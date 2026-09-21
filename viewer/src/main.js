import * as THREE from "three";
import { VRButton } from "three/examples/jsm/webxr/VRButton.js";

// --- Renderer ---------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
document.getElementById("app").appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

// --- Scene --------------------------------------------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1530);

const ambient = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambient);

const directional = new THREE.DirectionalLight(0xffffff, 1.2);
directional.position.set(3, 5, 2);
scene.add(directional);

// Ground grid, for spatial reference
const grid = new THREE.GridHelper(20, 20, 0x334466, 0x1c2a4a);
scene.add(grid);

// --- Camera rig -----------------------------------------------------------
// Todo lo movible (cámara, controles, futuro teleport target) vive bajo este
// grupo. Ver skill webxr-dev: mover el rig mueve todo junto; la posición del
// headset actualiza el transform *local* de la cámara dentro del rig.
const cameraRig = new THREE.Group();
scene.add(cameraRig);

const camera = new THREE.PerspectiveCamera(
  70,
  window.innerWidth / window.innerHeight,
  0.05,
  100
);
camera.position.set(0, 1.6, 3); // altura de ojos aprox, mirando hacia el objeto
cameraRig.add(camera);

// --- Objeto placeholder (reemplazar por la escena real) -------------------
// Colocado a la altura de los ojos y a pocos metros de distancia — ver skill
// webxr-dev: objetos en el origen quedan "a los pies" del usuario en VR.
const placeholder = new THREE.Mesh(
  new THREE.IcosahedronGeometry(0.5, 1),
  new THREE.MeshStandardMaterial({ color: 0x22d3ee, flatShading: true })
);
placeholder.position.set(0, 1.6, -2);
scene.add(placeholder);

// --- Resize -----------------------------------------------------------
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Loop -----------------------------------------------------------------
renderer.setAnimationLoop(() => {
  placeholder.rotation.y += 0.005;
  renderer.render(scene, camera);
});

// TODO (ver skill webxr-dev):
// - Framebuffer nativo (getNativeFramebufferScaleFactor) para evitar pixelado
// - Controllers + locomoción (thumbstick) y teleport
// - Reemplazar el placeholder por la escena/modelos reales (Blender MCP)
