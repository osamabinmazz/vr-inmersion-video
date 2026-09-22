"""Orquestador: corre las 26 etapas de punta a punta.

Cada etapa se ejecuta aislada. Si una falla, se registra el error y el
proceso SIGUE: es preferible entregar un modelo con el horneado incompleto
y el problema anotado, que perder veinte minutos de reconstrucción porque
una textura no tenía UVs. Las etapas que el plan marcó como saltadas se
anotan con su motivo en vez de ejecutarse a medias.

El original nunca se toca: todo pasa sobre copias en las colecciones
01_CLEAN en adelante.
"""

from __future__ import annotations

import os
import traceback

import bpy

from . import analysis, baking, cleanup, export, lod, quality_control
from . import reconstruction, retopology, sculpt_detail, super_resolution
from .core.classify import classify_model
from .core.planning import (
    HardwareProfile,
    ReconstructionMethod,
    Stage,
    build_reconstruction_plan,
)
from .core.presets import preset_for_classification
from .core.scoring import build_scorecard
from .logging_utils import StageLog, build_report, save_checkpoint, write_report


def detect_hardware() -> HardwareProfile:
    """Lee lo que se pueda del sistema. Lo que no, se asume conservador.

    Subestimar la RAM hace que el add-on recorte un objetivo que la máquina
    habría aguantado; sobrestimarla la cuelga. Se elige el error barato.
    """
    ram_gb = 8.0
    cores = 4
    try:
        cores = os.cpu_count() or 4
    except Exception:
        pass
    try:
        pages = os.sysconf("SC_PHYS_PAGES")
        page_size = os.sysconf("SC_PAGE_SIZE")
        ram_gb = (pages * page_size) / (1024 ** 3)
    except (ValueError, OSError, AttributeError):
        try:
            import psutil  # no viene con Blender; si está, mejor
            ram_gb = psutil.virtual_memory().total / (1024 ** 3)
        except Exception:
            pass

    vram = 0.0
    has_gpu = False
    try:
        prefs = bpy.context.preferences.addons.get("cycles")
        if prefs and prefs.preferences.compute_device_type not in ("NONE", ""):
            has_gpu = True
    except Exception:
        pass
    return HardwareProfile(ram_gb=ram_gb, cpu_cores=cores, gpu_vram_gb=vram, has_gpu=has_gpu)


class UltraRun:
    """Estado de una corrida. Se pasa entre etapas."""

    def __init__(self, obj, settings):
        self.original = obj
        self.settings = settings
        self.log = StageLog(obj.name)
        self.collections = {}
        self.source = None
        self.working = None
        self.master = None
        self.retopo = None
        self.lods: dict = {}
        self.images: dict = {}
        self.exports: list[str] = []
        self.stats_before = None
        self.stats_after = None
        self.score_before = None
        self.score_after = None
        self.classification = None
        self.preset = None
        self.plan = None
        self.fidelity = None
        self.report_path = ""


def _run_stage(run: UltraRun, stage: Stage, fn) -> None:
    """Ejecuta una etapa con su bitácora, respetando lo que el plan saltó."""
    plan = run.plan
    if plan is not None and stage.value in plan.skipped_stages:
        run.log.begin(stage.value)
        run.log.add(f"SALTADA: {plan.skipped_stages[stage.value]}")
        run.log.end()
        return

    run.log.begin(stage.value)
    try:
        result = fn()
        if result:
            run.log.add(result)
    except Exception as exc:  # una etapa rota no debe matar la corrida
        run.log.fail(stage.value, exc)
        run.log.add(traceback.format_exc(limit=3).strip().splitlines()[-1:])
    finally:
        run.log.end()

    if plan is not None and stage.value in plan.checkpoints and run.settings.auto_checkpoint:
        run.log.begin(f"{stage.value}__checkpoint")
        run.log.add(save_checkpoint(run.log, stage.value, run.settings.output_dir))
        run.log.end()


