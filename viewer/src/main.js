import * as THREE from "three";
import { VRButton } from "three/examples/jsm/webxr/VRButton.js";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";

// --- Renderer -------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
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
scene.fog = new THREE.FogExp2(0x1a1a0f, 0.008);

// --- HDRI: pradera charrúa al atardecer (IBL) + fondo ----------------------
// grasslands_sunset_4k.hdr — CC0, Poly Haven (polyhaven.com/a/grasslands_sunset)
const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();
new RGBELoader().load("/assets/hdri/grasslands_sunset_4k.hdr", (hdrTexture) => {
  const envMap = pmrem.fromEquirectangular(hdrTexture).texture;
  scene.background = envMap;
  scene.environment = envMap;
  hdrTexture.dispose();
  pmrem.dispose();
});

const sun = new THREE.DirectionalLight(0xffd9a0, 1.8);
sun.position.set(-6, 4, -2); // ángulo bajo, de atardecer
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -10;
sun.shadow.camera.right = 10;
sun.shadow.camera.top = 10;
sun.shadow.camera.bottom = -10;
scene.add(sun);

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
const waterMat = new THREE.MeshPhysicalMaterial({
  color: 0x46422c,
  roughness: 0.55,
  metalness: 0.0,
  normalMap: waterNormalTex,
  normalScale: new THREE.Vector2(0.55, 0.55),
  envMapIntensity: 0.45, // reflejo apenas insinuado: el agua turbia no es espejo
  clearcoat: 0.35,
  clearcoatRoughness: 0.3,
});

const water = new THREE.Mesh(waterGeo, waterMat);
water.position.set(WATER_CENTER[0], 0.17, WATER_CENTER[1]); // por encima del displacementScale del suelo (0.15) para que no quede tapada
scene.add(water);

// Orilla de barro expuesto: banda de tierra sin pasto entre el agua y la
// pradera, como en la referencia (el nivel del agua sube y baja y deja el
// borde pelado). Es un anillo con el mismo contorno irregular.
const shoreShape = makeWaterOutlineShape(1.3);
const shoreHole = new THREE.Path();
for (let i = 0; i <= WATER_SEGMENTS; i++) {
  const a = (i / WATER_SEGMENTS) * Math.PI * 2;
  const r = waterRadiusAt(a) * 0.98; // un poco por dentro del agua: evita z-fighting en el borde
  const x = Math.cos(a) * r;
  const y = Math.sin(a) * r;
  if (i === 0) shoreHole.moveTo(x, y);
  else shoreHole.lineTo(x, y);
}
shoreShape.holes.push(shoreHole);

const shoreGeo = new THREE.ShapeGeometry(shoreShape, 1);
shoreGeo.rotateX(-Math.PI / 2);
shoreGeo.scale(1, 1, WATER_Z_SQUASH);

const shoreMat = new THREE.MeshStandardMaterial({ color: 0x6d5b46, roughness: 1.0 });
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

// Árboles: tronco + copa irregular (silueta tipo espinillo/algarrobo)
const TREE_COUNT = 55;
const treePositions = scatterPositions(TREE_COUNT, 4.5, 17, 1.4);

const trunkGeo = new THREE.CylinderGeometry(0.05, 0.11, 1.6, 6);
trunkGeo.translate(0, 0.8, 0);
const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3b2a, roughness: 0.9, flatShading: true });
const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treePositions.length);
trunks.castShadow = true;

