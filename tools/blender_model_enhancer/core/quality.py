"""Control de calidad: cuantifica cuánto se alejó un resultado del original.

Sin dependencia de bpy: recibe las distancias ya muestreadas por la capa de
Blender (que usa BVHTree) y decide si el resultado es aceptable o hay que
bajar la intensidad del procesamiento y reintentar.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Any, Sequence


class Verdict(str, Enum):
    PASS = "pass"              # fiel al original
    ACCEPTABLE = "acceptable"  # desvío visible pero tolerable
    DEGRADED = "degraded"      # perdió forma: reintentar más suave
    FAILED = "failed"          # irreconocible


# Umbrales como fracción de la diagonal del bounding box, no en metros: así
# el criterio vale igual para un tero de 30cm que para un ombú de 12m.
DEVIATION_THRESHOLDS = {
    Verdict.PASS: 0.004,        # 0.4% de la diagonal
    Verdict.ACCEPTABLE: 0.012,  # 1.2%
    Verdict.DEGRADED: 0.035,    # 3.5%
}

# Cuánta pérdida de volumen se tolera. Un remesh mal calibrado "adelgaza" o
# "infla" el modelo aunque la distancia media parezca baja.
VOLUME_TOLERANCE = {
    Verdict.PASS: 0.03,
    Verdict.ACCEPTABLE: 0.08,
    Verdict.DEGRADED: 0.20,
}


@dataclass
class QualityReport:
    """Resultado de comparar una versión procesada contra el original."""

    level: str = ""
    verdict: Verdict = Verdict.PASS
    mean_deviation: float = 0.0       # relativa a la diagonal
    max_deviation: float = 0.0
    p95_deviation: float = 0.0
    volume_change: float = 0.0        # fracción con signo: negativo = perdió volumen
    tris: int = 0
    flipped_normals: int = 0
    non_manifold_edges: int = 0
    lost_uvs: bool = False
    lost_materials: bool = False
    issues: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["verdict"] = self.verdict.value
        return d

    @property
    def needs_retry(self) -> bool:
        """Si conviene rehacer el nivel con menos intensidad."""
        return self.verdict in (Verdict.DEGRADED, Verdict.FAILED)


def percentile(values: Sequence[float], pct: float) -> float:
    """Percentil por interpolación lineal. Evita traer numpy, que no está
    garantizado en el Python que embebe Blender."""
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    pos = (len(ordered) - 1) * max(0.0, min(1.0, pct))
    low = int(pos)
    high = min(low + 1, len(ordered) - 1)
    frac = pos - low
    return ordered[low] * (1.0 - frac) + ordered[high] * frac


def classify_deviation(mean_dev: float, p95_dev: float, volume_change: float) -> Verdict:
    """Combina desvío de superficie y cambio de volumen en un veredicto.

    Se usa el percentil 95 en vez del máximo porque un solo vértice suelto
    disparado no debería condenar un resultado que en general es fiel.
    """
    abs_vol = abs(volume_change)

    if mean_dev <= DEVIATION_THRESHOLDS[Verdict.PASS] and abs_vol <= VOLUME_TOLERANCE[Verdict.PASS]:
        return Verdict.PASS
    if (
        mean_dev <= DEVIATION_THRESHOLDS[Verdict.ACCEPTABLE]
        and p95_dev <= DEVIATION_THRESHOLDS[Verdict.DEGRADED]
        and abs_vol <= VOLUME_TOLERANCE[Verdict.ACCEPTABLE]
    ):
        return Verdict.ACCEPTABLE
    if mean_dev <= DEVIATION_THRESHOLDS[Verdict.DEGRADED] and abs_vol <= VOLUME_TOLERANCE[Verdict.DEGRADED]:
        return Verdict.DEGRADED
    return Verdict.FAILED


def build_quality_report(
    level: str,
    deviations: Sequence[float],
    diagonal: float,
    volume_original: float,
    volume_result: float,
    tris: int,
    flipped_normals: int = 0,
    non_manifold_edges: int = 0,
    lost_uvs: bool = False,
    lost_materials: bool = False,
) -> QualityReport:
    """Arma el informe a partir de distancias medidas en unidades de escena."""
    report = QualityReport(level=level, tris=tris)
    report.flipped_normals = flipped_normals
    report.non_manifold_edges = non_manifold_edges
    report.lost_uvs = lost_uvs
    report.lost_materials = lost_materials

    if diagonal <= 1e-9:
        report.verdict = Verdict.FAILED
        report.issues.append("Bounding box degenerado: no se puede medir desviación.")
        return report

    rel = [d / diagonal for d in deviations]
    report.mean_deviation = (sum(rel) / len(rel)) if rel else 0.0
    report.max_deviation = max(rel) if rel else 0.0
    report.p95_deviation = percentile(rel, 0.95)

    if volume_original > 1e-9:
        report.volume_change = (volume_result - volume_original) / volume_original

    report.verdict = classify_deviation(
        report.mean_deviation, report.p95_deviation, report.volume_change
    )

    if report.volume_change < -VOLUME_TOLERANCE[Verdict.ACCEPTABLE]:
        report.issues.append(
            f"Pérdida de volumen del {abs(report.volume_change) * 100:.1f}%: "
            "el modelo quedó adelgazado."
        )
    elif report.volume_change > VOLUME_TOLERANCE[Verdict.ACCEPTABLE]:
        report.issues.append(
            f"Ganancia de volumen del {report.volume_change * 100:.1f}%: "
            "el modelo quedó inflado (típico de suavizado excesivo)."
        )
    if report.p95_deviation > DEVIATION_THRESHOLDS[Verdict.DEGRADED]:
        report.issues.append("La silueta se aparta del original en zonas amplias.")
    if flipped_normals:
        report.issues.append(f"{flipped_normals} caras con la normal invertida.")
    if lost_uvs:
        report.issues.append("Se perdieron las UVs: no se puede bakear sobre este nivel.")
    if lost_materials:
        report.issues.append("Se perdieron los materiales del original.")

    return report


def relax_settings(current_strength: float, verdict: Verdict, floor: float = 0.1) -> float:
    """Baja la intensidad del procesamiento tras un resultado degradado.

    Se reduce más fuerte cuanto peor fue el resultado, con un piso para que
    el reintento no se vuelva un no-op.
    """
    if verdict is Verdict.FAILED:
        factor = 0.35
    elif verdict is Verdict.DEGRADED:
        factor = 0.6
    else:
        return current_strength
    return max(floor, current_strength * factor)
