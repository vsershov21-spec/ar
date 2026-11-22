#!/usr/bin/env node
// Текстуры кота 2K → 1K (scripts/build/model-opt.mjs MAX_TEX): один и тот же кадр — одна поза, один свет — с текстурами
// из двух сжатых моделей. Пилот (/mvp, кот на столе без камеры, ?nocard=off), телефон 390×844 @3x (iPhone), кадр
// рендерится вручную (renderer.render) без шага времени: меняются только карты материалов.
//   node scripts/qa/tex-ab.mjs <dist с моделями 1K> <dist с моделями 2K> [hooligan,kind,glitter] [--out DIR]
//   (сборки с моделями: VITE_EDITION=pilot npx vite build --outDir X, для 2K — AR_TEX_MAX=2048)
// Итог: DIR/tex_<кот>.png — слева 2K, справа 1K (кот целиком и морда 1:1 в пикселях экрана) + разница по пикселям.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const oi = argv.indexOf('--out');
const OUT = path.resolve(oi >= 0 ? argv.splice(oi, 2)[1] : path.join(root, 'bench-out/tex-ab'));
const [A, B] = argv.slice(0, 2).map((d) => path.resolve(d));
const CATS = (argv[2] ?? 'hooligan,kind,glitter').split(',');
// сборка editions (dist/mvp/index.html) или одна сборка VITE_EDITION=pilot vite build --outDir X (index.html в корне)
const MVP = fs.existsSync(path.join(A, 'mvp/index.html'));
fs.mkdirSync(OUT, { recursive: true });
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4' };
const file = (base, p) => {
  const f = path.join(base, p);
  return f.startsWith(base) && fs.existsSync(f) && fs.statSync(f).isFile() ? f : null;
};
// сайт — сборка A; /__b/… — файлы сборки B (её сжатые модели)
const srv = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.startsWith('/api/')) return void (res.writeHead(204), res.end());
  let f = p.startsWith('/__b/') ? file(B, p.slice(4)) : file(A, p);
  if (!f && !path.extname(p)) f = p.startsWith('/mvp') ? file(A, '/mvp/index.html') : file(A, '/index.html');
  if (!f) return void (res.writeHead(404), res.end());
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] ?? 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, protocolTimeout: 240000,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--lang=ru-RU', '--mute-audio'],
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** сжатая модель кота в сборке (v2 по умолчанию: models/v2/opt/<кот>_p1.<хэш>.glb) */
const optOf = (dist, cat) => {
  const d = path.join(dist, 'models/v2/opt');
  const n = fs.existsSync(d) && fs.readdirSync(d).find((x) => x.startsWith(cat + '_p1.') && x.endsWith('.glb'));
  return n ? `models/v2/opt/${n}` : null;
};

