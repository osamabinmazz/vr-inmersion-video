"""Interfaz: propiedades, operadores y panel N > 3D Model Enhancer."""

from __future__ import annotations

import bpy
from bpy.props import BoolProperty, EnumProperty, FloatProperty, IntProperty, StringProperty
from bpy.types import Operator, Panel, PropertyGroup

from . import analysis, pipeline
from .core.metrics import build_plan
from .core.quality import Verdict

REPORT_TEXT_NAME = "MODEL_ENHANCER_REPORT"


# --------------------------------------------------------------------------
# Propiedades
# --------------------------------------------------------------------------

class MDE_Props(PropertyGroup):
    bake_dir: StringProperty(
        name="Carpeta de bakes",
        description="Dónde guardar los mapas horneados. Vacío = solo en memoria",
        subtype="DIR_PATH",
        default="//bakes/",
    )
    export_dir: StringProperty(
        name="Carpeta de export",
        subtype="DIR_PATH",
        default="//exports/",
    )
    do_bake: BoolProperty(
        name="Bakear en AUTO",
        description="Hornear normal/AO/displacement durante el proceso automático",
        default=True,
    )
    bake_samples: IntProperty(
        name="Samples",
        description="Para normal y displacement alcanza con pocos; el AO pide más",
        default=16,
        min=1,
        max=512,
    )
    cage_extrusion: FloatProperty(
        name="Cage",
        description="Distancia de proyección del high al low. Muy baja deja huecos; "
        "muy alta captura geometría vecina equivocada",
        default=0.05,
        min=0.0,
        max=10.0,
    )
    max_retries: IntProperty(
        name="Reintentos",
        description="Cuántas veces reintentar más suave si el resultado pierde la forma",
        default=2,
        min=0,
        max=5,
    )
    export_formats: EnumProperty(
        name="Formatos",
        options={"ENUM_FLAG"},
        items=[
            ("GLB", "GLB", "glTF binario, ideal para WebXR"),
            ("GLTF", "glTF", "glTF separado"),
            ("FBX", "FBX", "FBX"),
            ("OBJ", "OBJ", "OBJ"),
            ("BLEND", "BLEND", "Archivo .blend"),
        ],
        default={"GLB"},
    )
    export_level: EnumProperty(
        name="Nivel",
        items=[
            ("MASTER_HIGH", "MASTER_HIGH", ""),
            ("LOD0", "LOD0", ""),
            ("LOD1", "LOD1", ""),
            ("LOD2", "LOD2", ""),
        ],
        default="LOD0",
    )
    last_summary: StringProperty(name="Resumen", default="")


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def _active_mesh(context):
    obj = context.active_object
    if obj and obj.type == "MESH":
        return obj
    return None


def _write_report(lines: list[str]) -> bpy.types.Text:
    """Vuelca el informe a un datablock de texto para poder leerlo dentro de
    Blender, además de la consola."""
    text = bpy.data.texts.get(REPORT_TEXT_NAME)
    if text is None:
        text = bpy.data.texts.new(REPORT_TEXT_NAME)
    text.clear()
    body = "\n".join(lines)
    text.write(body)
    print(body)
    return text


def _find_level_object(base_name: str, level: str):
    """Busca el objeto de un nivel dentro de su colección."""
    coll = bpy.data.collections.get(pipeline.COLLECTIONS[level])
    if not coll:
        return None
    for obj in coll.objects:
        if obj.name.startswith(base_name):
            return obj
    return coll.objects[0] if coll.objects else None


def _base_name(obj) -> str:
    name = obj.name
    for suffix in ("_ORIGINAL_BACKUP", "_MASTER_HIGH", "_LOD0", "_LOD1", "_LOD2"):
        name = name.replace(suffix, "")
    return name


class _MeshOperator(Operator):
    """Base: exige un objeto de malla activo."""

    @classmethod
    def poll(cls, context):
        return _active_mesh(context) is not None


# --------------------------------------------------------------------------
# Operadores
# --------------------------------------------------------------------------

