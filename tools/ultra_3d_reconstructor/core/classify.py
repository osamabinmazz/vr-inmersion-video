"""Clasificación semántica del modelo. SIN dependencia de bpy.

El tratamiento NO puede ser el mismo para un carpincho que para un ombú o
para la estatua de Zapicán:

  - un animal necesita que se preserven el volumen y la silueta orgánica,
    y que no se toque el skinning;
  - un árbol es mayoritariamente tarjetas abiertas con alfa: cerrarlas o
    remeshearlas lo destruye;
  - una estatua aguanta (y pide) subdivisión agresiva y microrelieve;
  - un escaneo de fotogrametría tiene superficie excelente y topología
    desastrosa: hay que retopologizar, no subdividir.

Por eso acá se decide QUÉ es el modelo, con señales medibles, antes de
decidir qué hacerle. Nunca se adivina en silencio: cada categoría acumula
evidencia citable y el resultado lleva su confianza y su segunda opción.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class ModelKind(str, Enum):
    """Las diez categorías del brief (A-J)."""

    ANIMAL = "A_animal"
    HUMAN = "B_human"
    TREE = "C_tree"
    PLANT = "D_plant"
    STATUE = "E_statue"
    RIGID_OBJECT = "F_rigid_object"
    ARCHITECTURE = "G_architecture"
    PHOTOGRAMMETRY = "H_photogrammetry"
    TERRAIN = "I_terrain"
    UNKNOWN = "J_unknown"

    @property
    def letter(self) -> str:
        return self.value[0]

    @property
    def label_es(self) -> str:
        return {
            "A_animal": "Animal",
            "B_human": "Humano / personaje",
            "C_tree": "Árbol",
            "D_plant": "Planta / arbusto",
            "E_statue": "Estatua / escultura",
            "F_rigid_object": "Objeto rígido",
            "G_architecture": "Arquitectura",
            "H_photogrammetry": "Escaneo de fotogrametría",
            "I_terrain": "Terreno",
            "J_unknown": "Modelo desconocido",
        }[self.value]


# Pistas por nombre. Valen bastante pero NO deciden solas: un archivo
# llamado "tree_final_v3" puede ser un tronco sólido sin una hoja, y la
# geometría manda sobre la etiqueta.
NAME_HINTS: dict[ModelKind, tuple[str, ...]] = {
    ModelKind.ANIMAL: (
        "animal", "capybara", "carpincho", "rhea", "nandu", "ñandu", "ave", "bird",
        "tero", "vanellus", "armadillo", "mulita", "caiman", "yacare", "yacaré",
        "dog", "cat", "horse", "caballo", "vaca", "cow", "deer", "venado", "fish",
        "pez", "insect", "butterfly", "mariposa", "lizard", "snake", "creature",
    ),
    ModelKind.HUMAN: (
        "human", "humano", "character", "personaje", "man", "woman", "hombre",
        "mujer", "person", "persona", "body", "cuerpo", "male", "female", "avatar",
        "charrua", "charrúa", "guerrero", "warrior",
    ),
    ModelKind.TREE: (
        "tree", "arbol", "árbol", "ombu", "ombú", "ceibo", "erythrina", "butia",
        "butiá", "palm", "palmera", "sauce", "willow", "espinillo", "algarrobo",
        "coronilla", "trunk", "tronco", "canopy", "foliage", "follaje",
    ),
    ModelKind.PLANT: (
        "plant", "planta", "bush", "arbusto", "shrub", "grass", "pasto", "cesped",
        "césped", "cortadera", "cortaderia", "pampas", "fern", "helecho", "flower",
        "flor", "leaf", "hoja", "hierba", "weed", "junco", "reed", "totora",
    ),
    ModelKind.STATUE: (
        "statue", "estatua", "sculpture", "escultura", "monument", "monumento",
        "bust", "busto", "zapican", "zapicán", "memorial", "marble", "bronze",
    ),
    ModelKind.ARCHITECTURE: (
        "building", "edificio", "house", "casa", "wall", "muro", "pared", "roof",
        "techo", "floor", "piso", "door", "puerta", "window", "ventana", "bridge",
        "puente", "tower", "torre", "ruin", "ruina", "fence", "cerco", "alambrado",
    ),
    ModelKind.RIGID_OBJECT: (
        "prop", "object", "objeto", "tool", "herramienta", "weapon", "arma",
        "boleadora", "vasija", "pot", "vessel", "box", "caja", "barrel", "barril",
        "rock", "roca", "piedra", "stone", "chair", "silla", "table", "mesa",
    ),
    ModelKind.TERRAIN: (
        "terrain", "terreno", "ground", "suelo", "landscape", "paisaje", "heightmap",
        "displacement_plane", "hill", "colina", "cerro", "island", "isla", "campo",
    ),
    ModelKind.PHOTOGRAMMETRY: (
        "scan", "escaneo", "photogrammetry", "fotogrametria", "fotogrametría",
        "reality", "realitycapture", "metashape", "meshroom", "lidar", "raw_scan",
    ),
}

# Peso máximo que puede aportar el nombre. Menos que la evidencia geométrica
# combinada, a propósito.
NAME_WEIGHT = 2.2


@dataclass
class Classification:
    """Resultado con su evidencia, para que la decisión sea auditable."""

    kind: ModelKind = ModelKind.UNKNOWN
    confidence: float = 0.0          # 0-1
    runner_up: ModelKind | None = None
    scores: dict[str, float] = field(default_factory=dict)
    evidence: list[str] = field(default_factory=list)
    photogrammetry_likelihood: float = 0.0
    is_organic: bool = False
    is_foliage: bool = False

    def describe(self) -> str:
        line = f"{self.kind.letter} — {self.kind.label_es} (confianza {self.confidence * 100:.0f}%)"
        if self.runner_up and self.confidence < 0.7:
            line += f", segunda opción: {self.runner_up.label_es}"
        return line


def _name_tokens(stats) -> str:
    parts = [stats.name or "", stats.source_file or ""]
    parts.extend(stats.name_hints or [])
    return " ".join(parts).lower().replace("-", "_").replace(".", "_")


def _name_score(stats) -> dict[ModelKind, tuple[float, str]]:
    """Coincidencias por nombre, una por categoría (la primera que pega)."""
    blob = _name_tokens(stats)
    found: dict[ModelKind, tuple[float, str]] = {}
    for kind, words in NAME_HINTS.items():
        for w in words:
            if w in blob:
                found[kind] = (NAME_WEIGHT, f'El nombre contiene "{w}".')
                break
    return found


def photogrammetry_score(stats) -> tuple[float, list[str]]:
    """Probabilidad de que sea un escaneo crudo.

    Es una firma bastante inconfundible: densidad altísima, todo triangulado,
    topología sucia, aristas de largo irregular y, a menudo, colores por
    vértice o una textura enorme única. Importa detectarlo porque un escaneo
    NO se subdivide: se retopologiza y se le hornea el detalle que ya tiene.
    """
    ev: list[str] = []
    score = 0.0

    if stats.tris > 250_000:
        score += 1.4
        ev.append(f"{stats.tris:,} triángulos: densidad propia de escaneo.")
    elif stats.tris > 80_000:
        score += 0.6

    if stats.tri_ratio > 0.95 and stats.faces > 5_000:
        score += 1.2
        ev.append("Malla 100% triangulada sin un solo quad.")

    if stats.non_manifold_ratio > 0.01:
        score += 0.8
        ev.append(f"Topología sucia ({stats.non_manifold_ratio * 100:.1f}% non-manifold).")

    if stats.edge_length_cv > 0.55:
        score += 0.7
        ev.append(f"Aristas de largo muy irregular (CV {stats.edge_length_cv:.2f}).")

    if stats.vertex_color_layers > 0 and stats.materials <= 1:
        score += 0.6
        ev.append("Color por vértice con un solo material: salida típica de escáner.")

    if stats.texture_resolution >= 8192:
        score += 0.5
        ev.append(f"Textura de {stats.texture_resolution}px: atlas de escaneo.")

    if stats.boundary_ratio > 0.02 and stats.loose_parts > 3:
        score += 0.4
        ev.append("Superficie fragmentada con bordes abiertos: zonas sin cobertura de cámara.")

    if stats.has_armature or stats.shape_keys:
        # Un escaneo crudo no viene riggeado.
        score -= 1.5

    return max(0.0, score), ev


# Debajo de esta cantidad de caras, las medidas de forma (planaridad,
# curvatura, simetría) no describen nada: un tetraedro da "0% plano" y eso
# no lo vuelve orgánico. Sin evidencia real, no se clasifica.
MIN_FACES_FOR_SHAPE = 50


def _organic_evidence(stats) -> tuple[float, list[str]]:
    """Señales comunes a animal / humano / estatua: forma orgánica.

    Un campo en cero puede significar "medido y da cero" o "no se pudo
    medir", y confundirlos hace que cualquier malla trivial pase por
    escultura. Por eso se exige un mínimo de caras antes de leer la forma.
    """
    ev: list[str] = []
    score = 0.0
    if stats.faces < MIN_FACES_FOR_SHAPE:
        return 0.0, []
    if stats.planar_ratio < 0.25:
        score += 1.0
        ev.append(f"Casi nada de la superficie es plana ({stats.planar_ratio * 100:.0f}%).")
    if stats.sharp_edges_ratio < 0.15:
        score += 0.8
        ev.append("Pocas aristas duras: transiciones suaves.")
    if stats.best_symmetry > 0.8:
        score += 1.0
        ev.append(f"Simetría bilateral marcada ({stats.best_symmetry * 100:.0f}%).")
    if stats.curvature_std > 0.2:
        score += 0.5
        ev.append("Curvatura variable: detalle concentrado en zonas, no uniforme.")
    if stats.loose_parts <= 3 and stats.faces > 0:
        score += 0.4
    return score, ev


def _foliage_evidence(stats) -> tuple[float, list[str]]:
    """Señales de vegetación: tarjetas abiertas, muchas islas, alfa."""
    ev: list[str] = []
    score = 0.0
    if stats.loose_parts >= 12:
        score += 1.3
        ev.append(f"{stats.loose_parts} piezas sueltas: hojas o tarjetas independientes.")
    elif stats.loose_parts >= 5:
        score += 0.6
    if stats.boundary_ratio > 0.15:
        score += 1.2
        ev.append(
            f"{stats.boundary_ratio * 100:.0f}% de bordes abiertos: superficies laminares, "
            "no un sólido."
        )
    if stats.planar_ratio > 0.5 and stats.loose_parts >= 5:
        score += 0.8
        ev.append("Muchas superficies planas repetidas: tarjetas de follaje.")
    if stats.materials >= 2 and stats.textured_materials >= 1 and stats.boundary_edges > 0:
        score += 0.3
    return score, ev


def classify_model(stats) -> Classification:
    """Clasifica el modelo con señales medibles y deja el rastro.

    No hay un único discriminante: se acumula evidencia por categoría y se
    compara. Si dos categorías quedan parejas, la confianza baja y el plan
    lo tiene en cuenta (trata al modelo con el criterio más conservador de
    los dos).
    """
    scores: dict[ModelKind, float] = {k: 0.0 for k in ModelKind}
    evidence: dict[ModelKind, list[str]] = {k: [] for k in ModelKind}

    if stats.faces == 0:
        return Classification(
            kind=ModelKind.UNKNOWN,
            confidence=0.0,
            evidence=["El objeto no tiene caras: no hay nada que clasificar."],
        )

    def add(kind: ModelKind, points: float, why: str = "") -> None:
        scores[kind] += points
        if why:
            evidence[kind].append(why)

    organic, organic_ev = _organic_evidence(stats)
    foliage, foliage_ev = _foliage_evidence(stats)
    photo, photo_ev = photogrammetry_score(stats)

    tall = stats.aspect_tall
    flat = stats.aspect_flat
    size = stats.max_dimension

    # --- H: fotogrametría ------------------------------------------------
    scores[ModelKind.PHOTOGRAMMETRY] += photo
    evidence[ModelKind.PHOTOGRAMMETRY].extend(photo_ev)

    # --- I: terreno ------------------------------------------------------
    if flat < 0.18 and stats.faces > 200:
        add(ModelKind.TERRAIN, 1.5, f"Muy chato: la altura es {flat * 100:.0f}% de su lado mayor.")
    if stats.upward_face_ratio > 0.7:
        add(
            ModelKind.TERRAIN,
            1.6,
            f"{stats.upward_face_ratio * 100:.0f}% de la superficie mira hacia arriba: "
            "es un campo de alturas.",
        )
    if size > 20.0 and flat < 0.3:
        add(ModelKind.TERRAIN, 0.8, f"Extensión de {size:.0f} unidades, sin volumen vertical.")
    if stats.loose_parts == 1 and stats.boundary_ratio > 0.0 and flat < 0.2:
        add(ModelKind.TERRAIN, 0.5, "Una sola pieza abierta por el perímetro.")
    if stats.has_armature:
        scores[ModelKind.TERRAIN] -= 2.0

    # --- G: arquitectura -------------------------------------------------
    if stats.planar_ratio > 0.7:
        add(
            ModelKind.ARCHITECTURE,
            1.4,
            f"{stats.planar_ratio * 100:.0f}% de superficie plana: construido con caras rectas.",
        )
    if stats.sharp_edges_ratio > 0.35:
        add(ModelKind.ARCHITECTURE, 1.0, "Predominan las aristas duras y los ángulos rectos.")
    if size > 6.0 and stats.planar_ratio > 0.55:
        add(ModelKind.ARCHITECTURE, 0.7, f"Escala de {size:.1f} unidades con geometría plana.")
    if stats.curvature_std < 0.12 and stats.planar_ratio > 0.6:
        add(ModelKind.ARCHITECTURE, 0.5, "Curvatura casi nula: nada esculpido.")
    if stats.has_armature:
        scores[ModelKind.ARCHITECTURE] -= 1.5

    # --- F: objeto rígido -------------------------------------------------
    if 0.35 < stats.planar_ratio <= 0.75 and stats.loose_parts <= 4:
        add(ModelKind.RIGID_OBJECT, 1.1, "Mezcla de caras planas y curvas en una pieza compacta.")
    if size < 3.0 and stats.planar_ratio > 0.3 and not stats.has_armature:
        add(ModelKind.RIGID_OBJECT, 0.9, f"Objeto compacto ({size:.2f} unidades) sin rig.")
    if stats.is_watertight and stats.sharp_edges_ratio > 0.2:
        add(ModelKind.RIGID_OBJECT, 0.6, "Sólido cerrado con bordes definidos.")
    if stats.has_armature or stats.shape_keys:
        scores[ModelKind.RIGID_OBJECT] -= 1.2

    # --- C/D: vegetación ---------------------------------------------------
    if foliage > 0:
        # Árbol y planta comparten la firma de follaje; los separa el porte.
        scores[ModelKind.TREE] += foliage
        scores[ModelKind.PLANT] += foliage
        evidence[ModelKind.TREE].extend(foliage_ev)
        evidence[ModelKind.PLANT].extend(foliage_ev)
    if tall > 1.4 and foliage > 0.5:
        add(ModelKind.TREE, 1.2, f"Porte vertical (alto/ancho {tall:.1f}) con masa de follaje.")
        scores[ModelKind.PLANT] -= 0.4
    if size > 3.0 and foliage > 0.5:
        add(ModelKind.TREE, 0.8, f"{size:.1f} unidades de altura: porte arbóreo.")
    if size <= 2.5 and foliage > 0.5:
        add(ModelKind.PLANT, 1.1, f"Vegetación de porte bajo ({size:.2f} unidades).")
    if tall <= 1.4 and foliage > 0.5:
        add(ModelKind.PLANT, 0.5, "Tan ancha como alta: mata o arbusto, no árbol.")
    if stats.has_armature:
        scores[ModelKind.TREE] -= 1.0
        scores[ModelKind.PLANT] -= 1.0

    # --- A/B/E: formas orgánicas ------------------------------------------
    if organic > 0:
        for k in (ModelKind.ANIMAL, ModelKind.HUMAN, ModelKind.STATUE):
            scores[k] += organic
            evidence[k].extend(organic_ev)

    rigged = stats.has_armature or stats.vertex_groups >= 4
    if rigged:
        add(ModelKind.ANIMAL, 1.3, "Tiene armature o vertex groups: está pensado para animarse.")
        add(ModelKind.HUMAN, 1.3, "Tiene armature o vertex groups: está pensado para animarse.")
        # Una estatua riggeada es una contradicción.
        scores[ModelKind.STATUE] -= 1.8

    # Bípedo de pie vs. cuadrúpedo: la proporción separa bastante bien.
    if 1.6 <= tall <= 6.0 and stats.best_symmetry > 0.75:
        add(ModelKind.HUMAN, 1.0, f"Proporción erguida (alto/ancho {tall:.1f}) y simétrica.")
        add(ModelKind.STATUE, 0.7, "Proporción erguida: figura de pie.")
    if tall < 1.2 and stats.best_symmetry > 0.7 and organic > 1.5:
        add(ModelKind.ANIMAL, 1.1, f"Más largo que alto (alto/ancho {tall:.1f}): cuadrúpedo o ave.")
        scores[ModelKind.HUMAN] -= 0.8

    if not rigged and organic > 1.5 and stats.materials <= 2:
        add(
            ModelKind.STATUE,
            1.0,
            "Forma orgánica sin rig y con material único: pieza escultórica, no personaje.",
        )
    if not rigged and stats.is_watertight and organic > 1.0 and stats.vertex_color_layers == 0:
        add(ModelKind.STATUE, 0.5, "Sólido cerrado y macizo.")

    # --- pistas por nombre -------------------------------------------------
    for kind, (pts, why) in _name_score(stats).items():
        add(kind, pts, why)

    # --- resolución --------------------------------------------------------
    ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    best, best_score = ranked[0]
    second, second_score = ranked[1]

    if best_score < 1.2:
        # Nada destaca: decirlo, en vez de inventar una categoría.
        result = Classification(
            kind=ModelKind.UNKNOWN,
            confidence=0.0,
            runner_up=best if best_score > 0 else None,
            scores={k.value: round(v, 2) for k, v in scores.items()},
            evidence=[
                "Ninguna categoría reúne evidencia suficiente; se aplica el "
                "tratamiento conservador de 'modelo desconocido'."
            ],
            photogrammetry_likelihood=round(min(1.0, photo / 3.5), 2),
        )
        return result

    total = sum(max(0.0, v) for v in scores.values()) or 1.0
    margin = (best_score - max(0.0, second_score)) / best_score
    # La confianza combina cuánto destaca sobre la segunda y cuánta masa de
    # evidencia concentra. Un ganador por poco margen no es una certeza.
    confidence = min(0.99, 0.45 * margin + 0.55 * (best_score / total) * 1.8)

    return Classification(
        kind=best,
        confidence=round(max(0.0, confidence), 2),
        runner_up=second if second_score > 0 else None,
        scores={k.value: round(v, 2) for k, v in scores.items()},
        evidence=evidence[best][:8],
        photogrammetry_likelihood=round(min(1.0, photo / 3.5), 2),
        is_organic=best in (ModelKind.ANIMAL, ModelKind.HUMAN, ModelKind.STATUE),
        is_foliage=best in (ModelKind.TREE, ModelKind.PLANT),
    )