def run_ultra_enhance(obj: bpy.types.Object, settings) -> UltraRun:
    """Las 26 etapas, en orden. Punto de entrada del botón ULTRA ENHANCE."""
    run = UltraRun(obj, settings)
    hardware = detect_hardware()

    # --- 01 inspección --------------------------------------------------
    def inspect():
        run.stats_before = analysis.analyze_object(obj, deep=settings.deep_analysis)
        s = run.stats_before
        return [
            f"{s.verts:,} vértices, {s.faces:,} caras, {s.tris:,} triángulos.",
            f"Densidad {s.density:,.1f} tris/u² sobre {s.surface_area:.3f} u² de superficie.",
            f"Problemas: {s.non_manifold_edges} non-manifold, {s.ngons} n-gons, "
            f"{s.duplicate_verts} duplicados, {s.interior_faces} caras interiores.",
            f"{s.loose_parts} islas, {s.boundary_edges} aristas de borde.",
            f"UVs: {s.uv_layers} capa(s), {s.udim_tiles} tile(s), "
            f"solapamiento estimado {s.uv_overlap_ratio * 100:.1f}%.",
        ]
    _run_stage(run, Stage.INSPECT, inspect)

    if run.stats_before is None:
        run.log.add("Sin medición inicial no se puede continuar.")
        return run

    # --- 02 clasificación ------------------------------------------------
    def classify():
        run.classification = classify_model(run.stats_before)
        run.preset = preset_for_classification(run.classification, settings.preset_override)
        lines = [run.classification.describe()]
        lines.extend(f"· {e}" for e in run.classification.evidence)
        lines.append(f"Preset: {run.preset.key} — {run.preset.description}")
        return lines
    _run_stage(run, Stage.CLASSIFY, classify)

    if run.preset is None:
        from .core.presets import get_preset
        run.preset = get_preset("OBJECT")
        run.classification = classify_model(run.stats_before)

    # --- 03 puntaje inicial ----------------------------------------------
    def score_before():
        run.score_before = build_scorecard(run.stats_before)
        c = run.score_before
        lines = [f"Global {c.overall:.1f}/100."]
        lines += [f"  {a}: {getattr(c, a):.1f}" for a in c.AXES]
        lines += [f"  [!] {i}" for i in c.issues[:10]]
        return lines
    _run_stage(run, Stage.SCORE_BEFORE, score_before)

    # El plan se calcula acá aunque la etapa 11 sea la que lo informa: las
    # etapas de limpieza necesitan saber qué está permitido antes de tocar
    # nada (en follaje, por ejemplo, cerrar agujeros está prohibido).
    curvature = []
    try:
        curvature = analysis.curvature_fractions(obj, bands=3)
    except Exception:
        pass
    run.plan = build_reconstruction_plan(
        run.stats_before, run.classification, run.preset, hardware,
        curvature_fractions=curvature, extreme_quality=settings.extreme_quality,
    )

    # --- 04 respaldo ------------------------------------------------------
    def backup():
        run.collections = cleanup.ensure_collections()
        run.source = cleanup.backup_source(obj, run.collections)
        run.working = cleanup.make_working_copy(run.source, run.collections)
        return [
            f"Original respaldado en 00_SOURCE como '{run.source.name}', "
            "oculto y bloqueado contra selección.",
            f"Copia de trabajo: '{run.working.name}' en 01_CLEAN.",
            "A partir de acá no se toca el original bajo ninguna circunstancia.",
        ]
    _run_stage(run, Stage.BACKUP, backup)

    if run.working is None:
        run.log.add("No se pudo crear la copia de trabajo: se aborta para no tocar el original.")
        return run

    # --- 05 limpieza ------------------------------------------------------
    _run_stage(run, Stage.CLEANUP, lambda: cleanup.repair_mesh(run.working, run.plan))

    # --- 06 normales ------------------------------------------------------
    def normals():
        notes = [cleanup.shade_smooth_by_angle(run.working, run.preset.smooth_angle_deg)]
        notes.append(cleanup.add_weighted_normals(run.working))
        return notes
    _run_stage(run, Stage.NORMALS, normals)

    # --- 07 transformaciones ----------------------------------------------
    _run_stage(run, Stage.TRANSFORM, lambda: cleanup.apply_transforms(run.working))

    # --- 08 agujeros -------------------------------------------------------
    _run_stage(run, Stage.HOLES, lambda: cleanup.fill_holes(run.working))

    # --- 09 auditoría UV ---------------------------------------------------
    def uv_audit():
        s = run.stats_before
        if not s.has_uvs:
            return "Sin UVs: hay que generarlas antes de poder hornear."
        return [
            f"{s.uv_layers} capa(s) UV, {s.udim_tiles} tile(s) UDIM.",
            f"Solapamiento estimado: {s.uv_overlap_ratio * 100:.1f}% "
            "(medición por muestreo, no exacta).",
        ]
    _run_stage(run, Stage.UV_AUDIT, uv_audit)

    # --- 10 generación UV --------------------------------------------------
    _run_stage(run, Stage.UV_BUILD, lambda: cleanup.ensure_uvs(run.working))

    # --- 11 estrategia -----------------------------------------------------
    def strategy():
        p = run.plan
        lines = [
            f"Método elegido: {p.method.value}",
            f"Objetivo del master: {p.master_target_tris:,} triángulos "
            f"(RAM detectada: {hardware.ram_gb:.1f} GB, {hardware.cpu_cores} núcleos).",
        ]
        if p.subdivision and p.subdivision.bands:
            for b in p.subdivision.bands:
                lines.append(f"  banda '{b.name}': nivel {b.levels} — {b.reason}")
        lines.extend(f"  · {n}" for n in p.notes)
        lines.extend(f"  [!] {w}" for w in p.warnings)
        return lines
    _run_stage(run, Stage.STRATEGY, strategy)

    # --- 12 reconstrucción --------------------------------------------------
    _run_stage(
        run, Stage.RECONSTRUCT,
        lambda: reconstruction.reconstruct(run.working, run.source, run.plan),
    )

    # --- 13 super-resolución -------------------------------------------------
    _run_stage(
        run, Stage.SUPER_RESOLUTION,
        lambda: super_resolution.super_resolve(run.working, run.source, run.plan, run.preset),
    )

    # --- 14 reproyección -----------------------------------------------------
    _run_stage(
        run, Stage.SHRINKWRAP,
        lambda: reconstruction.reproject_to_source(run.working, run.source),
    )

    # --- 15 microrelieve -----------------------------------------------------
    _run_stage(
        run, Stage.SCULPT_DETAIL,
        lambda: sculpt_detail.apply_evidence_based_detail(
            run.working, run.preset, analysis.bbox_diagonal(run.working)
        ),
    )

    # --- 16 master ultra ------------------------------------------------------
    def master():
        run.master = cleanup.make_working_copy(
            run.working, run.collections, suffix="MASTER_ULTRA", target="03_MASTER_ULTRA"
        )
        run.master["ultra3d_original_name"] = obj.name
        tris = sum(max(0, len(p.vertices) - 2) for p in run.master.data.polygons)
        return f"MASTER_ULTRA creado con {tris:,} triángulos."
    _run_stage(run, Stage.MASTER_ULTRA, master)

    target_for_quality = run.master or run.working

    # --- 17 control de desviación ----------------------------------------------
    def deviation_check():
        report, notes = quality_control.full_quality_check(
            run.source, target_for_quality, run.preset,
            samples=settings.deviation_samples, with_silhouette=False,
        )
        run.fidelity = report
        return notes + [f"Veredicto intermedio: {report.verdict.value}"] + \
            [f"  [!] {p}" for p in report.problems]
    _run_stage(run, Stage.DEVIATION_CHECK, deviation_check)

    # --- 18 retopología ----------------------------------------------------------
    def retopo():
        run.retopo = cleanup.make_working_copy(
            target_for_quality, run.collections, suffix="RETOPO", target="04_RETOPO"
        )
        run.retopo["ultra3d_original_name"] = obj.name
        notes = retopology.retopologize(run.retopo, run.source, run.plan, run.preset)
        notes.extend(retopology.transfer_surface_data(run.retopo, target_for_quality))
        return notes
    _run_stage(run, Stage.RETOPOLOGY, retopo)

    bake_low_source = run.retopo or target_for_quality

    # --- 19 UVs definitivas --------------------------------------------------------
    _run_stage(run, Stage.UV_MASTER, lambda: cleanup.ensure_uvs(bake_low_source))

    # --- 20 horneado ------------------------------------------------------------------
    def bake():
        images, notes = baking.bake_all(
            bake_low_source, target_for_quality, run.plan,
            analysis.bbox_diagonal(target_for_quality), use_gpu=settings.use_gpu,
        )
        run.images = images
        return notes
    _run_stage(run, Stage.BAKE, bake)

    # --- 21 LODs --------------------------------------------------------------------
    def build_lods():
        lods, notes = lod.build_all_lods(
            bake_low_source, run.plan, run.preset, run.collections["05_LODS"]
        )
        run.lods = lods
        notes.extend(lod.apply_baked_material(lods, run.images))
        return notes
    _run_stage(run, Stage.LOD_BUILD, build_lods)

    # --- 22 control de silueta ---------------------------------------------------------
    def silhouette_check():
        candidate = run.lods.get("LOD0") or bake_low_source
        report, notes = quality_control.full_quality_check(
            run.source, candidate, run.preset,
            samples=settings.deviation_samples, with_silhouette=True,
        )
        run.fidelity = report
        notes.append(
            f"Veredicto de fidelidad: {report.verdict.value} — "
            f"{'APROBADO' if report.passed else 'NO APROBADO'}"
        )
        notes.extend(f"  [!] {p}" for p in report.problems)
        notes.extend(f"  → {r}" for r in report.recommendations)
        return notes
    _run_stage(run, Stage.SILHOUETTE_CHECK, silhouette_check)

    # --- 23 puntaje final ----------------------------------------------------------------
    def score_after():
        final = run.lods.get("LOD0") or bake_low_source
        run.stats_after = analysis.analyze_object(final, deep=False)
        run.score_after = build_scorecard(run.stats_after)
        before, after = run.score_before, run.score_after
        if before is None:
            return f"Global final: {after.overall:.1f}/100."
        lines = [f"Global {before.overall:.1f} → {after.overall:.1f} "
                 f"({after.overall - before.overall:+.1f})."]
        for axis in after.AXES:
            a, b = getattr(before, axis), getattr(after, axis)
            lines.append(f"  {axis}: {a:.1f} → {b:.1f} ({b - a:+.1f})")
        return lines
    _run_stage(run, Stage.SCORE_AFTER, score_after)

    # --- 24 escena comparadora --------------------------------------------------------------
    def comparator():
        versions = {"SOURCE": run.source}
        if run.master:
            versions["MASTER_ULTRA"] = run.master
        if run.retopo:
            versions["RETOPO"] = run.retopo
        versions.update(run.lods)
        return quality_control.build_comparator(versions, run.collections["07_COMPARISON"])
    _run_stage(run, Stage.COMPARATOR, comparator)

    # --- 25 exportación ------------------------------------------------------------------------
    def do_export():
        if not settings.do_export:
            return "Exportación desactivada en el panel."
        directory = settings.output_dir or (
            os.path.join(os.path.dirname(bpy.data.filepath), "ultra3d_export")
            if bpy.data.filepath else ""
        )
        formats = [f for f, on in (
            ("GLB", settings.export_glb),
            ("FBX", settings.export_fbx),
            ("OBJ", settings.export_obj),
        ) if on]
        if not formats:
            return "No se marcó ningún formato de exportación."
        paths, notes = export.export_all(
            run.lods, run.images, directory, formats,
            include_master=run.master if settings.export_master else None,
        )
        run.exports = paths
        return notes
    _run_stage(run, Stage.EXPORT, do_export)

    # --- 26 informe -------------------------------------------------------------------------------
    def report():
        if run.score_after is None:
            run.score_after = run.score_before
            run.stats_after = run.stats_before
        text = build_report(
            obj.name, run.stats_before, run.stats_after,
            run.score_before, run.score_after,
            run.classification, run.preset, run.plan, run.fidelity,
            run.log, run.exports,
        )
        path, _ = write_report(text, obj.name, settings.output_dir)
        run.report_path = path
        return (
            f"Informe escrito en {path}" if path
            else "Informe disponible en el editor de textos del .blend "
                 "(el archivo no se guardó nunca, así que no hay dónde escribirlo en disco)."
        )
    _run_stage(run, Stage.REPORT, report)

    run.log.console()
    return run
