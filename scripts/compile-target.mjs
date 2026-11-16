#!/usr/bin/env node
// Компиляция изображения карты в .mind (MindAR) через headless Chromium.
// Пакет `canvas` (нужен офлайн-компилятору mind-ar в node) не ставится без нативной сборки,
// поэтому используем браузерный Compiler из mind-ar/dist внутри Chromium (puppeteer-core).
//
// Использование:
//   npm run compile-target -- path/to/card.png [--out public/targets/card.mind] [--min-width 1000]
// Chromium ищется в CHROME_PATH / PUPPETEER_EXECUTABLE_PATH / /usr/bin/google-chrome.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  if (i >= 0) { const v = args[i + 1]; args.splice(i, 2); return v; }
  return def;
};
const out = path.resolve(opt('--out', path.join(root, 'public/targets/card.mind')));
const minWidth = Number(opt('--min-width', '1000'));
const copyPng = opt('--png-out', path.join(path.dirname(out), path.basename(out, '.mind') + '.png'));
const input = args[0];
if (!input || !fs.existsSync(input)) {
  console.error('Укажите путь к PNG/JPG карты: npm run compile-target -- path/to/card.png');
  process.exit(1);
}

const chrome = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome';
const distDir = path.join(root, 'node_modules/mind-ar/dist');

const page = `<!doctype html><meta charset="utf-8"><body><script type="module">
import { Compiler } from '/dist/mindar-image.prod.js';
window.__compile = async (dataUrl, minWidth) => {
  const img = new Image();
  img.src = dataUrl; await img.decode();
  // маленькие картинки апскейлим: пирамида признаков MindAR рассчитана на ~1000px
  const k = Math.max(1, minWidth / img.width);
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, c.width, c.height);
  const scaled = new Image(); scaled.src = c.toDataURL('image/png'); await scaled.decode();
  const compiler = new Compiler();
  const data = await compiler.compileImageTargets([scaled], (p) => console.log('progress ' + p.toFixed(0)));
  const buf = new Uint8Array(compiler.exportData());
  let s = ''; for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
  const counts = data[0].matchingData.map(m => m.maximaPoints.length + m.minimaPoints.length);
  return { b64: btoa(s), width: c.width, height: c.height, features: counts,
           tracking: data[0].trackingData.map(t => t.points.length) };
};
window.__ready = true;
</script>`;

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/?')) { res.setHeader('content-type', 'text/html'); return res.end(page); }
  if (req.url.startsWith('/dist/')) {
    const f = path.join(distDir, path.basename(req.url.split('?')[0]));
    if (fs.existsSync(f)) { res.setHeader('content-type', 'text/javascript'); return res.end(fs.readFileSync(f)); }
  }
  res.statusCode = 404; res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await puppeteer.launch({ executablePath: chrome, headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const p = await browser.newPage();
  p.on('console', (m) => { const t = m.text(); if (/^progress (\d+)/.test(t)) process.stdout.write('\r' + t + '%   '); });
  p.on('pageerror', (e) => console.error('pageerror', e.message));
  await p.goto(`http://127.0.0.1:${port}/`);
  await p.waitForFunction('window.__ready === true', { timeout: 60000 });
  const ext = path.extname(input).toLowerCase() === '.jpg' || path.extname(input).toLowerCase() === '.jpeg' ? 'jpeg' : 'png';
  const dataUrl = `data:image/${ext};base64,` + fs.readFileSync(input).toString('base64');
  const r = await p.evaluate((d, w) => window.__compile(d, w), dataUrl, minWidth);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(r.b64, 'base64'));
  if (copyPng && path.resolve(copyPng) !== path.resolve(input)) fs.copyFileSync(input, copyPng);
  console.log(`\nГотово: ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} КБ), изображение ${r.width}×${r.height}`);
  console.log(`Признаки для поиска по уровням пирамиды: ${r.features.join(', ')}`);
  console.log(`Точки трекинга по уровням: ${r.tracking.join(', ')}`);
  const total = r.features.reduce((a, b) => a + b, 0);
  if (total < 150) console.warn('ВНИМАНИЕ: мало признаков — карта будет распознаваться плохо (см. docs/MECHANICS.md, «Требования к изображению карты»).');
} finally {
  await browser.close();
  server.close();
}
