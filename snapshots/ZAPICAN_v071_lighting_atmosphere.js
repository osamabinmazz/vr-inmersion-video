import * as THREE from "three";
import { VRButton } from "three/examples/jsm/webxr/VRButton.js";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { mergeGeometries, mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";

// --- Renderer -------------------------------------------------------------
// ===========================================================================
// FASE 5 — iluminación, cielo y atmósfera: parámetros de look
// ===========================================================================
// Dos modos (misma luz, mismo color; cambia solo lo que cuesta):
//   VR_BALANCED  (por defecto): cielo horneado en un cubemap una sola vez,
//                sombras 2048 sobre ±13 m, nubes estáticas.
//   PRESENTATION (?mode=presentation): cielo en vivo con nubes que derivan,
//                sombras 4096 sobre ±18 m y nubes a doble resolución.
// Sin postprocesado en ninguno de los dos: three no puede correr un
// EffectComposer dentro de una sesión WebXR, y un grade que existiera solo en
// las capturas mostraría algo que en las gafas no se ve. El grade vive en la
// luz, el tone mapping y la bruma, que valen igual en pantalla y en VR.
const LOOK_MODE = new URLSearchParams(location.search).get("mode") === "presentation" ? "PRESENTATION" : "VR_BALANCED";
const LOOK = {
  // Khronos PBR Neutral: conserva el tono de los materiales (ACES corría los
  // verdes hacia el amarillo y aplastaba el cielo a blanco).
  toneMapping: THREE.NeutralToneMapping,
  exposure: 1.2,
  // Tarde suave (~16:30 de otoño en el litoral): sol a 27° sobre el
  // horizonte, detrás y a la izquierda del visor → luz de tres cuartos sobre
  // el monte y los personajes, sombras hacia adelante-derecha.
  sunElevationDeg: 27,
  sunAzimuthDeg: -100, // desde la izquierda del visor, apenas por delante del través
  sunColor: 0xfff0dc, // ~5000 K: cálido moderado, no naranja
  // Relación sol/relleno ~3:1 (lookdev: con 2.7/0.62 las sombras quedaban
  // lechosas y el cielo pálido; ver lookdev/phase5/LOOKDEV_NOTES.txt).
  sunIntensity: 3.0,
  envIntensity: 0.6, // relleno del cielo: sombras con información, no lechosas
  hemi: { sky: 0xdfe8f0, ground: 0x6f5d40, intensity: 0.25 }, // rebote pardo del suelo
  sky: { turbidity: 4.2, rayleigh: 1.25, mie: 0.0035, mieG: 0.78 },
  // El cielo va por debajo de la exposición de la escena: con 1.2 de
  // exposición y el fondo a 0.66 el cielo queda azul y sin quemarse.
  bgIntensity: 0.66,
  // Bruma: color del horizonte (azul grisáceo claro), densidad baja → aire,
  // no niebla. 7 % a 10 m, 18 % a 26 m, 48 % a 88 m.
  // Igual al blanco azulado del cielo justo sobre el horizonte, para que la
  // llanura se funda con él sin una línea.
  fogColor: 0xd9e2e9,
  fogDensity: 0.0074,
  water: { envMapIntensity: 0.5, roughness: 0.32, specularIntensity: 0.12 },
  shadowMapSize: LOOK_MODE === "PRESENTATION" ? 4096 : 2048,
  shadowExtent: LOOK_MODE === "PRESENTATION" ? 18 : 13,
  cloudTex: LOOK_MODE === "PRESENTATION" ? [2048, 1024] : [1024, 512],
  skyCubeSize: 1024,
};
// Lookdev en desarrollo: ?tm=aces|agx|neutral&exp=..&sunI=..&envI=..&fog=..
if (import.meta.env.DEV) {
  const q = new URLSearchParams(location.search);
  const num = (k, target, key) => { if (q.has(k)) target[key] = parseFloat(q.get(k)); };
  if (q.has("tm")) LOOK.toneMapping = { aces: THREE.ACESFilmicToneMapping, agx: THREE.AgXToneMapping, neutral: THREE.NeutralToneMapping }[q.get("tm")] ?? LOOK.toneMapping;
  num("exp", LOOK, "exposure"); num("sunI", LOOK, "sunIntensity"); num("envI", LOOK, "envIntensity");
  num("fog", LOOK, "fogDensity"); num("elev", LOOK, "sunElevationDeg"); num("azim", LOOK, "sunAzimuthDeg");
  num("bgI", LOOK, "bgIntensity"); num("hemiI", LOOK.hemi, "intensity");
  num("wEnv", LOOK.water, "envMapIntensity"); num("wRough", LOOK.water, "roughness"); num("wSpec", LOOK.water, "specularIntensity");
}

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.toneMapping = LOOK.toneMapping;
renderer.toneMappingExposure = LOOK.exposure;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById("app").appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

renderer.xr.addEventListener("sessionstart", () => {
  renderer.xr.setFramebufferScaleFactor(2.0);
});

const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();

// --- Scene ------------------------------------------------------------
const scene = new THREE.Scene();
// FASE 5: bruma de aire, no niebla. El color es el del horizonte del cielo
// para que el paisaje se funda con él en vez de recortarse; la densidad
// separa planos (el primer plano casi intacto, el horizonte velado a la
// mitad). La anterior (0.013, beige) lavaba el fondo y escondía el corte del
// plano lejano de la cámara a 100 m.
scene.fog = new THREE.FogExp2(LOOK.fogColor, LOOK.fogDensity);

// --- Cielo procedural + nubes (FASE 5) -------------------------------------
// El HDRI de atardecer quedaba con el sol bajo DE FRENTE: todo lo que el
// visor mira estaba en contraluz, el cielo se leía blanco-rosado y la escena
// plana. Un cielo físico (Preetham, three/examples Sky) se ilumina con el
// MISMO sol que proyecta las sombras, así cielo, luz, reflejos del agua e
// iluminación ambiente cuentan una sola hora del día. Encima, una capa de
// nubes de buen tiempo, sutil y que se desvanece hacia el horizonte.
const SUN_DIR = new THREE.Vector3().setFromSphericalCoords(
  1,
  THREE.MathUtils.degToRad(90 - LOOK.sunElevationDeg),
  THREE.MathUtils.degToRad(LOOK.sunAzimuthDeg)
);

const sky = new Sky();
sky.scale.setScalar(800); // la caja entra entera en el plano lejano (1500 m)
{
  const u = sky.material.uniforms;
  u.turbidity.value = LOOK.sky.turbidity;
  u.rayleigh.value = LOOK.sky.rayleigh;
  u.mieCoefficient.value = LOOK.sky.mie;
  u.mieDirectionalG.value = LOOK.sky.mieG;
  u.sunPosition.value.copy(SUN_DIR);
  // Interruptor del disco solar: fuera para hornear la luz ambiente (si no,
  // el sol se cuenta dos veces: como luz direccional y dentro del entorno).
  u.uSunDisk = { value: 1 };
  sky.material.fragmentShader = sky.material.fragmentShader
    .replace("uniform vec3 up;", "uniform vec3 up;\nuniform float uSunDisk;")
    .replace(/float sundisk = smoothstep\(([^;]+)\);/, "float sundisk = smoothstep($1) * uSunDisk;");
}

// Nubes: textura procedural sobre una cúpula. Ruido fractal continuo en la
// costura (se muestrea sobre un cilindro), cobertura baja, bases apenas más
// grises y desvanecido hacia el horizonte para no dibujar un borde.
function makeCloudTexture(w, h) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(w, h);
  const nA = makeNoise2D(20931);
  const nB = makeNoise2D(55117);
  for (let y = 0; y < h; y++) {
    // La textura cubre SOLO la cúpula: fila 0 = cenit, última fila = horizonte.
    const v = y / h;
    const elev = 1 - v; // 1 cenit … 0 horizonte
    const fade = THREE.MathUtils.smoothstep(elev, 0.02, 0.22);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (fade <= 0) {
        img.data[i + 3] = 0;
        continue;
      }
      const a = (x / w) * Math.PI * 2;
      // Cuanto más cerca del horizonte, más "aplastadas" (perspectiva real
      // de una capa de nubes): se estira el ruido en v.
      const sx = Math.cos(a) * 3.2, sz = Math.sin(a) * 3.2;
      const sv = v * 7 * (1 + (1 - elev) * 0.7);
      let n = fbm(nA, sx + sv * 0.35 + 40, sz + sv, 5) * 0.72 + fbm(nB, sx * 2.3 + 11, sz * 2.3 + sv * 2.1, 3) * 0.28;
      const cover = THREE.MathUtils.smoothstep(n, 0.5, 0.68);
      const alpha = cover * fade * 0.72;
      // base apenas más gris que la cima
      const shade = 246 - (1 - THREE.MathUtils.smoothstep(n, 0.54, 0.74)) * 22;
      img.data[i] = shade;
      img.data[i + 1] = shade + 2;
      img.data[i + 2] = shade + 6;
      img.data[i + 3] = alpha * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}
const cloudTex = makeCloudTexture(LOOK.cloudTex[0], LOOK.cloudTex[1]);
const clouds = new THREE.Mesh(
  new THREE.SphereGeometry(700, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2),
  new THREE.MeshBasicMaterial({
    map: cloudTex,
    transparent: true,
    depthWrite: false,
    fog: false,
    side: THREE.BackSide,
    color: 0xfffaf4, // luz de tarde sobre la nube: apenas cálida
  })
);
clouds.renderOrder = -1;
// La textura se hizo para u = azimut, v = altura; la esfera parcial de three
// mapea v desde el cenit, igual que la textura.

const skyScene = new THREE.Scene();
skyScene.add(sky, clouds);

// Luz ambiente del cielo: PMREM del cielo SIN disco solar (y con nubes).
const pmrem = new THREE.PMREMGenerator(renderer);
sky.material.uniforms.uSunDisk.value = 0;
scene.environment = pmrem.fromScene(skyScene, 0.02).texture;
scene.environmentIntensity = LOOK.envIntensity;
sky.material.uniforms.uSunDisk.value = 1;
pmrem.dispose();

if (LOOK_MODE === "VR_BALANCED") {
  // Cielo horneado una vez en un cubemap: en el visor cuesta lo mismo que un
  // fondo de textura (sin el shader de dispersión por píxel, por ojo).
  const cubeRT = new THREE.WebGLCubeRenderTarget(LOOK.skyCubeSize, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  new THREE.CubeCamera(1, 1000, cubeRT).update(renderer, skyScene);
  scene.background = cubeRT.texture;
} else {
  // En vivo: nubes que derivan (ver render loop).
  scene.add(sky, clouds);
}
scene.backgroundIntensity = LOOK.bgIntensity;
if (LOOK_MODE !== "VR_BALANCED") {
  // En vivo el cielo es una malla: se le aplica la misma intensidad de fondo.
  sky.material.fragmentShader = sky.material.fragmentShader.replace(
    "gl_FragColor = vec4( retColor, 1.0 );",
    `gl_FragColor = vec4( retColor * ${LOOK.bgIntensity.toFixed(3)}, 1.0 );`
  );
  clouds.material.color.multiplyScalar(LOOK.bgIntensity);
}

// Sol: la misma dirección que el cielo. Tarde suave de tres cuartos.
const sun = new THREE.DirectionalLight(LOOK.sunColor, LOOK.sunIntensity);
const SUN_TARGET = new THREE.Vector3(0, 0, -2); // centro de interés: claro, personajes, laguna
sun.target.position.copy(SUN_TARGET);
sun.position.copy(SUN_DIR).multiplyScalar(30).add(SUN_TARGET);
sun.castShadow = true;
sun.shadow.mapSize.set(LOOK.shadowMapSize, LOOK.shadowMapSize);
sun.shadow.camera.left = -LOOK.shadowExtent;
sun.shadow.camera.right = LOOK.shadowExtent;
sun.shadow.camera.top = LOOK.shadowExtent;
sun.shadow.camera.bottom = -LOOK.shadowExtent;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 80;
// Sin acné ni "peter panning": sesgo mínimo + desplazamiento por normal.
sun.shadow.bias = -0.0002;
sun.shadow.normalBias = 0.025;
scene.add(sun, sun.target);

// Rebote del suelo: el cielo ilumina desde arriba, pero en un pastizal la
// tierra devuelve luz parda hacia la cara inferior de copas y troncos. Sin
// esto las sombras de las copas quedan azules y vacías.
const hemiLight = new THREE.HemisphereLight(LOOK.hemi.sky, LOOK.hemi.ground, LOOK.hemi.intensity);
scene.add(hemiLight);

// --- Suelo PBR 4K: pradera nativa con relieve real -------------------------
// grass_ground — CC0, Poly Haven (polyhaven.com/a/grass_ground)
const texLoader = new THREE.TextureLoader();
const REPEAT = 6;

function loadTiled(path, colorSpace) {
  const t = texLoader.load(path);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(REPEAT, REPEAT);
  t.anisotropy = maxAnisotropy;
  if (colorSpace) t.colorSpace = colorSpace;
  return t;
}

// --- Texturas fotográficas de corteza y hoja (CC0, ambientCG) -------------
// El salto de calidad de la vegetación no vino de más polígonos sino de acá:
// corteza real en los troncos y hojas recortadas por canal alfa a partir de
// una foto de hoja escaneada (Leaf001 trae haz y envés en la misma imagen,
// así que se puede variar cuál se usa moviendo el offset UV).
const barkColor = loadTiled("/assets/textures/bark/color.jpg", THREE.SRGBColorSpace);
const barkNormal = loadTiled("/assets/textures/bark/normal.jpg");
const barkRough = loadTiled("/assets/textures/bark/rough.jpg");
for (const t of [barkColor, barkNormal, barkRough]) t.repeat.set(1, 2);

function makeBarkMaterial(tint = 0xffffff) {
  return new THREE.MeshStandardMaterial({
    color: tint, // tiñe la misma corteza para diferenciar especies
    map: barkColor,
    normalMap: barkNormal,
    roughnessMap: barkRough,
    roughness: 1.0,
    metalness: 0.0,
  });
}

// DOS fotos de hoja distintas, no una sola repetida, porque las especies de
// esta escena pertenecen a familias con follaje incompatible:
//
//   - "ancha": hoja simple, ovada y aserrada. Es la del ombú (Phytolacca
//     dioica) y la de los folíolos del ceibo (Erythrina crista-galli).
//   - "pinnada": hoja compuesta y plumosa. Es la de las fabáceas del monte —
//     espinillo (Vachellia caven) y algarrobo (Prosopis) — que tienen hoja
//     bipinnada. Vestirlas con la hoja ancha era un error botánico: ningún
//     espinillo tiene una hoja parecida a la del ombú.
function loadLeafPhoto(dir) {
  const color = texLoader.load(`/assets/textures/${dir}/color.png`);
  color.colorSpace = THREE.SRGBColorSpace;
  const alpha = texLoader.load(`/assets/textures/${dir}/opacity.png`);
  const rough = texLoader.load(`/assets/textures/${dir}/rough.png`);
  for (const t of [color, alpha, rough]) {
    t.anisotropy = maxAnisotropy;
    // Cada foto trae DOS hojas lado a lado: se toma media imagen para
    // quedarse con una sola.
    t.repeat.set(0.5, 1);
  }
  return { color, alpha, rough };
}

const LEAF_PHOTOS = {
  ancha: loadLeafPhoto("leaf"),
  pinnada: loadLeafPhoto("leaf_pinnada"),
};

/** Alpha card de hoja: plano recortado por el mapa de opacidad.
 *
 * alphaTest en vez de transparent: da recorte duro, no necesita ordenar por
 * profundidad y no produce los halos ni el parpadeo que arruinan la
 * vegetación transparente en VR.
 */
// Proporción del plano: alto / ancho. Cada media textura mide 512×1024, así
// que 2.0 es la única proporción que NO deforma la foto. El valor anterior
// (1.55) achataba la hoja un 22% y la hacía más ancha de lo que es.
const LEAF_ASPECT = 2.0;

function makeLeafCardMaterial(tint, { kind = "ancha", variant = 0 } = {}) {
  const photo = LEAF_PHOTOS[kind] ?? LEAF_PHOTOS.ancha;
  // Clonar comparte la imagen en memoria pero da offset propio, así cada
  // especie puede usar una de las dos hojas de la foto.
  const offsetX = variant === 0 ? 0.0 : 0.5;
  const map = photo.color.clone();
  const alphaMap = photo.alpha.clone();
  const roughnessMap = photo.rough.clone();
  for (const t of [map, alphaMap, roughnessMap]) {
    t.offset.x = offsetX;
    t.needsUpdate = true;
  }
  return new THREE.MeshStandardMaterial({
    color: tint,
    map,
    alphaMap,
    roughnessMap,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    roughness: 0.85,
    metalness: 0.0,
    // Aproximación barata a la translucidez: la hoja real deja pasar luz y a
    // contraluz se enciende. Un transmission real sería carísimo en VR, así
    // que se simula con una emisión tenue del propio verde.
    // La translucidez se simula con una emisión tenue del propio verde. NO
    // puede tomar `tint`: ahora el color va por instancia y el tinte del
    // material es blanco, así que emitiría un velo gris sobre toda la hoja.
    // Se fija un verde medio de follaje, que es de lo que se enciende una
    // hoja real a contraluz.
    emissive: 0x6f8a44,
    emissiveIntensity: 0.12,
  });
}

const groundDiff = loadTiled("/assets/textures/grass_ground/diff_4k.jpg", THREE.SRGBColorSpace);
const groundNormal = loadTiled("/assets/textures/grass_ground/nor_gl_4k.jpg");
const groundArm = loadTiled("/assets/textures/grass_ground/arm_4k.jpg"); // R=AO G=Rough B=Metal
const groundDisp = loadTiled("/assets/textures/grass_ground/disp_4k.jpg");

const groundGeo = new THREE.PlaneGeometry(30, 30, 160, 160);
groundGeo.rotateX(-Math.PI / 2);
groundGeo.setAttribute("uv2", groundGeo.attributes.uv);

const groundMat = new THREE.MeshStandardMaterial({
  map: groundDiff,
  normalMap: groundNormal,
  roughnessMap: groundArm,
  metalnessMap: groundArm,
  aoMap: groundArm,
  displacementMap: groundDisp,
  displacementScale: 0.15,
  metalness: 0.0,
});

const ground = new THREE.Mesh(groundGeo, groundMat);
ground.receiveShadow = true;
scene.add(ground);

// Llanura lejana: el suelo con PBR 4K y displacement real solo mide 30x30m,
// suficiente para lo que se pisa, pero con un HDRI de cielo puro se vería
// el borde recortado contra el vacío. Este plano grande extiende la pampa
// hasta el horizonte. Va sin displacement ni normal map (a esa distancia no
// aportan nada y costarían caro) y apenas por debajo, para no pelearse en
// z-buffer con el suelo detallado.
// FASE 4 (presupuesto de texturas): este plano cargaba OTRA copia del
// difuso 4K — una segunda textura de 4096² en la GPU (~85 MB con mipmaps)
// para un suelo que se ve a más de 15 m, con 60 repeticiones. Ahora usa la
// misma foto reducida a 1024² en un canvas: a esa distancia cada texel sigue
// siendo más chico que un píxel del visor.
const farGroundDiff = (() => {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1024;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#8c8260"; // tono medio de la pradera mientras carga
  ctx.fillRect(0, 0, 1024, 1024);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = maxAnisotropy;
  tex.colorSpace = THREE.SRGBColorSpace;
  new THREE.ImageLoader().load("/assets/textures/grass_ground/diff_4k.jpg", (img) => {
    ctx.drawImage(img, 0, 0, 1024, 1024);
    tex.needsUpdate = true;
  });
  return tex;
})();
farGroundDiff.repeat.set(360, 360); // FASE 5: el plano pasa de 400 a 2.400 m (misma escala de textura)
const farGround = new THREE.Mesh(
  // FASE 5: 2.400 m de lado. Con el plano lejano de la cámara a 1.500 m y la
  // bruma, el borde de la llanura ya no se ve: se funde con el horizonte.
  new THREE.PlaneGeometry(2400, 2400),
  // Matiz de pastizal: sin la niebla pesada, la foto de suelo repetida hasta
  // el horizonte se leía como un desierto pardo. La pampa lejana es oliva.
  new THREE.MeshStandardMaterial({ map: farGroundDiff, color: 0xb4b98e, roughness: 1.0, metalness: 0.0 })
);
farGround.rotation.x = -Math.PI / 2;
farGround.position.y = -0.015;
scene.add(farGround);

// --- Cuerpo de agua: laguna --------------------------------------------
// Pequeña laguna, coherente con los puntos de agua reales junto a los que
// se asentaban los charrúas. Refleja el HDRI (scene.environment, ya
// cargado más arriba); la ondulación viene de un normal map procedimental
// (sin depender de texturas externas) que se anima lentamente.
const WATER_CENTER = [7, 4];
const WATER_RADIUS = 3.2;
const WATER_Z_SQUASH = 0.75; // achata la laguna en Z para forma elíptica

// Contorno IRREGULAR, no un círculo: una laguna/arroyo real tiene la orilla
// sinuosa, con entrantes y salientes. El radio varía con el ángulo como
// suma de senos de distinta frecuencia (determinista, sin depender del rng
// global, que se define más abajo). Todo lo demás — orilla de barro,
// juncos, sauces, capibaras, chapoteos — se cuelga de esta misma función,
// así que la forma queda coherente en toda la escena.
function waterRadiusAt(angle) {
  return (
    WATER_RADIUS *
    (1 +
      0.2 * Math.sin(angle + 0.7) +
      0.13 * Math.sin(angle * 2 + 2.1) +
      0.07 * Math.sin(angle * 3 + 4.3) +
      0.04 * Math.sin(angle * 5 + 1.2))
  );
}

function insideWater(x, z, margin = 0.6) {
  const dx = x - WATER_CENTER[0];
  const dz = (z - WATER_CENTER[1]) / WATER_Z_SQUASH;
  const angle = Math.atan2(dz, dx);
  return Math.hypot(dx, dz) < waterRadiusAt(angle) + margin;
}

function waterOutlinePoint(angle, radiusScale) {
  const r = waterRadiusAt(angle) * radiusScale;
  return [
    WATER_CENTER[0] + Math.cos(angle) * r,
    WATER_CENTER[1] + Math.sin(angle) * r * WATER_Z_SQUASH,
  ];
}

function makeWaterNormalTexture() {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgb(128,128,255)";
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 6 + Math.random() * 18;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, "rgba(170,170,255,0.5)");
    grad.addColorStop(1, "rgba(128,128,255,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 4);
  return tex;
}

const waterNormalTex = makeWaterNormalTexture();

const WATER_SEGMENTS = 128;

function makeWaterOutlineShape(radiusScale) {
  const shape = new THREE.Shape();
  for (let i = 0; i <= WATER_SEGMENTS; i++) {
    const a = (i / WATER_SEGMENTS) * Math.PI * 2;
    const r = waterRadiusAt(a) * radiusScale;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  return shape;
}

const waterGeo = new THREE.ShapeGeometry(makeWaterOutlineShape(1), 1);
waterGeo.rotateX(-Math.PI / 2); // la Shape se construye en XY; se acuesta al plano XZ
waterGeo.scale(1, 1, WATER_Z_SQUASH);

// Agua de arroyo/laguna real: turbia, verdosa-parda por los sedimentos, no
// azul de pileta. Conserva reflejo del cielo (clearcoat + envMap) porque en
// la referencia se ve el cielo espejado en la superficie, pero el cuerpo del
// agua es opaco y terroso.
// Mapa de profundidad: la laguna es honda en el centro y somera en la
// orilla, y eso cambia el color — en el medio se ve el agua, en el borde se
// ve el fondo a través de ella. Sin este gradiente la lámina es una mancha
// de un solo tono, que es lo que más la delataba.
function makeWaterDepthTexture() {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.04, size / 2, size / 2, size * 0.52);
  // Tonos MUY oscuros, y no por gusto: la lámina está horizontal bajo un
  // HDRI de cielo completo, así que recibe la irradiancia de medio
  // hemisferio. Con un albedo medio el difuso satura y el agua sale blanca
  // — fue el primer intento y era el diagnóstico equivocado: el problema no
  // era que el color del agua fuese débil, era que reventaba.
  //
  // El agua real es oscura porque absorbe casi toda la luz que entra; lo
  // que vemos de ella es sobre todo reflejo. De ahí que el cuerpo vaya
  // oscuro y el cielo se sume encima.
  g.addColorStop(0.0, "rgb(62,72,52)");   // hondo: verde pardo
  g.addColorStop(0.45, "rgb(76,82,58)");
  g.addColorStop(0.78, "rgb(98,95,66)");  // somero: se transparenta el fondo
  g.addColorStop(1.0, "rgb(122,110,78)"); // orilla: se acerca al barro
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  // Manchas de sedimento en suspensión: el agua de laguna no es homogénea.
  for (let i = 0; i < 70; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 20 + Math.random() * 70;
    const v = Math.round(36 + Math.random() * 34);
    const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, `rgba(${v},${v - 4},${Math.round(v * 0.7)},0.16)`);
    rg.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

// Roughness variable: la superficie no es igual de lisa en todas partes —
// donde hay corriente o viento se riza y refleja menos, en los remansos
// queda espejada. Un roughness constante da ese aspecto de plástico
// barnizado que tenía antes.
function makeWaterRoughnessTexture() {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  // Centro en 0.62: modula el 0.34 del material hasta ~0.21 en los remansos
  // y ~0.4 donde riza el viento.
  ctx.fillStyle = "rgb(158,158,158)";
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 15 + Math.random() * 55;
    const v = Math.round(70 + Math.random() * 110);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${v},${v},${v},0.5)`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  return tex;
}

const waterDepthTex = makeWaterDepthTexture();
const waterRoughTex = makeWaterRoughnessTexture();

// Segunda capa de ondas: la misma textura procedural a otra escala y
// desplazándose en otra dirección. Una sola frecuencia de onda se lee como
// un patrón repetido; dos que se cruzan, como agua.
const waterNormalTex2 = waterNormalTex.clone();
waterNormalTex2.repeat.set(9, 9);
waterNormalTex2.needsUpdate = true;

const waterMat = new THREE.MeshPhysicalMaterial({
  color: 0xffffff, // el color lo pone el mapa de profundidad
  map: waterDepthTex,
  roughnessMap: waterRoughTex,
  metalness: 0.0,
  normalMap: waterNormalTex,
  normalScale: new THREE.Vector2(0.4, 0.4),
  // El HDRI de atardecer es muy luminoso: con más reflejo que esto la lámina
  // revienta a blanco y desaparece el color del agua. Una laguna turbia
  // refleja el cielo, pero no es un espejo.
  // LÍMITE TÉCNICO, y es el que gobierna toda esta decisión: Three.js
  // refleja el ENVIRONMENT MAP, no la geometría de la escena. El HDRI es un
  // "pure sky" — cielo y nada más —, así que por mucho que se afine el
  // reflejo, la laguna solo puede devolver cielo. No hay ángulo ni roughness
  // que traiga el sauce que tiene encima: para eso hace falta una CubeCamera
  // o un Reflector, que cuesta un render extra por frame y queda fuera de
  // una pasada de materiales (y es caro en un visor autónomo).
  //
  // Con la lámina casi horizontal bajo medio hemisferio de cielo, cualquier
  // intensidad apreciable la revienta a blanco: se probó con el albedo
  // llevado casi a negro y seguía blanca, porque lo que saturaba era el
  // especular. La salida honesta es dejar el reflejo en un brillo tenue y
  // que el agua se lea por su propio color, iluminada por el sol.
  envMapIntensity: 0.04,
  clearcoat: 0.0,
  // FASE 5: los valores de arriba son los de Fase 1 contra el HDRI de
  // atardecer de frente. Con el cielo nuevo (azul, sol a la espalda del visor)
  // el reflejo ya no revienta: se reemplazan más abajo por LOOK.water.
  clearcoatRoughness: 0.55,
  // FASE 1 (reparación): 0.3 seguía sin ser suficiente. Medido con capturas
  // recortadas y comparadas lado a lado: en 0.3, 0.1 e incluso 0.05 la
  // lámina seguía leyéndose gris pálido, no verde-parda. El specular de un
  // sol de intensidad 2.1 sobre una superficie casi horizontal (roughness
  // bajo) genera un lóbulo tan ancho que cubre casi toda el área visible
  // del agua desde las cámaras QC, sin importar cuánto se oscurezca el
  // albedo. Con specularIntensity en 0.02 (prácticamente apagado) el color
  // del mapa de profundidad por fin se lee. El clearcoat se quitó del todo
  // por la misma razón: sumaba otro lóbulo especular encima.
  specularIntensity: 0.02,
  // Subido de 0.5: con el specular casi apagado, un roughness más alto
  // dispersa el resto de brillo en vez de concentrarlo en un punto duro.
  roughness: 0.78,
  clearcoatNormalMap: waterNormalTex2,
  clearcoatNormalScale: new THREE.Vector2(0.22, 0.22),
});

// ShapeGeometry genera las UV a partir de las coordenadas XY crudas de la
// forma, o sea en unidades de mundo (-4.6 a 4.6 acá). El mapa de
// profundidad tiene que cubrir ese rango UNA vez y centrado, o el gradiente
// sale repetido o descuadrado; los de onda, en cambio, se repiten a dos
// escalas distintas a propósito.
waterGeo.computeBoundingBox();
{
  const bb = waterGeo.boundingBox;
  const spanX = bb.max.x - bb.min.x;
  const spanZ = bb.max.z - bb.min.z;
  const span = Math.max(spanX, spanZ) * 1.02;
  waterDepthTex.repeat.set(1 / span, 1 / span);
  waterDepthTex.offset.set(0.5, 0.5);
  waterDepthTex.needsUpdate = true;

  waterRoughTex.repeat.set(0.34, 0.34);
  waterNormalTex.repeat.set(1.1, 1.1);
  waterNormalTex2.repeat.set(2.7, 2.7);
  waterNormalTex.needsUpdate = true;
  waterNormalTex2.needsUpdate = true;
}

const water = new THREE.Mesh(waterGeo, waterMat);
water.position.set(WATER_CENTER[0], 0.17, WATER_CENTER[1]); // por encima del displacementScale del suelo (0.15) para que no quede tapada
scene.add(water);

// Orilla de barro expuesto: banda de tierra sin pasto entre el agua y la
// pradera, como en la referencia (el nivel del agua sube y baja y deja el
// borde pelado). Es un anillo con el mismo contorno irregular.
// El anillo de barro era un offset uniforme del contorno del agua (1.3×):
// un ancho constante todo alrededor, que se lee como una junta de goma.
// Ahora el ancho varía entre 1.08× y 1.55× con ruido a lo largo de la
// costa, así que hay playas anchas y tramos donde el pasto llega al agua.
// El ruido se calcula acá y no con reedBandWidth porque esta forma se
// construye antes de que exista el módulo ecológico.
function shoreWidthAt(angle) {
  const n =
    0.5 +
    0.28 * Math.sin(angle * 1.0 + 1.9) +
    0.16 * Math.sin(angle * 2.0 + 0.4) +
    0.09 * Math.sin(angle * 3.0 + 3.1) +
    0.05 * Math.sin(angle * 5.0 + 2.2);
  return 1.08 + Math.max(0, Math.min(1, n)) * 0.47;
}

// Anillo construido a mano, con FILAS concéntricas de vértices.
//
// Antes era una ShapeGeometry con agujero: 129 vértices en el contorno
// interior, 129 en el exterior y ninguno en medio. Eso anulaba el gradiente
// de humedad — la GPU interpola en línea recta entre los dos bordes, así que
// cualquier curva de secado solo actuaba en los extremos y media franja
// salía siempre tirando a tierra seca. Por eso la orilla se veía pálida
// aunque el barro junto al agua fuera oscuro.
//
// Con varias filas, la curva se representa de verdad. Las filas están más
// juntas cerca del agua, que es donde el color cambia más rápido.
//
// Convención de coordenadas: la misma que tenía la ShapeGeometry después de
// rotateX(-90°) y del achatamiento — (x, 0, -y·achat) —, para que el agua,
// la orilla y el bloque que pinta la humedad sigan hablando del mismo
// ángulo.
const SHORE_ROWS = 8;

function shoreRowScale(row, width) {
  if (row === 0) return 0.98; // bajo la lámina: evita una rendija en el borde
  const t = (row - 1) / (SHORE_ROWS - 2);
  return 1.0 + (width - 1.0) * Math.pow(t, 1.35);
}

const shoreGeo = new THREE.BufferGeometry();
{
  const cols = WATER_SEGMENTS + 1; // se repite la costura para cerrar limpio
  const positions = new Float32Array(cols * SHORE_ROWS * 3);
  for (let i = 0; i < cols; i++) {
    const a = (i / WATER_SEGMENTS) * Math.PI * 2;
    const rBase = waterRadiusAt(a);
    const width = shoreWidthAt(a);
    for (let k = 0; k < SHORE_ROWS; k++) {
      const r = rBase * shoreRowScale(k, width);
      const v = (i * SHORE_ROWS + k) * 3;
      positions[v] = Math.cos(a) * r;
      positions[v + 1] = 0;
      positions[v + 2] = -Math.sin(a) * r * WATER_Z_SQUASH;
    }
  }
  const index = [];
  for (let i = 0; i < WATER_SEGMENTS; i++) {
    for (let k = 0; k < SHORE_ROWS - 1; k++) {
      const a0 = i * SHORE_ROWS + k;
      const a1 = (i + 1) * SHORE_ROWS + k;
      const b0 = a0 + 1;
      const b1 = a1 + 1;
      // Orden elegido para que las caras miren hacia +Y (verificado con las
      // normales calculadas: una orilla mirando al suelo no recibe luz).
      index.push(a0, b0, a1, a1, b0, b1);
    }
  }
  shoreGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  shoreGeo.setIndex(index);
  shoreGeo.computeVertexNormals();
}

// Barro húmedo, no arena seca: más oscuro y más saturado que antes, porque
// un borde claro se recorta contra el pastizal y vuelve a marcar la línea
// que se quiere disimular.
// Lambert y no Standard, por una medición y no por gusto. Con píxeles
// leídos de la captura: los vértices de la orilla son marrón oscuro (sin
// luz, ≈68,52,28), pero iluminada subía a ≈97,77,65 — el doble de brillo
// que la tierra de al lado y con el azul casi triplicado. Ese término
// blanquecino no dependía del albedo ni del mapa de entorno (con
// envMapIntensity en 0 no cambiaba): era el especular de la luz directa en
// ángulo rasante, que en MeshStandardMaterial no se puede apagar.
//
// El suelo de al lado no lo sufre porque su mapa ARM le da roughness ~1 y
// oclusión. El barro opaco de una orilla no tiene brillo apreciable desde
// este ángulo, así que un material solo difuso es a la vez el más fiel y el
// más barato — también en el visor.
// FASE 5: el agua refleja el cielo nuevo (reflejo suave del gradiente, con
// fresnel) en vez de ser una placa opaca; roughness bajo pero no espejo.
waterMat.envMapIntensity = LOOK.water.envMapIntensity;
waterMat.roughness = LOOK.water.roughness;
waterMat.specularIntensity = LOOK.water.specularIntensity;

const shoreMat = new THREE.MeshLambertMaterial({
  color: 0xffffff,
  vertexColors: true,
  // FASE 1 (reparación): el color por vértice nunca es negro (WET_MUD tiene
  // luminosidad ~0.23), pero los juncos y pastos densos alrededor del agua
  // proyectan sombra sobre esta franja angosta, y esa sombra aplastaba un
  // marrón medio hasta leerse casi negro -- la "franja negra" del brief no
  // era el color, era la sombra encima del color. Un emissive tenue con el
  // mismo tono del barro sostiene el color mínimo aun en sombra total, sin
  // aplanar el resto de la variación de luz/sombra real de la orilla.
  emissive: new THREE.Color(0x2a2010),
  emissiveIntensity: 1.0,
});
const shore = new THREE.Mesh(shoreGeo, shoreMat);
shore.position.set(WATER_CENTER[0], 0.162, WATER_CENTER[1]); // apenas bajo el agua, sobre el suelo
shore.receiveShadow = true;
scene.add(shore);

// Ondas visuales de chapoteo: un anillo que se expande y se desvanece en
// la superficie, disparado junto con el sonido de chapoteo (playWaterSplash,
// definido más abajo) para que se vea Y se escuche el mismo evento — sin
// esto el agua sonaba viva pero se veía perfectamente quieta.
const splashRingGeo = new THREE.RingGeometry(0.06, 0.11, 20);
splashRingGeo.rotateX(-Math.PI / 2);
const activeSplashes = [];
let currentTime = 0; // actualizado en el render loop; usado para el timing de los splashes

function spawnSplashRing() {
  const angle = rng() * Math.PI * 2;
  const [x, z] = waterOutlinePoint(angle, rng() * 0.8);
  const mat = new THREE.MeshBasicMaterial({ color: 0xdfeff2, transparent: true, opacity: 0.55, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(splashRingGeo, mat);
  ring.position.set(x, 0.19, z);
  scene.add(ring);
  activeSplashes.push({ mesh: ring, start: currentTime, duration: 1400 + rng() * 400 });
}

// --- Vegetación nativa: árboles y arbustos (espinillo/algarrobo) ----------
// Generados procedimentalmente (bajo poly, InstancedMesh) en vez de bajar
// modelos de asset packs: da buen rendimiento en VR y una silueta más fiel
// al monte nativo/espinillar de la pampa que las especies genéricas
// (pinos, abetos) de las librerías 3D gratuitas disponibles.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260921);

const POI_KEEP_OUT = [
  [-2.5, -3],
  [0, -4.5],
  [2.5, -3],
].map(([x, z]) => new THREE.Vector2(x, z));

function farFromPOI(x, z, minDist) {
  const p = new THREE.Vector2(x, z);
  return POI_KEEP_OUT.every((k) => k.distanceTo(p) > minDist);
}

// ===========================================================================
// SISTEMA ECOLÓGICO: ruido, relieve, zonas y distribución en grupos
// ===========================================================================
// Lo que hacía que el paisaje se leyera como procedural no era el número de
// plantas ni su calidad: era que TODAS salían de un random uniforme dentro
// de un anillo. Eso reparte con densidad constante y sin correlación entre
// vecinos, que es exactamente lo que la naturaleza nunca hace. Un campo real
// se organiza por agua, suelo y competencia, y eso produce manchas, claros y
// gradientes.
//
// Acá se construye ese sustrato:
//   1. ruido de valor con fBm  → todo lo demás se cuelga de él
//   2. campo de altura         → el terreno deja de ser un plano
//   3. zonas ecológicas        → qué crece dónde, con fronteras irregulares
//   4. distribución en grupos  → cómo se reparte dentro de cada zona

// --- 1. Ruido de valor 2D (determinista, independiente del rng global) ----
// Se usa ruido de valor y no Perlin/Simplex a propósito: para máscaras de
// densidad y ondulaciones suaves no se distingue, y esto son veinte líneas
// sin dependencias.
function makeNoise2D(seed) {
  const perm = new Uint8Array(512);
  const order = new Uint8Array(256);
  for (let i = 0; i < 256; i++) order[i] = i;
  const shuffle = mulberry32(seed);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(shuffle() * (i + 1));
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  for (let i = 0; i < 512; i++) perm[i] = order[i & 255];

  const hash = (xi, zi) => perm[(perm[xi & 255] + zi) & 255] / 255;
  // Quintic: suaviza también la segunda derivada, así el terreno no muestra
  // las aristas de la grilla del ruido en las zonas planas.
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

  return function noise(x, z) {
    const xi = Math.floor(x);
    const zi = Math.floor(z);
    const xf = x - xi;
    const zf = z - zi;
    const u = fade(xf);
    const v = fade(zf);
    const a = hash(xi, zi);
    const b = hash(xi + 1, zi);
    const c = hash(xi, zi + 1);
    const d = hash(xi + 1, zi + 1);
    const top = a + (b - a) * u;
    const bottom = c + (d - c) * u;
    return top + (bottom - top) * v; // 0..1
  };
}

/** Suma de octavas: da detalle a varias escalas en vez de una sola mancha. */
function fbm(noise, x, z, octaves = 4, lacunarity = 2.0, gain = 0.5) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let freq = 1;
  for (let o = 0; o < octaves; o++) {
    sum += noise(x * freq, z * freq) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm; // 0..1
}

const terrainNoise = makeNoise2D(11071831); // el año de la Salsipuedes, como semilla
const monteNoise = makeNoise2D(482913);
const shrubNoise = makeNoise2D(90517);
const grassNoise = makeNoise2D(313377);
const flowerNoise = makeNoise2D(667401);
const shoreNoise = makeNoise2D(155320);

const smoothstep = (a, b, t) => {
  const x = Math.max(0, Math.min(1, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
};
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// --- 2. Distancia con signo a la orilla ----------------------------------
// Positiva fuera del agua, negativa dentro. Es la señal que gobierna toda la
// transición ribereña: juncal, suelo húmedo, pastizal de humedal y, más
// lejos, el monte. El contorno de la laguna ya es irregular (waterRadiusAt),
// así que estas bandas heredan esa sinuosidad sin esfuerzo.
function distanceToWater(x, z) {
  const dx = x - WATER_CENTER[0];
  const dz = (z - WATER_CENTER[1]) / WATER_Z_SQUASH;
  const angle = Math.atan2(dz, dx);
  return Math.hypot(dx, dz) - waterRadiusAt(angle);
}

/** Ancho del juncal en este punto de la costa. Varía de 0.5 a 2.3 m con el
 *  ángulo: una laguna real no tiene un cinturón de juncos de ancho
 *  constante — hay orillas abiertas y rincones cerrados de totora. */
function reedBandWidth(x, z) {
  const angle = Math.atan2(z - WATER_CENTER[1], x - WATER_CENTER[0]);
  const n = fbm(shoreNoise, Math.cos(angle) * 2.5 + 10, Math.sin(angle) * 2.5 + 10, 3);
  return 0.5 + n * 1.8;
}

// --- 3. Campo de altura --------------------------------------------------
// Ondulaciones suaves, nunca colinas. La amplitud total ronda los 25 cm en
// 30 m de terreno: suficiente para que la línea del suelo deje de ser recta
// y para que las plantas se asienten a distintas alturas, sin que se note
// como relieve dramático ni rompa la sensación de llanura, que es lo que la
// pampa es.
const TERRAIN_AMPLITUDE = 0.22;
const WATER_SURFACE_Y = 0.17;

function terrainHeight(x, z) {
  const d = distanceToWater(x, z);

  // Ondulación general de escala grande + rugosidad fina encima.
  // El factor 2.6 no es decorativo: el fBm de ruido de valor se concentra
  // alrededor de 0.5 y su desviación real ronda ±0.2, no ±0.5. Sin
  // normalizarlo, una amplitud nominal de 22 cm daba un relieve medido de
  // 15 cm en 30 m de terreno — invisible. Con el factor, el rango queda en
  // unos 40 cm: una loma de 40 cm cada 15 m es un 1,3% de pendiente, que es
  // ondulación de pampa, no una colina.
  const broad = (fbm(terrainNoise, x * 0.055 + 50, z * 0.055 + 50, 3) - 0.5) * 2.6;
  const fine = (fbm(terrainNoise, x * 0.22 + 200, z * 0.22 + 200, 2) - 0.5) * 2.2;
  let h = broad * TERRAIN_AMPLITUDE + fine * TERRAIN_AMPLITUDE * 0.22;

  // El relieve se apaga al acercarse al agua. No es un detalle estético: la
  // lámina y la orilla de barro son mallas planas a altura fija, y si el
  // terreno subiera o bajara debajo de ellas quedarían flotando o enterradas.
  // Levantar el agua a un terreno ondulado es una tarea aparte y más cara.
  h *= smoothstep(0.0, 3.0, d);

  // Depresión húmeda: una franja apenas hundida a uno o dos metros de la
  // orilla, que es donde el nivel sube y baja. Vale 0 justo en el borde —
  // por lo mismo de arriba — y se desvanece a los 6 m.
  h -= 0.06 * smoothstep(0.0, 1.2, d) * (1 - smoothstep(1.2, 6.0, d));

  return h;
}

/** Altura del suelo para asentar una instancia. Si la vegetación no
 *  muestrea esto, el relieve solo sirve para que las plantas floten. */
function groundY(x, z) {
  return terrainHeight(x, z);
}

/** Humedad del suelo, 0 (seco) a 1 (empapado). Manda la distancia al agua,
 *  pero el ruido la desordena para que no queden anillos concéntricos. */
function soilMoisture(x, z) {
  const d = distanceToWater(x, z);
  const base = 1 - smoothstep(0.0, 6.0, Math.max(0, d));
  const n = fbm(shoreNoise, x * 0.12 + 70, z * 0.12 + 70, 3) - 0.5;
  return clamp01(base + n * 0.35);
}

// --- 4. Zonas ecológicas -------------------------------------------------
// Las fronteras no son círculos ni rectas: cada máscara mezcla la distancia
// al agua con ruido, así que los límites entran y salen de forma irregular.
const ZONES = {
  AGUA: "agua",
  JUNCAL: "juncal",
  HUMEDAL: "humedal",
  PASTIZAL_HUMEDO: "pastizal_humedo",
  PASTIZAL_ABIERTO: "pastizal_abierto",
  MATORRAL: "matorral",
  MONTE: "monte",
  CLARO: "claro",
};

/** Densidad de monte: dónde hay masa de árboles y dónde hay claro.
 *  Es la máscara que crea grupos y vacíos en vez de reparto parejo. */
function monteDensity(x, z) {
  const n = fbm(monteNoise, x * 0.075 + 30, z * 0.075 + 30, 4);
  // El umbral alto es lo que abre los claros: por debajo de 0.44 no crece
  // ningún árbol, y eso es más o menos un tercio del terreno.
  let d = smoothstep(0.44, 0.78, n);
  // Cerca del agua el monte rarea (suelo saturado) y muy lejos también
  // (queda el pastizal abierto de la llanura).
  const dw = distanceToWater(x, z);
  d *= smoothstep(1.2, 4.0, dw);
  d *= 1 - smoothstep(14.0, 19.0, Math.hypot(x, z));
  return clamp01(d);
}

function matorralDensity(x, z) {
  const n = fbm(shrubNoise, x * 0.11 + 80, z * 0.11 + 80, 4);
  let d = smoothstep(0.42, 0.72, n);
  // El matorral ocupa sobre todo el borde del monte: donde hay algo de
  // árboles pero no masa cerrada. Es lo que pasa de verdad — los arbustos
  // no prosperan ni en el pastizal raso ni bajo el dosel denso.
  const m = monteDensity(x, z);
  d *= 0.35 + 1.3 * m * (1 - m) * 2.2;
  d *= smoothstep(0.6, 2.2, distanceToWater(x, z));
  return clamp01(d);
}

function grassDensity(x, z) {
  const n = fbm(grassNoise, x * 0.14 + 120, z * 0.14 + 120, 3);
  // Las gramíneas son lo contrario del monte: llenan lo que los árboles
  // dejan libre. Por eso la densidad crece donde monteDensity baja.
  const open = 1 - monteDensity(x, z) * 0.6;
  // Suelo mínimo de 0.35: un claro es un claro de ÁRBOLES, no un desierto.
  // Sin este piso, las zonas de baja densidad quedaban de tierra pelada, que
  // es exactamente el aspecto artificial que se quería quitar.
  return clamp01(Math.max(0.35, (0.45 + n * 0.75) * open));
}

/** Máscara de manchas de flores. Deliberadamente restrictiva: las flores
 *  tienen que ser un detalle localizado, no una alfombra. */
function flowerPatch(x, z) {
  const n = fbm(flowerNoise, x * 0.19 + 300, z * 0.19 + 300, 3);
  return smoothstep(0.50, 0.66, n);
}

/** Apertura visual alrededor de los personajes: no viven en un jardín, y
 *  desde la cámara tiene que haber línea de visión hacia ellos. */
function poiClearing(x, z) {
  let openness = 1;
  for (const k of POI_KEEP_OUT) {
    const d = Math.hypot(x - k.x, z - k.y);
    // Espacio de actividad despejado hasta 2 m, difuminado hasta 3.6 m.
    openness = Math.min(openness, smoothstep(2.0, 3.6, d));
  }
  // Corredor visual desde la cámara (0, 4) hacia los marcadores. La primera
  // versión abría una cuña de 11 m y dejaba el primer plano pelado, que es
  // peor que tener los personajes medio tapados: un claro perfectamente
  // despejado delante de la cámara se lee como un pasillo, no como un
  // paisaje. Ahora solo despeja el tramo donde están los marcadores (de 3 a
  // 9 m) y solo para lo que de verdad tapa: los árboles.
  const toX = x - 0;
  const toZ = z - 4;
  const dist = Math.hypot(toX, toZ);
  if (dist > 3.0 && dist < 9.0 && toZ < 0) {
    const lateral = Math.abs(toX / Math.max(1, Math.abs(toZ)));
    if (lateral < 0.4) openness = Math.min(openness, 0.5 + lateral);
  }
  return clamp01(openness);
}

function ecologicalZone(x, z) {
  const d = distanceToWater(x, z);
  if (d < 0) return ZONES.AGUA;
  if (d < reedBandWidth(x, z)) return ZONES.JUNCAL;
  const moisture = soilMoisture(x, z);
  if (moisture > 0.62) return ZONES.HUMEDAL;
  if (monteDensity(x, z) > 0.45) return ZONES.MONTE;
  if (matorralDensity(x, z) > 0.4) return ZONES.MATORRAL;
  if (moisture > 0.3) return ZONES.PASTIZAL_HUMEDO;
  if (grassDensity(x, z) < 0.28) return ZONES.CLARO;
  return ZONES.PASTIZAL_ABIERTO;
}

// --- 5. Distribución ----------------------------------------------------
/** Valor con forma de campana en [min,max]: promedio de tres uniformes.
 *  Random puro reparte tamaños planos y produce vecinos idénticos de tamaño
 *  distinto al azar; esto da mayoría de individuos medianos y unos pocos
 *  extremos, que es la estructura de edades de un monte real. */
function bellRange(r, min, max) {
  const t = (r() + r() + r()) / 3;
  return min + t * (max - min);
}

/** Inclinación natural: casi todos verticales, algunos levemente ladeados.
 *  Devuelve radianes. */
function naturalTilt(r) {
  const roll = r();
  if (roll < 0.70) return r() * 0.035;          // 70% prácticamente a plomo
  if (roll < 0.90) return 0.035 + r() * 0.055;  // 20% apenas inclinados
  return 0.09 + r() * 0.07;                     // 10% con algo más de caída
}

/** Reparto en grupos con máscara de densidad y distancia mínima.
 *
 *  Tres mecanismos combinados, ninguno suficiente por sí solo:
 *   - semillas de grupo pesadas por la máscara → manchas y claros;
 *   - dispersión gaussiana alrededor de cada semilla → grupos de tamaño
 *     variable, no discos uniformes;
 *   - rechazo por distancia mínima (Poisson) → nada de pares pegados,
 *     que es lo que delata un random puro.
 *
 *  `solitaryRatio` reserva una fracción de individuos aislados: un monte
 *  solo de grupos se lee tan artificial como uno solo de individuos.
 */
function clusteredScatter({
  count,
  rMin,
  rMax,
  density,
  clusterCount,
  clusterRadius,
  minDist,
  solitaryRatio = 0.18,
  poiDist = 1.0,
  waterMargin = 0.6,
  rand,
  maxAttempts = 60,
}) {
  const r = rand;
  const points = [];
  const accepted = [];

  const valid = (x, z) => {
    const rad = Math.hypot(x, z);
    if (rad < rMin || rad > rMax) return false;
    if (insideWater(x, z, waterMargin)) return false;
    if (!farFromPOI(x, z, poiDist)) return false;
    for (const [px, pz] of accepted) {
      if ((px - x) * (px - x) + (pz - z) * (pz - z) < minDist * minDist) return false;
    }
    return true;
  };

  const push = (x, z) => {
    points.push([x, z]);
    accepted.push([x, z]);
  };

  // Semillas de grupo: se prueban posiciones y se aceptan con probabilidad
  // proporcional a la máscara, así los grupos caen donde la ecología los
  // pone y no donde cayó el dado.
  const seeds = [];
  let tries = 0;
  while (seeds.length < clusterCount && tries < clusterCount * 200) {
    tries++;
    const a = r() * Math.PI * 2;
    const rad = rMin + Math.sqrt(r()) * (rMax - rMin); // sqrt: área uniforme
    const x = Math.cos(a) * rad;
    const z = Math.sin(a) * rad;
    if (insideWater(x, z, waterMargin)) continue;
    if (r() < density(x, z)) seeds.push([x, z, 2 + Math.floor(r() * 6)]); // 2..7 por grupo
  }

  const solitaryTarget = Math.round(count * solitaryRatio);

  // Individuos de grupo
  for (const [sx, sz, size] of seeds) {
    if (points.length >= count - solitaryTarget) break;
    const spread = clusterRadius * (0.55 + r() * 0.9); // grupos de distinto tamaño
    for (let i = 0; i < size; i++) {
      let placed = false;
      for (let a = 0; a < maxAttempts && !placed; a++) {
        // Gaussiana aproximada: concentra cerca del centro del grupo y deja
        // algún individuo en la periferia.
        const g1 = (r() + r() + r() - 1.5) / 1.5;
        const g2 = (r() + r() + r() - 1.5) / 1.5;
        const x = sx + g1 * spread;
        const z = sz + g2 * spread;
        if (valid(x, z)) {
          push(x, z);
          placed = true;
        }
      }
      if (points.length >= count - solitaryTarget) break;
    }
  }

  // Individuos aislados, en cualquier punto donde la máscara lo permita
  let solitaryTries = 0;
  while (points.length < count && solitaryTries < count * 120) {
    solitaryTries++;
    const a = r() * Math.PI * 2;
    const rad = rMin + Math.sqrt(r()) * (rMax - rMin);
    const x = Math.cos(a) * rad;
    const z = Math.sin(a) * rad;
    if (r() > density(x, z) * 0.85) continue;
    if (valid(x, z)) push(x, z);
  }

  return points;
}

// --- Paleta del suelo: cinco materiales que se mezclan -------------------
// Vive acá, antes de plantar nada, porque la usan DOS cosas: el pintado del
// terreno y el tinte de la cobertura baja. Si cada una tuviera su paleta, la
// cobertura se recortaría contra la tierra como gravilla — que es justo lo
// que pasó al oscurecer la ribera y dejar las matitas con su color viejo.
const SOIL_DRY      = new THREE.Color(0xC2B189); // tierra seca, clara
const SOIL_NORMAL   = new THREE.Color(0x9D8B62); // tierra de pastizal
const SOIL_WET      = new THREE.Color(0x77613F); // barro húmedo de ribera
const SOIL_ORGANIC  = new THREE.Color(0x6B5C3E); // hojarasca bajo el monte
const SOIL_LOWGRASS = new THREE.Color(0x8C9256); // verde del pasto raso

const _soilMix = new THREE.Color();

/** Color del suelo en un punto, mezclando los cinco materiales según
 *  humedad, altura, pendiente, densidad de monte y de pasto, más ruido.
 *  `y` es opcional: si no se pasa, se calcula. */
function soilColorAt(x, z, target, y) {
  const height = y === undefined ? terrainHeight(x, z) : y;
  const moisture = soilMoisture(x, z);
  const under = monteDensity(x, z);
  const grass = grassDensity(x, z);

  // Pendiente por diferencias finitas: en una ladera la tierra queda
  // lavada y expuesta; en un hondo se acumula materia y humedad.
  const EPS = 0.35;
  const dhx = (terrainHeight(x + EPS, z) - terrainHeight(x - EPS, z)) / (2 * EPS);
  const dhz = (terrainHeight(x, z + EPS) - terrainHeight(x, z - EPS)) / (2 * EPS);
  const slope = clamp01(Math.hypot(dhx, dhz) * 5.5);

  // Frecuencia limitada por el muestreo: los vértices del suelo están cada
  // ~19 cm, así que por encima de ~0.5 ciclos por unidad el ruido aliasea y
  // el terreno sale moteado como sal y pimienta en vez de granulado.
  const blotch = fbm(terrainNoise, x * 0.35 + 900, z * 0.35 + 900, 3);
  const grain = fbm(shoreNoise, x * 0.45 + 1300, z * 0.45 + 1300, 2);

  const relative = clamp01(0.5 + height / (TERRAIN_AMPLITUDE * 1.6));
  const wet = clamp01(moisture * 1.15 - relative * 0.25 + (blotch - 0.5) * 0.35);

  const dryness = clamp01(relative * 0.55 + slope * 0.35 + (blotch - 0.5) * 0.5);
  _soilMix.copy(SOIL_NORMAL).lerp(SOIL_DRY, dryness);
  _soilMix.lerp(SOIL_LOWGRASS, clamp01((grass - 0.42) * 1.25) * 0.55);

  // Hojarasca bajo el monte. El ruido rompe el disco perfecto que daría una
  // máscara radial limpia.
  _soilMix.lerp(SOIL_ORGANIC, clamp01(under * 1.2 + (grain - 0.5) * 0.5) * 0.75);

  // La humedad va última porque manda sobre todo lo demás: el barro mojado
  // no es tierra seca teñida, es otro material.
  _soilMix.lerp(SOIL_WET, wet * 0.62);

  target.copy(_soilMix).multiplyScalar(0.92 + grain * 0.16);
  target.userWet = wet;
  return wet;
}

// Puntos donde una planta toca el suelo. Se usan al final para oscurecer
// la tierra a su pie: sin eso, todo objeto se lee como "apoyado encima" en
// vez de "creciendo desde ahí".
const contactPoints = [];

// --- 6. Aplicar el relieve a la malla del suelo --------------------------
// El displacement del material (0.15) sigue dando la rugosidad fina de la
// textura; esto agrega la ondulación de escala grande, que es geometría real
// y por lo tanto se puede muestrear desde JS para asentar la vegetación.
{
  const pos = groundGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, terrainHeight(pos.getX(i), pos.getZ(i)));
  }
  pos.needsUpdate = true;
  groundGeo.computeVertexNormals();
}

// Compatibilidad: quedan sistemas (fauna, mariposas) que no son vegetación
// y para los que un reparto disperso es correcto. Mantienen esta función.
function scatterPositions(count, rMin, rMax, minDistFromPOI) {
  const points = [];
  let attempts = 0;
  while (points.length < count && attempts < count * 30) {
    attempts++;
    const angle = rng() * Math.PI * 2;
    const r = rMin + rng() * (rMax - rMin);
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;
    if (farFromPOI(x, z, minDistFromPOI) && !insideWater(x, z)) points.push([x, z]);
  }
  return points;
}

const dummy = new THREE.Object3D();

// ===========================================================================
// FASE 3 — vegetación HERO: los ejemplares más cercanos al punto de vista
// ===========================================================================
// La cámara no tiene locomoción: está fija en (0, 1.6, 4) y mira hacia -Z.
// Eso vuelve literal lo que en un proyecto con recorrido libre habría que
// estimar con un sistema de LOD por distancia — acá "cerca del espectador"
// es UN punto conocido, no una heurística. `heroDist` mide contra ese punto
// y decide, por distancia real y no por índice, qué ejemplares merecen
// geometría multi-lóbulo en vez del blob único que arrastra toda la
// vegetación desde la Fase 1.
//
// Esta pasada toca solo lo que el usuario pidió ver primero: 2-3 arbustos
// del primer plano, los sauces de la orilla y la mata de cortadera más
// cercana al agua. El resto de la vegetación (monte, resto de arbustos,
// ombú, ceibo) queda con su geometría actual — no se autoriza extender el
// sistema hasta que esto se apruebe.
const HERO_VIEW_POS = { x: 0, y: 1.6, z: 4 };
function heroDist(x, z) {
  return Math.hypot(x - HERO_VIEW_POS.x, z - HERO_VIEW_POS.z);
}
const HERO_GROUP = new THREE.Group();
scene.add(HERO_GROUP);

// ===========================================================================
// FASE 4 — extensión controlada al plano medio
// ===========================================================================
// Zonificación visual. No alcanza con la distancia en metros: un árbol de
// 3 m a 12 m ocupa en pantalla lo mismo que un arbusto de 0,6 m a 2,4 m. Se
// mide el TAMAÑO APARENTE (el ángulo vertical que ocupa el objeto desde el
// punto de vista fijo) y se lo pondera por relevancia compositiva: lo que
// cae en el cono frontal —el visor arranca mirando hacia -Z, hacia el monte y
// los personajes— pesa más que lo que queda a la espalda. Es LOD por tamaño
// en pantalla decidido una sola vez, porque la cámara no se desplaza: no hay
// transiciones en vivo y por lo tanto no hay popping que disimular.
const TIER_RANK = { HERO: 0, FOREGROUND: 1, MIDGROUND_NEAR: 2, MIDGROUND_FAR: 3, BACKGROUND: 4, HORIZON: 5 };
const tierRegistry = {}; // asset -> { zona -> cantidad }, para el informe
function registerTier(asset, tier) {
  const r = (tierRegistry[asset] ??= {});
  r[tier] = (r[tier] || 0) + 1;
}
function visualTier(x, z, height, asset) {
  const d = Math.max(0.5, heroDist(x, z));
  const angular = THREE.MathUtils.radToDeg(2 * Math.atan(height / 2 / d));
  const facing = -(z - HERO_VIEW_POS.z) / d; // 1 = justo enfrente, -1 = detrás
  const relevance = 0.8 + 0.2 * clamp01((facing + 0.2) / 0.9);
  const score = angular * relevance;
  // Umbrales en grados pensados en píxeles del visor (~20 px por grado en
  // Quest 2/3): más de 20° (>400 px) es primer plano; 8–20° (160–400 px)
  // plano medio cercano; 3,5–8° (70–160 px) plano medio lejano; por debajo,
  // fondo. Un árbol de 2,4 m a 12 m ocupa ~11°: sigue siendo plano medio.
  let tier;
  if (d > 24) tier = "HORIZON";
  else if (score > 20) tier = "FOREGROUND";
  else if (score > 8) tier = "MIDGROUND_NEAR";
  else if (score > 3.5) tier = "MIDGROUND_FAR";
  else tier = "BACKGROUND";
  if (asset) registerTier(asset, tier);
  return tier;
}
// El viento baja con la zona: el primer plano se mueve entero, el fondo
// apenas respira. Un fondo quieto se lee muerto; uno que se mueve igual que
// el primer plano aplana la profundidad.
const TIER_WIND = { HERO: 1, FOREGROUND: 1, MIDGROUND_NEAR: 0.85, MIDGROUND_FAR: 0.6, BACKGROUND: 0.35, HORIZON: 0.15 };

// --- Viento por shader -----------------------------------------------------
// Hasta la Fase 3 el viento se hacía en CPU: cada frame se recomponía la
// matriz de ~8.600 instancias (pasto, copas, hojas de copa) y se subían a la
// GPU. Para el plano medio eso se pasa al vertex shader: el balanceo es el
// mismo (misma fórmula de dos senos), pero no cuesta CPU ni ancho de banda.
// La fase sale de un atributo o de la posición de la instancia, así que dos
// plantas vecinas nunca se mueven sincronizadas.
const windUniforms = {
  uWindTime: { value: 0 },
  uViewPos: { value: new THREE.Vector3(HERO_VIEW_POS.x, HERO_VIEW_POS.y, HERO_VIEW_POS.z) },
};
const WIND_GLSL = /* glsl */ `
uniform float uWindTime;
uniform vec3 uViewPos;
mat3 windRot(float ax, float az) {
  float cx = cos(ax), sx = sin(ax), cz = cos(az), sz = sin(az);
  return mat3(1.0, 0.0, 0.0, 0.0, cx, sx, 0.0, -sx, cx) * mat3(cz, sz, 0.0, -sz, cz, 0.0, 0.0, 0.0, 1.0);
}
`;
function windRotGLSL(mode, w) {
  const f = (v) => v.toFixed(4);
  const angle = (ph) =>
    `(sin(uWindTime * ${f(w.f1)} + ${ph}) * ${f(w.a1)} + sin(uWindTime * ${f(w.f2)} + ${ph} * 1.4) * ${f(w.a2)})`;
  if (mode === "pivot") {
    // Malla horneada: cada vértice sabe el pivote y la fase de SU ejemplar.
    return `float wA = aWind.y * ${angle("aWind.x")}; mat3 wR = windRot(wA, wA * ${f(w.zRatio)});`;
  }
  // Instancias: fase por hash de la posición y amplitud que cae con la
  // distancia al punto de vista.
  return `
#ifdef USE_INSTANCING
    vec3 wIP = vec3(instanceMatrix[3]);
#else
    vec3 wIP = vec3(0.0);
#endif
    float wPh = fract(sin(dot(wIP.xz, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831853;
    float wFade = mix(1.0, ${f(w.farAmp)}, smoothstep(${f(w.near)}, ${f(w.far)}, distance(wIP.xz, uViewPos.xz)));
    float wA = wFade * ${angle("wPh")}; mat3 wR = windRot(wA, wA * ${f(w.zRatio)});`;
}
function windify(material, mode, w) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWindTime = windUniforms.uWindTime;
    shader.uniforms.uViewPos = windUniforms.uViewPos;
    const rot = windRotGLSL(mode, w);
    const header = WIND_GLSL + (mode === "pivot" ? "attribute vec3 aPivot;\nattribute vec2 aWind;\n" : "");
    const move = mode === "pivot" ? "transformed = aPivot + wR * (transformed - aPivot);" : "transformed = wR * transformed;";
    shader.vertexShader =
      header +
      shader.vertexShader
        .replace("#include <beginnormal_vertex>", `#include <beginnormal_vertex>\n  { ${rot}\n    objectNormal = wR * objectNormal; }`)
        .replace("#include <begin_vertex>", `#include <begin_vertex>\n  { ${rot}\n    ${move} }`);
  };
  const key = `wind:${mode}:${JSON.stringify(w)}`;
  material.customProgramCacheKey = () => key;
  return material;
}
// La sombra tiene que moverse con la planta: el material de profundidad por
// defecto no conoce el viento del shader y dejaría la sombra quieta.
function windDepthMaterial(mode, w, src) {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  if (src?.alphaMap) {
    m.alphaMap = src.alphaMap;
    m.alphaTest = src.alphaTest;
    m.side = THREE.DoubleSide;
  }
  return windify(m, mode, w);
}

// --- Masas de follaje por lóbulos -----------------------------------------
// Ruido suave (suma de senos). A diferencia del hash por vértice que usa
// makeOrganicGeometry, da la MISMA forma a cualquier resolución: los niveles
// de detalle de un lóbulo comparten silueta y solo cambia cuán fina es.
function smoothNoise3(x, y, z, s) {
  return (
    0.55 * Math.sin(1.7 * x + s * 1.3) * Math.sin(1.9 * y + s * 0.7) * Math.sin(1.3 * z + s * 2.1) +
    0.3 * Math.sin(3.3 * x - s) * Math.sin(2.9 * z + s * 1.7) +
    0.15 * Math.sin(5.1 * y + 3.7 * x + s * 0.3)
  );
}
// Octava fina: los grumos de las ramitas que forman la superficie de una
// masa de follaje. Sin ella el lóbulo liso se lee como una burbuja de goma.
function fineNoise3(x, y, z, s) {
  return (
    Math.sin(6.3 * x + s * 2.3) * Math.sin(5.7 * y - s) * Math.sin(6.9 * z + s * 0.9) * 0.6 +
    Math.sin(9.7 * x + 8.3 * z + s * 1.9) * Math.sin(8.9 * y + s * 3.1) * 0.4
  );
}

// Lóbulo liso: icosaedro con los vértices SOLDADOS antes de calcular
// normales. El icosaedro de three viene sin indexar, y por eso todo el
// follaje de la escena se veía facetado: cada cara tenía su propia normal.
function makeLobe(r, detail, seed, amount, flatten, fine = 0.1) {
  let g = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute("normal");
  g.deleteAttribute("uv");
  g = mergeVertices(g);
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    v.multiplyScalar(1 + smoothNoise3(v.x * 1.6, v.y * 1.6, v.z * 1.6, seed) * amount + fineNoise3(v.x, v.y, v.z, seed) * fine);
    // Base achatada: una masa de follaje real cuelga y se aplana abajo.
    if (v.y < -flatten) v.y = -flatten + (v.y + flatten) * 0.35;
    pos.setXYZ(i, v.x * r, v.y * r, v.z * r);
  }
  return g;
}

// Une los lóbulos de un layout [[x, y, z, r], ...] en una sola geometría y
// hornea `aAO`: más oscuro abajo y hacia el interior de la masa, que es la
// sombra propia que una copa real tiene y que sin textura horneada falta.
function buildLobeMass(layout, detail, seed, { amount = 0.22, flatten = 0.55, aoMin = 0.66, fine = 0.1, bend = 0.62, dapple = 0.3 } = {}) {
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const [, y, , r] of layout) {
    yMin = Math.min(yMin, y - r);
    yMax = Math.max(yMax, y + r);
  }
  const lr = mulberry32(seed * 7 + 11);
  const parts = layout.map(([lx, ly, lz, r], li) => {
    // Sin detalle suficiente la octava fina solo agrega ruido de vértice.
    const g = makeLobe(r, detail, seed + li * 17.3, amount, flatten, detail >= 2 ? fine : fine * 0.4);
    const pos = g.attributes.position;
    const ao = new Float32Array(pos.count);
    const lobeTint = 0.93 + lr() * 0.14; // cada lóbulo, un matiz apenas distinto
    for (let i = 0; i < pos.count; i++) {
      const ny = pos.getY(i) / r;
      const gy = (ly + pos.getY(i) - yMin) / (yMax - yMin);
      ao[i] = (aoMin + (1 - aoMin) * clamp01(0.55 * (ny * 0.5 + 0.5) + 0.45 * gy)) * lobeTint;
    }
    g.translate(lx, ly, lz);
    g.setAttribute("aAO", new THREE.BufferAttribute(ao, 1));
    return g;
  });
  const merged = mergeGeometries(parts);
  merged.computeVertexNormals();
  // Normales curvadas hacia afuera de la MASA entera (técnica estándar de
  // follaje): con la normal de cada lóbulo, cada uno se sombrea como una
  // esfera propia y la copa se lee como un racimo de burbujas. Mezcladas con
  // la dirección desde el centro de la copa, la luz recorre la masa completa
  // y los lóbulos quedan solo en la silueta, que es donde tienen que estar.
  // Moteado: variación de valor por vértice, el "grano" de las ramitas.
  const cy = (yMin + yMax) / 2;
  const pos = merged.attributes.position;
  const nrm = merged.attributes.normal;
  const aoAttr = merged.attributes.aAO;
  const n = new THREE.Vector3();
  const dir = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i);
    const py = pos.getY(i);
    const pz = pos.getZ(i);
    dir.set(px, (py - cy) * 1.3, pz).normalize();
    n.fromBufferAttribute(nrm, i).lerp(dir, bend).normalize();
    nrm.setXYZ(i, n.x, n.y, n.z);
    aoAttr.setX(i, aoAttr.getX(i) * (1 - dapple / 2 + dapple * hashNoise3(px * 7.1 + seed, py * 7.1, pz * 7.1)));
  }
  return merged;
}

