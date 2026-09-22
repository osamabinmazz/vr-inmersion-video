"""Presets de reconstrucción por tipo de modelo. SIN dependencia de bpy.

Un preset NO es un atajo estético: es el conjunto de permisos y límites que
evitan destruir el modelo. Los dos campos que más importan son negativos:

  - `preserve_open_boundaries`: en follaje, las tarjetas de hojas son planos
    abiertos. Cerrarlos o remeshearlos con voxel convierte un ombú en una
    mancha sólida. Por eso en TREE/PLANT el voxel remesh está PROHIBIDO.
  - `allow_voxel_remesh`: recupera mallas rotas, pero borra UVs, vertex
    groups y aristas duras. Se habilita solo donde el costo es asumible.

Cada preset declara además cuánta desviación respecto al original se
tolera, que es lo que convierte "quedó lindo" en un criterio medible.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any

from .classify import ModelKind

# Mapas que el horneado puede producir. NORMAL es el que más calidad
# percibida da por byte; CURVATURE y CAVITY alimentan el sombreado y los
# materiales procedurales.
BAKE_NORMAL = "NORMAL"
BAKE_AO = "AO"
BAKE_HEIGHT = "HEIGHT"
BAKE_CURVATURE = "CURVATURE"
BAKE_CAVITY = "CAVITY"
BAKE_COLOR = "COLOR"

ALL_BAKES = (BAKE_NORMAL, BAKE_AO, BAKE_HEIGHT, BAKE_CURVATURE, BAKE_CAVITY, BAKE_COLOR)


@dataclass
class ReconstructionPreset:
    """Reglas de tratamiento para una familia de modelos."""

    key: str
    label_es: str
    description: str

    # --- permisos (lo que NO se puede hacer importa más que lo que sí) ---
    allow_voxel_remesh: bool = True
    allow_quad_retopo: bool = True
    allow_subdivision: bool = True
    preserve_open_boundaries: bool = False
    preserve_sharp_edges: bool = False
    preserve_vertex_groups: bool = False
    symmetrize: bool = False

    # --- intensidad ------------------------------------------------------
    max_subdiv_levels: int = 3
    master_target_tris: int = 1_500_000
    sculpt_detail_strength: float = 0.0   # 0 = no esculpir microrelieve
    smooth_angle_deg: float = 30.0
    use_shrinkwrap: bool = True

    # --- tolerancias medibles (fracción de la diagonal del bounding box) -
    deviation_tolerance: float = 0.004
    silhouette_tolerance: float = 0.02    # fracción de píxeles de contorno
    volume_tolerance: float = 0.05

    # --- salida ----------------------------------------------------------
    bake_maps: tuple[str, ...] = (BAKE_NORMAL, BAKE_AO, BAKE_CURVATURE)
    bake_resolution: int = 4096
    lod_budgets: dict[str, int] = field(
        default_factory=lambda: {"LOD0": 200_000, "LOD1": 60_000, "LOD2": 20_000, "LOD3": 6_000}
    )

    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _lods(a: int, b: int, c: int, d: int) -> dict[str, int]:
    return {"LOD0": a, "LOD1": b, "LOD2": c, "LOD3": d}


PRESETS: dict[str, ReconstructionPreset] = {
    "ANIMAL": ReconstructionPreset(
        key="ANIMAL",
        label_es="Animal",
        description=(
            "Volumen y silueta orgánica por encima de todo. Conserva los vertex "
            "groups para no romper el skinning y no fuerza aristas duras."
        ),
        allow_voxel_remesh=True,
        preserve_sharp_edges=False,
        preserve_vertex_groups=True,
        symmetrize=False,
        max_subdiv_levels=3,
        master_target_tris=2_000_000,
        sculpt_detail_strength=0.35,
        smooth_angle_deg=45.0,
        deviation_tolerance=0.003,
        volume_tolerance=0.04,
        bake_maps=(BAKE_NORMAL, BAKE_AO, BAKE_CURVATURE, BAKE_CAVITY),
        lod_budgets=_lods(120_000, 45_000, 15_000, 5_000),
        notes=[
            "Si el modelo viene riggeado, el remesh descarta los pesos: se "
            "transfieren desde el original con Data Transfer, no se re-pintan.",
        ],
    ),
    "TREE": ReconstructionPreset(
        key="TREE",
        label_es="Árbol",
        description=(
            "Tronco sólido + follaje laminar. El voxel remesh está prohibido: "
            "fusionaría las tarjetas de hojas en una masa."
        ),
        allow_voxel_remesh=False,
        allow_quad_retopo=False,
        preserve_open_boundaries=True,
        preserve_sharp_edges=False,
        max_subdiv_levels=2,
        master_target_tris=900_000,
        sculpt_detail_strength=0.15,
        smooth_angle_deg=60.0,
        use_shrinkwrap=False,
        deviation_tolerance=0.006,
        silhouette_tolerance=0.05,
        volume_tolerance=0.30,
        bake_maps=(BAKE_NORMAL, BAKE_COLOR),
        bake_resolution=2048,
        lod_budgets=_lods(90_000, 30_000, 10_000, 2_500),
        notes=[
            "El volumen no es un criterio útil en follaje: la tolerancia va alta "
            "a propósito.",
            "Las hojas dependen del canal alfa; los LODs bajos deben reducir "
            "geometría de tronco antes que cantidad de tarjetas.",
        ],
    ),
    "PLANT": ReconstructionPreset(
        key="PLANT",
        label_es="Planta / arbusto",
        description="Como ÁRBOL pero a escala menor y con presupuestos más ajustados.",
        allow_voxel_remesh=False,
        allow_quad_retopo=False,
        preserve_open_boundaries=True,
        max_subdiv_levels=2,
        master_target_tris=400_000,
        sculpt_detail_strength=0.1,
        smooth_angle_deg=60.0,
        use_shrinkwrap=False,
        deviation_tolerance=0.008,
        silhouette_tolerance=0.06,
        volume_tolerance=0.40,
        bake_maps=(BAKE_NORMAL, BAKE_COLOR),
        bake_resolution=2048,
        lod_budgets=_lods(40_000, 12_000, 4_000, 1_200),
        notes=["En pastos y matas, la silueta es el 90% de la lectura a distancia."],
    ),
    "STATUE": ReconstructionPreset(
        key="STATUE",
        label_es="Estatua / escultura",
        description=(
            "El caso que más gana con reconstrucción: sólido cerrado, sin rig, "
            "que admite subdivisión agresiva y microrelieve de piedra."
        ),
        allow_voxel_remesh=True,
        preserve_sharp_edges=True,
        max_subdiv_levels=4,
        master_target_tris=4_000_000,
        sculpt_detail_strength=0.6,
        smooth_angle_deg=35.0,
        deviation_tolerance=0.002,
        silhouette_tolerance=0.012,
        volume_tolerance=0.03,
        bake_maps=(BAKE_NORMAL, BAKE_AO, BAKE_HEIGHT, BAKE_CURVATURE, BAKE_CAVITY),
        bake_resolution=4096,
        lod_budgets=_lods(200_000, 70_000, 22_000, 7_000),
    ),
    "PHOTOGRAMMETRY": ReconstructionPreset(
        key="PHOTOGRAMMETRY",
        label_es="Escaneo de fotogrametría",
        description=(
            "Superficie excelente sobre topología desastrosa. NO se subdivide: "
            "se retopologiza y se hornea el detalle que el escaneo ya tiene."
        ),
        allow_voxel_remesh=True,
        allow_quad_retopo=True,
        allow_subdivision=False,
        preserve_sharp_edges=False,
        max_subdiv_levels=0,
        master_target_tris=0,           # el master es el escaneo original
        sculpt_detail_strength=0.0,
        smooth_angle_deg=40.0,
        deviation_tolerance=0.0015,
        silhouette_tolerance=0.01,
        volume_tolerance=0.03,
        bake_maps=(BAKE_NORMAL, BAKE_AO, BAKE_HEIGHT, BAKE_CURVATURE, BAKE_COLOR),
        bake_resolution=4096,
        lod_budgets=_lods(150_000, 50_000, 18_000, 5_000),
        notes=[
            "Subdividir un escaneo agrega peso sin una sola unidad de información "
            "nueva: el detalle ya está en los vértices.",
            "El escaneo crudo pasa a ser la referencia de horneado, no el entregable.",
        ],
    ),
    "OBJECT": ReconstructionPreset(
        key="OBJECT",
        label_es="Objeto rígido",
        description="Props y objetos duros: se protegen las aristas y los ángulos rectos.",
        allow_voxel_remesh=True,
        preserve_sharp_edges=True,
        max_subdiv_levels=2,
        master_target_tris=1_200_000,
        sculpt_detail_strength=0.25,
        smooth_angle_deg=25.0,
        deviation_tolerance=0.002,
        silhouette_tolerance=0.012,
        volume_tolerance=0.03,
        bake_maps=(BAKE_NORMAL, BAKE_AO, BAKE_CURVATURE),
        lod_budgets=_lods(80_000, 25_000, 8_000, 2_500),
        notes=[
            "Sin Bevel o marcado de aristas, la subdivisión redondea esquinas que "
            "deberían quedar vivas.",
        ],
    ),
    "VR": ReconstructionPreset(
        key="VR",
        label_es="VR / tiempo real",
        description=(
            "Prioriza que entre en un visor autónomo: presupuestos bajos, un solo "
            "material, normal map obligatorio."
        ),
        allow_voxel_remesh=True,
        allow_quad_retopo=True,
        preserve_open_boundaries=True,
        max_subdiv_levels=2,
        master_target_tris=600_000,
        sculpt_detail_strength=0.2,
        smooth_angle_deg=40.0,
        deviation_tolerance=0.006,
        silhouette_tolerance=0.03,
        volume_tolerance=0.08,
        bake_maps=(BAKE_NORMAL, BAKE_AO, BAKE_COLOR),
        bake_resolution=2048,
        lod_budgets=_lods(45_000, 18_000, 6_000, 1_800),
        notes=[
            "En VR el costo se paga dos veces: se renderiza un ojo por cada frame.",
            "Un draw call de más pesa más que 10k triángulos de más.",
        ],
    ),
    "CINEMATIC_ULTRA": ReconstructionPreset(
        key="CINEMATIC_ULTRA",
        label_es="Cinematográfico ULTRA",
        description=(
            "Sin techo de polígonos: para render offline y primeros planos. "
            "Requiere hardware; el pipeline avisa antes de arrancar."
        ),
        allow_voxel_remesh=True,
        allow_quad_retopo=True,
        preserve_sharp_edges=True,
        max_subdiv_levels=5,
        master_target_tris=12_000_000,
        sculpt_detail_strength=0.8,
        smooth_angle_deg=30.0,
        deviation_tolerance=0.001,
        silhouette_tolerance=0.006,
        volume_tolerance=0.02,
        bake_maps=ALL_BAKES,
        bake_resolution=8192,
        lod_budgets=_lods(600_000, 200_000, 60_000, 20_000),
        notes=[
            "12M de triángulos con Multires piden ~16 GB de RAM: el chequeo de "
            "hardware puede bajar el objetivo y lo deja dicho en el informe.",
        ],
    ),
}


# Qué preset corresponde a cada categoría detectada.
KIND_TO_PRESET: dict[ModelKind, str] = {
    ModelKind.ANIMAL: "ANIMAL",
    ModelKind.HUMAN: "ANIMAL",          # mismas reglas: orgánico y riggeable
    ModelKind.TREE: "TREE",
    ModelKind.PLANT: "PLANT",
    ModelKind.STATUE: "STATUE",
    ModelKind.RIGID_OBJECT: "OBJECT",
    ModelKind.ARCHITECTURE: "OBJECT",   # aristas duras, sin rig
    ModelKind.PHOTOGRAMMETRY: "PHOTOGRAMMETRY",
    ModelKind.TERRAIN: "OBJECT",
    ModelKind.UNKNOWN: "OBJECT",
}


def get_preset(key: str) -> ReconstructionPreset:
    """Devuelve el preset por clave, con el conservador como red de seguridad."""
    return PRESETS.get(key.upper(), PRESETS["OBJECT"])


def preset_for_kind(kind: ModelKind) -> ReconstructionPreset:
    return get_preset(KIND_TO_PRESET.get(kind, "OBJECT"))


def preset_for_classification(classification, override: str = "AUTO") -> ReconstructionPreset:
    """Elige el preset, respetando un override manual si lo hay.

    Con clasificación dudosa (confianza < 0.45) se usa OBJECT, que es el
    tratamiento que menos supone: no fuerza remesh de follaje ni subdivide
    un escaneo.
    """
    if override and override.upper() not in ("AUTO", ""):
        return get_preset(override)
    if classification.confidence < 0.45:
        p = get_preset("OBJECT")
        return p
    return preset_for_kind(classification.kind)
