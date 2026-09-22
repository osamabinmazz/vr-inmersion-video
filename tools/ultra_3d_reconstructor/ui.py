"""Panel N "ULTRA 3D RECONSTRUCTOR", propiedades y operadores.

Cada etapa tiene su botón para poder correrla suelta y ver qué hace, y
además está el botón grande ULTRA ENHANCE que encadena las 26. Los botones
sueltos recalculan el diagnóstico y el plan cada vez, así que nunca operan
con datos viejos de otra sesión.
"""

from __future__ import annotations

import bpy
from bpy.props import (
    BoolProperty,
    EnumProperty,
    FloatProperty,
    IntProperty,
    PointerProperty,
    StringProperty,
)
from bpy.types import Operator, Panel, PropertyGroup

from . import analysis, baking, cleanup, export as export_mod, lod, pipeline
from . import quality_control, reconstruction, retopology, sculpt_detail, super_resolution
from .core.classify import classify_model
from .core.planning import build_reconstruction_plan
from .core.presets import PRESETS, preset_for_classification
from .core.scoring import build_scorecard

PRESET_ITEMS = [("AUTO", "AUTO (detectar)", "Clasifica el modelo y elige el preset solo")]
PRESET_ITEMS += [
    (key, p.label_es, p.description) for key, p in sorted(PRESETS.items())
]


class ULTRA_Props(PropertyGroup):
    preset_override: EnumProperty(
        name="Preset",
        description="AUTO clasifica el modelo y elige. Forzarlo sirve cuando "
                    "se sabe algo que la geometría no dice",
        items=PRESET_ITEMS,
        default="AUTO",
    )
    extreme_quality: BoolProperty(
        name="CALIDAD EXTREMA",
        description="Sube el objetivo del master y un nivel de subdivisión. "
                    "Pide mucha RAM; el plan la verifica y recorta si no alcanza",
        default=False,
    )
    deep_analysis: BoolProperty(
        name="Análisis profundo",
        description="Mide simetría y auto-intersecciones. Más lento, pero es lo "
                    "que permite clasificar bien el modelo",
        default=True,
    )
    deviation_samples: IntProperty(
        name="Muestras de desviación",
        description="Más muestras = medición más fiable. Por debajo de 2000 el "
                    "informe marca el resultado como orientativo",
        default=20_000, min=500, max=200_000,
    )
    use_gpu: BoolProperty(name="Hornear con GPU", default=True)
    auto_checkpoint: BoolProperty(
        name="Guardar en cada checkpoint",
        description="Guarda una copia del .blend después de las etapas caras "
                    "de rehacer. No cambia el archivo que tenés abierto",
        default=True,
    )
    do_export: BoolProperty(name="Exportar al terminar", default=False)
    export_glb: BoolProperty(name="GLB", default=True)
    export_fbx: BoolProperty(name="FBX", default=False)
    export_obj: BoolProperty(name="OBJ", default=False)
    export_master: BoolProperty(
        name="Incluir MASTER_ULTRA",
        description="El master puede pesar cientos de MB: casi nunca se entrega",
        default=False,
    )
    output_dir: StringProperty(
        name="Carpeta de salida", subtype="DIR_PATH", default="",
    )

    # Resultados en caché, para que el panel muestre algo sin recalcular.
    last_class: StringProperty(default="")
    last_preset: StringProperty(default="")
    last_score: FloatProperty(default=-1.0)
    last_topology: FloatProperty(default=-1.0)
    last_geometry: FloatProperty(default=-1.0)
    last_silhouette: FloatProperty(default=-1.0)
    last_vr: FloatProperty(default=-1.0)
    last_tris: IntProperty(default=0)
    last_verdict: StringProperty(default="")
    last_report: StringProperty(default="")


# ------------------------------------------------------------- utilidades


def _active_mesh(context):
    obj = context.active_object
    if obj is None or obj.type != "MESH":
        return None
    return obj


def _context_plan(obj, settings):
    """Diagnóstico + clasificación + plan, recalculados en el momento."""
    stats = analysis.analyze_object(obj, deep=settings.deep_analysis)
    classification = classify_model(stats)
    preset = preset_for_classification(classification, settings.preset_override)
    curvature = []
    try:
        curvature = analysis.curvature_fractions(obj, bands=3)
    except Exception:
        pass
    plan = build_reconstruction_plan(
        stats, classification, preset, pipeline.detect_hardware(),
        curvature_fractions=curvature, extreme_quality=settings.extreme_quality,
    )
    return stats, classification, preset, plan


