"""Medición del modelo dentro de Blender: llena el MeshStats extendido.

Todo lo que toca bpy/bmesh vive en este módulo y en sus hermanos; las
decisiones se toman en `core/`, que no importa bpy y por eso se puede
testear. Acá solo se MIDE: ninguna función de este archivo modifica el
objeto que recibe.

Dos mediciones merecen aclaración porque Blender no las da hechas:

  - **Curvatura**: no existe una propiedad de curvatura por cara. Se
    aproxima por el ángulo diedro promedio contra las caras vecinas, que es
    la discretización estándar y es suficiente para repartir subdivisión.
  - **UVs superpuestas**: detectar solapamiento exacto de triángulos UV es
    caro. Se estima por muestreo Monte Carlo sobre una grilla; el resultado
    es una estimación y el informe lo dice así.
"""

from __future__ import annotations

import math
import random

import bmesh
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

from .core.stats import MeshStats

# Ángulo a partir del cual una arista se considera "dura".
SHARP_ANGLE = math.radians(30.0)
# Por debajo de esto, la superficie local se considera plana.
PLANAR_ANGLE = math.radians(5.0)
# Relación de aspecto a partir de la cual una cara es un "sliver".
THIN_FACE_ASPECT = 20.0
# Área relativa por debajo de la cual una cara es degenerada.
DEGENERATE_AREA_FACTOR = 1e-8

UV_GRID = 512
UV_SAMPLES_PER_FACE = 4
SYMMETRY_SAMPLES = 3_000
SELF_INTERSECT_LIMIT = 400_000  # por encima, el test de auto-intersección no se corre


# --------------------------------------------------------------- utilidades


def _bmesh_from(obj: bpy.types.Object, evaluated: bool = False) -> bmesh.types.BMesh:
    """bmesh nuevo a partir del objeto. NO se escribe de vuelta nunca."""
    bm = bmesh.new()
    if evaluated:
        depsgraph = bpy.context.evaluated_depsgraph_get()
        eval_obj = obj.evaluated_get(depsgraph)
        bm.from_mesh(eval_obj.to_mesh())
        eval_obj.to_mesh_clear()
    else:
        bm.from_mesh(obj.data)
    bm.verts.ensure_lookup_table()
    bm.edges.ensure_lookup_table()
    bm.faces.ensure_lookup_table()
    return bm


def bbox_diagonal(obj: bpy.types.Object) -> float:
    """Diagonal del bounding box en espacio de mundo.

    Es la unidad con la que se normalizan todas las desviaciones: así un
    umbral vale igual para un tero de 30 cm que para un ombú de 9 m.
    """
    corners = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
    if not corners:
        return 0.0
    lo = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
    hi = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
    return (hi - lo).length


def evaluated_tris(obj: bpy.types.Object) -> int:
    """Triángulos REALES después de los modificadores.

    Mirar `len(mesh.polygons)` engaña: un objeto de 500 caras con un
    Subsurf de nivel 3 llega al visor con 128.000.
    """
    depsgraph = bpy.context.evaluated_depsgraph_get()
    eval_obj = obj.evaluated_get(depsgraph)
    mesh = eval_obj.to_mesh()
    try:
        mesh.calc_loop_triangles()
        return len(mesh.loop_triangles)
    finally:
        eval_obj.to_mesh_clear()


# ------------------------------------------------------------- materiales


def _image_nodes(mat: bpy.types.Material):
    if not mat or not mat.use_nodes or not mat.node_tree:
        return []
    return [n for n in mat.node_tree.nodes if n.type == "TEX_IMAGE" and n.image]


def _linked_image(node_tree, socket) -> bool:
    """¿Hay una imagen conectada a este socket, directa o vía un nodo?

    Se sigue la cadena hacia atrás unos pocos saltos porque entre la textura
    y el socket suele haber un Normal Map, un Mix o un Color Ramp.
    """
    if not socket or not socket.is_linked:
        return False
    frontier = [l.from_node for l in socket.links]
    seen = set()
    for _ in range(6):
        nxt = []
        for node in frontier:
            if node is None or node in seen:
                continue
            seen.add(node)
            if node.type == "TEX_IMAGE" and node.image:
                return True
            for inp in node.inputs:
                for link in inp.links:
                    nxt.append(link.from_node)
        if not nxt:
            break
        frontier = nxt
    return False