for (const cat of CATS) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await page.evaluateOnNewDocument(() => {
    localStorage.clear();
    const mem = JSON.stringify({ name: null, persona: null, visits: 3, lastVisitAt: Date.now() - 3600_000, met: true });
    for (const P of ['', 'pilot:']) localStorage.setItem(P + 'sber-ar-cat:v1', mem);
  });
  // до кадра — быстро (?q=0: swiftshader), сам кадр — с чёткостью iPhone (pixelRatio 3)
  await page.goto(`${base}/${MVP ? 'mvp/' : ''}?from=test&nocard=off&cat=${cat}&progress=0&q=0&mic=ptt&noanalytics&meshy=0`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.__app?.director && window.__app.character?.mixer, { timeout: 120000 });
  await page.evaluate(() => document.querySelector('[data-a="wake"]')?.click());
  await page.waitForFunction(() => ['play', 'free'].includes(window.__app.director.state.phase) && !window.__app.awake?.active, { timeout: 180000, polling: 200 });
  await wait(1500);
  // интерфейс прочь, кадр — только 3D
  await page.addStyleTag({ content: 'body *{visibility:hidden!important} canvas.gl{visibility:visible!important}' });
  const bUrl = '/__b/' + optOf(B, cat);
  // кадр замораживаем (цикл приложения стоп), текстуры B — из её модели тем же загрузчиком (KTX2 → те же форматы GPU)
  const r = await page.evaluate(async (url) => {
    const app = window.__app;
    app.renderer.setAnimationLoop(null);
    app.renderer.setPixelRatio(3);
    app.resize?.();
    const ch = app.character;
    const sceneB = await ch.props.load(url);
    const slots = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'sheenColorMap', 'sheenRoughnessMap'];
    const mats = new Map();
    sceneB.traverse((o) => {
      const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of ms) mats.set(m.name, m);
    });
    const orig = [];
    ch.model.traverse((o) => {
      const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of ms) {
        const mb = mats.get(m.name);
        if (!mb) continue;
        for (const s of slots) if (m[s] && mb[s]) orig.push([m, s, m[s], mb[s]]);
      }
    });
    window.__texab = {
      set(which) {
        for (const [m, s, a, b] of orig) {
          m[s] = which === 'b' ? b : a;
          m.needsUpdate = false;
        }
        app.renderer.render(app.scene, app.tracker.camera);
      },
    };
    const sizes = orig.map(([, s, a, b]) => `${s} ${a.image?.width ?? a.source?.data?.width}→${b.image?.width ?? b.source?.data?.width}`);
    const cr = app.ui.catRect?.();
    return { n: orig.length, sizes: [...new Set(sizes)], cat: cr };
  }, bUrl);
  const shots = {};
  for (const w of ['a', 'b']) {
    await page.evaluate((x) => window.__texab.set(x), w);
    await wait(300);
    shots[w] = await page.screenshot({ type: 'png' });
  }
  // рамка кота (CSS px → px экрана ×3): от макушки до низа, по ширине — половина × 1,3
  const k = 3, c = r.cat;
  const box = c
    ? { left: Math.max(0, Math.round((c.cx - c.half * 1.4) * k)), top: Math.max(0, Math.round((c.top - 10) * k)), width: Math.round(c.half * 2.8 * k), height: Math.round((c.bottom - c.top + 20) * k) }
    : { left: 0, top: 600, width: 1170, height: 1400 };
  box.width = Math.min(box.width, 1170 - box.left);
  box.height = Math.min(box.height, 2532 - box.top);
  const fw = Math.round(box.width * 0.6);
  const face = { left: box.left + Math.round(box.width * 0.2), top: box.top + Math.round(box.height * 0.08), width: fw, height: Math.min(Math.round(fw * 1.1), box.height - Math.round(box.height * 0.08)) };
  const crop = (buf, b) => sharp(buf).extract(b).png().toBuffer();
  const [a1, b1, a2, b2] = await Promise.all([crop(shots.b, box), crop(shots.a, box), crop(shots.b, face), crop(shots.a, face)]);
  // разница (морда): средняя по каналам и доля пикселей с отличием > 24/255
  const ra = await sharp(a2).raw().toBuffer(), rb = await sharp(b2).raw().toBuffer();
  let sum = 0, big = 0;
  for (let i = 0; i < ra.length; i++) {
    const d = Math.abs(ra[i] - rb[i]);
    sum += d;
    if (d > 24) big++;
  }
  const W = box.width, H = box.height, FW = face.width, FH = face.height;
  const label = (t, w) => Buffer.from(`<svg width="${w}" height="70"><rect width="100%" height="100%" fill="rgba(0,0,0,0.6)"/><text x="20" y="48" font-size="40" font-family="sans-serif" font-weight="700" fill="#fff">${t}</text></svg>`);
  await sharp({ create: { width: W * 2 + 20 + FW * 2 + 20, height: Math.max(H, FH) + 70, channels: 3, background: '#111' } })
    .composite([
      { input: a1, left: 0, top: 70 }, { input: b1, left: W + 20, top: 70 },
      { input: a2, left: W * 2 + 40, top: 70 }, { input: b2, left: W * 2 + 40 + FW + 20, top: 70 },
      { input: label('2K', W), left: 0, top: 0 }, { input: label('1K', W), left: W + 20, top: 0 },
      { input: label('морда 2K', FW), left: W * 2 + 40, top: 0 }, { input: label('морда 1K', FW), left: W * 2 + 40 + FW + 20, top: 0 },
    ])
    .png({ palette: true, quality: 92, effort: 8 })
    .toFile(path.join(OUT, `tex_${cat}.png`));
  console.log(`${cat}: текстур подменено ${r.n} (${r.sizes.join(', ')}); морда: средняя разница ${(sum / ra.length).toFixed(2)}/255, пикселей > 24/255 — ${((big / ra.length) * 100).toFixed(2)} %; кот на экране ${Math.round(H)} px → ${path.relative(root, path.join(OUT, `tex_${cat}.png`))}`);
  await page.close();
}
await browser.close();
srv.close();
