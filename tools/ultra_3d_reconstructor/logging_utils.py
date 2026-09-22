"""Bitácora del proceso, checkpoints automáticos e informe final.

Un pipeline de 26 etapas que corre veinte minutos y no deja rastro es
inservible cuando algo sale mal: no se sabe en qué etapa se torció ni con
qué parámetros. Acá se registra cada etapa con su duración y su parte, se
guarda el archivo en los puntos caros de rehacer, y al final se escribe el
MODEL_REPORT.txt con los puntajes ANTES → DESPUÉS.
"""

from __future__ import annotations

import datetime
import os
import time

import bpy

from .core.scoring import ScoreCard


class StageLog:
    """Registro de una corrida completa."""

    def __init__(self, model_name: str):
        self.model_name = model_name
        self.started = time.time()
        self.entries: list[dict] = []
        self.checkpoints: list[str] = []
        self.errors: list[str] = []
        self._current: dict | None = None

    def begin(self, stage: str) -> None:
        self._current = {"stage": stage, "start": time.time(), "lines": [], "seconds": 0.0}

    def add(self, lines) -> None:
        if self._current is None:
            self.begin("sin_etapa")
        if isinstance(lines, str):
            lines = [lines]
        self._current["lines"].extend(l for l in lines if l)

    def fail(self, stage: str, exc: Exception) -> None:
        msg = f"[{stage}] {type(exc).__name__}: {exc}"
        self.errors.append(msg)
        self.add(msg)

    def end(self) -> None:
        if self._current is None:
            return
        self._current["seconds"] = time.time() - self._current["start"]
        self.entries.append(self._current)
        self._current = None

    @property
    def total_seconds(self) -> float:
        return time.time() - self.started

    def console(self) -> None:
        """Vuelca la bitácora a la consola del sistema, que es donde queda
        cuando Blender se cierra sin guardar."""
        print(f"\n=== ULTRA 3D RECONSTRUCTOR — {self.model_name} ===")
        for e in self.entries:
            print(f"[{e['stage']}] ({e['seconds']:.1f}s)")
            for line in e["lines"]:
                print(f"    {line}")


def save_checkpoint(log: StageLog, stage: str, directory: str = "") -> str:
    """Guarda una copia del archivo después de una etapa cara.

    Se guarda con `copy=True`: el archivo que el usuario tiene abierto sigue
    siendo el suyo, así que un checkpoint nunca le cambia la ruta ni le pisa
    el trabajo.
    """
    base = bpy.data.filepath
    if not base and not directory:
        return "Sin checkpoint: el archivo no se guardó nunca, no hay dónde escribir."

    target_dir = directory or os.path.join(os.path.dirname(base), "ultra3d_checkpoints")
    try:
        os.makedirs(target_dir, exist_ok=True)
    except OSError as exc:
        return f"No se pudo crear la carpeta de checkpoints: {exc}"

    name = os.path.splitext(os.path.basename(base or "sin_nombre.blend"))[0]
    path = os.path.join(target_dir, f"{name}__{stage}.blend")
    try:
        bpy.ops.wm.save_as_mainfile(filepath=path, copy=True, compress=True)
    except RuntimeError as exc:
        return f"No se pudo guardar el checkpoint de {stage}: {exc}"

    log.checkpoints.append(path)
    return f"Checkpoint guardado: {os.path.basename(path)}"


# ------------------------------------------------------------- informe


def _bar(value: float, width: int = 24) -> str:
    filled = int(round((value / 100.0) * width))
    return "█" * filled + "·" * (width - filled)


