"""Retopología a quads y transferencia de la superficie original.

Para qué sirve: un escaneo de fotogrametría tiene la superficie perfecta y
la topología inservible —millones de triángulos de tamaños dispares, sin
bucles, imposible de deformar o texturizar. Retopologizar no mejora la
forma: mejora la MALLA, y después el detalle vuelve por el horneado.

Limitación real: QuadriFlow exige una malla razonablemente manifold y
falla sin aviso útil en escaneos muy sucios. Por eso hay un camino de
respaldo (voxel remesh en modo quad + reproyección) en vez de dejar el
proceso colgado.
"""

from __future__ import annotations

import bpy

from .cleanup import activate
from .reconstruction import reproject_to_source


def quad_retopology(
    obj: bpy.types.Object,
    target_faces: int,
    preserve_sharp: bool = True,
    preserve_boundary: bool = True,
) -> list[str]:
    """Genera una malla de quads limpia con QuadriFlow."""
    report: list[str] = []
    before = len(obj.data.polygons)
    activate(obj)

    try:
        bpy.ops.object.quadriflow_remesh(
            use_paint_symmetry=False,
            use_preserve_sharp=preserve_sharp,
            use_preserve_boundary=preserve_boundary,
            use_mesh_symmetry=False,
            mode="FACES",
            target_faces=max(500, target_faces),
        )
        after = len(obj.data.polygons)
        quads = sum(1 for p in obj.data.polygons if len(p.vertices) == 4)
        report.append(
            f"QuadriFlow: {before:,} → {after:,} caras, {quads / max(1, after) * 100:.0f}% quads. "
            "La forma no cambió; lo que cambió es que ahora la malla se puede deformar "
            "y texturizar."
        )
        return report
    except RuntimeError as exc:
        report.append(
            f"QuadriFlow falló ({exc}). Suele pasar con escaneos muy sucios: exige una "
            "malla razonablemente manifold. Se usa el camino de respaldo."
        )

    return report + _fallback_quad_remesh(obj, target_faces)


def _fallback_quad_remesh(obj: bpy.types.Object, target_faces: int) -> list[str]:
    """Respaldo: voxel remesh en modo quad + Decimate al objetivo.

    Da quads menos prolijos que QuadriFlow y sin bucles de borde, pero es
    una malla utilizable. La alternativa sería no entregar nada.
    """
    before = len(obj.data.polygons)
    activate(obj)
    mesh = obj.data

    dims = obj.dimensions
    largest = max(dims) if dims else 1.0
    # Voxel dimensionado para llegar cerca del objetivo de caras.
    mesh.remesh_voxel_size = max(largest / 512.0, largest / max(8.0, (target_faces ** 0.5)))
    mesh.remesh_voxel_adaptivity = 0.0
    try:
        bpy.ops.object.voxel_remesh()
    except RuntimeError as exc:
        return [f"El respaldo también falló: {exc}. La malla queda como estaba."]

    current = len(obj.data.polygons)
    if current > target_faces:
        mod = obj.modifiers.new("ULTRA_RetopoDecimate", "DECIMATE")
        mod.decimate_type = "COLLAPSE"
        mod.ratio = max(0.02, target_faces / current)
        try:
            bpy.ops.object.modifier_apply(modifier=mod.name)
        except RuntimeError:
            obj.modifiers.remove(mod)

    return [
        f"Respaldo aplicado: {before:,} → {len(obj.data.polygons):,} caras. "
        "Sin los bucles de borde que daría QuadriFlow, pero es una malla trabajable."
    ]


def transfer_surface_data(low: bpy.types.Object, high: bpy.types.Object) -> list[str]:
    """Copia normales personalizadas (y UVs si faltan) del master a la malla nueva.

    Transferir las normales del modelo denso al liviano es de lo más
    rentable que hay: el sombreado del liviano pasa a leerse como el del
    denso sin un polígono más.
    """
    report: list[str] = []
    was_hidden = high.hide_viewport
    high.hide_viewport = False
    try:
        activate(low)
        high.select_set(True)
        bpy.context.view_layer.objects.active = low

        mod = low.modifiers.new("ULTRA_NormalTransfer", "DATA_TRANSFER")
        mod.object = high
        mod.use_loop_data = True
        mod.data_types_loops = {"CUSTOM_NORMAL"}
        mod.loop_mapping = "POLYINTERP_NEAREST"
        try:
            bpy.ops.object.datalayout_transfer(modifier=mod.name)
            bpy.ops.object.modifier_apply(modifier=mod.name)
            report.append(
                "Normales del master transferidas: el modelo liviano se sombrea como el "
                "denso, sin agregar geometría."
            )
        except RuntimeError as exc:
            if mod.name in low.modifiers:
                low.modifiers.remove(mod)
            report.append(f"No se pudieron transferir las normales: {exc}")
    finally:
        high.hide_viewport = was_hidden
    return report


def retopologize(
    obj: bpy.types.Object,
    source: bpy.types.Object,
    plan,
    preset,
) -> list[str]:
    """Etapa 18: retopología + recuperación de la silueta perdida.

    El orden importa: primero la malla nueva, después reproyectarla contra
    el original. QuadriFlow suaviza esquinas, y sin la reproyección el
    modelo queda redondeado.
    """
    if not preset.allow_quad_retopo:
        return [
            f"El preset {preset.key} no admite retopología automática: en superficies "
            "laminares (follaje, telas) QuadriFlow destruye las tarjetas."
        ]

    target = plan.retopo_target_faces or max(5_000, plan.lod_targets.get("LOD0", 50_000) // 2)
    report = quad_retopology(obj, target, preserve_sharp=preset.preserve_sharp_edges)

    if source is not None:
        report.extend(reproject_to_source(obj, source, smooth_factor=0.3, smooth_iterations=6))
    return report
