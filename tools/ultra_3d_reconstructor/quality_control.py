"""Control de calidad: silueta multi-vista, fidelidad y escena comparadora.

Por qué la silueta se mide aparte de la distancia: la desviación geométrica
puede dar excelente y el modelo verse mal igual. Un cuerno que se redondeó
apenas mueve poquísimos milímetros —la distancia ni lo registra— pero
cambia el perfil, y el perfil es lo que el ojo lee primero a distancia, que
es justo donde viven los LODs.

Se renderiza el contorno desde ocho ángulos con el motor Workbench (rápido
y determinista, no depende de luces ni materiales) y se comparan las
máscaras píxel a píxel. Manda la PEOR vista, nunca el promedio.
"""

from __future__ import annotations

import os
import tempfile

import bpy
from mathutils import Vector

from . import analysis
from .cleanup import duplicate_object, move_to_collection
from .core.deviation import (
    bidirectional_deviation,
    build_fidelity_report,
    combine_silhouettes,
    silhouette_error,
    volume_error,
)

# Ocho direcciones: las seis ortogonales más dos diagonales. Las diagonales
# importan porque muchos errores de remesh solo se ven de tres cuartos.
VIEWS: dict[str, tuple[float, float, float]] = {
    "frente": (0.0, -1.0, 0.0),
    "atras": (0.0, 1.0, 0.0),
    "izquierda": (-1.0, 0.0, 0.0),
    "derecha": (1.0, 0.0, 0.0),
    "arriba": (0.0, 0.0, 1.0),
    "abajo": (0.0, 0.0, -1.0),
    "tres_cuartos_alto": (0.7, -0.7, 0.55),
    "tres_cuartos_bajo": (-0.7, -0.7, -0.35),
}

MASK_RESOLUTION = 320


def _object_center_and_size(obj: bpy.types.Object) -> tuple[Vector, float]:
    corners = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
    lo = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
    hi = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
    return (lo + hi) * 0.5, max((hi - lo).length, 1e-6)


