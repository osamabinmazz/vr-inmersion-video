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

function insideWater(x, z) {
  const dx = x - WATER_CENTER[0];
  const dz = (z - WATER_CENTER[1]) / WATER_Z_SQUASH;
  const margin = WATER_RADIUS + 0.6;
  return dx * dx + dz * dz < margin * margin;
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

const waterGeo = new THREE.CircleGeometry(WATER_RADIUS, 64);
waterGeo.rotateX(-Math.PI / 2);
waterGeo.scale(1, 1, WATER_Z_SQUASH);

const waterMat = new THREE.MeshPhysicalMaterial({
  color: 0x1c4450,
  roughness: 0.08,
  metalness: 0.0,
  normalMap: waterNormalTex,
  normalScale: new THREE.Vector2(0.25, 0.25),
  envMapIntensity: 1.2,
});

const water = new THREE.Mesh(waterGeo, waterMat);
water.position.set(WATER_CENTER[0], 0.17, WATER_CENTER[1]); // por encima del displacementScale del suelo (0.15) para que no quede tapada
scene.add(water);

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

const espinilloGreen = new THREE.Color(0x7a8f4a);
const algarroboGreen = new THREE.Color(0x4f6b3a);
const tmpColor = new THREE.Color();

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

  dummy.position.set(x, trunkTopY - 0.08, z);
  dummy.rotation.set(rng() * 0.25, rng() * Math.PI * 2, rng() * 0.25);
  dummy.scale.set(
    treeScale * (1.1 + rng() * 0.6),
    treeScale * (0.6 + rng() * 0.3), // copa achatada, típica del espinillo
    treeScale * (1.1 + rng() * 0.6)
  );
  dummy.updateMatrix();
  canopies.setMatrixAt(i, dummy.matrix);

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

const SHRUB_SPECIES = [
  // Pata de vaca (Bauhinia forficata): flor blanca en forma de mariposa
  { name: "pata de vaca", geo: () => makeOrganicGeometry(new THREE.IcosahedronGeometry(0.34, 3), 0.35, 11), foliage: 0x5a7a4a, flower: 0xfbfaf5, roughness: 0.85, count: 22 },
  // Carqueja (Baccharis trimera): subarbusto rústico, tallos aplanados/angulosos
  { name: "carqueja", geo: () => makeOrganicGeometry(new THREE.IcosahedronGeometry(0.3, 3), 0.45, 23), foliage: 0x8a9a5a, flower: 0xd9d18a, roughness: 0.95, count: 24 },
  // Malva sonrojada (Calyculogygas uruguayensis): flores rojas vistosas, especie prioritaria
  { name: "malva sonrojada", geo: () => makeOrganicGeometry(new THREE.IcosahedronGeometry(0.3, 3), 0.3, 37), foliage: 0x6a8a4a, flower: 0xe0354f, roughness: 0.9, count: 20 },
  // Chilca (Baccharis salicifolia): monte ribereño, atrae polinizadores
  { name: "chilca", geo: () => makeOrganicGeometry(new THREE.IcosahedronGeometry(0.36, 3), 0.32, 53), foliage: 0x4f6b3a, flower: 0xf0ece0, roughness: 0.9, count: 24 },
  // Espina amarilla (Berberis laurina): follaje brillante, flor amarilla llamativa
  { name: "espina amarilla", geo: () => makeOrganicGeometry(new THREE.IcosahedronGeometry(0.3, 3), 0.4, 71), foliage: 0x3f6b3f, flower: 0xffd400, roughness: 0.35, count: 20 },
];

const flowerGeo = new THREE.IcosahedronGeometry(0.045, 0);
const FLOWERS_PER_SHRUB = 3;

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

  const flowerMat = new THREE.MeshStandardMaterial({
    color: species.flower,
    roughness: 0.5,
    emissive: species.flower,
    emissiveIntensity: 0.15,
    flatShading: true,
  });
  const flowers = new THREE.InstancedMesh(flowerGeo, flowerMat, positions.length * FLOWERS_PER_SHRUB);

  let flowerIdx = 0;
  positions.forEach(([x, z], i) => {
    const s = 0.6 + rng() * 0.6;
    const h = s * 0.35;
    dummy.position.set(x, h, z);
    dummy.rotation.set(rng() * Math.PI, rng() * Math.PI, rng() * Math.PI);
    dummy.scale.set(s, s * (0.8 + rng() * 0.4), s);
    dummy.updateMatrix();
    body.setMatrixAt(i, dummy.matrix);

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
  });
  body.instanceMatrix.needsUpdate = true;
  flowers.instanceMatrix.needsUpdate = true;
  scene.add(body, flowers);
}

