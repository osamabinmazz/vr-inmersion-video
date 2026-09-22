"""Capa de medición sobre Blender: traduce un objeto de la escena a MeshStats
y mide la desviación de un resultado contra el original.

Todo lo que toca bpy/bmesh vive acá; las decisiones se toman en core/.
"""

from __future__ import annotations

import bmesh
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

from .core.metrics import MeshStats
from .core.quality import QualityReport, build_quality_report


def _count_textured_materials(obj: bpy.types.Object) -> int:
    """Materiales con al menos una textura de imagen conectada.

    Importa para decidir el displacement: sin textura no hay información de
    la que reconstruir relieve, y bakear un displacement plano es tiempo
    perdido.
    """
    count = 0
    for slot in obj.material_slots:
        mat = slot.material
        if not mat or not mat.use_nodes or not mat.node_tree:
            continue
        if any(n.type == "TEX_IMAGE" and n.image for n in mat.node_tree.nodes):
            count += 1
    return count


def _has_armature(obj: bpy.types.Object) -> bool:
    if any(m.type == "ARMATURE" for m in obj.modifiers):
        return True
    return obj.parent is not None and obj.parent.type == "ARMATURE"


def analyze_object(obj: bpy.types.Object) -> MeshStats:
    """Mide el objeto sin modificarlo. Trabaja sobre una copia en bmesh."""
    if obj is None or obj.type != "MESH":
        raise ValueError("Se esperaba un objeto de tipo MESH")

    mesh = obj.data
    stats = MeshStats(name=obj.name)

    bm = bmesh.new()
    try:
        bm.from_mesh(mesh)
        bm.faces.ensure_lookup_table()
        bm.verts.ensure_lookup_table()
        bm.edges.ensure_lookup_table()

        stats.verts = len(bm.verts)
        stats.edges = len(bm.edges)
        stats.faces = len(bm.faces)

        tris = quads = ngons = 0
        area = 0.0
        for f in bm.faces:
            n = len(f.verts)
            # Un polígono de n lados aporta n-2 triángulos al rasterizar.
            tris += max(0, n - 2)
            if n == 4:
                quads += 1
            elif n > 4:
                ngons += 1
            area += f.calc_area()
        stats.tris = tris
        stats.quads = quads
        stats.ngons = ngons
        stats.surface_area = area

        stats.loose_verts = sum(1 for v in bm.verts if not v.link_faces)
        stats.non_manifold_edges = sum(1 for e in bm.edges if not e.is_manifold)
        stats.boundary_edges = sum(1 for e in bm.edges if e.is_boundary)
        # Cara interior: todos sus bordes comparten 3+ caras, o sea que está
        # metida dentro del volumen y nunca se ve.
        stats.interior_faces = sum(
            1 for f in bm.faces if f.edges and all(len(e.link_faces) > 2 for e in f.edges)
        )

        try:
            stats.volume = abs(bm.calc_volume(signed=True))
        except Exception:
            stats.volume = 0.0

        # Duplicados: find_doubles informa sin modificar la malla.
        try:
            res = bmesh.ops.find_doubles(bm, verts=bm.verts[:], dist=1e-5)
            stats.duplicate_verts = len(res.get("targetmap", {}))
        except Exception:
            stats.duplicate_verts = 0

        # Normales invertidas: se recalculan sobre una copia y se cuenta
        # cuántas dieron vuelta. Más fiable que comparar contra el centro del
        # objeto, que solo funciona en mallas convexas cerradas.
        try:
            bm_copy = bm.copy()
            bm_copy.faces.ensure_lookup_table()
            originals = [f.normal.copy() for f in bm_copy.faces]
            bmesh.ops.recalc_face_normals(bm_copy, faces=bm_copy.faces[:])
            bm_copy.faces.ensure_lookup_table()
            stats.flipped_normals = sum(
                1
                for f, n0 in zip(bm_copy.faces, originals)
                if f.normal.length > 0 and n0.length > 0 and f.normal.dot(n0) < 0
            )
            bm_copy.free()
        except Exception:
            stats.flipped_normals = 0
    finally:
        bm.free()

    stats.uv_layers = len(mesh.uv_layers)
    stats.materials = len(obj.material_slots)
    stats.textured_materials = _count_textured_materials(obj)
    stats.has_armature = _has_armature(obj)
    stats.shape_keys = len(mesh.shape_keys.key_blocks) if mesh.shape_keys else 0
    stats.vertex_groups = len(obj.vertex_groups)
    stats.has_custom_normals = getattr(mesh, "has_custom_normals", False)
    stats.dimensions = tuple(obj.dimensions)
    stats.scale = tuple(obj.scale)

    return stats


