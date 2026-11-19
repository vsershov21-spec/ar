#!/usr/bin/env node
// Коты v1 | v2 в приложении (сборка dist/, сервер «как Caddy», кадр как у scripts/tom-shots.mjs tom_ar_<кот>.png):
//   npm run build && node tools/model-ab-shot.mjs <outdir> [hooligan,kind,glitter]
// Снимает каждого кота дважды — ED (по умолчанию pilot) без параметра (v1, по умолчанию) и с ?models=v2 — и кладёт
//   <outdir>/v1_<кот>.png, <outdir>/v2_<кот>.png и склейку <outdir>/v2b_app_<кот>.png (слева v1, справа v2).
// env: ED=pilot|lab|mvp, VARIANTS=v1,v2 (какие снимать), HOME_SHOT=1 — ещё кухня «Мира кота» (<outdir>/v1_kitchen_<кот>.png …),
//      Q — доп. query, CHROME, BASE — адрес vite dev вместо dist/.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(root, 'dist');
const [outArg, catsArg] = process.argv.slice(2);
const outDir = path.resolve(outArg ?? 'docs/models');
fs.mkdirSync(outDir, { recursive: true });
const cats = (catsArg ?? 'hooligan,kind,glitter').split(',');
const ED = process.env.ED ?? 'pilot';
const VARIANTS = (process.env.VARIANTS ?? 'v1,v2').split(',');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ktx2': 'image/ktx2' };
const file = (p) => {
  const f = path.join(DIST, p);
  if (!f.startsWith(DIST)) return null;
  if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
  if (fs.existsSync(path.join(f, 'index.html'))) return path.join(f, 'index.html');
  return null;
};
const srv = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.startsWith('/api/')) return void (res.writeHead(204), res.end());
  let f = file(p);
  if (!f && (!path.extname(p) || p.endsWith('.html'))) f = p.startsWith('/mvp') ? file('/mvp/index.html') : p.startsWith('/lab') ? file('/lab/index.html') : file('/index.html');
  if (!f) return void (res.writeHead(404), res.end());
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] ?? 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
// BASE=http://localhost:4190 — вместо dist/ взять запущенный vite dev (редакция lab, модели без сжатия)
if (!process.env.BASE) await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = process.env.BASE ?? `http://127.0.0.1:${srv.address().port}`;
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  headless: true,
  protocolTimeout: 240000,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--lang=ru-RU'],
});

async function shoot(cat, variant) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const logs = [];
  page.on('pageerror', (e) => logs.push('ERR ' + e.message));
  page.on('console', (m) => /\[glb\]/.test(m.text()) && logs.push(m.text()));
  await page.evaluateOnNewDocument(() => {
    localStorage.clear();
    const P = location.pathname.startsWith('/lab') ? 'lab:' : location.pathname.startsWith('/mvp') ? 'pilot:' : '';
    localStorage.setItem(P + 'sber-ar-cat:v1', JSON.stringify({ name: null, persona: null, visits: 3, lastVisitAt: Date.now() - 3600_000, met: true }));
    localStorage.setItem(P + 'ar.catalog.tried', JSON.stringify(['pet', 'tickle', 'treat']));
  });
  const dir = ED === 'lab' ? 'lab/' : ED === 'mvp' ? '' : 'mvp/';
  const q = `from=test&nocard=off&cat=${cat}&progress=0&q=0&mic=ptt&noanalytics${variant === 'v2' ? '&models=v2' : ''}${process.env.Q ? '&' + process.env.Q : ''}`;
  await page.goto(`${base}/${dir}?${q}`, { waitUntil: 'networkidle0', timeout: 90000 });
  await page.waitForFunction(() => window.__app?.home && window.__edition, { timeout: 60000 });
  await page.evaluate(() => document.querySelector('[data-a="wake"]')?.click());
  const until = async (fn, ms = 120000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await page.evaluate(fn)) return true;
      await wait(80);
    }
    throw new Error('не дождался: ' + fn);
  };
  await until(() => ['play', 'free'].includes(window.__app.director.state.phase) && !window.__app.director.queue.busy && !window.__app.awake?.active);
  await wait(1500);
  const quiet = () => page.evaluate(() => {
    window.__app.director.queue?.clear?.();
    window.__app.ui.hideBubble();
    const t = window.__app.ui.tom;
    if (t) t.auto.idleMs = 1e9;
    t?.reveal();
  });
  await quiet();
  await wait(800);
  const shot = async (name) => {
    await page.evaluate(() => window.__app.ui.tom?.tick(true));
    await wait(450);
    const f = path.join(outDir, name);
    await page.screenshot({ path: f });
    return f;
  };
  const out = { ar: await shot(`${variant}_${cat}.png`) };
  if (process.env.HOME_SHOT === '1') {
    await page.evaluate(() => window.__app.home.enter('chip'));
    await until(() => window.__app.home.phase === 'home');
    await wait(2200);
    await page.evaluate(() => window.__app.home.go('kitchen'));
    await until(() => !window.__app.home.moving);
    await wait(1500);
    await quiet();
    out.kitchen = await shot(`${variant}_kitchen_${cat}.png`);
  }
  console.log(cat, variant, page.url().includes('models=v2') ? '(models=v2 в адресе)' : '', logs.filter((l) => /ERR|объёмы/.test(l)).join(' | '));
  await page.close();
  return out;
}

/** склейка слева направо с подписями */
async function sideBySide(files, labels, outFile) {
  const imgs = await Promise.all(files.map((f) => sharp(f).metadata()));
  const W = imgs[0].width, H = imgs[0].height;
  const label = (t) => Buffer.from(`<svg width="${W}" height="90"><rect width="100%" height="100%" fill="rgba(0,0,0,0.55)"/><text x="30" y="62" font-size="52" font-family="sans-serif" font-weight="700" fill="#fff">${t}</text></svg>`);
  const comp = [];
  files.forEach((f, i) => {
    comp.push({ input: f, left: i * W, top: 0 });
    comp.push({ input: label(labels[i]), left: i * W, top: H - 90 });
  });
  await sharp({ create: { width: W * files.length, height: H, channels: 3, background: '#000' } }).composite(comp).png({ palette: true, quality: 90, effort: 8 }).toFile(outFile);
}

for (const cat of cats) {
  const r = {};
  for (const v of VARIANTS) r[v] = await shoot(cat, v);
  if (r.v1 && r.v2) {
    await sideBySide([r.v1.ar, r.v2.ar], ['v1 (по умолчанию)', 'v2 (?models=v2)'], path.join(outDir, `v2b_app_${cat}.png`));
    if (r.v1.kitchen && r.v2.kitchen) await sideBySide([r.v1.kitchen, r.v2.kitchen], ['v1', 'v2'], path.join(outDir, `v2b_kitchen_${cat}.png`));
  }
}
await browser.close();
if (srv.listening) srv.close();
