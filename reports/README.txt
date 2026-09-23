Informes de las fases de mejora visual de ZAPICÁN.

VERSIONES
- v02:  snapshots/ZAPICAN_v02_materials_ground_water.js (antes de Fases 1-3)
- v051: snapshots/ZAPICAN_v051_ground_integration.js    (Fases 1-3)
- v060: snapshots/ZAPICAN_v060_before_midground_extension.js (= v051, backup antes de Fase 4)
- v061: snapshots/ZAPICAN_v061_midground_extension.js   (Fase 4)
- v070: snapshots/ZAPICAN_v070_before_lighting_atmosphere.js (= v061, backup antes de Fase 5)
- v071: snapshots/ZAPICAN_v071_lighting_atmosphere.js   (Fase 5, estado actual)
Las versiones intermedias (v030, v031, v040, v041, v050) no se guardaron en
su momento y no se pueden reconstruir. Desde ahora, cada fase queda como
commit propio en git.

CÁMARAS QC (viewer/src/main.js, QC_CAMERAS; window.__qc en modo dev)
QC_GROUND, QC_MID, QC_HIGH, QC_WATER, QC_TREE_CLOSE, QC_BUSH_CLOSE,
QC_REED_BASE, QC_HERO_WATER_EDGE, QC_HERO_TREE_FOREGROUND, QC_ROOT_CLOSE,
QC_MUD_TRANSITION, QC_WORST_CASE (Fase 4: el encuadre más caro medido); QC_LIGHTING_COMPARISON,
QC_ATMOS_DEPTH, QC_SKY_HORIZON (Fase 5).

COMPARATIVAS: comparisons/v02_vs_v051/ — las 11 cámaras, antes y después.

FASE 4 (plano medio y fondo)
- reports/phase4/MIDGROUND_AUDIT.txt         auditoría y clasificación por asset
- reports/phase4/PHASE4_MIDGROUND_REPORT.txt informe de la fase
- performance/phase4/PERFORMANCE_BEFORE_AFTER.txt  tablas medidas
- performance/phase4/BEFORE_MIDGROUND.json, AFTER_MIDGROUND.json  datos crudos
- comparisons/phase4/  BEFORE_/AFTER_MIDGROUND_<cámara>.jpg y COMPARE_<cámara>.jpg
  (QC_GROUND, QC_MID, QC_HIGH, QC_WATER, QC_WORST_CASE)

FASE 5 (iluminación, cielo, atmósfera)
- reports/phase5/LIGHTING_AUDIT.txt              diagnóstico de v070
- reports/phase5/PHASE5_LIGHTING_ATMOSPHERE_REPORT.txt  informe de la fase
- lookdev/phase5/LOOKDEV_NOTES.txt               iteraciones y justificación de valores
- performance/phase5/PERFORMANCE_BEFORE_AFTER.txt  tablas medidas (2 modos)
- performance/phase5/*.json, COST_*.json         datos crudos
- comparisons/phase5/  BEFORE_/AFTER_VR_BALANCED_/AFTER_PRESENTATION_<cámara>.jpg
  y COMPARE_<cámara>.jpg (11 cámaras QC + QC_LIGHTING_COMPARISON, QC_ATMOS_DEPTH,
  QC_SKY_HORIZON), VISUAL_METRICS.txt
- Dos modos de look: por defecto VR_BALANCED; ?mode=presentation para el modo
  de presentación (cielo en vivo, sombras 4K). ?perf=1 sigue midiendo FPS en
  el visor (agregado en Fase 4); ?perf=1&mode=presentation para el otro modo.