// Punto de la superficie de la masa en la dirección (nx, ny, nz) desde su
// centro: sirve para apoyar las hojas recortadas SOBRE los lóbulos y no
// sobre el elipsoide viejo, que ahora dejaría hojas flotando en los huecos.
function lobeSurface(layout, nx, ny, nz, out) {
  let best = -1;
  for (const [cx, cy, cz, r] of layout) {
    const b = nx * cx + ny * cy + nz * cz;
    const disc = b * b - (cx * cx + cy * cy + cz * cz - r * r);
    if (disc < 0) continue;
    best = Math.max(best, b + Math.sqrt(disc));
  }
  if (best > 0) return out.set(nx * best, ny * best, nz * best);
  // Dirección que cae en un hueco: se apoya en el lóbulo más alineado.
  let L = layout[0];
  let bd = -Infinity;
  for (const l of layout) {
    const len = Math.hypot(l[0], l[1], l[2]) || 1;
    const d = (nx * l[0] + ny * l[1] + nz * l[2]) / len;
    if (d > bd) {
      bd = d;
      L = l;
    }
  }
  return out.set(L[0] + nx * L[3], L[1] + ny * L[3], L[2] + nz * L[3]);
}

// Horneado de ejemplares en UNA malla: cada copia va a coordenadas de mundo
// con su color (tono del ejemplar × AO), su pivote y su fase de viento como
// atributos. Un draw call para decenas de ejemplares de formas distintas,
// que con InstancedMesh exigiría una malla por variante.
function bakeInstances(items) {
  if (!items.length) return new THREE.BufferGeometry(); // zona vacía: malla sin nada que dibujar
  const parts = items.map((it) => {
    const g = it.geo.clone().applyMatrix4(it.matrix);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    const piv = new Float32Array(n * 3);
    const wind = new Float32Array(n * 2);
    const ao = g.attributes.aAO;
    for (let i = 0; i < n; i++) {
      const a = ao ? ao.getX(i) : 1;
      col[i * 3] = it.color.r * a;
      col[i * 3 + 1] = it.color.g * a;
      col[i * 3 + 2] = it.color.b * a;
      piv[i * 3] = it.pivot[0];
      piv[i * 3 + 1] = it.pivot[1];
      piv[i * 3 + 2] = it.pivot[2];
      wind[i * 2] = it.phase;
      wind[i * 2 + 1] = it.amp;
    }
    if (ao) g.deleteAttribute("aAO");
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setAttribute("aPivot", new THREE.BufferAttribute(piv, 3));
    g.setAttribute("aWind", new THREE.BufferAttribute(wind, 2));
    if (it.uvScale) {
      // UV en espacio de mundo: dos arbustos vecinos no repiten el mismo
      // moteado en el mismo lugar.
      const p = g.attributes.position;
      const uv = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        const x = p.getX(i);
        const y = p.getY(i);
        const z = p.getZ(i);
        uv[i * 2] = (x + z * 0.5) * it.uvScale;
        uv[i * 2 + 1] = (y + (x - z) * 0.35) * it.uvScale;
      }
      g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    }
    return g;
  });
  const merged = mergeGeometries(parts);
  parts.forEach((g) => g.dispose());
  return merged;
}

