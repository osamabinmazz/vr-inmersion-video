"""Colecciones, respaldo del original y reparación de malla.

La regla que gobierna todo este módulo: **el objeto original nunca se
modifica**. Se duplica a `00_SOURCE`, se bloquea y se oculta, y a partir de
ahí se trabaja sobre copias. Si una etapa sale mal, el original sigue ahí
para volver a empezar; sin eso, un remesh mal calculado es irreversible.

La segunda regla es que "reparar" no significa cerrar todo: en follaje los
bordes abiertos SON las hojas, y taparlos convierte un ombú en un bloque.
Por eso cada reparación consulta el plan antes de ejecutarse.
"""

from __future__ import annotations

import math

import bmesh
import bpy

# Estructura de trabajo. Cada etapa deja su resultado en su colección, así
# el archivo queda navegable y se puede comparar cualquier par de versiones.
COLLECTIONS = [
    "00_SOURCE",        # original intacto, bloqueado y oculto
    "01_CLEAN",         # copia reparada
    "02_RECONSTRUCTED", # geometría reconstruida (remesh / subdivisión)
    "03_MASTER_ULTRA",  # la versión de máxima calidad
    "04_RETOPO",        # malla de quads limpia
    "05_LODS",          # LOD0..LOD3
    "06_BAKES",         # objetos con los mapas horneados
    "07_COMPARISON",    # escena comparadora
    "08_EXPORT",        # lo que se entrega
    "09_REPORTS",       # textos de informe dentro del .blend
]

SOURCE_COLLECTION = COLLECTIONS[0]


def blender_version() -> tuple[int, int, int]:
    return tuple(bpy.app.version)


# ------------------------------------------------------------ colecciones


def ensure_collections(prefix: str = "ULTRA_3D") -> dict[str, bpy.types.Collection]:
    """Crea (o recupera) la estructura de colecciones del pipeline."""
    scene = bpy.context.scene
    root = bpy.data.collections.get(prefix)
    if root is None:
        root = bpy.data.collections.new(prefix)
        scene.collection.children.link(root)
    elif root.name not in [c.name for c in scene.collection.children]:
        try:
            scene.collection.children.link(root)
        except RuntimeError:
            pass

    out: dict[str, bpy.types.Collection] = {}
    for name in COLLECTIONS:
        full = f"{prefix}_{name}"
        col = bpy.data.collections.get(full)
        if col is None:
            col = bpy.data.collections.new(full)
            root.children.link(col)
        elif col.name not in [c.name for c in root.children]:
            try:
                root.children.link(col)
            except RuntimeError:
                pass
        out[name] = col
    return out


def move_to_collection(obj: bpy.types.Object, collection: bpy.types.Collection) -> None:
    """Deja el objeto en UNA sola colección."""
    for col in list(obj.users_collection):
        col.objects.unlink(obj)
    collection.objects.link(obj)


def duplicate_object(obj: bpy.types.Object, new_name: str) -> bpy.types.Object:
    """Copia real del objeto y de su malla (no comparten datos)."""
    copy = obj.copy()
    copy.data = obj.data.copy()
    copy.name = new_name
    copy.data.name = f"{new_name}_mesh"
    if obj.animation_data and obj.animation_data.action:
        copy.animation_data_create().action = obj.animation_data.action
    bpy.context.scene.collection.objects.link(copy)
    return copy


def backup_source(obj: bpy.types.Object, collections: dict[str, bpy.types.Collection]) -> bpy.types.Object:
    """Guarda el original en 00_SOURCE, bloqueado y oculto.

    Se bloquea la selección además de ocultarlo porque lo que más pasa en la
    práctica no es que alguien lo borre a propósito: es que quede
    seleccionado junto con el resto y se le aplique un modificador sin
    querer.
    """
    backup = duplicate_object(obj, f"{obj.name}_SOURCE")
    move_to_collection(backup, collections[SOURCE_COLLECTION])
    backup.hide_viewport = True
    backup.hide_render = True
    backup.hide_select = True
    backup["ultra3d_role"] = "source"
    backup["ultra3d_original_name"] = obj.name
    return backup


