#!/usr/bin/env node
// Снимки редакции pilot (/mvp, docs/EDITIONS.md «Пилот»), 390×844: docs/ui/pilot_<что>.png —
//   каталог-лист у каждого кота (catalog_hooligan|kind|glitter), вход в «Мир кота» (home_enter — портал),
//   гостиная (home_living), кухня (home_kitchen), спальня с котом в кровати (home_bedroom).
// Запуск: npm run build && node scripts/pilot-shots.mjs   (CHROME — по желанию). Сервер — свой, «как Caddy» (/mvp/* → /mvp/index.html).
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(root, 'dist');
const outDir = path.join(root, 'docs/ui');
fs.mkdirSync(outDir, { recursive: true });
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
  if (!f && (!path.extname(p) || p.endsWith('.html'))) f = p.startsWith('/mvp') ? file('/mvp/index.html') : file('/index.html');
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

async function open(cat) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  page.on('pageerror', (e) => errors.push(`[${cat}] ${e.message}`));
  await page.evaluateOnNewDocument(() => {
    localStorage.clear();
    // пилот хранит ключи с префиксом pilot: — уже знакомы, сразу игра
    localStorage.setItem('pilot:sber-ar-cat:v1', JSON.stringify({ name: null, persona: null, visits: 3, lastVisitAt: Date.now() - 3600_000, met: true }));
    localStorage.setItem('pilot:ar.catalog.tried', JSON.stringify(['pet', 'tickle', 'treat']));
  });
  await page.goto(`${base}/mvp/?from=test&nocard=off&cat=${cat}&progress=0&q=0&mic=ptt&noanalytics`, { waitUntil: 'networkidle0', timeout: 90000 });
  await page.waitForFunction(() => window.__app?.home && window.__edition === 'pilot', { timeout: 60000 });
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
  await page.screenshot({ path: path.join(outDir, `pilot_${name}.png`) });
  console.log('  ✓', `docs/ui/pilot_${name}.png`);
};

const report = {};
for (const cat of process.env.PILOT_SHOTS === 'home' ? ['kind'] : ['hooligan', 'kind', 'glitter']) {
  const { page, until } = await open(cat);
  await page.evaluate(() => window.__app.ui.openCatalog());
  await wait(1000);
  // вкладки листа: что в каждой (для отчёта) — «Трюки» (8 общих + фирменное) и «Образ» (второе фирменное)
  report[cat] = await page.evaluate(() => Object.fromEntries(window.__app.ui.sheetGroupsList.map((g) => [g.id, g.items.map((i) => i.id)])));
  const tab = async (id) => {
    await page.evaluate((id) => document.querySelector(`.cs-tab[data-tab="${id}"]`)?.click(), id);
    await wait(700);
  };
  await tab('tricks');
  await shot(page, `catalog_${cat}`);
  await tab('look');
  await shot(page, `catalog_${cat}_look`);
  if (cat === 'kind' && process.env.PILOT_SHOTS !== 'catalog') {
    // (PILOT_SHOTS=home — только дом)
    await page.evaluate(() => window.__app.ui.closeCatalog());
    await wait(600);
    // портал «пойдём ко мне»: вспышка замедлена для снимка (на телефоне 0,45 с; снимок headless медленнее вспышки)
    await page.addStyleTag({ content: '.home-portal.in i, .home-portal.in b { animation-duration: 3s !important; }' });
    // настоящий вход (как чип «Пойдём!»): эффекты карты убраны, кот прыгает в портал
    // снимок посреди вспышки: комнату (и смену сцены) придерживаем на 2,5 с — только для снимка
    await page.evaluate(() => {
      const h = window.__app.home, orig = h.loadRoom.bind(h);
      h.loadRoom = () => new Promise((r) => setTimeout(() => r(orig()), 2500));
      h.enter('chip');
      h.loadRoom = orig;
    });
    await wait(Number(process.env.PORTAL_AT ?? 1100));
    await shot(page, 'home_enter');
    await page.addStyleTag({ content: '.home-portal.in i, .home-portal.in b { animation-duration: .45s !important; }' });
    await until(() => window.__app.home.phase === 'home');
    await wait(2600);
    await shot(page, 'home_living');
    const settled = () => until(() => !window.__app.home.moving);
    await page.evaluate(() => window.__app.home.go('kitchen'));
    await settled();
    await wait(600);
    await page.evaluate(() => window.__app.home.act('home:treat'));
    await wait(2200);
    await shot(page, 'home_kitchen');
    await page.evaluate(() => window.__app.home.go('bedroom'));
    await settled();
    await wait(600);
    await page.evaluate(() => window.__app.home.act('home:sleep'));
    await until(() => window.__app.home.lightLevel < 0.3);
    await wait(4000);
    await shot(page, 'home_bedroom');
  }
  await page.close();
}
console.log(JSON.stringify(report));
if (errors.length) console.log('ошибки страницы:\n ' + errors.join('\n '));
await browser.close();
srv.close();
