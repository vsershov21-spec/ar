#!/usr/bin/env node
// Скорость входа пилота (/mvp) на «медленном 4G» (пресет Chrome DevTools «Slow 4G»: 562,5 мс задержки, ~180 КБ/с вниз,
// ~84 КБ/с вверх), iPhone-вьюпорт 390×844, холодный кэш (новый профиль на каждый прогон).
// Что меряем (мс от начала навигации):
//   btn    — на экране видна первая кнопка (старый вход: «Познакомиться», новый: «Узнать, кто там»);
//   ready  — приложение готово (App.init прошёл: window.__app.input; старый вход до этого на «Открыть камеру» не реагирует);
//   tap    — нажатие, которое открывает камеру (старый вход — 4-е касание, новый — 1-е);
//   cam    — видео камеры пошло (разрешение — сразу, --use-fake-ui-for-media-stream);
//   cat    — кот сидит на карте (stage.root.visible && tracker.isTracking), карта — still.y4m из QA-стенда;
//   bytes  — сколько КБ скачано к кнопке и к коту (encodedDataLength, сжатие gzip как на проде).
// Сценарии: «сразу» — жмём, как только можно; «прочитал» — ребёнок смотрит на экран 4 с, потом жмёт.
// Запуск: node scripts/qa/quick-speed.mjs <dist-папка-с-mvp> [метка] [--runs 2] [--cpu 1]
//   (старый вход — копия dist/mvp до изменений, новый — dist после AR_EDITIONS=pilot node scripts/build/editions.mjs)
// Видео карты: QA_MEDIA=…/still.y4m (по умолчанию bench-out/qa/media/still.y4m из scripts/qa/run.mjs).
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const DIST = path.resolve(argv[0] && !argv[0].startsWith('--') ? argv[0] : path.join(root, 'dist'));
const LABEL = argv[1] && !argv[1].startsWith('--') ? argv[1] : path.basename(DIST);
const RUNS = Number(opt('--runs', 2));
const CPU = Number(opt('--cpu', 1));
const PUB = path.join(root, 'public');
const MEDIA = process.env.QA_MEDIA || path.join(root, 'bench-out/qa/media/still.y4m');
const CACHE = process.env.AR_MODEL_CACHE || path.join(root, '.cache/model-opt');
// --net fast4g — пресет «Fast 4G» (165 мс, ~1,1 МБ/с) для сравнения
const FAST4G = { offline: false, latency: 165, downloadThroughput: (9 * 1024 * 1024 / 8) * 0.9, uploadThroughput: (1.5 * 1024 * 1024 / 8) * 0.9 };
const NET = opt('--net', 'slow4g');
const SLOW4G = { offline: false, latency: 562.5, downloadThroughput: (1.6 * 1024 * 1024 / 8) * 0.9, uploadThroughput: (750 * 1024 / 8) * 0.9 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ktx2': 'image/ktx2', '.txt': 'text/plain' };
const ZIP = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt', '.wasm']);
const file = (base, p) => {
  const f = path.join(base, p);
  if (!f.startsWith(base)) return null;
  return fs.existsSync(f) && fs.statSync(f).isFile() ? f : null;
};
const optCached = (p) => {
  const m = /\/opt\/[^/]+\.([0-9a-f]{10})\.glb$/.exec(p);
  if (!m || !fs.existsSync(CACHE)) return null;
  const n = fs.readdirSync(CACHE).find((x) => x.startsWith(m[1]));
  return n ? path.join(CACHE, n) : null;
};
const gz = new Map();
const srv = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.startsWith('/api/')) return void (res.writeHead(204), res.end());
  let f = file(DIST, p) || file(PUB, p) || optCached(p);
  if (!f && p.startsWith('/mvp') && (!path.extname(p) || p.endsWith('/'))) f = file(DIST, '/mvp/index.html');
  if (!f) return void (res.writeHead(404), res.end());
  const ext = path.extname(f);
  const h = { 'Content-Type': TYPES[ext] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' };
  if (ZIP.has(ext) && /gzip/.test(req.headers['accept-encoding'] ?? '')) {
    if (!gz.has(f)) gz.set(f, zlib.gzipSync(fs.readFileSync(f), { level: 6 }));
    res.writeHead(200, { ...h, 'Content-Encoding': 'gzip' });
    return void res.end(gz.get(f));
  }
  res.writeHead(200, h);
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  headless: true,
  protocolTimeout: 300000,
  args: [
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${MEDIA}`,
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required',
    '--lang=ru-RU', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  ],
});

/** кнопки входа: первая видимая — «экран с кнопкой»; wake — та, что открывает камеру */
const BTN = '[data-a="ob-next"], [data-a="wake"]';

async function run(readMs) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1');
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', NET === 'fast4g' ? FAST4G : SLOW4G);
  if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  let bytes = 0;
  const urls = new Map(), done = [];
  cdp.on('Network.requestWillBeSent', (e) => urls.set(e.requestId, e.request.url));
  cdp.on('Network.loadingFinished', (e) => {
    bytes += e.encodedDataLength;
    done.push({ url: (urls.get(e.requestId) ?? '').replace(base, ''), kb: Math.round(e.encodedDataLength / 1024), at: Date.now() });
  });
  const navAt = Date.now();
  await page.evaluateOnNewDocument((sel) => {
    const t = (window.__spd = {});
    const vis = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 20 && r.height > 20 && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.5 && !el.closest('.hidden');
    };
    const tick = () => {
      if (!t.btn && [...document.querySelectorAll(sel)].some(vis)) t.btn = performance.now();
      if (!t.ready && window.__app?.input) t.ready = performance.now();
      const a = window.__app;
      if (!t.cam && (a?.tracker?.video?.readyState ?? 0) >= 2) t.cam = performance.now();
      if (!t.cat && a?.stage?.root?.visible && a?.tracker?.isTracking) t.cat = performance.now();
      if (!t.cat) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    document.addEventListener('DOMContentLoaded', tick);
  }, BTN);
  const url = `${base}/mvp/?progress=0&noanalytics&mic=ptt`;
  void page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => undefined);
  const until = async (fn, ms, arg) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try {
        const v = await page.evaluate(fn, arg);
        if (v) return v;
      } catch {
        /* навигация */
      }
      await wait(50);
    }
    return null;
  };
  await until(() => window.__spd?.btn, 60000);
  const bytesBtn = bytes;
  if (readMs) await wait(readMs);
  // касания до камеры: «Познакомиться» … → «Открыть камеру» (старый вход) или сразу кнопка (новый)
  let taps = 0, tapAt = 0;
  for (let i = 0; i < 8 && !tapAt; i++) {
    const r = await until(() => {
      const vis = (el) => el && el.getBoundingClientRect().width > 20 && !el.closest('.hidden') && getComputedStyle(el).display !== 'none' && !el.disabled;
      const w = [...document.querySelectorAll('[data-a="wake"]')].find(vis);
      const n = [...document.querySelectorAll('[data-a="ob-next"]')].find(vis);
      const b = w || n;
      if (!b) return null;
      const rc = b.getBoundingClientRect();
      return { x: rc.x + rc.width / 2, y: rc.y + rc.height / 2, wake: !!w };
    }, 60000);
    if (!r) break;
    await page.touchscreen.tap(r.x, r.y);
    taps++;
    if (r.wake) tapAt = await page.evaluate(() => performance.now());
    else await wait(450);
  }
  // старый вход: пока App.init не прошёл, «Открыть камеру» молчит — ребёнок жмёт ещё раз (раз в 1,5 с)
  for (let i = 0; i < 200; i++) {
    await wait(1500);
    const st = await page.evaluate(() => ({ started: !!window.__app?.tracker?.video || window.__app?.director?.state.phase !== 'start', quick: !!document.querySelector('#quick .q-cta.busy') })).catch(() => ({ started: false }));
    if (st.started || st.quick) break;
    const r = await page.evaluate(() => {
      const b = [...document.querySelectorAll('[data-a="wake"]')].find((el) => el.getBoundingClientRect().width > 20 && !el.closest('.hidden'));
      if (!b) return null;
      const rc = b.getBoundingClientRect();
      return { x: rc.x + rc.width / 2, y: rc.y + rc.height / 2 };
    });
    if (!r) break;
    await page.touchscreen.tap(r.x, r.y);
    taps++;
    tapAt = await page.evaluate(() => performance.now());
  }
  await until(() => window.__spd?.cat, 180000);
  const t = await page.evaluate(() => window.__spd);
  if (!t.cat) console.log('  нет кота:', await page.evaluate(() => JSON.stringify({ v: window.__app?.tracker?.video?.readyState, ph: window.__app?.director?.state.phase, start: !!document.querySelector('.start:not(.hidden)'), err: document.querySelector('.screen.error:not(.hidden)')?.textContent?.slice(0, 80) })));
  const top = done.filter((d) => d.kb > 40).sort((a, b) => b.kb - a.kb).slice(0, 14).map((d) => `${d.kb} КБ ${((d.at - navAt) / 1000).toFixed(1)} с ${d.url.slice(0, 70)}`);
  if (process.argv.includes('--files')) console.log(top.join('\n'));
  if (process.argv.includes('--timeline')) console.log(done.filter((d) => d.kb >= 5).sort((a, b) => a.at - b.at).map((d) => `${((d.at - navAt) / 1000).toFixed(1)} с ${d.kb} КБ ${d.url.slice(0, 80)}`).join('\n'));
  const res = { readMs, taps, top, btn: t.btn, ready: t.ready, tap: tapAt, cam: t.cam, cat: t.cat, kbBtn: Math.round(bytesBtn / 1024), kbCat: Math.round(bytes / 1024) };
  await ctx.close();
  return res;
}

const out = [];
for (const readMs of String(opt('--reads', '0,4000')).split(',').map(Number)) for (let i = 0; i < RUNS; i++) {
  const r = await run(readMs);
  out.push(r);
  const s = (v) => (v ? (v / 1000).toFixed(2) : '—');
  console.log(`${LABEL} [${NET}] ${readMs ? 'прочитал 4 с' : 'сразу'} #${i + 1}: кнопка ${s(r.btn)} с, готово ${s(r.ready)} с, касаний ${r.taps}, нажал ${s(r.tap)} с, камера ${s(r.cam)} с, кот ${s(r.cat)} с (кот после камеры ${r.cat && r.cam ? ((r.cat - r.cam) / 1000).toFixed(2) : '—'} с), КБ к кнопке ${r.kbBtn}, к коту ${r.kbCat}`);
}
fs.mkdirSync(path.join(root, 'bench-out'), { recursive: true });
fs.writeFileSync(path.join(root, `bench-out/quick-speed-${LABEL}-${NET}.json`), JSON.stringify({ label: LABEL, network: NET, cpu: CPU, runs: out }, null, 1));
await browser.close();
srv.close();