// Engorda los lóbulos de un layout: con radios justos quedaban esferas
// apenas tocándose (racimo de uvas); solapadas se leen como UNA masa.
const inflateLobes = (layout, k) => layout.map(([x, y, z, r]) => [x, y, z, r * k]);

// Elección de variante sin repetir la del vecino: dentro de `radius` metros
// no puede haber dos ejemplares con la misma forma. Rng propio por sistema.
function makeVariantPicker(count, radius, rand) {
  const placed = [];
  return (x, z, weights) => {
    const banned = new Set();
    for (const p of placed) if (Math.hypot(p.x - x, p.z - z) < radius) banned.add(p.v);
    let total = 0;
    const w = [];
    for (let v = 0; v < count; v++) {
      const wv = banned.has(v) && banned.size < count ? 0 : weights ? weights[v] : 1;
      w.push(wv);
      total += wv;
    }
    let pick = rand() * total;
    let v = 0;
    while (v < count - 1 && pick >= w[v]) pick -= w[v++];
    placed.push({ x, z, v });
    return v;
  };
}

// --- Variación natural de color por individuo ---------------------------
// Dos plantas de la misma especie nunca tienen exactamente el mismo verde,
// y esa diferencia es de las señales más fuertes de que algo está vivo y no
// instanciado. Los márgenes son deliberadamente estrechos — tono ±4%,
// saturación ±7%, luminosidad ±9% — porque pasados esos valores deja de
// leerse como variación natural y empieza a leerse como plantas de colores
// distintos.
const _hsl = { h: 0, s: 0, l: 0 };

function jitterColor(target, baseHex, r) {
  target.set(baseHex);
  target.getHSL(_hsl);
  const h = (_hsl.h + (r() - 0.5) * 0.08 + 1) % 1;
  const sat = clamp01(_hsl.s * (1 + (r() - 0.5) * 0.14));
  const lum = clamp01(_hsl.l * (1 + (r() - 0.5) * 0.18));
  // Suelos mínimos: ni el follaje más oscuro puede quedarse sin información
  // de color. Un negro absoluto no existe en vegetación real — lo que se ve
  // negro en una foto sigue teniendo tono y saturación.
  target.setHSL(h, Math.max(0.12, sat), Math.max(0.13, lum));
  return target;
}

// Árboles: tronco + copa irregular (silueta tipo espinillo/algarrobo)
// Los árboles ya no se reparten al azar dentro de un anillo: siguen la
// máscara de monte, que abre claros y junta manchas. `treeRng` es propio
// para que cambiar la distribución no corra la secuencia del rng global y
// mueva la fauna de sitio.
const TREE_COUNT = 62;
const treeRng = mulberry32(556071);
const treePositions = clusteredScatter({
  count: TREE_COUNT,
  rMin: 3.2,
  rMax: 17.5,
  density: (x, z) => monteDensity(x, z) * poiClearing(x, z),
  clusterCount: 14,
  clusterRadius: 1.5,
  minDist: 1.15,
  solitaryRatio: 0.16, // unos diez ejemplares aislados: un monte solo de
                       // grupos se lee tan artificial como uno solo de sueltos
  poiDist: 2.0,
  rand: treeRng,
});

const trunkGeo = new THREE.CylinderGeometry(0.05, 0.11, 1.6, 10);
trunkGeo.translate(0, 0.8, 0);

// Gradiente vertical horneado en los vértices del tronco: la base está más
// oscura y algo más fría porque acumula humedad y musgo, y aclara hacia
// arriba donde le pega el sol. Todos los troncos comparten esta geometría,
// así que el gradiente cuesta una sola vez para los 62 ejemplares.
{
  const pos = trunkGeo.attributes.position;
  const cols = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 1.6; // 0 en la base, 1 en la copa
    // Curva rápida al principio: la franja húmeda del pie es estrecha.
    const damp = Math.pow(1 - clamp01(y * 2.2), 2);
    cols[i * 3] = 1 - damp * 0.42;
    cols[i * 3 + 1] = 1 - damp * 0.38;
    cols[i * 3 + 2] = 1 - damp * 0.30; // menos azul: se va a pardo, no a gris
  }
  trunkGeo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
}

const trunkMat = makeBarkMaterial(0xb09a7c);
trunkMat.vertexColors = true;

// Cuatro cortezas de base, no una. El espinillo y el algarrobo conviven en
// el mismo monte y no tienen el mismo marrón; encima cada ejemplar varía.
const BARK_TINTS = [0xb5a084, 0xa89071, 0xc0ab8c, 0x9d8768];
const trunkColorRng = mulberry32(730051);
const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treePositions.length);
trunks.castShadow = true;

// FASE 4: la copa ya no es UNA bola repetida 62 veces. Hay cinco formas de
// copa (layouts de lóbulos) y cada árbol toma una según su ambiente: los
// expuestos del pastizal se abren en paraguas, los de adentro de la mancha
// crecen ceñidos y altos compitiendo por luz. La resolución de cada copa sale
// de su zona visual (tamaño aparente), no de una cifra fija.
// Unidades: las del icosaedro viejo (radio 0,55), así la escala aprobada de
// cada árbol (sX, sY, sZ) sigue significando lo mismo.
const CANOPY_VARIANTS = [
  // 0 · paraguas: espinillo expuesto, ancho y chato
  { name: "paraguas", lobes: [[0, 0.06, 0, 0.36], [0.3, 0.0, 0.1, 0.28], [-0.28, -0.02, -0.12, 0.3], [0.08, -0.04, 0.32, 0.26], [-0.1, 0.02, -0.34, 0.27], [0.22, 0.12, -0.22, 0.22]] },
  // 1 · dos pisos: asimétrico, una masa alta desplazada
  { name: "dos_pisos", lobes: [[0.05, 0.16, 0.02, 0.34], [-0.26, -0.1, 0.12, 0.3], [0.3, -0.12, -0.05, 0.27], [0.1, -0.14, -0.3, 0.24], [-0.18, 0.26, -0.14, 0.2]] },
  // 2 · joven ceñido: más alto que ancho, dentro de la mancha
  { name: "joven", lobes: [[0, 0.18, 0, 0.3], [0.12, -0.1, 0.08, 0.28], [-0.12, -0.08, -0.1, 0.27], [0.02, 0.42, 0.03, 0.2]] },
  // 3 · abierto: copa rota por un lado, con un hueco que deja ver cielo
  { name: "abierto", lobes: [[0.18, 0.06, 0.05, 0.33], [0.42, -0.06, -0.15, 0.24], [-0.24, 0.0, 0.3, 0.25], [-0.36, -0.1, -0.18, 0.22], [0.05, 0.22, -0.32, 0.2]] },
  // 4 · viejo: el más ancho, con los bordes caídos
  { name: "viejo", lobes: [[0, 0.1, 0, 0.33], [0.38, -0.12, 0.05, 0.26], [-0.36, -0.14, -0.04, 0.27], [0.06, -0.1, 0.4, 0.25], [-0.04, -0.12, -0.4, 0.25], [0.22, 0.14, 0.26, 0.2]] },
];
for (const v of CANOPY_VARIANTS) v.lobes = inflateLobes(v.lobes, 1.12);
// Resolución de cada lóbulo por zona (icosaedro soldado, liso):
// detalle 3 = 320 caras, 2 = 180, 1 = 80. En BACKGROUND además se descartan
// los lóbulos más chicos: a esa distancia no cambian la silueta.
const CANOPY_TIER_DETAIL = { FOREGROUND: 3, MIDGROUND_NEAR: 2, MIDGROUND_FAR: 1, BACKGROUND: 1 };
const canopyGeoCache = new Map();
function canopyLobesFor(variant, tier) {
  const lobes = CANOPY_VARIANTS[variant].lobes;
  if (tier !== "BACKGROUND" || lobes.length <= 4) return lobes;
  return [...lobes].sort((a, b) => b[3] - a[3]).slice(0, 4);
}
function canopyGeoFor(variant, tier) {
  const key = `${variant}:${tier}`;
  if (!canopyGeoCache.has(key)) {
    canopyGeoCache.set(key, buildLobeMass(canopyLobesFor(variant, tier), CANOPY_TIER_DETAIL[tier], 900 + variant * 31, { amount: 0.24 }));
  }
  return canopyGeoCache.get(key);
}
const canopyMat = new THREE.MeshStandardMaterial({ roughness: 0.85, vertexColors: true });
const CANOPY_WIND = { f1: 0.5, a1: 0.035, f2: 1.2, a2: 0.015, zRatio: 0.8 };
windify(canopyMat, "pivot", CANOPY_WIND);
// Rng aislado para elegir la forma: no toca treeRng, así que la posición,
// escala e inclinación aprobadas de cada árbol no se mueven.
const pickCanopyVariant = makeVariantPicker(CANOPY_VARIANTS.length, 2.6, mulberry32(640021));
const canopyBake = { shadow: [], noShadow: [] };
// ¿Cae dentro del mapa de sombra del sol? El sol es fijo, así que se decide
// una vez con la propia matriz de la sombra. Una copa fuera del mapa no
// puede dejar sombra en ningún lado: dibujarla en el pase de sombra era
// costo puro (el InstancedMesh viejo lo hacía con las 62).
sun.updateMatrixWorld();
sun.target.updateMatrixWorld();
sun.shadow.updateMatrices(sun);
const _shadowV = new THREE.Vector3();
function inSunShadowMap(x, y, z, pad = 0.06) {
  _shadowV.set(x, y, z).applyMatrix4(sun.shadow.matrix);
  return _shadowV.x > -pad && _shadowV.x < 1 + pad && _shadowV.y > -pad && _shadowV.y < 1 + pad;
}
// Ramas principales visibles entre lóbulos (solo primer plano y plano medio
// cercano). Se crean más abajo, cuando ya existe addStaticPart.
const monteBranchSpecs = [];
const _trunkEuler = new THREE.Euler();
const _v3a = new THREE.Vector3();

const espinilloGreen = new THREE.Color(0x7a8f4a);
const algarroboGreen = new THREE.Color(0x4f6b3a);
const tmpColor = new THREE.Color();

// Datos por instancia de copa (para el balanceo de viento del render loop):
// no se puede animar una InstancedMesh por vértice sin shader propio, pero
// sí recomponer la matriz de cada instancia por frame con una rotación
// extra oscilante — barato (55 instancias) y da la sensación de viento.
const treeCanopySway = [];

treePositions.forEach(([x, z], i) => {
  // Escala UNIFORME del tronco (no desacoplar alto/ancho): así se mantiene
  // la proporción tronco-grueso/copa-baja típica del espinillo/algarrobo
  // en vez de troncos finos y altísimos ("efecto palillo").
  // Escala en campana (mayoría medianos, pocos extremos) en vez de plana:
  // un random uniforme produce demasiados gigantes y demasiados enanos, y
  // eso es justo lo que hacía que dos árboles vecinos se vieran "iguales
  // pero de distinto tamaño" en lugar de parecer de distinta edad.
  let treeScale = bellRange(treeRng, 0.70, 1.35);
  // Sesgo por mancha: la masa de monte tiene ejemplares más altos que los
  // que crecen sueltos en el pastizal, donde el viento y el ganado los
  // achican. Esto es lo que rompe la línea horizontal de copas.
  const vigor = monteDensity(x, z);
  treeScale *= 0.86 + vigor * 0.34;
  const base = groundY(x, z);
  const trunkTopY = base + 1.6 * treeScale;

  // Inclinación: casi todos a plomo, unos pocos ladeados. Nunca caídos.
  const leanAngle = naturalTilt(treeRng);
  const leanDir = treeRng() * Math.PI * 2;

  dummy.position.set(x, base, z);
  // Mismo valor y mismo orden de consumo que antes: solo se guarda el yaw
  // para poder ubicar las ramas sobre el tronco inclinado.
  const trunkYaw = treeRng() * Math.PI * 2;
  dummy.rotation.set(Math.cos(leanDir) * leanAngle, trunkYaw, Math.sin(leanDir) * leanAngle);
  dummy.scale.set(treeScale, treeScale, treeScale);
  dummy.updateMatrix();
  trunks.setMatrixAt(i, dummy.matrix);
  trunks.setColorAt(
    i,
    jitterColor(tmpColor, BARK_TINTS[i % BARK_TINTS.length], trunkColorRng)
  );
  contactPoints.push([x, z, 0.55 * treeScale, 1.0]);

  // La copa no se apoya siempre en el mismo punto del tronco: un ejemplar
  // joven la lleva alta y ceñida, uno viejo baja y abierta. Ese desfase es
  // parte de lo que quiebra la línea de copas.
  const crownDrop = 0.08 + treeRng() * 0.3 * treeScale;
  const cy = trunkTopY - crownDrop;
  const rotX = treeRng() * 0.25;
  const rotY = treeRng() * Math.PI * 2;
  const rotZ = treeRng() * 0.25;
  // Copas anchas y chatas en los ejemplares expuestos, más ceñidas dentro
  // de la mancha, donde compiten por luz.
  const spreadBias = 1.18 - vigor * 0.22;
  const sX = treeScale * spreadBias * (0.95 + treeRng() * 0.55);
  const sY = treeScale * (0.55 + treeRng() * 0.42); // copa achatada, típica del espinillo
  const sZ = treeScale * spreadBias * (0.95 + treeRng() * 0.55);
  dummy.position.set(x, cy, z);
  dummy.rotation.set(rotX, rotY, rotZ);
  dummy.scale.set(sX, sY, sZ);
  dummy.updateMatrix();
  const canopyMatrix = dummy.matrix.clone();
  // Zona visual por la altura total del árbol, y forma según el ambiente:
  // expuesto (poco vigor de mancha) → paraguas / viejo; adentro → joven /
  // dos pisos. "abierto" puede tocarle a cualquiera.
  const treeH = 1.6 * treeScale + 0.55 * sY * 1.2;
  const tier = visualTier(x, z, treeH, "arbol_monte");
  const variant = pickCanopyVariant(x, z, [
    1.4 - vigor, 0.6 + vigor, 0.4 + vigor * 1.2, 0.7, 1.2 - vigor * 0.6,
  ]);
  treeCanopySway.push({ x, y: cy, z, rotX, rotY, rotZ, sX, sY, sZ, phase: treeRng() * Math.PI * 2, tier, variant, matrix: canopyMatrix });

  if (TIER_RANK[tier] <= TIER_RANK.MIDGROUND_NEAR) {
    // Ramas desde el 70% del fuste (siguiendo la inclinación real del
    // tronco) hacia los dos lóbulos más grandes que no son el central.
    _trunkEuler.set(Math.cos(leanDir) * leanAngle, trunkYaw, Math.sin(leanDir) * leanAngle);
    const from = _v3a.set(0, 1.6 * treeScale * 0.7, 0).applyEuler(_trunkEuler).add(new THREE.Vector3(x, base, z)).toArray();
    const targets = CANOPY_VARIANTS[variant].lobes.slice(1).sort((a, b) => b[3] - a[3]).slice(0, 3);
    for (const [lx, ly, lz] of targets) {
      const to = new THREE.Vector3(lx, ly, lz).applyMatrix4(canopyMatrix).toArray();
      monteBranchSpecs.push({ from, to, rBase: 0.045 * treeScale, rTip: 0.016 * treeScale });
    }
  }

  // Más oscura que las hojas: la masa de la copa hace de sombra interior y
  // deja que el follaje recortado sea lo que se lee en el contorno.
  // Tono por ejemplar: dos vecinos de la misma especie nunca tienen el mismo
  // verde. Es lo más barato que hay para romper la lectura de "copia pegada".
  tmpColor
    .lerpColors(espinilloGreen, algarroboGreen, treeRng())
    .multiplyScalar(0.56 + treeRng() * 0.13);
  // El AO horneado oscurece la base de cada lóbulo; se compensa un poco el
  // tono para que la copa conserve el valor medio aprobado.
  const c = treeCanopySway[treeCanopySway.length - 1];
  const castsShadow = TIER_RANK[tier] <= TIER_RANK.MIDGROUND_FAR && inSunShadowMap(x, cy, z);
  c.castsShadow = castsShadow;
  (castsShadow ? canopyBake.shadow : canopyBake.noShadow).push({
    geo: canopyGeoFor(c.variant, tier),
    matrix: c.matrix,
    color: tmpColor.clone().multiplyScalar(1.12),
    pivot: [x, cy, z],
    phase: c.phase,
    amp: TIER_WIND[tier],
  });
});
trunks.instanceMatrix.needsUpdate = true;
if (trunks.instanceColor) trunks.instanceColor.needsUpdate = true;
// Dos mallas para las 62 copas: las que proyectan sombra (plano medio
// dentro del mapa de sombra del sol) y el resto, que no pasa por el pase de
// sombra porque su sombra caería fuera del mapa o no se percibiría.
const canopies = new THREE.Mesh(bakeInstances(canopyBake.shadow), canopyMat);
canopies.castShadow = true;
canopies.customDepthMaterial = windDepthMaterial("pivot", CANOPY_WIND);
scene.add(trunks, canopies);
if (canopyBake.noShadow.length) scene.add(new THREE.Mesh(bakeInstances(canopyBake.noShadow), canopyMat));

// Follaje real sobre la copa: alpha cards con la foto de hoja repartidas
// sobre la superficie del elipsoide. La masa de la copa sigue abajo como
// volumen y oclusión, pero el CONTORNO que ve el ojo ahora lo dan hojas
// recortadas, no un poliedro liso. Es lo que más acerca el árbol a la
// referencia fotográfica.
const CANOPY_LEAVES = 88;
// Estos árboles son espinillo y algarrobo: fabáceas de hoja bipinnada. Por
// eso usan la foto "pinnada" y no la ovada ancha, que pertenece a otra
// familia entera.
const canopyLeafGeo = new THREE.PlaneGeometry(0.34, 0.34 * LEAF_ASPECT);
const canopyLeafMat = makeLeafCardMaterial(new THREE.Color(0x9cb865), { kind: "pinnada", variant: 1 });
const canopyLeaves = new THREE.InstancedMesh(
  canopyLeafGeo,
  canopyLeafMat,
  treeCanopySway.length * CANOPY_LEAVES
);
canopyLeaves.castShadow = true;
// Viento en shader (antes: 5.456 matrices recompuestas por frame en CPU).
const CANOPY_LEAF_WIND = { f1: 1.0, a1: 0.1, f2: 2.2, a2: 0.04, zRatio: 0.7, near: 7, far: 16, farAmp: 0.35 };
windify(canopyLeafMat, "instance", CANOPY_LEAF_WIND);
canopyLeaves.customDepthMaterial = windDepthMaterial("instance", CANOPY_LEAF_WIND, canopyLeafMat);

// Generador propio para las hojas: si consumieran del rng global, sus
// ~21k llamadas correrían toda la secuencia posterior y cambiarían dónde
// caen árboles, palmeras y fauna. Aislarlo mantiene el layout estable.
const leafRng = mulberry32(90210);

// Cuatro verdes de base para el follaje del monte, más la variación por
// hoja que aplica jitterColor: verde medio, verde oscuro de interior de
// copa, verde seco y amarillento de hoja vieja. Ninguno saturado — el
// espinillo y el algarrobo tienen follaje grisáceo, no verde de vivero.
const CANOPY_LEAF_TINTS = [0x9cb865, 0x7d9a52, 0xb0c079, 0x8ea45c];
// Rng SEPARADO del de posiciones, para no correr la secuencia aprobada.
const leafColorRng = mulberry32(410337);

const canopyLeafSway = [];
let canopyLeafIdx = 0;
let canopyLeafSeq = 0; // cuenta TODAS las hojas, se dibujen o no: fija el tinte
const _leafP = new THREE.Vector3();
// Raleo por zona: a partir del plano medio lejano una hoja de 34 cm ocupa
// pocos píxeles y solo suma parpadeo. Se descarta sin dejar de consumir los
// generadores, para que las hojas que quedan caigan donde caían.
const LEAF_KEEP = { FOREGROUND: 1, MIDGROUND_NEAR: 1, MIDGROUND_FAR: 0.75, BACKGROUND: 0.5 };

treeCanopySway.forEach((c) => {
  const lobes = canopyLobesFor(c.variant, c.tier);
  const keepEvery = LEAF_KEEP[c.tier];
  for (let l = 0; l < CANOPY_LEAVES; l++) {
    // FASE 4: la hoja se apoya sobre el lóbulo real de SU copa (en su
    // rotación y escala), ya no sobre un elipsoide genérico.
    const theta = leafRng() * Math.PI * 2;
    const phi = Math.acos(2 * leafRng() - 1);
    const nx = Math.sin(phi) * Math.cos(theta);
    const ny = Math.cos(phi);
    const nz = Math.sin(phi) * Math.sin(theta);
    lobeSurface(lobes, nx, ny, nz, _leafP).multiplyScalar(1.04).applyMatrix4(c.matrix);
    const x = _leafP.x;
    const y = _leafP.y;
    const z = _leafP.z;

    const rotX = (leafRng() - 0.5) * 2.2;
    const rotY = Math.atan2(nx, nz) + (leafRng() - 0.5) * 1.2;
    const rotZ = (leafRng() - 0.5) * 2.2;
    // La hoja escala con el árbol: con un tamaño fijo, los ejemplares
    // grandes se seguían leyendo como masas lisas porque sus hojas quedaban
    // diminutas en proporción.
    const ls = (0.7 + leafRng() * 0.55) * Math.max(0.8, c.sX);
    const tint = CANOPY_LEAF_TINTS[canopyLeafSeq++ % CANOPY_LEAF_TINTS.length];
    const keep = keepEvery >= 1 || (l % 4) < keepEvery * 4;
    if (!keep) {
      jitterColor(tmpColor, tint, leafColorRng); // consumo idéntico
      leafRng();
      continue;
    }

    dummy.position.set(x, y, z);
    dummy.rotation.set(rotX, rotY, rotZ);
    dummy.scale.set(ls, ls, ls);
    dummy.updateMatrix();
    canopyLeaves.setMatrixAt(canopyLeafIdx, dummy.matrix);
    // Verde por hoja. En una copa real no hay dos hojas del mismo tono: las
    // del exterior están más amarillas por el sol y las del interior más
    // oscuras y frías. Con un verde único la copa se lee como una calcomanía
    // repetida, que es lo que le daba el aspecto plástico.
    canopyLeaves.setColorAt(canopyLeafIdx, jitterColor(tmpColor, tint, leafColorRng));
    canopyLeafSway.push({
      index: canopyLeafIdx,
      x,
      y,
      z,
      ls,
      rotX,
      rotY,
      rotZ,
      phase: leafRng() * Math.PI * 2,
    });
    canopyLeafIdx++;
  }
});
canopyLeaves.count = canopyLeafIdx;
canopyLeaves.instanceMatrix.needsUpdate = true;
if (canopyLeaves.instanceColor) canopyLeaves.instanceColor.needsUpdate = true;
scene.add(canopyLeaves);

// --- Tarjetas de hoja sobre lóbulos de follaje ---------------------------
// El ombú, el ceibo y el sauce eran masas lisas de flat shading: a un metro
// de distancia se leían como piedras verdes, no como follaje. Este ayudante
// reparte hojas recortadas sobre la superficie de sus lóbulos, que es lo
// mismo que ya hace la copa del monte y lo que más acerca un árbol a la
// referencia fotográfica.
const extraLeafCards = [];

