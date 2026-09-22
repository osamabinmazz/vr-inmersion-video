"""Pipeline de procesamiento: backup, reparación, master, LODs, bake y export.

Regla de oro del módulo: el objeto original NUNCA se modifica. Toda
operación destructiva ocurre sobre duplicados.
"""

from __future__ import annotations

import math
import os
import time

import bmesh
import bpy

from . import analysis
from .core.metrics import (
    BAKE_RESOLUTION,
    ProcessingPlan,
    Strategy,
    build_plan,
    decimate_ratio,
)
from .core.quality import QualityReport, relax_settings

COLLECTIONS = {
    "ORIGINAL": "00_ORIGINAL",
    "MASTER_HIGH": "01_MASTER_HIGH",
    "LOD0": "02_LOD0",
    "LOD1": "03_LOD1",
    "LOD2": "04_LOD2",
    "BAKES": "05_BAKES",
    "EXPORTS": "06_EXPORTS",
}


# --------------------------------------------------------------------------
# Utilidades de escena
# --------------------------------------------------------------------------

def ensure_collections() -> dict[str, bpy.types.Collection]:
    """Crea las colecciones del pipeline si no existen."""
    out = {}
    scene_coll = bpy.context.scene.collection
    linked = {c.name for c in scene_coll.children}
    for key, name in COLLECTIONS.items():
        coll = bpy.data.collections.get(name)
        if coll is None:
            coll = bpy.data.collections.new(name)
            scene_coll.children.link(coll)
        elif name not in linked:
            # Existe pero quedó colgada fuera de la escena (p.ej. tras un
            # append): re-vincularla para que se vea en el outliner.
            try:
                scene_coll.children.link(coll)
            except RuntimeError:
                pass
        out[key] = coll
    return out


def move_to_collection(obj: bpy.types.Object, coll: bpy.types.Collection) -> None:
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    coll.objects.link(obj)


def set_active(obj: bpy.types.Object) -> None:
    """Deja obj como único seleccionado y activo, en modo objeto.

    Muchos bpy.ops dependen de este estado y fallan con 'context is
    incorrect' si no se prepara antes.
    """
    if bpy.context.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def duplicate_object(obj: bpy.types.Object, new_name: str) -> bpy.types.Object:
    """Copia independiente: también se copia la malla, si no ambos objetos
    comparten los mismos datos y editar uno edita el otro."""
    copy = obj.copy()
    copy.data = obj.data.copy()
    copy.name = new_name
    copy.data.name = f"{new_name}_mesh"
    bpy.context.scene.collection.objects.link(copy)
    return copy


def apply_modifier(obj: bpy.types.Object, modifier_name: str) -> bool:
    set_active(obj)
    try:
        bpy.ops.object.modifier_apply(modifier=modifier_name)
        return True
    except RuntimeError:
        return False


def _has_shape_keys(obj: bpy.types.Object) -> bool:
    return bool(obj.data.shape_keys and obj.data.shape_keys.key_blocks)


def backup_original(obj: bpy.types.Object) -> bpy.types.Object:
    """Copia intacta en 00_ORIGINAL. Es lo primero que hace todo el flujo."""
    colls = ensure_collections()
    backup = duplicate_object(obj, f"{obj.name}_ORIGINAL_BACKUP")
    move_to_collection(backup, colls["ORIGINAL"])
    backup.hide_render = True
    return backup


# --------------------------------------------------------------------------
# Limpieza y preparación
# --------------------------------------------------------------------------

