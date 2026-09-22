"""Métricas y clasificación de mallas. SIN dependencia de bpy.

Todo lo que decide *qué hacerle* a un modelo vive acá, separado de la capa
que habla con Blender. Así esta lógica —que es la que evita el error de
"más polígonos = más detalle"— se puede testear fuera de Blender.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Any


class MeshClass(str, Enum):
    """Rango de densidad del modelo de entrada."""

    VERY_LOW = "very_low"      # < 1k tris: cajas, props primitivos
    LOW = "low"                # 1k-15k: low poly de juego
    MEDIUM = "medium"          # 15k-120k: modelo de juego decente
    HIGH = "high"              # 120k-800k: alta calidad
    VERY_HIGH = "very_high"    # > 800k: escaneo / escultura


class TopologyQuality(str, Enum):
    """Qué tan sana es la topología, que decide subdividir vs. rehacer."""

    CLEAN = "clean"            # quads mayormente, manifold, sin basura
    ACCEPTABLE = "acceptable"  # algún problema menor, subdividible
    POOR = "poor"              # non-manifold / triángulos sucios: hay que remeshear
    BROKEN = "broken"          # tan rota que el remesh por voxel es la única vía


class Strategy(str, Enum):
    """Cómo se construye el MASTER_HIGH."""

    SUBDIVIDE = "subdivide"                  # topología sana: Subdivision Surface
    MULTIRES = "multires"                    # sana y con UVs: Multires (permite esculpir/bakear)
    REMESH_SHRINKWRAP = "remesh_shrinkwrap"  # topología mala: voxel remesh + shrinkwrap al original
    DETAIL_ONLY = "detail_only"              # ya es denso: no tocar geometría, solo mapas


# Límites de triángulos por nivel. Son rangos objetivo, no absolutos: el
# plan los adapta a la complejidad real del modelo (ver plan_targets).
LOD_BUDGETS: dict[str, tuple[int, int]] = {
    "MASTER_HIGH": (500_000, 3_000_000),
    "LOD0": (80_000, 250_000),
    "LOD1": (30_000, 80_000),
    "LOD2": (5_000, 30_000),
}

LOD_ORDER = ["MASTER_HIGH", "LOD0", "LOD1", "LOD2"]

# Resolución de bake por nivel.
BAKE_RESOLUTION: dict[str, int] = {
    "MASTER_HIGH": 4096,
    "LOD0": 4096,
    "LOD1": 2048,
    "LOD2": 2048,
}


@dataclass
class MeshStats:
    """Lo que se mide del modelo antes de tocarlo."""

    name: str = ""
    verts: int = 0
    edges: int = 0
    faces: int = 0
    tris: int = 0
    quads: int = 0
    ngons: int = 0
    loose_verts: int = 0
    non_manifold_edges: int = 0
    interior_faces: int = 0
    boundary_edges: int = 0        # agujeros: bordes con una sola cara
    flipped_normals: int = 0
    duplicate_verts: int = 0
    has_custom_normals: bool = False
    uv_layers: int = 0
    materials: int = 0
    textured_materials: int = 0
    has_armature: bool = False
    shape_keys: int = 0
    vertex_groups: int = 0
    dimensions: tuple[float, float, float] = (0.0, 0.0, 0.0)
    scale: tuple[float, float, float] = (1.0, 1.0, 1.0)
    volume: float = 0.0
    surface_area: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @property
    def quad_ratio(self) -> float:
        """Proporción de quads. Alta = topología pensada para subdividir."""
        return (self.quads / self.faces) if self.faces else 0.0

    @property
    def ngon_ratio(self) -> float:
        return (self.ngons / self.faces) if self.faces else 0.0

    @property
    def max_dimension(self) -> float:
        return max(self.dimensions) if self.dimensions else 0.0

    @property
    def density(self) -> float:
        """Triángulos por unidad de área. Mide detalle real, no conteo bruto:
        un modelo de 100k tris que mide 50m está menos detallado que uno de
        20k tris que mide 30cm."""
        return (self.tris / self.surface_area) if self.surface_area > 1e-9 else 0.0

    @property
    def has_uvs(self) -> bool:
        return self.uv_layers > 0

    @property
    def is_scaled(self) -> bool:
        """Escala sin aplicar: distorsiona el voxel remesh y modificadores
        que trabajan en distancias absolutas (Solidify, Bevel, Shrinkwrap)."""
        return any(abs(s - 1.0) > 1e-4 for s in self.scale)


@dataclass
class ProcessingPlan:
    """Decisión razonada de qué hacerle al modelo."""

    strategy: Strategy
    mesh_class: MeshClass
    topology: TopologyQuality
    targets: dict[str, int] = field(default_factory=dict)
    needs_repair: bool = False
    needs_uv_unwrap: bool = False
    needs_normals_fix: bool = False
    needs_scale_apply: bool = False
    subdivision_levels: int = 0
    voxel_size: float = 0.0
    use_shrinkwrap: bool = False
    bake_normal: bool = True
    bake_ao: bool = True
    bake_displacement: bool = False
    preserve_armature: bool = False
    warnings: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["strategy"] = self.strategy.value
        d["mesh_class"] = self.mesh_class.value
        d["topology"] = self.topology.value
        return d


def classify_density(tris: int) -> MeshClass:
    if tris < 1_000:
        return MeshClass.VERY_LOW
    if tris < 15_000:
        return MeshClass.LOW
    if tris < 120_000:
        return MeshClass.MEDIUM
    if tris < 800_000:
        return MeshClass.HIGH
    return MeshClass.VERY_HIGH


def classify_topology(stats: MeshStats) -> TopologyQuality:
    """Decide si la malla se puede subdividir o hay que rehacerla.

    El criterio no es estético: Subdivision Surface sobre topología
    non-manifold o llena de ngons produce artefactos (picos, pliegues,
    superficies derretidas). En ese caso conviene generar superficie nueva.
    """
    if stats.faces == 0:
        return TopologyQuality.BROKEN

    nm_ratio = stats.non_manifold_edges / stats.edges if stats.edges else 0.0

    # Malla severamente rota: no hay nada que subdividir con sentido.
    if nm_ratio > 0.25 or stats.interior_faces > stats.faces * 0.15:
        return TopologyQuality.BROKEN

    if nm_ratio > 0.05 or stats.ngon_ratio > 0.25 or stats.duplicate_verts > stats.verts * 0.05:
        return TopologyQuality.POOR

    if nm_ratio > 0.005 or stats.ngon_ratio > 0.05 or stats.flipped_normals > 0:
        return TopologyQuality.ACCEPTABLE

    return TopologyQuality.CLEAN


def choose_strategy(stats: MeshStats, mesh_class: MeshClass, topology: TopologyQuality) -> Strategy:
    """Elige cómo construir el MASTER_HIGH.

    Regla central del sistema: subdividir solo aporta cuando hay una
    superficie curva que refinar Y la topología lo soporta. Si el modelo ya
    es denso, subdividir no agrega información: agrega peso. Ahí el camino
    es recuperar detalle desde las texturas (normal/displacement).
    """
    if topology is TopologyQuality.BROKEN:
        return Strategy.REMESH_SHRINKWRAP

    # Ya tiene toda la geometría que puede necesitar: subdividir sería
    # inflarlo sin ganancia visual.
    if mesh_class is MeshClass.VERY_HIGH:
        return Strategy.DETAIL_ONLY

    if topology is TopologyQuality.POOR:
        return Strategy.REMESH_SHRINKWRAP

    # Topología sana + UVs: Multires permite bakear del nivel alto al bajo
    # conservando el mapeo, que es justo lo que necesita el pipeline de LODs.
    if topology is TopologyQuality.CLEAN and stats.has_uvs and stats.quad_ratio >= 0.5:
        return Strategy.MULTIRES

    return Strategy.SUBDIVIDE


def subdivision_levels_for(tris: int, target: int, max_levels: int = 4) -> int:
    """Cuántos niveles de subdivisión hacen falta para acercarse al objetivo.

    Cada nivel de Catmull-Clark multiplica las caras por ~4, así que esto
    crece rapidísimo: se corta en max_levels para no agotar la memoria.
    """
    if tris <= 0 or target <= tris:
        return 0
    levels = 0
    current = tris
    while current * 4 <= target and levels < max_levels:
        current *= 4
        levels += 1
    # Un nivel más si queda muy corto y no se dispara demasiado (factor 2 de
    # margen sobre el objetivo es aceptable).
    if levels < max_levels and current * 4 <= target * 2:
        levels += 1
    return levels


def plan_targets(stats: MeshStats, mesh_class: MeshClass) -> dict[str, int]:
    """Objetivos de triángulos por nivel, adaptados al modelo.

    Los rangos de referencia son los del brief, pero aplicarlos a ciegas da
    resultados absurdos: llevar un arbusto de 800 tris a 3M no lo mejora.
    Se posiciona dentro del rango según la complejidad de la fuente.
    """
    complexity = {
        MeshClass.VERY_LOW: 0.0,
        MeshClass.LOW: 0.2,
        MeshClass.MEDIUM: 0.45,
        MeshClass.HIGH: 0.75,
        MeshClass.VERY_HIGH: 1.0,
    }[mesh_class]

    targets: dict[str, int] = {}
    for level, (lo, hi) in LOD_BUDGETS.items():
        targets[level] = int(lo + (hi - lo) * complexity)

    # Un modelo muy simple no necesita un master de medio millón de tris.
    if mesh_class is MeshClass.VERY_LOW:
        targets["MASTER_HIGH"] = max(60_000, stats.tris * 64)
        targets["LOD0"] = max(8_000, stats.tris * 16)
        targets["LOD1"] = max(3_000, stats.tris * 6)
        targets["LOD2"] = max(1_000, stats.tris * 2)
    elif mesh_class is MeshClass.LOW:
        targets["MASTER_HIGH"] = min(targets["MASTER_HIGH"], max(120_000, stats.tris * 64))

    # Coherencia: cada nivel tiene que ser más liviano que el anterior.
    for i in range(1, len(LOD_ORDER)):
        prev, cur = LOD_ORDER[i - 1], LOD_ORDER[i]
        if targets[cur] >= targets[prev]:
            targets[cur] = max(500, int(targets[prev] * 0.4))

    return targets


def voxel_size_for(stats: MeshStats, target_tris: int) -> float:
    """Tamaño de voxel para el remesh, derivado del tamaño real del objeto.

    Un valor fijo no sirve: el mismo voxel_size que detalla un insecto
    convierte un árbol en una mancha. Se estima desde el área de superficie,
    porque es lo que determina cuántos voxels caben.
    """
    if stats.surface_area <= 1e-9 or target_tris <= 0:
        # Sin área utilizable, caer al tamaño del bounding box.
        return max(stats.max_dimension / 128.0, 1e-4) if stats.max_dimension else 0.01

    # Cada cuadrado de lado voxel_size aporta ~2 triángulos en el remesh.
    size = math.sqrt(2.0 * stats.surface_area / target_tris)
    # Límites de sensatez respecto al objeto: ni más fino que 1/1024 de su
    # dimensión mayor (agota la RAM) ni más grueso que 1/16 (lo derrite).
    if stats.max_dimension > 0:
        size = max(size, stats.max_dimension / 1024.0)
        size = min(size, stats.max_dimension / 16.0)
    return size


def build_plan(stats: MeshStats) -> ProcessingPlan:
    """Punto de entrada: mide el modelo y devuelve el plan razonado."""
    mesh_class = classify_density(stats.tris)
    topology = classify_topology(stats)
    strategy = choose_strategy(stats, mesh_class, topology)
    targets = plan_targets(stats, mesh_class)

    plan = ProcessingPlan(
        strategy=strategy,
        mesh_class=mesh_class,
        topology=topology,
        targets=targets,
        preserve_armature=stats.has_armature,
    )

    plan.needs_repair = topology in (TopologyQuality.POOR, TopologyQuality.BROKEN) or (
        stats.duplicate_verts > 0 or stats.loose_verts > 0 or stats.interior_faces > 0
    )
    plan.needs_normals_fix = stats.flipped_normals > 0
    plan.needs_uv_unwrap = not stats.has_uvs
    plan.needs_scale_apply = stats.is_scaled

    if strategy in (Strategy.SUBDIVIDE, Strategy.MULTIRES):
        plan.subdivision_levels = subdivision_levels_for(stats.tris, targets["MASTER_HIGH"])
        if plan.subdivision_levels == 0:
            plan.strategy = Strategy.DETAIL_ONLY
            plan.notes.append(
                "El modelo ya supera el objetivo del master: subdividir agregaría "
                "peso sin detalle. Se pasa a reconstruir detalle desde texturas."
            )
    elif strategy is Strategy.REMESH_SHRINKWRAP:
        plan.voxel_size = voxel_size_for(stats, targets["MASTER_HIGH"])
        plan.use_shrinkwrap = True
        plan.notes.append(
            "Topología no apta para subdividir: se genera superficie nueva por "
            "voxel remesh y se recupera la silueta con Shrinkwrap contra el original."
        )

    # El displacement solo vale la pena si hay textura de la que sacarlo y
    # UVs donde proyectarlo.
    plan.bake_displacement = stats.textured_materials > 0 and stats.has_uvs

    if stats.has_armature:
        plan.warnings.append(
            "El objeto tiene armature: no se aplican modificadores de forma "
            "destructiva ni se remeshea el original, para no romper el skinning."
        )
        if plan.strategy is Strategy.REMESH_SHRINKWRAP:
            plan.warnings.append(
                "El remesh descarta los vertex groups: habrá que re-pesar o "
                "transferir pesos desde el original."
            )
    if stats.shape_keys:
        plan.warnings.append(
            f"{stats.shape_keys} shape keys detectadas: la mayoría de los "
            "modificadores no se pueden aplicar sin destruirlas."
        )
    if not stats.has_uvs:
        plan.warnings.append("Sin UVs: se generan con Smart UV Project antes de bakear.")
    if stats.is_scaled:
        plan.warnings.append("Escala sin aplicar: se aplica antes de remeshear.")
    if stats.boundary_edges > 0:
        plan.notes.append(
            f"{stats.boundary_edges} bordes abiertos (agujeros o superficies planas "
            "tipo hoja). Se respetan: cerrarlos rompería las alpha cards."
        )

    return plan


def decimate_ratio(current_tris: int, target_tris: int) -> float:
    """Ratio para el modificador Decimate, acotado a un rango sensato."""
    if current_tris <= 0:
        return 1.0
    ratio = target_tris / current_tris
    return max(0.005, min(1.0, ratio))