function scatterLeafCards({ lobes, perLobe, size, kind, tint, variant = 0, narrow = 1, seed, outward = 1.05 }) {
  if (!lobes.length) return null;
  const geo = new THREE.PlaneGeometry(size * narrow, size * LEAF_ASPECT);
  const mat = makeLeafCardMaterial(tint, { kind, variant });
  const mesh = new THREE.InstancedMesh(geo, mat, lobes.length * perLobe);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.castShadow = true;

  // Generador propio por sistema de hojas: si consumieran del rng global,
  // sus miles de llamadas correrían toda la secuencia posterior y moverían
  // árboles, palmeras y fauna. Ya pasó una vez.
  const localRng = mulberry32(seed);
  const sway = [];
  let idx = 0;

  for (const lobe of lobes) {
    for (let l = 0; l < perLobe; l++) {
      // Punto sobre el elipsoide del lóbulo, empujado hacia afuera para que
      // la hoja asome en vez de quedar enterrada en la masa.
      const theta = localRng() * Math.PI * 2;
      const phi = Math.acos(2 * localRng() - 1);
      const nx = Math.sin(phi) * Math.cos(theta);
      const ny = Math.cos(phi);
      const nz = Math.sin(phi) * Math.sin(theta);
      const x = lobe.x + nx * lobe.rx * outward;
      const y = lobe.y + ny * lobe.ry * outward;
      const z = lobe.z + nz * lobe.rz * outward;

      const rotX = (localRng() - 0.5) * 2.2;
      const rotY = Math.atan2(nx, nz) + (localRng() - 0.5) * 1.2;
      const rotZ = (localRng() - 0.5) * 2.2;
      const ls = (0.75 + localRng() * 0.5) * (lobe.leafScale ?? 1);

      dummy.position.set(x, y, z);
      dummy.rotation.set(rotX, rotY, rotZ);
      dummy.scale.set(ls, ls, ls);
      dummy.updateMatrix();
      mesh.setMatrixAt(idx, dummy.matrix);
      sway.push({ index: idx, x, y, z, ls, rotX, rotY, rotZ, phase: localRng() * Math.PI * 2 });
      idx++;
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  scene.add(mesh);
  extraLeafCards.push({ mesh, sway });
  return mesh;
}

// Arbustos nativos vistosos: 5 especies REALES del Uruguay (no genéricas),
// cada una con geometría propia + color de flor botánicamente fiel.
// (Aromo/Espinillo — Acacia caven — ya está representado como árbol más
// arriba, no se duplica acá.)
//
// Detalle "casi fotográfico": en vez del poliedro plano de pocas caras,
// cada especie usa una malla de ~1000+ triángulos (icosaedro muy
// subdividido), deformada con ruido para romper la simetría perfecta
// (forma de "gema") y lograr un contorno orgánico de follaje real, con
// sombreado suave (no flatShading) + textura de color moteado y bump de
// hojas generados por canvas (sin descargar assets pesados — un modelo
// fotogramétrico real pesa ~95MB por arbusto, inviable para VR).
function hashNoise3(x, y, z) {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

function makeOrganicGeometry(geo, amount, seed) {
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = hashNoise3(v.x * 4 + seed, v.y * 4 + seed, v.z * 4 + seed);
    v.multiplyScalar(1 + (n - 0.5) * amount);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

// FASE 1 (reparación): juncos/cortadera/sedges eran conos rígidos, rectos
// de punta a punta -- por más que cada instancia se incline con su propia
// rotación, un cono sigue siendo un segmento recto, y se lee como "aguja
// clavada". Curvar la geometría COMPARTIDA una sola vez (no por instancia)
// resuelve esto sin tocar el costo: cada instancia ya gira en Y al azar, así
// que la misma curva local sale orientada distinto en cada una.
function bendBladeGeometry(geo, height, bendAmount, seed) {
  const pos = geo.attributes.position;
  const r = mulberry32(seed);
  const angle = r() * Math.PI * 2;
  const bx = Math.cos(angle);
  const bz = Math.sin(angle);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = Math.max(0, Math.min(1, y / height));
    // Cuadrática: casi recta cerca de la base (donde nace del suelo/mata) y
    // se arquea hacia la punta, como pesa el propio peso de la hoja.
    const bend = t * t * bendAmount;
    pos.setX(i, pos.getX(i) + bx * bend);
    pos.setZ(i, pos.getZ(i) + bz * bend);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

function makeFoliageMap() {
  // El mapa es GRIS, no verde, y esa es la corrección de fondo de esta
  // pasada: antes horneaba el color de la especie dentro de la textura y el
  // material lo volvía a aplicar como `color`. El resultado era el color
  // elevado al cuadrado — y con la variación por instancia, al cubo. De ahí
  // venían los arbustos casi negros.
  //
  // Ahora la textura solo aporta el moteado de luz y sombra del follaje, y
  // el color entra una sola vez, por instancia, con su variación propia.
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  // Base clara: la media del moteado tiene que quedar cerca del blanco para
  // que el color por instancia llegue entero.
  ctx.fillStyle = "rgb(214,214,214)";
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 260; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 3 + Math.random() * 9;
    // Sombra interior del follaje, nunca por debajo del 55% de luz: el
    // hueco entre hojas es oscuro, no negro.
    const shade = Math.round(150 + Math.random() * 70);
    ctx.fillStyle = `rgba(${shade},${shade},${shade},0.42)`;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * (0.5 + Math.random() * 0.5), Math.random() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeFoliageBumpMap() {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgb(128,128,255)";
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 500; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 2 + Math.random() * 6;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, "rgba(160,160,255,0.6)");
    grad.addColorStop(1, "rgba(128,128,255,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  return tex;
}

// Hojas individuales reconocibles por especie. La silueta ya no viene de un
// contorno 2D generado (bilobulado, palmado, aserrado…) sino del recorte
// alfa de una foto real: la venación y el borde de una hoja fotografiada se
// leen mejor a un metro de distancia que cualquier polígono dibujado a mano.
// Lo que distingue a cada especie ahora es qué foto usa y con qué proporción.

const SHRUB_SPECIES = [
  // Pata de vaca (Bauhinia forficata): flor blanca en forma de mariposa,
  // hoja bilobulada característica (silueta de pata de vaca/mariposa)
  {
    name: "pata de vaca",
    geo: () => makeOrganicGeometry(new THREE.IcosahedronGeometry(0.34, 3), 0.35, 11),
    blobRadius: 0.34,
    foliage: 0x5a7a4a,
    flower: 0xfbfaf5,
    roughness: 0.85,
    count: 22,
    leaf: { kind: "ancha", narrow: 1.0, sizeX: 0.075, sizeY: 0.068, count: 11, uprightBias: 0.3 },
  },
  // Carqueja (Baccharis trimera): subarbusto rústico, tallos aplanados y
  // angulosos, casi sin hojas verdaderas — se representa como muchas
  // láminas delgadas erguidas en vez de hojas anchas.
  {
    name: "carqueja",
    geo: () => makeOrganicGeometry(new THREE.IcosahedronGeometry(0.3, 3), 0.45, 23),
    blobRadius: 0.3,
    foliage: 0x8a9a5a,
    flower: 0xd9d18a,
    roughness: 0.95,
    count: 24,
    leaf: { kind: "ancha", narrow: 0.32, sizeX: 0.08, sizeY: 0.009, count: 22, uprightBias: 0.85 },
  },
  // Malva sonrojada (Calyculogygas uruguayensis): flores rojas vistosas,
  // especie prioritaria — hoja redondeada palmada típica de las malváceas
  {
    name: "malva sonrojada",
    geo: () => makeOrganicGeometry(new THREE.IcosahedronGeometry(0.3, 3), 0.3, 37),
    blobRadius: 0.3,
    foliage: 0x6a8a4a,
    flower: 0xe0354f,
    roughness: 0.9,
    count: 20,
    leaf: { kind: "ancha", narrow: 1.1, sizeX: 0.068, sizeY: 0.063, count: 10, uprightBias: 0.25 },
  },
  // Chilca (Baccharis salicifolia — "hoja de sauce"): monte ribereño, atrae
  // polinizadores — hoja lanceolada larga y angosta, apuntada en los extremos
  {
    name: "chilca",
    geo: () => makeOrganicGeometry(new THREE.IcosahedronGeometry(0.36, 3), 0.32, 53),
    blobRadius: 0.36,
    foliage: 0x4f6b3a,
    flower: 0xf0ece0,
    roughness: 0.9,
    count: 24,
    leaf: { kind: "ancha", narrow: 0.45, sizeX: 0.1, sizeY: 0.02, count: 13, uprightBias: 0.4 },
  },
  // Espina amarilla (Berberis laurina — "hoja de laurel"): follaje brillante,
  // flor amarilla llamativa — hoja ovalada con borde finamente aserrado/espinoso
  {
    name: "espina amarilla",
    geo: () => makeOrganicGeometry(new THREE.IcosahedronGeometry(0.3, 3), 0.4, 71),
    blobRadius: 0.3,
    foliage: 0x3f6b3f,
    flower: 0xffd400,
    roughness: 0.35,
    count: 20,
    leaf: { kind: "ancha", narrow: 0.85, sizeX: 0.052, sizeY: 0.03, count: 15, uprightBias: 0.2 },
  },
];

const flowerGeo = new THREE.IcosahedronGeometry(0.045, 0);
const FLOWERS_PER_SHRUB = 3;

// Igual que con las copas de los árboles: se guarda la transformación base
// de cada arbusto (y de cada hoja individual) para poder recomponerla con
// un balanceo leve por viento en el render loop.
const shrubSway = [];
const shrubBodyMeshes = [];
const leafSway = [];
const leafMeshes = [];

// Una sola textura de follaje para las cinco especies, en vez de una por
// especie. Antes cada una generaba su propio canvas porque llevaba el color
// horneado; ahora que el color va por instancia, la textura es la misma y se
// ahorran cuatro subidas a la GPU.
const sharedFoliageMap = makeFoliageMap();
const sharedFoliageBump = makeFoliageBumpMap();

// Rng propio del estrato arbustivo, para que reordenarlo no corra la
// secuencia global y mueva la fauna.
const shrubRng = mulberry32(880213);
// Rng SEPARADO para el color. Si el tinte consumiera del mismo generador
// que las posiciones y escalas, agregar variación de color correría toda la
// secuencia y movería la distribución ya aprobada.
const shrubColorRng = mulberry32(51199);
let shrubTotal = 0;
let flowerTotal = 0;

// Cuántos ejemplares HERO por especie. Solo carqueja y pata de vaca tienen
// individuos realmente cerca del punto de vista (1,7-4,7 m); el resto de
// las especies del matorral cae más lejos y queda para una pasada futura.
const HERO_SHRUB_BUDGET = { "carqueja": 2, "pata de vaca": 1 };

// FASE 4: los 107 arbustos no-hero dejan de ser una bola facetada por
// especie. Cada especie tiene tres masas de lóbulos distintas (en unidades
// de su blobRadius, base a ras del suelo) y cada ejemplar toma una sin
// repetir la del vecino. Se hornean en una malla por material: 2 draw calls
// (más su sombra) para todo el matorral, en vez de 5 InstancedMesh.
const SHRUB_VARIANTS = [
  [[0, 0.05, 0, 0.8], [0.55, -0.35, 0.2, 0.6], [-0.45, -0.38, -0.3, 0.6], [0.1, -0.4, -0.6, 0.55]],
  [[0, 0.15, 0, 0.72], [-0.5, -0.32, 0.35, 0.64], [0.5, -0.36, -0.25, 0.6]],
  [[0.15, 0.08, 0.1, 0.72], [-0.55, -0.38, 0.05, 0.58], [0.35, -0.4, -0.5, 0.56], [-0.1, 0.4, -0.25, 0.45], [0.3, -0.42, 0.55, 0.5]],
];
for (let v = 0; v < SHRUB_VARIANTS.length; v++) SHRUB_VARIANTS[v] = inflateLobes(SHRUB_VARIANTS[v], 1.12);
const SHRUB_TIER_DETAIL = { FOREGROUND: 3, MIDGROUND_NEAR: 2, MIDGROUND_FAR: 1, BACKGROUND: 1 };
const shrubGeoCache = new Map();
function shrubGeoFor(speciesIndex, variant, tier) {
  const key = `${speciesIndex}:${variant}:${tier}`;
  if (!shrubGeoCache.has(key)) {
    shrubGeoCache.set(
      key,
      buildLobeMass(SHRUB_VARIANTS[variant], SHRUB_TIER_DETAIL[tier], 3000 + speciesIndex * 101 + variant * 13, { amount: 0.26, flatten: 0.6, aoMin: 0.66, fine: 0.14, bend: 0.55, dapple: 0.34 })
    );
  }
  return shrubGeoCache.get(key);
}
const SHRUB_WIND = { f1: 0.7, a1: 0.05, f2: 1.6, a2: 0.02, zRatio: 0.7 };
const shrubBake = { matte: [], glossy: [] };
const pickShrubVariant = makeVariantPicker(SHRUB_VARIANTS.length, 1.3, mulberry32(270113));
const _shrubM = new THREE.Matrix4();
const _shrubQ = new THREE.Quaternion();
const _shrubE = new THREE.Euler();
const _shrubP = new THREE.Vector3();
const _shrubS = new THREE.Vector3();

// Rng propio para los lóbulos de los arbustos hero: aislado de shrubRng y
// shrubColorRng para no correr ninguna de las dos secuencias aprobadas.
// --- Apoyo sobre la superficie VISIBLE --------------------------------
// `groundY` es el relieve geométrico, pero el material del suelo le suma
// en la GPU un displacementMap de hasta 0.15 m. Todo lo plano apoyado en
// groundY + 1 cm (hojarasca, charcos, restos) quedaba enterrado bajo esa
// rugosidad, y en la franja de la orilla, bajo la malla del barro (y=0.162).
// Verificado subiéndolos en vivo: sin esto no se veía ninguno.
//
// La altura real se reconstruye igual que la calcula la GPU: el mismo JPG
// de displacement, leído en los vértices de la malla (160x160 sobre 30 m) e
// interpolado entre ellos. Agua y orilla son geometría sin displacement, así
// que ahí alcanza con un raycast.
const DISP_SCALE = 0.15;
const GROUND_SIZE = 30;
const GROUND_SEGS = 160;
const groundHuggers = [];
const hugRay = new THREE.Raycaster();
const hugDown = new THREE.Vector3(0, -1, 0);
const hugOrigin = new THREE.Vector3();
const hugM4 = new THREE.Matrix4();
const hugPos = new THREE.Vector3();
const hugQuat = new THREE.Quaternion();
const hugScale = new THREE.Vector3();
let dispImage = null;
let dispCtx = null;
const dispCache = new Map();

function dispAtVertex(i, j) {
  const key = i * 1000 + j;
  const cached = dispCache.get(key);
  if (cached !== undefined) return cached;
  const step = GROUND_SIZE / GROUND_SEGS;
  const x = -GROUND_SIZE / 2 + i * step;
  const z = -GROUND_SIZE / 2 + j * step;
  // PlaneGeometry rotada -90° en X: u = x/30 + 0.5, v = -z/30 + 0.5; la
  // textura repite REPEAT veces y se lee con flipY.
  const u = (x / GROUND_SIZE + 0.5) * REPEAT;
  const v = (-z / GROUND_SIZE + 0.5) * REPEAT;
  const W = dispImage.width;
  const H = dispImage.height;
  const px = Math.min(W - 1, Math.floor((u - Math.floor(u)) * W));
  const py = Math.min(H - 1, Math.floor((1 - (v - Math.floor(v))) * H));
  dispCtx.drawImage(dispImage, px, py, 1, 1, 0, 0, 1, 1);
  const d = dispCtx.getImageData(0, 0, 1, 1).data[0] / 255;
  dispCache.set(key, d);
  return d;
}

function displacementAt(x, z) {
  // Sin la imagen todavía, se asume el máximo: mejor flotar un instante
  // que quedar enterrado.
  if (!dispImage) return 1;
  const step = GROUND_SIZE / GROUND_SEGS;
  const gx = (x + GROUND_SIZE / 2) / step;
  const gz = (z + GROUND_SIZE / 2) / step;
  const i = Math.max(0, Math.min(GROUND_SEGS - 1, Math.floor(gx)));
  const j = Math.max(0, Math.min(GROUND_SEGS - 1, Math.floor(gz)));
  const fx = gx - i;
  const fz = gz - j;
  const a = dispAtVertex(i, j);
  const b = dispAtVertex(i + 1, j);
  const c = dispAtVertex(i, j + 1);
  const d = dispAtVertex(i + 1, j + 1);
  return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
}

function visibleSurfaceY(x, z) {
  let y = groundY(x, z) + displacementAt(x, z) * DISP_SCALE;
  hugOrigin.set(x, 5, z);
  hugRay.set(hugOrigin, hugDown);
  const hit = hugRay.intersectObjects([water, shore], false)[0];
  if (hit && hit.point.y > y) y = hit.point.y;
  return y;
}

// Máximo sobre el centro y cuatro puntos a `span`: un objeto plano de
// varios centímetros no puede atravesar el relieve por ninguno de sus lados.
function surfaceTopY(x, z, span) {
  let y = visibleSurfaceY(x, z);
  if (span > 0) {
    y = Math.max(
      y,
      visibleSurfaceY(x + span, z),
      visibleSurfaceY(x - span, z),
      visibleSurfaceY(x, z + span),
      visibleSurfaceY(x, z - span)
    );
  }
  return y;
}

function placeHugger(h) {
  const y = surfaceTopY(h.x, h.z, h.span) + h.lift;
  if (h.index === undefined) {
    h.mesh.position.y = y;
    return;
  }
  h.mesh.getMatrixAt(h.index, hugM4);
  hugM4.decompose(hugPos, hugQuat, hugScale);
  hugPos.y = y;
  hugM4.compose(hugPos, hugQuat, hugScale);
  h.mesh.setMatrixAt(h.index, hugM4);
  h.mesh.instanceMatrix.needsUpdate = true;
}

function hugGround(mesh, x, z, lift, span, index) {
  const h = { mesh, x, z, lift, span, index };
  groundHuggers.push(h);
  // La orilla y el agua ya tienen su matriz de mundo; el raycast la necesita
  // actualizada porque esto corre antes del primer render.
  water.updateMatrixWorld();
  shore.updateMatrixWorld();
  placeHugger(h);
}

{
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    dispCtx = canvas.getContext("2d", { willReadFrequently: true });
    dispCtx.imageSmoothingEnabled = false;
    dispImage = img;
    for (const h of groundHuggers) placeHugger(h);
  };
  img.src = "/assets/textures/grass_ground/disp_4k.jpg";
}

// Piezas estáticas y chicas (raíces, ramas de conexión, tallos): cada una
// era una malla suelta con sombra, o sea dos draw calls por pieza. Con ~70
// piezas eso sumaba más de cien draw calls por algo que nunca se mueve. Se
// registran acá y, terminada la construcción de la escena, se funden en una
// sola malla por material (flushStaticBatches).
const staticBatches = new Map();
function addStaticPart(mesh, parent = scene) {
  parent.add(mesh);
  if (!staticBatches.has(mesh.material)) staticBatches.set(mesh.material, []);
  staticBatches.get(mesh.material).push(mesh);
}
function flushStaticBatches() {
  scene.updateMatrixWorld(true);
  for (const [mat, meshes] of staticBatches) {
    if (meshes.length < 2) continue;
    const geos = meshes.map((m) => m.geometry.clone().applyMatrix4(m.matrixWorld));
    const merged = mergeGeometries(geos, false);
    geos.forEach((g) => g.dispose());
    if (!merged) continue; // atributos incompatibles: quedan como mallas sueltas
    for (const m of meshes) {
      m.parent.remove(m);
      m.geometry.dispose();
    }
    const batch = new THREE.Mesh(merged, mat);
    batch.castShadow = meshes[0].castShadow;
    batch.receiveShadow = meshes[0].receiveShadow;
    scene.add(batch);
  }
  staticBatches.clear();
}

function addRootFlare(baseX, baseY, baseZ, mat, count, rng, maxLen, maxR) {
  for (let i = 0; i < count; i++) {
    const ang = (i / count) * Math.PI * 2 + rng() * 0.7;
    const len = maxLen * (0.6 + rng() * 0.5);
    const rBase = maxR * (0.7 + rng() * 0.4);
    // El extremo sigue la altura REAL del terreno en ese punto (no una
    // pendiente fija): con relieve, una pendiente fija manda la raíz varios
    // centímetros bajo la superficie mucho antes de llegar a la punta, y el
    // propio terreno la tapa -- se veía solo el primer tercio, como una
    // astilla en vez de una raíz.
    const farX = baseX + Math.cos(ang) * len;
    const farZ = baseZ + Math.sin(ang) * len;
    const farY = groundY(farX, farZ) - 0.015;
    const dx = farX - baseX;
    const dy = farY - baseY;
    const dz = farZ - baseZ;
    const realLen = Math.hypot(dx, dy, dz);
    const rootGeo = new THREE.CylinderGeometry(rBase * 0.12, rBase, realLen, 5);
    rootGeo.translate(0, realLen / 2, 0);
    const root = new THREE.Mesh(rootGeo, mat);
    root.position.set(baseX, baseY, baseZ);
    root.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(dx, dy, dz).normalize()
    );
    root.castShadow = true;
    root.receiveShadow = true;
    addStaticPart(root);
  }
}

// Hojarasca en la base: unas pocas tarjetas planas, casi horizontales,
// tendidas sobre el suelo alrededor del tronco. Reutiliza el mismo mapa de
// hoja ancha que ya usan las copas, pero con tinte seco -- una hoja caída
// no es del mismo verde que una hoja viva.
const leafLitterGeo = new THREE.PlaneGeometry(0.16, 0.16 * LEAF_ASPECT);
const leafLitterMat = makeLeafCardMaterial(0xffffff, { kind: "ancha", variant: 0 });
leafLitterMat.color.setHex(0xb8964a);
// Una sola InstancedMesh para toda la hojarasca: eran ~90 mallas sueltas
// con la misma geometría y el mismo material, una por draw call.
const MAX_LEAF_LITTER = 160;
const leafLitterMesh = new THREE.InstancedMesh(leafLitterGeo, leafLitterMat, MAX_LEAF_LITTER);
leafLitterMesh.count = 0;
leafLitterMesh.receiveShadow = true;
// Las instancias se reparten por varios metros y se reubican al cargar el
// displacement; no vale la pena mantener una esfera de culling al día.
leafLitterMesh.frustumCulled = false;
scene.add(leafLitterMesh);
function addLeafLitter(baseX, baseZ, count, rng, radius) {
  for (let i = 0; i < count && leafLitterMesh.count < MAX_LEAF_LITTER; i++) {
    const a = rng() * Math.PI * 2;
    const rad = radius * (0.3 + rng() * 0.7);
    const lx = baseX + Math.cos(a) * rad;
    const lz = baseZ + Math.sin(a) * rad;
    const rx = -Math.PI / 2 + (rng() - 0.5) * 0.3;
    const rz = rng() * Math.PI * 2;
    const ls = 0.7 + rng() * 0.8;
    const idx = leafLitterMesh.count++;
    dummy.position.set(lx, 0, lz);
    dummy.rotation.set(rx, 0, rz);
    dummy.scale.set(ls, ls, ls);
    dummy.updateMatrix();
    leafLitterMesh.setMatrixAt(idx, dummy.matrix);
    hugGround(leafLitterMesh, lx, lz, 0.008, 0.12 * ls, idx);
  }
  leafLitterMesh.instanceMatrix.needsUpdate = true;
}

const heroShrubLobeRng = mulberry32(238117);
const heroShrubStemMat = new THREE.MeshStandardMaterial({ color: 0x6b5842, roughness: 0.92, flatShading: true });

/** Cuerpo multi-lóbulo para un arbusto HERO, en vez del blob único.
 *  3-4 lóbulos más chicos, superpuestos y desplazados, dejan huecos y
 *  asimetría en la silueta — lo que un solo icosaedro deformado no puede
 *  dar por más ruido que se le aplique al vértice. Reutiliza el material
 *  de la especie (mismo mapa, mismo normal) y las mismas hojas/flores que
 *  ya se generan para esa posición: solo cambia el cuerpo. */
function buildHeroShrub(x, h, z, rotY, s, sY, species, bodyMat, color) {
  const r = heroShrubLobeRng;
  // Clon propio del material: bodyMat es blanco (0xffffff) y depende de
  // instanceColor para el tinte, que solo existe en el InstancedMesh. Un
  // THREE.Mesh normal ignora instanceColor y saldría blanco puro.
  const heroMat = bodyMat.clone();
  heroMat.color.copy(color);
  const lobeCount = 3 + (r() < 0.5 ? 0 : 1); // 3 o 4
  const group = new THREE.Group();
  group.position.set(x, h, z);
  group.rotation.y = rotY;
  group.scale.set(s, sY, s);
  // FASE 2.5: mismo criterio que árboles — nivel de subdivisión según
  // distancia real, y un tallo visible conectando el centro del arbusto
  // con cada lóbulo en vez de dejarlos flotando sueltos.
  const shrubD = heroDist(x, z);
  const lobeDetail = shrubD < 3 ? 4 : shrubD < 6 ? 3 : 2;
  // FASE 3 (integración de suelo): los árboles hero ya tenían raíz y
  // hojarasca desde Fase 3A; los arbustos hero quedaban "clavados" -- base
  // limpia contra el pasto, sin nada que los ancle al terreno. Carqueja y
  // pata de vaca sí tienen base leñosa real, así que corresponde.
  const shrubGroundY = groundY(x, z);
  addRootFlare(x, shrubGroundY + 0.02, z, heroShrubStemMat, 4, r, species.blobRadius * s * 0.45, species.blobRadius * s * 0.06);
  addLeafLitter(x, z, 10, r, species.blobRadius * s * 0.9);
  for (let li = 0; li < lobeCount; li++) {
    const ang = (li / lobeCount) * Math.PI * 2 + r() * 0.9;
    const lobeR = species.blobRadius * (0.5 + r() * 0.28);
    const offR = species.blobRadius * (0.32 + r() * 0.34);
    const lobe = new THREE.Mesh(
      makeOrganicGeometry(new THREE.IcosahedronGeometry(lobeR, lobeDetail), 0.35, Math.floor(r() * 9999)),
      heroMat
    );
    const lobeX = Math.cos(ang) * offR;
    const lobeY = (r() - 0.4) * species.blobRadius * 0.55;
    const lobeZ = Math.sin(ang) * offR;
    lobe.position.set(lobeX, lobeY, lobeZ);
    lobe.castShadow = true;
    lobe.receiveShadow = true;
    addStaticPart(lobe, group);

    // Tallo leñoso desde la base del arbusto hasta cada lóbulo, recortado
    // al 78% del trayecto para que la punta quede embebida en el follaje.
    const reach = 0.78;
    const fromY = -species.blobRadius * 0.2;
    const dx = lobeX * reach;
    const dy = (lobeY - fromY) * reach;
    const dz = lobeZ * reach;
    const len = Math.hypot(dx, dy, dz) || 0.001;
    const stemGeo = new THREE.CylinderGeometry(lobeR * 0.1, lobeR * 0.2, len, 5);
    stemGeo.translate(0, len / 2, 0);
    const stem = new THREE.Mesh(stemGeo, heroShrubStemMat);
    stem.position.set(0, fromY, 0);
    stem.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx, dy, dz).normalize());
    stem.castShadow = true;
    addStaticPart(stem, group);
  }
  HERO_GROUP.add(group);
}

SHRUB_SPECIES.forEach((species, speciesIndex) => {
  // Manchas, no ejemplares sueltos equidistantes. Cada especie desplaza su
  // máscara (speciesIndex * 37) para que las cinco no ocupen exactamente
  // los mismos parches: en un matorral real las especies se mezclan pero
  // cada una tiene sus rincones.
  const offset = speciesIndex * 37;
  const positions = clusteredScatter({
    count: species.count,
    rMin: 1.6,
    rMax: 11.0,
    // Los arbustos no tapan la línea de visión hacia los personajes (miden
    // menos de un metro), así que solo respetan el espacio de actividad a
    // su alrededor, no el corredor visual.
    density: (x, z) => matorralDensity(x + offset, z + offset),
    clusterCount: 7,
    clusterRadius: 0.85,
    minDist: 0.55,
    solitaryRatio: 0.22,
    poiDist: 1.6,
    rand: shrubRng,
  });

  // Selección HERO por distancia real al punto de vista fijo, no por índice:
  // si una pasada futura cambia el reparto de arbustos, esto sigue eligiendo
  // a los que de verdad están más cerca.
  const heroBudget = HERO_SHRUB_BUDGET[species.name] ?? 0;
  const heroIndices = new Set();
  if (heroBudget > 0) {
    positions
      .map(([px, pz], idx) => ({ idx, d: heroDist(px, pz) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, heroBudget)
      .forEach((e) => heroIndices.add(e.idx));
  }

  const bodyMat = new THREE.MeshStandardMaterial({
    // Blanco: el color lo pone `instanceColor`, una sola vez y con su
    // variación por ejemplar. El mapa solo aporta el moteado.
    color: 0xffffff,
    map: sharedFoliageMap,
    normalMap: sharedFoliageBump,
    normalScale: new THREE.Vector2(0.7, 0.7),
    // El follaje no brilla, pero tampoco es un mate absoluto: la hoja nueva
    // devuelve algo de luz. Un 0.88 plano se lee como fieltro.
    roughness: species.roughness ?? 0.88,
    metalness: 0.0,
  });
  const body = new THREE.InstancedMesh(species.geo(), bodyMat, positions.length);
  body.castShadow = true;
  body.receiveShadow = true;
  body.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  shrubBodyMeshes.push(body);

  const flowerMat = new THREE.MeshStandardMaterial({
    color: species.flower,
    roughness: 0.5,
    emissive: species.flower,
    emissiveIntensity: 0.15,
    flatShading: true,
  });
  const flowers = new THREE.InstancedMesh(flowerGeo, flowerMat, positions.length * FLOWERS_PER_SHRUB);

  // Hojas de silueta reconocible: instanciadas sobre la superficie del
  // volumen de follaje (blobRadius), orientadas hacia afuera con un
  // sesgo "erguido" propio de cada especie (uprightBias — alto en
  // carqueja, cuyos tallos aplanados crecen casi verticales).
  const leafCfg = species.leaf;
  // Alpha card: un plano liso recortado por el mapa de opacidad de la foto.
  // La silueta ya no la da la geometría (antes era un contorno 2D generado)
  // sino el recorte de la hoja real, con su venación y su borde aserrado.
  // El tamaño sale de la especie, pero la PROPORCIÓN la fija la foto: si se
  // usara el aspecto de cada contorno (la carqueja era casi 9:1) la hoja
  // saldría aplastada.
  // `narrow` estrecha la tarjeta para especies de hoja lanceolada (chilca,
  // carqueja). Deforma la foto a propósito: no hay foto CC0 de hoja de
  // Baccharis, y una hoja ancha en una chilca se lee peor que una ovada
  // estirada a la proporción correcta.
  const leafW = Math.max(leafCfg.sizeX, leafCfg.sizeY) * 2.3;
  const leafGeo = new THREE.PlaneGeometry(leafW * (leafCfg.narrow ?? 1), leafW * LEAF_ASPECT);
  // El tinte modula la foto para acercarla al verde de cada especie sin
  // perder la textura: multiplicar por un color claro conserva el detalle.
  const leafBaseColor = new THREE.Color(species.foliage);
  const leafHsl = { h: 0, s: 0, l: 0 };
  leafBaseColor.getHSL(leafHsl);
  leafBaseColor.setHSL(leafHsl.h, Math.min(1, leafHsl.s * 0.9), Math.min(0.95, leafHsl.l * 2.1));
  // Blanco en el material, color por instancia: el tinte se aplicaba antes
  // a las 1.582 hojas por igual, así que todas las de una especie tenían
  // exactamente el mismo verde.
  const leafMat = makeLeafCardMaterial(0xffffff, {
    kind: leafCfg.kind ?? "ancha",
    variant: speciesIndex % 2,
  });
  const leaves = new THREE.InstancedMesh(leafGeo, leafMat, positions.length * leafCfg.count);
  leaves.castShadow = true;
  leaves.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  leafMeshes.push(leaves);

  let flowerIdx = 0;
  let flowerCount = 0;
  let leafIdx = 0;
  positions.forEach(([x, z], i) => {
    const s = bellRange(shrubRng, 0.55, 1.45);
    const h = groundY(x, z) + s * 0.35;
    const rotX = shrubRng() * Math.PI;
    const rotY = shrubRng() * Math.PI;
    const rotZ = shrubRng() * Math.PI;
    const sY = s * (0.75 + shrubRng() * 0.5);
    const isHero = heroIndices.has(i);
    // FASE 4: matriz de la masa por lóbulos. La rotación libre en los tres
    // ejes servía para una esfera; a una masa con base la pondría patas
    // arriba, así que de rotX/rotZ solo queda una inclinación leve.
    const shrubTier = isHero ? "HERO" : visualTier(x, z, 2 * species.blobRadius * Math.max(s, sY), "arbusto");
    if (isHero) registerTier("arbusto", "HERO");
    const shrubVariant = isHero ? 0 : pickShrubVariant(x, z);
    _shrubE.set((rotX / Math.PI - 0.5) * 0.22, rotY, (rotZ / Math.PI - 0.5) * 0.22);
    _shrubM.compose(
      _shrubP.set(x, h, z),
      _shrubQ.setFromEuler(_shrubE),
      _shrubS.set(s * species.blobRadius, sY * species.blobRadius, s * species.blobRadius)
    );
    const shrubMatrix = _shrubM.clone();
    dummy.position.set(x, h, z);
    dummy.rotation.set(rotX, rotY, rotZ);
    // El blob instanciado se oculta con escala cero en vez de recortarse del
    // InstancedMesh: así no hay que renumerar índices ni tocar la
    // contabilidad de hojas/flores, que sigue el mismo (x, z, i) de siempre.
    if (isHero) dummy.scale.set(0, 0, 0);
    else dummy.scale.set(s, sY, s);
    dummy.updateMatrix();
    body.setMatrixAt(i, dummy.matrix);
    contactPoints.push([x, z, s * 0.6, 0.75]);
    // Escala 0 también en el balanceo por viento: si quedara la real, el
    // render loop la recompondría cada frame y el blob oculto volvería a
    // aparecer en cuanto oscilara.
    // FASE 4: el balanceo del cuerpo pasó al shader de la malla horneada; la
    // fase se sigue sacando de shrubRng en el mismo lugar de la secuencia.
    const bodyPhase = shrubRng() * Math.PI * 2;
    // Tono por ejemplar dentro de los márgenes naturales. Antes esto
    // multiplicaba el color de especie por un escalar, encima de un material
    // que YA lo aplicaba dos veces: de ahí los arbustos negros.
    body.setColorAt(i, jitterColor(tmpColor, species.foliage, shrubColorRng));
    if (!isHero) {
      shrubBake[(species.roughness ?? 0.88) < 0.6 ? "glossy" : "matte"].push({
        geo: shrubGeoFor(speciesIndex, shrubVariant, shrubTier),
        matrix: shrubMatrix,
        color: tmpColor.clone().multiplyScalar(1.08),
        // Pivote en el pie: la mata se mece desde el suelo, no desde su centro.
        pivot: [x, groundY(x, z), z],
        phase: bodyPhase,
        amp: TIER_WIND[shrubTier],
        uvScale: 0.53,
      });
    }
    // El hero se construye después de calcular el tinte: así su material
    // clonado usa el mismo verde que el resto de la especie vería vía
    // instanceColor, en vez del blanco base de bodyMat.
    if (isHero) buildHeroShrub(x, h, z, rotY, s, sY, species, bodyMat, tmpColor.clone());
    // El color pasó a un rng propio, pero la versión aprobada consumía UN
    // valor de `shrubRng` justo acá. Se descarta uno para que la escala, la
    // rotación y la floración de los arbustos siguientes caigan exactamente
    // donde caían: la distribución aprobada no se mueve.
    shrubRng();

    // FLORES: antes llevaba tres cada arbusto, los 110 de la escena, y el
    // campo parecía un cantero. Ahora solo florece el que cae dentro de una
    // mancha de floración, y con menos flores. En un pastizal real la
    // floración es estacional y localizada, no un tapiz continuo.
    const patch = flowerPatch(x, z);
    const blooms = patch > 0.3 ? (shrubRng() < 0.35 + patch * 0.4 ? 2 : 1) : 0;
    for (let f = 0; f < blooms; f++) {
      const ang = shrubRng() * Math.PI * 2;
      const rad = s * (0.25 + shrubRng() * 0.2);
      dummy.position.set(
        x + Math.cos(ang) * rad,
        h + s * 0.25 + shrubRng() * 0.15,
        z + Math.sin(ang) * rad
      );
      dummy.rotation.set(shrubRng() * Math.PI, shrubRng() * Math.PI, shrubRng() * Math.PI);
      const fs = 0.7 + shrubRng() * 0.6;
      dummy.scale.set(fs, fs, fs);
      dummy.updateMatrix();
      flowers.setMatrixAt(flowerIdx++, dummy.matrix);
    }
    // Las instancias que sobran del presupuesto se mandan fuera de cámara:
    // una InstancedMesh siempre dibuja su `count`, y sin esto quedarían
    // flores apiladas en el origen.
    flowerCount = flowerIdx;

    const blobR = s * species.blobRadius;
    const shrubLobes = SHRUB_VARIANTS[shrubVariant];
    for (let l = 0; l < leafCfg.count; l++) {
      const theta = shrubRng() * Math.PI * 2;
      const phi = Math.acos(2 * shrubRng() - 1); // punto uniforme sobre la esfera
      let lx = x + Math.sin(phi) * Math.cos(theta) * blobR * 1.02;
      let lz = z + Math.sin(phi) * Math.sin(theta) * blobR * 1.02;
      let ly = h + Math.cos(phi) * blobR * 0.9 * 1.02;
      if (!isHero) {
        // FASE 4: sobre la superficie de SU masa de lóbulos.
        lobeSurface(shrubLobes, Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta), _shrubP)
          .multiplyScalar(1.03)
          .applyMatrix4(shrubMatrix);
        lx = _shrubP.x;
        ly = _shrubP.y;
        lz = _shrubP.z;
      }
      const outwardYaw = Math.atan2(lx - x, lz - z);
      const tiltRange = (1 - leafCfg.uprightBias) * 1.4;
      const lRotX = (shrubRng() - 0.5) * tiltRange;
      const lRotY = outwardYaw + (shrubRng() - 0.5) * 0.6;
      const lRotZ = (shrubRng() - 0.5) * tiltRange;
      const ls = 0.75 + shrubRng() * 0.6;
      dummy.position.set(lx, ly, lz);
      dummy.rotation.set(lRotX, lRotY, lRotZ);
      dummy.scale.set(ls, ls, ls);
      dummy.updateMatrix();
      leaves.setMatrixAt(leafIdx, dummy.matrix);
      // La hoja va algo más clara que el cuerpo del arbusto — es lo que hace
      // que se lea como hoja recortada sobre la masa y no como parte de ella.
      leaves.setColorAt(leafIdx, jitterColor(tmpColor, leafBaseColor.getHex(), leafColorRng));
      leafSway.push({ mesh: leaves, index: leafIdx, x: lx, y: ly, z: lz, rotX: lRotX, rotY: lRotY, rotZ: lRotZ, s: ls, phase: shrubRng() * Math.PI * 2 });
      leafIdx++;
    }
  });
  body.instanceMatrix.needsUpdate = true;
  // FASE 4: el cuerpo instanciado ya no se dibuja (lo reemplaza la malla
  // horneada por lóbulos); queda como fuente del material de los hero.
  shrubBodyMeshes.splice(shrubBodyMeshes.indexOf(body), 1);
  // Solo se dibujan las flores realmente colocadas.
  flowers.count = flowerCount;
  shrubTotal += positions.length;
  flowerTotal += flowerCount;
  flowers.instanceMatrix.needsUpdate = true;
  if (body.instanceColor) body.instanceColor.needsUpdate = true;
  leaves.instanceMatrix.needsUpdate = true;
  if (leaves.instanceColor) leaves.instanceColor.needsUpdate = true;
  scene.add(flowers, leaves);
});

for (const [kind, items] of Object.entries(shrubBake)) {
  if (!items.length) continue;
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    map: sharedFoliageMap,
    normalMap: sharedFoliageBump,
    normalScale: new THREE.Vector2(0.7, 0.7),
    roughness: kind === "glossy" ? 0.35 : 0.9,
    metalness: 0.0,
  });
  windify(mat, "pivot", SHRUB_WIND);
  const mass = new THREE.Mesh(bakeInstances(items), mat);
  mass.castShadow = true;
  mass.receiveShadow = true;
  mass.customDepthMaterial = windDepthMaterial("pivot", SHRUB_WIND);
  mass.name = `matorral_${kind}`;
  scene.add(mass);
}

// CAPA 3 — Gramíneas y herbáceas.
// El salto visual entre el suelo desnudo y los arbustos era lo que más
// delataba la escena: en un pastizal real no se ve tierra entre planta y
// planta, se ve pasto. Ahora los mechones siguen la máscara de gramíneas,
// que es alta donde el monte rarea y baja bajo el dosel.
const GRASS_COUNT = 2600;
const grassRng = mulberry32(447192);
const grassPositions = clusteredScatter({
  count: GRASS_COUNT,
  rMin: 0.9,
  rMax: 16.0,
  density: (x, z) => grassDensity(x, z),
  clusterCount: 90,
  clusterRadius: 0.75,
  minDist: 0.16,
  solitaryRatio: 0.35, // el pasto sí es en buena parte disperso
  poiDist: 0.55,
  waterMargin: 0.25,
  rand: grassRng,
});
// Se probó ensanchar el mechón a 4,8 cm para que leyera como mata y no como
// aguja: un cono de tres caras a ese ancho se convierte en una pirámide de
// cartón, peor que la púa. Con esta geometría el ancho no es la palanca; la
// que funciona es la densidad. Queda apenas más grueso que el original
// (2,5 cm) y el resto lo hace la cantidad.
const grassGeo = new THREE.ConeGeometry(0.03, 0.48, 3);
grassGeo.translate(0, 0.25, 0);
const grassMat = new THREE.MeshStandardMaterial({ color: 0x9a9a52, roughness: 1.0, flatShading: true });
// FASE 4: el viento del pasto pasa al shader (2.600 matrices menos por
// frame). La amplitud cae con la distancia: a 14 m el pasto apenas respira.
windify(grassMat, "instance", { f1: 1.1, a1: 0.14, f2: 2.6, a2: 0.05, zRatio: 0.6, near: 6, far: 14, farAmp: 0.35 });
const grassTufts = new THREE.InstancedMesh(grassGeo, grassMat, grassPositions.length);
// Manchas: a media distancia el pastizal no se lee como tallos sueltos sino
// como parches de distinto tono — más pajizo donde seca, más verde donde
// junta agua. Ruido propio, independiente de todos los generadores.
const grassPatchNoise = makeNoise2D(771203);
const GRASS_STRAW = new THREE.Color(0xb3a466);
// Raleo lejano con rng aislado: más allá de ~8 m un mechón de 3 cm de ancho
// es una astilla de medio píxel que solo parpadea. Se descarta hasta un 38%
// y los que quedan se ensanchan, así la mancha conserva su masa.
const grassThinRng = mulberry32(318877);
let grassDrawn = 0;

// El pasto es lo que más se nota balanceándose con el viento (más alto,
// más liviano) — guarda transform base por mechón para el render loop.
const grassSway = [];
const grassDry = new THREE.Color(0x9a9a52);
const grassWet = new THREE.Color(0x6f8a45); // el pasto de bañado es más verde
grassPositions.forEach(([x, z], i) => {
  // Más alto donde hay humedad, más raso y amarillo en el pastizal seco.
  const moisture = soilMoisture(x, z);
  const s = bellRange(grassRng, 0.60, 1.50) * (0.85 + moisture * 0.5);
  const y = groundY(x, z);
  const baseRotX = (grassRng() - 0.5) * 0.3;
  const baseRotZ = (grassRng() - 0.5) * 0.3;
  const rotY = grassRng() * Math.PI * 2;
  grassSway.push({ x, y, z, s, baseRotX, baseRotZ, rotY, phase: grassRng() * Math.PI * 2 });
  tmpColor.lerpColors(grassDry, grassWet, moisture).multiplyScalar(0.85 + grassRng() * 0.3);
  const far = clamp01((heroDist(x, z) - 8) / 6);
  if (grassThinRng() < far * 0.38) return; // raleado (ya consumió todo lo suyo)
  const widen = 1 + far * 0.8;
  dummy.position.set(x, y, z);
  dummy.rotation.set(baseRotX, rotY, baseRotZ);
  dummy.scale.set(widen, s, widen);
  dummy.updateMatrix();
  grassTufts.setMatrixAt(grassDrawn, dummy.matrix);
  const patch = fbm(grassPatchNoise, x * 0.3, z * 0.3, 2);
  tmpColor.lerp(GRASS_STRAW, THREE.MathUtils.smoothstep(patch, 0.5, 0.75) * 0.5).multiplyScalar(0.9 + patch * 0.2);
  grassTufts.setColorAt(grassDrawn, tmpColor);
  grassDrawn++;
});
grassTufts.count = grassDrawn;
grassTufts.instanceMatrix.needsUpdate = true;
if (grassTufts.instanceColor) grassTufts.instanceColor.needsUpdate = true;
scene.add(grassTufts);

// CAPA 4 — Cobertura del suelo.
// Matitas rasas y hojarasca: no se miran, se notan cuando faltan. Son lo que
// impide que el ojo vea "objeto apoyado sobre textura" y lo hace leer como
// "planta creciendo en un suelo". Se densifican junto a los árboles, que es
// donde de verdad se acumula la hojarasca.
const COVER_COUNT = 3200;
const coverRng = mulberry32(710044);
const coverPositions = clusteredScatter({
  count: COVER_COUNT,
  rMin: 0.8,
  rMax: 15.0,
  density: (x, z) => clamp01(0.35 + grassDensity(x, z) * 0.5 + monteDensity(x, z) * 0.45),
  clusterCount: 140,
  clusterRadius: 0.6,
  minDist: 0.1,
  solitaryRatio: 0.45,
  poiDist: 0.4,
  waterMargin: 0.15,
  rand: coverRng,
});

// Geometría mínima a propósito: son miles de instancias y nadie las mira de
// cerca. Pero el primer intento usó conos altos y oscuros, y el resultado
// fueron piedritas negras esparcidas por el campo: PEOR que el suelo
// desnudo. La cobertura tiene que ser ancha y baja — una mata rasa, no una
// púa — y de un tono cercano al del suelo, porque lo que debe aportar es
// textura, no contraste.
const coverGeo = new THREE.ConeGeometry(0.09, 0.055, 5);
coverGeo.translate(0, 0.027, 0);
const coverMat = new THREE.MeshStandardMaterial({
  color: 0x9a9064,
  roughness: 1.0,
  flatShading: true,
});
const groundCover = new THREE.InstancedMesh(coverGeo, coverMat, coverPositions.length);
const coverLitter = new THREE.Color(0x8e7d55); // hojarasca parda bajo los árboles
const coverGreen = new THREE.Color(0x8f9760);
coverPositions.forEach(([x, z], i) => {
  const under = monteDensity(x, z);
  const s = 0.7 + coverRng() * 1.1;
  dummy.position.set(x, groundY(x, z), z);
  dummy.rotation.set((coverRng() - 0.5) * 0.25, coverRng() * Math.PI * 2, (coverRng() - 0.5) * 0.25);
  dummy.scale.set(s, s * (0.5 + coverRng() * 0.7), s);
  dummy.updateMatrix();
  groundCover.setMatrixAt(i, dummy.matrix);
  // Cada matita toma el color del suelo donde está plantada y solo se
  // desvía un poco hacia el verde. Con un color propio fijo, al oscurecer
  // la ribera se recortaban contra la tierra como gravilla esparcida.
  soilColorAt(x, z, tmpColor);
  tmpColor
    .lerp(under > 0.3 ? coverLitter : coverGreen, 0.3)
    .multiplyScalar(1.02 + coverRng() * 0.16);
  groundCover.setColorAt(i, tmpColor);
});
groundCover.instanceMatrix.needsUpdate = true;
if (groundCover.instanceColor) groundCover.instanceColor.needsUpdate = true;
groundCover.receiveShadow = true;
scene.add(groundCover);

// --- Vegetación ribereña: totoras/juncos + sauce criollo -----------------
// En una laguna real la orilla no es pasto corto: hay una franja densa de
// totora (Schoenoplectus californicus) y juncos, y sauces criollos
// (Salix humboldtiana — el sauce NATIVO del monte ribereño uruguayo, no el
// sauce llorón asiático) inclinados sobre el agua con las ramas colgando.
const REED_CLUMPS = 30;
const REEDS_PER_CLUMP = 18;
const reedGeo = new THREE.ConeGeometry(0.011, 0.8, 6);
reedGeo.translate(0, 0.4, 0);
bendBladeGeometry(reedGeo, 0.8, 0.09, 71001);
const reedMat = new THREE.MeshStandardMaterial({ color: 0x5d7a3e, roughness: 1.0, flatShading: true });
const reeds = new THREE.InstancedMesh(reedGeo, reedMat, REED_CLUMPS * REEDS_PER_CLUMP);
reeds.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
reeds.castShadow = true;

// Los mechones estaban repartidos en ángulos exactamente equidistantes
// (c / REED_CLUMPS * 2π): un collar perfecto alrededor de la laguna. Eso es
// lo que hacía que el borde se leyera como una línea AGUA | TIERRA. Ahora la
// costa tiene tramos cerrados de totora y tramos abiertos de orilla limpia,
// y el ancho de la franja varía punto a punto (reedBandWidth).
const reedRng = mulberry32(228855);
const reedSway = [];
let reedIdx = 0;
let reedPlaced = 0;

for (let c = 0; c < REED_CLUMPS * 3 && reedPlaced < REED_CLUMPS; c++) {
  const clumpAngle = reedRng() * Math.PI * 2;
  // Máscara de costa: dónde hay juncal y dónde la orilla queda pelada.
  const bank = fbm(shoreNoise, Math.cos(clumpAngle) * 3 + 40, Math.sin(clumpAngle) * 3 + 40, 3);
  if (bank < 0.42) continue; // tramo de orilla abierta
  reedPlaced++;

  // Se plantan pisando el borde y se internan tierra adentro tanto como dé
  // el ancho del juncal en ese punto de la costa.
  const [ex, ez] = waterOutlinePoint(clumpAngle, 1.0);
  const width = reedBandWidth(ex, ez);
  const offset = (reedRng() - 0.35) * width; // algunos dentro del agua
  const clumpScale = 1.0 + offset / WATER_RADIUS;
  const [cx, cz] = waterOutlinePoint(clumpAngle, clumpScale);

  for (let r = 0; r < REEDS_PER_CLUMP; r++) {
    const spread = 0.18 + width * 0.16;
    const x = cx + (reedRng() - 0.5) * spread;
    const z = cz + (reedRng() - 0.5) * spread;
    // Los del borde exterior son más bajos: la totora se afina al alejarse
    // del agua, no termina en un corte recto.
    const d = Math.max(0, distanceToWater(x, z));
    const falloff = 1 - smoothstep(0, width + 0.4, d);
    const s = (0.5 + reedRng() * 0.7) * (0.45 + falloff * 0.75);
    const baseRotX = (reedRng() - 0.5) * 0.25;
    const baseRotZ = (reedRng() - 0.5) * 0.25;
    const rotY = reedRng() * Math.PI * 2;
    const y = d > 0.15 ? groundY(x, z) + 0.14 : 0.14;
    dummy.position.set(x, y, z);
    dummy.rotation.set(baseRotX, rotY, baseRotZ);
    dummy.scale.set(1, s, 1);
    dummy.updateMatrix();
    reeds.setMatrixAt(reedIdx, dummy.matrix);
    reedSway.push({ index: reedIdx, x, y, z, s, baseRotX, baseRotZ, rotY, phase: reedRng() * Math.PI * 2 });
    reedIdx++;
  }
}
reeds.count = reedIdx;
reeds.instanceMatrix.needsUpdate = true;
scene.add(reeds);

// --- HERO_WATER_EDGE_01 --------------------------------------------------
// FASE 2: una sección puntual del borde de agua como "referencia de
// calidad" -- no todo el perímetro, un único arco. Se elige el punto del
// contorno más cercano al punto de vista fijo (mismo criterio de heroDist
// que ya elige árboles/arbustos/matas hero), así que sigue siendo válido
// si el trazado de la laguna cambia en una pasada futura.
let heroEdgeAngle = 0;
let heroEdgeBestD = Infinity;
for (let a = 0; a < Math.PI * 2; a += 0.05) {
  const [ex, ez] = waterOutlinePoint(a, 1.0);
  const d = heroDist(ex, ez);
  if (d < heroEdgeBestD) {
    heroEdgeBestD = d;
    heroEdgeAngle = a;
  }
}

// Restos de junco seco: tallos caídos, no en pie, tendidos casi al ras del
// barro -- lo que de verdad queda en una orilla real, y que ningún sistema
// de matas en pie puede dar.
const edgeLitterGeo = new THREE.CylinderGeometry(0.006, 0.009, 0.6, 4);
edgeLitterGeo.translate(0, 0.3, 0);
bendBladeGeometry(edgeLitterGeo, 0.6, 0.05, 71005);
const edgeLitterMat = new THREE.MeshStandardMaterial({ color: 0x8a7a4a, roughness: 1.0, flatShading: true });
const HERO_EDGE_LITTER = 12;
const heroEdgeLitter = new THREE.InstancedMesh(edgeLitterGeo, edgeLitterMat, HERO_EDGE_LITTER);
heroEdgeLitter.receiveShadow = true;
const heroEdgeRng = mulberry32(881123);
for (let i = 0; i < HERO_EDGE_LITTER; i++) {
  const a = heroEdgeAngle + (heroEdgeRng() - 0.5) * 0.7;
  const rScale = 0.85 + heroEdgeRng() * 0.35; // desde el agua hasta el barro seco
  const [x, z] = waterOutlinePoint(a, rScale);
  dummy.position.set(x, 0, z);
  // Acostado y con rumbo propio. El orden YXZ importa: con el XYZ por
  // defecto el giro en Y se aplica antes de tumbarlo y no cambia nada, y
  // los 12 tallos quedaban paralelos apuntando al mismo lado.
  dummy.rotation.set(Math.PI / 2 + (heroEdgeRng() - 0.5) * 0.3, heroEdgeRng() * Math.PI * 2, 0, "YXZ");
  const ls = 0.7 + heroEdgeRng() * 0.6;
  dummy.scale.set(ls, ls, ls);
  dummy.updateMatrix();
  heroEdgeLitter.setMatrixAt(i, dummy.matrix);
  hugGround(heroEdgeLitter, x, z, 0.004, 0.15 * ls, i);
}
dummy.rotation.order = "XYZ";
heroEdgeLitter.instanceMatrix.needsUpdate = true;
scene.add(heroEdgeLitter);

// Charcos de barro húmedo: discos casi planos con brillo propio, para que
// la transición barro->agua tenga algún punto que de verdad refleje luz en
// vez de ser todo mate -- el barro recién mojado sí lo hace.
const puddleGeo = new THREE.CircleGeometry(0.14, 10);
puddleGeo.rotateX(-Math.PI / 2);
const puddleMat = new THREE.MeshStandardMaterial({
  color: 0x2c2415,
  // Con 0.35 el sol rasante los volvía gris claro, más brillantes que la
  // propia laguna: mismo lóbulo especular que blanqueaba el agua en Fase 1.
  roughness: 0.55,
  metalness: 0.0,
  envMapIntensity: 0.08,
  // Apoyado casi al ras del barro de la orilla: sin offset pelea en z-buffer.
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -2,
});
const HERO_PUDDLES = 4;
const heroPuddles = new THREE.InstancedMesh(puddleGeo, puddleMat, HERO_PUDDLES);
const heroPuddleRng = mulberry32(881457);
for (let i = 0; i < HERO_PUDDLES; i++) {
  const a = heroEdgeAngle + (heroPuddleRng() - 0.5) * 0.6;
  const rScale = 1.02 + heroPuddleRng() * 0.28; // ya en la franja de barro, fuera del agua
  const [x, z] = waterOutlinePoint(a, rScale);
  dummy.position.set(x, 0, z);
  dummy.rotation.set(0, heroPuddleRng() * Math.PI * 2, 0);
  const ps = 0.6 + heroPuddleRng() * 0.7;
  dummy.scale.set(ps, 1, ps * (0.6 + heroPuddleRng() * 0.4)); // charcos irregulares, no discos perfectos
  dummy.updateMatrix();
  heroPuddles.setMatrixAt(i, dummy.matrix);
  hugGround(heroPuddles, x, z, 0.003, 0.08, i);
}
heroPuddles.instanceMatrix.needsUpdate = true;
scene.add(heroPuddles);

// Franja de humedal: gramíneas de suelo húmedo entre el juncal y el
// pastizal. Es el eslabón que faltaba — sin ella se pasaba de totoras de
// 80 cm a pasto seco de un metro a otro, y esa discontinuidad es lo que
// leía como recorte. Va más baja que la totora y más verde que el pastizal.
const SEDGE_COUNT = 900;
const sedgeRng = mulberry32(339071);
const sedgeGeo = new THREE.ConeGeometry(0.014, 0.34, 6);
sedgeGeo.translate(0, 0.17, 0);
bendBladeGeometry(sedgeGeo, 0.34, 0.045, 71002);
const sedgeMat = new THREE.MeshStandardMaterial({
  color: 0x6d8443,
  roughness: 1.0,
  flatShading: true,
});
const sedges = new THREE.InstancedMesh(sedgeGeo, sedgeMat, SEDGE_COUNT);
const sedgeWet = new THREE.Color(0x5f8040);
const sedgeDry = new THREE.Color(0x8b9053);
let sedgeIdx = 0;
for (let i = 0; i < SEDGE_COUNT * 12 && sedgeIdx < SEDGE_COUNT; i++) {
  const a = sedgeRng() * Math.PI * 2;
  const [ex, ez] = waterOutlinePoint(a, 1.0);
  const width = reedBandWidth(ex, ez);
  // Se reparte desde el borde del juncal hasta unos metros tierra adentro,
  // con más densidad cerca del agua.
  const d = width * 0.5 + Math.pow(sedgeRng(), 1.7) * 3.4;
  const dir = Math.atan2(ez - WATER_CENTER[1], ex - WATER_CENTER[0]);
  const jitter = (sedgeRng() - 0.5) * 0.7;
  const x = ex + Math.cos(dir) * d + jitter;
  const z = ez + Math.sin(dir) * d * WATER_Z_SQUASH + jitter;
  if (insideWater(x, z, 0.05)) continue;
  const moisture = soilMoisture(x, z);
  if (sedgeRng() > moisture * 1.15) continue; // sigue la humedad, no el radio
  const s = bellRange(sedgeRng, 0.6, 1.5);
  dummy.position.set(x, groundY(x, z), z);
  dummy.rotation.set((sedgeRng() - 0.5) * 0.3, sedgeRng() * Math.PI * 2, (sedgeRng() - 0.5) * 0.3);
  dummy.scale.set(1, s, 1);
  dummy.updateMatrix();
  sedges.setMatrixAt(sedgeIdx, dummy.matrix);
  tmpColor.lerpColors(sedgeDry, sedgeWet, moisture).multiplyScalar(0.88 + sedgeRng() * 0.24);
  sedges.setColorAt(sedgeIdx, tmpColor);
  sedgeIdx++;
}
sedges.count = sedgeIdx;
sedges.instanceMatrix.needsUpdate = true;
if (sedges.instanceColor) sedges.instanceColor.needsUpdate = true;
sedges.castShadow = true;
scene.add(sedges);

// Sauces criollos: tronco inclinado sobre el agua + cortina de ramas
// colgantes. Las ramas son planos finos con el pivote ARRIBA (en el punto
// donde nacen), así el balanceo de viento las mueve desde el anclaje y la
// punta es la que más se desplaza — que es como cuelga un sauce de verdad.
// FASE 2.5 — rama de conexión tronco-copa: hasta ahora los lóbulos de
// follaje flotaban sueltos alrededor de la punta del tronco, sin nada que
// los sostuviera visualmente. Un cilindro cónico entre el punto de
// arranque y el centro del lóbulo (recortado al 82% del trayecto, para que
// la punta quede embebida en el follaje y no asome del otro lado) alcanza
// para leer como una rama real sin modelar toda la ramificación.
// FASE 3A — raíz superficial: unas pocas varillas cónicas que salen del pie
// del tronco y se hunden apenas hacia afuera, como el flare real de raíces
// que un sauce o un ceibo sí muestran en superficie (a diferencia de un
// cilindro que nace limpio del pasto). `rng` es la del propio árbol o una
// aislada, para no tocar ninguna secuencia aprobada.
function addBranchStub(fromX, fromY, fromZ, toX, toY, toZ, rBase, rTip, mat, reach = 0.82) {
  const dx = (toX - fromX) * reach;
  const dy = (toY - fromY) * reach;
  const dz = (toZ - fromZ) * reach;
  const len = Math.hypot(dx, dy, dz) || 0.001;
  const geo = new THREE.CylinderGeometry(rTip, rBase, len, 6);
  geo.translate(0, len / 2, 0);
  const branch = new THREE.Mesh(geo, mat);
  branch.position.set(fromX, fromY, fromZ);
  const dir = new THREE.Vector3(dx, dy, dz).normalize();
  branch.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  branch.castShadow = true;
  addStaticPart(branch);
  return branch;
}

// FASE 4: ramas principales de los árboles del monte en primer plano y plano
// medio cercano. Sin ellas la copa por lóbulos flotaba sobre un palo: ahora
// entre lóbulo y lóbulo se ve la estructura que los sostiene. Se funden en
// un solo lote estático con el resto de las ramas de esta corteza.
const monteBranchMat = makeBarkMaterial(0xa89071);
for (const b of monteBranchSpecs) {
  addBranchStub(b.from[0], b.from[1], b.from[2], b.to[0], b.to[1], b.to[2], b.rBase, b.rTip, monteBranchMat, 0.85);
}

const WILLOW_COUNT = 4;
const WHIPS_PER_WILLOW = 150;
const willowTrunkMat = makeBarkMaterial(0x9d8a70);
const willowCrownMat = new THREE.MeshStandardMaterial({ color: 0x475c33, roughness: 0.9, flatShading: true });
const willowWhipMat = new THREE.MeshStandardMaterial({ color: 0x7d9a5a, roughness: 0.85, flatShading: true });

// Ramitas colgantes finas (conos, no planos anchos): muchas y delgadas
// leen como cortina de sauce; pocas y anchas leían como cintas sueltas.
const whipGeo = new THREE.ConeGeometry(0.018, 1, 3);
whipGeo.translate(0, -0.5, 0); // pivote en el extremo superior, donde nace la rama
const willowWhips = new THREE.InstancedMesh(whipGeo, willowWhipMat, WILLOW_COUNT * WHIPS_PER_WILLOW);
willowWhips.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
willowWhips.castShadow = true;

const whipSway = [];
const willowCrownLobes = [];
const willowBasePositions = [];
let whipIdx = 0;
for (let w = 0; w < WILLOW_COUNT; w++) {
  const angle = (w / WILLOW_COUNT) * Math.PI * 2 + 0.6 + rng() * 0.5;
  const [bx, bz] = waterOutlinePoint(angle, 1.45 + rng() * 0.25);
  willowBasePositions.push([bx, bz]);

  // se inclina hacia el centro del agua
  const toWaterX = WATER_CENTER[0] - bx;
  const toWaterZ = WATER_CENTER[1] - bz;
  const toWaterLen = Math.hypot(toWaterX, toWaterZ) || 1;
  const dirX = toWaterX / toWaterLen;
  const dirZ = toWaterZ / toWaterLen;

  const height = 3.1 + rng() * 1.1;
  const lean = 0.16 + rng() * 0.1;

  const trunkGeo = new THREE.CylinderGeometry(0.07, 0.15, height, 16);
  trunkGeo.translate(0, height / 2, 0);
  const trunk = new THREE.Mesh(trunkGeo, willowTrunkMat);
  trunk.position.set(bx, groundY(bx, bz) + 0.1, bz);
  contactPoints.push([bx, bz, 0.7, 1.05]);
  trunk.rotation.x = dirZ * lean;
  trunk.rotation.z = -dirX * lean;
  trunk.castShadow = true;
  scene.add(trunk);

  // copa desplazada por la inclinación del tronco
  const crownX = bx + dirX * height * Math.sin(lean);
  const crownZ = bz + dirZ * height * Math.sin(lean);
  const crownY = groundY(bx, bz) + 0.1 + height * Math.cos(lean);
  const crownSpread = 1.25 + rng() * 0.7;

  // Masa de follaje en la copa: sin esto el tronco quedaba pelado y las
  // ramas colgantes parecían flotar sueltas en el aire.
  //
  // FASE 3: antes era UN blob (un solo icosaedro deformado). Con solo 4
  // sauces en toda la escena, el costo de darle a cada uno una copa real es
  // insignificante — así que los 4 pasan a tener 3-4 lóbulos superpuestos
  // en vez de uno. `willowLobeRng` es una semilla propia por sauce (no
  // consume del `rng()` global) para no correr la posición de nada que se
  // genere después en el archivo.
  const willowLobeRng = mulberry32(560000 + w * 977);
  const crownLobeCount = 3 + (willowLobeRng() < 0.5 ? 0 : 1);
  // FASE 2.5: el facetado de copa era el defecto más visible de toda la
  // escena. Subdividir el icosaedro base (nivel 2 -> nivel 4 para los
  // sauces realmente cercanos) multiplica los triángulos por ~16, pero solo
  // en los ejemplares que el usuario realmente va a mirar de cerca: los
  // lejanos se quedan en nivel 2, que a 10+ m no se distingue.
  const willowD = heroDist(bx, bz);
  const lobeDetail = willowD < 6 ? 4 : willowD < 12 ? 3 : 2;
  // FASE 3A: raíz superficial + hojarasca, solo en los sauces realmente
  // cercanos -- el resto de la escena no cambia.
  if (willowD < 6) {
    const baseY = groundY(bx, bz) + 0.06;
    addRootFlare(bx, baseY, bz, willowTrunkMat, 5, willowLobeRng, 0.95, 0.15);
    addLeafLitter(bx, bz, 14, willowLobeRng, 0.9);
  }
  for (let cl = 0; cl < crownLobeCount; cl++) {
    const ang = (cl / crownLobeCount) * Math.PI * 2 + willowLobeRng() * 0.8;
    const lobeSpread = crownSpread * (0.58 + willowLobeRng() * 0.3);
    const offR = crownSpread * (0.22 + willowLobeRng() * 0.16);
    const offY = (willowLobeRng() - 0.35) * crownSpread * 0.26;
    const lobe = new THREE.Mesh(
      makeOrganicGeometry(new THREE.IcosahedronGeometry(0.62, lobeDetail), 0.3, 400 + w * 37 + cl),
      willowCrownMat
    );
    const lobeX = crownX + Math.cos(ang) * offR;
    const lobeY = crownY - 0.15 + offY;
    const lobeZ = crownZ + Math.sin(ang) * offR;
    lobe.position.set(lobeX, lobeY, lobeZ);
    lobe.scale.set(lobeSpread * 0.85, lobeSpread * 0.5, lobeSpread * 0.85);
    lobe.castShadow = true;
    addStaticPart(lobe);
    addBranchStub(crownX, crownY - 0.2, crownZ, lobeX, lobeY, lobeZ, 0.045, 0.014, willowTrunkMat);
  }
  willowCrownLobes.push({
    x: crownX,
    y: crownY - 0.15,
    z: crownZ,
    rx: crownSpread * 0.85,
    ry: crownSpread * 0.5,
    rz: crownSpread * 0.85,
    leafScale: crownSpread * 0.9,
  });

  for (let k = 0; k < WHIPS_PER_WILLOW; k++) {
    const a = rng() * Math.PI * 2;
    // sesgadas al borde de la copa: es de ahí de donde cuelgan las ramas
    // ceñidas al perímetro de la copa (que mide crownSpread * 0.85): si se
    // dispersan más allá, quedan colgando del aire en vez del follaje
    const rad = crownSpread * 0.85 * (0.62 + 0.38 * Math.sqrt(rng()));
    const x = crownX + Math.cos(a) * rad;
    const z = crownZ + Math.sin(a) * rad;
    // las del borde nacen más abajo: da la silueta redondeada del sauce
    const y = crownY - 0.35 - (rad / crownSpread) * (0.3 + rng() * 0.25);
    // cortas y muy juntas: una cortina tupida, no palitos sueltos y largos
    const len = 0.45 + rng() * 0.75;
    const baseRotX = (rng() - 0.5) * 0.16;
    const baseRotZ = (rng() - 0.5) * 0.16;
    const rotY = rng() * Math.PI * 2;
    dummy.position.set(x, y, z);
    dummy.rotation.set(baseRotX, rotY, baseRotZ);
    dummy.scale.set(1, len, 1);
    dummy.updateMatrix();
    willowWhips.setMatrixAt(whipIdx, dummy.matrix);
    whipSway.push({ index: whipIdx, x, y, z, len, baseRotX, baseRotZ, rotY, phase: rng() * Math.PI * 2 });
    whipIdx++;
  }
}
willowWhips.instanceMatrix.needsUpdate = true;
scene.add(willowWhips);

// El sauce criollo (Salix humboldtiana) tiene hoja lanceolada larga y
// angosta. No hay foto CC0 de hoja de sauce, así que se usa la ovada
// estrechada al 38%: deforma la foto a propósito, pero la proporción que
// queda es la del sauce y es lo que el ojo lee en la silueta.
scatterLeafCards({
  lobes: willowCrownLobes,
  perLobe: 240,
  size: 0.24,
  kind: "ancha",
  narrow: 0.42,
  tint: new THREE.Color(0x9cbc6e),
  variant: 0,
  seed: 51477,
  // Asoman más que en el resto de los árboles: la copa del sauce es grande
  // y lisa, y con menos empuje las hojas quedaban dentro del volumen.
  outward: 1.1,
});

// --- Cortadera (Cortaderia selloana) -------------------------------------
// El pasto más característico de la pradera pampeana: mata densa de hojas
// largas y arqueadas, de la que salen varas altas rematadas en un penacho
// plumoso blanco-plateado. Es la silueta que más "lee" como pampa a
// distancia, así que se siembra por toda la escena, no solo cerca del agua.
const PAMPAS_CLUMPS = 26;
const BLADES_PER_CLUMP = 16;
const PLUMES_PER_CLUMP = 5;

// La cortadera es planta de suelo húmedo y bordes: se agrupa donde hay
// humedad y donde el monte no cierra, no repartida por toda la pradera.
const pampasRng = mulberry32(602118);
const pampasPositions = clusteredScatter({
  count: PAMPAS_CLUMPS,
  rMin: 2.4,
  rMax: 15.0,
  density: (x, z) =>
    clamp01(soilMoisture(x, z) * 1.1 + 0.25) * (1 - monteDensity(x, z) * 0.7) * poiClearing(x, z),
  clusterCount: 8,
  clusterRadius: 1.1,
  minDist: 0.9,
  solitaryRatio: 0.3,
  poiDist: 1.8,
  rand: pampasRng,
});

// Hoja: lámina muy larga y angosta, con el pivote en la base para que el
// viento la arquee desde donde nace.
const bladeGeo = new THREE.ConeGeometry(0.02, 1, 6);
bladeGeo.translate(0, 0.5, 0);
bendBladeGeometry(bladeGeo, 1, 0.13, 71003);
const bladeMat = new THREE.MeshStandardMaterial({ color: 0x8a9159, roughness: 1.0, flatShading: true });
const pampasBlades = new THREE.InstancedMesh(bladeGeo, bladeMat, PAMPAS_CLUMPS * BLADES_PER_CLUMP);
pampasBlades.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
pampasBlades.castShadow = true;

// Penacho: masa plumosa alargada arriba de la vara. Casi blanco y con algo
// de emisión para que capte la luz rasante del atardecer, como las plumas
// reales retroiluminadas.
// FASE 4: misma forma exacta que antes (mismo ruido por posición), pero con
// los vértices soldados: el penacho del plano medio deja de ser un poliedro
// blanco facetado, que era lo más "low poly" de toda la pradera.
const plumeGeo = (() => {
  let g = new THREE.IcosahedronGeometry(0.16, 2);
  g.deleteAttribute("normal");
  g.deleteAttribute("uv");
  g = mergeVertices(g);
  return makeOrganicGeometry(g, 0.45, 133);
})();
plumeGeo.scale(0.55, 2.3, 0.55);
const plumeMat = new THREE.MeshStandardMaterial({
  color: 0xe8e0cf,
  roughness: 0.75,
  emissive: 0xb8ac93,
  emissiveIntensity: 0.18,
});
const pampasPlumes = new THREE.InstancedMesh(plumeGeo, plumeMat, PAMPAS_CLUMPS * PLUMES_PER_CLUMP);
pampasPlumes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
pampasPlumes.castShadow = true;

// Vara que sostiene el penacho
const stalkGeo = new THREE.CylinderGeometry(0.012, 0.018, 1, 4);
stalkGeo.translate(0, 0.5, 0);
const stalkMat = new THREE.MeshStandardMaterial({ color: 0x9a9060, roughness: 1.0, flatShading: true });
const pampasStalks = new THREE.InstancedMesh(stalkGeo, stalkMat, PAMPAS_CLUMPS * PLUMES_PER_CLUMP);
pampasStalks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

// FASE 2.5: antes se elegía una sola mata hero; ahora son las 2 más
// cercanas al punto de vista fijo (punto 24 del brief: "2 cortaderas"),
// siempre por posición pura, antes de generar nada.
const HERO_CLUMP_BUDGET = 2;
const heroClumpIndices = new Set(
  pampasPositions
    .map(([cx, cz], idx) => ({ idx, d: heroDist(cx, cz) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, HERO_CLUMP_BUDGET)
    .map((e) => e.idx)
);

// Relleno de base para las matas hero: en la captura de referencia se veía
// tierra desnuda entre las hojas largas y el suelo, porque BLADES_PER_CLUMP
// reparte las hojas en un solo radio y no deja nada bajo. Son instancias
// EXTRA sobre las 16 normales de cada mata, en un InstancedMesh aparte con
// su propio generador -- así las matas siguen teniendo exactamente las
// mismas 16 hojas y 5 penachos que antes, más este agregado, y ningún otro
// sistema ve moverse un solo valor de rng.
const HERO_FILLER_BLADES = 16;
const fillerBladeGeo = new THREE.ConeGeometry(0.015, 0.55, 4);
fillerBladeGeo.translate(0, 0.275, 0);
bendBladeGeometry(fillerBladeGeo, 0.55, 0.06, 71004);
const heroFillerBlades = new THREE.InstancedMesh(
  fillerBladeGeo,
  bladeMat,
  HERO_FILLER_BLADES * HERO_CLUMP_BUDGET
);
heroFillerBlades.castShadow = true;
const heroFillerRng = mulberry32(771002);
const heroFillerSway = [];
let heroFillerSlot = 0; // qué bloque de HERO_FILLER_BLADES le toca a la próxima mata hero

// FASE 2.5: penacho individual de mayor detalle para las matas hero. El
// penacho compartido (plumeGeo) es nivel 2; estos son nivel 4, igual que se
// hizo con las copas de árbol y arbusto -- reemplazo por escala cero en el
// InstancedMesh compartido más una malla propia, nunca tocando el resto de
// las matas.
// Una sola InstancedMesh (antes eran 10 mallas sueltas con sombra = 20 draw
// calls). La geometría es compartida; la variación la dan escala y rotación.
const heroPlumeGeo = makeOrganicGeometry(new THREE.IcosahedronGeometry(0.16, 4), 0.4, 900);
heroPlumeGeo.scale(0.55, 2.3, 0.55);
const heroPlumes = new THREE.InstancedMesh(heroPlumeGeo, plumeMat, PLUMES_PER_CLUMP * HERO_CLUMP_BUDGET);
heroPlumes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
heroPlumes.castShadow = true;
heroPlumes.count = 0;
const heroPlumeSway = [];
// Generador propio: la fase NO puede salir de `rng()`. Consumir valores de la
// secuencia compartida corría la posición de todo lo que se genera después
// (ceibo, ombú, butiá...), o sea la distribución aprobada.
const heroPlumeRng = mulberry32(771501);

const bladeSway = [];
const plumeSway = [];
let bladeIdx = 0;
let plumeIdx = 0;

pampasPositions.forEach(([cx, cz], clumpIdx) => {
  const clumpBase = groundY(cx, cz);
  contactPoints.push([cx, cz, 0.42, 0.7]);
  const clumpScale = 0.85 + rng() * 0.5;
  // FASE 4: versión simplificada para plano medio lejano y fondo: 10 hojas
  // más anchas en vez de 16. Se conserva lo que se lee a esa distancia
  // —penacho, altura, movimiento y silueta— y se quita lo que no.
  const clumpTier = heroClumpIndices.has(clumpIdx) ? "HERO" : visualTier(cx, cz, 2.2 * clumpScale, "cortadera");
  if (clumpTier === "HERO") registerTier("cortadera", "HERO");
  const simplified = TIER_RANK[clumpTier] >= TIER_RANK.MIDGROUND_FAR;

  for (let b = 0; b < BLADES_PER_CLUMP; b++) {
    const a = rng() * Math.PI * 2;
    const rad = rng() * 0.22 * clumpScale;
    const x = cx + Math.cos(a) * rad;
    const z = cz + Math.sin(a) * rad;
    const len = (0.8 + rng() * 0.6) * clumpScale;
    // las hojas se abren hacia afuera en abanico: más inclinadas cuanto
    // más lejos del centro de la mata
    const lean = 0.25 + (rad / (0.22 * clumpScale)) * 0.5;
    const baseRotX = Math.sin(a) * lean;
    const baseRotZ = -Math.cos(a) * lean;
    const rotY = rng() * Math.PI * 2;
    const hidden = simplified && b >= 10;
    const bw = hidden ? 0 : simplified ? 1.35 : 1;
    dummy.position.set(x, clumpBase, z);
    dummy.rotation.set(baseRotX, rotY, baseRotZ);
    dummy.scale.set(bw, hidden ? 0 : len, bw);
    dummy.updateMatrix();
    pampasBlades.setMatrixAt(bladeIdx, dummy.matrix);
    bladeSway.push({ index: bladeIdx, x, y: clumpBase, z, len: hidden ? 0 : len, bw, baseRotX, baseRotZ, rotY, phase: rng() * Math.PI * 2 });
    bladeIdx++;
  }

  if (heroClumpIndices.has(clumpIdx)) {
    const r = heroFillerRng;
    const slotBase = heroFillerSlot * HERO_FILLER_BLADES;
    heroFillerSlot++;
    for (let f = 0; f < HERO_FILLER_BLADES; f++) {
      // Radio más chico y más parejo que el de las hojas largas: son las
      // hojas cortas del centro de la mata, las que tapan la tierra pelada.
      const a = r() * Math.PI * 2;
      const rad = r() * 0.16 * clumpScale;
      const x = cx + Math.cos(a) * rad;
      const z = cz + Math.sin(a) * rad;
      const len = (0.28 + r() * 0.22) * clumpScale;
      const lean = 0.35 + r() * 0.5;
      const baseRotX = Math.sin(a) * lean;
      const baseRotZ = -Math.cos(a) * lean;
      const rotY = r() * Math.PI * 2;
      const idx = slotBase + f;
      dummy.position.set(x, clumpBase, z);
      dummy.rotation.set(baseRotX, rotY, baseRotZ);
      dummy.scale.set(1, len, 1);
      dummy.updateMatrix();
      heroFillerBlades.setMatrixAt(idx, dummy.matrix);
      heroFillerSway.push({ index: idx, x, y: clumpBase, z, len, baseRotX, baseRotZ, rotY, phase: r() * Math.PI * 2 });
    }
    // FASE 3: hojas secas caídas alrededor de la base -- sin esto cada mata
    // hero se leía como un objeto aparte pisando el pasto, en vez de una
    // mata real que acumula su propia hojarasca alrededor.
    addLeafLitter(cx, cz, 8, r, clumpScale * 0.5);
  }

  for (let p = 0; p < PLUMES_PER_CLUMP; p++) {
    const a = rng() * Math.PI * 2;
    const rad = rng() * 0.16 * clumpScale;
    const x = cx + Math.cos(a) * rad;
    const z = cz + Math.sin(a) * rad;
    const stalkLen = (1.5 + rng() * 0.8) * clumpScale;
    const baseRotX = (rng() - 0.5) * 0.18;
    const baseRotZ = (rng() - 0.5) * 0.18;

    dummy.position.set(x, clumpBase, z);
    dummy.rotation.set(baseRotX, 0, baseRotZ);
    dummy.scale.set(1, stalkLen, 1);
    dummy.updateMatrix();
    pampasStalks.setMatrixAt(plumeIdx, dummy.matrix);

    // el penacho corona la vara, siguiendo su inclinación
    const plumeY = clumpBase + stalkLen * Math.cos(baseRotX) + 0.22;
    const plumeX = x - Math.sin(baseRotZ) * stalkLen;
    const plumeZ = z + Math.sin(baseRotX) * stalkLen;
    const plumeRotY = rng() * Math.PI * 2;
    const ps = 0.8 + rng() * 0.45;
    const isHeroPlume = heroClumpIndices.has(clumpIdx);
    dummy.position.set(plumeX, plumeY, plumeZ);
    dummy.rotation.set(baseRotX, plumeRotY, baseRotZ);
    // Las matas hero reemplazan este penacho por una malla propia de mayor
    // detalle (más abajo); acá se lo oculta con escala cero, igual que se
    // hizo con los blobs de arbusto -- el InstancedMesh sigue teniendo el
    // mismo total de instancias, solo que esta no dibuja nada.
    dummy.scale.set(isHeroPlume ? 0 : ps, isHeroPlume ? 0 : ps, isHeroPlume ? 0 : ps);
    dummy.updateMatrix();
    pampasPlumes.setMatrixAt(plumeIdx, dummy.matrix);

    plumeSway.push({
      index: plumeIdx,
      stalkX: x,
      stalkZ: z,
      stalkLen,
      plumeX,
      plumeY,
      plumeZ,
      // 0 para las hero: el penacho instanciado se queda oculto aunque la
      // vara (pampasStalks, que usa el mismo stalkLen de este objeto) siga
      // animándose normalmente frame a frame.
      ps: isHeroPlume ? 0 : ps,
      baseRotX,
      baseRotZ,
      rotY: plumeRotY,
      phase: rng() * Math.PI * 2,
    });

    if (isHeroPlume) {
      const hIdx = heroPlumes.count++;
      dummy.position.set(plumeX, plumeY, plumeZ);
      dummy.rotation.set(baseRotX, plumeRotY, baseRotZ);
      dummy.scale.set(ps, ps, ps);
      dummy.updateMatrix();
      heroPlumes.setMatrixAt(hIdx, dummy.matrix);
      heroPlumeSway.push({
        index: hIdx,
        stalkX: x,
        stalkZ: z,
        stalkLen,
        ps,
        baseRotX,
        baseRotZ,
        rotY: plumeRotY,
        phase: heroPlumeRng() * Math.PI * 2,
      });
    }
    plumeIdx++;
  }
});
pampasBlades.instanceMatrix.needsUpdate = true;
// Matiz por mata: el penacho de la cortadera va del blanco plateado al
// crema, y algunos tiran a rosado. Todos iguales delataban la instancia.
{
  const plumeTintRng = mulberry32(563311);
  const PLUME_TINTS = [0xffffff, 0xf5eadb, 0xfbeeea, 0xeceef0];
  for (let c = 0; c < pampasPositions.length; c++) {
    const baseTint = PLUME_TINTS[Math.floor(plumeTintRng() * PLUME_TINTS.length)];
    for (let q = 0; q < PLUMES_PER_CLUMP; q++) {
      jitterColor(tmpColor, baseTint, plumeTintRng);
      pampasPlumes.setColorAt(c * PLUMES_PER_CLUMP + q, tmpColor);
    }
  }
  pampasPlumes.instanceColor.needsUpdate = true;
}
pampasPlumes.instanceMatrix.needsUpdate = true;
pampasStalks.instanceMatrix.needsUpdate = true;
heroFillerBlades.instanceMatrix.needsUpdate = true;
heroPlumes.instanceMatrix.needsUpdate = true;
scene.add(pampasBlades, pampasPlumes, pampasStalks, heroFillerBlades, heroPlumes);

// --- Ombú (Phytolacca dioica) --------------------------------------------
// El árbol emblema de la pampa. Técnicamente es una hierba gigante, y eso
// explica su rasgo inconfundible: la base del tronco se ensancha en una
// masa bulbosa y acanalada mucho más ancha que el fuste. Copa muy amplia y
// densa: daba la única sombra de la llanura, así que funciona como hito
// visual de la escena.
const OMBU_COUNT = 3;
const ombuTrunkMat = makeBarkMaterial(0xa8947a);
// FASE 4: la copa del ombú (plano medio, 7,5–14 m) era de las más facetadas
// de la escena, y además 24 mallas sueltas con sombra (48 draw calls). Ahora
// es lisa y va a un solo lote estático por material.
const ombuLeafMat = new THREE.MeshStandardMaterial({ color: 0x3f5f33, roughness: 0.88 });
function smoothOrganic(radius, detail, amount, seed) {
  let g = new THREE.IcosahedronGeometry(radius, detail);
  g.deleteAttribute("normal");
  g.deleteAttribute("uv");
  g = mergeVertices(g);
  return makeOrganicGeometry(g, amount, seed); // misma forma, normales lisas
}

const ombuCrownLobes = [];
// El ombú es solitario por definición: da la única sombra de la llanura y
// crece aislado. Se planta lejos del monte cerrado, no dentro.
const ombuRng = mulberry32(144902);
const ombuPositions = clusteredScatter({
  count: OMBU_COUNT,
  rMin: 7.5,
  rMax: 14.0,
  density: (x, z) => clamp01(1 - monteDensity(x, z) * 1.4) * poiClearing(x, z),
  clusterCount: 3,
  clusterRadius: 0.3,
  minDist: 6.0, // nunca dos ombúes juntos
  solitaryRatio: 1.0,
  poiDist: 3.0,
  rand: ombuRng,
});
ombuPositions.forEach(([x, z], i) => {
  const scale = bellRange(ombuRng, 0.9, 1.4);
  const base = groundY(x, z);

  // base bulbosa: varios lóbulos que se funden, no un cono liso
  const baseLobes = 6;
  for (let b = 0; b < baseLobes; b++) {
    const a = (b / baseLobes) * Math.PI * 2;
    const lobe = new THREE.Mesh(
      makeOrganicGeometry(new THREE.IcosahedronGeometry(0.55, 2), 0.28, 200 + i * 10 + b),
      ombuTrunkMat
    );
    lobe.position.set(x + Math.cos(a) * 0.42 * scale, base + 0.34 * scale, z + Math.sin(a) * 0.42 * scale);
    lobe.scale.set(scale * 0.9, scale * 0.75, scale * 0.9);
    lobe.castShadow = true;
    lobe.receiveShadow = true;
    addStaticPart(lobe); // FASE 4: base del ombú en un solo lote
  }
  const baseCore = new THREE.Mesh(
    makeOrganicGeometry(new THREE.IcosahedronGeometry(0.8, 2), 0.2, 260 + i),
    ombuTrunkMat
  );
  baseCore.position.set(x, base + 0.5 * scale, z);
  baseCore.scale.set(scale, scale * 0.85, scale);
  baseCore.castShadow = true;
  addStaticPart(baseCore);

  // fuste corto y grueso que sale del bulbo
  const trunkH = 1.7 * scale;
  // Sin índice, como los icosaedros de la base: así el lote puede fundirlos.
  const ombuTrunkGeo = new THREE.CylinderGeometry(0.3 * scale, 0.55 * scale, trunkH, 9).toNonIndexed();
  ombuTrunkGeo.translate(0, trunkH / 2, 0);
  const ombuTrunk = new THREE.Mesh(ombuTrunkGeo, ombuTrunkMat);
  ombuTrunk.position.set(x, base + 0.75 * scale, z);
  contactPoints.push([x, z, 1.5 * scale, 1.25]);
  ombuTrunk.castShadow = true;
  addStaticPart(ombuTrunk);

  // copa ancha y baja, hecha de varios lóbulos de follaje
  const crownY = base + 0.75 * scale + trunkH;
  const crownLobes = 7;
  for (let c = 0; c < crownLobes; c++) {
    const a = (c / crownLobes) * Math.PI * 2 + rng() * 0.4;
    const rad = (0.9 + rng() * 0.7) * scale;
    const lobe = new THREE.Mesh(smoothOrganic(1, 2, 0.3, 300 + i * 10 + c), ombuLeafMat);
    lobe.position.set(
      x + Math.cos(a) * rad,
      crownY + (rng() - 0.35) * 0.5 * scale,
      z + Math.sin(a) * rad
    );
    const ls = (0.95 + rng() * 0.5) * scale;
    lobe.scale.set(ls, ls * 0.62, ls);
    lobe.castShadow = true;
    addStaticPart(lobe);
    ombuCrownLobes.push({
      x: lobe.position.x,
      y: lobe.position.y,
      z: lobe.position.z,
      rx: ls,
      ry: ls * 0.62,
      rz: ls,
      leafScale: scale,
    });
  }
  const crownCore = new THREE.Mesh(smoothOrganic(1, 2, 0.25, 360 + i), ombuLeafMat);
  crownCore.position.set(x, crownY + 0.25 * scale, z);
  crownCore.scale.set(1.5 * scale, 0.85 * scale, 1.5 * scale);
  crownCore.castShadow = true;
  addStaticPart(crownCore);
  registerTier("ombu", visualTier(x, z, crownY - base + 1.2 * scale));
  ombuCrownLobes.push({
    x,
    y: crownY + 0.25 * scale,
    z,
    rx: 1.5 * scale,
    ry: 0.85 * scale,
    rz: 1.5 * scale,
    leafScale: scale * 1.15,
  });
});

// Hoja del ombú: simple, ovada y grande. Es el árbol más voluminoso de la
// escena, así que su copa lisa era la que más delataba que el follaje era
// geometría y no vegetación.
scatterLeafCards({
  lobes: ombuCrownLobes,
  perLobe: 46,
  size: 0.34,
  kind: "ancha",
  tint: new THREE.Color(0x8fb562),
  variant: 0,
  seed: 77031,
});

// --- Ceibo (Erythrina crista-galli) --------------------------------------
// FLOR NACIONAL de Uruguay. Árbol de bañados y orillas, así que va en la
// ribera de la laguna, que es su hábitat real. Rasgos que lo identifican:
// tronco tortuoso e irregular (nunca recto), copa abierta y poco densa, y
// sobre todo los racimos de flores rojo carmesí intenso, que en el árbol
// real se ven antes que el follaje.
const CEIBO_COUNT = 3;
const ceiboTrunkMat = makeBarkMaterial(0xa08b70);
const ceiboLeafMat = new THREE.MeshStandardMaterial({ color: 0x47663a, roughness: 0.9, flatShading: true });
const ceiboFlowerMat = new THREE.MeshStandardMaterial({
  color: 0xc4142c,
  roughness: 0.55,
  emissive: 0x7a0d1b,
  emissiveIntensity: 0.3, // levanta el rojo bajo la luz rasante del atardecer
  flatShading: true,
});

// Flor: pétalo alargado y curvo, el "pico" de la cresta de gallo que le da
// el nombre a la especie.
const ceiboFlowerGeo = new THREE.ConeGeometry(0.042, 0.2, 5);
ceiboFlowerGeo.rotateX(Math.PI); // punta hacia abajo: la flor cuelga y se afina
ceiboFlowerGeo.translate(0, -0.1, 0); // pivote en la base, donde se une al racimo
const CEIBO_FLOWERS = 72;
const ceiboFlowers = new THREE.InstancedMesh(ceiboFlowerGeo, ceiboFlowerMat, CEIBO_COUNT * CEIBO_FLOWERS);
ceiboFlowers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
ceiboFlowers.castShadow = true;

const ceiboFlowerSway = [];
const ceiboCrownLobes = [];
const ceiboBasePositions = [];
let ceiboFlowerIdx = 0;

for (let c = 0; c < CEIBO_COUNT; c++) {
  const angle = (c / CEIBO_COUNT) * Math.PI * 2 + 2.2 + rng() * 0.6;
  const [bx, bz] = waterOutlinePoint(angle, 1.7 + rng() * 0.35);
  ceiboBasePositions.push([bx, bz]);
  const scale = 0.9 + rng() * 0.3;

  // tronco tortuoso: tramos encadenados que cambian de dirección, en vez
  // de un cilindro recto
  let segX = bx;
  let segZ = bz;
  let segY = groundY(bx, bz) + 0.05;
  let tiltX = (rng() - 0.5) * 0.3;
  let tiltZ = (rng() - 0.5) * 0.3;
  const segments = 3;
  for (let s = 0; s < segments; s++) {
    const segLen = (0.85 + rng() * 0.5) * scale;
    const rTop = (0.13 - s * 0.028) * scale;
    const rBot = (0.19 - s * 0.028) * scale;
    const segGeo = new THREE.CylinderGeometry(rTop, rBot, segLen, 14);
    segGeo.translate(0, segLen / 2, 0);
    const seg = new THREE.Mesh(segGeo, ceiboTrunkMat);
    seg.position.set(segX, segY, segZ);
    seg.rotation.x = tiltX;
    seg.rotation.z = tiltZ;
    seg.castShadow = true;
    scene.add(seg);

    // la punta de este tramo es la base del siguiente
    segX += -Math.sin(tiltZ) * segLen;
    segZ += Math.sin(tiltX) * segLen;
    segY += segLen * Math.cos(tiltX) * Math.cos(tiltZ);
    tiltX += (rng() - 0.5) * 0.5;
    tiltZ += (rng() - 0.5) * 0.5;
  }

  // copa abierta: lóbulos separados, no una masa compacta
  const crownLobes = 5;
  // Mismo criterio de nivel por distancia que en el sauce.
  const ceiboD = heroDist(bx, bz);
  const ceiboLobeDetail = ceiboD < 6 ? 4 : ceiboD < 12 ? 3 : 2;
  // FASE 3A: raíz superficial + hojarasca en la base del tronco (no en la
  // punta, que es donde arranca la copa). Rng propia y aislada: el resto
  // del ceibo usa `rng()` compartida y no se debe mover ni un valor.
  if (ceiboD < 6) {
    const ceiboRootRng = mulberry32(820000 + c * 719);
    const baseY = groundY(bx, bz) + 0.04;
    addRootFlare(bx, baseY, bz, ceiboTrunkMat, 6, ceiboRootRng, 1.0 * scale, 0.17 * scale);
    addLeafLitter(bx, bz, 16, ceiboRootRng, 1.0 * scale);
  }
  for (let l = 0; l < crownLobes; l++) {
    const a = (l / crownLobes) * Math.PI * 2 + rng() * 0.5;
    const rad = (0.5 + rng() * 0.55) * scale;
    const lobe = new THREE.Mesh(
      makeOrganicGeometry(new THREE.IcosahedronGeometry(0.5, ceiboLobeDetail), 0.3, 500 + c * 10 + l),
      ceiboLeafMat
    );
    const lobeX = segX + Math.cos(a) * rad;
    const lobeY = segY + (rng() - 0.3) * 0.5 * scale;
    const lobeZ = segZ + Math.sin(a) * rad;
    lobe.position.set(lobeX, lobeY, lobeZ);
    const ls = (0.85 + rng() * 0.5) * scale;
    lobe.scale.set(ls, ls * 0.75, ls);
    lobe.castShadow = true;
    addBranchStub(segX, segY, segZ, lobeX, lobeY, lobeZ, 0.06 * scale, 0.018 * scale, ceiboTrunkMat);
    ceiboCrownLobes.push({
      x: lobe.position.x,
      y: lobe.position.y,
      z: lobe.position.z,
      // el icosaedro base tiene radio 0.5, no 1
      rx: 0.5 * ls,
      ry: 0.5 * ls * 0.75,
      rz: 0.5 * ls,
      leafScale: scale,
    });
    addStaticPart(lobe);
  }

  // racimos de flores colgando del borde de la copa
  for (let f = 0; f < CEIBO_FLOWERS; f++) {
    const a = rng() * Math.PI * 2;
    const rad = (0.35 + rng() * 0.75) * scale;
    const x = segX + Math.cos(a) * rad;
    const z = segZ + Math.sin(a) * rad;
    const y = segY + (rng() - 0.25) * 0.65 * scale;
    const baseRotX = (rng() - 0.5) * 0.5;
    const baseRotZ = (rng() - 0.5) * 0.5;
    const rotY = rng() * Math.PI * 2;
    const fs = (0.8 + rng() * 0.5) * scale;
    dummy.position.set(x, y, z);
    dummy.rotation.set(baseRotX, rotY, baseRotZ);
    dummy.scale.set(fs, fs, fs);
    dummy.updateMatrix();
    ceiboFlowers.setMatrixAt(ceiboFlowerIdx, dummy.matrix);
    ceiboFlowerSway.push({ index: ceiboFlowerIdx, x, y, z, fs, baseRotX, baseRotZ, rotY, phase: rng() * Math.PI * 2 });
    ceiboFlowerIdx++;
  }
}
ceiboFlowers.instanceMatrix.needsUpdate = true;
scene.add(ceiboFlowers);

// Follaje del ceibo: hoja trifoliada de folíolos anchos. Se usa la foto
// ovada, y pocas hojas por lóbulo a propósito — la copa del ceibo es
// abierta y rala, y es esa transparencia la que deja ver las flores rojas,
// que en el árbol real se ven antes que el follaje.
scatterLeafCards({
  lobes: ceiboCrownLobes,
  perLobe: 32,
  size: 0.22,
  kind: "ancha",
  tint: new THREE.Color(0x8aab66),
  variant: 1,
  seed: 64108,
});

// --- Palma butiá (Butia odorata) -----------------------------------------
// La palmera nativa uruguaya. OJO con el nombre: la especie de acá es
// Butia odorata; "Butia capitata" (como aparece rotulada en varios bancos
// de modelos) es en realidad la especie brasileña. Rasgo inconfundible: la
// fronda pinnada se arquea fuerte hacia abajo, dando la silueta de fuente
// o plumero, y el tronco queda anillado por las bases de hojas viejas.
const BUTIA_COUNT = 4;
const FRONDS_PER_PALM = 13;
// +1 por paso: además de los folíolos laterales va un segmento alineado al
// raquis, que los cose en una fronda continua en vez de hojas sueltas
const LEAFLET_STEPS = 22;
const LEAFLETS_PER_FROND = LEAFLET_STEPS * 2;

const butiaTrunkMat = makeBarkMaterial(0xc0a888);
const butiaLeafletMat = new THREE.MeshStandardMaterial({
  color: 0x6f8557,
  roughness: 0.9,
  side: THREE.DoubleSide,
  flatShading: true,
});
const butiaFruitMat = new THREE.MeshStandardMaterial({ color: 0xe0921f, roughness: 0.65, flatShading: true });

const leafletGeo = new THREE.ConeGeometry(0.055, 0.5, 3);
leafletGeo.translate(0, 0.25, 0); // nace en el origen y se extiende hacia +Y
const butiaLeaflets = new THREE.InstancedMesh(
  leafletGeo,
  butiaLeafletMat,
  BUTIA_COUNT * FRONDS_PER_PALM * LEAFLETS_PER_FROND
);
butiaLeaflets.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
butiaLeaflets.castShadow = true;

const frondSway = [];
let leafletIdx = 0;
const LEAFLET_UP = new THREE.Vector3(0, 1, 0);
const leafletDir = new THREE.Vector3();
const rachisHere = new THREE.Vector3();
const rachisNext = new THREE.Vector3();
const rachisDir = new THREE.Vector3();
const swayQuat = new THREE.Quaternion();
const swayAxis = new THREE.Vector3();
const composedQuat = new THREE.Quaternion();

// El butiá forma palmares: aparece en grupos, no salpicado de a uno.
const butiaRng = mulberry32(318870);
const butiaPositions = clusteredScatter({
  count: BUTIA_COUNT,
  rMin: 6.5,
  rMax: 14.5,
  density: (x, z) => clamp01(0.4 + grassDensity(x, z) * 0.8) * poiClearing(x, z),
  clusterCount: 2,
  clusterRadius: 1.6,
  minDist: 2.2,
  solitaryRatio: 0.25,
  poiDist: 2.6,
  rand: butiaRng,
});
butiaPositions.forEach(([x, z], p) => {
  const butiaBase = groundY(x, z);
  const scale = 0.9 + rng() * 0.4;
  const trunkH = (3.2 + rng() * 1.4) * scale;

  const butiaTrunkGeo = new THREE.CylinderGeometry(0.19 * scale, 0.26 * scale, trunkH, 9);
  butiaTrunkGeo.translate(0, trunkH / 2, 0);
  const butiaTrunk = new THREE.Mesh(butiaTrunkGeo, butiaTrunkMat);
  butiaTrunk.position.set(x, butiaBase + 0.05, z);
  contactPoints.push([x, z, 0.5, 0.8]);
  butiaTrunk.castShadow = true;
  scene.add(butiaTrunk);

  // anillos: las bases de hojas viejas que quedan pegadas al tronco
  const rings = Math.floor(trunkH / 0.32);
  for (let r = 0; r < rings; r++) {
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.23 * scale, 0.23 * scale, 0.1, 9), butiaTrunkMat);
    ring.position.set(x, butiaBase + 0.05 + 0.2 + r * 0.32, z);
    ring.scale.set(1, 1, 1);
    scene.add(ring);
  }

  const crownY = 0.05 + trunkH;

  for (let f = 0; f < FRONDS_PER_PALM; f++) {
    const frondAngle = (f / FRONDS_PER_PALM) * Math.PI * 2 + rng() * 0.25;
    const frondLen = (1.5 + rng() * 0.6) * scale;
    // ángulo inicial de salida: las de afuera salen casi horizontales, las
    // del centro más erguidas
    const rise = 0.45 + rng() * 0.75;
    const phase = rng() * Math.PI * 2;

    // Direcciones del raquis: hacia afuera y lateral. Los folíolos se
    // orientan con quaternion (apuntando el eje +Y de la geometría a una
    // dirección calculada) en vez de con ángulos de Euler: con Euler es
    // casi imposible lograr que la punta de la fronda cuelgue hacia abajo
    // y queda todo apuntando al cielo como una yuca.
    const radialX = Math.cos(frondAngle);
    const radialZ = Math.sin(frondAngle);
    const latX = -Math.sin(frondAngle);
    const latZ = Math.cos(frondAngle);

    // punto del raquis en la posición normalizada tt (0 = base, 1 = punta).
    // El arco sube al principio y cae al final: de acá sale la silueta de
    // fuente característica del butiá.
    const rachisPoint = (tt, out) => {
      const arcY = Math.sin(tt * Math.PI * 0.85) * rise - tt * tt * 1.35;
      const dist = tt * frondLen;
      return out.set(x + radialX * dist, crownY + arcY * scale, z + radialZ * dist);
    };

    for (let s = 0; s < LEAFLET_STEPS; s++) {
      const tt = (s + 1) / LEAFLET_STEPS;
      rachisPoint(tt, rachisHere);
      const lx = rachisHere.x;
      const ly = rachisHere.y;
      const lz = rachisHere.z;

      // folíolos laterales: salen en "V" y caen cada vez más hacia la punta
      const side = s % 2 === 0 ? 1 : -1;
      const upComp = 0.5 - tt * 1.5; // positivo en la base, negativo en la punta
      const ls = (1 - tt * 0.4) * scale;
      leafletDir
        .set(radialX * 0.72 + latX * side * 0.55, upComp, radialZ * 0.72 + latZ * side * 0.55)
        .normalize();
      const sideQuat = new THREE.Quaternion().setFromUnitVectors(LEAFLET_UP, leafletDir);

      dummy.position.set(lx, ly, lz);
      dummy.quaternion.copy(sideQuat);
      dummy.scale.set(ls, ls, ls);
      dummy.updateMatrix();
      butiaLeaflets.setMatrixAt(leafletIdx, dummy.matrix);
      frondSway.push({ index: leafletIdx, x: lx, y: ly, z: lz, ls, baseQuat: sideQuat, tt, phase });
      leafletIdx++;

      // segmento del raquis: apunta al siguiente punto del arco, de modo
      // que la fronda se lee como una hoja entera y no como folíolos sueltos
      rachisPoint(Math.min(1, tt + 1 / LEAFLET_STEPS), rachisNext);
      rachisDir.subVectors(rachisNext, rachisHere).normalize();
      const rachisQuat = new THREE.Quaternion().setFromUnitVectors(LEAFLET_UP, rachisDir);
      const rs = (0.42 - tt * 0.1) * scale;

      dummy.position.set(lx, ly, lz);
      dummy.quaternion.copy(rachisQuat);
      dummy.scale.set(rs * 0.6, rs * 1.5, rs * 0.6);
      dummy.updateMatrix();
      butiaLeaflets.setMatrixAt(leafletIdx, dummy.matrix);
      frondSway.push({
        index: leafletIdx,
        x: lx,
        y: ly,
        z: lz,
        ls: rs,
        scaleX: rs * 0.6,
        scaleY: rs * 1.5,
        baseQuat: rachisQuat,
        tt,
        phase,
      });
      leafletIdx++;
    }
  }

  // racimo de frutos: el butiá que le da nombre al árbol y a los palmares
  const bunch = new THREE.Group();
  for (let b = 0; b < 16; b++) {
    const fruit = new THREE.Mesh(new THREE.SphereGeometry(0.045 * scale, 6, 5), butiaFruitMat);
    fruit.position.set((rng() - 0.5) * 0.28, -rng() * 0.32, (rng() - 0.5) * 0.28);
    bunch.add(fruit);
  }
  bunch.position.set(x + 0.2 * scale, crownY - 0.15, z);
  scene.add(bunch);
});
butiaLeaflets.instanceMatrix.needsUpdate = true;
scene.add(butiaLeaflets);

// --- Pintado del suelo: mezcla de cinco materiales -----------------------
// El suelo era una sola textura seca repetida, y eso es lo que lo delataba:
// un campo real no tiene el mismo color a un metro del agua que a quince.
//
// En vez de cargar cinco texturas y mezclarlas en un shader, se pinta el
// COLOR POR VÉRTICE de la malla del suelo. MeshStandardMaterial multiplica
// el color de vértice por el mapa difuso de forma nativa, así que no hace
// falta tocar el shader ni sumar un solo draw call, y la malla ya tiene
// 161×161 vértices — unos 19 cm de resolución, de sobra para gradientes de
// humedad y manchas de hojarasca.
//
// La mezcla se calcula con las MISMAS funciones que reparten la vegetación,
// así que la tierra y lo que crece encima cuentan la misma historia.
{
  const pos = groundGeo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const wetness = new Float32Array(pos.count);
  const c = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    wetness[i] = soilColorAt(x, z, c, pos.getY(i));
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }

  // --- Sombra de contacto al pie de cada planta -------------------------
  // Sin esto, cada objeto se lee "apoyado encima" del suelo. Lo que se pinta
  // NO es un círculo negro: el radio se modula con ruido según el ángulo, y
  // la intensidad cae de forma suave, así que la mancha queda lobulada, como
  // la acumulación real de hojarasca y sombra alrededor de una mata.
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    let darken = 0;
    for (let k = 0; k < contactPoints.length; k++) {
      const cp = contactPoints[k];
      const dx = x - cp[0];
      const dz = z - cp[1];
      const d2 = dx * dx + dz * dz;
      const reach = cp[2] * 2.1;
      if (d2 > reach * reach) continue;
      const d = Math.sqrt(d2);
      const ang = Math.atan2(dz, dx);
      // Radio irregular: el borde de la mancha entra y sale.
      const wobble = 0.72 + fbm(shoreNoise, Math.cos(ang) * 2 + cp[0], Math.sin(ang) * 2 + cp[1], 2) * 0.6;
      const r = cp[2] * wobble * 2.1;
      if (d > r) continue;
      darken = Math.max(darken, (1 - d / r) * (1 - d / r) * 0.24 * cp[3]);
    }
    if (darken <= 0) continue;
    colors[i * 3] *= 1 - darken;
    colors[i * 3 + 1] *= 1 - darken * 0.94;
    colors[i * 3 + 2] *= 1 - darken * 0.88; // se va a pardo, no a gris
  }

  // Suelo mínimo de luz. La suma de barro húmedo + hojarasca + sombra de
  // contacto podía llevar la ribera casi al negro, que es el mismo error
  // que los arbustos: la tierra mojada es OSCURA, no negra, y conserva
  // color. Este tope lo garantiza pase lo que pase con las máscaras.
  const FLOOR = 0.17;
  for (let i = 0; i < pos.count; i++) {
    const lum = colors[i * 3] * 0.299 + colors[i * 3 + 1] * 0.587 + colors[i * 3 + 2] * 0.114;
    if (lum >= FLOOR || lum <= 0) continue;
    const lift = FLOOR / lum;
    colors[i * 3] = Math.min(1, colors[i * 3] * lift);
    colors[i * 3 + 1] = Math.min(1, colors[i * 3 + 1] * lift);
    colors[i * 3 + 2] = Math.min(1, colors[i * 3 + 2] * lift);
  }

  groundGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  groundMat.vertexColors = true;
  // El mapa difuso de Poly Haven ya trae su propio color; se blanquea un
  // poco para que el pintado por vértice mande y no se peleen dos tierras.
  groundMat.color.setHex(0xf0ece4);
  groundMat.needsUpdate = true;

  // --- Roughness variable con la humedad: INTENTADO Y REVERTIDO ---------
  // Lo que distingue barro de tierra seca no es solo el color: el mojado
  // refleja. MeshStandardMaterial no admite roughness por vértice, así que
  // se probó inyectar un atributo y tres líneas de shader con
  // onBeforeCompile, modulando `roughnessFactor` con la humedad.
  //
  // Resultado: toda la ribera se llenó de un moteado de sal y pimienta —
  // el material dejó de sombrear bien. Se revirtió en vez de insistir,
  // porque el encargo pedía exactamente eso ante un sombreado con
  // artefactos, y porque la ganancia era menor que el daño: bajo este HDRI
  // de atardecer, la diferencia especular entre barro y tierra seca apenas
  // se percibe, mientras que el color sí.
  //
  // La humedad, entonces, se lee por COLOR (más oscuro y más saturado hacia
  // el agua), que es como se lee en una foto de campo al atardecer. Queda
  // pendiente para una pasada de shaders propios.
}

  // --- Gradiente de humedad de la orilla --------------------------------
  // Va acá y no junto a la malla de la orilla porque usa la paleta del suelo
  // y `tmpColor`, que se declaran más abajo en el archivo: allá arriba
  // estarían en zona muerta temporal y reventaría al cargar.
  //
  // La orilla era un marrón plano de punta a punta. Ahora lleva color por
  // vértice: barro empapado y oscuro pegado al agua, que se seca y aclara
  // hacia afuera hasta encontrarse con el color del suelo vecino. Es la
  // transición de humedad del brief, resuelta con material y sin agregar un
  // solo objeto.
{
  // Un punto más claro que antes: con Lambert ya no hay especular que lo
  // levante, y el borde pegado al agua quedaba prácticamente negro. El barro
  // empapado es oscuro, pero conserva tono.
  const WET_MUD = new THREE.Color(0x4C3D29);
  const DAMP    = new THREE.Color(0x5A4930);
  const pos = shoreGeo.attributes.position;
  const cols = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const zLocal = pos.getZ(i);
    // `rotateX(-90°)` lleva la Y de la forma 2D a -Z, así que para recuperar
    // el ángulo con el que se construyó el contorno hay que deshacer ese
    // signo además del achatamiento. Sin invertirlo, `waterRadiusAt` recibe
    // el ángulo espejado, devuelve el radio de otro punto de la costa y el
    // gradiente se calcula contra una referencia equivocada — que es por lo
    // que la franja salía uniformemente pálida.
    const zShape = -zLocal / WATER_Z_SQUASH;
    const ang = Math.atan2(zShape, x);
    const rEdge = waterRadiusAt(ang);
    const rOuter = rEdge * shoreWidthAt(ang);
    // 0 justo en el agua, 1 en el borde exterior de la franja.
    const t = clamp01((Math.hypot(x, zShape) - rEdge) / Math.max(0.001, rOuter - rEdge));
    // El secado no es lineal, y la curva tiene que ser MUY lenta: el agujero
    // interior del anillo está a 0.98× del radio del agua, o sea POR DEBAJO
    // de la lámina. Los vértices más oscuros quedan tapados por el agua, así
    // que el tramo que se ve empieza ya avanzado — con una curva cuadrática
    // la franja visible salía casi toda seca y pálida.
    const dryT = t * t * t;
    c.copy(WET_MUD).lerp(DAMP, dryT);
    // El barro seco se acerca al color del suelo que tiene al lado.
    soilColorAt(x + WATER_CENTER[0], zLocal + WATER_CENTER[1], tmpColor);
    c.lerp(tmpColor, dryT * 0.4);
    // Moteado: charcos y zonas pisadas, para que la franja no sea un degradé
    // perfecto de manual.
    const n = fbm(shoreNoise, x * 0.9 + 2200, zLocal * 0.9 + 2200, 2);
    c.multiplyScalar(0.88 + n * 0.26);
    cols[i * 3] = c.r;
    cols[i * 3 + 1] = c.g;
    cols[i * 3 + 2] = c.b;
  }
  shoreGeo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
}


