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
    if (farFromPOI(x, z, minDistFromPOI)) points.push([x, z]);
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

// Arbustos nativos vistosos: 4 "especies" con geometría propia (no el
// mismo sólido escalado) + flores de acento, inspiradas en flora nativa
// uruguaya — chirca, espinillo joven, duraznillo, amancay.
const SHRUB_SPECIES = [
  { name: "chirca", geo: () => new THREE.IcosahedronGeometry(0.32, 1), foliage: 0x5a7a4a, flower: 0xf5f5f0, count: 26 },
  { name: "espinillo joven", geo: () => new THREE.DodecahedronGeometry(0.3, 0), foliage: 0x7a8f4a, flower: 0xf4c430, count: 26 },
  { name: "duraznillo", geo: () => new THREE.OctahedronGeometry(0.36, 1), foliage: 0x4f6b3a, flower: 0xc9a0dc, count: 24 },
  { name: "amancay", geo: () => new THREE.TetrahedronGeometry(0.32, 1), foliage: 0x6a8a5a, flower: 0xff8c42, count: 20 },
];

const flowerGeo = new THREE.IcosahedronGeometry(0.045, 0);
const FLOWERS_PER_SHRUB = 3;

for (const species of SHRUB_SPECIES) {
  const positions = scatterPositions(species.count, 1.8, 9.5, 1.0);

  const bodyMat = new THREE.MeshStandardMaterial({ color: species.foliage, roughness: 0.9, flatShading: true });
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
renderer.setAnimationLoop((time) => {
  for (const ring of poiMarkers) {
    ring.material.opacity = 0.5 + 0.3 * Math.sin(time * 0.002 + ring.position.x);
  }
  renderer.render(scene, camera);
});

// TODO (ver README y skill webxr-dev):
// - Reemplazar los marcadores por figuras 3D animadas (Vaimacá Perú, Abayubá,
//   Guyunusa) cuando se decida el enfoque — ver sección "Personajes" del README.
// - Controllers + locomoción (thumbstick) y teleport
// - Vegetación adicional (pastos altos, árboles nativos: ceibo, espinillo)