def _scan_materials(obj: bpy.types.Object, stats: MeshStats) -> None:
    """Inventario de materiales, texturas y mapas presentes."""
    stats.materials = len([s for s in obj.material_slots if s.material])
    textured = 0
    max_res = 0

    for slot in obj.material_slots:
        mat = slot.material
        if not mat:
            continue
        if mat.use_nodes:
            stats.uses_nodes = True
        images = _image_nodes(mat)
        if images:
            textured += 1
        for node in images:
            img = node.image
            try:
                max_res = max(max_res, img.size[0], img.size[1])
            except Exception:
                pass
            name = (img.name or "").lower() + " " + (node.label or "").lower()
            if any(k in name for k in ("normal", "_nor", "nrm")):
                stats.has_normal_map = True
            if any(k in name for k in ("rough", "_rgh")):
                stats.has_roughness_map = True
            if any(k in name for k in ("disp", "height", "bump")):
                stats.has_displacement_map = True
            if any(k in name for k in ("ao", "occlusion", "_arm")):
                stats.has_ao_map = True
            if getattr(img, "source", "") == "TILED":
                stats.udim_tiles = max(stats.udim_tiles, len(img.tiles))

        # Detección por conexión, que es más fiable que el nombre.
        if mat.use_nodes and mat.node_tree:
            for node in mat.node_tree.nodes:
                if node.type == "BSDF_PRINCIPLED":
                    if _linked_image(mat.node_tree, node.inputs.get("Normal")):
                        stats.has_normal_map = True
                    if _linked_image(mat.node_tree, node.inputs.get("Roughness")):
                        stats.has_roughness_map = True
                if node.type == "OUTPUT_MATERIAL":
                    disp = node.inputs.get("Displacement")
                    if disp and disp.is_linked:
                        stats.has_displacement_map = True

    stats.textured_materials = textured
    stats.texture_resolution = max_res


# --------------------------------------------------------------------- UVs


def _measure_uvs(bm: bmesh.types.BMesh, stats: MeshStats) -> None:
    """Tiles UDIM, aprovechamiento del espacio UV y solapamiento estimado."""
    if not bm.loops.layers.uv:
        return
    uv_layer = bm.loops.layers.uv.active
    if uv_layer is None:
        return

    tiles: set[tuple[int, int]] = set()
    # Monte Carlo: se marcan celdas con el índice de cara que las reclamó
    # primero; un punto que cae en una celda de otra cara cuenta como
    # solapamiento. Es una ESTIMACIÓN, no una detección exacta.
    grid: dict[tuple[int, int], int] = {}
    hits = 0
    samples = 0
    used_cells: set[tuple[int, int]] = set()

    rng = random.Random(1234)  # determinista: dos corridas dan el mismo número
    for idx, face in enumerate(bm.faces):
        uvs = [l[uv_layer].uv for l in face.loops]
        if len(uvs) < 3:
            continue
        for uv in uvs:
            tiles.add((int(math.floor(uv.x)), int(math.floor(uv.y))))
        for _ in range(UV_SAMPLES_PER_FACE):
            # Punto aleatorio dentro del triángulo (0, 1, k).
            k = rng.randrange(2, len(uvs))
            a, b, c = uvs[0], uvs[k - 1], uvs[k]
            r1, r2 = rng.random(), rng.random()
            if r1 + r2 > 1.0:
                r1, r2 = 1.0 - r1, 1.0 - r2
            p = a + (b - a) * r1 + (c - a) * r2
            cell = (int(p.x * UV_GRID) % (UV_GRID * 8), int(p.y * UV_GRID) % (UV_GRID * 8))
            samples += 1
            used_cells.add(cell)
            owner = grid.get(cell)
            if owner is None:
                grid[cell] = idx
            elif owner != idx:
                hits += 1

    if samples:
        stats.uv_overlap_ratio = hits / samples
        stats.uv_area_ratio = min(1.0, len(used_cells) / float(UV_GRID * UV_GRID))
    stats.udim_tiles = max(stats.udim_tiles, len(tiles))


# ------------------------------------------------------------------ forma


