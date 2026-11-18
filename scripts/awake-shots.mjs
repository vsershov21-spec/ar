#!/usr/bin/env node
// Снимки сцены пробуждения кота (src/awake): покадрово docs/ui/awake_<кот>_<NN>_<t>.png (8 кадров на кота)
// и видео-превью docs/ui/awake_<кот>.webm (+ короткая версия повторного визита awake_<кот>_short.webm).
// Плюс замер главного потока на старте сцены (время кадра, работа сцены, новые шейдеры в первые 0,6 с) — docs/ui/awake_perf.json.
//
//   node scripts/awake-shots.mjs [--url http://localhost:5173/] [--cats hooligan,kind,glitter] [--slow 0.2] [--no-video]
//
// Страница — ?debug (трекер-заглушка: карта на «столе», без камеры). Headless Chrome рисует программно (SwiftShader) —
// медленно, поэтому вся страница идёт в замедленном времени: performance.now/Date/rAF-время и таймеры ×slow,
// а снятое видео ускоряется обратно (ffmpeg setpts). Без --url собирает bench-out/awake/dist и поднимает vite preview (--no-build — без пересборки).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const CATS = arg('--cats', 'hooligan,kind,glitter').split(',');
const SLOW = Number(arg('--slow', 0.2));
const VIDEO = !argv.includes('--no-video');
const OUT = path.join(root, 'docs/ui');
const TMP = path.join(root, 'bench-out/awake');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[awake]', ...a);

let server = null;
let URL0 = arg('--url', null);
if (!URL0) {
  const port = 4377;
  // сборка (dev-сервер перезагружал бы страницу при правках соседних файлов)
  const dist = path.join(TMP, 'dist');
  if (!argv.includes('--no-build')) {
    log('сборка → bench-out/awake/dist');
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
  protocolTimeout: 600_000,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--lang=ru-RU', '--mute-audio',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

/** замедленное время страницы: всё (рендер, клипы, таймеры сценария) идёт в slow раз медленнее */
function slowTime(S) {
  const pn = performance.now.bind(performance);
  const t0 = pn();
  let k = 1;
  window.__slow = (v) => {
    const now = pn();
    base = virt();
    anchor = now;
    k = v;
  };
  let base = t0, anchor = t0;
  const virt = () => base + (pn() - anchor) * k;
  performance.now = () => virt();
  const d0 = Date.now();
  Date.now = () => d0 + (virt() - t0);
  const st = window.setTimeout.bind(window), si = window.setInterval.bind(window);
  window.setTimeout = (f, ms = 0, ...a) => st(f, (ms || 0) / k, ...a);
  window.setInterval = (f, ms = 0, ...a) => si(f, (ms || 0) / k, ...a);
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf(() => cb(virt()));
  window.__slow(S);
  // покадровая запись: время стоит (k = 0), шаг — ровно ms виртуального времени
  window.__advance = (ms) => {
    base += ms;
  };
  // длинные задачи главного потока (реальное время)
  window.__long = [];
  try {
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push({ at: pn(), ms: e.duration }))).observe({ type: 'longtask', buffered: true });
  } catch {}
  window.__realNow = pn;
}

