"""Construcción de la geometría nueva, según el método que eligió el plan.

**Limitación técnica de Blender, dicha sin vueltas**: no existe un
modificador de subdivisión que aplique niveles distintos por zona. El
Subdivision Surface es global, y "Adaptive Subdivision" solo existe como
dicing de render en Cycles, no como geometría real.

La mejor alternativa disponible con herramientas de stock, que es la que se
implementa acá, tiene dos pasos:

  1. subdividir parejo hasta el nivel máximo del plan;
  2. colapsar con Decimate usando un grupo de vértices de CURVATURA, de
     modo que las zonas planas pierdan los polígonos que no les servían y
     las curvas los conserven.

El resultado final es el reparto que `core.planning` calculó: los polígonos
terminan donde hay forma. No es un atajo ni una simulación — es geometría
real medida después por `quality_control`.
"""

from __future__ import annotations

import math

import bmesh
import bpy

from .cleanup import activate
from .core.planning import ReconstructionMethod

CURVATURE_GROUP = "ULTRA_curvature"


# ----------------------------------------------------- grupo de curvatura


def build_curvature_group(obj: bpy.types.Object, gamma: float = 0.6) -> str:
    """Grupo de vértices con la curvatura local normalizada 0-1.

    Es la pieza que vuelve adaptativa la subdivisión: Decimate lo lee para
    decidir dónde puede colapsar sin perder forma. Se usa el ángulo diedro
    máximo (no el promedio) porque un vértice en un borde vivo tiene
    vecinas planas que le bajarían el promedio y lo harían colapsable.
    """
    group = obj.vertex_groups.get(CURVATURE_GROUP)
    if group is None:
        group = obj.vertex_groups.new(name=CURVATURE_GROUP)

    bm = bmesh.new()
    bm.from_mesh(obj.data)
    try:
        bm.verts.ensure_lookup_table()
        values: list[float] = []
        for v in bm.verts:
            angles = []
            for edge in v.link_edges:
                if len(edge.link_faces) == 2:
                    try:
                        angles.append(edge.calc_face_angle())
                    except ValueError:
                        pass
            values.append(max(angles) if angles else 0.0)
    finally:
        bm.free()

    if not values:
        return "No se pudo medir curvatura: la malla no tiene aristas con dos caras."

    peak = max(values) or 1.0
    for idx, raw in enumerate(values):
        # gamma < 1 levanta las curvaturas medias: sin eso, casi todo el
        # modelo queda en peso ~0 y Decimate lo aplana entero.
        weight = min(1.0, (raw / peak) ** gamma)
        group.add([idx], weight, "REPLACE")

    curved = sum(1 for v in values if v / peak > 0.25)
    return (
        f"Grupo de curvatura creado: {curved} de {len(values)} vértices en zonas con "
        f"forma (ángulo máximo {math.degrees(peak):.0f}°)."
    )


# ------------------------------------------------- subdivisión adaptativa


