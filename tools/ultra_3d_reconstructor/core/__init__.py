"""Núcleo de decisión del ULTRA 3D RECONSTRUCTOR.

Todo este paquete es Python puro: no importa bpy y por lo tanto se puede
testear fuera de Blender. Es donde viven las decisiones que, mal tomadas,
arruinan un modelo — y por eso son justamente las que hay que poder
verificar sin depender de abrir la aplicación.
"""

from .stats import MeshStats
from .scoring import ScoreCard, build_scorecard
from .classify import Classification, ModelKind, classify_model, photogrammetry_score
from .presets import (
    PRESETS,
    ReconstructionPreset,
    get_preset,
    preset_for_kind,
    preset_for_classification,
)
from .planning import (
    HardwareProfile,
    ReconstructionMethod,
    ReconstructionPlan,
    Stage,
    STAGE_ORDER,
    adaptive_subdivision_plan,
    build_reconstruction_plan,
    estimate_peak_memory_gb,
    safe_target_tris,
)
from .deviation import (
    DeviationVerdict,
    FidelityReport,
    HausdorffResult,
    SilhouetteResult,
    bidirectional_deviation,
    build_fidelity_report,
    classify_deviation,
    combine_silhouettes,
    silhouette_error,
    summarize_distances,
    volume_error,
)

__all__ = [
    "MeshStats",
    "ScoreCard",
    "build_scorecard",
    "Classification",
    "ModelKind",
    "classify_model",
    "photogrammetry_score",
    "PRESETS",
    "ReconstructionPreset",
    "get_preset",
    "preset_for_kind",
    "preset_for_classification",
    "HardwareProfile",
    "ReconstructionMethod",
    "ReconstructionPlan",
    "Stage",
    "STAGE_ORDER",
    "adaptive_subdivision_plan",
    "build_reconstruction_plan",
    "estimate_peak_memory_gb",
    "safe_target_tris",
    "DeviationVerdict",
    "FidelityReport",
    "HausdorffResult",
    "SilhouetteResult",
    "bidirectional_deviation",
    "build_fidelity_report",
    "classify_deviation",
    "combine_silhouettes",
    "silhouette_error",
    "summarize_distances",
    "volume_error",
]
