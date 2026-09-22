"""Super-resolución geométrica: agregar detalle REAL, no polígonos.

La diferencia entre las dos cosas es todo el punto del add-on. Acá se hacen
solo dos operaciones, y las dos están atadas a evidencia:

  1. **Densificar donde hay forma**: se subdividen únicamente las aristas
     con ángulo diedro alto. Una arista entre dos caras coplanares no gana
     nada al partirse; una en el borde de un párpado sí. Esto es
     subdivisión local de verdad, con `bmesh.ops.subdivide_edges`, no un
     Subsurf global disfrazado.

  2. **Reproyectar contra el original, midiendo**: cada pasada de
     Shrinkwrap + suavizado se mide contra `00_SOURCE`. Si la desviación
     empeora, se descarta la pasada y se vuelve a la anterior. Sin esa
     medición, "refinar" es apretar botones y esperar.

Lo que NO se hace: inventar relieve que el original no tiene. Eso queda en
`sculpt_detail.py` y solo corre si hay un mapa de altura del que sacarlo.
"""

from __future__ import annotations

import math

import bmesh
import bpy

from . import analysis
from .cleanup import activate
from .core.deviation import bidirectional_deviation, classify_deviation, DeviationVerdict

# Ángulo a partir del cual una arista "tiene forma" y merece más resolución.
DETAIL_ANGLE = math.radians(18.0)


