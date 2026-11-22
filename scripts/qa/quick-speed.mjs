#!/usr/bin/env node
// Скорость входа пилота (/mvp) на «медленном 4G» (пресет Chrome DevTools «Slow 4G»: 562,5 мс задержки, ~180 КБ/с вниз,
// ~84 КБ/с вверх), iPhone-вьюпорт 390×844, холодный кэш (новый профиль на каждый прогон).
// Что меряем (мс от начала навигации):
//   btn    — на экране видна первая кнопка (старый вход: «Познакомиться», новый: «Узнать, кто там»);
//   ready  — приложение готово (App.init прошёл: window.__app.input; старый вход до этого на «Открыть камеру» не реагирует);
//   tap    — нажатие, которое открывает камеру (старый вход — 4-е касание, новый — 1-е);
//   cam    — видео камеры пошло (разрешение — сразу, --use-fake-ui-for-media-stream);
//   cat    — кот на карте: приложение готово, сценарий после поиска, корень сцены виден (в пробуждении — кот уже вылетел
//            из карты: stage.intro.scale > 0), карта в кадре — два кадра подряд; карта — still.y4m из QA-стенда;
//   track  — карта нашлась (поиск теперь идёт и до готовности приложения);
//   appear — пробуждение пошло: кот скачан и разобран, карта найдена (дальше 1,55 с сцены до вылета кота);
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
const NET_TAG = NET + (opt('--encode', '') === 'all' ? '-encode' : '');
const SLOW4G = { offline: false, latency: 562.5, downloadThroughput: (1.6 * 1024 * 1024 / 8) * 0.9, uploadThroughput: (750 * 1024 / 8) * 0.9 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ktx2': 'image/ktx2', '.txt': 'text/plain' };
// --encode all — сервер жмёт и модели/движения (.glb/.bin/.ktx2/.mind), как после scripts/deploy/caddy-encode.sh;
// по умолчанию — как прод до правки: Caddy `encode` по своему списку типов (текст, json, js, wasm), .glb — без сжатия
const ENC_ALL = opt('--encode', '') === 'all';
const ZIP = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt', '.wasm', ...(ENC_ALL ? ['.glb', '.bin', '.ktx2', '.mind'] : [])]);
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
  // --console — сообщения страницы с временем (что делает приложение между загрузкой и котом)
  if (argv.includes('--console')) page.on('console', (m) => console.log(`  ${((Date.now() - navAt) / 1000).toFixed(2)} с [${m.type()}] ${m.text().slice(0, 160)}`));
  if (argv.includes('--console')) await page.evaluateOnNewDocument(() => (window.__spdConsole = true));
  if (argv.includes('--trace')) await page.evaluateOnNewDocument(() => (window.__spdTrace = true));
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
      if (!t.track && a?.tracker?.isTracking) t.track = performance.now();
      // кот на карте: приложение готово, сценарий после поиска (пробуждение пошло), корень сцены виден, карта в кадре
      // (поиск карты теперь идёт и до готовности приложения — корень сцены тогда ещё не прятали)
      // + в пробуждении — кот уже вылетел из карты (stage.intro.scale > 0); два кадра подряд (кадр приложения мог ещё
      // не пройти после смены фазы)
      const ph = a?.director?.state?.phase;
      const it = a?.stage?.intro;
      const on = !!a?.input && ph && ph !== 'start' && ph !== 'scanning' && a?.stage?.root?.visible && (!it || it.scale > 0.001) && a?.tracker?.isTracking;
      // пробуждение пошло (кот скачан и разобран, карта найдена — сцена «из карты» началась); дальше — 1,55 с сцены до
      // вылета кота (src/awake/timeline.ts tPop), на swiftshader стенда — дольше: первые кадры с мехом и компиляция шейдеров
      if (!t.appear && a?.input && ph && ph !== 'start' && ph !== 'scanning') t.appear = performance.now();
      if (t.appear && !t.cat) t.fr = (t.fr ?? 0) + 1; // кадров от пробуждения до кота (на телефоне 30–60 к/с)
      t.onN = on ? (t.onN ?? 0) + 1 : 0;
      if (!t.cat && t.onN >= 2) t.cat = performance.now();
      // --trace: состояние раз в 250 мс (фаза, карта, корень, масштаб пробуждения) — где кот ждёт
      if (window.__spdTrace && (!t.lastTr || performance.now() - t.lastTr > 250)) {
        t.lastTr = performance.now();
        console.debug(`[trace] ${ph} track=${!!a?.tracker?.isTracking} vis=${!!a?.stage?.root?.visible} intro=${it ? it.scale.toFixed(2) : '-'} ready=${!!a?.input}`);
      }
      if (!t.cat) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    document.addEventListener('DOMContentLoaded', tick);
    // --console: лог режиссёра в консоль (одна подписка, как только появится приложение)
    const hook = setInterval(() => {
      const d = window.__app?.director;
      if (!d?.on) return;
      clearInterval(hook);
      if (window.__spdConsole) d.on('log', (m) => console.debug('[dir] ' + m));
    }, 50);
  }, BTN);
  // --q N — уровень качества (?q=N: мех, чёткость): на swiftshader стенда первые кадры с мехом идут секундами
  const url = `${base}/mvp/?progress=0&noanalytics&mic=ptt${opt('--q', '') !== '' ? '&q=' + opt('--q') : ''}${opt('--params', '') ? '&' + opt('--params') : ''}`;
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
  // --profile: профиль ЦП от готовности приложения до кота (bench-out/quick-speed-profile.json: топ по своему времени)
  if (argv.includes('--profile')) {
    await until(() => window.__spd?.ready, 180000);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
    await cdp.send('Profiler.start');
  }
  await until(() => window.__spd?.cat, 180000);
  if (argv.includes('--profile')) {
    const { profile } = await cdp.send('Profiler.stop');
    const self = new Map();
    const dt = profile.timeDeltas ?? [];
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    profile.samples.forEach((id, i) => {
      const n = byId.get(id);
      const k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.replace(/^.*\//, '')}:${n.callFrame.lineNumber}`;
      self.set(k, (self.get(k) ?? 0) + (dt[i] ?? 0) / 1000);
    });
    const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 25);
    console.log(top.map(([k, ms]) => `${ms.toFixed(0).padStart(6)} мс  ${k}`).join('\n'));
  }
  const t = await page.evaluate(() => window.__spd);
  if (!t.cat) console.log('  нет кота:', await page.evaluate(() => JSON.stringify({ v: window.__app?.tracker?.video?.readyState, ph: window.__app?.director?.state.phase, start: !!document.querySelector('.start:not(.hidden)'), err: document.querySelector('.screen.error:not(.hidden)')?.textContent?.slice(0, 80) })));
  // один файл дважды (до кота) — дубль загрузки
  const seen = new Map();
  for (const d of done) if (d.kb > 1) seen.set(d.url.replace(/\?.*$/, ''), (seen.get(d.url.replace(/\?.*$/, '')) ?? 0) + 1);
  const dups = [...seen].filter(([, n]) => n > 1).map(([u, n]) => `${u} ×${n}`);
  const top = done.filter((d) => d.kb > 40).sort((a, b) => b.kb - a.kb).slice(0, 14).map((d) => `${d.kb} КБ ${((d.at - navAt) / 1000).toFixed(1)} с ${d.url.slice(0, 70)}`);
  if (process.argv.includes('--files')) console.log(top.join('\n'));
  if (process.argv.includes('--timeline')) console.log(done.filter((d) => d.kb >= 5).sort((a, b) => a.at - b.at).map((d) => `${((d.at - navAt) / 1000).toFixed(1)} с ${d.kb} КБ ${d.url.slice(0, 80)}`).join('\n'));
  const res = { readMs, taps, top, btn: t.btn, ready: t.ready, tap: tapAt, cam: t.cam, track: t.track, appear: t.appear, cat: t.cat, fr: t.fr, dups, kbBtn: Math.round(bytesBtn / 1024), kbCat: Math.round(bytes / 1024) };
  await ctx.close();
  return res;
}

