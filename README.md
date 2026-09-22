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

- **HDRI** [belfast_sunset_puresky](https://polyhaven.com/a/belfast_sunset_puresky) (4K) — atardecer, iluminación por imagen (IBL) + fondo/reflejos. Es un **"pure sky"**: solo cielo, sin nada terrestre. Se cambió por eso — el anterior (`grasslands_sunset`) era un parque real y metía galpones, un alambrado y edificios en el horizonte, imposibles en una escena charrúa. El horizonte lo cierra ahora el monte nativo generado por código (tres capas a distinta distancia, cada una más fría y clara: perspectiva atmosférica). El cielo se rota (`SUN_AZIMUTH`) para traer el poniente al encuadre, y la luz direccional se alinea con ese mismo valor para que sombras y resplandor coincidan.
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
- **Hojas con silueta real por especie**: cada arbusto suma ~10-22 hojas individuales (no solo el "blob" de follaje) con el contorno 2D característico de su especie real — bilobulada tipo mariposa en pata de vaca, lámina delgada casi sin hoja verdadera en carqueja (fiel a sus tallos aplanados), redondeada de 5 lóbulos en malva sonrojada, lanceolada larga tipo hoja de sauce en chilca, ovalada con borde aserrado/espinoso en espina amarilla. Coloreadas más claras que el follaje base para que se lean por contraste. Cada hoja tiene su propio balanceo de viento.
- **Capibara con más definición**: hocico rectangular achatado + fosas nasales (rasgo distintivo real del capibara, ausente en el modelo anterior) y más segmentos en cuerpo/cabeza/orejas.
- **Aves con cola**: se agregó una cola en abanico, visible tanto en vuelo como si se posaran, para leer mejor la silueta a distancia.

### Texturas fotográficas y hojas con alfa

Cuatro rondas seguidas de subir polígonos no volvieron realista la vegetación, porque el problema no era la densidad de malla: era que **todo era color plano**. La corteza no tenía corteza y las hojas eran geometría opaca.

Texturas CC0 de [ambientCG](https://ambientcg.com) (descarga directa, como Poly Haven — las baja `scripts/download-assets.sh`):

- **Corteza** (`Bark014`, 1K: color + normal + roughness) en todos los troncos — espinillo, ombú, ceibo, sauce y butiá. Es la misma textura teñida distinto por especie, lo que cuesta un solo juego de mapas en memoria.
- **Hoja con canal alfa** (`Leaf001`, 1K: color + opacity + roughness). Es una hoja escaneada de verdad, con venación y borde aserrado. La imagen trae **dos** hojas (haz y envés), así que clonando la textura con distinto `offset.x` se obtienen dos variantes sin costo de memoria extra.

Decisiones que importan:

- **`alphaTest` en vez de `transparent`.** Da recorte duro, no necesita ordenar por profundidad y no produce los halos ni el parpadeo que arruinan la vegetación transparente en VR.
- **Translucidez aproximada.** La hoja real deja pasar la luz y a contraluz se enciende; un `transmission` real sería carísimo en un visor autónomo, así que se simula con una emisión tenue del propio verde.
- **La proporción la fija la foto, no la especie.** Si el plano usara el aspecto de cada contorno (la carqueja era casi 9:1) la hoja saldría aplastada.
- **Las hojas de copa escalan con el árbol.** Con un tamaño fijo, los ejemplares grandes se seguían leyendo como masas lisas porque sus hojas quedaban diminutas en proporción. La masa de la copa quedó además más oscura: pasa a hacer de sombra interior y deja que el follaje recortado defina el contorno.
- **Generador aleatorio propio para las hojas.** Sus ~21.000 llamadas, si salieran del `rng` global, correrían toda la secuencia posterior y cambiarían dónde caen árboles, palmeras y fauna (pasó: un butiá apareció plantado delante de la cámara).

Lo que se perdió en el cambio: los arbustos ya no tienen una silueta de hoja distinta por especie, porque todas usan la misma foto. La diferenciación ahora viene del tamaño, el tinte y la densidad.

### Especies emblemáticas de la pampa

Incorporadas a partir de una lista de referencia de modelos 3D comerciales, pero **modeladas procedimentalmente**: los modelos enlazados no eran utilizables (Sketchfab exige login para descargar, ArtStation Marketplace es de pago, y los escaneos "ultra HQ" con texturas 16K pesan cientos de MB, inviables para WebXR en un visor autónomo). Lo aprovechable era la selección de especies:

- **Cortadera** (*Cortaderia selloana*) — matas de hojas largas arqueadas en abanico y varas altas con penacho plumoso blanco-plateado. Es la silueta que más "lee" como pampa a media distancia. El penacho viaja con la punta de la vara al balancearse, no flota suelto.
- **Ombú** (*Phytolacca dioica*) — el árbol emblema de la llanura. Técnicamente es una hierba gigante, y eso explica su rasgo inconfundible: la base se ensancha en una masa bulbosa y acanalada mucho más ancha que el fuste. Modelado con lóbulos fundidos, no un cono liso.
- **Ñandú** (*Rhea americana*) — pieza clave de la vida charrúa: se lo cazaba con boleadoras y se aprovechaba carne, plumas, cuero y huevos. Pastorea en la llanura abierta (nunca junto al agua, a diferencia del carpincho), bajando y subiendo el cuello en un ciclo que pasa más tiempo abajo que arriba, como el animal real.
- **Ceibo** (*Erythrina crista-galli*) — **flor nacional de Uruguay**. Árbol de bañados y orillas, así que va plantado en la ribera de la laguna, su hábitat real. Tronco tortuoso construido como tramos encadenados que cambian de dirección (nunca recto), copa abierta y poco densa, y racimos de flores rojo carmesí colgantes, que en el árbol real se ven antes que el follaje.
- **Palma butiá** (*Butia odorata*) — la palmera nativa. Ojo con el nombre: la especie uruguaya es *B. odorata*; *"Butia capitata"*, como aparece rotulada en varios bancos de modelos, es en realidad la brasileña. La fronda se arquea fuerte hacia abajo dando la silueta de fuente, y el tronco queda anillado por las bases de hojas viejas. Cada fronda lleva un raquis que cose los folíolos: sin él se leían como hojas sueltas flotando.
- **Tero** (*Vanellus chilensis*) — el ave más característica del campo uruguayo: pechera negra, copete fino en la nuca, patas rojas, cola oscura con banda blanca. Picotea el pasto con pausas de alerta, y su grito de alarma "tero-tero" está sintetizado como ráfaga de sílabas agudas y metálicas (onda diente de sierra + pasabanda, ataque seco), integrado al ambiente sonoro.

### Laguna con referencia fotográfica

La laguna se rehízo a partir de una foto real de un arroyo/laguna uruguaya, corrigiendo lo que la delataba como sintética:

- **Contorno irregular** en vez de círculo perfecto: el radio varía con el ángulo (suma de senos, determinista). Todo lo demás —orilla, juncos, sauces, capibaras, chapoteos— se cuelga de la misma función `waterRadiusAt()`, así que la forma queda coherente en toda la escena.
- **Agua turbia verdosa-parda**, no azul de pileta: reflejo del cielo apenas insinuado (`envMapIntensity` bajo + roughness alta), porque el agua con sedimentos no es un espejo.
- **Orilla de barro expuesto**: franja de tierra sin pasto entre el agua y la pradera, como deja el nivel del agua al subir y bajar.
- **Totoras y juncos** (*Schoenoplectus californicus*) en mechones pisando el borde del agua.
- **Sauces criollos** (*Salix humboldtiana* — el sauce **nativo** del monte ribereño uruguayo, no el sauce llorón asiático) inclinados sobre el agua, con copa de follaje y cortina de ramas colgantes que se balancean con el viento (son lo que más se mueve de la escena, con el pivote de rotación en el punto donde nace la rama).

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