const canopyGeo = new THREE.IcosahedronGeometry(0.55, 1);
const canopyMat = new THREE.MeshStandardMaterial({ roughness: 0.85, flatShading: true });
const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, treePositions.length);
canopies.castShadow = true;
canopies.instanceMatrix.setUsage(THREE.DynamicDrawUsage); // se recompone cada frame (balanceo por viento)

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
  const treeScale = 0.75 + rng() * 0.45; // tronco final: ~1.2 a ~2.3m
  const trunkTopY = 1.6 * treeScale;

  dummy.position.set(x, 0, z);
  dummy.rotation.y = rng() * Math.PI * 2;
  dummy.scale.set(treeScale, treeScale, treeScale);
  dummy.updateMatrix();
  trunks.setMatrixAt(i, dummy.matrix);

  const cy = trunkTopY - 0.08;
  const rotX = rng() * 0.25;
  const rotY = rng() * Math.PI * 2;
  const rotZ = rng() * 0.25;
  const sX = treeScale * (1.1 + rng() * 0.6);
  const sY = treeScale * (0.6 + rng() * 0.3); // copa achatada, típica del espinillo
  const sZ = treeScale * (1.1 + rng() * 0.6);
  dummy.position.set(x, cy, z);
  dummy.rotation.set(rotX, rotY, rotZ);
  dummy.scale.set(sX, sY, sZ);
  dummy.updateMatrix();
  canopies.setMatrixAt(i, dummy.matrix);
  treeCanopySway.push({ x, y: cy, z, rotX, rotY, rotZ, sX, sY, sZ, phase: rng() * Math.PI * 2 });

  tmpColor.lerpColors(espinilloGreen, algarroboGreen, rng());
  canopies.setColorAt(i, tmpColor);
});
trunks.instanceMatrix.needsUpdate = true;
canopies.instanceMatrix.needsUpdate = true;
canopies.instanceColor.needsUpdate = true;
scene.add(trunks, canopies);

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

