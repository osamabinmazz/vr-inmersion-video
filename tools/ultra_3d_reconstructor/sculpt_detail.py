"""Microrelieve: solo a partir de evidencia, nunca inventado.

Regla del brief que este módulo respeta al pie de la letra: *nunca inventar
arbitrariamente estructuras importantes si no existe evidencia visual*.

Por eso acá NO hay generadores de ruido de piedra, ni poros procedurales, ni
"detalle artístico". Hay una sola fuente de relieve admitida: un mapa de
altura o displacement que ya venga en los materiales del modelo. Si no lo
hay, la función se abstiene y explica por qué, en vez de fabricar textura
que el objeto real no tiene.

La excepción declarada es el **realce de relieve existente**: amplificar
con Displace un mapa que ya está no agrega información nueva, la hace
visible. Eso sí se hace, con intensidad acotada por el preset.
"""

from __future__ import annotations

import bpy

from .cleanup import activate


def _find_height_images(obj: bpy.types.Object) -> list[bpy.types.Image]:
    """Mapas de altura presentes en los materiales del objeto."""
    found: list[bpy.types.Image] = []
    for slot in obj.material_slots:
        mat = slot.material
        if not mat or not mat.use_nodes or not mat.node_tree:
            continue
        # Por conexión: lo que entra al Displacement del Material Output.
        for node in mat.node_tree.nodes:
            if node.type != "OUTPUT_MATERIAL":
                continue
            disp = node.inputs.get("Displacement")
            if not disp or not disp.is_linked:
                continue
            frontier = [l.from_node for l in disp.links]
            seen = set()
            for _ in range(6):
                nxt = []
                for n in frontier:
                    if n is None or n in seen:
                        continue
                    seen.add(n)
                    if n.type == "TEX_IMAGE" and n.image and n.image not in found:
                        found.append(n.image)
                    for inp in n.inputs:
                        nxt.extend(l.from_node for l in inp.links)
                if not nxt:
                    break
                frontier = nxt
        # Por nombre, como respaldo.
        for node in mat.node_tree.nodes:
            if node.type == "TEX_IMAGE" and node.image:
                name = (node.image.name or "").lower()
                if any(k in name for k in ("disp", "height", "bump")) and node.image not in found:
                    found.append(node.image)
    return found


def apply_evidence_based_detail(
    obj: bpy.types.Object,
    preset,
    bbox_diagonal: float,
) -> list[str]:
    """Realza el relieve que el modelo ya documenta en sus texturas.

    La fuerza se deriva del tamaño del objeto, no de un número fijo: 2 mm de
    desplazamiento es microrelieve en una estatua y una deformación brutal
    en una hebilla.
    """
    strength_factor = preset.sculpt_detail_strength
    if strength_factor <= 0.0:
        return [
            f"El preset {preset.key} no aplica microrelieve: en este tipo de modelo "
            "sería inventar estructura que el original no tiene."
        ]

    if not obj.data.uv_layers:
        return [
            "Sin UVs no se puede proyectar un mapa de altura. Se omite el microrelieve "
            "(generarlo sin referencia sería inventarlo)."
        ]

    images = _find_height_images(obj)
    if not images:
        return [
            "No hay ningún mapa de altura ni displacement en los materiales. "
            "No se agrega microrelieve: sin evidencia visual, cualquier relieve "
            "que se agregara sería inventado."
        ]

    image = images[0]
    tex = bpy.data.textures.get(f"ULTRA_Height_{image.name}")
    if tex is None:
        tex = bpy.data.textures.new(f"ULTRA_Height_{image.name}", type="IMAGE")
    tex.image = image

    activate(obj)
    mod = obj.modifiers.new("ULTRA_Displace", "DISPLACE")
    mod.texture = tex
    mod.texture_coords = "UV"
    mod.mid_level = 0.5
    # Tope duro del 0.4% de la diagonal: por encima de eso ya no es
    # microrelieve, es cambiar la forma del objeto.
    mod.strength = bbox_diagonal * 0.004 * strength_factor

    try:
        bpy.ops.object.modifier_apply(modifier=mod.name)
    except RuntimeError as exc:
        obj.modifiers.remove(mod)
        return [f"No se pudo aplicar el displacement: {exc}"]

    return [
        f"Microrelieve realzado desde '{image.name}' con fuerza "
        f"{mod.strength:.5f} ({strength_factor * 100:.0f}% del tope). "
        "Es relieve que el modelo ya documentaba en su textura, hecho geometría."
    ]
