#!/usr/bin/env node
// Видео раскраски карты (src/card/paint.ts): docs/ui/paint_<кот>.mp4 (1080×1920, H.264, ≤ 3 МБ) и лист кадров
// docs/ui/paint_<кот>_sheet.jpg (12 кадров). Трекер ?debug — карта лежит на столе перед камерой.
// Покадрово: время страницы стоит, шаг — ровно 1/FPS с виртуального времени, снимок каждого кадра (headless-рендер
// SwiftShader медленный: запись экрана в реальном времени дала бы 3–5 к/с).
//
//   node scripts/paint-video.mjs [--url http://localhost:5173/] [--cats hooligan,kind,glitter] [--fps 30] [--dpr 3]
//                                [--zoom 2.25] [--no-build] [--preview]   (--preview — 360×640, 15 к/с: быстро посмотреть)
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const PREVIEW = argv.includes('--preview');
const CATS = arg('--cats', 'hooligan,kind,glitter').split(',');
const FPS = Number(arg('--fps', 20));
const DPR = Number(arg('--dpr', PREVIEW ? 1 : 1.25));
const ZOOM = Number(arg('--zoom', 3.25));
const TILT = Number(arg('--tilt', 1.3));
const MAX_S = Number(arg('--max', 40));
const SWATCH = { hooligan: 1, kind: 0, glitter: 0 };
const OUT = path.join(root, 'docs/ui');
const TMP = path.join(root, 'bench-out/paint');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[paint]', ...a);

let server = null;
let URL0 = arg('--url', null);
if (!URL0) {
  const port = 4378;
  const dist = path.join(TMP, 'dist');
  if (!argv.includes('--no-build')) {
    log('сборка → bench-out/paint/dist');
    const b = spawnSync('npx', ['vite', 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'warn'], { cwd: root, stdio: 'inherit' });
    if (b.status) throw new Error('vite build упал');
  }
  server = spawn('npx', ['vite', 'preview', '--outDir', dist, '--port', String(port), '--strictPort'], { cwd: root, stdio: 'ignore' });
  URL0 = `http://localhost:${port}/`;
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(URL0)).ok) break;
    } catch {}
    await sleep(500);
  }
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/usr/bin/google-chrome',
  headless: true,
  protocolTimeout: 900_000,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--lang=ru-RU', '--mute-audio',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});

/** время страницы под управлением скрипта: __freeze() — стоит, __advance(ms) — шаг виртуального времени */
function virtualTime() {
  const pn = performance.now.bind(performance);
  let base = pn(), anchor = base, k = 1;
  const virt = () => base + (pn() - anchor) * k;
  window.__freeze = () => {
    base = virt();
    anchor = pn();
    k = 0;
  };
  window.__advance = (ms) => {
    base += ms;
  };
  performance.now = () => virt();
  const d0 = Date.now(), t0 = base;
  Date.now = () => d0 + (virt() - t0);
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf(() => cb(virt()));
}

