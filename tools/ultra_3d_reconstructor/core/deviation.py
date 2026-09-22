"""Medición de fidelidad al original. SIN dependencia de bpy.

Acá vive la respuesta a la única pregunta que importa después de
reconstruir: ¿el resultado SIGUE SIENDO el mismo objeto?

Se mide de tres formas independientes, porque cada una se puede engañar
sola:

  1. **Desviación bidireccional (tipo Hausdorff)**: distancia de cada punto
     de A a la superficie más cercana de B, y al revés. Hacerlo en un solo
     sentido oculta lo que se perdió: si B se comió una oreja, todos los
     puntos de B siguen cerca de A y la medición unidireccional da bien.
  2. **Silueta multi-vista**: se compara el contorno renderizado desde
     varios ángulos. Detecta lo que la distancia no ve: un detalle fino que
     se redondeó apenas, pero cambia el perfil.
  3. **Volumen**: barato y delata el colapso o el inflado global.

Blender no expone una métrica de Hausdorff: se aproxima por muestreo con
BVHTree (lo hace la capa bpy) y acá se convierte en estadística y veredicto.
El límite es real y está documentado: es un muestreo, no un cálculo exacto;
con suficientes muestras (>= 20k) el p99 converge bien.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Any, Sequence

# Umbrales como fracción de la diagonal del bounding box: así valen igual
# para un tero de 30 cm que para un ombú de 9 m.
DEVIATION_THRESHOLDS = {
    "excellent": 0.0015,
    "good": 0.004,
    "acceptable": 0.010,
    "drifted": 0.030,
}

MIN_RELIABLE_SAMPLES = 2_000


class DeviationVerdict(str, Enum):
    EXCELLENT = "excellent"      # indistinguible del original
    GOOD = "good"                # diferencias invisibles en uso normal
    ACCEPTABLE = "acceptable"    # se nota mirando de cerca
    DRIFTED = "drifted"          # perdió detalle: hay que ajustar y repetir
    BROKEN = "broken"            # ya no es el mismo objeto
    UNMEASURED = "unmeasured"    # no se pudo medir; se dice, no se finge


def percentile(values: Sequence[float], q: float) -> float:
    """Percentil por interpolación lineal. q en 0-1."""
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    pos = q * (len(ordered) - 1)
    lo = int(math.floor(pos))
    hi = min(lo + 1, len(ordered) - 1)
    frac = pos - lo
    return ordered[lo] * (1.0 - frac) + ordered[hi] * frac


@dataclass
class DeviationStats:
    """Estadística de distancias, ya normalizada por el tamaño del objeto."""

    samples: int = 0
    mean: float = 0.0
    rms: float = 0.0
    p95: float = 0.0
    p99: float = 0.0
    maximum: float = 0.0
    reliable: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def summarize_distances(distances: Sequence[float], bbox_diagonal: float) -> DeviationStats:
    """Convierte distancias crudas en estadística normalizada.

    Se normaliza por la diagonal del bounding box porque una desviación de
    2 mm es despreciable en una estatua de 3 m y brutal en un colibrí.
    """
    if not distances or bbox_diagonal <= 1e-9:
        return DeviationStats()

    scale = 1.0 / bbox_diagonal
    vals = [abs(d) * scale for d in distances]
    n = len(vals)
    mean = sum(vals) / n
    rms = math.sqrt(sum(v * v for v in vals) / n)

    return DeviationStats(
        samples=n,
        mean=mean,
        rms=rms,
        p95=percentile(vals, 0.95),
        p99=percentile(vals, 0.99),
        maximum=max(vals),
        reliable=n >= MIN_RELIABLE_SAMPLES,
    )


@dataclass
class HausdorffResult:
    """Desviación en los dos sentidos más la simétrica."""

    forward: DeviationStats = field(default_factory=DeviationStats)   # original → reconstruido
    backward: DeviationStats = field(default_factory=DeviationStats)  # reconstruido → original
    symmetric_max: float = 0.0
    symmetric_p99: float = 0.0
    symmetric_mean: float = 0.0
    lost_detail: bool = False       # el original tiene zonas sin contraparte
    added_geometry: bool = False    # el reconstruido inventó superficie

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["forward"] = self.forward.to_dict()
        d["backward"] = self.backward.to_dict()
        return d


def bidirectional_deviation(
    forward_distances: Sequence[float],
    backward_distances: Sequence[float],
    bbox_diagonal: float,
    asymmetry_factor: float = 1.8,
) -> HausdorffResult:
    """Combina ambos sentidos en una sola lectura.

    La asimetría es el dato valioso: si la ida (original → reconstruido)
    es mucho peor que la vuelta, significa que hay partes del original que
    no tienen contraparte — se perdió detalle. Al revés, el reconstruido
    generó superficie que no existía (típico del voxel remesh cerrando
    huecos que debían quedar abiertos).
    """
    fwd = summarize_distances(forward_distances, bbox_diagonal)
    bwd = summarize_distances(backward_distances, bbox_diagonal)

    result = HausdorffResult(
        forward=fwd,
        backward=bwd,
        symmetric_max=max(fwd.maximum, bwd.maximum),
        symmetric_p99=max(fwd.p99, bwd.p99),
        symmetric_mean=max(fwd.mean, bwd.mean),
    )

    eps = 1e-9
    if fwd.p99 > bwd.p99 * asymmetry_factor and fwd.p99 > DEVIATION_THRESHOLDS["good"]:
        result.lost_detail = True
    if bwd.p99 > fwd.p99 * asymmetry_factor and bwd.p99 > DEVIATION_THRESHOLDS["good"]:
        result.added_geometry = True
    _ = eps
    return result


def classify_deviation(value: float, tolerance: float | None = None) -> DeviationVerdict:
    """Traduce una desviación normalizada a veredicto.

    Si el preset trae su propia tolerancia, los tramos se escalan respecto
    a ella: un follaje tolera mucho más que una estatua.
    """
    if value < 0:
        return DeviationVerdict.UNMEASURED

    if tolerance and tolerance > 0:
        ratio = value / tolerance
        if ratio <= 0.4:
            return DeviationVerdict.EXCELLENT
        if ratio <= 1.0:
            return DeviationVerdict.GOOD
        if ratio <= 2.5:
            return DeviationVerdict.ACCEPTABLE
        if ratio <= 7.0:
            return DeviationVerdict.DRIFTED
        return DeviationVerdict.BROKEN

    if value <= DEVIATION_THRESHOLDS["excellent"]:
        return DeviationVerdict.EXCELLENT
    if value <= DEVIATION_THRESHOLDS["good"]:
        return DeviationVerdict.GOOD
    if value <= DEVIATION_THRESHOLDS["acceptable"]:
        return DeviationVerdict.ACCEPTABLE
    if value <= DEVIATION_THRESHOLDS["drifted"]:
        return DeviationVerdict.DRIFTED
    return DeviationVerdict.BROKEN


# ---------------------------------------------------------------- silueta


@dataclass
class SilhouetteResult:
    """Comparación de contornos desde varias vistas."""

    views: int = 0
    mean_error: float = 0.0     # fracción de píxeles que no coinciden
    worst_error: float = 0.0
    worst_view: str = ""
    mean_iou: float = 1.0
    per_view: dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def silhouette_error(matched_px: int, original_px: int, reconstructed_px: int) -> float:
    """Error de silueta de UNA vista: píxeles discordantes sobre la unión.

    Es 1 - IoU. Se usa la unión y no el original como denominador porque
    así penaliza igual perder contorno que agregarlo: un modelo inflado
    está tan mal como uno comido.
    """
    union = original_px + reconstructed_px - matched_px
    if union <= 0:
        return 0.0
    return max(0.0, min(1.0, 1.0 - (matched_px / union)))


def combine_silhouettes(per_view: dict[str, float]) -> SilhouetteResult:
    """Agrega las vistas. Manda la PEOR, no el promedio.

    Promediar esconde el caso real: seis vistas perfectas y una en la que
    desapareció un cuerno siguen dando un promedio excelente, y el objeto
    está roto desde ese ángulo.
    """
    if not per_view:
        return SilhouetteResult()

    errors = list(per_view.values())
    worst_view = max(per_view, key=lambda k: per_view[k])
    mean_err = sum(errors) / len(errors)

    return SilhouetteResult(
        views=len(per_view),
        mean_error=round(mean_err, 5),
        worst_error=round(per_view[worst_view], 5),
        worst_view=worst_view,
        mean_iou=round(1.0 - mean_err, 5),
        per_view={k: round(v, 5) for k, v in per_view.items()},
    )


def volume_error(volume_before: float, volume_after: float) -> float:
    """Error relativo de volumen. -1 si no se puede medir.

    Solo vale en mallas cerradas: en follaje abierto el volumen firmado no
    significa nada y por eso los presets de vegetación lo toleran amplio.
    """
    if volume_before <= 1e-12:
        return -1.0
    return abs(volume_after - volume_before) / volume_before


# --------------------------------------------------------------- veredicto


@dataclass
class FidelityReport:
    """Dictamen completo de fidelidad, con el motivo de cada pérdida."""

    verdict: DeviationVerdict = DeviationVerdict.UNMEASURED
    hausdorff: HausdorffResult | None = None
    silhouette: SilhouetteResult | None = None
    volume_error: float = -1.0
    passed: bool = False
    problems: list[str] = field(default_factory=list)
    recommendations: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "verdict": self.verdict.value,
            "hausdorff": self.hausdorff.to_dict() if self.hausdorff else None,
            "silhouette": self.silhouette.to_dict() if self.silhouette else None,
            "volume_error": self.volume_error,
            "passed": self.passed,
            "problems": list(self.problems),
            "recommendations": list(self.recommendations),
        }


def build_fidelity_report(
    hausdorff: HausdorffResult | None,
    silhouette: SilhouetteResult | None,
    vol_error: float,
    preset,
) -> FidelityReport:
    """Junta las tres mediciones en un dictamen y propone qué cambiar.

    El veredicto final es el PEOR de los tres, no el promedio: si la silueta
    se rompió, no importa que la distancia media sea excelente.
    """
    report = FidelityReport(hausdorff=hausdorff, silhouette=silhouette, volume_error=vol_error)
    verdicts: list[DeviationVerdict] = []

    if hausdorff and hausdorff.forward.samples:
        v = classify_deviation(hausdorff.symmetric_p99, preset.deviation_tolerance)
        verdicts.append(v)
        if hausdorff.lost_detail:
            report.problems.append(
                "Hay zonas del original sin contraparte en el resultado: se perdió detalle "
                f"(p99 de ida {hausdorff.forward.p99:.4f} vs. vuelta {hausdorff.backward.p99:.4f})."
            )
            report.recommendations.append(
                "Subir la resolución del remesh/retopo o activar Shrinkwrap con más iteraciones."
            )
        if hausdorff.added_geometry:
            report.problems.append(
                "El resultado tiene superficie que el original no tenía: el remesh cerró "
                "huecos o unió partes que debían quedar separadas."
            )
            report.recommendations.append(
                "Reducir el tamaño de voxel, o desactivar el voxel remesh si el modelo "
                "tiene superficies laminares (follaje, telas)."
            )
        if not hausdorff.forward.reliable:
            report.problems.append(
                f"Solo {hausdorff.forward.samples} muestras: la medición de desviación es "
                "orientativa, no concluyente."
            )
    else:
        report.problems.append("No se pudo medir la desviación geométrica.")

    if silhouette and silhouette.views:
        sil_verdict = classify_deviation(silhouette.worst_error, preset.silhouette_tolerance)
        verdicts.append(sil_verdict)
        if silhouette.worst_error > preset.silhouette_tolerance:
            report.problems.append(
                f"La silueta cambió un {silhouette.worst_error * 100:.1f}% en la vista "
                f"'{silhouette.worst_view}' (tolerancia {preset.silhouette_tolerance * 100:.1f}%)."
            )
            report.recommendations.append(
                "Revisar esa vista en la escena comparadora: es donde se perdió el contorno."
            )

    if vol_error >= 0:
        if vol_error > preset.volume_tolerance:
            verdicts.append(DeviationVerdict.DRIFTED)
            report.problems.append(
                f"El volumen cambió un {vol_error * 100:.1f}% "
                f"(tolerancia {preset.volume_tolerance * 100:.1f}%)."
            )
            report.recommendations.append(
                "Volumen inflado o colapsado: suele venir de un Shrinkwrap con offset o "
                "de un remesh demasiado grueso."
            )

    if verdicts:
        order = [
            DeviationVerdict.EXCELLENT,
            DeviationVerdict.GOOD,
            DeviationVerdict.ACCEPTABLE,
            DeviationVerdict.DRIFTED,
            DeviationVerdict.BROKEN,
        ]
        report.verdict = max(verdicts, key=lambda v: order.index(v))
    else:
        report.verdict = DeviationVerdict.UNMEASURED

    report.passed = report.verdict in (
        DeviationVerdict.EXCELLENT,
        DeviationVerdict.GOOD,
        DeviationVerdict.ACCEPTABLE,
    )
    return report