class MDE_OT_analyze(_MeshOperator):
    bl_idname = "mde.analyze"
    bl_label = "ANALIZAR MODELO"
    bl_description = "Mide la malla y muestra qué procedimiento conviene, sin modificar nada"
    bl_options = {"REGISTER"}

    def execute(self, context):
        obj = _active_mesh(context)
        stats = analysis.analyze_object(obj)
        plan = build_plan(stats)

        lines = [
            "=" * 62,
            f"ANÁLISIS: {stats.name}",
            "=" * 62,
            f"  Vértices             : {stats.verts:,}",
            f"  Caras                : {stats.faces:,}  (quads {stats.quads:,} / ngons {stats.ngons:,})",
            f"  Triángulos           : {stats.tris:,}",
            f"  Proporción quads     : {stats.quad_ratio * 100:.1f}%",
            f"  Non-manifold         : {stats.non_manifold_edges:,} aristas",
            f"  Bordes abiertos      : {stats.boundary_edges:,}",
            f"  Caras interiores     : {stats.interior_faces:,}",
            f"  Vértices sueltos     : {stats.loose_verts:,}",
            f"  Duplicados           : {stats.duplicate_verts:,}",
            f"  Normales invertidas  : {stats.flipped_normals:,}",
            f"  UV maps              : {stats.uv_layers}",
            f"  Materiales           : {stats.materials} ({stats.textured_materials} con textura)",
            f"  Armature             : {'sí' if stats.has_armature else 'no'}",
            f"  Shape keys           : {stats.shape_keys}",
            f"  Vertex groups        : {stats.vertex_groups}",
            f"  Dimensiones          : {stats.dimensions[0]:.3f} x {stats.dimensions[1]:.3f} x {stats.dimensions[2]:.3f}",
            f"  Escala aplicada      : {'NO' if stats.is_scaled else 'sí'}",
            f"  Área de superficie   : {stats.surface_area:.4f}",
            f"  Densidad             : {stats.density:.1f} tris/unidad²",
            "",
            "-" * 62,
            "PLAN PROPUESTO",
            "-" * 62,
            f"  Clase de densidad    : {plan.mesh_class.value}",
            f"  Topología            : {plan.topology.value}",
            f"  Estrategia           : {plan.strategy.value}",
            f"  Niveles de subdiv    : {plan.subdivision_levels}",
            f"  Voxel size           : {plan.voxel_size:.5f}" if plan.voxel_size
            else "  Voxel size           : n/a",
            f"  Reparar antes        : {'sí' if plan.needs_repair else 'no'}",
            f"  Generar UVs          : {'sí' if plan.needs_uv_unwrap else 'no'}",
            "",
            "  Objetivos de triángulos:",
        ]
        for level, target in plan.targets.items():
            lines.append(f"    {level:<12}: {target:,}")

        if plan.notes:
            lines += ["", "  Notas:"] + [f"    - {n}" for n in plan.notes]
        if plan.warnings:
            lines += ["", "  ADVERTENCIAS:"] + [f"    ! {w}" for w in plan.warnings]

        _write_report(lines)
        context.scene.mde_props.last_summary = (
            f"{stats.tris:,} tris | {plan.topology.value} | {plan.strategy.value}"
        )
        self.report({"INFO"}, f"Análisis listo: ver el texto {REPORT_TEXT_NAME}")
        return {"FINISHED"}


class MDE_OT_backup(_MeshOperator):
    bl_idname = "mde.backup"
    bl_label = "CREAR BACKUP"
    bl_description = "Copia intacta del original en la colección 00_ORIGINAL"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        obj = _active_mesh(context)
        backup = pipeline.backup_original(obj)
        self.report({"INFO"}, f"Backup creado: {backup.name}")
        return {"FINISHED"}


