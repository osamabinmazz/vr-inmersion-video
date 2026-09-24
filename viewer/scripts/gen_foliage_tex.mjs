// Genera una textura de "moteado de follaje" a partir de la foto de hoja ya
// aprobada en el proyecto (leaf/color.png), en vez de las 260 elipses al
// azar de makeFoliageMap(). Compone varias hojas rotadas/escaladas sobre un
// fondo gris neutro (mismo criterio que la textura procedural: la media
// tiene que quedar cerca del blanco para que el tinte por instancia entre
// entero) y desatura el resultado.
//
// El resultado (foliage_mottle/*.png) SÍ se commitea al repo — no hace
// falta correr este script después de clonar. Se deja acá solo como
// referencia de cómo se generó, por si hay que rehacerlo con otra hoja.
// Requiere Playwright instalado (npx playwright install si hace falta);
// ajustar el import de "chromium" según cómo esté instalado en tu entorno.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const leafPath = path.join(__dirname, '../public/assets/textures/leaf/color.png');
const leafPinnadaPath = path.join(__dirname, '../public/assets/textures/leaf_pinnada/color.png');
const outDir = path.join(__dirname, '../public/assets/textures/foliage_mottle');
fs.mkdirSync(outDir, { recursive: true });

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 600, height: 600 } });
await p.goto('about:blank');

async function buildMottle(imgPath, outFile, seed) {
  const b64 = fs.readFileSync(imgPath).toString('base64');
  const dataUrl = `data:image/png;base64,${b64}`;
  const result = await p.evaluate(async ([dataUrl, seed]) => {
    // PRNG determinista simple (mismo criterio que el proyecto: nada de
    // Math.random en un asset que se guarda).
    let s = seed;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = dataUrl; });
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    // Fondo gris neutro, igual criterio que la versión procedural (rgb 214).
    ctx.fillStyle = 'rgb(214,214,214)';
    ctx.fillRect(0, 0, size, size);
    // La imagen trae DOS hojas lado a lado; se toma solo la mitad izquierda.
    const leafW = img.width / 2, leafH = img.height;
    // Varias hojas rotadas/escaladas, con recorte al medio-tono para que el
    // promedio siga cerca del gris de fondo (si no, tinta demasiado oscuro).
    ctx.globalAlpha = 0.55;
    for (let i = 0; i < 34; i++) {
      const scale = (0.28 + rnd() * 0.22) * (size / leafH);
      const w = leafW * scale, h = leafH * scale;
      const x = rnd() * size, y = rnd() * size;
      const rot = rnd() * Math.PI * 2;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rot);
      ctx.drawImage(img, 0, 0, leafW, leafH, -w / 2, -h / 2, w, h);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    // Desaturar: el mapa tiene que ser gris (el color lo pone instanceColor
    // una sola vez), no verde — mismo criterio que la versión procedural.
    const id = ctx.getImageData(0, 0, size, size);
    const d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      d[i] = d[i + 1] = d[i + 2] = l;
    }
    ctx.putImageData(id, 0, 0);
    return canvas.toDataURL('image/png');
  }, [dataUrl, seed]);
  fs.writeFileSync(outFile, Buffer.from(result.split(',')[1], 'base64'));
}

await buildMottle(leafPath, `${outDir}/mottle_ancha.png`, 918273);
await buildMottle(leafPinnadaPath, `${outDir}/mottle_pinnada.png`, 405162);
await b.close();
console.log('done');
