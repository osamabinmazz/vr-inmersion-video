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

# --- Texturas fotográficas de vegetación (CC0, ambientCG) -----------------
# Vienen en ZIP con más mapas de los que se usan; se extrae solo lo
# necesario para no cargar el viewer con decenas de MB de normales que a
# esta escala no se notan.
LEAF_DIR="public/assets/textures/leaf"
LEAF_PIN_DIR="public/assets/textures/leaf_pinnada"
BARK_DIR="public/assets/textures/bark"
mkdir -p "$LEAF_DIR" "$LEAF_PIN_DIR" "$BARK_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Hacen falta DOS fotos de hoja distintas porque las especies de la escena
# son de familias con follaje incompatible: el ombú y el ceibo tienen hoja
# simple ancha, mientras que el espinillo y el algarrobo son fabáceas de
# hoja bipinnada. Con una sola foto, el monte llevaba puesta la hoja del
# ombú, que es un error botánico.
echo "Descargando hoja ancha con canal alfa (Leaf001, CC0 ambientCG)..."
curl -sS -L -o "$TMP/leaf.zip" "https://ambientcg.com/get?file=Leaf001_1K-PNG.zip"
unzip -o -j -q "$TMP/leaf.zip" \
  "Leaf001_1K-PNG_Color.png" "Leaf001_1K-PNG_Opacity.png" "Leaf001_1K-PNG_Roughness.png" \
  -d "$TMP/leaf"
mv "$TMP/leaf/Leaf001_1K-PNG_Color.png"     "$LEAF_DIR/color.png"
mv "$TMP/leaf/Leaf001_1K-PNG_Opacity.png"   "$LEAF_DIR/opacity.png"
mv "$TMP/leaf/Leaf001_1K-PNG_Roughness.png" "$LEAF_DIR/rough.png"

echo "Descargando hoja pinnada con canal alfa (Leaf003, CC0 ambientCG)..."
curl -sS -L -o "$TMP/leaf3.zip" "https://ambientcg.com/get?file=Leaf003_1K-PNG.zip"
unzip -o -j -q "$TMP/leaf3.zip" \
  "Leaf003_1K-PNG_Color.png" "Leaf003_1K-PNG_Opacity.png" "Leaf003_1K-PNG_Roughness.png" \
  -d "$TMP/leaf3"
mv "$TMP/leaf3/Leaf003_1K-PNG_Color.png"     "$LEAF_PIN_DIR/color.png"
mv "$TMP/leaf3/Leaf003_1K-PNG_Opacity.png"   "$LEAF_PIN_DIR/opacity.png"
mv "$TMP/leaf3/Leaf003_1K-PNG_Roughness.png" "$LEAF_PIN_DIR/rough.png"

echo "Descargando corteza (Bark014, CC0 ambientCG)..."
curl -sS -L -o "$TMP/bark.zip" "https://ambientcg.com/get?file=Bark014_1K-JPG.zip"
unzip -o -j -q "$TMP/bark.zip" \
  "Bark014_1K-JPG_Color.jpg" "Bark014_1K-JPG_NormalGL.jpg" "Bark014_1K-JPG_Roughness.jpg" \
  -d "$TMP/bark"
mv "$TMP/bark/Bark014_1K-JPG_Color.jpg"     "$BARK_DIR/color.jpg"
mv "$TMP/bark/Bark014_1K-JPG_NormalGL.jpg"  "$BARK_DIR/normal.jpg"
mv "$TMP/bark/Bark014_1K-JPG_Roughness.jpg" "$BARK_DIR/rough.jpg"

echo "Listo. Assets en public/assets/"