class MDE_OT_repair(_MeshOperator):
    bl_idname = "mde.repair"
    bl_label = "MEJORAR GEOMETRÍA"
    bl_description = (
        "Limpia duplicados, vértices sueltos y caras interiores, recalcula normales y "
        "mejora el sombreado. Hace backup antes de tocar nada"
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        obj = _active_mesh(context)
        pipeline.backup_original(obj)
        result = pipeline.repair_mesh(obj)
        pipeline.shade_smooth_by_angle(obj)
        pipeline.add_weighted_normals(obj)
        self.report(
            {"INFO"},
            "Limpieza: {merged_verts} duplicados, {loose_removed} sueltos, "
            "{interior_removed} caras internas".format(**result),
        )
        return {"FINISHED"}


class MDE_OT_master(_MeshOperator):
    bl_idname = "mde.master"
    bl_label = "CREAR MASTER HIGH"
    bl_description = "Genera la versión de máxima calidad con la estrategia que decida el análisis"
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        obj = _active_mesh(context)
        stats = analysis.analyze_object(obj)
        plan = build_plan(stats)
        backup = pipeline.backup_original(obj)
        master = pipeline.build_master(backup, plan)
        report = analysis.measure_deviation(master, backup, "MASTER_HIGH")
        self.report(
            {"INFO"} if report.verdict is not Verdict.FAILED else {"WARNING"},
            f"MASTER_HIGH: {report.tris:,} tris | fidelidad {report.verdict.value} "
            f"(desvío medio {report.mean_deviation * 100:.2f}%)",
        )
        return {"FINISHED"}


class MDE_OT_lod(_MeshOperator):
    bl_idname = "mde.lod"
    bl_label = "CREAR LOD"
    bl_description = "Genera el LOD indicado a partir del MASTER_HIGH"
    bl_options = {"REGISTER", "UNDO"}

    level: EnumProperty(
        items=[("LOD0", "LOD0", ""), ("LOD1", "LOD1", ""), ("LOD2", "LOD2", "")],
        default="LOD0",
    )

    def execute(self, context):
        obj = _active_mesh(context)
        base = _base_name(obj)
        master = _find_level_object(base, "MASTER_HIGH")
        if master is None:
            self.report({"ERROR"}, "No hay MASTER_HIGH todavía: creá el master primero")
            return {"CANCELLED"}

        backup = _find_level_object(base, "ORIGINAL") or obj
        stats = analysis.analyze_object(backup)
        plan = build_plan(stats)
        lod = pipeline.build_lod(master, self.level, plan.targets[self.level])
        report = analysis.measure_deviation(lod, backup, self.level)
        self.report(
            {"INFO"},
            f"{self.level}: {report.tris:,} tris | fidelidad {report.verdict.value}",
        )
        return {"FINISHED"}


class MDE_OT_bake(_MeshOperator):
    bl_idname = "mde.bake"
    bl_label = "BAKEAR TEXTURAS"
    bl_description = "Hornea del MASTER_HIGH al nivel elegido (normal, AO y displacement)"
    bl_options = {"REGISTER"}

    bake_type: EnumProperty(
        items=[
            ("ALL", "Todos", ""),
            ("NORMAL", "Normal", ""),
            ("AO", "AO", ""),
            ("DISPLACEMENT", "Displacement", ""),
        ],
        default="ALL",
    )

    def execute(self, context):
        props = context.scene.mde_props
        obj = _active_mesh(context)
        base = _base_name(obj)
        master = _find_level_object(base, "MASTER_HIGH")
        if master is None:
            self.report({"ERROR"}, "Falta el MASTER_HIGH: sin él no hay detalle que hornear")
            return {"CANCELLED"}

        level = props.export_level if props.export_level != "MASTER_HIGH" else "LOD0"
        low = _find_level_object(base, level)
        if low is None:
            self.report({"ERROR"}, f"No existe {level}: generalo antes de bakear")
            return {"CANCELLED"}

        types = ("NORMAL", "AO", "DISPLACEMENT") if self.bake_type == "ALL" else (self.bake_type,)
        result = pipeline.bake_maps(
            low,
            master,
            level,
            types=types,
            output_dir=bpy.path.abspath(props.bake_dir) if props.bake_dir else "",
            samples=props.bake_samples,
            cage_extrusion=props.cage_extrusion,
        )
        errors = [k for k, v in result.items() if v.startswith("ERROR")]
        if errors:
            self.report({"WARNING"}, f"Bake con problemas en: {', '.join(errors)}")
        else:
            self.report({"INFO"}, f"Bake listo: {', '.join(result)}")
        return {"FINISHED"}


class MDE_OT_compare(_MeshOperator):
    bl_idname = "mde.compare"
    bl_label = "COMPARAR MODELOS"
    bl_description = "Mide cuánto se aleja cada versión del original y lo vuelca al informe"
    bl_options = {"REGISTER"}

    def execute(self, context):
        obj = _active_mesh(context)
        base = _base_name(obj)
        backup = _find_level_object(base, "ORIGINAL")
        if backup is None:
            self.report({"ERROR"}, "No hay copia original con la que comparar")
            return {"CANCELLED"}

        orig_stats = analysis.analyze_object(backup)
        lines = [
            "=" * 66,
            f"COMPARACIÓN: {base}",
            "=" * 66,
            f"{'NIVEL':<14}{'TRIS':>12}{'vs ORIG':>10}{'DESVÍO':>10}{'VOLUMEN':>10}  FIDELIDAD",
            "-" * 66,
            f"{'ORIGINAL':<14}{orig_stats.tris:>12,}{'100%':>10}{'-':>10}{'-':>10}  referencia",
        ]
        for level in ("MASTER_HIGH", "LOD0", "LOD1", "LOD2"):
            target = _find_level_object(base, level)
            if target is None:
                lines.append(f"{level:<14}{'(no generado)':>12}")
                continue
            rep = analysis.measure_deviation(target, backup, level)
            pct = (rep.tris / orig_stats.tris * 100) if orig_stats.tris else 0.0
            lines.append(
                f"{level:<14}{rep.tris:>12,}{pct:>9.0f}%"
                f"{rep.mean_deviation * 100:>9.2f}%{rep.volume_change * 100:>9.1f}%"
                f"  {rep.verdict.value}"
            )
            for issue in rep.issues:
                lines.append(f"{'':<14}  ! {issue}")

        lines += [
            "",
            "El desvío es la distancia media a la superficie original, expresada",
            "como porcentaje de la diagonal del objeto: así el criterio vale igual",
            "para un pájaro de 30 cm que para un árbol de 12 m.",
        ]
        _write_report(lines)
        self.report({"INFO"}, f"Comparación en el texto {REPORT_TEXT_NAME}")
        return {"FINISHED"}


class MDE_OT_export(_MeshOperator):
    bl_idname = "mde.export"
    bl_label = "EXPORTAR"
    bl_description = "Exporta el nivel elegido en los formatos marcados"
    bl_options = {"REGISTER"}

    def execute(self, context):
        props = context.scene.mde_props
        obj = _active_mesh(context)
        base = _base_name(obj)
        target = _find_level_object(base, props.export_level)
        if target is None:
            self.report({"ERROR"}, f"No existe {props.export_level}")
            return {"CANCELLED"}
        if not props.export_formats:
            self.report({"ERROR"}, "No hay ningún formato marcado")
            return {"CANCELLED"}

        result = pipeline.export_object(
            target, bpy.path.abspath(props.export_dir), tuple(props.export_formats)
        )
        errors = [k for k, v in result.items() if v.startswith("ERROR")]
        if errors:
            self.report({"WARNING"}, f"Falló la exportación: {', '.join(errors)}")
        else:
            self.report({"INFO"}, f"Exportado: {', '.join(result)}")
        return {"FINISHED"}


class MDE_OT_auto(_MeshOperator):
    bl_idname = "mde.auto"
    bl_label = "AUTO ENHANCE SELECTED MODEL"
    bl_description = (
        "Proceso completo: analiza, respalda, limpia, crea MASTER_HIGH y los tres LODs, "
        "bakea, verifica fidelidad y escribe el informe"
    )
    bl_options = {"REGISTER", "UNDO"}

    def execute(self, context):
        props = context.scene.mde_props
        obj = _active_mesh(context)

        result = pipeline.run_auto_enhance(
            obj,
            do_bake=props.do_bake,
            bake_dir=bpy.path.abspath(props.bake_dir) if props.bake_dir else "",
            max_retries=props.max_retries,
        )

        stats = result["stats"]
        plan = result["plan"]
        quality = result["quality"]
        timings = result["timings"]

        lines = [
            "=" * 66,
            f"INFORME FINAL — {stats.name}",
            "=" * 66,
            "",
            "GEOMETRÍA",
            "-" * 66,
            f"  {'ORIGINAL':<14}{stats.tris:>12,} tris",
        ]
        for level in ("MASTER_HIGH", "LOD0", "LOD1", "LOD2"):
            rep = quality.get(level)
            if rep:
                lines.append(
                    f"  {level:<14}{rep.tris:>12,} tris   "
                    f"desvío {rep.mean_deviation * 100:5.2f}%   "
                    f"volumen {rep.volume_change * 100:+6.1f}%   {rep.verdict.value}"
                )

        lines += [
            "",
            "DECISIONES",
            "-" * 66,
            f"  Clase           : {plan.mesh_class.value}",
            f"  Topología       : {plan.topology.value}",
            f"  Estrategia      : {plan.strategy.value}",
            f"  Intensidad final: {result['final_strength']:.2f}"
            + ("  (reducida tras control de calidad)" if result["final_strength"] < 1.0 else ""),
            "",
            "TEXTURAS HORNEADAS",
            "-" * 66,
        ]
        if result["bakes"]:
            for level, maps in result["bakes"].items():
                for kind, path in maps.items():
                    lines.append(f"  {level:<10}{kind:<14}{path}")
        else:
            lines.append("  (bake desactivado)")

        lines += ["", "TIEMPOS", "-" * 66]
        for key, seconds in timings.items():
            lines.append(f"  {key:<20}{seconds:8.2f} s")

        problems = []
        for level, rep in quality.items():
            problems += [f"[{level}] {i}" for i in rep.issues]
        lines += ["", "PROBLEMAS ENCONTRADOS", "-" * 66]
        lines += [f"  ! {p}" for p in problems] if problems else ["  Ninguno."]

        lines += ["", "ADVERTENCIAS DEL PLAN", "-" * 66]
        lines += [f"  ! {w}" for w in plan.warnings] if plan.warnings else ["  Ninguna."]

        recs = []
        if plan.strategy.value == "detail_only":
            recs.append(
                "El modelo ya era denso: la mejora vino de los mapas, no de geometría. "
                "Revisá el normal map antes de dar por bueno el LOD0."
            )
        if stats.has_armature:
            recs.append(
                "Con armature: transferí los pesos del original a los LODs "
                "(Data Transfer / Weight Transfer) y probá la animación antes de exportar."
            )
        if any(r.verdict in (Verdict.DEGRADED, Verdict.FAILED) for r in quality.values()):
            recs.append(
                "Algún nivel perdió forma. Bajá la intensidad a mano o generá ese LOD "
                "con un objetivo de triángulos más alto."
            )
        if not stats.has_uvs:
            recs.append(
                "Las UVs se generaron automáticamente: para texturas pintadas a mano "
                "conviene un desplegado manual."
            )
        lines += ["", "RECOMENDACIONES", "-" * 66]
        lines += [f"  - {r}" for r in recs] if recs else ["  Sin observaciones."]

        _write_report(lines)
        props.last_summary = (
            f"{stats.tris:,} → master {quality['MASTER_HIGH'].tris:,} tris "
            f"({timings['total']:.1f}s)"
        )
        self.report({"INFO"}, f"AUTO listo en {timings['total']:.1f}s — ver {REPORT_TEXT_NAME}")
        return {"FINISHED"}


# --------------------------------------------------------------------------
# Panel
# --------------------------------------------------------------------------

class MDE_PT_main(Panel):
    bl_label = "3D Model Enhancer"
    bl_idname = "MDE_PT_main"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "3D Model Enhancer"

    def draw(self, context):
        layout = self.layout
        props = context.scene.mde_props
        obj = _active_mesh(context)

        box = layout.box()
        if obj:
            box.label(text=obj.name, icon="MESH_DATA")
            if props.last_summary:
                box.label(text=props.last_summary, icon="INFO")
        else:
            box.label(text="Seleccioná un objeto de malla", icon="ERROR")

        col = layout.column(align=True)
        col.scale_y = 1.4
        col.operator("mde.auto", icon="SHADERFX")

        layout.separator()
        col = layout.column(align=True)
        col.operator("mde.analyze", icon="VIEWZOOM")
        col.operator("mde.backup", icon="DUPLICATE")
        col.operator("mde.repair", icon="MODIFIER")

        layout.separator()
        col = layout.column(align=True)
        col.label(text="Niveles:")
        col.operator("mde.master", icon="MESH_UVSPHERE")
        row = col.row(align=True)
        for level in ("LOD0", "LOD1", "LOD2"):
            row.operator("mde.lod", text=level).level = level

        layout.separator()
        box = layout.box()
        box.label(text="Bake", icon="RENDER_STILL")
        box.prop(props, "bake_dir")
        row = box.row(align=True)
        row.prop(props, "bake_samples")
        row.prop(props, "cage_extrusion")
        col = box.column(align=True)
        col.operator("mde.bake", text="GENERAR NORMAL MAP").bake_type = "NORMAL"
        col.operator("mde.bake", text="GENERAR DISPLACEMENT").bake_type = "DISPLACEMENT"
        col.operator("mde.bake", text="BAKEAR TEXTURAS (todo)").bake_type = "ALL"

        layout.separator()
        layout.operator("mde.compare", icon="ARROW_LEFTRIGHT")

        box = layout.box()
        box.label(text="Exportar", icon="EXPORT")
        box.prop(props, "export_level", text="")
        box.prop(props, "export_formats")
        box.prop(props, "export_dir")
        box.operator("mde.export", icon="EXPORT")

        box = layout.box()
        box.label(text="AUTO", icon="PREFERENCES")
        box.prop(props, "do_bake")
        box.prop(props, "max_retries")


CLASSES = (
    MDE_Props,
    MDE_OT_analyze,
    MDE_OT_backup,
    MDE_OT_repair,
    MDE_OT_master,
    MDE_OT_lod,
    MDE_OT_bake,
    MDE_OT_compare,
    MDE_OT_export,
    MDE_OT_auto,
    MDE_PT_main,
)


def register():
    for cls in CLASSES:
        bpy.utils.register_class(cls)
    bpy.types.Scene.mde_props = bpy.props.PointerProperty(type=MDE_Props)


def unregister():
    if hasattr(bpy.types.Scene, "mde_props"):
        del bpy.types.Scene.mde_props
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)
