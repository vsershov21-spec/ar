#!/usr/bin/env node
// Снимки меню «как у Говорящего Тома» (feature ui.tomLayout, docs/ui/TOM_LAYOUT.md) в редакции pilot (/mvp):
//   docs/ui/tom_ar_<кот>.png (390×844), tom_home_kitchen_<кот>.png, tom_home_bedroom_<кот>.png, tom_landscape_<кот>.png (844×390)
//   + tom_ar_games_kind.png (поповер «Игры»), tom_ar_hidden_kind.png (колонки спрятались), tom_ar_tip_kind.png (долгое нажатие),
//   tom_ar_360_kind.png (360×740).
// Запуск: npm run build && node scripts/tom-shots.mjs [hooligan,kind,glitter]   (CHROME — по желанию). Сервер — «как Caddy».
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';
/** PNG ×2 — палитрой (≈ в 4 раза меньше, на глаз не отличить) */
const squeeze = async (f) => fs.writeFileSync(f, await sharp(f).png({ palette: true, quality: 90, effort: 8 }).toBuffer());

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(root, 'dist');
const outDir = path.join(root, 'docs/ui');
fs.mkdirSync(outDir, { recursive: true });
const ED = process.env.TOM_ED ?? 'pilot';
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
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  headless: true,
  protocolTimeout: 240000,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--lang=ru-RU'],
});
const errors = [];

async function open(cat, vp = { width: 390, height: 844 }) {
  const page = await browser.newPage();
  await page.setViewport({ ...vp, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.on('pageerror', (e) => errors.push(`[${cat}] ${e.message}`));
  await page.evaluateOnNewDocument(() => {
    localStorage.clear();
    // пилот хранит ключи с префиксом pilot: — уже знакомы, сразу игра
    const P = location.pathname.startsWith('/lab') ? 'lab:' : 'pilot:';
    localStorage.setItem(P + 'sber-ar-cat:v1', JSON.stringify({ name: null, persona: null, visits: 3, lastVisitAt: Date.now() - 3600_000, met: true }));
    localStorage.setItem(P + 'ar.catalog.tried', JSON.stringify(['pet', 'tickle', 'treat']));
  });
  await page.goto(`${base}/${ED === 'lab' ? 'lab' : 'mvp'}/?from=test&nocard=off&cat=${cat}&progress=0&q=0&mic=ptt&noanalytics`, { waitUntil: 'networkidle0', timeout: 90000 });
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
  return { page, until };
}
const shot = async (page, name) => {
  await page.evaluate(() => window.__app.ui.tom?.tick(true));
  await wait(450);
  const f = ED === 'lab' ? `tom_lab_${name}.png` : `tom_${name}.png`;
  await page.screenshot({ path: path.join(outDir, f) });
  await squeeze(path.join(outDir, f));
  console.log('  ✓', `docs/ui/${f}`);
};


const cats = (process.argv[2] ?? 'hooligan,kind,glitter').split(',');
const only = process.env.TOM_SHOTS?.split(',') ?? null;
const want = (k) => !only || only.includes(k);
const quiet = (page) => page.evaluate(() => {
  const d = window.__app.director;
  d.queue?.clear?.();
  window.__app.ui.hideBubble();
  // headless медленный: автоскрытие (6 с) для снимков выключено, его снимок — tom_ar_hidden_kind
  const t = window.__app.ui.tom;
  if (t) t.auto.idleMs = 1e9;
  t?.reveal();
});
const info = {};
for (const cat of cats) {
  const { page, until } = await open(cat);
  await quiet(page);
  await wait(800);
  info[cat] = await page.evaluate(() => {
    const t = window.__app.ui.tom;
    return { left: t.items.left.map((i) => i.id), right: t.items.right.map((i) => i.id), modes: [t.layout.left.mode, t.layout.right.mode], cat: window.__app.ui.catRect() };
  });
  if (want('ar')) await shot(page, `ar_${cat}`);
  if (cat === 'kind' && want('extra')) {
    await page.evaluate(() => document.querySelector('.tom-games')?.click());
    await wait(500);
    await shot(page, 'ar_games_kind');
    await page.evaluate(() => window.__app.ui.tom.closePop());
    // долгое нажатие — подсказка
    const b = await page.evaluate(() => { const r = document.querySelector('.tom-col.r .tom-btn[data-item="ui:paint"]')?.getBoundingClientRect(); return r && { x: r.x + r.width / 2, y: r.y + 20 }; });
    if (b) {
      await page.touchscreen.touchStart(b.x, b.y);
      await wait(700);
      await shot(page, 'ar_tip_kind');
      await page.touchscreen.touchEnd();
    }
    await wait(2300);
    // 6 с без касаний — колонки уехали к краю
    await page.evaluate(() => { const t = window.__app.ui.tom; t.auto.idleMs = 6000; t.auto.touch(performance.now() - 7000); t.tick(); });
    await wait(700);
    await page.screenshot({ path: path.join(outDir, 'tom_ar_hidden_kind.png') });
    await squeeze(path.join(outDir, 'tom_ar_hidden_kind.png'));
    console.log('  ✓ docs/ui/tom_ar_hidden_kind.png');
    await page.evaluate(() => window.__app.ui.tom.reveal());
  }
  if (want('home')) {
    await page.evaluate(() => window.__app.home.enter('chip'));
    await until(() => window.__app.home.phase === 'home');
    await wait(2200);
    const settled = () => until(() => !window.__app.home.moving);
    await page.evaluate(() => window.__app.home.go('kitchen'));
    await settled();
    await wait(1500);
    await quiet(page);
    await shot(page, `home_kitchen_${cat}`);
    await page.evaluate(() => window.__app.home.go('bedroom'));
    await settled();
    await wait(1500);
    await quiet(page);
    await shot(page, `home_bedroom_${cat}`);
  }
  await page.close();
  if (want('land')) {
    const L = await open(cat, { width: 844, height: 390 });
    await quiet(L.page);
    await wait(800);
    await shot(L.page, `landscape_${cat}`);
    if (cat === 'kind' && want('extra')) {
      await L.page.evaluate(() => window.__app.home.enter('chip'));
      await L.until(() => window.__app.home.phase === 'home');
      await wait(2200);
      await quiet(L.page);
      await shot(L.page, 'landscape_home_kind');
    }
    await L.page.close();
  }
  if (cat === 'kind' && want('extra')) {
    const S = await open(cat, { width: 360, height: 740 });
    await quiet(S.page);
    await wait(800);
    await shot(S.page, 'ar_360_kind');
    await S.page.close();
  }
}
console.log(JSON.stringify(info));
if (errors.length) console.log('ошибки страницы:\n ' + errors.join('\n '));
await browser.close();
srv.close();