def repair_mesh(
    obj: bpy.types.Object,
    merge_distance: float = 1e-5,
    remove_interior: bool = True,
    fix_normals: bool = True,
) -> dict[str, int]:
    """Limpia la malla con bmesh (sin ops: no necesita edit mode ni contexto).

    No cierra agujeros a propósito: en vegetación las superficies abiertas
    (hojas, alpha cards) son intencionales y taparlas arruina el asset.
    """
    stats = {"merged_verts": 0, "loose_removed": 0, "interior_removed": 0}
    mesh = obj.data

    bm = bmesh.new()
    try:
        bm.from_mesh(mesh)
        bm.verts.ensure_lookup_table()
        bm.faces.ensure_lookup_table()

        before_verts = len(bm.verts)
        bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=merge_distance)
        bm.verts.ensure_lookup_table()
        stats["merged_verts"] = before_verts - len(bm.verts)

        loose = [v for v in bm.verts if not v.link_faces]
        if loose:
            bmesh.ops.delete(bm, geom=loose, context="VERTS")
            stats["loose_removed"] = len(loose)

        if remove_interior:
            bm.faces.ensure_lookup_table()
            interior = [
                f for f in bm.faces if f.edges and all(len(e.link_faces) > 2 for e in f.edges)
            ]
            if interior:
                bmesh.ops.delete(bm, geom=interior, context="FACES")
                stats["interior_removed"] = len(interior)

        if fix_normals:
            bm.faces.ensure_lookup_table()
            bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])

        bm.to_mesh(mesh)
        mesh.update()
    finally:
        bm.free()
    return stats


