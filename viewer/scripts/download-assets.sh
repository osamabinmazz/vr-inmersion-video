#!/usr/bin/env bash
# Descarga los assets 4K (CC0, Poly Haven) que el viewer necesita.
# No se commitean al repo (pesan ~50MB) — correr este script después de clonar.
set -euo pipefail
cd "$(dirname "$0")/.."

HDRI_DIR="public/assets/hdri"
TEX_DIR="public/assets/textures/cobblestone_floor_04"
mkdir -p "$HDRI_DIR" "$TEX_DIR"

echo "Descargando HDRI 4K (royal_esplanade, CC0 Poly Haven)..."
curl -sS -L -o "$HDRI_DIR/royal_esplanade_4k.hdr" \
  "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/royal_esplanade_4k.hdr"

echo "Descargando set PBR 4K (cobblestone_floor_04, CC0 Poly Haven)..."
curl -sS -L -o "$TEX_DIR/diff_4k.jpg" \
  "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/4k/cobblestone_floor_04/cobblestone_floor_04_diff_4k.jpg"
curl -sS -L -o "$TEX_DIR/nor_gl_4k.jpg" \
  "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/4k/cobblestone_floor_04/cobblestone_floor_04_nor_gl_4k.jpg"
curl -sS -L -o "$TEX_DIR/arm_4k.jpg" \
  "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/4k/cobblestone_floor_04/cobblestone_floor_04_arm_4k.jpg"
curl -sS -L -o "$TEX_DIR/disp_4k.jpg" \
  "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/4k/cobblestone_floor_04/cobblestone_floor_04_disp_4k.jpg"

echo "Listo. Assets en public/assets/"