def adaptive_subdivide(obj: bpy.types.Object, plan) -> list[str]:
    """Subdivide y después redistribuye según curvatura."""
    report: list[str] = []
    sub = plan.subdivision
    levels = sub.max_levels if sub else 0
    if levels <= 0:
        return ["Sin subdivisión: el plan no la pidió."]

    report.append(build_curvature_group(obj))
    activate(obj)

    mod = obj.modifiers.new("ULTRA_Subdiv", "SUBSURF")
    mod.subdivision_type = "CATMULL_CLARK"
    mod.levels = levels
    mod.render_levels = levels
    mod.use_limit_surface = True
    try:
        bpy.ops.object.modifier_apply(modifier=mod.name)
    except RuntimeError as exc:
        obj.modifiers.remove(mod)
        return report + [f"La subdivisión falló y no se aplicó nada: {exc}"]

    subdivided = len(obj.data.polygons)
    report.append(f"Subdivisión Catmull-Clark nivel {levels}: {subdivided:,} caras.")

    if not sub or not sub.adaptive or not obj.vertex_groups.get(CURVATURE_GROUP):
        report.append(
            "Sin datos de curvatura: queda la subdivisión uniforme. Es lo peor "
            "repartido, pero es lo único honesto sin esa medición."
        )
        return report

    target = max(1, sub.expected_tris)
    current_tris = sum(max(0, len(p.vertices) - 2) for p in obj.data.polygons)
    if current_tris <= target:
        report.append("No hizo falta redistribuir: ya estaba dentro del objetivo.")
        return report

    dec = obj.modifiers.new("ULTRA_Adaptive", "DECIMATE")
    dec.decimate_type = "COLLAPSE"
    dec.ratio = max(0.02, min(1.0, target / current_tris))
    dec.vertex_group = CURVATURE_GROUP
    # invert = las zonas de MENOR curvatura son las que se colapsan.
    dec.invert_vertex_group = True
    dec.vertex_group_factor = 1.0
    dec.use_collapse_triangulate = False
    try:
        bpy.ops.object.modifier_apply(modifier=dec.name)
        final = sum(max(0, len(p.vertices) - 2) for p in obj.data.polygons)
        report.append(
            f"Redistribución por curvatura: {current_tris:,} → {final:,} triángulos. "
            "Los polígonos que se perdieron estaban en superficie plana, donde no "
            "describían ninguna forma."
        )
    except RuntimeError as exc:
        obj.modifiers.remove(dec)
        report.append(
            f"No se pudo redistribuir ({exc}): queda la subdivisión uniforme, que es "
            "más pesada para el mismo detalle visible."
        )
    return report


# ------------------------------------------------------------- multires


def build_multires(obj: bpy.types.Object, plan) -> list[str]:
    """Multires: subdivide y deja el nivel alto disponible para esculpir y hornear.

    Es preferible a aplicar un Subsurf cuando la topología lo admite, porque
    conserva la malla base: se puede bajar de nivel, y el horneado de
    Multires a base es exacto en vez de una proyección aproximada.
    """
    report: list[str] = []
    levels = plan.subdivision.max_levels if plan.subdivision else 2
    if levels <= 0:
        return ["El plan no pidió subdivisión."]

    activate(obj)
    mod = obj.modifiers.new("ULTRA_Multires", "MULTIRES")
    try:
        for i in range(levels):
            bpy.ops.object.multires_subdivide(modifier=mod.name, mode="CATMULL_CLARK")
            report.append(f"Multires nivel {i + 1} generado.")
    except RuntimeError as exc:
        obj.modifiers.remove(mod)
        report.append(
            f"Multires falló ({exc}). Exige topología all-quad sin non-manifold; "
            "se cae a subdivisión adaptativa."
        )
        report.extend(adaptive_subdivide(obj, plan))
        return report

    mod.levels = levels
    mod.sculpt_levels = levels
    mod.render_levels = levels
    report.append(
        f"Multires en nivel {levels}. La malla base queda intacta: se puede bajar "
        "de nivel y el horneado a la base es exacto."
    )
    return report


# --------------------------------------------------------- voxel remesh


def remesh_and_reproject(obj: bpy.types.Object, source: bpy.types.Object, plan) -> list[str]:
    """Superficie nueva por voxel + recuperación de la silueta.

    El voxel remesh produce una malla sana pero redondeada y sin UVs ni
    vertex groups. Por eso siempre va seguido de un Shrinkwrap contra el
    original, que es lo que devuelve el contorno: sin ese paso el modelo
    queda "derretido".
    """
    report: list[str] = []
    voxel = plan.voxel_size
    if voxel <= 0.0:
        return ["El plan no definió tamaño de voxel."]

    activate(obj)
    mesh = obj.data
    mesh.remesh_voxel_size = voxel
    mesh.remesh_voxel_adaptivity = 0.0
    if hasattr(mesh, "use_remesh_preserve_volume"):
        mesh.use_remesh_preserve_volume = True

    before = len(mesh.polygons)
    try:
        bpy.ops.object.voxel_remesh()
    except RuntimeError as exc:
        return [f"El voxel remesh falló: {exc}. La geometría queda como estaba."]
    report.append(
        f"Voxel remesh a {voxel:.5f}: {before:,} → {len(obj.data.polygons):,} caras. "
        "Topología sana, pero la silueta quedó redondeada."
    )

    if plan.use_shrinkwrap and source is not None:
        report.extend(reproject_to_source(obj, source))
    return report