def ensure_uvs(obj: bpy.types.Object, island_margin: float = 0.02) -> bool:
    """Genera UVs con Smart UV Project si el objeto no tiene.

    Sin UVs no se puede bakear nada, así que es requisito del pipeline.
    """
    if obj.data.uv_layers:
        return False
    set_active(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    try:
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(
            angle_limit=math.radians(66.0), island_margin=island_margin
        )
    finally:
        bpy.ops.object.mode_set(mode="OBJECT")
    return True


def shade_smooth_by_angle(obj: bpy.types.Object, angle_deg: float = 30.0) -> None:
    """Suavizado por ángulo, compatible con 4.1+ y anteriores.

    En Blender 4.1 se eliminó mesh.use_auto_smooth y se reemplazó por el
    operador shade_smooth_by_angle, así que hay que probar ambos caminos.
    """
    set_active(obj)
    if hasattr(bpy.ops.object, "shade_smooth_by_angle"):
        try:
            bpy.ops.object.shade_smooth_by_angle(angle=math.radians(angle_deg))
            return
        except (RuntimeError, TypeError):
            pass
    bpy.ops.object.shade_smooth()
    mesh = obj.data
    if hasattr(mesh, "use_auto_smooth"):
        mesh.use_auto_smooth = True
        mesh.auto_smooth_angle = math.radians(angle_deg)


def add_weighted_normals(obj: bpy.types.Object) -> None:
    """Weighted Normals mejora mucho el sombreado en superficies duras sin
    agregar un solo polígono."""
    if any(m.type == "WEIGHTED_NORMAL" for m in obj.modifiers):
        return
    mod = obj.modifiers.new("EnhancerWeightedNormal", "WEIGHTED_NORMAL")
    mod.keep_sharp = True
    mod.mode = "FACE_AREA_WITH_ANGLE"


# --------------------------------------------------------------------------
# Construcción del MASTER_HIGH
# --------------------------------------------------------------------------

def _apply_shrinkwrap(target: bpy.types.Object, source: bpy.types.Object, offset: float = 0.0) -> None:
    """Proyecta target sobre la superficie de source: así una malla
    remesheada recupera la silueta exacta del original."""
    mod = target.modifiers.new("EnhancerShrinkwrap", "SHRINKWRAP")
    mod.target = source
    mod.wrap_method = "NEAREST_SURFACEPOINT"
    mod.offset = offset
    apply_modifier(target, mod.name)


def _corrective_smooth(obj: bpy.types.Object, factor: float = 0.35, iterations: int = 6) -> None:
    """Suaviza sin encoger el volumen, que es lo que hace el smooth normal.

    Se usa después del shrinkwrap para limpiar el escalonado del voxel
    remesh sin volver a perder la forma que se acaba de recuperar.
    """
    mod = obj.modifiers.new("EnhancerCorrectiveSmooth", "CORRECTIVE_SMOOTH")
    mod.factor = factor
    mod.iterations = iterations
    mod.use_only_smooth = True
    apply_modifier(obj, mod.name)


def build_master(
    source: bpy.types.Object, plan: ProcessingPlan, strength: float = 1.0
) -> bpy.types.Object:
    """Crea el MASTER_HIGH según la estrategia decidida en core/.

    `strength` permite reintentar más suave si el control de calidad detecta
    que el resultado se alejó del original.
    """
    colls = ensure_collections()
    master = duplicate_object(source, f"{source.name}_MASTER_HIGH")
    move_to_collection(master, colls["MASTER_HIGH"])

    if plan.needs_repair:
        repair_mesh(master)
    if plan.needs_scale_apply and not plan.preserve_armature:
        set_active(master)
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

    strategy = plan.strategy

    if strategy is Strategy.REMESH_SHRINKWRAP:
        # Menos strength = voxel más grueso = resultado más conservador.
        voxel = plan.voxel_size / max(0.2, strength)
        mesh = master.data
        mesh.remesh_voxel_size = max(voxel, 1e-5)
        mesh.remesh_voxel_adaptivity = 0.0
        set_active(master)
        try:
            bpy.ops.object.voxel_remesh()
        except RuntimeError:
            # Si el remesh falla (malla vacía o voxel imposible), se sigue
            # con la geometría original en vez de abortar todo el proceso.
            pass
        if plan.use_shrinkwrap:
            _apply_shrinkwrap(master, source)
            _corrective_smooth(master, factor=0.3 * strength)

    elif strategy is Strategy.MULTIRES:
        mod = master.modifiers.new("EnhancerMultires", "MULTIRES")
        set_active(master)
        levels = max(1, int(round(plan.subdivision_levels * strength)))
        for _ in range(levels):
            try:
                bpy.ops.object.multires_subdivide(modifier=mod.name, mode="CATMULL_CLARK")
            except RuntimeError:
                break

    elif strategy is Strategy.SUBDIVIDE:
        levels = max(1, int(round(plan.subdivision_levels * strength)))
        mod = master.modifiers.new("EnhancerSubsurf", "SUBSURF")
        mod.levels = levels
        mod.render_levels = levels
        mod.use_limit_surface = True
        # Con shape keys o armature, aplicar rompe la animación: se deja el
        # modificador vivo para no destruir nada.
        if not _has_shape_keys(master) and not plan.preserve_armature:
            apply_modifier(master, mod.name)

    # DETAIL_ONLY no toca la geometría: el detalle vendrá de los mapas.

    shade_smooth_by_angle(master)
    add_weighted_normals(master)
    return master


# --------------------------------------------------------------------------
# LODs
# --------------------------------------------------------------------------

def build_lod(
    master: bpy.types.Object,
    level: str,
    target_tris: int,
    preserve_armature: bool = False,
) -> bpy.types.Object:
    """Decima el master hasta el objetivo del nivel.

    Decimate se usa SOLO acá, en las versiones optimizadas, nunca sobre el
    master ni el original.
    """
    colls = ensure_collections()
    base_name = master.name.replace("_MASTER_HIGH", "").replace("_ORIGINAL_BACKUP", "")
    lod = duplicate_object(master, f"{base_name}_{level}")
    move_to_collection(lod, colls[level])

    current = analysis.evaluated_tris(lod)
    ratio = decimate_ratio(current, target_tris)

    if ratio < 1.0:
        mod = lod.modifiers.new(f"Enhancer{level}Decimate", "DECIMATE")
        mod.decimate_type = "COLLAPSE"
        mod.ratio = ratio
        if not _has_shape_keys(lod):
            apply_modifier(lod, mod.name)

    shade_smooth_by_angle(lod)
    return lod


# --------------------------------------------------------------------------
# Bake
# --------------------------------------------------------------------------

def _ensure_bake_material(obj: bpy.types.Object) -> bpy.types.Material:
    """Devuelve un material con nodos donde poder colgar la imagen destino."""
    if obj.data.materials and obj.data.materials[0]:
        mat = obj.data.materials[0]
        if not mat.use_nodes:
            mat.use_nodes = True
        return mat
    mat = bpy.data.materials.new(f"{obj.name}_BakeMat")
    mat.use_nodes = True
    obj.data.materials.append(mat)
    return mat


def _prepare_bake_target(obj: bpy.types.Object, image: bpy.types.Image) -> None:
    """Cuelga la imagen en un nodo y lo deja ACTIVO.

    Cycles bakea al nodo Image Texture activo del material: si no se marca
    como activo, el bake falla o escribe en la imagen equivocada.
    """
    mat = _ensure_bake_material(obj)
    nodes = mat.node_tree.nodes
    node = nodes.get("ENHANCER_BAKE_TARGET")
    if node is None:
        node = nodes.new("ShaderNodeTexImage")
        node.name = "ENHANCER_BAKE_TARGET"
        node.location = (-900, 400)
    node.image = image
    for n in nodes:
        n.select = False
    node.select = True
    nodes.active = node


def bake_maps(
    low: bpy.types.Object,
    high: bpy.types.Object,
    level: str,
    types: tuple[str, ...] = ("NORMAL", "AO"),
    output_dir: str = "",
    samples: int = 16,
    cage_extrusion: float = 0.05,
) -> dict[str, str]:
    """Bakea del MASTER_HIGH al LOD (selected to active).

    Es la pieza que permite que un LOD0 de 150k tris se vea casi como un
    master de 2M: el detalle que se perdió en geometría vuelve como normal
    map.
    """
    scene = bpy.context.scene
    previous_engine = scene.render.engine
    scene.render.engine = "CYCLES"
    scene.cycles.samples = samples

    resolution = BAKE_RESOLUTION.get(level, 2048)
    written: dict[str, str] = {}

    ensure_uvs(low)

    for bake_type in types:
        is_data = bake_type in ("NORMAL", "DISPLACEMENT")
        img_name = f"{low.name}_{bake_type.lower()}_{resolution}"
        image = bpy.data.images.get(img_name)
        if image is None:
            image = bpy.data.images.new(
                img_name, width=resolution, height=resolution, alpha=False, is_data=is_data
            )
        _prepare_bake_target(low, image)

        # Selección: el high seleccionado y el low ACTIVO. Cycles proyecta de
        # lo seleccionado hacia lo activo.
        if bpy.context.mode != "OBJECT":
            bpy.ops.object.mode_set(mode="OBJECT")
        bpy.ops.object.select_all(action="DESELECT")
        high.select_set(True)
        low.select_set(True)
        bpy.context.view_layer.objects.active = low

        bake_settings = scene.render.bake
        bake_settings.use_selected_to_active = True
        bake_settings.cage_extrusion = cage_extrusion
        bake_settings.use_clear = True
        if hasattr(bake_settings, "max_ray_distance"):
            bake_settings.max_ray_distance = cage_extrusion * 2.0

        try:
            bpy.ops.object.bake(type=bake_type)
        except RuntimeError as exc:
            written[bake_type] = f"ERROR: {exc}"
            continue

        if output_dir:
            os.makedirs(output_dir, exist_ok=True)
            path = os.path.join(output_dir, f"{img_name}.png")
            image.filepath_raw = path
            image.file_format = "PNG"
            try:
                image.save()
                written[bake_type] = path
            except RuntimeError as exc:
                written[bake_type] = f"ERROR al guardar: {exc}"
        else:
            written[bake_type] = f"(en memoria: {img_name})"

    scene.render.engine = previous_engine
    return written


# --------------------------------------------------------------------------
# Export
# --------------------------------------------------------------------------

def export_object(obj: bpy.types.Object, directory: str, formats: tuple[str, ...]) -> dict[str, str]:
    """Exporta solo el objeto dado, manteniendo escala."""
    os.makedirs(directory, exist_ok=True)
    set_active(obj)
    out: dict[str, str] = {}

    for fmt in formats:
        fmt = fmt.upper()
        try:
            if fmt == "GLB":
                path = os.path.join(directory, f"{obj.name}.glb")
                bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True)
            elif fmt == "GLTF":
                path = os.path.join(directory, f"{obj.name}.gltf")
                bpy.ops.export_scene.gltf(
                    filepath=path, export_format="GLTF_SEPARATE", use_selection=True
                )
            elif fmt == "FBX":
                path = os.path.join(directory, f"{obj.name}.fbx")
                bpy.ops.export_scene.fbx(
                    filepath=path,
                    use_selection=True,
                    global_scale=1.0,
                    apply_scale_options="FBX_SCALE_NONE",
                )
            elif fmt == "OBJ":
                path = os.path.join(directory, f"{obj.name}.obj")
                # wm.obj_export es el exportador nuevo (3.3+); el viejo
                # export_scene.obj se eliminó en 4.0.
                if hasattr(bpy.ops.wm, "obj_export"):
                    bpy.ops.wm.obj_export(filepath=path, export_selected_objects=True)
                else:
                    bpy.ops.export_scene.obj(filepath=path, use_selection=True)
            elif fmt == "BLEND":
                path = os.path.join(directory, f"{obj.name}.blend")
                bpy.ops.wm.save_as_mainfile(filepath=path, copy=True)
            else:
                continue
            out[fmt] = path
        except (RuntimeError, AttributeError) as exc:
            out[fmt] = f"ERROR: {exc}"
    return out


