"""Puntuación de calidad 0-100 en siete ejes. SIN dependencia de bpy.

Cada eje mide algo distinto y se calcula por separado porque un modelo puede
estar excelente en uno y roto en otro: un escaneo de fotogrametría tiene
superficie inmejorable y topología desastrosa, y promediarlos escondería
justo el dato que decide cómo tratarlo.

Los puntajes no son decorativos: alimentan las decisiones de reconstrucción
y se recalculan al final para mostrar ANTES → DESPUÉS.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any

# Presupuesto de triángulos que un visor autónomo (Quest 2/3) mueve con
# holgura para UN objeto, contando que la escena tendrá muchos más.
VR_BUDGET_COMFORTABLE = 60_000
VR_BUDGET_MAX = 200_000

# Resoluciones de textura de referencia.
TEXTURE_RES_GOOD = 2048
TEXTURE_RES_EXCELLENT = 4096


def _clamp(v: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, v))


def _penalty(ratio: float, weight: float, cap: float) -> float:
    """Penalización proporcional acotada: un defecto no puede, por sí solo,
    llevar un eje a cero si el resto está sano."""
    return min(cap, ratio * weight)


@dataclass
class ScoreCard:
    """Los siete ejes más el global."""

    topology: float = 0.0
    geometry: float = 0.0
    surface: float = 0.0
    texture: float = 0.0
    material: float = 0.0
    silhouette: float = 0.0
    vr_readiness: float = 0.0
    issues: list[str] = field(default_factory=list)

    AXES = ("topology", "geometry", "surface", "texture", "material", "silhouette", "vr_readiness")

    @property
    def overall(self) -> float:
        """Global ponderado. Topología y geometría pesan más porque son las
        que condicionan todo lo demás: sobre una malla rota no sirve ni la
        mejor textura."""
        weights = {
            "topology": 0.22,
            "geometry": 0.22,
            "surface": 0.16,
            "texture": 0.13,
            "material": 0.09,
            "silhouette": 0.10,
            "vr_readiness": 0.08,
        }
        return round(sum(getattr(self, a) * w for a, w in weights.items()), 1)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["overall"] = self.overall
        return d

    def delta(self, other: "ScoreCard") -> dict[str, tuple[float, float]]:
        """Pares (antes, después) por eje, para el informe final."""
        out: dict[str, tuple[float, float]] = {
            a: (getattr(self, a), getattr(other, a)) for a in self.AXES
        }
        out["overall"] = (self.overall, other.overall)
        return out


def score_topology(stats) -> tuple[float, list[str]]:
    """Qué tan sana y trabajable es la malla.

    Penaliza lo que impide subdividir o deformar sin artefactos: geometría
    non-manifold, n-gons, duplicados, caras interiores y normales invertidas.
    Premia los quads, que son los que soportan bien la subdivisión.
    """
    issues: list[str] = []
    if stats.faces == 0:
        return 0.0, ["Malla sin caras."]

    score = 100.0
    edges = max(1, stats.edges)
    faces = max(1, stats.faces)
    verts = max(1, stats.verts)

    nm = stats.non_manifold_edges / edges
    if nm > 0:
        # Peso alto a propósito: un 2% de aristas non-manifold en una malla
        # de un millón de aristas son 20.000 puntos donde la subdivisión,
        # el booleano y el horneado fallan. El porcentaje suena chico; el
        # problema no lo es.
        score -= _penalty(nm, 700.0, 50.0)
        issues.append(f"{stats.non_manifold_edges} aristas non-manifold ({nm * 100:.1f}%).")

    ngon = stats.ngons / faces
    if ngon > 0.02:
        score -= _penalty(ngon, 60.0, 22.0)
        issues.append(f"{stats.ngons} n-gons ({ngon * 100:.1f}%).")

    dup = stats.duplicate_verts / verts
    if dup > 0:
        score -= _penalty(dup, 130.0, 20.0)
        issues.append(f"{stats.duplicate_verts} vértices duplicados.")

    interior = stats.interior_faces / faces
    if interior > 0:
        score -= _penalty(interior, 160.0, 18.0)
        issues.append(f"{stats.interior_faces} caras interiores (invisibles, cuestan igual).")

    if stats.flipped_normals:
        score -= _penalty(stats.flipped_normals / faces, 130.0, 15.0)
        issues.append(f"{stats.flipped_normals} caras con la normal invertida.")

    if stats.loose_verts:
        score -= _penalty(stats.loose_verts / verts, 90.0, 10.0)
        issues.append(f"{stats.loose_verts} vértices sueltos.")

    # Malla fragmentada donde debería ser un sólido. La condición del borde
    # abierto es la que separa un defecto de un diseño: en follaje las islas
    # sueltas SON las hojas, y ahí no se penaliza nada.
    if stats.loose_parts > 3 and stats.boundary_ratio < 0.10:
        score -= min(12.0, (stats.loose_parts - 1) * 2.0)
        issues.append(
            f"{stats.loose_parts} islas desconectadas en una malla que debería ser "
            "una sola pieza."
        )

    # Aristas de largo muy dispar: la malla tiene zonas densísimas al lado de
    # zonas vacías. Subdividirla amplifica esa desigualdad y deformarla
    # produce pellizcos.
    cv = stats.edge_length_cv
    if cv > 0.5:
        score -= min(12.0, (cv - 0.5) * 20.0)
        issues.append(f"Densidad de malla muy irregular (CV de arista {cv:.2f}).")

    # Los quads son mejores para subdividir y deformar; sin ellos el modelo
    # es utilizable pero no se puede refinar limpiamente.
    quad_bonus = (stats.quad_ratio - 0.5) * 30.0
    score += max(-15.0, min(10.0, quad_bonus))
    if stats.quad_ratio < 0.25 and stats.faces > 100:
        issues.append(f"Solo {stats.quad_ratio * 100:.0f}% de quads: malla triangulada.")

    return round(_clamp(score), 1), issues


def score_geometry(stats) -> tuple[float, list[str]]:
    """Si hay suficiente geometría para la forma que describe.

    El criterio es la DENSIDAD (triángulos por unidad de área), no el conteo
    bruto: 20k tris en un pájaro de 30 cm es alta resolución, los mismos 20k
    en un árbol de 12 m es una caja.
    """
    issues: list[str] = []
    if stats.tris == 0:
        return 0.0, ["Sin geometría."]
    if stats.surface_area <= 1e-9:
        return 25.0, ["No se pudo medir el área: geometría degenerada o plana."]

    d = stats.density  # triángulos por unidad²

    # Escala por tramos: la percepción de detalle no crece linealmente con la
    # densidad. ~4000 tris/u² ya se considera denso para un objeto de 1 m.
    if d < 8:
        score = 10.0 + d * 2.0
        issues.append(f"Densidad muy baja ({d:.1f} tris/u²): la forma está apenas insinuada.")
    elif d < 80:
        score = 26.0 + (d - 8) * 0.45
        issues.append(f"Densidad baja ({d:.0f} tris/u²): las curvas se ven facetadas.")
    elif d < 600:
        score = 58.0 + (d - 80) * 0.045
    elif d < 4000:
        score = 82.0 + (d - 600) * 0.0035
    else:
        score = 94.0 + min(6.0, (d - 4000) / 8000.0)

    # Distribución: si casi toda la malla es plana, los polígonos no están
    # donde hacen falta.
    if stats.planar_ratio > 0.75 and stats.tris > 5_000:
        score -= 12.0
        issues.append(
            f"{stats.planar_ratio * 100:.0f}% de la malla es plana: los polígonos "
            "no están donde aportan silueta."
        )

    if stats.degenerate_faces:
        score -= _penalty(stats.degenerate_faces / max(1, stats.faces), 120.0, 15.0)
        issues.append(f"{stats.degenerate_faces} caras degeneradas (área ~0).")

    return round(_clamp(score), 1), issues


def score_surface(stats) -> tuple[float, list[str]]:
    """Calidad del sombreado y la continuidad superficial."""
    issues: list[str] = []
    score = 72.0

    if stats.has_custom_normals:
        score += 10.0
    if stats.shade_smooth:
        score += 8.0
    else:
        issues.append("Sombreado plano: las superficies curvas se ven facetadas.")
        score -= 10.0

    if stats.flipped_normals:
        score -= _penalty(stats.flipped_normals / max(1, stats.faces), 150.0, 25.0)
        issues.append("Normales inconsistentes: el sombreado tiene manchas.")

    # Caras muy finas producen sombreado sucio y revientan al subdividir.
    if stats.thin_faces:
        ratio = stats.thin_faces / max(1, stats.faces)
        score -= _penalty(ratio, 110.0, 20.0)
        issues.append(f"{stats.thin_faces} caras extremadamente delgadas.")

    if stats.boundary_edges and stats.faces > 500:
        # Los bordes abiertos son normales en hojas y alpha cards; se señalan
        # pero no se castigan fuerte.
        ratio = stats.boundary_edges / max(1, stats.edges)
        if ratio > 0.2:
            score -= 8.0
            issues.append(
                f"{stats.boundary_edges} bordes abiertos: malla no cerrada "
                "(normal en follaje, problema en un sólido)."
            )

    return round(_clamp(score), 1), issues


def score_texture(stats) -> tuple[float, list[str]]:
    """Cobertura y resolución de las texturas."""
    issues: list[str] = []
    if not stats.has_uvs:
        return 0.0, ["Sin UVs: no se puede texturizar ni hornear."]

    score = 40.0
    if stats.uv_layers >= 1:
        score += 12.0
    if stats.udim_tiles > 1:
        score += 8.0

    if stats.texture_resolution >= TEXTURE_RES_EXCELLENT:
        score += 24.0
    elif stats.texture_resolution >= TEXTURE_RES_GOOD:
        score += 16.0
    elif stats.texture_resolution >= 1024:
        score += 8.0
        issues.append(f"Texturas de {stats.texture_resolution}px: justas para primeros planos.")
    elif stats.texture_resolution > 0:
        issues.append(f"Texturas de {stats.texture_resolution}px: muy baja resolución.")
    else:
        issues.append("Sin texturas de imagen.")

    # Los mapas que aportan relieve son los que más suben la calidad
    # percibida sin costar geometría.
    if stats.has_normal_map:
        score += 12.0
    else:
        issues.append("Sin normal map: el microrelieve tendría que salir de geometría.")
    if stats.has_roughness_map:
        score += 5.0
    if stats.has_displacement_map:
        score += 5.0
    if stats.has_ao_map:
        score += 3.0

    if stats.uv_overlap_ratio > 0.05:
        score -= _penalty(stats.uv_overlap_ratio, 60.0, 18.0)
        issues.append(
            f"UVs superpuestas ({stats.uv_overlap_ratio * 100:.0f}%): el bake se pisa a sí mismo."
        )

    return round(_clamp(score), 1), issues


def score_material(stats) -> tuple[float, list[str]]:
    """Si los materiales están armados de forma utilizable."""
    issues: list[str] = []
    if stats.materials == 0:
        return 15.0, ["Sin materiales asignados."]

    score = 55.0
    if stats.textured_materials > 0:
        score += 25.0 * min(1.0, stats.textured_materials / stats.materials)
    else:
        issues.append("Materiales sin texturas: solo colores planos.")

    if stats.uses_nodes:
        score += 12.0
    else:
        issues.append("Materiales sin nodos: no se puede hornear sobre ellos.")

    if stats.materials > 8:
        score -= 8.0
        issues.append(f"{stats.materials} materiales: conviene atlasar para VR.")

    return round(_clamp(score), 1), issues


def score_silhouette(stats) -> tuple[float, list[str]]:
    """Cuán bien definido está el contorno, que es lo que más se ve.

    Se estima por cuánta geometría hay en zonas de curvatura: un modelo con
    muchos polígonos repartidos en superficies planas tiene mala silueta
    aunque el conteo total sea alto.
    """
    issues: list[str] = []
    if stats.tris == 0:
        return 0.0, ["Sin geometría."]

    curved = 1.0 - stats.planar_ratio
    score = 35.0 + curved * 45.0

    d = stats.density
    if d < 40:
        score -= 20.0
        issues.append("Poca geometría en los bordes: la silueta se ve poligonal.")
    elif d > 400:
        score += 12.0

    if stats.sharp_edges_ratio > 0.4 and stats.tris > 2000:
        score -= 8.0
        issues.append("Muchos bordes duros: silueta angulosa donde debería ser orgánica.")

    return round(_clamp(score), 1), issues


def score_vr_readiness(stats) -> tuple[float, list[str]]:
    """Si se puede poner tal cual en un visor autónomo."""
    issues: list[str] = []
    score = 100.0

    if stats.tris > VR_BUDGET_MAX:
        score -= 45.0
        issues.append(
            f"{stats.tris:,} tris: muy por encima del presupuesto de VR "
            f"({VR_BUDGET_MAX:,} para un objeto). Necesita LODs."
        )
    elif stats.tris > VR_BUDGET_COMFORTABLE:
        score -= 18.0
        issues.append(f"{stats.tris:,} tris: pesado para VR, conviene un LOD.")

    if not stats.has_uvs:
        score -= 25.0
        issues.append("Sin UVs: no se puede hornear para aligerar.")
    if stats.materials > 4:
        score -= 12.0
        issues.append(f"{stats.materials} materiales = {stats.materials} draw calls.")
    if stats.texture_resolution > 4096:
        score -= 10.0
        issues.append("Texturas de más de 4K: exceso de memoria en un visor autónomo.")
    if stats.non_manifold_edges > 0:
        score -= 8.0
    if stats.shape_keys > 0 and stats.tris > VR_BUDGET_COMFORTABLE:
        score -= 8.0
        issues.append("Shape keys sobre malla pesada: costoso de animar en VR.")

    return round(_clamp(score), 1), issues


def build_scorecard(stats) -> ScoreCard:
    """Calcula los siete ejes y junta los problemas encontrados."""
    card = ScoreCard()
    all_issues: list[str] = []

    for axis, fn in (
        ("topology", score_topology),
        ("geometry", score_geometry),
        ("surface", score_surface),
        ("texture", score_texture),
        ("material", score_material),
        ("silhouette", score_silhouette),
        ("vr_readiness", score_vr_readiness),
    ):
        value, issues = fn(stats)
        setattr(card, axis, value)
        all_issues.extend(issues)

    card.issues = all_issues
    return card
