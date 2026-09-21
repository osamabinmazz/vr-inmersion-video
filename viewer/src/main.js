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