// Pastos altos: mechones dispersos en primer plano
const GRASS_COUNT = 400;
const grassPositions = scatterPositions(GRASS_COUNT, 1.2, 14, 0.6);
const grassGeo = new THREE.ConeGeometry(0.025, 0.5, 3);
grassGeo.translate(0, 0.25, 0);
const grassMat = new THREE.MeshStandardMaterial({ color: 0x9a9a52, roughness: 1.0, flatShading: true });
const grassTufts = new THREE.InstancedMesh(grassGeo, grassMat, grassPositions.length);

grassPositions.forEach(([x, z], i) => {
  const s = 0.6 + rng() * 0.8;
  dummy.position.set(x, 0, z);
  dummy.rotation.set((rng() - 0.5) * 0.3, rng() * Math.PI * 2, (rng() - 0.5) * 0.3);
  dummy.scale.set(1, s, 1);
  dummy.updateMatrix();
  grassTufts.setMatrixAt(i, dummy.matrix);
});
grassTufts.instanceMatrix.needsUpdate = true;
scene.add(grassTufts);

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

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.5, 4, 8), capybaraMat);
  body.rotation.z = Math.PI / 2;
  body.position.y = 0.24;
  body.castShadow = true;
  group.add(body);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), capybaraMat);
  head.position.set(0.42, 0.28, 0);
  head.scale.set(1.15, 0.85, 0.9);
  head.castShadow = true;
  group.add(head);

  for (const side of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 4), capybaraDarkMat);
    ear.position.set(0.46, 0.4, side * 0.09);
    group.add(ear);
  }

  const legGeo = new THREE.CylinderGeometry(0.045, 0.05, 0.22, 6);
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
  const r = WATER_RADIUS + 0.3 + rng() * 0.8; // justo en el borde de la laguna
  const x = WATER_CENTER[0] + Math.cos(angle) * r;
  const z = WATER_CENTER[1] + Math.sin(angle) * r * WATER_Z_SQUASH;
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

  const body = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 5), birdBodyMat);
  body.scale.set(1.6, 1, 1);
  group.add(body);

  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.03, 6, 5), birdBellyMat);
  belly.position.set(0, -0.015, 0);
  belly.scale.set(1.3, 0.8, 0.8);
  group.add(belly);

  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.012, 0.03, 5), birdBodyMat);
  beak.rotation.z = -Math.PI / 2;
  beak.position.set(0.07, 0, 0);
  group.add(beak);

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

function scheduleWaterSplashes(ctx, panner) {
  const tick = () => {
    playWaterSplash(ctx, panner);
    setTimeout(tick, 4000 + Math.random() * 6000);
  };
  setTimeout(tick, 2500);
}

const soundToggle = document.getElementById("sound-toggle");
if (soundToggle) {
  soundToggle.addEventListener("click", () => {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      startWind(audioCtx);
      scheduleWildlifeSounds(audioCtx);
      const waterPanner = makeWaterPanner(audioCtx);
      startWaterAmbience(audioCtx, waterPanner);
      scheduleWaterSplashes(audioCtx, waterPanner);
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
  for (const ring of poiMarkers) {
    ring.material.opacity = 0.5 + 0.3 * Math.sin(time * 0.002 + ring.position.x);
  }
  waterNormalTex.offset.x = time * 0.00002;
  waterNormalTex.offset.y = time * 0.000012;

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

  renderer.render(scene, camera);
});

// TODO (ver README y skill webxr-dev):
// - Reemplazar los marcadores por figuras 3D animadas (Vaimacá Perú, Abayubá,
//   Guyunusa) cuando se decida el enfoque — ver sección "Personajes" del README.
// - Controllers + locomoción (thumbstick) y teleport
// - Vegetación adicional (pastos altos, árboles nativos: ceibo, espinillo)
