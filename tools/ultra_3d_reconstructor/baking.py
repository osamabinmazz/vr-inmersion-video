"""Horneado de mapas del master al modelo liviano.

Es la etapa que devuelve, en textura, el detalle que el LOD perdió en
geometría. Un normal map bien horneado hace que 20.000 triángulos se lean
como 2 millones, y cuesta memoria de textura en vez de memoria de malla —
que en VR es el cambio que conviene.

**Limitaciones reales de Blender, y qué se hace con cada una:**

  - No existe un tipo de bake "curvature" ni "cavity". La alternativa
    disponible —y la que usa todo el mundo— es armar un material temporal
    con el nodo Geometry → Pointiness y hornear EMIT. Eso es exactamente lo
    que hace `bake_pointiness_map`: no es una simulación del mapa, es el
    mapa, generado por el único camino que el programa ofrece.
  - El bake de altura (displacement) solo existe para Multires. Si el
    modelo no tiene Multires, se dice y se omite, en vez de entregar una
    imagen gris que no sirve para nada.
  - El horneado exige el motor Cycles. Se cambia el motor, se hornea y se
    restaura el que estaba.
"""

from __future__ import annotations

import bpy

from .cleanup import activate

# Tipos de bake nativos que Blender sí tiene.
NATIVE_BAKE = {
    "NORMAL": "NORMAL",
    "AO": "AO",
    "COLOR": "DIFFUSE",
}

# Fracción de la diagonal usada como extrusión de la jaula. Muy poco deja
# huecos sin hornear; demasiado captura geometría del otro lado del objeto.
CAGE_FACTOR = 0.02


def _new_image(name: str, size: int, is_data: bool, color=(0.5, 0.5, 1.0, 1.0)) -> bpy.types.Image:
    img = bpy.data.images.get(name)
    if img is not None and (img.size[0] != size or img.size[1] != size):
        bpy.data.images.remove(img)
        img = None
    if img is None:
        img = bpy.data.images.new(name, width=size, height=size, alpha=False, float_buffer=False)
    img.generated_color = color
    img.colorspace_settings.name = "Non-Color" if is_data else "sRGB"
    return img


def _bake_target_material(obj: bpy.types.Object, image: bpy.types.Image) -> bpy.types.Material:
    """Material del objeto liviano con el nodo de imagen ACTIVO.

    Blender hornea sobre el nodo de textura seleccionado del material
    activo. Si ese nodo no queda activo, el operador falla con un mensaje
    que no explica nada; por eso se fuerza explícitamente.
    """
    if obj.data.materials:
        mat = obj.data.materials[0]
    else:
        mat = bpy.data.materials.new(f"{obj.name}_ULTRA")
        obj.data.materials.append(mat)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes

    node = nodes.get("ULTRA_BakeTarget")
    if node is None:
        node = nodes.new("ShaderNodeTexImage")
        node.name = "ULTRA_BakeTarget"
        node.location = (-400, 400)
    node.image = image
    node.select = True
    nodes.active = node
    return mat


def _pointiness_material(name: str, cavity: bool) -> bpy.types.Material:
    """Material temporal que emite la 'pointiness' de la geometría.

    Es el único camino que Blender ofrece para obtener curvatura/cavidad
    como imagen: no hay bake type nativo.
    """
    mat = bpy.data.materials.get(name)
    if mat is None:
        mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    tree = mat.node_tree
    tree.nodes.clear()

    geo = tree.nodes.new("ShaderNodeNewGeometry")
    ramp = tree.nodes.new("ShaderNodeValToRGB")
    emit = tree.nodes.new("ShaderNodeEmission")
    out = tree.nodes.new("ShaderNodeOutputMaterial")

    # La pointiness vive comprimida cerca de 0.5; el ramp la expande para
    # que el mapa tenga rango utilizable.
    if cavity:
        ramp.color_ramp.elements[0].position = 0.40
        ramp.color_ramp.elements[1].position = 0.52
    else:
        ramp.color_ramp.elements[0].position = 0.44
        ramp.color_ramp.elements[1].position = 0.58

    tree.links.new(geo.outputs["Pointiness"], ramp.inputs["Fac"])
    tree.links.new(ramp.outputs["Color"], emit.inputs["Color"])
    tree.links.new(emit.outputs["Emission"], out.inputs["Surface"])
    return mat


class BakeSession:
    """Cambia el motor a Cycles para hornear y lo restaura al salir."""

    def __init__(self, samples: int = 8, use_gpu: bool = True):
        self.samples = samples
        self.use_gpu = use_gpu
        self._engine = None
        self._samples = None
        self._device = None

    def __enter__(self):
        scene = bpy.context.scene
        self._engine = scene.render.engine
        scene.render.engine = "CYCLES"
        self._samples = scene.cycles.samples
        self._device = scene.cycles.device
        scene.cycles.samples = self.samples
        if self.use_gpu:
            try:
                scene.cycles.device = "GPU"
            except Exception:
                scene.cycles.device = "CPU"
        scene.render.bake.use_selected_to_active = True
        scene.render.bake.use_clear = True
        return self

    def __exit__(self, *exc):
        scene = bpy.context.scene
        scene.render.engine = self._engine
        if self._samples is not None:
            scene.cycles.samples = self._samples
        if self._device is not None:
            scene.cycles.device = self._device
        return False