async function open(cat, fresh) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  page.on('pageerror', (e) => log(`pageerror ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/502|archive/.test(m.text()) && log('console.error', m.text().slice(0, 200)));
  await page.evaluateOnNewDocument(() => localStorage.clear());
  await page.goto(`${URL0}?debug&cat=${cat}${fresh ? '&fresh' : ''}`, { waitUntil: 'networkidle0', timeout: 120000 });
  await page.waitForFunction(() => window.__app?.director && window.__awake && window.__debugPanel, { timeout: 120000 });
  await page.evaluate(() => window.__debugPanel.open(false));
  // модель кота загружена
  await page.waitForFunction(() => window.__app.character?.object?.children?.length > 0, { timeout: 120000 });
  return page;
}

const perf = {};

/** кадры: от начала (свечение, столб), полёт, приземление, салют, глаза, машет — по моментам плана образа */
const frameTimes = (p) => {
  const f = p.tLand - p.tPop;
  return [0.4, 1.2, p.tPop + 0.12, p.tPop + f * 0.42, p.tLand + 0.12, p.tLand + 0.75, p.tLand + 1.55, p.tLand + 2.45];
};

async function replay(page, kind) {
  await page.evaluate((k) => window.__awake.replay(k), kind);
}
const sceneT = (page) => page.evaluate(() => window.__awake.run?.t ?? null);

for (const cat of CATS) {
  log(`— ${cat}`);
  const page = await open(cat, true);
  // 1) главный поток на настоящей первой посадке: время кадра, работа сцены, новые шейдеры в первые 0,6 с
  await page.evaluate(() => {
    const aw = window.__awake, app = window.__app;
    const m = (window.__m = { upd: [], frame: [], play: null, progAtPlay: 0, long: [] });
    const wrap = (o, k, cb) => {
      const f = o[k].bind(o);
      o[k] = (...a) => {
        const t = performance.now();
        const r = f(...a);
        cb(t, performance.now() - t);
        return r;
      };
    };
    wrap(aw, 'update', (at, ms) => m.upd.push({ at, ms }));
    wrap(app, 'frame', (at, ms) => m.frame.push({ at, ms }));
    const play = aw.play.bind(aw);
    aw.play = (...a) => {
      m.progAtPlay = app.renderer.info.programs?.length ?? 0;
      const t = performance.now();
      const r = play(...a);
      m.play = performance.now() - t;
      return r;
    };
    try {
      new PerformanceObserver((l) => l.getEntries().forEach((e) => m.long.push({ at: e.startTime, ms: e.duration }))).observe({ type: 'longtask' });
    } catch {}
  });
  await page.evaluate(() => document.querySelector('[data-a="wake"]')?.click());
  await page.waitForFunction(() => window.__awake.played > 0, { timeout: 60000 });
  await page.waitForFunction(() => !window.__awake.active, { timeout: 120000 });
  const r = await page.evaluate(() => {
    const m = window.__m, s = window.__awake.startedAt;
    const inWin = (e) => e.at >= s - 20 && e.at <= s + 600;
    const med = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
    const fr = m.frame.filter(inWin).map((e) => e.ms), later = m.frame.filter((e) => e.at > s + 600).map((e) => e.ms);
    const r1 = (x) => Math.round(x * 10) / 10;
    return {
      playMs: r1(m.play), updMaxMs: r1(Math.max(0, ...m.upd.map((e) => e.ms))), updMedianMs: r1(med(m.upd.map((e) => e.ms))),
      frameMaxStartMs: r1(Math.max(0, ...fr)), frameMedianStartMs: r1(med(fr)), frameMedianLaterMs: r1(med(later)), framesStart: fr.length,
      newProgramsAtStart: (window.__app.renderer.info.programs?.length ?? 0) - m.progAtPlay,
      longTasksStart: m.long.filter(inWin).map((e) => Math.round(e.ms)),
      saluteMaxParts: window.__awake.salute.peak,
      after: { salute: window.__awake.salute.active, display: window.__awake.salute.canvas.style.display, parts: window.__awake.scene.particlesLive },
    };
  });
  // то же на перезапуске сцены (без жеста «Разбудить» и открытия камеры в том же окне): чистая цена старта сцены
  const r2 = await page.evaluate(async () => {
    const m = window.__m;
    m.upd.length = 0;
    m.frame.length = 0;
    m.long.length = 0;
    // фон: 1,5 с кот просто стоит (та же сцена, тот же рендер) — для сравнения
    const b0 = performance.now();
    await new Promise((res) => setTimeout(res, 1500));
    const base = { long: m.long.filter((e) => e.at >= b0 + 900).map((e) => Math.round(e.ms)), frameMax: Math.max(0, ...m.frame.filter((e) => e.at >= b0 + 900).map((e) => e.ms)) };
    window.__awake.replay('first');
    const s = window.__awake.startedAt;
    await new Promise((res) => setTimeout(res, 1500));
    const inWin = (e) => e.at >= s - 20 && e.at <= s + 600;
    const r1 = (x) => Math.round(x * 10) / 10;
    const up = m.upd.filter(inWin);
    return {
      replayPlayMs: r1(m.play), replayUpdMaxMs: r1(Math.max(0, ...up.map((e) => e.ms))), replayFrameMaxMs: r1(Math.max(0, ...m.frame.filter(inWin).map((e) => e.ms))),
      replayLongTasks: m.long.filter(inWin).map((e) => Math.round(e.ms)), replayFrames: m.frame.filter(inWin).length,
      baselineLongTasks600ms: base.long, baselineFrameMaxMs: r1(base.frameMax),
    };
  });
  await page.waitForFunction(() => !window.__awake.active, { timeout: 120000 });
  Object.assign(r, r2);
  perf[cat] = r;
  log('замер', JSON.stringify(r));
  if (argv.includes('--perf-only')) {
    await page.close();
    continue;
  }

  // 2) сценарий на паузе, интерфейс знакомства спрятан — сцену перезапускаем на месте в замедленном времени
  await page.evaluate(() => {
    const d = window.__app.director;
    d.timers?.forEach?.((t) => clearTimeout(t));
    d.queue?.clear?.();
    window.__app.voice?.cancel?.();
    d.paused = true;
    const st = document.createElement('style');
    st.textContent = '.bubble,.name-sheet,.sheet,.coach,.toast,.nudge,.chips,.dbg-tab,.dbg{visibility:hidden!important}';
    document.head.appendChild(st);
  });
  await page.evaluate(slowTime, SLOW);
  await sleep(500);
  // стоп-кадр точно в момент: после awake.update (до отрисовки кадра) время страницы — на паузу
  await page.evaluate(() => {
    const aw = window.__awake;
    const upd = aw.update.bind(aw);
    aw.update = (dt) => {
      upd(dt);
      if (window.__freezeAt != null && aw.run && aw.run.t >= window.__freezeAt) {
        window.__slow(0);
        window.__frozenAt = aw.run.t;
        window.__freezeAt = null;
      }
    };
  });
  await replay(page, 'first');
  const P = await page.evaluate(() => ({ tPop: window.__awake.run.plan.tPop, tLand: window.__awake.run.plan.tLand }));
  const times = frameTimes(P);
  await page.evaluate((t) => (window.__freezeAt = t), times[0]);
  for (let i = 0; i < times.length; i++) {
    await page.waitForFunction(() => window.__frozenAt != null, { timeout: 180000, polling: 50 });
    await sleep(400); // кадр с замершим временем дорисован
    const t = await page.evaluate(() => window.__frozenAt);
    await page.screenshot({ path: path.join(OUT, `awake_${cat}_${String(i + 1).padStart(2, '0')}.png`) });
    log(`  кадр ${i + 1} t=${t.toFixed(2)} с`);
    await page.evaluate(
      (next, S) => {
        window.__frozenAt = null;
        window.__freezeAt = next;
        window.__slow(S);
      },
      times[i + 1] ?? null,
      SLOW,
    );
  }
  await page.waitForFunction(() => !window.__awake.active, { timeout: 180000, polling: 200 });
  // 3) видео: полная сцена и короткая (повторный визит) — покадрово: время стоит, шаг 1/30 с, снимок каждого кадра
  //    (запись экрана в реальном времени в headless-рендере дала бы 3–5 к/с)
  if (VIDEO)
    for (const kind of ['first', 'short']) {
      const name = `awake_${cat}${kind === 'short' ? '_short' : ''}`;
      const dir = path.join(TMP, name);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      await page.evaluate(() => window.__slow(0));
      const frame = async (n) => {
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        await page.screenshot({ path: path.join(dir, `${String(n).padStart(4, '0')}.jpg`), type: 'jpeg', quality: 88 });
      };
      let n = 0;
      // 0,3 с до сцены (кот стоит), сцена, 0,5 с после (экран чистый)
      for (let i = 0; i < 9; i++) {
        await page.evaluate(() => window.__advance(1000 / 30));
        await frame(n++);
      }
      await replay(page, kind);
      let tail = 0;
      for (let guard = 0; guard < 600 && tail < 15; guard++) {
        await page.evaluate(() => window.__advance(1000 / 30));
        await frame(n++);
        if (!(await page.evaluate(() => window.__awake.active))) tail++;
      }
      const out = path.join(OUT, `${name}.webm`);
      const rr = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '30', '-i', path.join(dir, '%04d.jpg'), '-vf', 'scale=390:-2', '-c:v', 'libvpx-vp9', '-b:v', '1400k', '-pix_fmt', 'yuv420p', '-an', out]);
      if (rr.status) log('ffmpeg', rr.stderr?.toString().slice(0, 300));
      else log(`  видео ${path.relative(root, out)}: ${n} кадров, ${Math.round(fs.statSync(out).size / 1024)} КБ`);
      await page.evaluate((S) => window.__slow(S), SLOW);
    }
  await page.close();
}
fs.writeFileSync(path.join(OUT, 'awake_perf.json'), JSON.stringify(perf, null, 1));
await browser.close();
server?.kill();