def make_working_copy(
    source: bpy.types.Object,
    collections: dict[str, bpy.types.Collection],
    suffix: str = "CLEAN",
    target: str = "01_CLEAN",
) -> bpy.types.Object:
    """Copia de trabajo sobre la que sí se puede operar."""
    was_hidden = source.hide_select
    source.hide_select = False
    try:
        copy = duplicate_object(source, f"{source.get('ultra3d_original_name', source.name)}_{suffix}")
    finally:
        source.hide_select = was_hidden
    copy.hide_viewport = False
    copy.hide_render = False
    copy.hide_select = False
    move_to_collection(copy, collections[target])
    copy["ultra3d_role"] = suffix.lower()
    return copy


# -------------------------------------------------------------- selección


def activate(obj: bpy.types.Object) -> None:
    """Deja el objeto como único seleccionado y activo.

    Muchos `bpy.ops` trabajan sobre la selección, no sobre lo que se les
    pasa: olvidarse de esto es la causa más común de que un operador se
    aplique al objeto equivocado.
    """
    if bpy.context.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    for o in bpy.context.selected_objects:
        o.select_set(False)
    obj.hide_viewport = False
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


# ------------------------------------------------------------- reparación


def apply_transforms(obj: bpy.types.Object, scale: bool = True, rotation: bool = False) -> str:
    """Aplica la escala (y opcionalmente la rotación).

    Es obligatorio antes de remeshear: el voxel remesh y el Shrinkwrap
    trabajan en distancias absolutas, y con una escala de 0.01 sin aplicar
    el resultado sale cien veces más fino de lo pedido.
    """
    activate(obj)
    try:
        bpy.ops.object.transform_apply(location=False, rotation=rotation, scale=scale)
        return "Transformaciones aplicadas."
    except RuntimeError as exc:
        return f"No se pudo aplicar la transformación: {exc}"


def repair_mesh(obj: bpy.types.Object, plan, merge_distance: float = 1e-5) -> list[str]:
    """Limpieza conservadora sobre la copia de trabajo.

    Lo que se hace siempre: quitar duplicados, sueltos, caras degeneradas e
    interiores, y unificar normales. Nada de eso cambia la forma.

    Lo que depende del plan: cerrar agujeros y disolver n-gons. En follaje
    ambas cosas están prohibidas y el plan lo marca saltando la etapa.
    """
    report: list[str] = []
    mesh = obj.data
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.verts.ensure_lookup_table()
    bm.edges.ensure_lookup_table()
    bm.faces.ensure_lookup_table()

    try:
        before = (len(bm.verts), len(bm.edges), len(bm.faces))

        removed = bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=merge_distance)
        merged = len(removed.get("targetmap", {}) or {})
        if merged:
            report.append(f"{merged} vértices duplicados fusionados (a {merge_distance}).")

        loose_verts = [v for v in bm.verts if not v.link_edges]
        loose_edges = [e for e in bm.edges if not e.link_faces]
        if loose_verts:
            bmesh.ops.delete(bm, geom=loose_verts, context="VERTS")
            report.append(f"{len(loose_verts)} vértices sueltos eliminados.")
        if loose_edges:
            bmesh.ops.delete(bm, geom=loose_edges, context="EDGES")
            report.append(f"{len(loose_edges)} aristas sueltas eliminadas.")

        bm.faces.ensure_lookup_table()
        degenerate = [f for f in bm.faces if f.calc_area() <= 1e-12]
        if degenerate:
            bmesh.ops.delete(bm, geom=degenerate, context="FACES")
            report.append(f"{len(degenerate)} caras degeneradas eliminadas.")

        # Caras interiores: invisibles, pero se rasterizan y rompen el bake.
        bm.faces.ensure_lookup_table()
        interior = [
            f for f in bm.faces if f.edges and all(len(e.link_faces) > 2 for e in f.edges)
        ]
        if interior:
            bmesh.ops.delete(bm, geom=interior, context="FACES")
            report.append(f"{len(interior)} caras interiores eliminadas.")

        if plan.needs_normals_fix:
            bm.faces.ensure_lookup_table()
            bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
            report.append("Normales recalculadas hacia afuera.")

        after = (len(bm.verts), len(bm.edges), len(bm.faces))
        if before != after:
            report.append(
                f"Malla: {before[0]}v/{before[2]}c → {after[0]}v/{after[2]}c."
            )
        bm.to_mesh(mesh)
        mesh.update()
    finally:
        bm.free()

    return report or ["La malla ya estaba limpia: no hizo falta reparar nada."]