def _select_pair(low: bpy.types.Object, high: bpy.types.Object) -> None:
    """Alto seleccionado + bajo activo: es como Blender espera el par."""
    activate(low)
    high.hide_viewport = False
    high.select_set(True)
    low.select_set(True)
    bpy.context.view_layer.objects.active = low


def bake_map(
    low: bpy.types.Object,
    high: bpy.types.Object,
    map_type: str,
    size: int,
    cage_distance: float,
) -> tuple[bpy.types.Image | None, str]:
    """Hornea UN mapa del objeto denso al liviano."""
    if not low.data.uv_layers:
        return None, f"{map_type}: el modelo liviano no tiene UVs. No se puede hornear."

    is_data = map_type != "COLOR"
    default = (0.5, 0.5, 1.0, 1.0) if map_type == "NORMAL" else (0.0, 0.0, 0.0, 1.0)
    image = _new_image(f"{low.name}_{map_type}", size, is_data, default)
    _bake_target_material(low, image)

    scene = bpy.context.scene
    scene.render.bake.cage_extrusion = cage_distance
    scene.render.bake.max_ray_distance = cage_distance * 2.0

    if map_type in NATIVE_BAKE:
        bake_type = NATIVE_BAKE[map_type]
        _select_pair(low, high)
        try:
            if bake_type == "DIFFUSE":
                scene.render.bake.use_pass_direct = False
                scene.render.bake.use_pass_indirect = False
                scene.render.bake.use_pass_color = True
            bpy.ops.object.bake(type=bake_type, use_selected_to_active=True)
        except RuntimeError as exc:
            return None, f"{map_type}: el horneado falló ({exc})."
        return image, f"{map_type} horneado a {size}px."

    if map_type in ("CURVATURE", "CAVITY"):
        return _bake_pointiness(low, high, image, map_type, size)

    if map_type == "HEIGHT":
        return _bake_height(low, high, image, size)

    return None, f"{map_type}: tipo de mapa no reconocido."


def _bake_pointiness(low, high, image, map_type, size):
    """Curvatura/cavidad vía Geometry → Pointiness + bake EMIT."""
    original = list(high.data.materials)
    temp = _pointiness_material(f"ULTRA_{map_type}", cavity=(map_type == "CAVITY"))
    high.data.materials.clear()
    high.data.materials.append(temp)
    try:
        _select_pair(low, high)
        bpy.ops.object.bake(type="EMIT", use_selected_to_active=True)
        msg = (
            f"{map_type} horneado a {size}px vía Geometry → Pointiness. "
            "Blender no tiene un bake nativo de curvatura; este es el camino real, "
            "no una aproximación inventada."
        )
        return image, msg
    except RuntimeError as exc:
        return None, f"{map_type}: el horneado por pointiness falló ({exc})."
    finally:
        high.data.materials.clear()
        for m in original:
            high.data.materials.append(m)


def _bake_height(low, high, image, size):
    """Displacement: solo existe por Multires."""
    multires = next((m for m in low.modifiers if m.type == "MULTIRES"), None)
    if multires is None:
        return None, (
            "HEIGHT omitido: Blender solo hornea displacement desde un modificador "
            "Multires, y este modelo no lo tiene. El normal map cubre el mismo "
            "microrelieve con menos problemas de silueta."
        )
    _bake_target_material(low, image)
    activate(low)
    scene = bpy.context.scene
    scene.render.use_bake_multires = True
    scene.render.bake_type = "DISPLACEMENT"
    try:
        bpy.ops.object.bake_image()
        return image, f"HEIGHT horneado a {size}px desde Multires."
    except RuntimeError as exc:
        return None, f"HEIGHT: el horneado desde Multires falló ({exc})."
    finally:
        scene.render.use_bake_multires = False