def _report_lines(op, lines) -> None:
    if isinstance(lines, str):
        lines = [lines]
    for line in lines:
        if line:
            print(f"[ULTRA 3D] {line}")
    if lines:
        op.report({"INFO"}, lines[0][:200])


class _MeshOperator(Operator):
    """Base: exige un objeto malla activo."""

    @classmethod
    def poll(cls, context):
        return _active_mesh(context) is not None


# ------------------------------------------------------------- operadores


class ULTRA_OT_analyze(_MeshOperator):
    bl_idname = "ultra3d.analyze"
    bl_label = "Analizar modelo"
    bl_description = "Mide el modelo sin tocarlo y calcula los siete puntajes"
    bl_options = {"REGISTER"}

    def execute(self, context):
        obj = _active_mesh(context)
        settings = context.scene.ultra3d
        stats = analysis.analyze_object(obj, deep=settings.deep_analysis)
        card = build_scorecard(stats)
        classification = classify_model(stats)
        preset = preset_for_classification(classification, settings.preset_override)

        settings.last_class = classification.describe()
        settings.last_preset = preset.key
        settings.last_score = card.overall
        settings.last_topology = card.topology
        settings.last_geometry = card.geometry
        settings.last_silhouette = card.silhouette
        settings.last_vr = card.vr_readiness
        settings.last_tris = stats.tris

        lines = [
            f"{stats.tris:,} triángulos, densidad {stats.density:,.1f} tris/u².",
            settings.last_class,
            f"Global {card.overall:.1f}/100.",
        ] + [f"[!] {i}" for i in card.issues[:12]]
        _report_lines(self, lines)
        return {"FINISHED"}


class ULTRA_OT_cleanup(_MeshOperator):
    bl_idname = "ultra3d.cleanup"
    bl_label = "Limpiar y respaldar"
    bl_description = ("Respalda el original en 00_SOURCE y repara una copia: "
                      "duplicados, sueltos, caras interiores y normales")

    def execute(self, context):
        obj = _active_mesh(context)
        settings = context.scene.ultra3d
        _, _, _, plan = _context_plan(obj, settings)
        cols = cleanup.ensure_collections()
        source = cleanup.backup_source(obj, cols)
        working = cleanup.make_working_copy(source, cols)
        notes = cleanup.repair_mesh(working, plan)
        notes.append(cleanup.shade_smooth_by_angle(working, 30.0))
        _report_lines(self, notes)
        return {"FINISHED"}


class ULTRA_OT_reconstruct(_MeshOperator):
    bl_idname = "ultra3d.reconstruct"
    bl_label = "Reconstruir geometría"
    bl_description = ("Aplica el método que corresponde al tipo de modelo: "
                      "subdivisión adaptativa, Multires, remesh o nada")

    def execute(self, context):
        obj = _active_mesh(context)
        settings = context.scene.ultra3d
        _, _, _, plan = _context_plan(obj, settings)
        source = _find_source(obj)
        _report_lines(self, reconstruction.reconstruct(obj, source, plan))
        return {"FINISHED"}


class ULTRA_OT_super_resolution(_MeshOperator):
    bl_idname = "ultra3d.super_resolution"
    bl_label = "Super-resolución"
    bl_description = "Densifica solo donde hay curvatura y verifica midiendo"

    def execute(self, context):
        obj = _active_mesh(context)
        settings = context.scene.ultra3d
        _, _, preset, plan = _context_plan(obj, settings)
        _report_lines(self, super_resolution.super_resolve(obj, _find_source(obj), plan, preset))
        return {"FINISHED"}


class ULTRA_OT_sculpt_detail(_MeshOperator):
    bl_idname = "ultra3d.sculpt_detail"
    bl_label = "Microrelieve"
    bl_description = ("Realza el relieve que el modelo ya documenta en sus mapas. "
                      "Sin mapa de altura, no hace nada: no inventa detalle")

    def execute(self, context):
        obj = _active_mesh(context)
        settings = context.scene.ultra3d
        _, _, preset, _ = _context_plan(obj, settings)
        _report_lines(
            self,
            sculpt_detail.apply_evidence_based_detail(obj, preset, analysis.bbox_diagonal(obj)),
        )
        return {"FINISHED"}


