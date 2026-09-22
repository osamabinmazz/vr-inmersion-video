"""Estructura de medición de una malla. SIN dependencia de bpy.

Esto es el "expediente" del modelo: todo lo que se pudo medir antes de
tocarlo. Lo llena `analysis.py` (que sí habla con Blender) y lo consumen
`scoring.py`, `classify.py` y `planning.py`, que son lógica pura.

Separarlo así tiene una razón práctica: la parte que DECIDE qué hacerle a
un modelo se puede testear sin abrir Blender, que es donde se cometen los
errores caros (subdividir lo que no hay que subdividir, remeshear un
escaneo bueno, destruir el original).
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any


@dataclass
class MeshStats:
    """Medición completa de un objeto malla.

    Todos los campos tienen default porque el analizador puede no llegar a
    medir todo (una malla rota puede tirar excepción a mitad de camino) y
    es preferible un expediente incompleto a ninguno.
    """

    # --- identidad -------------------------------------------------------
    name: str = ""
    source_file: str = ""

    # --- conteos crudos --------------------------------------------------
    verts: int = 0
    edges: int = 0
    faces: int = 0
    tris: int = 0
    quads: int = 0
    ngons: int = 0

    # --- patologías de topología ----------------------------------------
    loose_verts: int = 0
    loose_edges: int = 0
    non_manifold_edges: int = 0
    non_manifold_verts: int = 0
    interior_faces: int = 0
    boundary_edges: int = 0        # bordes con una sola cara: agujeros o láminas
    flipped_normals: int = 0
    duplicate_verts: int = 0
    degenerate_faces: int = 0      # área ~0: revientan al subdividir
    thin_faces: int = 0            # slivers: relación de aspecto extrema
    self_intersections: int = 0    # -1 = no se pudo medir
    loose_parts: int = 1           # islas desconectadas

    # --- forma y distribución -------------------------------------------
    planar_ratio: float = 0.0      # fracción de área en zonas casi planas
    sharp_edges_ratio: float = 0.0 # fracción de aristas con ángulo > 30°
    curvature_mean: float = 0.0    # curvatura media normalizada
    curvature_std: float = 0.0     # dispersión: uniforme vs. detalle localizado
    edge_length_mean: float = 0.0
    edge_length_std: float = 0.0
    symmetry_x: float = 0.0        # 0-1, simetría bilateral respecto a YZ
    symmetry_y: float = 0.0
    symmetry_z: float = 0.0
    upward_face_ratio: float = 0.0  # área con la normal hacia +Z: delata terreno

    # --- sombreado -------------------------------------------------------
    has_custom_normals: bool = False
    shade_smooth: bool = False
    autosmooth_angle: float = 0.0

    # --- UVs y texturas --------------------------------------------------
    uv_layers: int = 0
    udim_tiles: int = 1
    uv_overlap_ratio: float = 0.0
    uv_area_ratio: float = 0.0     # área UV usada / área UV disponible
    texture_resolution: int = 0    # la mayor encontrada
    has_normal_map: bool = False
    has_roughness_map: bool = False
    has_displacement_map: bool = False
    has_ao_map: bool = False
    vertex_color_layers: int = 0

    # --- materiales ------------------------------------------------------
    materials: int = 0
    textured_materials: int = 0
    uses_nodes: bool = False

    # --- rigging / animación --------------------------------------------
    has_armature: bool = False
    shape_keys: int = 0
    vertex_groups: int = 0

    # --- transformación y tamaño ----------------------------------------
    dimensions: tuple[float, float, float] = (0.0, 0.0, 0.0)
    scale: tuple[float, float, float] = (1.0, 1.0, 1.0)
    volume: float = 0.0
    surface_area: float = 0.0

    # --- pistas del contexto --------------------------------------------
    name_hints: list[str] = field(default_factory=list)
    modifiers: list[str] = field(default_factory=list)

    # ---------------------------------------------------------------- API

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @property
    def quad_ratio(self) -> float:
        """Proporción de quads. Alta = topología pensada para subdividir."""
        return (self.quads / self.faces) if self.faces else 0.0

    @property
    def tri_ratio(self) -> float:
        """Proporción de caras triangulares (no de triángulos totales)."""
        if not self.faces:
            return 0.0
        return max(0.0, (self.faces - self.quads - self.ngons) / self.faces)

    @property
    def ngon_ratio(self) -> float:
        return (self.ngons / self.faces) if self.faces else 0.0

    @property
    def boundary_ratio(self) -> float:
        return (self.boundary_edges / self.edges) if self.edges else 0.0

    @property
    def non_manifold_ratio(self) -> float:
        return (self.non_manifold_edges / self.edges) if self.edges else 0.0

    @property
    def max_dimension(self) -> float:
        return max(self.dimensions) if self.dimensions else 0.0

    @property
    def min_dimension(self) -> float:
        return min(self.dimensions) if self.dimensions else 0.0

    @property
    def density(self) -> float:
        """Triángulos por unidad de área.

        Es la medida honesta de detalle: 100k tris repartidos en un árbol de
        12 m es una caja; los mismos 100k en un pájaro de 30 cm es un
        escaneo. El conteo bruto no dice nada sin el tamaño.
        """
        return (self.tris / self.surface_area) if self.surface_area > 1e-9 else 0.0

    @property
    def has_uvs(self) -> bool:
        return self.uv_layers > 0

    @property
    def is_scaled(self) -> bool:
        """Escala sin aplicar: distorsiona el voxel remesh y todo modificador
        que trabaje en distancias absolutas (Solidify, Bevel, Shrinkwrap)."""
        return any(abs(s - 1.0) > 1e-4 for s in self.scale)

    @property
    def aspect_tall(self) -> float:
        """Cuánto más alto que ancho es (Z sobre la mayor horizontal).

        Blender es Z-up, así que un árbol o una estatua de pie dan valores
        altos y un terreno o un cuadrúpedo dan valores bajos.
        """
        horizontal = max(self.dimensions[0], self.dimensions[1]) if self.dimensions else 0.0
        if horizontal <= 1e-9:
            return 0.0
        return self.dimensions[2] / horizontal

    @property
    def aspect_flat(self) -> float:
        """Cuánto más chato que ancho es. Alto = terreno o lámina."""
        largest = self.max_dimension
        if largest <= 1e-9:
            return 0.0
        return self.dimensions[2] / largest

    @property
    def edge_length_cv(self) -> float:
        """Coeficiente de variación de longitud de arista.

        Bajo = malla regular (retopología manual, remesh). Alto = mezcla de
        zonas densas y vacías, típico de escaneos y de modelos hechos a mano
        sin cuidado.
        """
        if self.edge_length_mean <= 1e-9:
            return 0.0
        return self.edge_length_std / self.edge_length_mean

    @property
    def best_symmetry(self) -> float:
        return max(self.symmetry_x, self.symmetry_y, self.symmetry_z)

    @property
    def is_watertight(self) -> bool:
        return self.boundary_edges == 0 and self.non_manifold_edges == 0 and self.faces > 0