def detect_projection_errors(image: bpy.types.Image, map_type: str) -> str | None:
    """Busca zonas sin hornear: píxeles que quedaron en el color de fondo.

    Es el fallo silencioso más común del horneado: la jaula no alcanzó y
    quedan parches vacíos que recién se ven en el visor. Detectarlo acá
    cuesta un muestreo; detectarlo tarde cuesta rehacer el LOD.
    """
    try:
        pixels = list(image.pixels)
    except Exception:
        return None
    if not pixels:
        return None

    total = len(pixels) // 4
    if total == 0:
        return None

    step = max(1, total // 20_000)  # muestreo: leer 16M de floats es carísimo
    empty = 0
    checked = 0
    for i in range(0, total, step):
        r, g, b = pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2]
        checked += 1
        if map_type == "NORMAL":
            # Normal tangente sin hornear = exactamente el azul de fondo.
            if abs(r - 0.5) < 0.004 and abs(g - 0.5) < 0.004 and abs(b - 1.0) < 0.004:
                empty += 1
        else:
            if r < 0.004 and g < 0.004 and b < 0.004:
                empty += 1

    if not checked:
        return None
    ratio = empty / checked
    if ratio > 0.25:
        return (
            f"{map_type}: {ratio * 100:.0f}% de la textura quedó sin hornear. "
            "Casi seguro la jaula (cage extrusion) no alcanza a cubrir la distancia "
            "entre el liviano y el denso: conviene subirla y repetir."
        )
    if ratio > 0.08:
        return (
            f"{map_type}: {ratio * 100:.0f}% sin hornear. Suele ser normal si hay islas "
            "UV con margen, pero conviene mirar el mapa antes de exportar."
        )
    return None


def bake_all(
    low: bpy.types.Object,
    high: bpy.types.Object,
    plan,
    bbox_diagonal: float,
    use_gpu: bool = True,
) -> tuple[dict[str, bpy.types.Image], list[str]]:
    """Hornea todos los mapas que pidió el plan. Devuelve (imágenes, parte)."""
    report: list[str] = []
    images: dict[str, bpy.types.Image] = {}

    if not plan.bake_maps:
        return images, ["El plan no pidió ningún mapa."]
    if not low.data.uv_layers:
        return images, ["Sin UVs en el modelo liviano: no se hornea nada."]

    cage = max(bbox_diagonal * CAGE_FACTOR, 1e-5)
    was_hidden = high.hide_viewport
    high.hide_viewport = False

    try:
        with BakeSession(use_gpu=use_gpu):
            for map_type in plan.bake_maps:
                image, msg = bake_map(low, high, map_type, plan.bake_resolution, cage)
                report.append(msg)
                if image is not None:
                    images[map_type] = image
                    warning = detect_projection_errors(image, map_type)
                    if warning:
                        report.append(warning)
    except Exception as exc:
        report.append(f"El horneado se interrumpió: {exc}")
    finally:
        high.hide_viewport = was_hidden

    if images:
        report.append(
            f"{len(images)} mapas horneados con jaula de {cage:.5f} "
            f"({CAGE_FACTOR * 100:.0f}% de la diagonal del objeto)."
        )
    return images, report


def wire_baked_material(obj: bpy.types.Object, images: dict[str, bpy.types.Image]) -> str:
    """Arma un material Principled con los mapas horneados conectados.

    Sin esto, el horneado entrega imágenes sueltas que alguien tiene que
    cablear a mano. Un solo material además significa un solo draw call,
    que en VR pesa más que unos miles de triángulos.
    """
    mat = bpy.data.materials.new(f"{obj.name}_BAKED")
    mat.use_nodes = True
    tree = mat.node_tree
    tree.nodes.clear()

    bsdf = tree.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (0, 0)
    out = tree.nodes.new("ShaderNodeOutputMaterial")
    out.location = (320, 0)
    tree.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    y = 400
    if "COLOR" in images:
        tex = tree.nodes.new("ShaderNodeTexImage")
        tex.image = images["COLOR"]
        tex.location = (-700, y)
        tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        y -= 300

    if "NORMAL" in images:
        tex = tree.nodes.new("ShaderNodeTexImage")
        tex.image = images["NORMAL"]
        tex.image.colorspace_settings.name = "Non-Color"
        tex.location = (-700, y)
        nmap = tree.nodes.new("ShaderNodeNormalMap")
        nmap.location = (-400, y)
        tree.links.new(tex.outputs["Color"], nmap.inputs["Color"])
        tree.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
        y -= 300

    if "AO" in images:
        # El AO multiplica el color base; si no hay color, no hay dónde
        # aplicarlo y se deja el mapa disponible sin conectar.
        tex = tree.nodes.new("ShaderNodeTexImage")
        tex.image = images["AO"]
        tex.image.colorspace_settings.name = "Non-Color"
        tex.location = (-700, y)
        base_link = next((l for l in tree.links if l.to_socket == bsdf.inputs["Base Color"]), None)
        if base_link is not None:
            mix = tree.nodes.new("ShaderNodeMixRGB")
            mix.blend_type = "MULTIPLY"
            mix.inputs["Fac"].default_value = 0.8
            mix.location = (-250, y + 150)
            source = base_link.from_socket
            tree.links.remove(base_link)
            tree.links.new(source, mix.inputs["Color1"])
            tree.links.new(tex.outputs["Color"], mix.inputs["Color2"])
            tree.links.new(mix.outputs["Color"], bsdf.inputs["Base Color"])

    obj.data.materials.clear()
    obj.data.materials.append(mat)
    return f"Material '{mat.name}' armado con {len(images)} mapas, en un solo slot."