// --- Monte lejano: cierra el horizonte ------------------------------------
// Con el HDRI de cielo puro el horizonte queda vacío, así que la línea de
// árboles la ponemos nosotros — y así es vegetación nativa, no los galpones
// y alambrados que traía el HDRI anterior.
// Se arma en tres capas a distinta distancia, cada una más fría y clara que
// la anterior: es perspectiva atmosférica, y es lo que da sensación de
// profundidad real en un paisaje abierto. Son low-poly a propósito: a más
// de 25m no se distingue el detalle y gastar polígonos ahí sería tirarlos.
const FAR_BANDS = [
  { rMin: 26, rMax: 42, count: 130, color: 0x4c6340, hMin: 2.6, hMax: 5.0 },
  { rMin: 42, rMax: 62, count: 150, color: 0x5d7358, hMin: 3.0, hMax: 5.8 },
  { rMin: 62, rMax: 88, count: 160, color: 0x74878a, hMin: 3.4, hMax: 6.6 },
];

const farTrunkGeo = new THREE.CylinderGeometry(0.1, 0.16, 1, 5);
farTrunkGeo.translate(0, 0.5, 0);

// FASE 4 — horizonte. Antes: 440 icosaedros de 20 caras, facetados, todos
// con la misma forma y un verde plano por banda — una empalizada de
// poliedros. Ahora cada árbol lejano toma una de cuatro siluetas de lóbulos
// lisos (redonda, paraguas, emergente alta, mata baja), tiene su propio tono
// y un reparto de alturas que rompe la línea de copas: algunos emergentes
// aislados, grupos bajos, masas densas y claros.
//
// Presupuesto HORIZON: 80–100 triángulos por árbol (lóbulos de detalle 0,
// soldados y con normales curvadas); solo los emergentes de la banda
// cercana, que recortan contra el cielo, usan detalle 1. Todo el horizonte va
// horneado en UNA malla sin sombra: 1 draw call para las copas y 1 para los
// troncos, contra 6 de antes.
//
// Las posiciones, alturas base y escalas salen del MISMO rng global en el
// mismo orden que antes (la fauna consume ese rng después); la variación
// nueva viene de un generador aislado.
const FAR_VARIANTS = [
  { name: "redonda", lobes: [[0, 0.1, 0, 0.72], [0.5, -0.15, 0.2, 0.55], [-0.45, -0.1, -0.25, 0.58], [0.05, -0.2, -0.55, 0.5]] },
  { name: "paraguas", lobes: [[0, 0.2, 0, 0.6], [0.6, 0.0, 0.1, 0.5], [-0.55, 0.02, -0.1, 0.52], [0.1, -0.05, 0.6, 0.48], [-0.1, 0.05, -0.6, 0.46]] },
  { name: "emergente", lobes: [[0, 0.3, 0, 0.58], [0.22, -0.1, 0.1, 0.55], [-0.2, -0.18, -0.12, 0.5], [0.08, 0.6, -0.05, 0.4]] },
  { name: "mata_baja", lobes: [[0, 0, 0, 0.6], [0.7, -0.1, 0.1, 0.5], [-0.65, -0.08, 0.15, 0.5], [0.2, -0.1, -0.55, 0.45], [-0.3, -0.12, 0.6, 0.42]] },
];
for (const v of FAR_VARIANTS) v.lobes = inflateLobes(v.lobes, 1.18);
const farGeoCache = new Map();
function farGeoFor(variant, detail) {
  const key = `${variant}:${detail}`;
  if (!farGeoCache.has(key)) {
    farGeoCache.set(key, buildLobeMass(FAR_VARIANTS[variant].lobes, detail, 5000 + variant * 29, { amount: 0.3, flatten: 0.5, aoMin: 0.62, fine: 0.16, bend: 0.8, dapple: 0.34 }));
  }
  return farGeoCache.get(key);
}
const farRng = mulberry32(915527);
const pickFarVariant = makeVariantPicker(FAR_VARIANTS.length, 5, farRng);
const farBake = [];
const farTrunkPlacements = [];
const _farM = new THREE.Matrix4();
const _farQ = new THREE.Quaternion();
const _farE = new THREE.Euler();
const _farP = new THREE.Vector3();
const _farS = new THREE.Vector3();

