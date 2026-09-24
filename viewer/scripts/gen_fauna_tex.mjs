// Genera texturas de "moteado" de plumaje y pelaje para la fauna (ñandú,
// tero, carpincho), mismo criterio que gen_foliage_tex.mjs para arbustos:
// un patrón orgánico gris neutro (la media cerca del blanco) que se aplica
// como `map` sobre el color propio de cada material — no reemplaza el
// color, solo le da variación de luz/sombra con forma reconocible (barbas
// de pluma, mechones de pelo) en vez de un polígono liso.
// El resultado (fauna_mottle/*.png) SÍ se commitea al repo — no hace falta
// correr este script después de clonar. Requiere Playwright instalado.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '../public/assets/textures/fauna_mottle');
fs.mkdirSync(outDir, { recursive: true });

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 600, height: 600 } });
await p.goto('about:blank');

// Textura de plumaje: barbas de pluma como óvalos alargados suaves, todas
// apuntando en una dirección dominante (como caen las plumas reales), con
// una leve curvatura tipo coma.
async function buildFeather(outFile, seed) {
  const result = await p.evaluate(async (seed) => {
    let s = seed;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgb(214,214,214)';
    ctx.fillRect(0, 0, size, size);
    const baseAngle = -0.35; // dirección dominante de caída de la pluma
    for (let i = 0; i < 90; i++) {
      const x = rnd() * size, y = rnd() * size;
      const len = 30 + rnd() * 46;
      const wid = len * (0.22 + rnd() * 0.08);
      const rot = baseAngle + (rnd() - 0.5) * 0.5;
      const shade = 150 + rnd() * 70; // nunca negro puro: sombra entre barbas, no hueco
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rot);
      ctx.globalAlpha = 0.35 + rnd() * 0.15;
      const grad = ctx.createLinearGradient(-len / 2, 0, len / 2, 0);
      grad.addColorStop(0, `rgba(${shade},${shade},${shade},0)`);
      grad.addColorStop(0.5, `rgba(${shade},${shade},${shade},1)`);
      grad.addColorStop(1, `rgba(${shade},${shade},${shade},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(0, 0, len / 2, wid / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      // raquis fino (el "tallo" central de la barba), apenas más oscuro
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = `rgba(${Math.max(0, shade - 40)},${Math.max(0, shade - 40)},${Math.max(0, shade - 40)},1)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-len / 2, 0);
      ctx.lineTo(len / 2, 0);
      ctx.stroke();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    return canvas.toDataURL('image/png');
  }, seed);
  fs.writeFileSync(outFile, Buffer.from(result.split(',')[1], 'base64'));
}

// Textura de pelaje: trazos cortos y finos, más caóticos que la pluma
// (el pelo del carpincho es grueso y desordenado, no alineado).
async function buildFur(outFile, seed) {
  const result = await p.evaluate(async (seed) => {
    let s = seed;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgb(214,214,214)';
    ctx.fillRect(0, 0, size, size);
    ctx.lineCap = 'round';
    for (let i = 0; i < 1400; i++) {
      const x = rnd() * size, y = rnd() * size;
      const len = 6 + rnd() * 10;
      const rot = (rnd() - 0.5) * 1.2; // pelo grueso: sin dirección tan marcada
      const shade = 140 + rnd() * 80;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rot);
      ctx.globalAlpha = 0.3 + rnd() * 0.2;
      ctx.strokeStyle = `rgb(${shade},${shade},${shade})`;
      ctx.lineWidth = 1.4 + rnd() * 1.3;
      ctx.beginPath();
      ctx.moveTo(-len / 2, 0);
      ctx.lineTo(len / 2, 0);
      ctx.stroke();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    return canvas.toDataURL('image/png');
  }, seed);
  fs.writeFileSync(outFile, Buffer.from(result.split(',')[1], 'base64'));
}

await buildFeather(`${outDir}/feather_mottle.png`, 771002);
await buildFur(`${outDir}/fur_mottle.png`, 559013);
await b.close();
console.log('done');
