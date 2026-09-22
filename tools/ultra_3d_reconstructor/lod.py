"""Generación de los cuatro niveles de detalle.

Un LOD no es "el modelo con menos polígonos": es el modelo con menos
polígonos **que se sigue leyendo igual a la distancia en la que se usa**.
Dos decisiones lo hacen posible:

  - el Decimate colapsa guiado por el grupo de curvatura, así que lo que se
    pierde primero es superficie plana, no silueta;
  - las normales del master se transfieren a cada nivel, de modo que el
    sombreado del LOD3 sigue siendo el del millón de triángulos.

Cada nivel se verifica contra su presupuesto y, si no llega, se dice.
"""

from __future__ import annotations

import bpy

from .cleanup import activate, duplicate_object, move_to_collection, shade_smooth_by_angle
from .reconstruction import CURVATURE_GROUP, build_curvature_group

LOD_ORDER = ("LOD0", "LOD1", "LOD2", "LOD3")

# Distancias sugeridas de conmutación, como fracción del tamaño del objeto.
LOD_SWITCH_HINT = {
    "LOD0": "primer plano (hasta ~3 veces el tamaño del objeto)",
    "LOD1": "media distancia (~3 a 10 veces)",
    "LOD2": "fondo (~10 a 30 veces)",
    "LOD3": "silueta lejana (más de 30 veces)",
}


def _tri_count(obj: bpy.types.Object) -> int:
    return sum(max(0, len(p.vertices) - 2) for p in obj.data.polygons)


def build_lod(
    master: bpy.types.Object,
    name: str,
    target_tris: int,
    collection: bpy.types.Collection,
    preserve_sharp: bool,
    smooth_angle: float,
) -> tuple[bpy.types.Object | None, list[str]]:
    """Crea un nivel a partir del master."""
    report: list[str] = []
    base_name = master.get("ultra3d_original_name", master.name)
    lod = duplicate_object(master, f"{base_name}_{name}")
    move_to_collection(lod, collection)
    lod["ultra3d_role"] = name.lower()

    # Multires no sobrevive al Decimate: se aplica al nivel más alto antes.
    for mod in list(lod.modifiers):
        if mod.type == "MULTIRES":
            activate(lod)
            try:
                bpy.ops.object.modifier_apply(modifier=mod.name)
            except RuntimeError:
                lod.modifiers.remove(mod)

    current = _tri_count(lod)
    if current <= target_tris:
        report.append(
            f"{name}: el master ya tiene {current:,} triángulos, por debajo del "
            f"presupuesto ({target_tris:,}). Se entrega sin decimar."
        )
        shade_smooth_by_angle(lod, smooth_angle)
        return lod, report

    if not lod.vertex_groups.get(CURVATURE_GROUP):
        build_curvature_group(lod)

    activate(lod)
    dec = lod.modifiers.new(f"ULTRA_{name}", "DECIMATE")
    dec.decimate_type = "COLLAPSE"
    dec.ratio = max(0.004, target_tris / current)
    if lod.vertex_groups.get(CURVATURE_GROUP):
        dec.vertex_group = CURVATURE_GROUP
        dec.invert_vertex_group = True   # colapsa primero lo plano
        dec.vertex_group_factor = 0.85
    dec.use_collapse_triangulate = False

    try:
        bpy.ops.object.modifier_apply(modifier=dec.name)
    except RuntimeError as exc:
        lod.modifiers.remove(dec)
        report.append(f"{name}: el Decimate falló ({exc}). Queda sin reducir.")
        return lod, report

    final = _tri_count(lod)
    report.append(
        f"{name}: {current:,} → {final:,} triángulos (objetivo {target_tris:,}). "
        "Lo que se colapsó primero fue superficie plana, no silueta."
    )
    if final > target_tris * 1.25:
        report.append(
            f"{name} quedó un {(final / target_tris - 1) * 100:.0f}% por encima del "
            "presupuesto: el Decimate no puede bajar más sin romper la forma. "
            "Bajar más exigiría retopología manual."
        )

    if preserve_sharp:
        planar = lod.modifiers.new(f"ULTRA_{name}_Planar", "DECIMATE")
        planar.decimate_type = "DISSOLVE"
        planar.angle_limit = 0.0873  # 5°: disuelve lo coplanar y nada más
        try:
            bpy.ops.object.modifier_apply(modifier=planar.name)
            after = _tri_count(lod)
            if after < final:
                report.append(
                    f"{name}: {final - after:,} triángulos coplanares disueltos, "
                    "sin tocar ninguna arista viva."
                )
        except RuntimeError:
            if planar.name in lod.modifiers:
                lod.modifiers.remove(planar)

    shade_smooth_by_angle(lod, smooth_angle)
    return lod, report


def build_all_lods(
    master: bpy.types.Object,
    plan,
    preset,
    collection: bpy.types.Collection,
) -> tuple[dict[str, bpy.types.Object], list[str]]:
    """Genera LOD0..LOD3 y verifica que cada uno sea más liviano que el anterior."""
    report: list[str] = []
    lods: dict[str, bpy.types.Object] = {}

    for name in LOD_ORDER:
        target = plan.lod_targets.get(name)
        if not target:
            continue
        lod, notes = build_lod(
            master, name, target, collection,
            preserve_sharp=preset.preserve_sharp_edges,
            smooth_angle=preset.smooth_angle_deg,
        )
        report.extend(notes)
        if lod is not None:
            lods[name] = lod

    # Verificación: un LOD que no baja del anterior no sirve para nada.
    previous_name = None
    for name in LOD_ORDER:
        if name not in lods:
            continue
        if previous_name:
            a, b = _tri_count(lods[previous_name]), _tri_count(lods[name])
            if b >= a:
                report.append(
                    f"{name} ({b:,} tris) no es más liviano que {previous_name} ({a:,}). "
                    "Con este modelo no tiene sentido usar los dos niveles."
                )
        previous_name = name

    for name, lod in lods.items():
        lod["ultra3d_switch_hint"] = LOD_SWITCH_HINT.get(name, "")
    return lods, report


def apply_baked_material(lods: dict[str, bpy.types.Object], images: dict) -> list[str]:
    """Pone el material horneado en todos los niveles.

    Compartirlo entre los cuatro no es solo prolijidad: es un único draw
    call para todo el objeto, sin importar qué nivel esté activo.
    """
    from .baking import wire_baked_material

    if not images:
        return ["Sin mapas horneados: los LODs conservan sus materiales originales."]
    notes: list[str] = []
    material = None
    for name in LOD_ORDER:
        lod = lods.get(name)
        if lod is None:
            continue
        if material is None:
            notes.append(wire_baked_material(lod, images))
            material = lod.data.materials[0] if lod.data.materials else None
        elif material is not None:
            lod.data.materials.clear()
            lod.data.materials.append(material)
    if material is not None:
        notes.append(f"Los {len(lods)} niveles comparten el material horneado: un solo draw call.")
    return notes