FAR_BANDS.forEach((band, bandIndex) => {
  let placed = 0;
  for (let i = 0; i < band.count * 2 && placed < band.count; i++) {
    const a = rng() * Math.PI * 2;
    // La profundidad también sigue la máscara: donde hay mancha, el monte se
    // mete hacia adentro; donde no, retrocede.
    const depth = fbm(monteNoise, Math.cos(a) * 4 + 700, Math.sin(a) * 4 + 700, 2);
    const r = band.rMin + (0.1 + 0.9 * depth) * (band.rMax - band.rMin);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    // Máscara a lo largo del horizonte: huecos de campo abierto y manchas.
    const horizon = fbm(monteNoise, Math.cos(a) * 6 + 400, Math.sin(a) * 6 + 400, 3);
    if (horizon < 0.47) continue;
    let h = bellRange(rng, band.hMin, band.hMax) * (0.78 + horizon * 0.45);
    const trunkYaw = rng() * Math.PI * 2;
    let spread = h * (0.42 + rng() * 0.22);
    const crownRX = rng() * 0.4;
    const crownRY = rng() * Math.PI * 2;
    const crownRZ = rng() * 0.4;
    const crownSY = 0.6 + rng() * 0.3;
    placed++;

    // Siluetas: en el corazón de la mancha manda la copa redonda y densa; en
    // el borde ralo, el paraguas y la mata baja. El emergente es escaso.
    const edge = clamp01((0.62 - horizon) / 0.15);
    const variant = pickFarVariant(x, z, [1.2 - edge * 0.6, 0.6 + edge * 0.6, 0.22, 0.25 + edge * 0.9]);
    let trunkK = 1;
    if (variant === 2) {
      h *= 1.35 + farRng() * 0.3; // emergente aislado: quiebra la línea de copas
      spread *= 0.8;
    } else if (variant === 3) {
      h *= 0.5 + farRng() * 0.2; // grupo bajo: el horizonte también tiene huecos bajos
      spread *= 1.15;
      trunkK = 0.25;
    } else {
      h *= 0.85 + farRng() * 0.3;
    }
    const crownY = variant === 3 ? h * 0.4 : h * 0.62;
    _farE.set(crownRX, crownRY, crownRZ);
    _farM.compose(_farP.set(x, crownY, z), _farQ.setFromEuler(_farE), _farS.set(spread, spread * crownSY, spread));
    // Tono propio de cada árbol dentro de la paleta de su banda (perspectiva
    // atmosférica intacta): unos más oliva, otros más oscuros o secos.
    jitterColor(tmpColor, band.color, farRng);
    if (farRng() < 0.14) tmpColor.lerp(new THREE.Color(0x8a8a55), 0.25);
    farBake.push({
      geo: farGeoFor(variant, bandIndex === 0 && variant === 2 ? 1 : 0),
      matrix: _farM.clone(),
      color: tmpColor.clone().multiplyScalar(0.72),
      pivot: [x, 0, z],
      phase: farRng() * Math.PI * 2,
      amp: TIER_WIND.HORIZON,
    });
    farTrunkPlacements.push({ x, y: 0, z, yaw: trunkYaw, h: h * 0.55 * trunkK });
    registerTier("horizonte", "HORIZON");
  }
});