# --------------------------------------------------------------------------
# Orquestador
# --------------------------------------------------------------------------

def run_auto_enhance(
    obj: bpy.types.Object,
    do_bake: bool = True,
    bake_dir: str = "",
    max_retries: int = 2,
) -> dict:
    """Ejecuta el flujo completo y devuelve los datos del informe."""
    timings: dict[str, float] = {}
    t_total = time.perf_counter()

    t = time.perf_counter()
    stats = analysis.analyze_object(obj)
    plan = build_plan(stats)
    timings["analisis"] = time.perf_counter() - t

    t = time.perf_counter()
    backup = backup_original(obj)
    timings["backup"] = time.perf_counter() - t

    # El master se construye contra el backup intacto, no contra el objeto
    # que el usuario tiene seleccionado (que podría tener modificadores).
    t = time.perf_counter()
    strength = 1.0
    master = None
    quality: dict[str, QualityReport] = {}

    for attempt in range(max_retries + 1):
        if master is not None:
            bpy.data.objects.remove(master, do_unlink=True)
        master = build_master(backup, plan, strength=strength)
        report = analysis.measure_deviation(master, backup, "MASTER_HIGH")
        quality["MASTER_HIGH"] = report
        if not report.needs_retry or attempt == max_retries:
            break
        # Perdió la forma: repetir con menos intensidad en vez de entregar un
        # modelo deformado.
        strength = relax_settings(strength, report.verdict)
    timings["master_high"] = time.perf_counter() - t

    lods: dict[str, bpy.types.Object] = {}
    for level in ("LOD0", "LOD1", "LOD2"):
        t = time.perf_counter()
        lod = build_lod(master, level, plan.targets[level], plan.preserve_armature)
        lods[level] = lod
        quality[level] = analysis.measure_deviation(lod, backup, level)
        timings[level.lower()] = time.perf_counter() - t

    bakes: dict[str, dict[str, str]] = {}
    if do_bake:
        bake_types = ["NORMAL"]
        if plan.bake_ao:
            bake_types.append("AO")
        if plan.bake_displacement:
            bake_types.append("DISPLACEMENT")
        for level, lod in lods.items():
            t = time.perf_counter()
            bakes[level] = bake_maps(
                lod, master, level, types=tuple(bake_types), output_dir=bake_dir
            )
            timings[f"bake_{level.lower()}"] = time.perf_counter() - t

    timings["total"] = time.perf_counter() - t_total

    return {
        "stats": stats,
        "plan": plan,
        "backup": backup,
        "master": master,
        "lods": lods,
        "quality": quality,
        "bakes": bakes,
        "timings": timings,
        "final_strength": strength,
    }