for (const cat of CATS) {
  log(`— ${cat}`);
  const page = await browser.newPage();
  await page.setViewport({ width: 360, height: 640, deviceScaleFactor: DPR, isMobile: true, hasTouch: true });
  page.on('pageerror', (e) => log(`pageerror ${e.message}`));
  await page.evaluateOnNewDocument((c) => {
    localStorage.clear();
    localStorage.setItem('sber-ar-cat:v1', JSON.stringify({ name: null, persona: c, visits: 3, lastVisitAt: Date.now() - 3600_000, met: true }));
  }, cat);
  await page.evaluateOnNewDocument(virtualTime);
  await page.goto(`${URL0}?debug&cat=${cat}&progress=0&q=0&mic=ptt&noanalytics&awake=0`, { waitUntil: 'networkidle0', timeout: 120000 });
  await page.waitForFunction(() => window.__app?.director && window.__paint, { timeout: 120000 });
  await page.evaluate(() => document.querySelector('[data-a="wake"]')?.click());
  await page.waitForFunction(() => window.__app.character?.object?.children?.length > 0 && window.__app.director.state.appeared, { timeout: 120000 });
  await page.addStyleTag({ content: '.tom, .kids, .kids-go, .dbg, .dbg-toggle, .dbg-fps, .edition-badge, .chips, .nudge, .coach, [class*="kids"], .bubble-tip, .bubble, .mic-hint, .hint { visibility: hidden !important; }' });
  // камера ближе к карте: карта и кот крупно (дальше — мелко на телефоне)
  await page.evaluate((z, t) => {
    const tr = window.__app.tracker;
    if ('distance' in tr) tr.distance = z;
    if ('tilt' in tr) tr.tilt = t;
    if ('spin' in tr) tr.spin = -0.38;
    // карта ближе к середине кадра (у заглушки — у нижнего края): кот и рисунок крупно
    if (tr.placeCard) {
      const place = tr.placeCard.bind(tr);
      tr.placeCard = (tt) => {
        place(tt);
        tr.target.elements[13] = -0.56;
      };
    }
    // док (звук, дом, микрофон, игры) — не в кадр
    document.querySelectorAll('.tom-dbtn').forEach((b) => b.parentElement && (b.parentElement.style.visibility = 'hidden'));
    window.__app.fx?.reset?.();
  }, ZOOM, TILT);
  // кот вышел, пузырь жвачки появления лопнул
  await sleep(7000);
  // реплики не ждём: сценарий на паузе, кот стоит
  await page.evaluate(() => {
    const d = window.__app.director;
    d.queue?.clear?.();
  });
  await page.evaluate(() => window.__freeze());
  const dir = path.join(TMP, cat);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  const frame = async () => {
    await page.evaluate((ms) => window.__advance(ms), 1000 / FPS);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
    await page.screenshot({ path: path.join(dir, `${String(n++).padStart(4, '0')}.jpg`), type: 'jpeg', quality: 90 });
  };
  for (let i = 0; i < Math.round(FPS * 0.3); i++) await frame();
  const ok = await page.evaluate((s) => (window.__app.fx?.reset?.(), window.__paint.start(s, 20261118 + s)), SWATCH[cat]);
  if (!ok) throw new Error(`${cat}: раскраска не началась ${JSON.stringify(await page.evaluate(() => window.__paint.where()))}`);
  const qa = [];
  let tail = 0;
  for (let guard = 0; guard < FPS * MAX_S && tail < FPS * 1.6; guard++) {
    await frame();
    const q = await page.evaluate(() => ({ ...window.__paint.qa, p: window.__paint.progress, painting: window.__paint.painting, clip: window.__app.character?.currentClip }));
    qa.push(q);
    if (!q.painting) tail++;
    if (n % FPS === 0) log(`  ${(n / FPS).toFixed(0)} с: ${q.step} ${q.clip} промах ${q.miss.toFixed(3)} прогресс ${q.p.toFixed(2)}`);
  }
  const sprayed = qa.filter((q) => q.spraying);
  const miss = sprayed.length ? sprayed.reduce((a, q) => a + q.miss, 0) / sprayed.length : 0;
  log(`  кадров ${n}, краска шла в ${sprayed.length}, средний промах сопла ${miss.toFixed(4)} ширины карты, макс ${Math.max(0, ...sprayed.map((q) => q.miss)).toFixed(3)}`);
  const name = PREVIEW ? `paint_${cat}_preview` : `paint_${cat}`;
  const out = PREVIEW ? path.join(TMP, `${name}.mp4`) : path.join(OUT, `${name}.mp4`);
  // ≤ 3 МБ: битрейт по длительности
  const secs = n / FPS;
  const kbps = Math.floor((2.85 * 8 * 1024) / secs);
  const enc = ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(dir, '%04d.jpg'), '-vf', 'scale=1080:1920:flags=lanczos,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high', '-movflags', '+faststart', '-an'];
  const p1 = spawnSync('ffmpeg', [...enc, '-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.3)}k`, '-bufsize', `${kbps * 2}k`, out]);
  if (p1.status) log('ffmpeg', p1.stderr?.toString().slice(0, 400));
  log(`  видео ${path.relative(root, out)}: ${secs.toFixed(1)} с, ${Math.round(fs.statSync(out).size / 1024)} КБ`);
  // лист кадров: 12 равномерно по раскраске
  const sheet = PREVIEW ? path.join(TMP, `${name}_sheet.jpg`) : path.join(OUT, `paint_${cat}_sheet.jpg`);
  const every = Math.max(1, Math.floor(n / 12));
  spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(dir, '%04d.jpg'), '-vf', `select='not(mod(n\\,${every}))',scale=270:480,tile=6x2:padding=4:color=white`, '-frames:v', '1', '-q:v', '4', sheet]);
  log(`  лист ${path.relative(root, sheet)}`);
  fs.writeFileSync(path.join(TMP, `${cat}_qa.json`), JSON.stringify(qa));
  await page.close();
}
await browser.close();
server?.kill();