def fill_holes(obj: bpy.types.Object, max_sides: int = 12) -> str:
    """Cierra agujeros chicos. NO se llama en modelos con follaje.

    El límite de lados existe para no tapar una boca o un hueco intencional
    con una cara enorme: un agujero de más de 12 lados casi nunca es un
    defecto de malla.
    """
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    try:
        bm.edges.ensure_lookup_table()
        boundary = [e for e in bm.edges if e.is_boundary]
        if not boundary:
            return "No había agujeros que cerrar."
        bmesh.ops.holes_fill(bm, edges=boundary, sides=max_sides)
        bm.to_mesh(obj.data)
        obj.data.update()
        return f"Agujeros cerrados a partir de {len(boundary)} aristas de borde."
    finally:
        bm.free()


def dissolve_ngons(obj: bpy.types.Object, max_sides: int = 4) -> str:
    """Triangula los n-gons dejando quads donde se pueda.

    Un n-gon cóncavo subdividido produce pliegues; convertirlo a quads y
    triángulos antes es más barato que arreglar el artefacto después.
    """
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    try:
        bm.faces.ensure_lookup_table()
        ngons = [f for f in bm.faces if len(f.verts) > max_sides]
        if not ngons:
            return "No había n-gons."
        bmesh.ops.triangulate(bm, faces=ngons, quad_method="BEAUTY", ngon_method="BEAUTY")
        bm.faces.ensure_lookup_table()
        bmesh.ops.join_triangles(
            bm, faces=bm.faces[:],
            angle_face_threshold=math.radians(40.0),
            angle_shape_threshold=math.radians(40.0),
        )
        bm.to_mesh(obj.data)
        obj.data.update()
        return f"{len(ngons)} n-gons resueltos a quads y triángulos."
    finally:
        bm.free()


def ensure_uvs(obj: bpy.types.Object, angle_limit: float = 66.0, margin: float = 0.02) -> str:
    """Garantiza un mapa UV utilizable. Sin UVs no hay horneado posible.

    Smart UV Project no da el mismo resultado que un desplegado a mano, pero
    para hornear mapas es suficiente y es lo único automatizable: la
    alternativa honesta sería no hornear.
    """
    if obj.data.uv_layers:
        return "El modelo ya tenía UVs."
    activate(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    try:
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(
            angle_limit=math.radians(angle_limit),
            island_margin=margin,
            correct_aspect=True,
            scale_to_bounds=False,
        )
    finally:
        bpy.ops.object.mode_set(mode="OBJECT")
    return f"UVs generadas con Smart UV Project (límite {angle_limit:.0f}°)."


def shade_smooth_by_angle(obj: bpy.types.Object, angle_deg: float = 30.0) -> str:
    """Sombreado suave respetando las aristas duras.

    Blender 4.1 eliminó `mesh.use_auto_smooth` y lo reemplazó por un
    operador con modificador. Se detecta la versión en vez de asumir una:
    el add-on tiene que funcionar en las dos.
    """
    activate(obj)
    version = blender_version()
    if version >= (4, 1, 0):
        try:
            bpy.ops.object.shade_smooth_by_angle(angle=math.radians(angle_deg))
            return f"Sombreado suave por ángulo ({angle_deg:.0f}°), Blender {version[0]}.{version[1]}."
        except (AttributeError, RuntimeError):
            bpy.ops.object.shade_smooth()
            return "Sombreado suave aplicado (el operador por ángulo no estaba disponible)."
    bpy.ops.object.shade_smooth()
    mesh = obj.data
    if hasattr(mesh, "use_auto_smooth"):
        mesh.use_auto_smooth = True
        mesh.auto_smooth_angle = math.radians(angle_deg)
        return f"Auto Smooth a {angle_deg:.0f}° (Blender {version[0]}.{version[1]})."
    return "Sombreado suave aplicado."


def add_weighted_normals(obj: bpy.types.Object) -> str:
    """Weighted Normal: mejora el sombreado sin agregar un solo polígono.

    Es de lo más rentable del pipeline —corrige el sombreado sucio en
    biselados y transiciones— y cuesta cero en geometría.
    """
    if any(m.type == "WEIGHTED_NORMAL" for m in obj.modifiers):
        return "Ya tenía Weighted Normal."
    mod = obj.modifiers.new("ULTRA_WeightedNormal", "WEIGHTED_NORMAL")
    mod.keep_sharp = True
    mod.mode = "FACE_AREA_WITH_ANGLE"
    return "Weighted Normal agregado (mejor sombreado sin costo de geometría)."