class ULTRA_OT_retopology(_MeshOperator):
    bl_idname = "ultra3d.retopology"
    bl_label = "Retopologizar"
    bl_description = "Genera una malla de quads limpia y le devuelve la silueta"

    def execute(self, context):
        obj = _active_mesh(context)
        settings = context.scene.ultra3d
        _, _, preset, plan = _context_plan(obj, settings)
        _report_lines(self, retopology.retopologize(obj, _find_source(obj), plan, preset))
        return {"FINISHED"}


class ULTRA_OT_bake(_MeshOperator):
    bl_idname = "ultra3d.bake"
    bl_label = "Hornear mapas"
    bl_description = ("Hornea del objeto seleccionado (denso) al activo (liviano). "
                      "Hay que tener los dos seleccionados")

    def execute(self, context):
        low = _active_mesh(context)
        settings = context.scene.ultra3d
        others = [o for o in context.selected_objects if o is not low and o.type == "MESH"]
        if not others:
            self.report({"ERROR"}, "Seleccioná también el modelo denso del que hornear.")
            return {"CANCELLED"}
        high = others[0]
        _, _, _, plan = _context_plan(low, settings)
        images, notes = baking.bake_all(
            low, high, plan, analysis.bbox_diagonal(high), use_gpu=settings.use_gpu
        )
        if images:
            notes.append(baking.wire_baked_material(low, images))
        _report_lines(self, notes)
        return {"FINISHED"}


class ULTRA_OT_lods(_MeshOperator):
    bl_idname = "ultra3d.lods"
    bl_label = "Generar LODs"
    bl_description = "Crea LOD0..LOD3 colapsando primero la superficie plana"

    def execute(self, context):
        obj = _active_mesh(context)
        settings = context.scene.ultra3d
        _, _, preset, plan = _context_plan(obj, settings)
        cols = cleanup.ensure_collections()
        lods, notes = lod.build_all_lods(obj, plan, preset, cols["05_LODS"])
        _report_lines(self, notes)
        return {"FINISHED"}


class ULTRA_OT_quality(_MeshOperator):
    bl_idname = "ultra3d.quality"
    bl_label = "Control de calidad"
    bl_description = ("Mide desviación bidireccional, silueta en 8 vistas y volumen "
                      "contra el original de 00_SOURCE")

    def execute(self, context):
        obj = _active_mesh(context)
        settings = context.scene.ultra3d
        source = _find_source(obj)
        if source is None:
            self.report({"ERROR"}, "No se encontró el original en 00_SOURCE.")
            return {"CANCELLED"}
        _, _, preset, _ = _context_plan(obj, settings)
        report, notes = quality_control.full_quality_check(
            source, obj, preset, samples=settings.deviation_samples
        )
        settings.last_verdict = report.verdict.value
        notes.append(f"Veredicto: {report.verdict.value} — "
                     f"{'APROBADO' if report.passed else 'NO APROBADO'}")
        notes.extend(f"[!] {p}" for p in report.problems)
        notes.extend(f"→ {r}" for r in report.recommendations)
        _report_lines(self, notes)
        return {"FINISHED"}


class ULTRA_OT_comparator(Operator):
    bl_idname = "ultra3d.comparator"
    bl_label = "Escena comparadora"
    bl_description = "Alinea copias de todas las versiones para verlas juntas"

    def execute(self, context):
        cols = cleanup.ensure_collections()
        versions = {}
        for col_name, key in (
            ("00_SOURCE", "SOURCE"), ("03_MASTER_ULTRA", "MASTER_ULTRA"),
            ("04_RETOPO", "RETOPO"),
        ):
            objs = list(cols[col_name].objects)
            if objs:
                versions[key] = objs[0]
        for o in cols["05_LODS"].objects:
            versions[o.get("ultra3d_role", o.name).upper()] = o
        if not versions:
            self.report({"ERROR"}, "No hay versiones generadas todavía.")
            return {"CANCELLED"}
        _report_lines(self, quality_control.build_comparator(versions, cols["07_COMPARISON"]))
        return {"FINISHED"}


class ULTRA_OT_export(Operator):
    bl_idname = "ultra3d.export"
    bl_label = "Exportar LODs"
    bl_description = "Exporta los LODs generados y las texturas horneadas"

    def execute(self, context):
        settings = context.scene.ultra3d
        cols = cleanup.ensure_collections()
        lods = {o.get("ultra3d_role", o.name).upper(): o for o in cols["05_LODS"].objects}
        if not lods:
            self.report({"ERROR"}, "No hay LODs que exportar.")
            return {"CANCELLED"}
        formats = [f for f, on in (
            ("GLB", settings.export_glb), ("FBX", settings.export_fbx),
            ("OBJ", settings.export_obj),
        ) if on]
        paths, notes = export_mod.export_all(lods, {}, settings.output_dir, formats)
        _report_lines(self, notes)
        return {"FINISHED"}