def _measure_shape(bm: bmesh.types.BMesh, stats: MeshStats) -> list[float]:
    """Curvatura, planaridad, aristas duras y caras defectuosas.

    Devuelve la curvatura por cara (misma longitud que bm.faces), que
    `curvature_fractions` usa para repartir la subdivisión.
    """
    total_area = 0.0
    planar_area = 0.0
    upward_area = 0.0
    curvatures: list[float] = []
    degenerate = 0
    thin = 0

    areas = [f.calc_area() for f in bm.faces]
    mean_area = (sum(areas) / len(areas)) if areas else 0.0
    degenerate_threshold = mean_area * DEGENERATE_AREA_FACTOR

    for face, area in zip(bm.faces, areas):
        total_area += area
        if area <= degenerate_threshold or area <= 0.0:
            degenerate += 1
            curvatures.append(0.0)
            continue

        perimeter = sum(e.calc_length() for e in face.edges)
        if perimeter > 0.0:
            # Un triángulo equilátero tiene P²/A ≈ 20.8; muy por encima de
            # eso, la cara es una astilla que revienta al subdividir.
            if (perimeter * perimeter) / area > THIN_FACE_ASPECT * 4.0:
                thin += 1

        n = face.normal
        if n.length_squared > 0.0 and n.z > 0.7:
            upward_area += area

        # Curvatura discreta: ángulo diedro promedio con las caras vecinas.
        angles = []
        for edge in face.edges:
            for other in edge.link_faces:
                if other is face:
                    continue
                try:
                    angles.append(n.angle(other.normal))
                except ValueError:
                    pass
        if angles:
            mean_angle = sum(angles) / len(angles)
            curvatures.append(min(1.0, mean_angle / math.pi))
            if mean_angle < PLANAR_ANGLE:
                planar_area += area
        else:
            curvatures.append(0.0)
            planar_area += area  # cara aislada: no hay forma que describir

    stats.surface_area = total_area
    stats.degenerate_faces = degenerate
    stats.thin_faces = thin
    if total_area > 1e-12:
        stats.planar_ratio = planar_area / total_area
        stats.upward_face_ratio = upward_area / total_area

    if curvatures:
        mean_c = sum(curvatures) / len(curvatures)
        stats.curvature_mean = mean_c
        stats.curvature_std = math.sqrt(
            sum((c - mean_c) ** 2 for c in curvatures) / len(curvatures)
        )

    sharp = 0
    lengths = []
    for edge in bm.edges:
        lengths.append(edge.calc_length())
        if len(edge.link_faces) == 2:
            try:
                if edge.calc_face_angle() > SHARP_ANGLE:
                    sharp += 1
            except ValueError:
                pass
    if bm.edges:
        stats.sharp_edges_ratio = sharp / len(bm.edges)
    if lengths:
        m = sum(lengths) / len(lengths)
        stats.edge_length_mean = m
        stats.edge_length_std = math.sqrt(sum((l - m) ** 2 for l in lengths) / len(lengths))

    return curvatures


def _count_loose_parts(bm: bmesh.types.BMesh) -> int:
    """Islas desconectadas, por recorrido en anchura sobre las caras."""
    seen: set[int] = set()
    parts = 0
    for face in bm.faces:
        if face.index in seen:
            continue
        parts += 1
        stack = [face]
        seen.add(face.index)
        while stack:
            f = stack.pop()
            for edge in f.edges:
                for other in edge.link_faces:
                    if other.index not in seen:
                        seen.add(other.index)
                        stack.append(other)
    return max(1, parts)


def _measure_symmetry(bm: bmesh.types.BMesh, stats: MeshStats) -> None:
    """Simetría bilateral por eje, muestreando vértices y buscando su espejo.

    Sirve para separar un animal o una figura humana (muy simétricos) de una
    roca o un terreno. Se mide contra el centro del bounding box, no contra
    el origen del objeto, que puede estar en cualquier lado.
    """
    verts = [v.co.copy() for v in bm.verts]
    if len(verts) < 20:
        return

    if len(verts) > SYMMETRY_SAMPLES:
        rng = random.Random(4321)
        sample = rng.sample(verts, SYMMETRY_SAMPLES)
    else:
        sample = verts

    lo = Vector((min(v.x for v in verts), min(v.y for v in verts), min(v.z for v in verts)))
    hi = Vector((max(v.x for v in verts), max(v.y for v in verts), max(v.z for v in verts)))
    center = (lo + hi) * 0.5
    diag = (hi - lo).length
    if diag <= 1e-9:
        return
    tol = diag * 0.02

    try:
        tree = BVHTree.FromBMesh(bm)
    except Exception:
        return

    for axis, attr in ((0, "symmetry_x"), (1, "symmetry_y"), (2, "symmetry_z")):
        matched = 0
        for co in sample:
            mirrored = co.copy()
            mirrored[axis] = 2.0 * center[axis] - co[axis]
            hit = tree.find_nearest(mirrored, tol * 4.0)
            if hit and hit[0] is not None and (hit[0] - mirrored).length <= tol:
                matched += 1
        setattr(stats, attr, matched / len(sample))