function makeFoliageMap(baseHex) {
  // OJO: THREE.Color.r/g/b devuelve componentes en espacio LINEAR (con
  // color management, activo por defecto desde r152), no sRGB. Escribirlos
  // directo como bytes en un canvas los oscurece muchísimo (casi negro).
  // Por eso acá se extrae el RGB directo del entero hex, sin pasar por
  // THREE.Color.
  const br = (baseHex >> 16) & 255;
  const bg = (baseHex >> 8) & 255;
  const bb = baseHex & 255;

  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = `rgb(${br},${bg},${bb})`;
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 260; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 3 + Math.random() * 9;
    const shade = 0.55 + Math.random() * 0.75;
    const cr = Math.min(255, Math.round(br * shade));
    const cg = Math.min(255, Math.round(bg * shade));
    const cb = Math.min(255, Math.round(bb * shade));
    ctx.fillStyle = `rgba(${cr},${cg},${cb},0.55)`;
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

// Hojas individuales reconocibles por especie: en vez de que la identidad
// de cada arbusto dependa solo del color, cada una tiene una silueta de
// hoja propia (contorno 2D real, no una malla genérica) instanciada muchas
// veces sobre el volumen de follaje — bilobulada (pata de vaca), lámina
// delgada tipo tallo aplanado (carqueja, casi sin hoja verdadera), redondeada
// palmada (malva sonrojada), lanceolada alargada (chilca, "salicifolia" =
// hoja de sauce) u ovalada con borde aserrado (espina amarilla, follaje
// tipo laurel con espinas).
function makeLeafGeometry(radiusFn, segments, sizeX, sizeY) {
  const shape = new THREE.Shape();
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const r = radiusFn(a);
    const x = Math.cos(a) * r * sizeX;
    const y = Math.sin(a) * r * sizeY;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  const geo = new THREE.ShapeGeometry(shape, 1);
  geo.computeVertexNormals();
  return geo;
}

function bilobedRadius(a) {
  const d = a > Math.PI ? a - Math.PI * 2 : a; // distancia angular al notch en a=0
  const notch = 0.6 * Math.exp(-(d * d) / 0.05);
  return Math.max(0.35, 1 - notch);
}
function ellipseRadius() {
  return 1; // el contorno lo da el aspect ratio sizeX/sizeY, no la función
}
function palmateRadius(a) {
  return 1 + 0.14 * Math.cos(a * 5); // 5 lóbulos suaves, tipo hoja de malva
}
function serratedOvalRadius(a) {
  return 1 + 0.07 * Math.sin(a * 16); // borde con pequeñas espinas/dientes
}

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
    leaf: { radiusFn: bilobedRadius, segments: 24, sizeX: 0.075, sizeY: 0.068, count: 11, uprightBias: 0.3 },
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
    leaf: { radiusFn: ellipseRadius, segments: 16, sizeX: 0.08, sizeY: 0.009, count: 22, uprightBias: 0.85 },
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
    leaf: { radiusFn: palmateRadius, segments: 22, sizeX: 0.068, sizeY: 0.063, count: 10, uprightBias: 0.25 },
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
    leaf: { radiusFn: ellipseRadius, segments: 18, sizeX: 0.1, sizeY: 0.02, count: 13, uprightBias: 0.4 },
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
    leaf: { radiusFn: serratedOvalRadius, segments: 24, sizeX: 0.052, sizeY: 0.03, count: 15, uprightBias: 0.2 },
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

for (const species of SHRUB_SPECIES) {
  const positions = scatterPositions(species.count, 1.8, 9.5, 1.0);

  const bodyMat = new THREE.MeshStandardMaterial({
    color: species.foliage,
    map: makeFoliageMap(species.foliage),
    normalMap: makeFoliageBumpMap(),
    normalScale: new THREE.Vector2(0.7, 0.7),
    roughness: species.roughness ?? 0.9,
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
  const leafGeo = makeLeafGeometry(leafCfg.radiusFn, leafCfg.segments, leafCfg.sizeX, leafCfg.sizeY);
  // Un poco más clara y saturada que el follaje base: así la silueta de
  // hoja individual se lee por contraste contra el "blob" de fondo, en vez
  // de perderse mezclada con la textura moteada de la mesa base.
  const leafBaseColor = new THREE.Color(species.foliage);
  const leafHsl = { h: 0, s: 0, l: 0 };
  leafBaseColor.getHSL(leafHsl);
  leafBaseColor.setHSL(leafHsl.h, Math.min(1, leafHsl.s * 1.25), Math.min(0.85, leafHsl.l * 1.35));
  const leafMat = new THREE.MeshStandardMaterial({
    color: leafBaseColor,
    roughness: (species.roughness ?? 0.9) * 0.7,
    side: THREE.DoubleSide,
  });
  const leaves = new THREE.InstancedMesh(leafGeo, leafMat, positions.length * leafCfg.count);
  leaves.castShadow = true;
  leaves.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  leafMeshes.push(leaves);

  let flowerIdx = 0;
  let leafIdx = 0;
  positions.forEach(([x, z], i) => {
    const s = 0.6 + rng() * 0.6;
    const h = s * 0.35;
    const rotX = rng() * Math.PI;
    const rotY = rng() * Math.PI;
    const rotZ = rng() * Math.PI;
    const sY = s * (0.8 + rng() * 0.4);
    dummy.position.set(x, h, z);
    dummy.rotation.set(rotX, rotY, rotZ);
    dummy.scale.set(s, sY, s);
    dummy.updateMatrix();
    body.setMatrixAt(i, dummy.matrix);
    shrubSway.push({ mesh: body, index: i, x, y: h, z, rotX, rotY, rotZ, s, sY, phase: rng() * Math.PI * 2 });

    for (let f = 0; f < FLOWERS_PER_SHRUB; f++) {
      const ang = rng() * Math.PI * 2;
      const rad = s * (0.25 + rng() * 0.2);
      dummy.position.set(x + Math.cos(ang) * rad, h + s * 0.25 + rng() * 0.15, z + Math.sin(ang) * rad);
      dummy.rotation.set(rng() * Math.PI, rng() * Math.PI, rng() * Math.PI);
      const fs = 0.7 + rng() * 0.6;
      dummy.scale.set(fs, fs, fs);
      dummy.updateMatrix();
      flowers.setMatrixAt(flowerIdx++, dummy.matrix);
    }

    const blobR = s * species.blobRadius;
    for (let l = 0; l < leafCfg.count; l++) {
      const theta = rng() * Math.PI * 2;
      const phi = Math.acos(2 * rng() - 1); // punto uniforme sobre la esfera
      const lx = x + Math.sin(phi) * Math.cos(theta) * blobR * 1.02;
      const lz = z + Math.sin(phi) * Math.sin(theta) * blobR * 1.02;
      const ly = h + Math.cos(phi) * blobR * 0.9 * 1.02;
      const outwardYaw = Math.atan2(lx - x, lz - z);
      const tiltRange = (1 - leafCfg.uprightBias) * 1.4;
      const lRotX = (rng() - 0.5) * tiltRange;
      const lRotY = outwardYaw + (rng() - 0.5) * 0.6;
      const lRotZ = (rng() - 0.5) * tiltRange;
      const ls = 0.75 + rng() * 0.6;
      dummy.position.set(lx, ly, lz);
      dummy.rotation.set(lRotX, lRotY, lRotZ);
      dummy.scale.set(ls, ls, ls);
      dummy.updateMatrix();
      leaves.setMatrixAt(leafIdx, dummy.matrix);
      leafSway.push({ mesh: leaves, index: leafIdx, x: lx, y: ly, z: lz, rotX: lRotX, rotY: lRotY, rotZ: lRotZ, s: ls, phase: rng() * Math.PI * 2 });
      leafIdx++;
    }
  });
  body.instanceMatrix.needsUpdate = true;
  flowers.instanceMatrix.needsUpdate = true;
  leaves.instanceMatrix.needsUpdate = true;
  scene.add(body, flowers, leaves);
}

// Pastos altos: mechones dispersos en primer plano
const GRASS_COUNT = 400;
const grassPositions = scatterPositions(GRASS_COUNT, 1.2, 14, 0.6);
const grassGeo = new THREE.ConeGeometry(0.025, 0.5, 3);
grassGeo.translate(0, 0.25, 0);
const grassMat = new THREE.MeshStandardMaterial({ color: 0x9a9a52, roughness: 1.0, flatShading: true });
const grassTufts = new THREE.InstancedMesh(grassGeo, grassMat, grassPositions.length);
grassTufts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

// El pasto es lo que más se nota balanceándose con el viento (más alto,
// más liviano) — guarda transform base por mechón para el render loop.
const grassSway = [];
grassPositions.forEach(([x, z], i) => {
  const s = 0.6 + rng() * 0.8;
  const baseRotX = (rng() - 0.5) * 0.3;
  const baseRotZ = (rng() - 0.5) * 0.3;
  const rotY = rng() * Math.PI * 2;
  grassSway.push({ x, z, s, baseRotX, baseRotZ, rotY, phase: rng() * Math.PI * 2 });
  dummy.position.set(x, 0, z);
  dummy.rotation.set(baseRotX, rotY, baseRotZ);
  dummy.scale.set(1, s, 1);
  dummy.updateMatrix();
  grassTufts.setMatrixAt(i, dummy.matrix);
});
grassTufts.instanceMatrix.needsUpdate = true;
scene.add(grassTufts);

// --- Vegetación ribereña: totoras/juncos + sauce criollo -----------------
// En una laguna real la orilla no es pasto corto: hay una franja densa de
// totora (Schoenoplectus californicus) y juncos, y sauces criollos
// (Salix humboldtiana — el sauce NATIVO del monte ribereño uruguayo, no el
// sauce llorón asiático) inclinados sobre el agua con las ramas colgando.
const REED_CLUMPS = 30;
const REEDS_PER_CLUMP = 18;
const reedGeo = new THREE.ConeGeometry(0.011, 0.8, 3);
reedGeo.translate(0, 0.4, 0);
const reedMat = new THREE.MeshStandardMaterial({ color: 0x5d7a3e, roughness: 1.0, flatShading: true });
const reeds = new THREE.InstancedMesh(reedGeo, reedMat, REED_CLUMPS * REEDS_PER_CLUMP);
reeds.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
reeds.castShadow = true;

const reedSway = [];
let reedIdx = 0;
for (let c = 0; c < REED_CLUMPS; c++) {
  const clumpAngle = (c / REED_CLUMPS) * Math.PI * 2 + rng() * 0.2;
  // los mechones se plantan pisando el borde del agua, como en la referencia
  const clumpScale = 0.97 + rng() * 0.22;
  const [cx, cz] = waterOutlinePoint(clumpAngle, clumpScale);
  for (let r = 0; r < REEDS_PER_CLUMP; r++) {
    const spread = 0.24;
    const x = cx + (rng() - 0.5) * spread;
    const z = cz + (rng() - 0.5) * spread;
    const s = 0.65 + rng() * 0.7;
    const baseRotX = (rng() - 0.5) * 0.25;
    const baseRotZ = (rng() - 0.5) * 0.25;
    const rotY = rng() * Math.PI * 2;
    dummy.position.set(x, 0.14, z);
    dummy.rotation.set(baseRotX, rotY, baseRotZ);
    dummy.scale.set(1, s, 1);
    dummy.updateMatrix();
    reeds.setMatrixAt(reedIdx, dummy.matrix);
    reedSway.push({ index: reedIdx, x, z, s, baseRotX, baseRotZ, rotY, phase: rng() * Math.PI * 2 });
    reedIdx++;
  }
}
reeds.instanceMatrix.needsUpdate = true;
scene.add(reeds);

// Sauces criollos: tronco inclinado sobre el agua + cortina de ramas
// colgantes. Las ramas son planos finos con el pivote ARRIBA (en el punto
// donde nacen), así el balanceo de viento las mueve desde el anclaje y la
// punta es la que más se desplaza — que es como cuelga un sauce de verdad.
const WILLOW_COUNT = 4;
const WHIPS_PER_WILLOW = 150;
const willowTrunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3d2e, roughness: 0.95, flatShading: true });
const willowCrownMat = new THREE.MeshStandardMaterial({ color: 0x6e8c4e, roughness: 0.9, flatShading: true });
const willowWhipMat = new THREE.MeshStandardMaterial({ color: 0x7d9a5a, roughness: 0.85, flatShading: true });

// Ramitas colgantes finas (conos, no planos anchos): muchas y delgadas
// leen como cortina de sauce; pocas y anchas leían como cintas sueltas.
const whipGeo = new THREE.ConeGeometry(0.018, 1, 3);
whipGeo.translate(0, -0.5, 0); // pivote en el extremo superior, donde nace la rama
const willowWhips = new THREE.InstancedMesh(whipGeo, willowWhipMat, WILLOW_COUNT * WHIPS_PER_WILLOW);
willowWhips.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
willowWhips.castShadow = true;

const whipSway = [];
let whipIdx = 0;
for (let w = 0; w < WILLOW_COUNT; w++) {
  const angle = (w / WILLOW_COUNT) * Math.PI * 2 + 0.6 + rng() * 0.5;
  const [bx, bz] = waterOutlinePoint(angle, 1.45 + rng() * 0.25);

  // se inclina hacia el centro del agua
  const toWaterX = WATER_CENTER[0] - bx;
  const toWaterZ = WATER_CENTER[1] - bz;
  const toWaterLen = Math.hypot(toWaterX, toWaterZ) || 1;
  const dirX = toWaterX / toWaterLen;
  const dirZ = toWaterZ / toWaterLen;

  const height = 3.1 + rng() * 1.1;
  const lean = 0.16 + rng() * 0.1;

  const trunkGeo = new THREE.CylinderGeometry(0.07, 0.15, height, 8);
  trunkGeo.translate(0, height / 2, 0);
  const trunk = new THREE.Mesh(trunkGeo, willowTrunkMat);
  trunk.position.set(bx, 0.1, bz);
  trunk.rotation.x = dirZ * lean;
  trunk.rotation.z = -dirX * lean;
  trunk.castShadow = true;
  scene.add(trunk);

  // copa desplazada por la inclinación del tronco
  const crownX = bx + dirX * height * Math.sin(lean);
  const crownZ = bz + dirZ * height * Math.sin(lean);
  const crownY = 0.1 + height * Math.cos(lean);
  const crownSpread = 1.25 + rng() * 0.7;

  // Masa de follaje en la copa: sin esto el tronco quedaba pelado y las
  // ramas colgantes parecían flotar sueltas en el aire.
  const crown = new THREE.Mesh(makeOrganicGeometry(new THREE.IcosahedronGeometry(1, 2), 0.3, 90 + w), willowCrownMat);
  crown.position.set(crownX, crownY - 0.15, crownZ);
  crown.scale.set(crownSpread * 0.85, crownSpread * 0.5, crownSpread * 0.85);
  crown.castShadow = true;
  scene.add(crown);

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

function scheduleWildlifeSounds(ctx) {
  const tick = () => {
    if (Math.random() < 0.7) playBirdChirp(ctx);
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
  100
);
camera.position.set(0, 1.6, 4);
cameraRig.add(camera);

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
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
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

renderer.setAnimationLoop((time) => {
  currentTime = time;

  for (const ring of poiMarkers) {
    ring.material.opacity = 0.5 + 0.3 * Math.sin(time * 0.002 + ring.position.x);
  }
  waterNormalTex.offset.x = time * 0.00002;
  waterNormalTex.offset.y = time * 0.000012;

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
  for (let i = 0; i < grassSway.length; i++) {
    const g = grassSway[i];
    const sway = Math.sin(t * 1.1 + g.phase) * 0.14 + Math.sin(t * 2.6 + g.phase * 1.7) * 0.05;
    dummy.position.set(g.x, 0, g.z);
    dummy.rotation.set(g.baseRotX + sway, g.rotY, g.baseRotZ + sway * 0.6);
    dummy.scale.set(1, g.s, 1);
    dummy.updateMatrix();
    grassTufts.setMatrixAt(i, dummy.matrix);
  }
  grassTufts.instanceMatrix.needsUpdate = true;

  for (const b of shrubSway) {
    const sway = Math.sin(t * 0.7 + b.phase) * 0.05 + Math.sin(t * 1.6 + b.phase * 1.3) * 0.02;
    dummy.position.set(b.x, b.y, b.z);
    dummy.rotation.set(b.rotX + sway, b.rotY, b.rotZ + sway * 0.7);
    dummy.scale.set(b.s, b.sY, b.s);
    dummy.updateMatrix();
    b.mesh.setMatrixAt(b.index, dummy.matrix);
  }
  for (const mesh of shrubBodyMeshes) mesh.instanceMatrix.needsUpdate = true;

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
    dummy.position.set(rd.x, 0.14, rd.z);
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

  for (let i = 0; i < treeCanopySway.length; i++) {
    const c = treeCanopySway[i];
    const sway = Math.sin(t * 0.5 + c.phase) * 0.035 + Math.sin(t * 1.2 + c.phase * 1.4) * 0.015;
    dummy.position.set(c.x, c.y, c.z);
    dummy.rotation.set(c.rotX + sway, c.rotY, c.rotZ + sway * 0.8);
    dummy.scale.set(c.sX, c.sY, c.sZ);
    dummy.updateMatrix();
    canopies.setMatrixAt(i, dummy.matrix);
  }
  canopies.instanceMatrix.needsUpdate = true;

  renderer.render(scene, camera);
});

// TODO (ver README y skill webxr-dev):
// - Reemplazar los marcadores por figuras 3D animadas (Vaimacá Perú, Abayubá,
//   Guyunusa) cuando se decida el enfoque — ver sección "Personajes" del README.
// - Controllers + locomoción (thumbstick) y teleport
// - Vegetación adicional (pastos altos, árboles nativos: ceibo, espinillo)