// FONDO (BACKGROUND, 18–25 m): entre el último árbol del monte (17,5 m) y la
// primera banda del horizonte (26 m) había una llanura vacía que cortaba la
// continuidad del paisaje. Masas bajas de matorral y algún árbol chico, en
// manchas que siguen la máscara del monte (no uniformes) y dejan claros.
const bgRng = mulberry32(417733);
for (let i = 0; i < 280; i++) {
  const a = bgRng() * Math.PI * 2;
  const r = 18 + bgRng() * 7;
  const x = Math.cos(a) * r;
  const z = Math.sin(a) * r;
  const mask = fbm(monteNoise, x * 0.12 + 150, z * 0.12 + 150, 3);
  const pick = bgRng();
  if (mask < 0.44 || pick > (mask - 0.44) * 3.2) continue; // manchas y claros
  const isTree = bgRng() < 0.3;
  const variant = isTree ? (bgRng() < 0.5 ? 0 : 1) : 3;
  const h = isTree ? 2.4 + bgRng() * 1.4 : 0.9 + bgRng() * 0.9;
  const spread = isTree ? h * (0.38 + bgRng() * 0.12) : h * (0.9 + bgRng() * 0.5);
  const y = Math.abs(x) < 15 && Math.abs(z) < 15 ? groundY(x, z) : 0;
  const crownY = y + (isTree ? h * 0.66 : spread * 0.35);
  _farE.set((bgRng() - 0.5) * 0.3, bgRng() * Math.PI * 2, (bgRng() - 0.5) * 0.3);
  _farM.compose(_farP.set(x, crownY, z), _farQ.setFromEuler(_farE), _farS.set(spread, spread * (0.55 + bgRng() * 0.25), spread));
  jitterColor(tmpColor, isTree ? 0x4b633c : 0x4f6139, bgRng);
  // Detalle 1 solo donde la masa todavía es plano medio (>3,5° en pantalla).
  const bgTier = visualTier(x, z, h);
  farBake.push({
    geo: farGeoFor(variant, TIER_RANK[bgTier] <= TIER_RANK.MIDGROUND_FAR ? 1 : 0),
    matrix: _farM.clone(),
    color: tmpColor.clone().multiplyScalar(0.64),
    pivot: [x, y, z],
    phase: bgRng() * Math.PI * 2,
    amp: TIER_WIND.BACKGROUND,
  });
  if (isTree) farTrunkPlacements.push({ x, y, z, yaw: bgRng() * Math.PI * 2, h: h * 0.62 });
  registerTier("fondo_masas", bgTier);
}

const farCanopyMat = new THREE.MeshStandardMaterial({ roughness: 1.0, metalness: 0.0, vertexColors: true });
windify(farCanopyMat, "pivot", { f1: 0.45, a1: 0.035, f2: 1.1, a2: 0.015, zRatio: 0.8 });
const farCanopies = new THREE.Mesh(bakeInstances(farBake), farCanopyMat);
farCanopies.name = "horizonte_y_fondo";
const farTrunks = new THREE.InstancedMesh(
  farTrunkGeo,
  new THREE.MeshStandardMaterial({ color: 0x584734, roughness: 1.0 }),
  farTrunkPlacements.length
);
farTrunkPlacements.forEach((t, i) => {
  dummy.position.set(t.x, t.y, t.z);
  dummy.rotation.set(0, t.yaw, 0);
  dummy.scale.set(1, Math.max(0.05, t.h), 1);
  dummy.updateMatrix();
  farTrunks.setMatrixAt(i, dummy.matrix);
});
farTrunks.instanceMatrix.needsUpdate = true;
scene.add(farTrunks, farCanopies);

// --- Fauna nativa: carpinchos junto a la laguna + bandada de aves --------
// Sin locomoción por pedido explícito: la fauna es lo que se mueve/anima
// en la escena, no la cámara. Geometría procedimental (mismo criterio que
// árboles/arbustos): nada de modelos externos pesados.

// Carpinchos (Hydrochoerus hydrochaeris): cuerpo achatado, orejas
// pequeñas, patas cortas — habitan justo en el borde de cuerpos de agua
// como esta laguna, así que van ahí.
const capybaraMat = new THREE.MeshStandardMaterial({ color: 0x6b5438, roughness: 0.95, flatShading: true });
const capybaraDarkMat = new THREE.MeshStandardMaterial({ color: 0x4a3a26, roughness: 0.95, flatShading: true });

function makeCapybara() {
  const group = new THREE.Group();

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.5, 6, 12), capybaraMat);
  body.rotation.z = Math.PI / 2;
  body.position.y = 0.24;
  body.castShadow = true;
  group.add(body);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 14, 10), capybaraMat);
  head.position.set(0.42, 0.28, 0);
  head.scale.set(1.15, 0.85, 0.9);
  head.castShadow = true;
  group.add(head);

  // Hocico rectangular achatado: rasgo más distintivo del capibara frente
  // a otro roedor genérico de cuerpo similar.
  const snout = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, 0.13), capybaraMat);
  snout.position.set(0.56, 0.2, 0);
  snout.castShadow = true;
  group.add(snout);

  for (const side of [-1, 1]) {
    const nostril = new THREE.Mesh(new THREE.SphereGeometry(0.012, 6, 6), capybaraDarkMat);
    nostril.position.set(0.61, 0.21, side * 0.035);
    group.add(nostril);
  }

  for (const side of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), capybaraDarkMat);
    ear.position.set(0.46, 0.4, side * 0.09);
    group.add(ear);
  }

  const legGeo = new THREE.CylinderGeometry(0.045, 0.05, 0.22, 8);
  for (const [lx, lz] of [
    [0.18, 0.14],
    [0.18, -0.14],
    [-0.18, 0.14],
    [-0.18, -0.14],
  ]) {
    const leg = new THREE.Mesh(legGeo, capybaraDarkMat);
    leg.position.set(lx, 0.11, lz);
    leg.castShadow = true;
    group.add(leg);
  }

  return group;
}

const CAPYBARA_COUNT = 3;
const capybaras = [];
for (let i = 0; i < CAPYBARA_COUNT; i++) {
  const angle = rng() * Math.PI * 2;
  const [x, z] = waterOutlinePoint(angle, 1.12 + rng() * 0.14); // sobre la orilla de barro
  const capy = makeCapybara();
  capy.position.set(x, 0, z);
  capy.rotation.y = Math.atan2(WATER_CENTER[0] - x, WATER_CENTER[1] - z) + Math.PI / 2; // mirando hacia el agua
  capy.userData.bobOffset = rng() * Math.PI * 2;
  scene.add(capy);
  capybaras.push(capy);
}

// Bandada de aves pequeñas (tipo benteveo/hornero), volando en círculos
// bajos cerca de los árboles.
const birdBodyMat = new THREE.MeshStandardMaterial({ color: 0x4a3626, roughness: 0.8, flatShading: true });
const birdBellyMat = new THREE.MeshStandardMaterial({ color: 0xd9c9a0, roughness: 0.8, flatShading: true });
const birdWingMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1c, roughness: 0.8, side: THREE.DoubleSide, flatShading: true });

function makeBird() {
  const group = new THREE.Group();

  const body = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 9), birdBodyMat);
  body.scale.set(1.6, 1, 1);
  group.add(body);

  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), birdBellyMat);
  belly.position.set(0, -0.015, 0);
  belly.scale.set(1.3, 0.8, 0.8);
  group.add(belly);

  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.012, 0.03, 6), birdBodyMat);
  beak.rotation.z = -Math.PI / 2;
  beak.position.set(0.07, 0, 0);
  group.add(beak);

  // Cola en abanico: rasgo visible en horneros/benteveos posados o en
  // vuelo, y ayuda a leer la silueta del ave a distancia (antes era solo
  // un cuerpo ovalado sin rasgo distintivo detrás).
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.028, 0.06, 4), birdBodyMat);
  tail.rotation.z = Math.PI / 2;
  tail.position.set(-0.075, 0, 0);
  tail.scale.set(1, 0.35, 1.6);
  group.add(tail);

  const wingGeo = new THREE.PlaneGeometry(0.09, 0.04);
  const wingL = new THREE.Mesh(wingGeo, birdWingMat);
  wingL.position.set(0, 0, 0.03);
  const wingR = new THREE.Mesh(wingGeo, birdWingMat);
  wingR.position.set(0, 0, -0.03);
  group.add(wingL, wingR);
  group.userData.wings = [wingL, wingR];

  return group;
}

const BIRD_COUNT = 10;
const birds = [];
for (let i = 0; i < BIRD_COUNT; i++) {
  const bird = makeBird();
  bird.userData.radius = 2 + rng() * 6;
  bird.userData.center = [
    (rng() - 0.5) * 16,
    (rng() - 0.5) * 16,
  ];
  bird.userData.height = 2.2 + rng() * 1.8;
  bird.userData.speed = 0.15 + rng() * 0.15;
  bird.userData.phase = rng() * Math.PI * 2;
  bird.userData.flapSpeed = 8 + rng() * 4;
  scene.add(bird);
  birds.push(bird);
}

// Mariposas (tipo Vanessa carye — "isabelita del campo" — especie nativa
// muy común en la pradera uruguaya), revoloteando cerca de los arbustos con
// flor: dan movimiento a media altura, distinto del vuelo alto en círculo
// de las aves, y refuerzan la idea de polinización sobre la vegetación
// florida ya sembrada.
const butterflyWingMat = new THREE.MeshStandardMaterial({
  color: 0xe8963c,
  roughness: 0.55,
  side: THREE.DoubleSide,
  flatShading: true,
  emissive: 0xe8963c,
  emissiveIntensity: 0.08,
});
const butterflyBodyMat = new THREE.MeshStandardMaterial({ color: 0x2a1f14, roughness: 0.8, flatShading: true });

function makeButterfly() {
  const group = new THREE.Group();

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.006, 0.03, 3, 4), butterflyBodyMat);
  body.rotation.z = Math.PI / 2;
  group.add(body);

  const wingGeo = new THREE.PlaneGeometry(0.06, 0.045);
  const wingL = new THREE.Mesh(wingGeo, butterflyWingMat);
  wingL.position.set(0, 0, 0.006);
  const wingR = new THREE.Mesh(wingGeo, butterflyWingMat);
  wingR.position.set(0, 0, -0.006);
  group.add(wingL, wingR);
  group.userData.wings = [wingL, wingR];

  return group;
}

const BUTTERFLY_COUNT = 16;
const butterflyHomes = scatterPositions(BUTTERFLY_COUNT, 1.8, 9.5, 1.0);
const butterflies = [];
butterflyHomes.forEach(([hx, hz]) => {
  const bfly = makeButterfly();
  Object.assign(bfly.userData, {
    homeX: hx,
    homeZ: hz,
    homeY: 0.35 + rng() * 0.4,
    radius: 0.25 + rng() * 0.45,
    speed: 0.5 + rng() * 0.5,
    phase: rng() * Math.PI * 2,
    vertPhase: rng() * Math.PI * 2,
    flapSpeed: 16 + rng() * 8,
  });
  scene.add(bfly);
  butterflies.push(bfly);
});

// --- Ñandú (Rhea americana) ----------------------------------------------
// El ave emblemática de la pampa y pieza clave de la vida charrúa: se lo
// cazaba con boleadoras, y se aprovechaba carne, plumas, cuero y huevos.
// No vuela, así que camina y pastorea por la pradera abierta — nunca cerca
// del agua como el carpincho. Silueta: cuerpo grande y ovalado, cuello
// largo y flexible, patas altas de tres dedos, plumaje gris pardo.
const rheaBodyMat = new THREE.MeshStandardMaterial({ color: 0x8d8271, roughness: 0.95, flatShading: true });
const rheaDarkMat = new THREE.MeshStandardMaterial({ color: 0x5a5245, roughness: 0.95, flatShading: true });
const rheaLegMat = new THREE.MeshStandardMaterial({ color: 0x6b6355, roughness: 0.9, flatShading: true });

function makeRhea() {
  const group = new THREE.Group();

  // cuerpo voluminoso y redondeado, con plumas colgantes (el ñandú no tiene
  // cola: el plumaje del dorso cae sobre la grupa)
  const body = new THREE.Mesh(makeOrganicGeometry(new THREE.IcosahedronGeometry(0.42, 2), 0.18, 411), rheaBodyMat);
  body.position.set(0, 0.95, 0);
  body.scale.set(1.25, 0.95, 0.95);
  body.castShadow = true;
  group.add(body);

  // el cuello va en su propio sub-grupo para poder animar el pastoreo
  const neckPivot = new THREE.Group();
  neckPivot.position.set(0.34, 1.12, 0);
  group.add(neckPivot);

  const neckGeo = new THREE.CylinderGeometry(0.055, 0.085, 0.72, 7);
  neckGeo.translate(0, 0.36, 0);
  const neck = new THREE.Mesh(neckGeo, rheaBodyMat);
  neck.rotation.z = -0.25;
  neck.castShadow = true;
  neckPivot.add(neck);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.085, 10, 8), rheaBodyMat);
  head.position.set(0.19, 0.71, 0);
  head.scale.set(1.3, 0.9, 0.9);
  neckPivot.add(head);

  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.12, 6), rheaDarkMat);
  beak.rotation.z = -Math.PI / 2;
  beak.position.set(0.31, 0.69, 0);
  neckPivot.add(beak);

  group.userData.neck = neckPivot;

  // patas largas: muslo + caña, bien altas, típicas de ave corredora
  const legs = [];
  for (const side of [-1, 1]) {
    const leg = new THREE.Group();
    const thighGeo = new THREE.CylinderGeometry(0.05, 0.038, 0.45, 6);
    thighGeo.translate(0, -0.225, 0);
    const thigh = new THREE.Mesh(thighGeo, rheaLegMat);
    thigh.castShadow = true;
    leg.add(thigh);

    const shinGeo = new THREE.CylinderGeometry(0.028, 0.024, 0.48, 6);
    shinGeo.translate(0, -0.24, 0);
    const shin = new THREE.Mesh(shinGeo, rheaLegMat);
    shin.position.y = -0.45;
    leg.add(shin);

    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.035, 0.09), rheaDarkMat);
    foot.position.set(0.03, -0.92, 0);
    leg.add(foot);

    leg.position.set(-0.03, 0.78, side * 0.13);
    group.add(leg);
    legs.push(leg);
  }
  group.userData.legs = legs;

  return group;
}

const RHEA_COUNT = 3;
const rheas = [];
// lejos del agua y de los marcadores: pastorean en la llanura abierta
const rheaPositions = scatterPositions(RHEA_COUNT, 6, 12, 3.0);
rheaPositions.forEach(([x, z]) => {
  const rhea = makeRhea();
  rhea.position.set(x, 0, z);
  rhea.rotation.y = rng() * Math.PI * 2;
  rhea.userData.grazePhase = rng() * Math.PI * 2;
  rhea.userData.grazeSpeed = 0.25 + rng() * 0.2;
  rhea.userData.stepPhase = rng() * Math.PI * 2;
  scene.add(rhea);
  rheas.push(rhea);
});

// --- Tero (Vanellus chilensis) -------------------------------------------
// El ave más característica del campo uruguayo: anda a pie por el pasto
// corto, blanco y gris con la pechera negra, copete fino en la nuca y patas
// rojas. Su grito de alarma "tero-tero" se sintetiza más abajo, junto al
// resto del ambiente.
const teroBodyMat = new THREE.MeshStandardMaterial({ color: 0x9aa3a8, roughness: 0.9, flatShading: true });
const teroWhiteMat = new THREE.MeshStandardMaterial({ color: 0xe8e6e0, roughness: 0.9, flatShading: true });
const teroBlackMat = new THREE.MeshStandardMaterial({ color: 0x25272a, roughness: 0.85, flatShading: true });
const teroLegMat = new THREE.MeshStandardMaterial({ color: 0xa8342c, roughness: 0.8, flatShading: true });

function makeTero() {
  const group = new THREE.Group();

  const body = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 9), teroBodyMat);
  body.position.y = 0.16;
  body.scale.set(1.5, 1, 1);
  body.castShadow = true;
  group.add(body);

  // pechera negra: el rasgo que lo distingue de cualquier otra ave del campo
  const breast = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), teroBlackMat);
  breast.position.set(0.06, 0.155, 0);
  breast.scale.set(1.1, 1.05, 0.95);
  group.add(breast);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.048, 10, 8), teroWhiteMat);
  head.position.set(0.13, 0.25, 0);
  group.add(head);

  const face = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6), teroBlackMat);
  face.position.set(0.16, 0.235, 0);
  face.scale.set(1.1, 0.9, 0.8);
  group.add(face);

  // copete: penacho fino que le sale de la nuca hacia atrás
  const crest = new THREE.Mesh(new THREE.ConeGeometry(0.008, 0.09, 4), teroBlackMat);
  crest.rotation.z = Math.PI / 2 + 0.35;
  crest.position.set(0.08, 0.28, 0);
  group.add(crest);

  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.011, 0.045, 6), teroBlackMat);
  beak.rotation.z = -Math.PI / 2;
  beak.position.set(0.19, 0.24, 0);
  group.add(beak);

  // cola oscura con banda blanca en la base, como la del tero real
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.038, 0.07, 4), teroBlackMat);
  tail.rotation.z = Math.PI / 2;
  tail.position.set(-0.125, 0.165, 0);
  tail.scale.set(1, 0.35, 1.15);
  group.add(tail);

  const tailBand = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.025, 4), teroWhiteMat);
  tailBand.rotation.z = Math.PI / 2;
  tailBand.position.set(-0.086, 0.166, 0);
  tailBand.scale.set(1, 0.36, 1.15);
  group.add(tailBand);

  for (const side of [-1, 1]) {
    const legGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.14, 5);
    legGeo.translate(0, -0.07, 0);
    const leg = new THREE.Mesh(legGeo, teroLegMat);
    leg.position.set(0, 0.14, side * 0.035);
    group.add(leg);
  }

  return group;
}

