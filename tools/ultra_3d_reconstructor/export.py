"""Exportación de los niveles y de los mapas horneados.

**Limitación real de Blender**: el exportador de OBJ cambió de operador en
4.0 (`export_scene.obj` → `wm.obj_export`) y el de glTF cambió nombres de
parámetros entre versiones. Se detecta la versión en vez de asumir una; un
add-on que solo anda en la versión del autor no sirve de nada.
"""

from __future__ import annotations

import os

import bpy

from .cleanup import activate

FORMATS = ("GLB", "FBX", "OBJ")


def _select_only(objects) -> None:
    if bpy.context.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    for o in bpy.context.selected_objects:
        o.select_set(False)
    for o in objects:
        o.hide_viewport = False
        o.select_set(True)
    if objects:
        bpy.context.view_layer.objects.active = objects[0]


def export_object(obj: bpy.types.Object, directory: str, fmt: str) -> tuple[str, str]:
    """Exporta un objeto. Devuelve (ruta, mensaje); ruta vacía si falló."""
    os.makedirs(directory, exist_ok=True)
    _select_only([obj])
    fmt = fmt.upper()

    if fmt == "GLB":
        path = os.path.join(directory, f"{obj.name}.glb")
        try:
            bpy.ops.export_scene.gltf(
                filepath=path, export_format="GLB",
                use_selection=True, export_apply=True,
            )
            return path, f"{obj.name} → GLB"
        except (RuntimeError, TypeError) as exc:
            return "", f"{obj.name}: falló la exportación a GLB ({exc})"

    if fmt == "FBX":
        path = os.path.join(directory, f"{obj.name}.fbx")
        try:
            bpy.ops.export_scene.fbx(
                filepath=path, use_selection=True,
                apply_scale_options="FBX_SCALE_ALL", mesh_smooth_type="FACE",
            )
            return path, f"{obj.name} → FBX"
        except (RuntimeError, TypeError) as exc:
            return "", f"{obj.name}: falló la exportación a FBX ({exc})"

    if fmt == "OBJ":
        path = os.path.join(directory, f"{obj.name}.obj")
        if bpy.app.version >= (4, 0, 0):
            try:
                bpy.ops.wm.obj_export(filepath=path, export_selected_objects=True)
                return path, f"{obj.name} → OBJ (wm.obj_export, Blender 4.x)"
            except (RuntimeError, AttributeError, TypeError) as exc:
                return "", f"{obj.name}: falló la exportación a OBJ ({exc})"
        try:
            bpy.ops.export_scene.obj(filepath=path, use_selection=True)
            return path, f"{obj.name} → OBJ (export_scene.obj, Blender 3.x)"
        except (RuntimeError, AttributeError, TypeError) as exc:
            return "", f"{obj.name}: falló la exportación a OBJ ({exc})"

    return "", f"Formato no soportado: {fmt}"


def export_textures(images: dict, directory: str) -> tuple[list[str], list[str]]:
    """Guarda los mapas horneados como PNG junto a los modelos.

    Sin esto las texturas viven solo dentro del .blend y el modelo exportado
    llega gris al motor de destino.
    """
    if not images:
        return [], ["Sin mapas horneados que exportar."]
    tex_dir = os.path.join(directory, "textures")
    os.makedirs(tex_dir, exist_ok=True)

    paths: list[str] = []
    notes: list[str] = []
    for map_type, image in images.items():
        path = os.path.join(tex_dir, f"{image.name}.png")
        try:
            image.filepath_raw = path
            image.file_format = "PNG"
            image.save()
            paths.append(path)
            notes.append(f"{map_type} → {os.path.basename(path)}")
        except (RuntimeError, OSError) as exc:
            notes.append(f"{map_type}: no se pudo guardar ({exc})")
    return paths, notes


def export_all(
    lods: dict,
    images: dict,
    directory: str,
    formats=("GLB",),
    include_master: bpy.types.Object | None = None,
) -> tuple[list[str], list[str]]:
    """Exporta los niveles pedidos más las texturas."""
    if not directory:
        return [], ["Sin carpeta de destino: no se exporta nada."]

    paths: list[str] = []
    notes: list[str] = []

    targets = list(lods.items())
    if include_master is not None:
        targets.insert(0, ("MASTER_ULTRA", include_master))

    for _, obj in targets:
        for fmt in formats:
            path, msg = export_object(obj, directory, fmt)
            notes.append(msg)
            if path:
                paths.append(path)

    tex_paths, tex_notes = export_textures(images, directory)
    paths.extend(tex_paths)
    notes.extend(tex_notes)

    notes.append(f"{len(paths)} archivos escritos en {directory}")
    return paths, notes