class ULTRA_OT_restore_source(Operator):
    bl_idname = "ultra3d.restore_source"
    bl_label = "Restaurar original"
    bl_description = "Trae de vuelta una copia visible del original de 00_SOURCE"

    def execute(self, context):
        cols = cleanup.ensure_collections()
        objs = list(cols["00_SOURCE"].objects)
        if not objs:
            self.report({"ERROR"}, "No hay nada en 00_SOURCE.")
            return {"CANCELLED"}
        restored = cleanup.make_working_copy(objs[0], cols, suffix="RESTORED", target="01_CLEAN")
        self.report({"INFO"}, f"Original restaurado como '{restored.name}'.")
        return {"FINISHED"}


class ULTRA_OT_ultra_enhance(_MeshOperator):
    bl_idname = "ultra3d.ultra_enhance"
    bl_label = "ULTRA ENHANCE"
    bl_description = ("Corre las 26 etapas de punta a punta sobre el objeto activo. "
                      "El original queda intacto en 00_SOURCE")
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        obj = _active_mesh(context)
        settings = context.scene.ultra3d
        run = pipeline.run_ultra_enhance(obj, settings)

        if run.score_before and run.score_after:
            settings.last_score = run.score_after.overall
            settings.last_topology = run.score_after.topology
            settings.last_geometry = run.score_after.geometry
            settings.last_silhouette = run.score_after.silhouette
            settings.last_vr = run.score_after.vr_readiness
            delta = run.score_after.overall - run.score_before.overall
            msg = (f"Listo: {run.score_before.overall:.1f} → "
                   f"{run.score_after.overall:.1f} ({delta:+.1f}).")
        else:
            msg = "Proceso terminado (ver la consola para el detalle)."
        if run.classification:
            settings.last_class = run.classification.describe()
        if run.preset:
            settings.last_preset = run.preset.key
        if run.fidelity:
            settings.last_verdict = run.fidelity.verdict.value
        settings.last_report = run.report_path
        if run.stats_after:
            settings.last_tris = run.stats_after.tris

        if run.log.errors:
            self.report({"WARNING"}, f"{msg} Con {len(run.log.errors)} etapa(s) con errores.")
        else:
            self.report({"INFO"}, msg)
        return {"FINISHED"}


def _find_source(obj):
    """Busca el respaldo del original correspondiente a este objeto."""
    base = obj.get("ultra3d_original_name", obj.name)
    col = bpy.data.collections.get("ULTRA_3D_00_SOURCE")
    if col is None:
        return None
    for candidate in col.objects:
        if candidate.get("ultra3d_original_name") == base:
            return candidate
    return col.objects[0] if col.objects else None


# ------------------------------------------------------------------ panel