def evaluated_tris(obj: bpy.types.Object, depsgraph=None) -> int:
    """Triángulos reales tras aplicar modificadores, que es lo que cuesta
    renderizar. Sin esto, un objeto con Subdivision se reporta como si
    tuviera solo la geometría base."""
    depsgraph = depsgraph or bpy.context.evaluated_depsgraph_get()
    eval_obj = obj.evaluated_get(depsgraph)
    mesh = eval_obj.to_mesh()
    try:
        return sum(max(0, len(p.vertices) - 2) for p in mesh.polygons)
    finally:
        eval_obj.to_mesh_clear()


def bbox_diagonal(obj: bpy.types.Object) -> float:
    """Diagonal del bounding box en espacio mundo. Sirve de escala para que
    los umbrales de desviación valgan igual en objetos chicos y grandes."""
    pts = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    if not pts:
        return 0.0
    xs = [p.x for p in pts]
    ys = [p.y for p in pts]
    zs = [p.z for p in pts]
    dx, dy, dz = max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs)
    return (dx * dx + dy * dy + dz * dz) ** 0.5


def mesh_volume(obj: bpy.types.Object) -> float:
    bm = bmesh.new()
    try:
        bm.from_mesh(obj.data)
        return abs(bm.calc_volume(signed=True))
    except Exception:
        return 0.0
    finally:
        bm.free()


def measure_deviation(
    result: bpy.types.Object,
    original: bpy.types.Object,
    level: str,
    max_samples: int = 20_000,
) -> QualityReport:
    """Compara la silueta del resultado contra el original.

    Para cada vértice del resultado busca el punto más cercano de la
    superficie original con un BVHTree. Muestrea como mucho max_samples
    vértices: sobre un master de millones, recorrerlos todos tarda minutos y
    no cambia las conclusiones.
    """
    depsgraph = bpy.context.evaluated_depsgraph_get()
    bvh = BVHTree.FromObject(original, depsgraph)

    mw_result = result.matrix_world
    mw_orig_inv = original.matrix_world.inverted_safe()

    verts = result.data.vertices
    total = len(verts)
    step = max(1, total // max_samples) if total else 1

    deviations: list[float] = []
    for i in range(0, total, step):
        # El BVH vive en espacio local del original: hay que llevar el punto
        # ahí, no comparar coordenadas de mundo contra locales.
        world_co = mw_result @ verts[i].co
        local_co = mw_orig_inv @ world_co
        hit = bvh.find_nearest(local_co)
        if hit and hit[0] is not None:
            deviations.append(hit[3])

    orig_stats = analyze_object(original)
    result_stats = analyze_object(result)

    return build_quality_report(
        level=level,
        deviations=deviations,
        diagonal=bbox_diagonal(original),
        volume_original=mesh_volume(original),
        volume_result=mesh_volume(result),
        tris=result_stats.tris,
        flipped_normals=result_stats.flipped_normals,
        non_manifold_edges=result_stats.non_manifold_edges,
        lost_uvs=orig_stats.has_uvs and not result_stats.has_uvs,
        lost_materials=orig_stats.materials > 0 and result_stats.materials == 0,
    )
