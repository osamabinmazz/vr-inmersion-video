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

- **HDRI** [grasslands_sunset](https://polyhaven.com/a/grasslands_sunset) (4K) — pradera al atardecer, iluminación por imagen (IBL) + fondo/reflejos
- **Textura PBR** [grass_ground](https://polyhaven.com/a/grass_ground) (4K: difuso, normal, ARM, desplazamiento) — suelo con relieve geométrico real, no solo normal mapping

Para cambiar el entorno, edita las URLs en `scripts/download-assets.sh` por cualquier otro asset CC0 de Poly Haven (buscar el `slug` en polyhaven.com y usar la misma estructura de URL).

### Contexto: jornada territorial Zapicán

Este viewer es el componente digital complementario de una actividad territorial real en el entorno de la estatua de **Zapicán** (Punta de Rieles), con las escuelas N.º 179 y N.º 338 — ver el plan completo de la jornada: [Jornada Territorial — Estatua de Zapicán](https://claude.ai/artifact/Vw3QTJ81LjVXLRrpb2TDpL).

### Fauna nativa y sonido ambiente

La escena incluye fauna procedimental (mismo criterio que la vegetación — sin bajar modelos externos):

- **Carpinchos** (3) en el borde de la laguna, con idle sutil.
- **Bandada de aves** (10) volando en círculos bajos cerca de los árboles, con aleteo animado.
- **Sonido ambiente** sintetizado con Web Audio API (viento + cantos de aves + gruñido ocasional de carpincho + agua de la laguna) — sin clips de audio externos, así se ajusta exacto a la fauna representada y no arrastra temas de licencia. Se activa con el botón "🔊 Activar sonido ambiente" (requerido por la política de autoplay de los navegadores; no puede arrancar solo).
- **Sonido posicional del agua**: el siseo de superficie + chapoteos ocasionales de la laguna usan un `PannerNode` (HRTF) ubicado en `WATER_CENTER` — se escucha más fuerte cerca del agua y se atenúa con la distancia. El listener de audio sigue la posición/orientación de la cámara en cada frame, así que el paneo reacciona a hacia dónde mira el usuario (relevante en VR).
- **Mariposas** (16, tipo *Vanessa carye* — especie nativa muy común en la pradera uruguaya) revoloteando a media altura cerca de los arbustos con flor, con aleteo animado — refuerzan la idea de polinización sobre la vegetación florida.
- **Chapoteos visibles**: cada chapoteo de la laguna dispara también un anillo que se expande y se desvanece en la superficie del agua, sincronizado con el sonido — el mismo evento se ve y se escucha, activo desde que carga la escena (no depende de que el sonido esté encendido).
- **Balanceo por viento**: pasto, arbustos y copas de los árboles oscilan sutilmente cada frame (más marcado en el pasto, más leve en las copas) — recompone la matriz de cada instancia con una oscilación de dos frecuencias en vez de vértices estáticos, dando sensación de brisa sin depender de un shader propio.

Explícitamente **sin locomoción** por ahora — la cámara es fija, lo que se mueve/anima es la fauna y la vegetación (viento).

### Personajes (pendiente)

La escena tiene 3 marcadores ubicados donde eventualmente irán figuras representando a **Vaimacá Perú**, **Abayubá** y **Guyunusa**, haciendo vida cotidiana de su época. Se decidió posponer su modelado porque:

1. No hay referencias visuales confiables de su aspecto real — cualquier recreación 3D es una **interpretación artística**, no un retrato histórico, y hay que comunicarlo así.
2. Requiere modelos humanos rigged/animados (no solo texturas), un salto de complejidad distinto al del entorno.

**Opciones evaluadas para cuando se retome:**
- Modelos base tipo Mixamo personalizados con vestimenta/adornos de la época, animados haciendo actividades simples (tejer, hacer fuego, caminar).
- Siluetas/recortes 2D ilustrados con panel de texto/audio (ElevenLabs MCP) — más honesto visualmente sobre que es una recreación didáctica.
- Modelado en Blender (vía Blender MCP) si se consigue asesoramiento de referencia cultural/histórica confiable.

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