def _score_table(before: ScoreCard, after: ScoreCard) -> list[str]:
    labels = {
        "topology": "Topología",
        "geometry": "Geometría",
        "surface": "Superficie",
        "texture": "Texturas",
        "material": "Materiales",
        "silhouette": "Silueta",
        "vr_readiness": "Listo para VR",
    }
    lines = [
        f"{'EJE':<16}{'ANTES':>7}{'DESPUÉS':>9}{'Δ':>8}   PERFIL FINAL",
        "-" * 74,
    ]
    for axis in ScoreCard.AXES:
        a, b = getattr(before, axis), getattr(after, axis)
        lines.append(
            f"{labels[axis]:<16}{a:>7.1f}{b:>9.1f}{b - a:>+8.1f}   {_bar(b)}"
        )
    lines.append("-" * 74)
    lines.append(
        f"{'GLOBAL':<16}{before.overall:>7.1f}{after.overall:>9.1f}"
        f"{after.overall - before.overall:>+8.1f}   {_bar(after.overall)}"
    )
    return lines


def build_report(
    model_name: str,
    stats_before,
    stats_after,
    score_before: ScoreCard,
    score_after: ScoreCard,
    classification,
    preset,
    plan,
    fidelity,
    log: StageLog,
    exports: list[str] | None = None,
) -> str:
    """Arma el MODEL_REPORT.txt completo."""
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    L: list[str] = []
    add = L.append

    add("=" * 74)
    add("ULTRA 3D RECONSTRUCTOR — INFORME DE MODELO")
    add("=" * 74)
    add(f"Modelo:  {model_name}")
    add(f"Fecha:   {now}")
    add(f"Blender: {'.'.join(str(v) for v in bpy.app.version)}")
    add(f"Duración total: {log.total_seconds / 60.0:.1f} minutos")
    add("")

    add("1. QUÉ ES ESTE MODELO")
    add("-" * 74)
    add(f"Clasificación: {classification.describe()}")
    for ev in classification.evidence:
        add(f"  · {ev}")
    if classification.photogrammetry_likelihood >= 0.5:
        add(f"  · Probabilidad de escaneo: {classification.photogrammetry_likelihood * 100:.0f}%")
    add(f"Preset aplicado: {preset.key} — {preset.label_es}")
    add(f"  {preset.description}")
    add("")

    add("2. PUNTAJES DE CALIDAD (0-100)")
    add("-" * 74)
    L.extend(_score_table(score_before, score_after))
    add("")

    add("3. GEOMETRÍA")
    add("-" * 74)
    add(f"{'':<22}{'ANTES':>14}{'DESPUÉS':>14}")
    rows = [
        ("Vértices", stats_before.verts, stats_after.verts),
        ("Caras", stats_before.faces, stats_after.faces),
        ("Triángulos", stats_before.tris, stats_after.tris),
        ("Quads", stats_before.quads, stats_after.quads),
        ("N-gons", stats_before.ngons, stats_after.ngons),
        ("Non-manifold", stats_before.non_manifold_edges, stats_after.non_manifold_edges),
        ("Caras interiores", stats_before.interior_faces, stats_after.interior_faces),
        ("Vért. duplicados", stats_before.duplicate_verts, stats_after.duplicate_verts),
    ]
    for label, a, b in rows:
        add(f"{label:<22}{a:>14,}{b:>14,}")
    add(f"{'Densidad (tris/u²)':<22}{stats_before.density:>14,.1f}{stats_after.density:>14,.1f}")
    add("")

    add("4. CÓMO SE RECONSTRUYÓ")
    add("-" * 74)
    add(f"Método: {plan.method.value}")
    if plan.subdivision and plan.subdivision.bands:
        add("Reparto de subdivisión por curvatura:")
        for band in plan.subdivision.bands:
            add(f"  · {band.name:<14} nivel {band.levels}  — {band.reason}")
        if plan.subdivision.uniform_tris:
            add(
                f"  Adaptativa: {plan.subdivision.expected_tris:,} triángulos. "
                f"Uniforme habría usado {plan.subdivision.uniform_tris:,} "
                f"({plan.subdivision.savings_ratio * 100:.0f}% más) para el mismo detalle visible."
            )
    if plan.voxel_size:
        add(f"Tamaño de voxel: {plan.voxel_size:.5f}")
    if plan.retopo_target_faces:
        add(f"Objetivo de retopología: {plan.retopo_target_faces:,} caras")
    for note in plan.notes:
        add(f"  · {note}")
    add("")

    add("5. FIDELIDAD AL ORIGINAL")
    add("-" * 74)
    if fidelity is None:
        add("No se ejecutó el control de fidelidad.")
    else:
        add(f"Veredicto: {fidelity.verdict.value.upper()} — "
            f"{'APROBADO' if fidelity.passed else 'NO APROBADO'}")
        if fidelity.hausdorff:
            h = fidelity.hausdorff
            add(f"Desviación p99 (normalizada por la diagonal): {h.symmetric_p99:.5f}")
            add(f"  ida  (original → resultado): media {h.forward.mean:.5f}, máx {h.forward.maximum:.5f}")
            add(f"  vuelta (resultado → original): media {h.backward.mean:.5f}, máx {h.backward.maximum:.5f}")
            add(f"  muestras: {h.forward.samples:,} / {h.backward.samples:,}")
        if fidelity.silhouette and fidelity.silhouette.views:
            s = fidelity.silhouette
            add(f"Silueta: peor vista '{s.worst_view}' con {s.worst_error * 100:.2f}% de error")
            for view, err in sorted(s.per_view.items(), key=lambda kv: -kv[1]):
                add(f"  {view:<20} {err * 100:>6.2f}%")
        if fidelity.volume_error >= 0:
            add(f"Volumen: {fidelity.volume_error * 100:.2f}% de diferencia")
        for p in fidelity.problems:
            add(f"  [!] {p}")
        for r in fidelity.recommendations:
            add(f"  → {r}")
    add("")

    add("6. NIVELES DE DETALLE")
    add("-" * 74)
    if plan.lod_targets:
        for name, target in plan.lod_targets.items():
            add(f"{name:<8} objetivo {target:>10,} triángulos")
    add("")

    add("7. AVISOS Y LÍMITES TÉCNICOS")
    add("-" * 74)
    if plan.warnings:
        for w in plan.warnings:
            add(f"  [!] {w}")
    for lim in plan.limitations:
        add(f"  [i] {lim}")
    if log.errors:
        add("")
        add("Errores durante el proceso:")
        for e in log.errors:
            add(f"  [X] {e}")
    add("")

    add("8. BITÁCORA POR ETAPA")
    add("-" * 74)
    for entry in log.entries:
        add(f"[{entry['stage']}] ({entry['seconds']:.1f}s)")
        for line in entry["lines"]:
            add(f"    {line}")
    add("")

    if log.checkpoints:
        add("9. CHECKPOINTS GUARDADOS")
        add("-" * 74)
        for path in log.checkpoints:
            add(f"  {path}")
        add("")

    if exports:
        add("10. ARCHIVOS EXPORTADOS")
        add("-" * 74)
        for path in exports:
            add(f"  {path}")
        add("")

    add("=" * 74)
    return "\n".join(L)


def write_report(text: str, model_name: str, directory: str = "") -> tuple[str, bpy.types.Text]:
    """Escribe el informe a disco y lo deja también dentro del .blend.

    Lo segundo importa: si alguien manda el .blend sin la carpeta, el
    informe viaja con él.
    """
    name = f"MODEL_REPORT_{model_name}.txt"
    text_block = bpy.data.texts.get(name)
    if text_block is None:
        text_block = bpy.data.texts.new(name)
    text_block.clear()
    text_block.write(text)

    base = directory or (os.path.dirname(bpy.data.filepath) if bpy.data.filepath else "")
    if not base:
        return "", text_block

    path = os.path.join(base, name)
    try:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        return path, text_block
    except OSError as exc:
        print(f"No se pudo escribir el informe en disco: {exc}")
        return "", text_block