const TERO_COUNT = 5;
const teros = [];
const teroPositions = scatterPositions(TERO_COUNT, 3.5, 11, 1.6);
teroPositions.forEach(([x, z]) => {
  const tero = makeTero();
  tero.position.set(x, 0, z);
  tero.rotation.y = rng() * Math.PI * 2;
  tero.userData.peckPhase = rng() * Math.PI * 2;
  tero.userData.peckSpeed = 0.5 + rng() * 0.4;
  scene.add(tero);
  teros.push(tero);
});

// --- Sonido ambiente: viento + cantos de aves + carpincho -----------------
// Sintetizado con Web Audio API (osciladores + ruido filtrado), sin bajar
// clips externos: evita temas de licencia y peso, y se ajusta exacto a la
// fauna representada en la escena. Requiere gesto del usuario (política de
// autoplay del navegador) — se activa con el botón #sound-toggle.
let audioCtx = null;

function makeNoiseBuffer(ctx, seconds) {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function startWind(ctx) {
  const noise = ctx.createBufferSource();
  noise.buffer = makeNoiseBuffer(ctx, 4);
  noise.loop = true;

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 500;

  const gain = ctx.createGain();
  gain.gain.value = 0.05;

  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.07; // ráfagas lentas de viento
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 0.03;
  lfo.connect(lfoGain);
  lfoGain.connect(gain.gain);
  lfo.start();

  noise.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);
  noise.start();
}

function playBirdChirp(ctx) {
  const now = ctx.currentTime;
  const notes = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < notes; i++) {
    const t0 = now + i * 0.09;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    const baseFreq = 2200 + Math.random() * 1400;
    osc.frequency.setValueAtTime(baseFreq, t0);
    osc.frequency.exponentialRampToValueAtTime(baseFreq * (0.6 + Math.random() * 0.5), t0 + 0.07);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.06, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.08);

    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.1);
  }
}

function playCapybaraGrunt(ctx) {
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(110, now);
  osc.frequency.exponentialRampToValueAtTime(70, now + 0.35);

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 300;

  const g = ctx.createGain();
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(0.08, now + 0.05);
  g.gain.exponentialRampToValueAtTime(0.001, now + 0.4);

  osc.connect(filter);
  filter.connect(g);
  g.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.45);
}

// Grito del tero: la alarma más reconocible del campo uruguayo. Son sílabas
// cortas, muy agudas y metálicas, repetidas en ráfaga ("tero-tero-tero"),
// cada una con un golpe de ataque seco y una caída rápida de tono.
function playTeroCall(ctx) {
  const now = ctx.currentTime;
  const syllables = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < syllables; i++) {
    const t0 = now + i * 0.17;

    const osc = ctx.createOscillator();
    osc.type = "sawtooth"; // más armónicos que una sinusoide: suena metálico
    const f0 = 1900 + Math.random() * 300;
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(f0 * 0.62, t0 + 0.11);

    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 2300;
    filter.Q.value = 3.5;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.07, t0 + 0.006); // ataque seco
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.13);

    osc.connect(filter);
    filter.connect(g);
    g.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.15);
  }
}

function scheduleWildlifeSounds(ctx) {
  const tick = () => {
    const r = Math.random();
    if (r < 0.45) playBirdChirp(ctx);
    else if (r < 0.8) playTeroCall(ctx);
    else playCapybaraGrunt(ctx);
    setTimeout(tick, 1800 + Math.random() * 3500);
  };
  setTimeout(tick, 1000);
}

// Sonido de agua de la laguna: posicional (PannerNode) en las coordenadas
// reales de WATER_CENTER — se escucha más fuerte cerca del agua y se
// atenúa con la distancia, algo que importa en VR cuando el usuario gira
// la cabeza. Combina un "siseo" de superficie (ruido pasa-banda continuo)
// con chapoteos puntuales aleatorios.
function makeWaterPanner(ctx) {
  const panner = ctx.createPanner();
  panner.panningModel = "HRTF";
  panner.distanceModel = "inverse";
  panner.refDistance = 2;
  panner.maxDistance = 25;
  panner.rolloffFactor = 1.2;
  if (panner.positionX) {
    panner.positionX.value = WATER_CENTER[0];
    panner.positionY.value = 0.2;
    panner.positionZ.value = WATER_CENTER[1];
  } else {
    panner.setPosition(WATER_CENTER[0], 0.2, WATER_CENTER[1]);
  }
  panner.connect(ctx.destination);
  return panner;
}

function startWaterAmbience(ctx, panner) {
  const noise = ctx.createBufferSource();
  noise.buffer = makeNoiseBuffer(ctx, 4);
  noise.loop = true;

  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = 1400;
  filter.Q.value = 0.6;

  const gain = ctx.createGain();
  gain.gain.value = 0.06;

  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.2; // ondulación suave de la superficie
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 0.02;
  lfo.connect(lfoGain);
  lfoGain.connect(gain.gain);
  lfo.start();

  noise.connect(filter);
  filter.connect(gain);
  gain.connect(panner);
  noise.start();
}

function playWaterSplash(ctx, panner) {
  const now = ctx.currentTime;
  const noise = ctx.createBufferSource();
  noise.buffer = makeNoiseBuffer(ctx, 0.3);

  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(2500, now);
  filter.frequency.exponentialRampToValueAtTime(700, now + 0.25);
  filter.Q.value = 1.2;

  const g = ctx.createGain();
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(0.12, now + 0.02);
  g.gain.exponentialRampToValueAtTime(0.001, now + 0.3);

  noise.connect(filter);
  filter.connect(g);
  g.connect(panner);
  noise.start(now);
  noise.stop(now + 0.3);
}

// Los chapoteos combinan sonido Y el anillo visual (spawnSplashRing, ver
// sección del cuerpo de agua) en un único evento — así el agua se ve viva
// aunque el usuario todavía no haya activado el sonido, y cuando lo activa
// el chapoteo que escucha es el mismo que ve.
let waterPanner = null;

function scheduleWaterEvents() {
  const tick = () => {
    spawnSplashRing();
    if (audioCtx && waterPanner) playWaterSplash(audioCtx, waterPanner);
    setTimeout(tick, 4000 + Math.random() * 6000);
  };
  setTimeout(tick, 2500);
}
scheduleWaterEvents();

const soundToggle = document.getElementById("sound-toggle");
if (soundToggle) {
  soundToggle.addEventListener("click", () => {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      startWind(audioCtx);
      scheduleWildlifeSounds(audioCtx);
      waterPanner = makeWaterPanner(audioCtx);
      startWaterAmbience(audioCtx, waterPanner);
    }
    if (audioCtx.state === "suspended") audioCtx.resume();
    soundToggle.textContent = "🔊 Sonido activado";
    soundToggle.disabled = true;
  });
}

// --- Camera rig -------------------------------------------------------
const cameraRig = new THREE.Group();
scene.add(cameraRig);

const camera = new THREE.PerspectiveCamera(
  70,
  window.innerWidth / window.innerHeight,
  0.05,
  1500 // FASE 5: antes 100 m — el "horizonte" era el recorte del plano lejano
);
camera.position.set(0, 1.6, 4);
cameraRig.add(camera);

// --- Cámaras de control de calidad (solo en desarrollo) -----------------
// Puntos de vista fijos para comparar antes/después siempre desde el mismo
// sitio. Sin esto, dos capturas "del mismo lugar" nunca lo son y cualquier
// comparación es una impresión, no una medición.
const QC_CAMERAS = {
  // Nivel del ojo desde el punto de vista real del visor: es la única que
  // representa lo que verá quien use las gafas.
  QC_GROUND: { pos: [0, 1.6, 4], look: [0, 1.4, -6] },
  // Plano medio elevado: sirve para juzgar manchas, claros y densidad.
  QC_MID: { pos: [-6, 3.2, 8], look: [2, 1.0, -2] },
  // Vista alta: el perfil de copas y el reparto general del monte.
  QC_HIGH: { pos: [0, 9, 14], look: [1, 1.0, -2] },
  // Laguna: la transición agua → juncal → humedal → pastizal.
  QC_WATER: { pos: [1.5, 1.5, 6.5], look: [7, 0.3, 4] },
  // Primeros planos de la zona hero. Son coordenadas fijas, no calculadas:
  // una cámara de control tiene que mirar SIEMPRE lo mismo para que el
  // antes/después sea comparable. Si cambia el reparto, se ajustan a mano.
  QC_TREE_CLOSE: { pos: [1.2, 1.5, 3.3], look: [3.7, 1.8, 2.0] },
  QC_BUSH_CLOSE: { pos: [0.3, 1.3, 3.6], look: [-0.5, 0.9, 3.1] },
  QC_REED_BASE: { pos: [1.5, 1.3, 4.3], look: [3.9, 0.6, 1.8] },
  QC_HERO_WATER_EDGE: { pos: [1.2, 1.3, 3.2], look: [3.5, 0.3, 4.0] },
  // Desde el punto de vista real del visor, hacia el árbol hero más cercano.
  QC_HERO_TREE_FOREGROUND: { pos: [0, 1.6, 4], look: [0.9, 2.0, 6.0] },
  QC_ROOT_CLOSE: { pos: [0.9, 1.9, 4.9], look: [0.9, 0.0, 6.0] },
  QC_MUD_TRANSITION: { pos: [2.0, 0.5, 3.0], look: [3.6, 0.1, 4.1] },
  // FASE 4 — peor caso: elegida midiendo candidatos en v060 (la de más
  // triángulos, ~300k con sombras, 250 draw calls). En el mismo cuadro entran
  // laguna, juncal, monte, arbustos, plano medio, fondo y horizonte.
  QC_WORST_CASE: { pos: [-3, 2.2, 9], look: [4, 0.8, -2] },
  // FASE 5 — lookdev de luz y atmósfera.
  // Modelado de formas: monte, árbol hero y personajes con la luz de tres
  // cuartos, desde el punto de vista real.
  QC_LIGHTING_COMPARISON: { pos: [0, 1.6, 4], look: [-4, 1.6, -3] },
  // Profundidad aérea: el eje más largo de la escena, de primer plano al
  // horizonte.
  QC_ATMOS_DEPTH: { pos: [-1.5, 3.4, 12.5], look: [-2, 1.2, -30] },
  // Relación cielo/horizonte: mitad superior cielo, línea de monte abajo.
  QC_SKY_HORIZON: { pos: [0, 1.6, 4], look: [2, 5, -40] },
};

if (import.meta.env.DEV) {
  window.__cam = camera;
  window.__qc = QC_CAMERAS;
  window.__scene = scene;
  window.__renderer = renderer;
  window.__waterMat = waterMat;
  window.__sun = sun;
  window.__shoreMat = shoreMat;
  // Censo de la escena, para el informe: contar a mano lo que genera un
  // sistema procedural es como se cuelan los errores.
  window.__census = () => {
    const census = { draws: 0, instances: 0, porTipo: {} };
    scene.traverse((o) => {
      if (!o.isMesh) return;
      census.draws++;
      const n = o.isInstancedMesh ? o.count : 1;
      census.instances += n;
      const key = o.isInstancedMesh ? o.geometry.type + ":inst" : o.geometry.type;
      census.porTipo[key] = (census.porTipo[key] || 0) + n;
    });
    return census;
  };
  window.__vegCounts = () => ({
    arboles_monte: treePositions.length,
    arbustos: shrubTotal,
    flores: flowerTotal,
    gramineas: grassPositions.length,
    cobertura_suelo: coverPositions.length,
    juncos: reeds.count,
    humedal_gramineas: sedges.count,
    cortadera_matas: pampasPositions.length,
    ombues: ombuPositions.length,
    ceibos: CEIBO_COUNT,
    sauces: WILLOW_COUNT,
    butias: butiaPositions.length,
    // FASE 4: lo que realmente se dibuja tras el raleo del plano medio.
    gramineas_dibujadas: grassTufts.count,
    hojas_copa_monte_dibujadas: canopyLeaves.count,
    arboles_horizonte_y_fondo: farBake.length,
  });
  // FASE 4: zonificación visual de cada sistema (para MIDGROUND_AUDIT).
  window.__tiers = () => ({
    zonas: tierRegistry,
    copas_monte: treeCanopySway.map((c) => ({ x: +c.x.toFixed(2), z: +c.z.toFixed(2), d: +heroDist(c.x, c.z).toFixed(2), zona: c.tier, variante: CANOPY_VARIANTS[c.variant].name, sombra: c.castsShadow })),
    tris_copa_por_variante_y_zona: Object.fromEntries([...canopyGeoCache].map(([k, g]) => [k, g.index.count / 3])),
    tris_arbusto_por_variante_y_zona: Object.fromEntries([...shrubGeoCache].map(([k, g]) => [k, g.index.count / 3])),
    tris_horizonte_por_variante: Object.fromEntries([...farGeoCache].map(([k, g]) => [k, g.index.count / 3])),
  });

  // FASE 2.5 — auditoría geométrica real: triángulos por tipo de malla,
  // agrupados por geometry.type (no por especie: el sistema es procedural
  // y no nombra sus objetos), con distancia mínima/máxima al punto de vista
  // fijo. `dist` usa HERO_VIEW_POS, la misma referencia que ya decide qué
  // instancias reciben tratamiento hero — así el "cerca" del audit es
  // exactamente el mismo "cerca" que el resto del código ya usa.
  window.__geoAudit = () => {
    const groups = {};
    const _m4 = new THREE.Matrix4();
    const v = new THREE.Vector3();
    const trisOf = (geo) => (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const tris = trisOf(o.geometry);
      const isInst = !!o.isInstancedMesh;
      const n = isInst ? o.count : 1;
      const key = o.geometry.type + (isInst ? ":inst" : "");
      if (!groups[key]) {
        groups[key] = {
          trisPerInstance: Math.round(tris),
          instances: 0,
          totalTris: 0,
          drawCalls: 0,
          minDist: Infinity,
          maxDist: 0,
        };
      }
      const g = groups[key];
      g.drawCalls += 1;
      g.instances += n;
      g.totalTris += tris * n;
      if (isInst) {
        for (let i = 0; i < o.count; i++) {
          o.getMatrixAt(i, _m4);
          v.setFromMatrixPosition(_m4);
          const d = v.distanceTo(HERO_VIEW_POS);
          if (d < g.minDist) g.minDist = d;
          if (d > g.maxDist) g.maxDist = d;
        }
      } else {
        o.updateWorldMatrix(true, false);
        v.setFromMatrixPosition(o.matrixWorld);
        const d = v.distanceTo(HERO_VIEW_POS);
        if (d < g.minDist) g.minDist = d;
        if (d > g.maxDist) g.maxDist = d;
      }
    });
    for (const k in groups) {
      groups[k].minDist = Math.round(groups[k].minDist * 100) / 100;
      groups[k].maxDist = Math.round(groups[k].maxDist * 100) / 100;
    }
    return groups;
  };

  // Triángulos y draw calls REALMENTE enviados a la GPU en el último frame
  // renderizado — a diferencia de __geoAudit (todo lo cargado), esto refleja
  // el culling real: si un InstancedMesh completo cae fuera del frustum no
  // cuenta acá. Es el número que responde "cuánto ve realmente el usuario
  // desde donde está parado", pedido explícitamente para el informe.
  window.__frameStats = () => ({
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    geometries: renderer.info.memory.geometries,
    textures: renderer.info.memory.textures,
  });

  // Posiciones base por especie de árbol: para rankear distancia real al
  // punto de vista fijo sin adivinar por tipo de geometría (varias especies
  // comparten CylinderGeometry/IcosahedronGeometry y serían indistinguibles
  // en __geoAudit).
  window.__treePositions = {
    monte: treePositions,
    ombu: ombuPositions,
    ceibo: ceiboBasePositions,
    sauce: willowBasePositions,
    butia: butiaPositions,
  };
}

// --- Marcadores de puntos de interés (placeholders) -------------------
// Figuras humanas (Vaimaca Perú, Abayubá, Guyunusa) pospuestas — ver README.
// Estos marcadores señalan dónde irán, con un panel de texto flotante.
function makeLabelSprite(text) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgba(15,15,10,0.75)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#f5e6c8";
  ctx.font = "bold 48px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  // FASE 5: sin bruma ni tone mapping — el rótulo es interfaz y tiene que
  // leerse igual con cualquier luz.
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, fog: false, toneMapped: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.6, 0.4, 1);
  return sprite;
}

const POI = [
  { name: "Vaimacá Perú", pos: [-2.5, 0, -3] },
  { name: "Abayubá", pos: [0, 0, -4.5] },
  { name: "Guyunusa", pos: [2.5, 0, -3] },
];

const poiMarkers = [];
for (const { name, pos } of POI) {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.35, 0.45, 32),
    new THREE.MeshBasicMaterial({ color: 0xf5e6c8, side: THREE.DoubleSide, transparent: true, opacity: 0.8 })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(pos[0], 0.02, pos[2]);
  scene.add(ring);

  const label = makeLabelSprite(name);
  label.position.set(pos[0], 1.9, pos[2]);
  scene.add(label);

  poiMarkers.push(ring);
}

// --- Resize -----------------------------------------------------------
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Loop -----------------------------------------------------------------
const listenerForward = new THREE.Vector3();
const listenerUp = new THREE.Vector3();

flushStaticBatches();

// --- FASE 4: medición en el visor (?perf=1) --------------------------------
// En este entorno se renderiza por software y los FPS no significan nada; en
// las gafas sí. Con ?perf=1 en la URL, cada 10 s se registra en la consola
// (chrome://inspect sobre el Quest) y en window.__perfLog: FPS medio, frame
// time medio, p95, p99, máximo, frames que exceden 1,5× el presupuesto
// (stutter), draw calls y triángulos del último frame.
const PERF_ENABLED = new URLSearchParams(location.search).has("perf");
const perfState = { last: 0, windowStart: 0, samples: [] };
function perfTick(time) {
  if (!PERF_ENABLED) return;
  if (perfState.last) perfState.samples.push(time - perfState.last);
  perfState.last = time;
  if (!perfState.windowStart) perfState.windowStart = time;
  if (time - perfState.windowStart < 10000 || perfState.samples.length < 30) return;
  const a = [...perfState.samples].sort((x, y) => x - y);
  const mean = a.reduce((acc, v) => acc + v, 0) / a.length;
  const q = (f) => a[Math.min(a.length - 1, Math.floor(f * a.length))];
  const hz = renderer.xr.getSession?.()?.frameRate || 72;
  const budget = 1000 / hz;
  const report = {
    enXR: renderer.xr.isPresenting,
    hz,
    fps: +(1000 / mean).toFixed(1),
    frameMs: +mean.toFixed(2),
    p95: +q(0.95).toFixed(2),
    p99: +q(0.99).toFixed(2),
    max: +a[a.length - 1].toFixed(2),
    stutters: a.filter((v) => v > budget * 1.5).length,
    frames: a.length,
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
  };
  console.log("[perf]", JSON.stringify(report));
  (window.__perfLog ??= []).push(report);
  perfState.samples.length = 0;
  perfState.windowStart = time;
}

// FASE 4 (estabilidad al girar la cabeza): three compila cada shader la
// primera vez que su material entra en cuadro, y eso congela ese frame
// (medido: 30–80 ms al girar hacia 15° y 195°, ya en v060). En VR es un tirón
// visible la primera vez que se mira hacia ahí. Se compilan todos al inicio.
renderer.compile(scene, camera);

renderer.setAnimationLoop((time) => {
  currentTime = time;
  perfTick(time);

  for (const ring of poiMarkers) {
    ring.material.opacity = 0.5 + 0.3 * Math.sin(time * 0.002 + ring.position.x);
  }
  // Movimiento muy lento y cruzado: las dos capas de onda se desplazan en
  // direcciones distintas, así que el patrón nunca se repite a ojo. Una
  // sola capa, por lento que vaya, se lee como una textura que resbala.
  waterNormalTex.offset.x = time * 0.0000125;
  waterNormalTex.offset.y = time * 0.0000075;
  waterNormalTex2.offset.x = -time * 0.0000068;
  waterNormalTex2.offset.y = time * 0.0000104;

  // Anillos de chapoteo: se expanden y desvanecen, se descartan al terminar.
  for (let i = activeSplashes.length - 1; i >= 0; i--) {
    const sp = activeSplashes[i];
    const elapsed = currentTime - sp.start;
    const p = Math.min(elapsed / sp.duration, 1);
    if (p >= 1) {
      scene.remove(sp.mesh);
      sp.mesh.material.dispose();
      activeSplashes.splice(i, 1);
      continue;
    }
    const scale = 1 + p * 6;
    sp.mesh.scale.set(scale, 1, scale);
    sp.mesh.material.opacity = 0.55 * (1 - p);
  }

  // Listener de audio sigue a la cámara: el paneo espacial del agua
  // reacciona a hacia dónde mira el usuario (clave en VR).
  if (audioCtx) {
    const listener = audioCtx.listener;
    const camPos = camera.getWorldPosition(new THREE.Vector3());
    camera.getWorldDirection(listenerForward);
    listenerUp.set(0, 1, 0).applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion()));
    if (listener.positionX) {
      listener.positionX.value = camPos.x;
      listener.positionY.value = camPos.y;
      listener.positionZ.value = camPos.z;
      listener.forwardX.value = listenerForward.x;
      listener.forwardY.value = listenerForward.y;
      listener.forwardZ.value = listenerForward.z;
      listener.upX.value = listenerUp.x;
      listener.upY.value = listenerUp.y;
      listener.upZ.value = listenerUp.z;
    } else {
      listener.setPosition(camPos.x, camPos.y, camPos.z);
      listener.setOrientation(listenerForward.x, listenerForward.y, listenerForward.z, listenerUp.x, listenerUp.y, listenerUp.z);
    }
  }

  const t = time * 0.001;
  for (const bird of birds) {
    const { radius, center, height, speed, phase, flapSpeed } = bird.userData;
    const angle = t * speed + phase;
    bird.position.set(
      center[0] + Math.cos(angle) * radius,
      height + Math.sin(t * 0.6 + phase) * 0.2,
      center[1] + Math.sin(angle) * radius
    );
    bird.rotation.y = -angle + Math.PI / 2; // mirando en la dirección de vuelo
    const flap = Math.sin(t * flapSpeed + phase) * 0.6;
    for (const wing of bird.userData.wings) wing.rotation.x = flap;
  }

  for (const capy of capybaras) {
    capy.position.y = 0.01 + 0.01 * Math.sin(t * 0.8 + capy.userData.bobOffset);
  }

  // Ñandú pastoreando: baja el cuello al pasto, lo sube a vigilar. El ciclo
  // pasa más tiempo abajo que arriba, como el animal real.
  for (const rhea of rheas) {
    const { neck, grazePhase, grazeSpeed, stepPhase } = rhea.userData;
    const cycle = Math.sin(t * grazeSpeed + grazePhase);
    neck.rotation.z = 0.75 + 0.75 * Math.max(0, cycle); // 0 = erguido, ~1.5 rad = cabeza al suelo
    rhea.position.y = 0.012 * Math.sin(t * 1.4 + stepPhase);
    // peso que cambia de pata, sutil
    rhea.rotation.z = 0.02 * Math.sin(t * 0.9 + stepPhase);
  }

  // Tero picoteando el pasto corto, con pausas de alerta
  for (const tero of teros) {
    const { peckPhase, peckSpeed } = tero.userData;
    const c = Math.sin(t * peckSpeed + peckPhase);
    tero.rotation.z = Math.max(0, c - 0.45) * 0.9; // solo picotea en el pico del ciclo
  }

  for (const bfly of butterflies) {
    const { homeX, homeZ, homeY, radius, speed, phase, vertPhase, flapSpeed } = bfly.userData;
    const angle = t * speed + phase;
    bfly.position.set(
      homeX + Math.cos(angle) * radius,
      homeY + Math.sin(t * 1.4 + vertPhase) * 0.12,
      homeZ + Math.sin(angle * 1.6) * radius
    );
    bfly.rotation.y = -angle + Math.PI / 2;
    const flap = Math.sin(t * flapSpeed + phase) * 1.1;
    for (const wing of bfly.userData.wings) wing.rotation.x = flap;
  }

  // Balanceo por viento: pasto (más marcado), arbustos (sutil) y copas de
  // los árboles (más lento y leve) — recompone la matriz de cada instancia
  // sumando una oscilación a su rotación base. Barato: ~565 instancias en
  // total, nada comparado con el trabajo de sombreado/raster por frame.
  // FASE 4: pasto, cuerpos de arbusto, copas del monte y sus hojas se mecen
  // en el vertex shader (windify); acá solo avanza el reloj del viento.
  windUniforms.uWindTime.value = t;
  if (LOOK_MODE === "PRESENTATION") cloudTex.offset.x = t * 0.0006; // FASE 5: nubes que derivan

  // Las hojas individuales tienen su propio balanceo (más rápido y liviano
  // que el del cuerpo del arbusto) — no siguen exactamente la rotación del
  // "blob" padre, pero comparten la misma cadencia de viento así que la
  // sensación de conjunto es coherente.
  for (const lf of leafSway) {
    const sway = Math.sin(t * 1.3 + lf.phase) * 0.09 + Math.sin(t * 2.4 + lf.phase * 1.6) * 0.04;
    dummy.position.set(lf.x, lf.y, lf.z);
    dummy.rotation.set(lf.rotX + sway, lf.rotY, lf.rotZ + sway * 0.6);
    dummy.scale.set(lf.s, lf.s, lf.s);
    dummy.updateMatrix();
    lf.mesh.setMatrixAt(lf.index, dummy.matrix);
  }
  for (const mesh of leafMeshes) mesh.instanceMatrix.needsUpdate = true;

  // Juncos/totoras: altos y flexibles, se mueven más que el pasto.
  for (const rd of reedSway) {
    const sway = Math.sin(t * 1.0 + rd.phase) * 0.2 + Math.sin(t * 2.2 + rd.phase * 1.5) * 0.07;
    dummy.position.set(rd.x, rd.y, rd.z);
    dummy.rotation.set(rd.baseRotX + sway, rd.rotY, rd.baseRotZ + sway * 0.7);
    dummy.scale.set(1, rd.s, 1);
    dummy.updateMatrix();
    reeds.setMatrixAt(rd.index, dummy.matrix);
  }
  reeds.instanceMatrix.needsUpdate = true;

  // Ramas colgantes del sauce: lo que más se mueve de toda la escena, y
  // como el pivote está arriba, la punta describe el arco más amplio.
  for (const wp of whipSway) {
    const sway = Math.sin(t * 0.8 + wp.phase) * 0.26 + Math.sin(t * 1.9 + wp.phase * 1.4) * 0.1;
    dummy.position.set(wp.x, wp.y, wp.z);
    dummy.rotation.set(wp.baseRotX + sway, wp.rotY, wp.baseRotZ + sway * 0.8);
    dummy.scale.set(1, wp.len, 1);
    dummy.updateMatrix();
    willowWhips.setMatrixAt(wp.index, dummy.matrix);
  }
  willowWhips.instanceMatrix.needsUpdate = true;

  // Cortadera: las hojas se arquean y las varas con penacho cabecean. Es lo
  // que da la lectura de "campo con viento" a media distancia.
  for (const bl of bladeSway) {
    const sway = Math.sin(t * 1.15 + bl.phase) * 0.17 + Math.sin(t * 2.5 + bl.phase * 1.6) * 0.06;
    dummy.position.set(bl.x, bl.y, bl.z);
    dummy.rotation.set(bl.baseRotX + sway, bl.rotY, bl.baseRotZ + sway * 0.7);
    dummy.scale.set(bl.bw, bl.len, bl.bw);
    dummy.updateMatrix();
    pampasBlades.setMatrixAt(bl.index, dummy.matrix);
  }
  pampasBlades.instanceMatrix.needsUpdate = true;

  for (const hf of heroFillerSway) {
    const sway = Math.sin(t * 1.3 + hf.phase) * 0.13 + Math.sin(t * 2.7 + hf.phase * 1.6) * 0.05;
    dummy.position.set(hf.x, hf.y, hf.z);
    dummy.rotation.set(hf.baseRotX + sway, hf.rotY, hf.baseRotZ + sway * 0.7);
    dummy.scale.set(1, hf.len, 1);
    dummy.updateMatrix();
    heroFillerBlades.setMatrixAt(hf.index, dummy.matrix);
  }
  heroFillerBlades.instanceMatrix.needsUpdate = true;

  for (const pl of plumeSway) {
    const sway = Math.sin(t * 0.95 + pl.phase) * 0.12 + Math.sin(t * 2.1 + pl.phase * 1.3) * 0.045;
    const rotX = pl.baseRotX + sway;
    const rotZ = pl.baseRotZ + sway * 0.7;

    dummy.position.set(pl.stalkX, 0, pl.stalkZ);
    dummy.rotation.set(rotX, 0, rotZ);
    dummy.scale.set(1, pl.stalkLen, 1);
    dummy.updateMatrix();
    pampasStalks.setMatrixAt(pl.index, dummy.matrix);

    // el penacho viaja con la punta de la vara, no se queda flotando
    dummy.position.set(
      pl.stalkX - Math.sin(rotZ) * pl.stalkLen,
      pl.stalkLen * Math.cos(rotX) + 0.22,
      pl.stalkZ + Math.sin(rotX) * pl.stalkLen
    );
    dummy.rotation.set(rotX, pl.rotY, rotZ);
    dummy.scale.set(pl.ps, pl.ps, pl.ps);
    dummy.updateMatrix();
    pampasPlumes.setMatrixAt(pl.index, dummy.matrix);
  }
  pampasStalks.instanceMatrix.needsUpdate = true;
  pampasPlumes.instanceMatrix.needsUpdate = true;

  // Penachos hero: mismo cálculo que el loop de arriba, sobre su propia
  // InstancedMesh -- misma fórmula de viento, sin desincronizarse.
  for (const hp of heroPlumeSway) {
    const sway = Math.sin(t * 0.95 + hp.phase) * 0.12 + Math.sin(t * 2.1 + hp.phase * 1.3) * 0.045;
    const rotX = hp.baseRotX + sway;
    const rotZ = hp.baseRotZ + sway * 0.7;
    dummy.position.set(
      hp.stalkX - Math.sin(rotZ) * hp.stalkLen,
      hp.stalkLen * Math.cos(rotX) + 0.22,
      hp.stalkZ + Math.sin(rotX) * hp.stalkLen
    );
    dummy.rotation.set(rotX, hp.rotY, rotZ);
    dummy.scale.set(hp.ps, hp.ps, hp.ps);
    dummy.updateMatrix();
    heroPlumes.setMatrixAt(hp.index, dummy.matrix);
  }
  heroPlumes.instanceMatrix.needsUpdate = true;

  // Flores del ceibo: cuelgan, así que oscilan como péndulos cortos.
  for (const cf of ceiboFlowerSway) {
    const sway = Math.sin(t * 1.2 + cf.phase) * 0.13 + Math.sin(t * 2.3 + cf.phase * 1.5) * 0.05;
    dummy.position.set(cf.x, cf.y, cf.z);
    dummy.rotation.set(cf.baseRotX + sway, cf.rotY, cf.baseRotZ + sway * 0.7);
    dummy.scale.set(cf.fs, cf.fs, cf.fs);
    dummy.updateMatrix();
    ceiboFlowers.setMatrixAt(cf.index, dummy.matrix);
  }
  ceiboFlowers.instanceMatrix.needsUpdate = true;

  // Frondas del butiá: la punta de la hoja se mueve mucho más que la base,
  // por eso la amplitud escala con la posición a lo largo del raquis (tt).
  for (const fr of frondSway) {
    const amp = 0.05 + fr.tt * 0.16;
    const sway = Math.sin(t * 0.9 + fr.phase) * amp + Math.sin(t * 1.8 + fr.phase * 1.4) * amp * 0.35;
    // el balanceo se compone sobre la orientación base en vez de
    // reemplazarla, para no perder la caída de la fronda
    swayAxis.set(Math.cos(fr.phase), 0.25, Math.sin(fr.phase)).normalize();
    swayQuat.setFromAxisAngle(swayAxis, sway);
    composedQuat.multiplyQuaternions(swayQuat, fr.baseQuat);
    dummy.position.set(fr.x, fr.y, fr.z);
    dummy.quaternion.copy(composedQuat);
    // los segmentos de raquis llevan escala no uniforme (finos y largos)
    if (fr.scaleX !== undefined) dummy.scale.set(fr.scaleX, fr.scaleY, fr.scaleX);
    else dummy.scale.set(fr.ls, fr.ls, fr.ls);
    dummy.updateMatrix();
    butiaLeaflets.setMatrixAt(fr.index, dummy.matrix);
  }
  butiaLeaflets.instanceMatrix.needsUpdate = true;

  // Mismo balanceo para las hojas de ombú, ceibo y sauce. Si quedaran
  // quietas mientras el resto del monte se mueve, la inmovilidad se notaría
  // más que la ausencia de hojas.
  for (const system of extraLeafCards) {
    for (const lf of system.sway) {
      const sway = Math.sin(t * 1.0 + lf.phase) * 0.1 + Math.sin(t * 2.2 + lf.phase * 1.5) * 0.04;
      dummy.position.set(lf.x, lf.y, lf.z);
      dummy.rotation.set(lf.rotX + sway, lf.rotY, lf.rotZ + sway * 0.7);
      dummy.scale.set(lf.ls, lf.ls, lf.ls);
      dummy.updateMatrix();
      system.mesh.setMatrixAt(lf.index, dummy.matrix);
    }
    system.mesh.instanceMatrix.needsUpdate = true;
  }

  renderer.render(scene, camera);
});

// TODO (ver README y skill webxr-dev):
// - Reemplazar los marcadores por figuras 3D animadas (Vaimacá Perú, Abayubá,
//   Guyunusa) cuando se decida el enfoque — ver sección "Personajes" del README.
// - Controllers + locomoción (thumbstick) y teleport
// - Vegetación adicional (pastos altos, árboles nativos: ceibo, espinillo)