def reproject_to_source(
    obj: bpy.types.Object,
    source: bpy.types.Object,
    smooth_factor: float = 0.5,
    smooth_iterations: int = 12,
) -> list[str]:
    """Pega la malla nueva a la superficie del original y suaviza los pellizcos.

    El Corrective Smooth va DESPUÉS del Shrinkwrap y no antes: el
    Shrinkwrap deja pellizcos donde la malla nueva cruza el original, y
    suavizarlos primero no tendría nada que corregir.
    """
    report: list[str] = []
    was_hidden = source.hide_viewport
    source.hide_viewport = False
    try:
        activate(obj)
        wrap = obj.modifiers.new("ULTRA_Shrinkwrap", "SHRINKWRAP")
        wrap.target = source
        wrap.wrap_method = "NEAREST_SURFACEPOINT"
        wrap.wrap_mode = "ON_SURFACE"
        wrap.offset = 0.0
        try:
            bpy.ops.object.modifier_apply(modifier=wrap.name)
            report.append("Silueta recuperada: Shrinkwrap contra el original.")
        except RuntimeError as exc:
            obj.modifiers.remove(wrap)
            return [f"El Shrinkwrap falló: {exc}. La malla queda redondeada."]

        smooth = obj.modifiers.new("ULTRA_Smooth", "CORRECTIVE_SMOOTH")
        smooth.factor = smooth_factor
        smooth.iterations = smooth_iterations
        smooth.smooth_type = "LENGTH_WEIGHTED"
        smooth.use_only_smooth = False
        try:
            bpy.ops.object.modifier_apply(modifier=smooth.name)
            report.append(
                f"Corrective Smooth ({smooth_iterations} iteraciones) sobre los pellizcos "
                "que deja el Shrinkwrap."
            )
        except RuntimeError as exc:
            obj.modifiers.remove(smooth)
            report.append(f"No se pudo suavizar: {exc}")
    finally:
        source.hide_viewport = was_hidden
    return report


def transfer_vertex_groups(obj: bpy.types.Object, source: bpy.types.Object) -> str:
    """Recupera los pesos de skinning que el remesh descartó.

    Transferirlos por proximidad no es lo mismo que pintarlos a mano y hay
    que revisarlos antes de animar, pero es infinitamente mejor que perder
    el rigging entero.
    """
    if not source.vertex_groups:
        return "El original no tenía vertex groups que transferir."

    was_hidden = source.hide_viewport
    source.hide_viewport = False
    try:
        activate(obj)
        source.select_set(True)
        bpy.context.view_layer.objects.active = obj
        mod = obj.modifiers.new("ULTRA_DataTransfer", "DATA_TRANSFER")
        mod.object = source
        mod.use_vert_data = True
        mod.data_types_verts = {"VGROUP_WEIGHTS"}
        mod.vert_mapping = "POLYINTERP_NEAREST"
        try:
            bpy.ops.object.datalayout_transfer(modifier=mod.name)
            bpy.ops.object.modifier_apply(modifier=mod.name)
            return (
                f"{len(source.vertex_groups)} vertex groups transferidos por proximidad. "
                "Revisar los pesos antes de animar: no equivalen a un pintado manual."
            )
        except RuntimeError as exc:
            if mod.name in obj.modifiers:
                obj.modifiers.remove(mod)
            return f"No se pudieron transferir los pesos: {exc}"
    finally:
        source.hide_viewport = was_hidden