def _count_self_intersections(bm: bmesh.types.BMesh) -> int:
    """Pares de caras que se atraviesan. -1 si no se pudo medir.

    BVHTree.overlap consigo mismo devuelve también pares de caras vecinas
    que solo se tocan en una arista, así que se descartan las que comparten
    vértices. En mallas enormes el costo es prohibitivo y se informa como
    no medido en vez de colgar la sesión.
    """
    if len(bm.faces) > SELF_INTERSECT_LIMIT:
        return -1
    try:
        tree = BVHTree.FromBMesh(bm, epsilon=0.0)
        pairs = tree.overlap(tree)
    except Exception:
        return -1

    count = 0
    for a, b in pairs:
        if a >= b:
            continue
        try:
            fa, fb = bm.faces[a], bm.faces[b]
        except IndexError:
            continue
        if set(fa.verts) & set(fb.verts):
            continue  # vecinas, no intersección real
        count += 1
    return count


# ------------------------------------------------------------------ público


def analyze_object(obj: bpy.types.Object, deep: bool = True) -> MeshStats:
    """Mide el objeto SIN modificarlo y devuelve el expediente completo.

    `deep=False` saltea simetría y auto-intersecciones, que son las medidas
    caras; sirve para reanalizar rápido entre etapas.
    """
    if obj is None or obj.type != "MESH":
        raise ValueError("Se esperaba un objeto de tipo MESH")

    stats = MeshStats(name=obj.name)
    stats.source_file = bpy.path.basename(bpy.data.filepath or "")
    stats.name_hints = [obj.name, obj.data.name]
    stats.modifiers = [m.type for m in obj.modifiers]

    bm = _bmesh_from(obj)
    try:
        stats.verts = len(bm.verts)
        stats.edges = len(bm.edges)
        stats.faces = len(bm.faces)

        tris = quads = ngons = 0
        for f in bm.faces:
            n = len(f.verts)
            tris += max(0, n - 2)   # un polígono de n lados aporta n-2 triángulos
            if n == 4:
                quads += 1
            elif n > 4:
                ngons += 1
        stats.tris = tris
        stats.quads = quads
        stats.ngons = ngons

        stats.loose_verts = sum(1 for v in bm.verts if not v.link_faces)
        stats.loose_edges = sum(1 for e in bm.edges if not e.link_faces)
        stats.non_manifold_edges = sum(1 for e in bm.edges if not e.is_manifold)
        stats.non_manifold_verts = sum(1 for v in bm.verts if not v.is_manifold)
        stats.boundary_edges = sum(1 for e in bm.edges if e.is_boundary)
        # Cara interior: todos sus bordes tocan 3+ caras, o sea que está
        # metida dentro del volumen y nunca se ve, pero se paga igual.
        stats.interior_faces = sum(
            1 for f in bm.faces if f.edges and all(len(e.link_faces) > 2 for e in f.edges)
        )

        try:
            stats.volume = abs(bm.calc_volume(signed=True))
        except Exception:
            stats.volume = 0.0

        # find_doubles informa sin tocar la malla.
        try:
            res = bmesh.ops.find_doubles(bm, verts=bm.verts[:], dist=1e-5)
            stats.duplicate_verts = len(res.get("targetmap", {}))
        except Exception:
            stats.duplicate_verts = 0

        # Normales invertidas respecto al criterio de recalculado hacia afuera.
        stats.flipped_normals = _count_flipped(bm)

        _measure_shape(bm, stats)
        _measure_uvs(bm, stats)
        stats.loose_parts = _count_loose_parts(bm)

        if deep:
            _measure_symmetry(bm, stats)
            stats.self_intersections = _count_self_intersections(bm)
        else:
            stats.self_intersections = -1
    finally:
        bm.free()

    mesh = obj.data
    stats.uv_layers = len(mesh.uv_layers)
    stats.vertex_color_layers = len(getattr(mesh, "color_attributes", []) or [])
    stats.has_custom_normals = bool(getattr(mesh, "has_custom_normals", False))
    stats.shade_smooth = any(p.use_smooth for p in mesh.polygons) if mesh.polygons else False
    stats.shape_keys = len(mesh.shape_keys.key_blocks) - 1 if mesh.shape_keys else 0
    stats.vertex_groups = len(obj.vertex_groups)
    stats.has_armature = any(m.type == "ARMATURE" for m in obj.modifiers) or (
        obj.parent is not None and obj.parent.type == "ARMATURE"
    )
    stats.dimensions = tuple(obj.dimensions)
    stats.scale = tuple(obj.scale)

    _scan_materials(obj, stats)
    return stats