def densify_curved_regions(
    obj: bpy.types.Object,
    max_new_faces: int,
    angle: float = DETAIL_ANGLE,
    cuts: int = 1,
) -> list[str]:
    """Subdivide solo las aristas con curvatura. Subdivisión local real.

    `max_new_faces` acota el resultado: si las aristas candidatas son
    demasiadas, se toman las de mayor ángulo primero. Refinar el 100% del
    modelo sería volver al Subsurf global, que es justo lo que se evita.
    """
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    try:
        bm.edges.ensure_lookup_table()
        bm.faces.ensure_lookup_table()
        before = len(bm.faces)

        candidates: list[tuple[float, bmesh.types.BMEdge]] = []
        for edge in bm.edges:
            if len(edge.link_faces) != 2:
                continue
            try:
                a = edge.calc_face_angle()
            except ValueError:
                continue
            if a >= angle:
                candidates.append((a, edge))

        if not candidates:
            return [
                "No hay aristas con curvatura suficiente: el modelo ya es liso a esta "
                "escala y densificarlo solo agregaría peso."
            ]

        # Cada arista subdividida genera del orden de dos caras nuevas.
        budget = max(1, max_new_faces // 2)
        if len(candidates) > budget:
            candidates.sort(key=lambda p: p[0], reverse=True)
            candidates = candidates[:budget]
            limited = True
        else:
            limited = False

        bmesh.ops.subdivide_edges(
            bm,
            edges=[e for _, e in candidates],
            cuts=cuts,
            use_grid_fill=True,
            smooth=1.0,
            smooth_falloff="SMOOTH",
        )
        bm.to_mesh(obj.data)
        obj.data.update()
        after = len(obj.data.polygons)

        msg = (
            f"Densificación local: {len(candidates):,} aristas con ángulo ≥ "
            f"{math.degrees(angle):.0f}° subdivididas. {before:,} → {after:,} caras, "
            "todas en zonas con forma."
        )
        notes = [msg]
        if limited:
            notes.append(
                f"Había más aristas candidatas que presupuesto ({max_new_faces:,} caras): "
                "se tomaron las de mayor ángulo, que son las que más silueta aportan."
            )
        return notes
    finally:
        bm.free()


def _deviation_now(obj: bpy.types.Object, source: bpy.types.Object, samples: int) -> float:
    """Percentil 99 simétrico normalizado. Un solo número comparable."""
    fwd, bwd, diag = analysis.measure_deviation(source, obj, samples=samples)
    return bidirectional_deviation(fwd, bwd, diag).symmetric_p99


def refine_against_source(
    obj: bpy.types.Object,
    source: bpy.types.Object,
    preset,
    iterations: int = 3,
    samples: int = 8_000,
) -> list[str]:
    """Reproyecta contra el original y MIDE cada pasada.

    Si una pasada empeora la desviación, se descarta y se corta: seguir
    iterando sobre un resultado que se aleja es cómo se derrite un modelo
    sin darse cuenta.
    """
    report: list[str] = []
    if source is None:
        return ["Sin original de referencia: no se puede reproyectar."]

    try:
        best = _deviation_now(obj, source, samples)
    except Exception as exc:
        return [f"No se pudo medir la desviación inicial: {exc}. Se omite el refinado."]

    report.append(f"Desviación inicial (p99 normalizado): {best:.5f}.")
    backup_mesh = obj.data.copy()

    was_hidden = source.hide_viewport
    source.hide_viewport = False
    try:
        for i in range(1, iterations + 1):
            activate(obj)
            wrap = obj.modifiers.new(f"ULTRA_Refine_{i}", "SHRINKWRAP")
            wrap.target = source
            wrap.wrap_method = "NEAREST_SURFACEPOINT"
            wrap.wrap_mode = "ON_SURFACE"
            try:
                bpy.ops.object.modifier_apply(modifier=wrap.name)
            except RuntimeError as exc:
                obj.modifiers.remove(wrap)
                report.append(f"Pasada {i} no se pudo aplicar: {exc}")
                break

            smooth = obj.modifiers.new(f"ULTRA_RefineSmooth_{i}", "CORRECTIVE_SMOOTH")
            smooth.factor = 0.35
            smooth.iterations = 8
            smooth.smooth_type = "LENGTH_WEIGHTED"
            try:
                bpy.ops.object.modifier_apply(modifier=smooth.name)
            except RuntimeError:
                if smooth.name in obj.modifiers:
                    obj.modifiers.remove(smooth)

            try:
                current = _deviation_now(obj, source, samples)
            except Exception as exc:
                report.append(f"Pasada {i}: no se pudo medir ({exc}). Se detiene el refinado.")
                break

            if current < best * 0.98:
                report.append(f"Pasada {i}: desviación {best:.5f} → {current:.5f}. Se conserva.")
                best = current
                old = backup_mesh
                backup_mesh = obj.data.copy()
                if old.users == 0:
                    bpy.data.meshes.remove(old)
            else:
                report.append(
                    f"Pasada {i}: la desviación no mejoró ({best:.5f} → {current:.5f}). "
                    "Se descarta la pasada y se corta el refinado."
                )
                stale = obj.data
                obj.data = backup_mesh
                if stale.users == 0:
                    bpy.data.meshes.remove(stale)
                break
    finally:
        source.hide_viewport = was_hidden
        if backup_mesh is not obj.data and backup_mesh.users == 0:
            bpy.data.meshes.remove(backup_mesh)

    verdict = classify_deviation(best, preset.deviation_tolerance)
    report.append(
        f"Desviación final {best:.5f} → veredicto {verdict.value} "
        f"(tolerancia del preset {preset.key}: {preset.deviation_tolerance})."
    )
    if verdict in (DeviationVerdict.DRIFTED, DeviationVerdict.BROKEN):
        report.append(
            "El resultado se alejó del original más de lo aceptable. Conviene bajar la "
            "agresividad del remesh o desactivarlo: el original sigue intacto en 00_SOURCE."
        )
    return report


def super_resolve(
    obj: bpy.types.Object,
    source: bpy.types.Object,
    plan,
    preset,
) -> list[str]:
    """Etapa 13 del pipeline: densificar donde hace falta y verificar.

    Se saltea sola en los casos donde no aportaría nada, y lo dice en vez de
    hacer un trabajo inútil que después se cobra en tiempo y en memoria.
    """
    report: list[str] = []

    budget = max(0, plan.master_target_tris - len(obj.data.polygons) * 2)
    if budget < 5_000:
        report.append(
            "Sin presupuesto para densificar: el modelo ya está en el objetivo del "
            "master. Se pasa directo a la verificación."
        )
    else:
        report.extend(densify_curved_regions(obj, budget))

    if plan.use_shrinkwrap and source is not None:
        report.extend(refine_against_source(obj, source, preset))
    else:
        report.append(
            "Sin reproyección: este método no la necesita (la geometría no se "
            "reemplazó, se refinó sobre sí misma)."
        )
    return report
