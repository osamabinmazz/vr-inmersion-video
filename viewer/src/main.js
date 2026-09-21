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

// Fix de nitidez en VR (ver skill webxr-dev): el framebuffer por defecto
// suele renderizar por debajo de la resolución nativa del headset.
renderer.xr.addEventListener("sessionstart", () => {
  renderer.xr.setFramebufferScaleFactor(2.0);
});

const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();

// --- Scene ------------------------------------------------------------
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x0b1530, 0.015);

// --- HDRI: iluminación por imagen (IBL) + fondo -----------------------
// royal_esplanade_4k.hdr — CC0, Poly Haven (polyhaven.com/a/royal_esplanade)
const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();
new RGBELoader().load("/assets/hdri/royal_esplanade_4k.hdr", (hdrTexture) => {
  const envMap = pmrem.fromEquirectangular(hdrTexture).texture;
  scene.background = envMap;
  scene.environment = envMap;
  hdrTexture.dispose();
  pmrem.dispose();
});

const directional = new THREE.DirectionalLight(0xffffff, 1.5);
directional.position.set(4, 6, 3);
directional.castShadow = true;
directional.shadow.mapSize.set(2048, 2048);
directional.shadow.camera.left = -8;
directional.shadow.camera.right = 8;
directional.shadow.camera.top = 8;
directional.shadow.camera.bottom = -8;
scene.add(directional);

// --- Suelo PBR 4K con desplazamiento geométrico real ----------------------
// cobblestone_floor_04 — CC0, Poly Haven (polyhaven.com/a/cobblestone_floor_04)
const texLoader = new THREE.TextureLoader();
const REPEAT = 4;

function loadTiled(path, colorSpace) {
  const t = texLoader.load(path);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(REPEAT, REPEAT);
  t.anisotropy = maxAnisotropy;
  if (colorSpace) t.colorSpace = colorSpace;
  return t;
}

const groundDiff = loadTiled("/assets/textures/cobblestone_floor_04/diff_4k.jpg", THREE.SRGBColorSpace);
const groundNormal = loadTiled("/assets/textures/cobblestone_floor_04/nor_gl_4k.jpg");
// ARM: R=AO, G=Roughness, B=Metalness (empaquetado estilo glTF)
const groundArm = loadTiled("/assets/textures/cobblestone_floor_04/arm_4k.jpg");
const groundDisp = loadTiled("/assets/textures/cobblestone_floor_04/disp_4k.jpg");

// Suficientes segmentos para que el displacement genere relieve real, sin
// reventar el framerate en VR (72-120fps) — ver skill webxr-dev.
const groundGeo = new THREE.PlaneGeometry(20, 20, 128, 128);
groundGeo.rotateX(-Math.PI / 2);
groundGeo.setAttribute("uv2", groundGeo.attributes.uv); // requerido por aoMap

const groundMat = new THREE.MeshStandardMaterial({
  map: groundDiff,
  normalMap: groundNormal,
  roughnessMap: groundArm,
  metalnessMap: groundArm,
  aoMap: groundArm,
  aoMapIntensity: 1.0,
  displacementMap: groundDisp,
  displacementScale: 0.08,
  metalness: 0.0, // el metalness real lo aporta el canal B del ARM map
});

const ground = new THREE.Mesh(groundGeo, groundMat);
ground.receiveShadow = true;
scene.add(ground);

// --- Camera rig -------------------------------------------------------
// Todo lo movible vive bajo este grupo (ver skill webxr-dev).
const cameraRig = new THREE.Group();
scene.add(cameraRig);

const camera = new THREE.PerspectiveCamera(
  70,
  window.innerWidth / window.innerHeight,
  0.05,
  100
);
camera.position.set(0, 1.6, 3);
cameraRig.add(camera);

// --- Objeto foco: material físico reflectante para lucir el HDRI ----------
const focal = new THREE.Mesh(
  new THREE.IcosahedronGeometry(0.5, 4),
  new THREE.MeshPhysicalMaterial({
    color: 0x22d3ee,
    roughness: 0.15,
    metalness: 0.9,
    clearcoat: 0.5,
  })
);
focal.position.set(0, 1.6, -2);
focal.castShadow = true;
scene.add(focal);

// --- Resize -----------------------------------------------------------
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Loop -----------------------------------------------------------------
renderer.setAnimationLoop(() => {
  focal.rotation.y += 0.005;
  renderer.render(scene, camera);
});

// TODO (ver skill webxr-dev):
// - Controllers + locomoción (thumbstick) y teleport
// - Reemplazar el objeto foco por modelos reales (Blender MCP)
// - Si el hardware VR es limitado, bajar REPEAT/segments del suelo o el
//   framebufferScaleFactor de sesión
