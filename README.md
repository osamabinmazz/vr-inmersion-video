# VR Inmersión Video

Proyecto con dos partes:

- **`viewer/`** — experiencia WebXR (Three.js) para explorar la escena 3D en un visor VR (Meta Quest, navegador de escritorio con WebXR emulator, etc).
- **`video/`** — proyecto Remotion para producir/renderizar el video final (incluye captions, animaciones y efectos de las escenas).

## Requisitos

- Node.js 18+
- Un headset VR (Meta Quest) para probar `viewer/` en inmersión real, o el [WebXR API Emulator](https://chromewebstore.google.com/detail/webxr-api-emulator/mjddjgeghkdijejnciaefnkjmkafnnje) para desktop.

## Viewer (WebXR)

```bash
cd viewer
npm install
./scripts/download-assets.sh   # baja el HDRI 4K + set PBR 4K (~50MB, no están en git)
npm run dev
```

Abre la URL local en Chrome/Edge. Con el emulador de WebXR instalado verás el botón "Enter VR"; en un Quest conectado por cable/wifi a la misma red, ábrelo en el navegador del headset.

### Assets 4K (entorno ultra detallado)

El suelo y la iluminación usan assets reales CC0 de [Poly Haven](https://polyhaven.com), descargados por `scripts/download-assets.sh` (no se commitean al repo por su peso):

- **HDRI** [royal_esplanade](https://polyhaven.com/a/royal_esplanade) (4K) — iluminación por imagen (IBL) + fondo/reflejos
- **Textura PBR** [cobblestone_floor_04](https://polyhaven.com/a/cobblestone_floor_04) (4K: difuso, normal, ARM, desplazamiento) — suelo con relieve geométrico real, no solo normal mapping

Para cambiar el entorno, edita las URLs en `scripts/download-assets.sh` por cualquier otro asset CC0 de Poly Haven (buscar el `slug` en polyhaven.com y usar la misma estructura de URL).

## Video (Remotion)

```bash
cd video
npm install
npx remotion studio
```

Abre el preview en el navegador para editar/ver las composiciones. Para renderizar:

```bash
npx remotion render
```

## Próximos pasos sugeridos

- [ ] Definir la escena 3D del viewer (modelos, iluminación, escala — ver skill `webxr-dev`)
- [ ] Definir el guion/storyboard de las escenas del video (ver skill `remotion-create`)
- [ ] Si hay assets 3D propios: usar Blender MCP para modelarlos
- [ ] Si el video es 360°/equirectangular: post-procesar con el skill `ffmpeg-stabilization-360`
- [ ] Narración: ElevenLabs MCP para voz en off