class _SilhouetteRig:
    """Escena temporal con cámara ortográfica y fondo transparente.

    Se usa Workbench y no Cycles/EEVEE a propósito: la máscara no depende de
    luces, materiales ni ruido de muestreo, así que dos corridas dan
    exactamente el mismo contorno y la comparación es fiable.
    """

    def __init__(self, resolution: int = MASK_RESOLUTION):
        self.resolution = resolution
        self.scene = bpy.data.scenes.new("ULTRA_SilhouetteQC")
        self.scene.render.engine = "BLENDER_WORKBENCH"
        self.scene.render.resolution_x = resolution
        self.scene.render.resolution_y = resolution
        self.scene.render.resolution_percentage = 100
        self.scene.render.film_transparent = True
        self.scene.render.image_settings.file_format = "PNG"
        self.scene.render.image_settings.color_mode = "RGBA"
        shading = self.scene.display.shading
        shading.light = "FLAT"
        shading.color_type = "SINGLE"
        shading.single_color = (1.0, 1.0, 1.0)
        shading.show_shadows = False
        shading.show_cavity = False

        cam_data = bpy.data.cameras.new("ULTRA_QC_Cam")
        cam_data.type = "ORTHO"
        self.camera = bpy.data.objects.new("ULTRA_QC_Cam", cam_data)
        self.scene.collection.objects.link(self.camera)
        self.scene.camera = self.camera
        self.tmpdir = tempfile.mkdtemp(prefix="ultra3d_qc_")

    def close(self) -> None:
        cam_data = self.camera.data
        try:
            bpy.data.objects.remove(self.camera, do_unlink=True)
            bpy.data.cameras.remove(cam_data)
            bpy.data.scenes.remove(self.scene)
        except Exception:
            pass
        for f in os.listdir(self.tmpdir) if os.path.isdir(self.tmpdir) else []:
            try:
                os.remove(os.path.join(self.tmpdir, f))
            except OSError:
                pass
        try:
            os.rmdir(self.tmpdir)
        except OSError:
            pass

    def render_mask(self, obj: bpy.types.Object, view: str, direction, center, size) -> list[bool]:
        """Devuelve la máscara de cobertura de UNA vista."""
        d = Vector(direction).normalized()
        self.camera.location = center + d * (size * 2.0)
        self.camera.rotation_euler = d.to_track_quat("Z", "Y").to_euler()
        self.camera.data.ortho_scale = size * 1.15
        self.camera.data.clip_start = size * 0.05
        self.camera.data.clip_end = size * 6.0

        linked = obj.name in self.scene.collection.objects
        if not linked:
            self.scene.collection.objects.link(obj)
        path = os.path.join(self.tmpdir, f"{obj.name}_{view}.png")
        self.scene.render.filepath = path
        try:
            bpy.ops.render.render(write_still=True, scene=self.scene.name)
        finally:
            if not linked and obj.name in self.scene.collection.objects:
                self.scene.collection.objects.unlink(obj)

        img = bpy.data.images.load(path)
        try:
            pixels = list(img.pixels)
            # El canal alfa es la cobertura: no depende del color ni la luz.
            return [pixels[i * 4 + 3] > 0.5 for i in range(len(pixels) // 4)]
        finally:
            bpy.data.images.remove(img)


def compare_silhouettes(
    reference: bpy.types.Object,
    candidate: bpy.types.Object,
    resolution: int = MASK_RESOLUTION,
):
    """Compara los contornos de dos objetos desde las ocho vistas.

    Ambos se encuadran con la MISMA cámara para cada vista (centro y escala
    tomados de la referencia): si cada uno se encuadrara por su cuenta, un
    modelo inflado se vería idéntico al original.
    """
    rig = _SilhouetteRig(resolution)
    per_view: dict[str, float] = {}
    try:
        center, size = _object_center_and_size(reference)
        was_ref_hidden = reference.hide_render
        was_cand_hidden = candidate.hide_render
        reference.hide_render = False
        candidate.hide_render = False
        try:
            for view, direction in VIEWS.items():
                try:
                    mask_ref = rig.render_mask(reference, view, direction, center, size)
                    mask_cand = rig.render_mask(candidate, view, direction, center, size)
                except Exception:
                    continue
                if len(mask_ref) != len(mask_cand):
                    continue
                matched = sum(1 for a, b in zip(mask_ref, mask_cand) if a and b)
                per_view[view] = silhouette_error(matched, sum(mask_ref), sum(mask_cand))
        finally:
            reference.hide_render = was_ref_hidden
            candidate.hide_render = was_cand_hidden
    finally:
        rig.close()

    return combine_silhouettes(per_view)


def full_quality_check(
    source: bpy.types.Object,
    candidate: bpy.types.Object,
    preset,
    samples: int = 20_000,
    with_silhouette: bool = True,
):
    """Las tres mediciones juntas: distancia, silueta y volumen.

    Devuelve (informe, notas). El informe NO se redondea hacia arriba: si
    una medición no se pudo hacer, queda como no medida y el veredicto lo
    refleja, en vez de aprobar por defecto.
    """
    notes: list[str] = []
    hausdorff = None
    try:
        fwd, bwd, diag = analysis.measure_deviation(source, candidate, samples=samples)
        hausdorff = bidirectional_deviation(fwd, bwd, diag)
        notes.append(
            f"Desviación medida con {len(fwd):,} + {len(bwd):,} muestras "
            f"(diagonal {diag:.4f})."
        )
    except Exception as exc:
        notes.append(f"No se pudo medir la desviación geométrica: {exc}")

    silhouette = None
    if with_silhouette:
        try:
            silhouette = compare_silhouettes(source, candidate)
            if silhouette.views:
                notes.append(
                    f"Silueta comparada en {silhouette.views} vistas; la peor es "
                    f"'{silhouette.worst_view}' con {silhouette.worst_error * 100:.2f}% "
                    "de píxeles discordantes."
                )
            else:
                notes.append("No se pudo renderizar ninguna vista para comparar silueta.")
        except Exception as exc:
            notes.append(f"La comparación de silueta falló: {exc}")

    vol_err = -1.0
    try:
        stats_src = analysis.analyze_object(source, deep=False)
        stats_cand = analysis.analyze_object(candidate, deep=False)
        if stats_src.boundary_edges == 0 and stats_cand.boundary_edges == 0:
            vol_err = volume_error(stats_src.volume, stats_cand.volume)
        else:
            notes.append(
                "Volumen no comparado: alguna de las mallas está abierta y el volumen "
                "firmado no significa nada ahí."
            )
    except Exception as exc:
        notes.append(f"No se pudo comparar el volumen: {exc}")

    report = build_fidelity_report(hausdorff, silhouette, vol_err, preset)
    return report, notes


# ------------------------------------------------------ escena comparadora


def build_comparator(
    versions: dict[str, bpy.types.Object],
    collection: bpy.types.Collection,
    gap_factor: float = 1.4,
) -> list[str]:
    """Alinea copias de todas las versiones para mirarlas de una sola vez.

    Es la etapa que convierte el informe en algo verificable a ojo: los
    números dicen que la desviación es 0.002, pero ver el original y el
    LOD3 uno al lado del otro es lo que confirma que el trabajo sirve.
    """
    if not versions:
        return ["No hay versiones que comparar."]

    notes: list[str] = []
    order = [k for k in ("SOURCE", "MASTER_ULTRA", "RETOPO", "LOD0", "LOD1", "LOD2", "LOD3")
             if k in versions]
    order += [k for k in versions if k not in order]

    reference = versions[order[0]]
    _, size = _object_center_and_size(reference)
    step = size * gap_factor

    for i, key in enumerate(order):
        obj = versions[key]
        was_hidden = obj.hide_select
        obj.hide_select = False
        try:
            copy = duplicate_object(obj, f"CMP_{key}")
        finally:
            obj.hide_select = was_hidden
        copy.hide_viewport = False
        copy.hide_render = False
        copy.hide_select = False
        copy.location = Vector(obj.location) + Vector((step * i, 0.0, 0.0))
        copy["ultra3d_role"] = "comparison"
        copy["ultra3d_version"] = key
        move_to_collection(copy, collection)
        notes.append(f"{key} ubicado en x={copy.location.x:.2f}.")

    notes.append(
        f"Escena comparadora con {len(order)} versiones alineadas cada {step:.2f} unidades. "
        "Son copias: tocar cualquiera de ellas no afecta a las originales."
    )
    return notes
