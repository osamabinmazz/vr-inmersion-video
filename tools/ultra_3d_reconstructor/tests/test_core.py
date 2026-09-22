"""Tests del núcleo de decisión. Corren sin Blender: `python3 -m unittest`.

La idea es verificar las decisiones que, tomadas mal, destruyen el modelo:
subdividir un escaneo, remeshear follaje, inflar un objeto simple a millones
de triángulos, o dar por bueno un resultado que perdió detalle.
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.classify import Classification, ModelKind, classify_model, photogrammetry_score
from core.deviation import (
    DeviationVerdict,
    bidirectional_deviation,
    build_fidelity_report,
    classify_deviation,
    combine_silhouettes,
    percentile,
    silhouette_error,
    summarize_distances,
    volume_error,
)
from core.planning import (
    CHECKPOINT_STAGES,
    HardwareProfile,
    ReconstructionMethod,
    STAGE_ORDER,
    Stage,
    adaptive_subdivision_plan,
    build_reconstruction_plan,
    curvature_thresholds,
    estimate_peak_memory_gb,
    safe_target_tris,
    voxel_size_for,
)
from core.presets import PRESETS, get_preset, preset_for_classification, preset_for_kind
from core.scoring import ScoreCard, build_scorecard, score_geometry, score_topology
from core.stats import MeshStats


# --------------------------------------------------------------- fixtures


def animal_stats(**kw) -> MeshStats:
    """Carpincho low-poly riggeado."""
    base = dict(
        name="carpincho_lowpoly",
        verts=8_100, edges=16_000, faces=8_000, tris=16_000, quads=7_400, ngons=0,
        dimensions=(1.10, 0.50, 0.55), surface_area=2.0, volume=0.09,
        planar_ratio=0.10, sharp_edges_ratio=0.07, curvature_std=0.31,
        symmetry_x=0.93, has_armature=True, vertex_groups=28, loose_parts=1,
        uv_layers=1, materials=1, textured_materials=1, uses_nodes=True,
        texture_resolution=2048, has_normal_map=True, shade_smooth=True,
        edge_length_mean=0.02, edge_length_std=0.006,
    )
    base.update(kw)
    return MeshStats(**base)


def tree_stats(**kw) -> MeshStats:
    """Ombú: tronco sólido + tarjetas de follaje abiertas."""
    base = dict(
        name="ombu_phytolacca",
        verts=42_000, edges=80_000, faces=40_000, tris=60_000, quads=2_000, ngons=0,
        dimensions=(6.0, 6.0, 9.0), surface_area=90.0, volume=0.0,
        planar_ratio=0.62, sharp_edges_ratio=0.2, loose_parts=140,
        boundary_edges=24_000, uv_layers=1, materials=2, textured_materials=2,
        uses_nodes=True, texture_resolution=2048, shade_smooth=True,
        edge_length_mean=0.12, edge_length_std=0.05,
    )
    base.update(kw)
    return MeshStats(**base)


def scan_stats(**kw) -> MeshStats:
    """Escaneo crudo de fotogrametría."""
    base = dict(
        name="zapican_scan_raw",
        verts=452_000, edges=1_350_000, faces=900_000, tris=900_000, quads=0, ngons=0,
        dimensions=(1.10, 0.90, 2.60), surface_area=9.0,
        planar_ratio=0.12, sharp_edges_ratio=0.1, curvature_std=0.4,
        non_manifold_edges=30_000, boundary_edges=40_000, loose_parts=6,
        vertex_color_layers=1, materials=1, textured_materials=1, uses_nodes=True,
        uv_layers=1, texture_resolution=8192,
        edge_length_mean=0.004, edge_length_std=0.0035, symmetry_x=0.4,
    )
    base.update(kw)
    return MeshStats(**base)


def statue_stats(**kw) -> MeshStats:
    """Estatua limpia, sin rig, un material."""
    base = dict(
        name="estatua_zapican",
        verts=30_000, edges=60_000, faces=30_000, tris=58_000, quads=28_000, ngons=0,
        dimensions=(1.0, 0.8, 2.4), surface_area=8.0, volume=0.35,
        planar_ratio=0.12, sharp_edges_ratio=0.1, curvature_std=0.28,
        symmetry_x=0.86, loose_parts=1, uv_layers=1, materials=1,
        textured_materials=1, uses_nodes=True, texture_resolution=4096,
        has_normal_map=True, shade_smooth=True,
        edge_length_mean=0.03, edge_length_std=0.008,
    )
    base.update(kw)
    return MeshStats(**base)


def box_stats(**kw) -> MeshStats:
    """Caja: el caso donde subdividir sería absurdo."""
    base = dict(
        name="caja_simple",
        verts=8, edges=12, faces=6, tris=12, quads=6, ngons=0,
        dimensions=(1.0, 1.0, 1.0), surface_area=6.0, volume=1.0,
        planar_ratio=1.0, sharp_edges_ratio=1.0, loose_parts=1,
    )
    base.update(kw)
    return MeshStats(**base)


# ---------------------------------------------------------------- MeshStats


class TestMeshStats(unittest.TestCase):
    def test_density_usa_area_no_conteo(self):
        chico = MeshStats(tris=20_000, surface_area=0.3)
        grande = MeshStats(tris=100_000, surface_area=90.0)
        self.assertGreater(chico.density, grande.density)

    def test_density_cero_sin_area(self):
        self.assertEqual(MeshStats(tris=1000, surface_area=0.0).density, 0.0)

    def test_quad_ratio_y_tri_ratio(self):
        s = MeshStats(faces=100, quads=60, ngons=10)
        self.assertAlmostEqual(s.quad_ratio, 0.6)
        self.assertAlmostEqual(s.tri_ratio, 0.3)

    def test_ratios_sin_caras_no_explotan(self):
        s = MeshStats()
        self.assertEqual(s.quad_ratio, 0.0)
        self.assertEqual(s.tri_ratio, 0.0)
        self.assertEqual(s.boundary_ratio, 0.0)
        self.assertEqual(s.non_manifold_ratio, 0.0)

    def test_aspect_tall_detecta_porte_vertical(self):
        self.assertAlmostEqual(MeshStats(dimensions=(1, 1, 3)).aspect_tall, 3.0)
        self.assertAlmostEqual(MeshStats(dimensions=(4, 2, 1)).aspect_tall, 0.25)

    def test_is_scaled(self):
        self.assertFalse(MeshStats(scale=(1.0, 1.0, 1.0)).is_scaled)
        self.assertTrue(MeshStats(scale=(1.0, 2.5, 1.0)).is_scaled)

    def test_watertight(self):
        self.assertTrue(MeshStats(faces=10).is_watertight)
        self.assertFalse(MeshStats(faces=10, boundary_edges=4).is_watertight)
        self.assertFalse(MeshStats(faces=10, non_manifold_edges=1).is_watertight)

    def test_edge_length_cv(self):
        self.assertAlmostEqual(MeshStats(edge_length_mean=0.1, edge_length_std=0.05).edge_length_cv, 0.5)
        self.assertEqual(MeshStats().edge_length_cv, 0.0)

    def test_to_dict_serializa(self):
        d = animal_stats().to_dict()
        self.assertEqual(d["name"], "carpincho_lowpoly")
        self.assertIn("planar_ratio", d)


# ----------------------------------------------------------------- scoring


class TestScoring(unittest.TestCase):
    def test_malla_vacia_no_puntua(self):
        card = build_scorecard(MeshStats())
        self.assertEqual(card.topology, 0.0)
        self.assertEqual(card.geometry, 0.0)

    def test_ejes_en_rango(self):
        for stats in (animal_stats(), tree_stats(), scan_stats(), statue_stats(), box_stats()):
            card = build_scorecard(stats)
            for axis in ScoreCard.AXES:
                v = getattr(card, axis)
                self.assertGreaterEqual(v, 0.0, f"{stats.name}/{axis}")
                self.assertLessEqual(v, 100.0, f"{stats.name}/{axis}")
            self.assertGreaterEqual(card.overall, 0.0)
            self.assertLessEqual(card.overall, 100.0)

    def test_escaneo_superficie_buena_topologia_mala(self):
        """La firma del escaneo: no se puede resumir en un número solo."""
        card = build_scorecard(scan_stats())
        self.assertLess(card.topology, 55.0)
        self.assertGreater(card.geometry, 80.0)

    def test_topologia_limpia_puntua_mas_que_sucia(self):
        limpia, _ = score_topology(statue_stats())
        sucia, _ = score_topology(statue_stats(non_manifold_edges=5_000, ngons=9_000, duplicate_verts=2_000))
        self.assertGreater(limpia, sucia + 15)

    def test_un_defecto_no_anula_un_eje(self):
        """Las penalizaciones están acotadas a propósito."""
        score, _ = score_topology(statue_stats(non_manifold_edges=60_000))
        self.assertGreater(score, 10.0)

    def test_geometria_premia_densidad_no_conteo(self):
        denso, _ = score_geometry(MeshStats(tris=20_000, faces=10_000, surface_area=0.05))
        disperso, _ = score_geometry(MeshStats(tris=100_000, faces=50_000, surface_area=400.0))
        self.assertGreater(denso, disperso)

    def test_vr_penaliza_exceso_de_triangulos(self):
        liviano = build_scorecard(animal_stats())
        pesado = build_scorecard(animal_stats(tris=900_000))
        self.assertGreater(liviano.vr_readiness, pesado.vr_readiness)

    def test_sin_uvs_textura_es_cero(self):
        card = build_scorecard(animal_stats(uv_layers=0))
        self.assertEqual(card.texture, 0.0)
        self.assertTrue(any("UVs" in i for i in card.issues))

    def test_overall_es_ponderado_no_promedio(self):
        card = ScoreCard(topology=100, geometry=100, surface=0, texture=0,
                         material=0, silhouette=0, vr_readiness=0)
        self.assertAlmostEqual(card.overall, 44.0, places=1)

    def test_delta_antes_despues(self):
        antes = build_scorecard(scan_stats())
        despues = build_scorecard(statue_stats())
        d = antes.delta(despues)
        self.assertIn("overall", d)
        self.assertEqual(len(d["topology"]), 2)
        self.assertGreater(d["topology"][1], d["topology"][0])

    def test_issues_explican_el_puntaje(self):
        card = build_scorecard(animal_stats(uv_layers=0, flipped_normals=500, shade_smooth=False))
        self.assertTrue(card.issues)
        self.assertTrue(any("normal" in i.lower() for i in card.issues))


# -------------------------------------------------------------- clasificación


class TestClassify(unittest.TestCase):
    def test_animal(self):
        c = classify_model(animal_stats())
        self.assertEqual(c.kind, ModelKind.ANIMAL)
        self.assertGreater(c.confidence, 0.4)
        self.assertTrue(c.is_organic)

    def test_arbol(self):
        c = classify_model(tree_stats())
        self.assertEqual(c.kind, ModelKind.TREE)
        self.assertTrue(c.is_foliage)

    def test_planta_baja_no_es_arbol(self):
        c = classify_model(tree_stats(
            name="cortadera_selloana", dimensions=(1.2, 1.2, 1.6),
            surface_area=8.0, loose_parts=60,
        ))
        self.assertEqual(c.kind, ModelKind.PLANT)

    def test_fotogrametria(self):
        c = classify_model(scan_stats())
        self.assertEqual(c.kind, ModelKind.PHOTOGRAMMETRY)
        self.assertGreater(c.photogrammetry_likelihood, 0.7)

    def test_estatua_no_es_personaje(self):
        """Sin rig y con un material: escultura, no personaje animable."""
        c = classify_model(statue_stats())
        self.assertIn(c.kind, (ModelKind.STATUE, ModelKind.HUMAN))
        self.assertEqual(c.kind, ModelKind.STATUE)

    def test_terreno(self):
        c = classify_model(MeshStats(
            name="terreno_pradera", verts=66_000, edges=130_000, faces=65_000, tris=130_000,
            quads=65_000, dimensions=(120.0, 120.0, 6.0), surface_area=14_000.0,
            planar_ratio=0.5, upward_face_ratio=0.93, loose_parts=1, boundary_edges=1_000,
        ))
        self.assertEqual(c.kind, ModelKind.TERRAIN)

    def test_arquitectura(self):
        c = classify_model(MeshStats(
            name="galpon", verts=900, edges=1_800, faces=880, tris=1_760, quads=850,
            dimensions=(12.0, 8.0, 5.0), surface_area=320.0,
            planar_ratio=0.95, sharp_edges_ratio=0.6, curvature_std=0.02, loose_parts=3,
        ))
        self.assertEqual(c.kind, ModelKind.ARCHITECTURE)

    def test_sin_caras_es_desconocido(self):
        c = classify_model(MeshStats(name="vacio"))
        self.assertEqual(c.kind, ModelKind.UNKNOWN)
        self.assertEqual(c.confidence, 0.0)

    def test_evidencia_sin_pistas_ambiguas(self):
        """Sin señales claras se admite 'no sé' en vez de inventar."""
        c = classify_model(MeshStats(faces=4, edges=8, verts=6, tris=8, dimensions=(1, 1, 1), surface_area=1.0))
        self.assertIn(c.kind, (ModelKind.UNKNOWN, ModelKind.RIGID_OBJECT))

    def test_nombre_ayuda_pero_no_manda_solo(self):
        """La geometría de follaje pesa más que un nombre de animal."""
        c = classify_model(tree_stats(name="capybara_tree_asset"))
        self.assertIn(c.kind, (ModelKind.TREE, ModelKind.PLANT))

    def test_armature_descarta_estatua(self):
        rig = classify_model(statue_stats(has_armature=True, vertex_groups=40))
        self.assertNotEqual(rig.kind, ModelKind.STATUE)

    def test_photogrammetry_score_baja_con_rig(self):
        sin_rig, _ = photogrammetry_score(scan_stats())
        con_rig, _ = photogrammetry_score(scan_stats(has_armature=True))
        self.assertGreater(sin_rig, con_rig)

    def test_scores_incluyen_todas_las_categorias(self):
        c = classify_model(animal_stats())
        self.assertEqual(len(c.scores), len(ModelKind))

    def test_describe_es_legible(self):
        texto = classify_model(animal_stats()).describe()
        self.assertIn("Animal", texto)
        self.assertIn("confianza", texto)


# ------------------------------------------------------------------ presets


class TestPresets(unittest.TestCase):
    def test_son_ocho(self):
        self.assertEqual(len(PRESETS), 8)

    def test_follaje_prohibe_voxel_remesh(self):
        """La regla que salva los árboles."""
        for key in ("TREE", "PLANT"):
            p = get_preset(key)
            self.assertFalse(p.allow_voxel_remesh, key)
            self.assertTrue(p.preserve_open_boundaries, key)

    def test_fotogrametria_no_subdivide(self):
        p = get_preset("PHOTOGRAMMETRY")
        self.assertFalse(p.allow_subdivision)
        self.assertEqual(p.max_subdiv_levels, 0)
        self.assertTrue(p.allow_quad_retopo)

    def test_clave_desconocida_cae_en_conservador(self):
        self.assertEqual(get_preset("NO_EXISTE").key, "OBJECT")

    def test_lods_decrecientes(self):
        for key, p in PRESETS.items():
            vals = [p.lod_budgets[k] for k in ("LOD0", "LOD1", "LOD2", "LOD3")]
            self.assertEqual(vals, sorted(vals, reverse=True), key)

    def test_vr_mas_barato_que_cinematografico(self):
        self.assertLess(get_preset("VR").lod_budgets["LOD0"],
                        get_preset("CINEMATIC_ULTRA").lod_budgets["LOD0"])

    def test_tolerancias_coherentes(self):
        """Follaje tolera más desviación que una estatua; no al revés."""
        self.assertGreater(get_preset("TREE").deviation_tolerance,
                           get_preset("STATUE").deviation_tolerance)
        self.assertGreater(get_preset("TREE").volume_tolerance,
                           get_preset("STATUE").volume_tolerance)

    def test_mapa_categoria_preset_completo(self):
        for kind in ModelKind:
            self.assertIsNotNone(preset_for_kind(kind))

    def test_humano_usa_reglas_de_animal(self):
        self.assertEqual(preset_for_kind(ModelKind.HUMAN).key, "ANIMAL")

    def test_override_manual_gana(self):
        c = classify_model(tree_stats())
        self.assertEqual(preset_for_classification(c, "STATUE").key, "STATUE")

    def test_clasificacion_dudosa_usa_conservador(self):
        dudosa = Classification(kind=ModelKind.TREE, confidence=0.2)
        self.assertEqual(preset_for_classification(dudosa).key, "OBJECT")

    def test_auto_respeta_la_clasificacion(self):
        c = classify_model(tree_stats())
        self.assertEqual(preset_for_classification(c, "AUTO").key, "TREE")


# ----------------------------------------------------------------- planning


class TestHardware(unittest.TestCase):
    def test_memoria_crece_con_triangulos(self):
        self.assertGreater(estimate_peak_memory_gb(8_000_000), estimate_peak_memory_gb(1_000_000))

    def test_objetivo_se_recorta_en_maquina_chica(self):
        chico, aviso = safe_target_tris(HardwareProfile(ram_gb=8), 12_000_000)
        self.assertLess(chico, 12_000_000)
        self.assertIsNotNone(aviso)
        self.assertIn("RAM", aviso)

    def test_maquina_grande_no_recorta(self):
        objetivo, aviso = safe_target_tris(HardwareProfile(ram_gb=128), 4_000_000)
        self.assertEqual(objetivo, 4_000_000)
        self.assertIsNone(aviso)

    def test_recorte_nunca_deja_objetivo_inutil(self):
        objetivo, _ = safe_target_tris(HardwareProfile(ram_gb=2), 12_000_000)
        self.assertGreaterEqual(objetivo, 50_000)


class TestAdaptiveSubdivision(unittest.TestCase):
    def test_reparte_menos_que_uniforme(self):
        plan = adaptive_subdivision_plan(100_000, 3_000_000, 3, [0.6, 0.25, 0.15])
        self.assertLess(plan.expected_tris, plan.uniform_tris)
        self.assertGreater(plan.savings_ratio, 0.2)

    def test_lo_plano_no_recibe_el_maximo(self):
        plan = adaptive_subdivision_plan(50_000, 2_000_000, 4, [0.7, 0.2, 0.1])
        self.assertLessEqual(plan.bands[0].levels, 1)
        self.assertGreaterEqual(plan.bands[-1].levels, plan.bands[0].levels)

    def test_sin_curvatura_avisa_que_es_uniforme(self):
        plan = adaptive_subdivision_plan(10_000, 500_000, 2, None)
        self.assertFalse(plan.adaptive)
        self.assertEqual(plan.expected_tris, plan.uniform_tris)
        self.assertTrue(any("uniforme" in n.lower() for n in plan.notes))

    def test_niveles_cero_no_subdivide(self):
        plan = adaptive_subdivision_plan(10_000, 10_000, 0, [0.5, 0.5])
        self.assertEqual(plan.expected_tris, 10_000)
        self.assertFalse(plan.adaptive)

    def test_baja_nivel_si_se_pasa_del_objetivo(self):
        plan = adaptive_subdivision_plan(200_000, 300_000, 4, [0.3, 0.3, 0.4])
        self.assertLess(plan.max_levels, 4)
        self.assertLessEqual(plan.expected_tris, 300_000 * 1.6)

    def test_umbrales_por_cuantiles(self):
        cortes = curvature_thresholds([0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8], 3)
        self.assertEqual(len(cortes), 2)
        self.assertLess(cortes[0], cortes[1])

    def test_umbrales_vacios_sin_datos(self):
        self.assertEqual(curvature_thresholds([], 3), [])

    def test_fracciones_se_normalizan(self):
        plan = adaptive_subdivision_plan(10_000, 5_000_000, 2, [3, 1, 1])
        self.assertAlmostEqual(sum(b.fraction for b in plan.bands), 1.0, places=2)


class TestVoxelSize(unittest.TestCase):
    def test_escala_con_el_objeto(self):
        chico = voxel_size_for(animal_stats(), 200_000)
        grande = voxel_size_for(tree_stats(), 200_000)
        self.assertLess(chico, grande)

    def test_acotado_al_tamano(self):
        s = statue_stats()
        v = voxel_size_for(s, 50_000_000)
        self.assertGreaterEqual(v, s.max_dimension / 1024.0 - 1e-9)

    def test_sin_area_usa_bounding_box(self):
        v = voxel_size_for(MeshStats(dimensions=(2, 2, 2)), 100_000)
        self.assertGreater(v, 0.0)


class TestReconstructionPlan(unittest.TestCase):
    def _plan(self, stats, **kw):
        c = classify_model(stats)
        p = preset_for_classification(c)
        return build_reconstruction_plan(stats, c, p, HardwareProfile(ram_gb=32), **kw)

    def test_follaje_nunca_remeshea(self):
        plan = self._plan(tree_stats(), curvature_fractions=[0.5, 0.3, 0.2])
        self.assertEqual(plan.method, ReconstructionMethod.FOLIAGE_SAFE)
        self.assertEqual(plan.voxel_size, 0.0)
        self.assertIn(Stage.RETOPOLOGY.value, plan.skipped_stages)
        self.assertIn(Stage.HOLES.value, plan.skipped_stages)

    def test_escaneo_retopologiza_no_subdivide(self):
        plan = self._plan(scan_stats())
        self.assertEqual(plan.method, ReconstructionMethod.QUAD_RETOPO_FIRST)
        self.assertGreater(plan.retopo_target_faces, 0)
        self.assertIn(Stage.SUPER_RESOLUTION.value, plan.skipped_stages)

    def test_topologia_rota_genera_superficie_nueva(self):
        roto = statue_stats(non_manifold_edges=12_000, ngons=15_000, quads=5_000)
        plan = self._plan(roto)
        self.assertEqual(plan.method, ReconstructionMethod.REMESH_REPROJECT)
        self.assertGreater(plan.voxel_size, 0.0)
        self.assertTrue(plan.use_shrinkwrap)

    def test_modelo_ya_denso_no_se_infla(self):
        denso = statue_stats(
            verts=600_000, edges=1_200_000, faces=600_000, quads=580_000,
            tris=1_200_000, surface_area=8.0, edge_length_std=0.002,
        )
        plan = self._plan(denso)
        self.assertEqual(plan.method, ReconstructionMethod.DETAIL_ONLY)

    def test_malla_sana_con_uvs_usa_multires(self):
        plan = self._plan(statue_stats(), curvature_fractions=[0.4, 0.35, 0.25])
        self.assertEqual(plan.method, ReconstructionMethod.MULTIRES_SCULPT)
        self.assertIsNotNone(plan.subdivision)

    def test_caja_no_termina_en_millones(self):
        """Subdividir una caja sin curvatura no agrega información."""
        plan = self._plan(box_stats(), curvature_fractions=[1.0])
        if plan.subdivision:
            self.assertLess(plan.subdivision.expected_tris, 50_000)

    def test_rig_avisa_sobre_pesos(self):
        roto = animal_stats(non_manifold_edges=9_000, edges=16_000, ngons=6_000, quads=1_000)
        plan = self._plan(roto)
        self.assertEqual(plan.method, ReconstructionMethod.REMESH_REPROJECT)
        self.assertTrue(any("vertex group" in w.lower() for w in plan.warnings))

    def test_shape_keys_advertidas(self):
        plan = self._plan(animal_stats(shape_keys=12))
        self.assertTrue(any("shape key" in w.lower() for w in plan.warnings))

    def test_sin_uvs_planifica_unwrap(self):
        plan = self._plan(animal_stats(uv_layers=0))
        self.assertTrue(plan.needs_uv_unwrap)
        self.assertIn(Stage.UV_BUILD.value, plan.stages)

    def test_con_uvs_salta_unwrap(self):
        plan = self._plan(animal_stats())
        self.assertIn(Stage.UV_BUILD.value, plan.skipped_stages)

    def test_etapas_en_orden_del_pipeline(self):
        plan = self._plan(statue_stats(), curvature_fractions=[0.4, 0.35, 0.25])
        orden = [s.value for s in STAGE_ORDER]
        posiciones = [orden.index(s) for s in plan.stages]
        self.assertEqual(posiciones, sorted(posiciones))

    def test_son_veintiseis_etapas(self):
        self.assertEqual(len(STAGE_ORDER), 26)

    def test_etapas_saltadas_llevan_motivo(self):
        plan = self._plan(tree_stats(), curvature_fractions=[0.5, 0.3, 0.2])
        for stage, motivo in plan.skipped_stages.items():
            self.assertTrue(motivo.strip(), stage)

    def test_checkpoints_son_subconjunto_de_etapas(self):
        plan = self._plan(statue_stats(), curvature_fractions=[0.4, 0.35, 0.25])
        self.assertTrue(set(plan.checkpoints).issubset(set(plan.stages)))
        self.assertTrue(set(plan.checkpoints).issubset({c.value for c in CHECKPOINT_STAGES}))

    def test_backup_siempre_presente(self):
        """Nunca se modifica el original: el respaldo no es opcional."""
        for stats in (animal_stats(), tree_stats(), scan_stats(), statue_stats()):
            plan = self._plan(stats)
            self.assertIn(Stage.BACKUP.value, plan.stages, stats.name)

    def test_hardware_chico_recorta_y_avisa(self):
        c = classify_model(statue_stats())
        p = preset_for_classification(c)
        plan = build_reconstruction_plan(statue_stats(), c, p, HardwareProfile(ram_gb=4),
                                         curvature_fractions=[0.4, 0.35, 0.25])
        self.assertTrue(any("RAM" in w for w in plan.warnings))

    def test_modo_extremo_sube_el_objetivo(self):
        c = classify_model(statue_stats())
        p = preset_for_classification(c)
        hw = HardwareProfile(ram_gb=256)
        normal = build_reconstruction_plan(statue_stats(), c, p, hw, [0.4, 0.35, 0.25], False)
        extremo = build_reconstruction_plan(statue_stats(), c, p, hw, [0.4, 0.35, 0.25], True)
        self.assertGreater(extremo.master_target_tris, normal.master_target_tris)

    def test_limitaciones_declaradas(self):
        plan = self._plan(statue_stats(), curvature_fractions=[0.4, 0.35, 0.25])
        self.assertTrue(plan.limitations)
        self.assertTrue(any("Hausdorff" in l for l in plan.limitations))

    def test_plan_serializable(self):
        d = self._plan(animal_stats()).to_dict()
        self.assertIsInstance(d["method"], str)
        self.assertIsInstance(d["kind"], str)


# ---------------------------------------------------------------- deviation


class TestPercentile(unittest.TestCase):
    def test_extremos(self):
        vals = [1, 2, 3, 4, 5]
        self.assertEqual(percentile(vals, 0.0), 1)
        self.assertEqual(percentile(vals, 1.0), 5)

    def test_interpola(self):
        self.assertAlmostEqual(percentile([0.0, 10.0], 0.5), 5.0)

    def test_vacio(self):
        self.assertEqual(percentile([], 0.5), 0.0)

    def test_un_solo_valor(self):
        self.assertEqual(percentile([7.0], 0.9), 7.0)


class TestDeviation(unittest.TestCase):
    def test_normaliza_por_tamano(self):
        """2 mm es nada en una estatua y mucho en un colibrí."""
        grande = summarize_distances([0.002] * 3_000, 3.0)
        chico = summarize_distances([0.002] * 3_000, 0.05)
        self.assertLess(grande.p99, chico.p99)

    def test_marca_muestreo_insuficiente(self):
        self.assertFalse(summarize_distances([0.001] * 50, 1.0).reliable)
        self.assertTrue(summarize_distances([0.001] * 5_000, 1.0).reliable)

    def test_sin_datos_no_inventa(self):
        s = summarize_distances([], 1.0)
        self.assertEqual(s.samples, 0)
        self.assertFalse(s.reliable)

    def test_detecta_detalle_perdido(self):
        """Ida mucho peor que vuelta = al resultado le falta algo del original."""
        h = bidirectional_deviation([0.05] * 3_000, [0.001] * 3_000, 1.0)
        self.assertTrue(h.lost_detail)
        self.assertFalse(h.added_geometry)

    def test_detecta_geometria_inventada(self):
        h = bidirectional_deviation([0.001] * 3_000, [0.05] * 3_000, 1.0)
        self.assertTrue(h.added_geometry)
        self.assertFalse(h.lost_detail)

    def test_simetrico_toma_el_peor(self):
        h = bidirectional_deviation([0.01] * 100, [0.03] * 100, 1.0)
        self.assertAlmostEqual(h.symmetric_max, 0.03, places=4)

    def test_medicion_unidireccional_ocultaria_la_perdida(self):
        """Justificación de medir en los dos sentidos."""
        h = bidirectional_deviation([0.08] * 3_000, [0.0005] * 3_000, 1.0)
        self.assertLess(h.backward.p99, 0.001)
        self.assertGreater(h.symmetric_p99, 0.05)

    def test_veredictos_por_umbral_absoluto(self):
        self.assertEqual(classify_deviation(0.0005), DeviationVerdict.EXCELLENT)
        self.assertEqual(classify_deviation(0.003), DeviationVerdict.GOOD)
        self.assertEqual(classify_deviation(0.008), DeviationVerdict.ACCEPTABLE)
        self.assertEqual(classify_deviation(0.02), DeviationVerdict.DRIFTED)
        self.assertEqual(classify_deviation(0.5), DeviationVerdict.BROKEN)

    def test_veredicto_escala_con_la_tolerancia_del_preset(self):
        valor = 0.005
        self.assertEqual(classify_deviation(valor, get_preset("TREE").deviation_tolerance),
                         DeviationVerdict.GOOD)
        self.assertEqual(classify_deviation(valor, get_preset("STATUE").deviation_tolerance),
                         DeviationVerdict.ACCEPTABLE)

    def test_valor_negativo_es_no_medido(self):
        self.assertEqual(classify_deviation(-1.0), DeviationVerdict.UNMEASURED)


class TestSilhouette(unittest.TestCase):
    def test_coincidencia_total_no_da_error(self):
        self.assertAlmostEqual(silhouette_error(1_000, 1_000, 1_000), 0.0)

    def test_es_simetrica_en_las_dos_mallas(self):
        """Intercambiar original y reconstruido no cambia el error."""
        self.assertAlmostEqual(silhouette_error(800, 1_000, 850),
                               silhouette_error(800, 850, 1_000), places=6)

    def test_penaliza_comer_y_penaliza_inflar(self):
        """Un modelo inflado está tan mal como uno comido; ninguno da cero."""
        comido = silhouette_error(800, 1_000, 800)
        inflado = silhouette_error(1_000, 1_000, 1_250)
        self.assertGreater(comido, 0.0)
        self.assertGreater(inflado, 0.0)
        self.assertAlmostEqual(comido, inflado, places=3)

    def test_union_vacia_no_explota(self):
        self.assertEqual(silhouette_error(0, 0, 0), 0.0)

    def test_manda_la_peor_vista(self):
        """Seis vistas buenas no compensan una rota."""
        r = combine_silhouettes({"frente": 0.002, "izq": 0.002, "der": 0.09, "arriba": 0.003})
        self.assertEqual(r.worst_view, "der")
        self.assertAlmostEqual(r.worst_error, 0.09, places=4)
        self.assertLess(r.mean_error, r.worst_error)

    def test_sin_vistas(self):
        r = combine_silhouettes({})
        self.assertEqual(r.views, 0)


class TestVolume(unittest.TestCase):
    def test_error_relativo(self):
        self.assertAlmostEqual(volume_error(1.0, 1.1), 0.1, places=5)

    def test_sin_volumen_devuelve_no_medible(self):
        self.assertEqual(volume_error(0.0, 1.0), -1.0)

    def test_colapso_e_inflado_pesan_igual(self):
        self.assertAlmostEqual(volume_error(1.0, 0.8), volume_error(1.0, 1.2), places=5)


class TestFidelityReport(unittest.TestCase):
    def _report(self, fwd, bwd, sil, vol, preset_key):
        h = bidirectional_deviation(fwd, bwd, 1.0)
        s = combine_silhouettes(sil) if sil else None
        return build_fidelity_report(h, s, vol, get_preset(preset_key))

    def test_todo_bien_pasa(self):
        r = self._report([0.0005] * 3_000, [0.0005] * 3_000,
                         {"frente": 0.001, "lado": 0.002}, 0.005, "STATUE")
        self.assertTrue(r.passed)
        self.assertEqual(r.verdict, DeviationVerdict.EXCELLENT)

    def test_silueta_rota_reprueba_aunque_la_distancia_sea_buena(self):
        r = self._report([0.0005] * 3_000, [0.0005] * 3_000,
                         {"frente": 0.001, "lado": 0.40}, 0.005, "STATUE")
        self.assertFalse(r.passed)
        self.assertTrue(any("silueta" in p.lower() for p in r.problems))

    def test_volumen_fuera_de_tolerancia_reprueba(self):
        r = self._report([0.0005] * 3_000, [0.0005] * 3_000, {"frente": 0.001}, 0.5, "STATUE")
        self.assertFalse(r.passed)
        self.assertTrue(any("volumen" in p.lower() for p in r.problems))

    def test_follaje_tolera_volumen_que_una_estatua_no(self):
        sil = {"frente": 0.01}
        arbol = self._report([0.001] * 3_000, [0.001] * 3_000, sil, 0.25, "TREE")
        estatua = self._report([0.001] * 3_000, [0.001] * 3_000, sil, 0.25, "STATUE")
        self.assertTrue(arbol.passed)
        self.assertFalse(estatua.passed)

    def test_detalle_perdido_propone_que_hacer(self):
        r = self._report([0.05] * 3_000, [0.0005] * 3_000, {"frente": 0.002}, 0.01, "STATUE")
        self.assertTrue(r.recommendations)
        self.assertTrue(any("perdió detalle" in p for p in r.problems))

    def test_geometria_inventada_sugiere_desactivar_voxel(self):
        r = self._report([0.0005] * 3_000, [0.05] * 3_000, {"frente": 0.002}, 0.01, "STATUE")
        self.assertTrue(any("voxel" in rec.lower() for rec in r.recommendations))

    def test_sin_mediciones_no_finge_aprobar(self):
        r = build_fidelity_report(None, None, -1.0, get_preset("OBJECT"))
        self.assertEqual(r.verdict, DeviationVerdict.UNMEASURED)
        self.assertFalse(r.passed)

    def test_muestreo_pobre_queda_registrado(self):
        r = self._report([0.001] * 100, [0.001] * 100, {"frente": 0.001}, 0.01, "OBJECT")
        self.assertTrue(any("muestras" in p for p in r.problems))

    def test_serializable(self):
        d = self._report([0.001] * 3_000, [0.001] * 3_000, {"frente": 0.001}, 0.01, "OBJECT").to_dict()
        self.assertIn("verdict", d)
        self.assertIsInstance(d["verdict"], str)


# ---------------------------------------------------- integración end-to-end


class TestIntegracion(unittest.TestCase):
    def test_cada_arquetipo_recorre_el_pipeline(self):
        for stats in (animal_stats(), tree_stats(), scan_stats(), statue_stats(), box_stats()):
            c = classify_model(stats)
            p = preset_for_classification(c)
            plan = build_reconstruction_plan(stats, c, p, HardwareProfile(ram_gb=32),
                                             [0.5, 0.3, 0.2])
            card = build_scorecard(stats)
            self.assertTrue(plan.stages, stats.name)
            self.assertIn(Stage.REPORT.value, plan.stages, stats.name)
            self.assertGreaterEqual(card.overall, 0.0, stats.name)

    def test_la_mejora_se_ve_en_el_puntaje(self):
        """Antes → después: es lo que el informe final tiene que mostrar."""
        antes = build_scorecard(scan_stats())
        despues = build_scorecard(scan_stats(
            quads=440_000, faces=450_000, tris=900_000, non_manifold_edges=0,
            boundary_edges=0, loose_parts=1, shade_smooth=True, has_normal_map=True,
            has_roughness_map=True, has_ao_map=True, texture_resolution=4096,
            uv_overlap_ratio=0.0, edge_length_std=0.0004,
        ))
        self.assertGreater(despues.overall, antes.overall)
        self.assertGreater(despues.topology, antes.topology + 20)


if __name__ == "__main__":
    unittest.main(verbosity=2)