class ULTRA_PT_main(Panel):
    bl_label = "ULTRA 3D RECONSTRUCTOR"
    bl_idname = "ULTRA_PT_main"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "ULTRA 3D"

    def draw(self, context):
        layout = self.layout
        settings = context.scene.ultra3d
        obj = _active_mesh(context)

        # 1. Objeto
        box = layout.box()
        box.label(text="1 · Objeto", icon="MESH_DATA")
        if obj is None:
            box.label(text="Seleccioná un objeto de tipo malla.", icon="ERROR")
            return
        box.label(text=obj.name)
        if settings.last_tris:
            box.label(text=f"{settings.last_tris:,} triángulos medidos")

        # 2. Diagnóstico
        box = layout.box()
        box.label(text="2 · Diagnóstico", icon="VIEWZOOM")
        box.prop(settings, "deep_analysis")
        box.operator("ultra3d.analyze", icon="ZOOM_ALL")

        # 3. Clasificación y preset
        box = layout.box()
        box.label(text="3 · Clasificación y preset", icon="OUTLINER_OB_GROUP_INSTANCE")
        box.prop(settings, "preset_override")
        if settings.last_class:
            box.label(text=settings.last_class, icon="INFO")
        if settings.last_preset:
            box.label(text=f"Preset activo: {settings.last_preset}")

        # 4. Puntajes
        box = layout.box()
        box.label(text="4 · Puntajes de calidad", icon="SORTBYEXT")
        if settings.last_score < 0:
            box.label(text="Todavía sin analizar.")
        else:
            col = box.column(align=True)
            col.label(text=f"Global:     {settings.last_score:5.1f} / 100")
            col.label(text=f"Topología:  {settings.last_topology:5.1f}")
            col.label(text=f"Geometría:  {settings.last_geometry:5.1f}")
            col.label(text=f"Silueta:    {settings.last_silhouette:5.1f}")
            col.label(text=f"Listo VR:   {settings.last_vr:5.1f}")

        # 5. Limpieza y respaldo
        box = layout.box()
        box.label(text="5 · Limpieza y respaldo", icon="BRUSH_DATA")
        box.operator("ultra3d.cleanup", icon="TRASH")
        box.operator("ultra3d.restore_source", icon="LOOP_BACK")

        # 6. Reconstrucción
        box = layout.box()
        box.label(text="6 · Reconstrucción", icon="MOD_REMESH")
        box.prop(settings, "extreme_quality")
        box.operator("ultra3d.reconstruct", icon="MOD_SUBSURF")

        # 7. Super-resolución
        box = layout.box()
        box.label(text="7 · Super-resolución", icon="MOD_MULTIRES")
        box.operator("ultra3d.super_resolution", icon="MESH_GRID")

        # 8. Microrelieve
        box = layout.box()
        box.label(text="8 · Microrelieve", icon="SCULPTMODE_HLT")
        box.operator("ultra3d.sculpt_detail", icon="MOD_DISPLACE")

        # 9. Retopología
        box = layout.box()
        box.label(text="9 · Retopología", icon="MOD_TRIANGULATE")
        box.operator("ultra3d.retopology", icon="MESH_PLANE")

        # 10. Horneado
        box = layout.box()
        box.label(text="10 · Horneado de mapas", icon="TEXTURE")
        box.prop(settings, "use_gpu")
        box.operator("ultra3d.bake", icon="RENDER_STILL")

        # 11. LODs
        box = layout.box()
        box.label(text="11 · Niveles de detalle", icon="MOD_DECIM")
        box.operator("ultra3d.lods", icon="MESH_ICOSPHERE")

        # 12. Control de calidad
        box = layout.box()
        box.label(text="12 · Control de calidad", icon="CHECKMARK")
        box.prop(settings, "deviation_samples")
        box.operator("ultra3d.quality", icon="DRIVER_DISTANCE")
        box.operator("ultra3d.comparator", icon="IMAGE_REFERENCE")
        if settings.last_verdict:
            box.label(text=f"Veredicto: {settings.last_verdict}", icon="INFO")

        # 13. Exportación e informe
        box = layout.box()
        box.label(text="13 · Exportación e informe", icon="EXPORT")
        box.prop(settings, "output_dir")
        row = box.row(align=True)
        row.prop(settings, "export_glb", toggle=True)
        row.prop(settings, "export_fbx", toggle=True)
        row.prop(settings, "export_obj", toggle=True)
        box.prop(settings, "export_master")
        box.operator("ultra3d.export", icon="FILE_BLEND")
        if settings.last_report:
            box.label(text=f"Informe: {settings.last_report}", icon="TEXT")

        # Proceso completo
        layout.separator()
        box = layout.box()
        box.label(text="PROCESO COMPLETO", icon="SOLO_ON")
        box.prop(settings, "auto_checkpoint")
        box.prop(settings, "do_export")
        row = box.row()
        row.scale_y = 2.0
        row.operator("ultra3d.ultra_enhance", icon="SHADERFX")
        box.label(text="El original queda intacto en 00_SOURCE.", icon="LOCKED")


CLASSES = (
    ULTRA_Props,
    ULTRA_OT_analyze,
    ULTRA_OT_cleanup,
    ULTRA_OT_reconstruct,
    ULTRA_OT_super_resolution,
    ULTRA_OT_sculpt_detail,
    ULTRA_OT_retopology,
    ULTRA_OT_bake,
    ULTRA_OT_lods,
    ULTRA_OT_quality,
    ULTRA_OT_comparator,
    ULTRA_OT_export,
    ULTRA_OT_restore_source,
    ULTRA_OT_ultra_enhance,
    ULTRA_PT_main,
)


def register():
    for cls in CLASSES:
        bpy.utils.register_class(cls)
    bpy.types.Scene.ultra3d = PointerProperty(type=ULTRA_Props)


def unregister():
    del bpy.types.Scene.ultra3d
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)