# ------------------------------------------------------- follaje seguro


def _closed_island_edges(bm: bmesh.types.BMesh) -> list:
    """Aristas de las islas CERRADAS (tronco, ramas), sin tocar las láminas.

    Es la distinción que salva a un árbol: las tarjetas de hojas son islas
    con borde abierto y no se subdividen; el tronco es una isla cerrada y sí.
    """
    seen: set[int] = set()
    keep: list = []
    for face in bm.faces:
        if face.index in seen:
            continue
        island = []
        stack = [face]
        seen.add(face.index)
        open_border = False
        while stack:
            f = stack.pop()
            island.append(f)
            for edge in f.edges:
                if edge.is_boundary:
                    open_border = True
                for other in edge.link_faces:
                    if other.index not in seen:
                        seen.add(other.index)
                        stack.append(other)
        if not open_border and len(island) > 8:
            for f in island:
                keep.extend(f.edges)
    return list({e.index: e for e in keep}.values())


def foliage_safe_subdivide(obj: bpy.types.Object, plan) -> list[str]:
    """Subdivide SOLO las partes sólidas. Las tarjetas de hojas no se tocan.

    Subdividir una tarjeta plana no le agrega ni una unidad de detalle: es
    el mismo plano con más vértices. El tronco, en cambio, sí gana.
    """
    levels = plan.subdivision.max_levels if plan.subdivision else 1
    if levels <= 0:
        return ["El plan no pidió subdivisión para este follaje."]

    bm = bmesh.new()
    bm.from_mesh(obj.data)
    try:
        bm.verts.ensure_lookup_table()
        bm.edges.ensure_lookup_table()
        bm.faces.ensure_lookup_table()
        edges = _closed_island_edges(bm)
        if not edges:
            return [
                "No hay ninguna isla cerrada: el modelo es todo follaje laminar. "
                "No se subdivide nada, que es lo correcto — más vértices en un "
                "plano no agregan detalle."
            ]
        before = len(bm.faces)
        bmesh.ops.subdivide_edges(
            bm, edges=edges, cuts=max(1, min(3, levels)),
            use_grid_fill=True, smooth=1.0, smooth_falloff="SMOOTH",
        )
        bm.to_mesh(obj.data)
        obj.data.update()
        after = len(obj.data.polygons)
        return [
            f"Subdivisión aplicada solo a las partes cerradas (tronco y ramas): "
            f"{before:,} → {after:,} caras. Las tarjetas de follaje quedaron intactas."
        ]
    finally:
        bm.free()


# ---------------------------------------------------------------- público


def reconstruct(obj: bpy.types.Object, source: bpy.types.Object, plan) -> list[str]:
    """Aplica el método que eligió el plan. Devuelve el parte de lo hecho."""
    method = plan.method

    if method is ReconstructionMethod.MULTIRES_SCULPT:
        report = build_multires(obj, plan)
    elif method is ReconstructionMethod.ADAPTIVE_SUBDIVISION:
        report = adaptive_subdivide(obj, plan)
    elif method is ReconstructionMethod.REMESH_REPROJECT:
        report = remesh_and_reproject(obj, source, plan)
        if source.vertex_groups:
            report.append(transfer_vertex_groups(obj, source))
    elif method is ReconstructionMethod.FOLIAGE_SAFE:
        report = foliage_safe_subdivide(obj, plan)
    elif method is ReconstructionMethod.QUAD_RETOPO_FIRST:
        report = [
            "Escaneo: la geometría base no se toca. El detalle ya está en los "
            "vértices y la reconstrucción pasa directo a retopología."
        ]
    else:  # DETAIL_ONLY
        report = [
            "Geometría sin cambios: el modelo ya tiene la densidad necesaria. "
            "Subdividirlo agregaría peso sin una sola unidad de información nueva."
        ]

    return report
