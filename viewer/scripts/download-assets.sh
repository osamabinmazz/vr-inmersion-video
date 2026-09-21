#!/usr/bin/env bash
# Descarga los assets 4K (CC0, Poly Haven) que el viewer necesita.
# No se commitean al repo (pesan ~65MB) — correr este script después de clonar.
set -euo pipefail
cd "$(dirname "$0")/.."

HDRI_DIR="public/assets/hdri"
TEX_DIR="public/assets/textures/grass_ground"
mkdir -p "$HDRI_DIR" "$TEX_DIR"

# "pure sky" = SOLO cielo, sin nada terrestre. Se cambió a este porque el
# anterior (grasslands_sunset) era un parque real y metía galpones, un
# alambrado y edificios en el horizonte, imposibles en una escena charrúa.
# El horizonte lo cierra ahora el monte nativo generado en main.js.
echo "Descargando HDRI 4K (qwantani_sunset_puresky — cielo puro, CC0 Poly Haven)..."
curl -sS -L -o "$HDRI_DIR/qwantani_sunset_puresky_4k.hdr" \
  "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/qwantani_sunset_puresky_4k.hdr"

echo "Descargando set PBR 4K (grass_ground, CC0 Poly Haven)..."
curl -sS -L -o "$TEX_DIR/diff_4k.jpg" \
  "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/4k/grass_ground/grass_ground_diff_4k.jpg"
curl -sS -L -o "$TEX_DIR/nor_gl_4k.jpg" \
  "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/4k/grass_ground/grass_ground_nor_gl_4k.jpg"
curl -sS -L -o "$TEX_DIR/arm_4k.jpg" \
  "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/4k/grass_ground/grass_ground_arm_4k.jpg"
curl -sS -L -o "$TEX_DIR/disp_4k.jpg" \
  "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/4k/grass_ground/grass_ground_disp_4k.jpg"

echo "Listo. Assets en public/assets/"
