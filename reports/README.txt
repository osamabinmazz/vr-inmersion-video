Informes de las fases de mejora visual de ZAPICÁN.

VERSIONES
- v02:  snapshots/ZAPICAN_v02_materials_ground_water.js (antes de Fases 1-3)
- v051: snapshots/ZAPICAN_v051_ground_integration.js    (Fases 1-3)
- v060: snapshots/ZAPICAN_v060_before_midground_extension.js (= v051, backup antes de Fase 4)
- v061: snapshots/ZAPICAN_v061_midground_extension.js   (Fase 4, estado actual)
Las versiones intermedias (v030, v031, v040, v041, v050) no se guardaron en
su momento y no se pueden reconstruir. Desde ahora, cada fase queda como
commit propio en git.

CÁMARAS QC (viewer/src/main.js, QC_CAMERAS; window.__qc en modo dev)
QC_GROUND, QC_MID, QC_HIGH, QC_WATER, QC_TREE_CLOSE, QC_BUSH_CLOSE,
QC_REED_BASE, QC_HERO_WATER_EDGE, QC_HERO_TREE_FOREGROUND, QC_ROOT_CLOSE,
QC_MUD_TRANSITION, QC_WORST_CASE (Fase 4: el encuadre más caro medido).

COMPARATIVAS: comparisons/v02_vs_v051/ — las 11 cámaras, antes y después.

FASE 4 (plano medio y fondo)
- reports/phase4/MIDGROUND_AUDIT.txt         auditoría y clasificación por asset
- reports/phase4/PHASE4_MIDGROUND_REPORT.txt informe de la fase
- performance/phase4/PERFORMANCE_BEFORE_AFTER.txt  tablas medidas
- performance/phase4/BEFORE_MIDGROUND.json, AFTER_MIDGROUND.json  datos crudos
- comparisons/phase4/  BEFORE_/AFTER_MIDGROUND_<cámara>.jpg y COMPARE_<cámara>.jpg
  (QC_GROUND, QC_MID, QC_HIGH, QC_WATER, QC_WORST_CASE)
