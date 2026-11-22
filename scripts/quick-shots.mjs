#!/usr/bin/env node
// Кадры быстрого входа (feature 'intro.quick') на iPhone-вьюпорте 390×844 → docs/qa/ui/quick/NN_<что>.jpg.
// Запуск: AR_EDITIONS=pilot node scripts/build/editions.mjs && node scripts/quick-shots.mjs [splash,terms,consent,search,denied,play]
//   consent — кадр галочки: собрать с VITE_CONSENT_MODE=parent и запустить `node scripts/quick-shots.mjs consent`.
// Карта на «камере» — still.y4m QA-стенда (QA_MEDIA=…, по умолчанию bench-out/qa/media/still.y4m, scripts/qa/run.mjs).
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(root, 'dist');
const PUB = path.join(root, 'public');
const CACHE = process.env.AR_MODEL_CACHE || path.join(root, '.cache/model-opt');
const MEDIA = process.env.QA_MEDIA || path.join(root, 'bench-out/qa/media/still.y4m');
const out = path.join(root, 'docs/qa/ui/quick');
fs.mkdirSync(out, { recursive: true });
const only = (process.argv[2] || 'splash,terms,search,denied,play').split(',');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml' };
const file = (base, p) => {
  const f = path.join(base, p);
  return f.startsWith(base) && fs.existsSync(f) && fs.statSync(f).isFile() ? f : null;
};
const optCached = (p) => {
  const m = /\/opt\/[^/]+\.([0-9a-f]{10})\.glb$/.exec(p);
  if (!m || !fs.existsSync(CACHE)) return null;
  const n = fs.readdirSync(CACHE).find((x) => x.startsWith(m[1]));
  return n ? path.join(CACHE, n) : null;
};
const srv = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.startsWith('/api/')) return void (res.writeHead(204), res.end());
  let f = file(DIST, p) || file(PUB, p) || optCached(p);
  if (!f && p.startsWith('/mvp') && (!path.extname(p) || p.endsWith('/'))) f = file(DIST, '/mvp/index.html');
  if (!f) return void (res.writeHead(404), res.end());
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const SLOW4G = { offline: false, latency: 562.5, downloadThroughput: (1.6 * 1024 * 1024 / 8) * 0.9, uploadThroughput: (750 * 1024 / 8) * 0.9 };

const launch = (card) =>
  puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/bin/google-chrome',
    headless: true,
    protocolTimeout: 300000,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', ...(card ? [`--use-file-for-fake-video-capture=${MEDIA}`] : []),
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--lang=ru-RU', '--mute-audio'],
  });
const errors = [];
async function page(browser, name, { slow = false, deny = false, q = '' } = {}) {
  const ctx = await browser.createBrowserContext();
  const pg = await ctx.newPage();
  await pg.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1');
  await pg.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  pg.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));
  if (slow) {
    const cdp = await pg.createCDPSession();
    await cdp.send('Network.emulateNetworkConditions', SLOW4G);
  }
  if (deny)
    await pg.evaluateOnNewDocument(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
    });
  await pg.goto(`${base}/mvp/?progress=0&noanalytics&mic=ptt${q}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  const until = async (fn, ms = 120000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await pg.evaluate(fn).catch(() => false)) return true;
      await wait(100);
    }
    console.warn(`  ! [${name}] не дождался: ${fn}`);
    return false;
  };
  return { pg, until, close: () => ctx.close() };
}
const shot = async (pg, name) => {
  const f = path.join(out, `${name}.jpg`);
  await pg.screenshot({ path: f, type: 'jpeg', quality: 78 });
  console.log('  ✓', path.relative(root, f));
};
const tap = async (pg, sel) => {
  const r = await pg.evaluate((s) => {
    const b = document.querySelector(s);
    if (!b) return null;
    const rc = b.getBoundingClientRect();
    return { x: rc.x + rc.width / 2, y: rc.y + rc.height / 2 };
  }, sel);
  if (r) await pg.touchscreen.tap(r.x, r.y);
  return !!r;
};

const plain = await launch(false);
if (only.includes('splash')) {
  const { pg, close } = await page(plain, 'splash', { slow: true });
  await wait(1600);
  await shot(pg, '01_splash_slow4g_1.6s');
  await tap(pg, '.q-card');
  await wait(120);
  await shot(pg, '02_splash_knock');
  await pg.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await wait(300);
  await shot(pg, '03_splash_reduced_motion');
  await close();
}
if (only.includes('terms')) {
  const { pg, close } = await page(plain, 'terms');
  await wait(800);
  await tap(pg, '[data-q="terms"]');
  await wait(300);
  await shot(pg, '04_terms');
  await close();
}
if (only.includes('consent')) {
  const { pg, close } = await page(plain, 'consent');
  await wait(800);
  await shot(pg, '05_consent_parent');
  await tap(pg, '.q-cta');
  await wait(400);
  await shot(pg, '06_consent_parent_need');
  await close();
}
if (only.includes('denied')) {
  const { pg, until, close } = await page(plain, 'denied', { deny: true });
  await wait(800);
  await tap(pg, '.q-cta');
  await until(() => !document.querySelector('.q-denied')?.classList.contains('hidden'), 20000);
  await wait(400);
  await shot(pg, '07_camera_denied');
  // приложение готово — «Попробовать ещё раз» снова не даёт: вторая подсказка «Обновить страницу»
  await until(() => window.__quick?.ready, 120000);
  await tap(pg, '[data-q="retry"]');
  await until(() => !document.querySelector('.q-again')?.classList.contains('hidden'), 20000);
  await wait(400);
  await shot(pg, '08_camera_denied_again');
  await close();
}
if (only.includes('search')) {
  // медленная сеть: нажали сразу — камера пошла до готовности приложения, плашка «Положи карту…» с глазами
  const { pg, until, close } = await page(plain, 'search', { slow: true });
  await wait(1500);
  await tap(pg, '.q-cta');
  await until(() => document.querySelector('#quick')?.classList.contains('q-searching'), 60000);
  await wait(800);
  await shot(pg, '09_camera_before_app_ready');
  // приложение готово: детский поиск карты — лапки и глаза, без кота
  await until(() => !!window.__app?.input && document.querySelector('#quick')?.classList.contains('hidden'), 240000);
  await wait(2500);
  await shot(pg, '10_card_search_eyes');
  await close();
}
await plain.close();
if (only.includes('play')) {
  const b = await launch(true);
  const { pg, until, close } = await page(b, 'play');
  await wait(500);
  await tap(pg, '.q-cta');
  await until(() => !!window.__app?.awake?.active, 120000);
  await wait(1200);
  await shot(pg, '11_awake_reveal');
  await until(() => ['play', 'free', 'ask_name'].includes(window.__app?.director?.state.phase), 120000);
  await shot(pg, '12_meet');
  await until(() => !!document.querySelector('.hintp-cap:not(.hidden)'), 90000);
  await wait(300);
  await shot(pg, '13_hint_caption_1');
  await until(() => {
    const c = document.querySelector('.hintp-cap:not(.hidden)');
    return c && c.textContent !== window.__cap0 && (window.__cap0 ??= c.textContent) && c.textContent !== window.__cap0;
  }, 15000);
  await wait(300);
  await shot(pg, '14_hint_caption_2');
  await close();
  await b.close();
}
srv.close();
if (errors.length) console.log('ошибки страницы:\n' + errors.join('\n'));
