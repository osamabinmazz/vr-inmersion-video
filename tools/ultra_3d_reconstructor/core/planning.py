"""Plan de reconstrucción: qué se hace, en qué orden y hasta dónde.
SIN dependencia de bpy.

Lo que este módulo evita es exactamente lo que el brief prohíbe: apretar
"Subdivision Surface → Apply" y llamarlo reconstrucción. Dos decisiones
concretas lo impiden:

  - **Subdivisión adaptativa por curvatura**: los polígonos van donde hay
    forma. Una esfera lisa no gana nada con 4 niveles uniformes; una mano
    sí, pero solo en los nudillos. `adaptive_subdivision_plan` calcula
    cuánto se ahorra y cuánto detalle se conserva, y lo deja escrito.
  - **Presupuesto por hardware**: 12M de triángulos en una máquina de 8 GB
    no es "calidad extrema", es un cuelgue. El plan baja el objetivo y lo
    informa en vez de fallar a mitad de camino.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Any, Sequence

from .classify import Classification, ModelKind
from .presets import ReconstructionPreset


class Stage(str, Enum):
    """Las 26 etapas del pipeline, en orden de ejecución."""

    INSPECT = "01_inspeccion"
    CLASSIFY = "02_clasificacion"
    SCORE_BEFORE = "03_puntaje_inicial"
    BACKUP = "04_respaldo_source"
    CLEANUP = "05_limpieza"
    NORMALS = "06_normales"
    TRANSFORM = "07_transformaciones"
    HOLES = "08_agujeros"
    UV_AUDIT = "09_auditoria_uv"
    UV_BUILD = "10_generacion_uv"
    STRATEGY = "11_estrategia"
    RECONSTRUCT = "12_reconstruccion_base"
    SUPER_RESOLUTION = "13_super_resolucion"
    SHRINKWRAP = "14_reproyeccion"
    SCULPT_DETAIL = "15_microrelieve"
    MASTER_ULTRA = "16_master_ultra"
    DEVIATION_CHECK = "17_control_desviacion"
    RETOPOLOGY = "18_retopologia"
    UV_MASTER = "19_uv_definitivas"
    BAKE = "20_horneado"
    LOD_BUILD = "21_lods"
    SILHOUETTE_CHECK = "22_control_silueta"
    SCORE_AFTER = "23_puntaje_final"
    COMPARATOR = "24_escena_comparadora"
    EXPORT = "25_exportacion"
    REPORT = "26_informe"


STAGE_ORDER: tuple[Stage, ...] = tuple(Stage)

# Etapas después de las cuales conviene guardar: son las caras de rehacer.
CHECKPOINT_STAGES: frozenset[Stage] = frozenset(
    {
        Stage.BACKUP,
        Stage.CLEANUP,
        Stage.MASTER_ULTRA,
        Stage.RETOPOLOGY,
        Stage.BAKE,
        Stage.LOD_BUILD,
        Stage.EXPORT,
    }
)

# Memoria por triángulo evaluado en Blender: vértices, aristas, loops, bucle
# de modificadores y la copia del depsgraph. Medido grueso y con margen,
# porque subestimarlo es lo que cuelga la máquina.
BYTES_PER_TRI_EVAL = 420
MEMORY_SAFETY_FACTOR = 2.5
MIN_FREE_RAM_GB = 1.5


class ReconstructionMethod(str, Enum):
    """Cómo se construye el MASTER_ULTRA."""

    ADAPTIVE_SUBDIVISION = "adaptive_subdivision"  # topología sana: subdivisión por curvatura
    MULTIRES_SCULPT = "multires_sculpt"            # sana + UVs: Multires, permite esculpir y bakear
    REMESH_REPROJECT = "remesh_reproject"          # rota: superficie nueva + reproyección
    QUAD_RETOPO_FIRST = "quad_retopo_first"        # escaneo: primero retopo, después detalle
    DETAIL_ONLY = "detail_only"                    # ya denso: solo mapas, nada de geometría
    FOLIAGE_SAFE = "foliage_safe"                  # follaje: se respetan las láminas abiertas


@dataclass
class HardwareProfile:
    """Lo que la máquina puede aguantar."""

    ram_gb: float = 8.0
    cpu_cores: int = 4
    gpu_vram_gb: float = 0.0
    has_gpu: bool = False

    def usable_ram_gb(self) -> float:
        return max(0.5, self.ram_gb - MIN_FREE_RAM_GB)


def estimate_peak_memory_gb(tris: int) -> float:
    """Pico de memoria estimado para evaluar una malla de N triángulos."""
    if tris <= 0:
        return 0.0
    return (tris * BYTES_PER_TRI_EVAL * MEMORY_SAFETY_FACTOR) / (1024 ** 3)


def safe_target_tris(hardware: HardwareProfile, desired: int) -> tuple[int, str | None]:
    """Recorta el objetivo si no entra en RAM. Devuelve (objetivo, aviso)."""
    if desired <= 0:
        return 0, None
    budget = hardware.usable_ram_gb()
    if estimate_peak_memory_gb(desired) <= budget:
        return desired, None

    capacity = int(budget * (1024 ** 3) / (BYTES_PER_TRI_EVAL * MEMORY_SAFETY_FACTOR))
    capacity = max(50_000, capacity)
    aviso = (
        f"El objetivo de {desired:,} triángulos necesita ~"
        f"{estimate_peak_memory_gb(desired):.1f} GB y hay {budget:.1f} GB utilizables. "
        f"Se baja a {capacity:,}. No es una limitación del add-on sino de la máquina: "
        "con más RAM el mismo preset llega al objetivo completo."
    )
    return capacity, aviso


# ------------------------------------------------- subdivisión adaptativa


@dataclass
class SubdivisionBand:
    """Una franja de curvatura y cuánto se subdivide."""

    name: str
    fraction: float       # fracción de caras del modelo en esta franja
    levels: int
    reason: str = ""

    @property
    def multiplier(self) -> int:
        return 4 ** self.levels


@dataclass
class SubdivisionPlan:
    """Reparto de polígonos por curvatura, con la cuenta de lo que ahorra."""

    bands: list[SubdivisionBand] = field(default_factory=list)
    expected_tris: int = 0
    uniform_tris: int = 0
    max_levels: int = 0
    thresholds: list[float] = field(default_factory=list)
    adaptive: bool = True
    notes: list[str] = field(default_factory=list)

    @property
    def savings_ratio(self) -> float:
        """Cuánto más liviano que subdividir uniforme al mismo nivel máximo."""
        if self.uniform_tris <= 0:
            return 0.0
        return max(0.0, 1.0 - self.expected_tris / self.uniform_tris)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["savings_ratio"] = round(self.savings_ratio, 4)
        return d


def curvature_thresholds(curvatures: Sequence[float], bands: int = 3) -> list[float]:
    """Cortes por cuantiles, no por valores absolutos.

    Un umbral fijo de curvatura no sirve porque la escala depende del
    modelo: lo que en una estatua es 'plano' en un tornillo es una curva
    pronunciada. Los cuantiles se adaptan solos a la distribución real.
    """
    if not curvatures or bands < 2:
        return []
    ordered = sorted(curvatures)
    n = len(ordered)
    cuts: list[float] = []
    for i in range(1, bands):
        idx = min(n - 1, int(n * i / bands))
        cuts.append(ordered[idx])
    return cuts


def adaptive_subdivision_plan(
    base_tris: int,
    target_tris: int,
    max_levels: int,
    curvature_fractions: Sequence[float] | None = None,
) -> SubdivisionPlan:
    """Reparte niveles de subdivisión según la curvatura.

    `curvature_fractions` es la fracción de caras en cada franja, de plana a
    muy curva. Sin ese dato se cae a un reparto uniforme —y se dice, porque
    no medir la curvatura es una limitación real, no un detalle.
    """
    plan = SubdivisionPlan(max_levels=max_levels)

    if base_tris <= 0 or max_levels <= 0:
        plan.adaptive = False
        plan.expected_tris = max(0, base_tris)
        plan.uniform_tris = max(0, base_tris)
        plan.notes.append("Sin subdivisión: el modelo ya cumple el objetivo o no es subdividible.")
        return plan

    plan.uniform_tris = base_tris * (4 ** max_levels)

    if not curvature_fractions:
        plan.adaptive = False
        plan.bands = [
            SubdivisionBand(
                "uniforme", 1.0, max_levels,
                "No se pudo medir la curvatura: se subdivide parejo, que es lo "
                "peor repartido pero lo único honesto sin ese dato.",
            )
        ]
        plan.expected_tris = plan.uniform_tris
        plan.notes.append("Subdivisión uniforme (sin datos de curvatura).")
        return plan

    fracs = list(curvature_fractions)
    total = sum(fracs)
    if total <= 0:
        fracs = [1.0]
        total = 1.0
    fracs = [f / total for f in fracs]

    # Franjas de plana a muy curva: la plana casi no recibe polígonos nuevos
    # porque no hay forma que describir; la curva se lleva el máximo.
    n_bands = len(fracs)
    names = ["plana", "suave", "curva", "muy curva", "detalle fino"][:n_bands]
    if len(names) < n_bands:
        names += [f"banda_{i}" for i in range(len(names), n_bands)]

    expected = 0.0
    for i, frac in enumerate(fracs):
        # El nivel crece con la franja, sin pasar del máximo.
        level = int(round(max_levels * (i / max(1, n_bands - 1))))
        level = max(0, min(max_levels, level))
        if i == 0 and max_levels >= 2:
            level = min(level, 1)  # lo plano nunca se lleva el máximo
        reason = (
            f"{frac * 100:.0f}% de la malla; nivel {level} "
            + ("(superficie sin forma que refinar)" if level == 0 else
               "(donde está la silueta)" if level >= max_levels else
               "(transición)")
        )
        band = SubdivisionBand(names[i], round(frac, 4), level, reason)
        plan.bands.append(band)
        expected += base_tris * frac * band.multiplier

    plan.expected_tris = int(expected)

    # Si aun repartido se pasa del objetivo, se baja un nivel global.
    while plan.expected_tris > target_tris * 1.6 and plan.max_levels > 1:
        plan.max_levels -= 1
        plan.bands = [
            SubdivisionBand(b.name, b.fraction, max(0, min(plan.max_levels, b.levels - 1)), b.reason)
            for b in plan.bands
        ]
        plan.expected_tris = int(sum(base_tris * b.fraction * b.multiplier for b in plan.bands))
        plan.uniform_tris = base_tris * (4 ** plan.max_levels)
        plan.notes.append(
            f"Se bajó un nivel para no pasarse del objetivo: máximo {plan.max_levels}."
        )

    if plan.savings_ratio > 0.15:
        plan.notes.append(
            f"La subdivisión adaptativa usa {plan.expected_tris:,} triángulos donde la "
            f"uniforme usaría {plan.uniform_tris:,}: un {plan.savings_ratio * 100:.0f}% menos "
            "para el mismo detalle visible, porque los polígonos van a las zonas curvas."
        )
    return plan


# -------------------------------------------------------------- el plan


@dataclass
class ReconstructionPlan:
    """Decisión completa y auditable de qué se le hace al modelo."""

    method: ReconstructionMethod
    preset_key: str
    kind: ModelKind
    stages: list[str] = field(default_factory=list)
    skipped_stages: dict[str, str] = field(default_factory=dict)

    master_target_tris: int = 0
    subdivision: SubdivisionPlan | None = None
    voxel_size: float = 0.0
    retopo_target_faces: int = 0
    lod_targets: dict[str, int] = field(default_factory=dict)
    bake_maps: list[str] = field(default_factory=list)
    bake_resolution: int = 2048

    needs_cleanup: bool = False
    needs_normals_fix: bool = False
    needs_scale_apply: bool = False
    needs_uv_unwrap: bool = False
    use_shrinkwrap: bool = False
    sculpt_detail_strength: float = 0.0

    checkpoints: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    limitations: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["method"] = self.method.value
        d["kind"] = self.kind.value
        d["subdivision"] = self.subdivision.to_dict() if self.subdivision else None
        return d


def choose_method(stats, classification: Classification, preset: ReconstructionPreset) -> ReconstructionMethod:
    """Elige cómo reconstruir. El orden de los cortes NO es arbitrario.

    Primero se descartan los casos donde una técnica destruiría el modelo
    (follaje con voxel, escaneo con subdivisión), y recién después se elige
    entre las que quedan permitidas.
    """
    # 1. Follaje: las láminas abiertas mandan sobre cualquier otra señal.
    if preset.preserve_open_boundaries and (classification.is_foliage or stats.boundary_ratio > 0.15):
        return ReconstructionMethod.FOLIAGE_SAFE

    # 2. Escaneo: tiene el detalle; lo que le falta es topología.
    if classification.kind is ModelKind.PHOTOGRAMMETRY or classification.photogrammetry_likelihood >= 0.7:
        return ReconstructionMethod.QUAD_RETOPO_FIRST

    # 3. Ya denso: subdividir es peso sin información.
    if stats.density > 3_000 and stats.tris > 400_000:
        return ReconstructionMethod.DETAIL_ONLY

    # 4. Topología irrecuperable: hay que generar superficie nueva.
    broken = stats.non_manifold_ratio > 0.05 or stats.ngon_ratio > 0.30 or stats.faces == 0
    if broken:
        if preset.allow_voxel_remesh:
            return ReconstructionMethod.REMESH_REPROJECT
        return ReconstructionMethod.FOLIAGE_SAFE

    if not preset.allow_subdivision:
        return ReconstructionMethod.DETAIL_ONLY

    # 5. Sana + quads + UVs: Multires, que además habilita esculpir y hornear.
    if stats.quad_ratio >= 0.5 and stats.has_uvs and stats.non_manifold_edges == 0:
        return ReconstructionMethod.MULTIRES_SCULPT

    return ReconstructionMethod.ADAPTIVE_SUBDIVISION


def voxel_size_for(stats, target_tris: int) -> float:
    """Tamaño de voxel derivado del área real, no un número fijo.

    El mismo voxel que detalla un tero convierte un ombú en una mancha.
    """
    if target_tris <= 0:
        target_tris = 200_000
    if stats.surface_area <= 1e-9:
        return max(stats.max_dimension / 128.0, 1e-4) if stats.max_dimension else 0.01
    size = math.sqrt(2.0 * stats.surface_area / target_tris)
    if stats.max_dimension > 0:
        size = max(size, stats.max_dimension / 1024.0)
        size = min(size, stats.max_dimension / 16.0)
    return size


def build_reconstruction_plan(
    stats,
    classification: Classification,
    preset: ReconstructionPreset,
    hardware: HardwareProfile | None = None,
    curvature_fractions: Sequence[float] | None = None,
    extreme_quality: bool = False,
) -> ReconstructionPlan:
    """Arma el plan completo. Es el cerebro del add-on."""
    hardware = hardware or HardwareProfile()
    method = choose_method(stats, classification, preset)

    plan = ReconstructionPlan(
        method=method,
        preset_key=preset.key,
        kind=classification.kind,
        bake_maps=list(preset.bake_maps),
        bake_resolution=preset.bake_resolution,
        lod_targets=dict(preset.lod_budgets),
        sculpt_detail_strength=preset.sculpt_detail_strength,
    )

    # --- reparaciones previas -------------------------------------------
    plan.needs_cleanup = (
        stats.duplicate_verts > 0
        or stats.loose_verts > 0
        or stats.loose_edges > 0
        or stats.interior_faces > 0
        or stats.degenerate_faces > 0
    )
    plan.needs_normals_fix = stats.flipped_normals > 0
    plan.needs_scale_apply = stats.is_scaled
    plan.needs_uv_unwrap = not stats.has_uvs or stats.uv_overlap_ratio > 0.15

    # --- objetivo del master --------------------------------------------
    desired = preset.master_target_tris
    if extreme_quality:
        desired = int(desired * 2.5)
    if desired > 0:
        target, aviso = safe_target_tris(hardware, desired)
        plan.master_target_tris = target
        if aviso:
            plan.warnings.append(aviso)
    else:
        plan.master_target_tris = stats.tris

    # --- geometría según el método ---------------------------------------
    max_levels = preset.max_subdiv_levels + (1 if extreme_quality else 0)

    if method in (ReconstructionMethod.ADAPTIVE_SUBDIVISION, ReconstructionMethod.MULTIRES_SCULPT):
        plan.subdivision = adaptive_subdivision_plan(
            stats.tris, plan.master_target_tris, max_levels, curvature_fractions
        )
        plan.use_shrinkwrap = False
        plan.notes.extend(plan.subdivision.notes)
        if plan.subdivision.expected_tris <= stats.tris:
            plan.method = ReconstructionMethod.DETAIL_ONLY
            plan.notes.append(
                "El modelo ya alcanza el objetivo: subdividir agregaría peso sin "
                "detalle. Se pasa a reconstruir detalle desde mapas."
            )

    elif method is ReconstructionMethod.REMESH_REPROJECT:
        plan.voxel_size = voxel_size_for(stats, plan.master_target_tris)
        plan.use_shrinkwrap = preset.use_shrinkwrap
        plan.notes.append(
            "Topología no apta para subdividir: se genera superficie nueva por voxel "
            "remesh y se recupera la silueta reproyectando contra el original."
        )
        if stats.has_armature or stats.vertex_groups:
            plan.warnings.append(
                "El remesh descarta vertex groups: se transfieren desde el original "
                "con Data Transfer. Revisar los pesos antes de animar."
            )

    elif method is ReconstructionMethod.QUAD_RETOPO_FIRST:
        plan.retopo_target_faces = max(5_000, min(200_000, int(stats.tris * 0.08)))
        plan.use_shrinkwrap = True
        plan.subdivision = adaptive_subdivision_plan(0, 0, 0, None)
        plan.notes.append(
            "Escaneo: el detalle ya está en la malla. Se retopologiza a quads y se "
            "hornea el original como referencia; no se subdivide."
        )
        plan.skipped_stages[Stage.SUPER_RESOLUTION.value] = (
            "Un escaneo no necesita super-resolución: tiene más vértices que información."
        )

    elif method is ReconstructionMethod.FOLIAGE_SAFE:
        plan.use_shrinkwrap = False
        plan.subdivision = adaptive_subdivision_plan(
            stats.tris, plan.master_target_tris, min(2, max_levels), curvature_fractions
        )
        plan.notes.append(
            "Follaje: el voxel remesh y el cierre de agujeros quedan DESACTIVADOS. "
            "Fusionarían las tarjetas de hojas en una masa sólida."
        )
        plan.skipped_stages[Stage.HOLES.value] = (
            "Los bordes abiertos son las tarjetas de hojas, no defectos."
        )
        plan.skipped_stages[Stage.RETOPOLOGY.value] = (
            "QuadriFlow no maneja superficies laminares sueltas: destruiría el follaje."
        )

    else:  # DETAIL_ONLY
        plan.notes.append(
            "No se toca la geometría: el modelo ya tiene la densidad necesaria. "
            "La mejora viene de mapas (normal, AO, curvatura) y de la limpieza."
        )
        plan.skipped_stages[Stage.SUPER_RESOLUTION.value] = "El modelo ya es denso."

    # --- LODs coherentes ---------------------------------------------------
    names = sorted(plan.lod_targets, key=lambda k: -plan.lod_targets[k])
    for i in range(1, len(names)):
        prev, cur = names[i - 1], names[i]
        if plan.lod_targets[cur] >= plan.lod_targets[prev]:
            plan.lod_targets[cur] = max(300, int(plan.lod_targets[prev] * 0.35))

    # --- etapas efectivas --------------------------------------------------
    for stage in STAGE_ORDER:
        if stage.value in plan.skipped_stages:
            continue
        if stage is Stage.UV_BUILD and not plan.needs_uv_unwrap:
            plan.skipped_stages[stage.value] = "El modelo ya trae UVs utilizables."
            continue
        if stage is Stage.SHRINKWRAP and not plan.use_shrinkwrap:
            plan.skipped_stages[stage.value] = "No hace falta reproyectar con este método."
            continue
        if stage is Stage.SCULPT_DETAIL and plan.sculpt_detail_strength <= 0.0:
            plan.skipped_stages[stage.value] = (
                "El preset no aplica microrelieve (inventaría detalle que el original no tiene)."
            )
            continue
        if stage is Stage.TRANSFORM and not plan.needs_scale_apply:
            plan.skipped_stages[stage.value] = "Escala y rotación ya aplicadas."
            continue
        plan.stages.append(stage.value)

    plan.checkpoints = [s for s in plan.stages if s in {c.value for c in CHECKPOINT_STAGES}]

    # --- límites técnicos reales, dichos sin disimulo ----------------------
    plan.limitations.append(
        "Blender no expone una distancia de Hausdorff: se aproxima por muestreo con "
        "BVHTree en ambos sentidos. Con menos de 2000 muestras el resultado es "
        "orientativo y el informe lo marca."
    )
    if plan.method is ReconstructionMethod.MULTIRES_SCULPT:
        plan.limitations.append(
            "Multires exige topología all-quad sin non-manifold. Si al aplicarlo falla, "
            "se cae a subdivisión adaptativa y queda registrado."
        )
    if stats.shape_keys:
        plan.warnings.append(
            f"{stats.shape_keys} shape keys: Blender no permite aplicar la mayoría de "
            "modificadores sin destruirlas. El original queda intacto en 00_SOURCE y "
            "las versiones nuevas se generan sin ellas."
        )
    if stats.has_armature:
        plan.warnings.append(
            "Objeto riggeado: no se aplica nada destructivo sobre el original."
        )
    if not stats.has_uvs and plan.bake_maps:
        plan.notes.append(
            "Sin UVs no se puede hornear: se generan con Smart UV Project antes del bake."
        )

    plan.warnings.extend(preset.notes)
    return plan