const out = [];
for (const readMs of String(opt('--reads', '0,4000')).split(',').map(Number)) for (let i = 0; i < RUNS; i++) {
  const r = await run(readMs);
  out.push(r);
  const s = (v) => (v ? (v / 1000).toFixed(2) : '—');
  console.log(`${LABEL} [${NET_TAG}] ${readMs ? 'прочитал 4 с' : 'сразу'} #${i + 1}: кнопка ${s(r.btn)} с, готово ${s(r.ready)} с, касаний ${r.taps}, нажал ${s(r.tap)} с, камера ${s(r.cam)} с, карта ${s(r.track)} с, пробуждение ${s(r.appear)} с, кот ${s(r.cat)} с (${r.fr ?? '—'} кадров от пробуждения) (кот после камеры ${r.cat && r.cam ? ((r.cat - r.cam) / 1000).toFixed(2) : '—'} с), КБ к кнопке ${r.kbBtn}, к коту ${r.kbCat}${r.dups.length ? `, ДУБЛИ: ${r.dups.join(', ')}` : ', дублей нет'}`);
}
fs.mkdirSync(path.join(root, 'bench-out'), { recursive: true });
fs.writeFileSync(path.join(root, `bench-out/quick-speed-${LABEL}-${NET_TAG}.json`), JSON.stringify({ label: LABEL, network: NET, cpu: CPU, runs: out }, null, 1));
await browser.close();
srv.close();