def _count_flipped(bm: bmesh.types.BMesh) -> int:
    """Caras cuya normal queda al revés del recalculado hacia afuera.

    Se hace sobre una COPIA: recalc_face_normals modifica la malla, y este
    módulo no modifica nada.
    """
    try:
        clone = bm.copy()
    except Exception:
        return 0
    try:
        before = [f.normal.copy() for f in bm.faces]
        bmesh.ops.recalc_face_normals(clone, faces=clone.faces[:])
        clone.faces.ensure_lookup_table()
        flipped = 0
        for i, f in enumerate(clone.faces):
            if i >= len(before):
                break
            if before[i].dot(f.normal) < 0.0:
                flipped += 1
        return flipped
    except Exception:
        return 0
    finally:
        clone.free()


def curvature_fractions(obj: bpy.types.Object, bands: int = 3) -> list[float]:
    """Fracción de ÁREA en cada franja de curvatura, de plana a muy curva.

    Es el dato que convierte la subdivisión en adaptativa: sin él, el plan
    reparte parejo y lo dice. Se pondera por área y no por cantidad de caras
    porque mil caras diminutas en una hebilla no deben pesar más que la
    superficie entera del torso.
    """
    bm = _bmesh_from(obj)
    try:
        curvs = _measure_shape(bm, MeshStats())
        areas = [f.calc_area() for f in bm.faces]
    finally:
        bm.free()

    if not curvs or not areas:
        return []

    total = sum(areas)
    if total <= 1e-12:
        return []

    # Los cortes son por ÁNGULO, no por cuantiles de área. Un corte por
    # cuantiles daría siempre tercios iguales por definición, y entonces la
    # subdivisión nunca se enteraría de cuánto del modelo es plano — que es
    # justo el dato que hace falta para repartir los polígonos.
    cuts = _curvature_cuts(bands)
    buckets = [0.0] * bands
    for c, a in zip(curvs, areas):
        idx = bands - 1
        for i, limit in enumerate(cuts):
            if c < limit:
                idx = i
                break
        buckets[idx] += a

    return [round(b / total, 4) for b in buckets]


def _curvature_cuts(bands: int) -> list[float]:
    """Umbrales de curvatura normalizada (ángulo / pi) entre franjas.

    Con tres franjas: plano por debajo de 6°, curvatura media hasta 25°, y
    de ahí para arriba es forma marcada. Son los ángulos a los que el
    facetado empieza a verse en una superficie sombreada suave.
    """
    if bands <= 1:
        return []
    degrees = [6.0, 25.0, 55.0, 90.0]
    return [math.radians(d) / math.pi for d in degrees[: bands - 1]]


def measure_deviation(
    reference: bpy.types.Object,
    candidate: bpy.types.Object,
    samples: int = 20_000,
) -> tuple[list[float], list[float], float]:
    """Distancias en AMBOS sentidos entre dos objetos, en espacio de mundo.

    Devuelve (referencia→candidato, candidato→referencia, diagonal).

    Medir en un solo sentido esconde lo que se perdió: si el candidato se
    comió una oreja, todos SUS puntos siguen cerca de la referencia y la
    medición unidireccional da bien. Por eso van los dos.

    Limitación real: es muestreo, no una distancia de Hausdorff exacta —
    Blender no expone ninguna. Con 20.000 muestras el percentil 99 es
    estable; con pocas, `core.deviation` marca el resultado como no fiable.
    """
    depsgraph = bpy.context.evaluated_depsgraph_get()

    def tree_and_points(obj):
        bm = bmesh.new()
        eval_obj = obj.evaluated_get(depsgraph)
        mesh = eval_obj.to_mesh()
        try:
            bm.from_mesh(mesh)
        finally:
            eval_obj.to_mesh_clear()
        bm.transform(obj.matrix_world)
        bm.verts.ensure_lookup_table()
        pts = [v.co.copy() for v in bm.verts]
        tree = BVHTree.FromBMesh(bm)
        bm.free()
        return tree, pts

    tree_ref, pts_ref = tree_and_points(reference)
    tree_cand, pts_cand = tree_and_points(candidate)

    diag = max(bbox_diagonal(reference), 1e-9)
    max_dist = diag  # buscar más lejos que el objeto entero no aporta nada

    rng = random.Random(9001)

    def sample(points, tree):
        pool = points if len(points) <= samples else rng.sample(points, samples)
        out: list[float] = []
        for p in pool:
            hit = tree.find_nearest(p, max_dist)
            if hit and hit[0] is not None:
                out.append((hit[0] - p).length)
            else:
                out.append(max_dist)
        return out

    forward = sample(pts_ref, tree_cand)
    backward = sample(pts_cand, tree_ref)
    return forward, backward, diag
