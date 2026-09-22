"""Tests de la lógica de decisión. Corren SIN Blender:

    python3 -m unittest discover -s tools/blender_model_enhancer/tests

Cubren justamente lo que el sistema tiene que hacer bien: no subdividir a
ciegas, adaptar los objetivos al modelo, y detectar cuándo un resultado
perdió la forma original.
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from blender_model_enhancer.core.metrics import (  # noqa: E402
    LOD_ORDER,
    MeshClass,
    MeshStats,
    Strategy,
    TopologyQuality,
    build_plan,
    classify_density,
    classify_topology,
    decimate_ratio,
    plan_targets,
    subdivision_levels_for,
    voxel_size_for,
)
from blender_model_enhancer.core.quality import (  # noqa: E402
    Verdict,
    build_quality_report,
    classify_deviation,
    percentile,
    relax_settings,
)


def clean_mesh(tris: int, **kw) -> MeshStats:
    """Malla sana: quads, manifold, con UVs. Base sintética para los casos."""
    faces = max(1, tris // 2)
    defaults = dict(
        name="test",
        verts=max(4, tris // 2),
        edges=max(6, tris * 2),
        faces=faces,
        tris=tris,
        quads=faces,
        ngons=0,
        uv_layers=1,
        materials=1,
        dimensions=(1.0, 1.0, 1.0),
        scale=(1.0, 1.0, 1.0),
        volume=1.0,
        surface_area=6.0,
    )
    defaults.update(kw)
    return MeshStats(**defaults)


class TestDensityClassification(unittest.TestCase):
    def test_bands(self):
        self.assertIs(classify_density(500), MeshClass.VERY_LOW)
        self.assertIs(classify_density(5_000), MeshClass.LOW)
        self.assertIs(classify_density(50_000), MeshClass.MEDIUM)
        self.assertIs(classify_density(300_000), MeshClass.HIGH)
        self.assertIs(classify_density(2_000_000), MeshClass.VERY_HIGH)

    def test_boundaries_are_exclusive(self):
        self.assertIs(classify_density(999), MeshClass.VERY_LOW)
        self.assertIs(classify_density(1_000), MeshClass.LOW)
        self.assertIs(classify_density(799_999), MeshClass.HIGH)
        self.assertIs(classify_density(800_000), MeshClass.VERY_HIGH)


class TestTopologyClassification(unittest.TestCase):
    def test_clean_mesh(self):
        self.assertIs(classify_topology(clean_mesh(10_000)), TopologyQuality.CLEAN)

    def test_empty_mesh_is_broken(self):
        self.assertIs(classify_topology(MeshStats()), TopologyQuality.BROKEN)

    def test_flipped_normals_downgrade_to_acceptable(self):
        stats = clean_mesh(10_000, flipped_normals=3)
        self.assertIs(classify_topology(stats), TopologyQuality.ACCEPTABLE)

    def test_heavy_ngons_are_poor(self):
        stats = clean_mesh(10_000, ngons=3_000, quads=2_000)
        self.assertIs(classify_topology(stats), TopologyQuality.POOR)

    def test_massive_non_manifold_is_broken(self):
        stats = clean_mesh(10_000, non_manifold_edges=8_000)
        self.assertIs(classify_topology(stats), TopologyQuality.BROKEN)

    def test_interior_faces_break_mesh(self):
        stats = clean_mesh(10_000, interior_faces=2_000)
        self.assertIs(classify_topology(stats), TopologyQuality.BROKEN)


class TestStrategy(unittest.TestCase):
    def test_dense_scan_is_not_subdivided(self):
        """El caso que el brief marca como error: no inflar lo que ya es denso."""
        plan = build_plan(clean_mesh(1_500_000))
        self.assertIs(plan.strategy, Strategy.DETAIL_ONLY)
        self.assertEqual(plan.subdivision_levels, 0)

    def test_clean_quads_with_uvs_use_multires(self):
        plan = build_plan(clean_mesh(20_000))
        self.assertIs(plan.strategy, Strategy.MULTIRES)
        self.assertGreater(plan.subdivision_levels, 0)

    def test_no_uvs_falls_back_to_subdivide(self):
        plan = build_plan(clean_mesh(20_000, uv_layers=0))
        self.assertIs(plan.strategy, Strategy.SUBDIVIDE)
        self.assertTrue(plan.needs_uv_unwrap)

    def test_broken_topology_triggers_remesh_and_shrinkwrap(self):
        stats = clean_mesh(20_000, non_manifold_edges=30_000)
        plan = build_plan(stats)
        self.assertIs(plan.strategy, Strategy.REMESH_SHRINKWRAP)
        self.assertTrue(plan.use_shrinkwrap)
        self.assertGreater(plan.voxel_size, 0.0)

    def test_triangle_soup_is_remeshed(self):
        stats = clean_mesh(20_000, quads=0, ngons=9_000)
        plan = build_plan(stats)
        self.assertIs(plan.strategy, Strategy.REMESH_SHRINKWRAP)


class TestSubdivisionLevels(unittest.TestCase):
    def test_no_subdivision_when_target_below_current(self):
        self.assertEqual(subdivision_levels_for(100_000, 50_000), 0)

    def test_levels_grow_with_target(self):
        self.assertGreaterEqual(subdivision_levels_for(1_000, 1_000_000), 3)

    def test_capped_at_max_levels(self):
        self.assertLessEqual(subdivision_levels_for(10, 10_000_000_000), 4)

    def test_zero_geometry_is_safe(self):
        self.assertEqual(subdivision_levels_for(0, 100_000), 0)


class TestTargets(unittest.TestCase):
    def test_levels_are_strictly_descending(self):
        for tris in (300, 5_000, 60_000, 400_000, 2_000_000):
            targets = plan_targets(clean_mesh(tris), classify_density(tris))
            values = [targets[k] for k in LOD_ORDER]
            self.assertEqual(
                values, sorted(values, reverse=True), f"orden roto con {tris} tris"
            )
            self.assertTrue(all(v > 0 for v in values))

    def test_simple_model_gets_modest_master(self):
        """Un arbusto de 800 tris no necesita un master de 3M."""
        targets = plan_targets(clean_mesh(800), MeshClass.VERY_LOW)
        self.assertLess(targets["MASTER_HIGH"], 500_000)

    def test_scan_gets_full_budget(self):
        targets = plan_targets(clean_mesh(2_000_000), MeshClass.VERY_HIGH)
        self.assertGreaterEqual(targets["MASTER_HIGH"], 2_000_000)


class TestVoxelSize(unittest.TestCase):
    def test_scales_with_object_size(self):
        """El mismo objetivo en un objeto grande pide voxels más grandes."""
        small = MeshStats(tris=10_000, dimensions=(0.3, 0.3, 0.3), surface_area=0.5)
        large = MeshStats(tris=10_000, dimensions=(12.0, 12.0, 12.0), surface_area=800.0)
        self.assertLess(voxel_size_for(small, 500_000), voxel_size_for(large, 500_000))

    def test_never_finer_than_bbox_fraction(self):
        stats = MeshStats(dimensions=(2.0, 2.0, 2.0), surface_area=24.0)
        self.assertGreaterEqual(voxel_size_for(stats, 10**9), 2.0 / 1024.0)

    def test_never_coarser_than_bbox_fraction(self):
        stats = MeshStats(dimensions=(2.0, 2.0, 2.0), surface_area=24.0)
        self.assertLessEqual(voxel_size_for(stats, 1), 2.0 / 16.0)

    def test_degenerate_input_does_not_crash(self):
        self.assertGreater(voxel_size_for(MeshStats(), 1000), 0.0)


class TestPlanFlags(unittest.TestCase):
    def test_armature_raises_warning_and_is_preserved(self):
        plan = build_plan(clean_mesh(20_000, has_armature=True, vertex_groups=12))
        self.assertTrue(plan.preserve_armature)
        self.assertTrue(any("armature" in w.lower() for w in plan.warnings))

    def test_shape_keys_warn(self):
        plan = build_plan(clean_mesh(20_000, shape_keys=4))
        self.assertTrue(any("shape key" in w.lower() for w in plan.warnings))

    def test_unapplied_scale_is_flagged(self):
        plan = build_plan(clean_mesh(20_000, scale=(2.0, 2.0, 2.0)))
        self.assertTrue(plan.needs_scale_apply)

    def test_displacement_only_with_textures_and_uvs(self):
        self.assertFalse(build_plan(clean_mesh(20_000, textured_materials=0)).bake_displacement)
        self.assertTrue(build_plan(clean_mesh(20_000, textured_materials=2)).bake_displacement)
        self.assertFalse(
            build_plan(clean_mesh(20_000, textured_materials=2, uv_layers=0)).bake_displacement
        )

    def test_open_borders_are_respected_not_repaired(self):
        """Las hojas y alpha cards son superficies abiertas a propósito."""
        plan = build_plan(clean_mesh(20_000, boundary_edges=400))
        self.assertTrue(any("alpha card" in n.lower() for n in plan.notes))


class TestDecimateRatio(unittest.TestCase):
    def test_basic_ratio(self):
        self.assertAlmostEqual(decimate_ratio(100_000, 25_000), 0.25)

    def test_never_above_one(self):
        self.assertEqual(decimate_ratio(1_000, 50_000), 1.0)

    def test_has_floor(self):
        self.assertGreaterEqual(decimate_ratio(10_000_000, 1), 0.005)

    def test_zero_is_safe(self):
        self.assertEqual(decimate_ratio(0, 1_000), 1.0)


class TestPercentile(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(percentile([], 0.95), 0.0)

    def test_single_value(self):
        self.assertEqual(percentile([5.0], 0.95), 5.0)

    def test_median(self):
        self.assertAlmostEqual(percentile([1.0, 2.0, 3.0], 0.5), 2.0)

    def test_p95_ignores_lone_outlier(self):
        values = [0.001] * 99 + [10.0]
        self.assertLess(percentile(values, 0.95), 1.0)


class TestQualityVerdict(unittest.TestCase):
    def test_faithful_result_passes(self):
        self.assertIs(classify_deviation(0.001, 0.003, 0.01), Verdict.PASS)

    def test_visible_but_tolerable(self):
        self.assertIs(classify_deviation(0.008, 0.02, 0.05), Verdict.ACCEPTABLE)

    def test_deformed_result_is_degraded(self):
        self.assertIs(classify_deviation(0.03, 0.05, 0.15), Verdict.DEGRADED)

    def test_destroyed_result_fails(self):
        self.assertIs(classify_deviation(0.2, 0.4, 0.5), Verdict.FAILED)

    def test_volume_loss_alone_downgrades(self):
        """Aunque la distancia media sea baja, perder 30% de volumen no pasa."""
        verdict = classify_deviation(0.002, 0.004, -0.30)
        self.assertIn(verdict, (Verdict.DEGRADED, Verdict.FAILED))


class TestQualityReport(unittest.TestCase):
    def test_deviations_are_relative_to_diagonal(self):
        """La misma desviación absoluta pesa distinto según el tamaño."""
        small = build_quality_report("LOD0", [0.01] * 10, 0.5, 1.0, 1.0, 1000)
        large = build_quality_report("LOD0", [0.01] * 10, 20.0, 1.0, 1.0, 1000)
        self.assertGreater(small.mean_deviation, large.mean_deviation)

    def test_volume_loss_reported(self):
        report = build_quality_report("LOD1", [0.0] * 5, 10.0, 1.0, 0.8, 5000)
        self.assertLess(report.volume_change, 0)
        self.assertTrue(any("volumen" in i.lower() for i in report.issues))

    def test_inflation_reported(self):
        report = build_quality_report("LOD1", [0.0] * 5, 10.0, 1.0, 1.3, 5000)
        self.assertGreater(report.volume_change, 0)
        self.assertTrue(any("inflado" in i.lower() for i in report.issues))

    def test_lost_uvs_flagged(self):
        report = build_quality_report("LOD2", [0.0], 10.0, 1.0, 1.0, 100, lost_uvs=True)
        self.assertTrue(any("uv" in i.lower() for i in report.issues))

    def test_degenerate_bbox_fails_safely(self):
        report = build_quality_report("LOD0", [1.0], 0.0, 1.0, 1.0, 100)
        self.assertIs(report.verdict, Verdict.FAILED)

    def test_needs_retry_only_when_bad(self):
        good = build_quality_report("LOD0", [0.001] * 10, 10.0, 1.0, 1.0, 1000)
        self.assertFalse(good.needs_retry)
        bad = build_quality_report("LOD0", [2.0] * 10, 10.0, 1.0, 0.4, 1000)
        self.assertTrue(bad.needs_retry)


class TestRelaxSettings(unittest.TestCase):
    def test_pass_does_not_change_strength(self):
        self.assertEqual(relax_settings(1.0, Verdict.PASS), 1.0)

    def test_degraded_reduces(self):
        self.assertLess(relax_settings(1.0, Verdict.DEGRADED), 1.0)

    def test_failed_reduces_more_than_degraded(self):
        self.assertLess(
            relax_settings(1.0, Verdict.FAILED), relax_settings(1.0, Verdict.DEGRADED)
        )

    def test_has_floor(self):
        strength = 1.0
        for _ in range(50):
            strength = relax_settings(strength, Verdict.FAILED)
        self.assertGreaterEqual(strength, 0.1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
