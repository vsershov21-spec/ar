#!/usr/bin/env node
// Снимки UX пилота (/mvp) на iPhone-вьюпорте 390×844: онбординг, игра, подсказки «нажми сюда», запотевшее стекло,
// дом, карточка СберKids → docs/qa/ui/<PHASE>_<что>.jpg (PHASE=before|after, по умолчанию after); интро покадрово —
// docs/qa/ui/intro/<PHASE>_NN_<шаг>.jpg.
// Запуск: AR_EDITIONS=pilot node scripts/build/editions.mjs && PHASE=after node scripts/ux-shots.mjs [ob,play,glass,home,kids]
// Сервер — свой: /mvp/* → dist/mvp (SPA-фолбэк), остальное (модели, звуки) — из public/, как на проде из корня.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(root, 'dist');
const PUB = path.join(root, 'public');
const outDir = path.join(root, 'docs/qa/ui');
fs.mkdirSync(outDir, { recursive: true });
const PHASE = process.env.PHASE || 'after';
const only = (process.argv[2] || 'ob,play,glass,home,kids,intro').split(',');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ktx2': 'image/ktx2' };
const file = (base, p) => {
  const f = path.join(base, p);
  if (!f.startsWith(base)) return null;
  if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
  return null;
};
// сжатые модели (models/opt/<имя>.<хэш10>.glb) — из кэша model-opt (.cache/model-opt/<sha1>.glb), если dist/models/opt нет
const CACHE = process.env.AR_MODEL_CACHE || path.join(root, '.cache/model-opt');
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

async function open(name, { met = true, cat = 'hooligan', wake = true, card = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  page.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));
  await page.evaluateOnNewDocument((met) => {
    if (sessionStorage.getItem('__shots')) return;
    sessionStorage.setItem('__shots', '1');
    localStorage.clear();
    if (met) {
      localStorage.setItem('pilot:sber-ar-cat:v1', JSON.stringify({ name: null, persona: null, visits: 3, lastVisitAt: Date.now() - 3600_000, met: true }));
      localStorage.setItem('pilot:ar.catalog.tried', JSON.stringify(['pet', 'tickle', 'treat']));
    }
  }, met);
  await page.goto(`${base}/mvp/?from=test${card ? '' : '&nocard=off'}&cat=${cat}&progress=0&q=0&mic=ptt&noanalytics`, { waitUntil: 'networkidle0', timeout: 90000 });
  if (!card) await page.waitForFunction(() => window.__app?.home && window.__edition === 'pilot', { timeout: 60000 });
  else await page.waitForFunction(() => !!document.querySelector('.ob-next'), { timeout: 60000 });
  const until = async (fn, ms = 120000, arg) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await page.evaluate(fn, arg)) return true;
      await wait(100);
    }
    throw new Error('не дождался: ' + fn);
  };
  if (wake) {
    await page.evaluate(() => {
      // онбординг: сразу последний шаг (кнопка «Открыть камеру»)
      const b = document.querySelector('[data-a="wake"]');
      b?.click();
    });
    await until(() => ['play', 'free'].includes(window.__app.director.state.phase) && !window.__app.director.queue.busy && !window.__app.awake?.active);
    await wait(1500);
  }
  return { page, until };
}
const shot = async (page, name) => {
  const f = path.join(outDir, `${PHASE}_${name}.jpg`);
  await page.screenshot({ path: f, type: 'jpeg', quality: 80 });
  console.log('  ✓', path.relative(root, f));
};

if (only.includes('ob')) {
  const { page } = await open('ob', { met: false, wake: false });
  await wait(800);
  for (let i = 1; i <= 5; i++) {
    await shot(page, `ob_${i}`);
    const has = await page.evaluate(() => {
      const b = document.querySelector('.ob-next');
      if (!b || b.classList.contains('hidden') || getComputedStyle(b).display === 'none') return false;
      b.click();
      return true;
    });
    if (!has) break;
    await wait(700);
  }
  await page.close();
}

if (only.includes('play')) {
  // первая встреча: после онбординга и знакомства — подсказки «нажми сюда» по главным кнопкам
  const { page, until } = await open('play', { met: true });
  await shot(page, 'play');
  await wait(2500);
  await shot(page, 'play_hint');
  await wait(3000);
  await shot(page, 'play_hint2');
  // бездействие ~9 с — подсказка на кнопке
  await wait(10000);
  await shot(page, 'play_idle');
  await page.close();
  void until;
}

if (only.includes('glass')) {
  const { page } = await open('glass', { met: true, cat: 'hooligan' });
  await page.evaluate(() => {
    const app = window.__app;
    const it = app.ui.catalogGroups().flatMap((g) => g.items).find((i) => i.id === 'glass');
    if (it) app.runCatalogItem(it);
  });
  await wait(1200);
  await shot(page, 'glass_press');
  await wait(2600);
  // headless (swiftshader) рисует кадр секундами: туман держим дольше, чтобы снимки успели
  await page.evaluate(() => {
    const fb = window.__app.fogBoard;
    fb.o.lifeMs = fb.o.maxMs = 900000;
    if (!fb.on) window.__app.startFog({ x: 195, y: 360 });
  });
  await shot(page, 'glass_fog');
  // палец рисует (два штриха) — настоящие касания
  const t = page.touchscreen;
  const stroke = async (pts) => {
    await t.touchStart(pts[0][0], pts[0][1]);
    for (const [x, y] of pts.slice(1)) {
      await t.touchMove(x, y);
      await wait(16);
    }
    await t.touchEnd();
  };
  const heart = [];
  for (let k = 0; k <= 40; k++) {
    const a = (k / 40) * Math.PI * 2;
    heart.push([195 + 90 * Math.pow(Math.sin(a), 3), 380 - (70 * Math.cos(a) - 28 * Math.cos(2 * a) - 12 * Math.cos(3 * a) - 4 * Math.cos(4 * a))]);
  }
  await stroke(heart);
  await stroke([[90, 560], [150, 600], [210, 560], [270, 600], [320, 560]]);
  await wait(400);
  console.log('  туман:', await page.evaluate(() => JSON.stringify({ on: window.__app.fogBoard?.on, drawn: Math.round(window.__app.fogBoard?.drawn ?? -1), strokes: window.__app.fogBoard?.strokes })));
  await shot(page, 'glass_draw');
  await page.evaluate(() => document.querySelector('.fogb-wipe')?.click());
  await wait(2500);
  await shot(page, 'glass_after');
  await page.close();
}

if (only.includes('home')) {
  const { page, until } = await open('home', { met: true, cat: 'kind' });
  await page.evaluate(() => window.__app.home.enter('chip'));
  await until(() => window.__app.home.phase === 'home');
  await wait(3500);
  await shot(page, 'home');
  await page.evaluate(() => window.__app.home.go('bedroom'));
  await until(() => !window.__app.home.moving);
  await wait(1500);
  await shot(page, 'home_bedroom');
  await wait(6000);
  await shot(page, 'home_later');
  await page.close();
}

if (only.includes('kids')) {
  const { page } = await open('kids', { met: true, cat: 'glitter' });
  await page.evaluate(() => window.__app.kidsOffer?.force?.('play'));
  await wait(1200);
  await shot(page, 'kids_chip');
  await page.evaluate(() => document.querySelector('.kids-card [data-k="go"]')?.click());
  await wait(800);
  await shot(page, 'kids_tap');
  await page.close();
}

if (only.includes('intro')) {
  // интро покадрово: онбординг → камера → поиск карты (кандидат подаётся вручную — в headless карты нет) → пробуждение → имя
  const dir = path.join(outDir, 'intro');
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  const frame = async (page, tag) => {
    const f = path.join(dir, `${PHASE}_${String(++n).padStart(2, '0')}_${tag}.jpg`);
    await page.screenshot({ path: f, type: 'jpeg', quality: 70 });
  };
  {
    const { page } = await open('intro-card', { met: false, wake: false, card: true });
    await wait(600);
    await frame(page, 'ob1');
    for (let i = 2; i <= 4; i++) {
      const more = await page.evaluate(() => {
        const b = document.querySelector('.ob-next');
        if (!b || b.classList.contains('hidden')) return false;
        b.click();
        return true;
      });
      if (!more) break;
      await wait(250);
      await frame(page, `ob${i}_mid`);
      await wait(450);
      await frame(page, `ob${i}`);
    }
    await page.evaluate(() => document.querySelector('[data-a="wake"]')?.click());
    for (let i = 0; i < 4; i++) {
      await wait(450);
      await frame(page, 'camera');
    }
    await page.waitForFunction(() => window.__app?.tracker?.overlay, { timeout: 60000 });
    await wait(1500);
    await frame(page, 'search');
    await wait(4200);
    await frame(page, 'search2');
    // кандидат: карта в кадре, прогресс 0 → 1 (подаём в оверлей те же вызовы, что FSM; настоящий поиск заглушён)
    const step = (k, hint, kind = 'sber') => page.evaluate((k, hint, kind) => {
      const ov = window.__app.tracker.overlay;
      if (!window.__fakeGuide) {
        window.__fakeGuide = true;
        const g = ov.guide;
        window.__realGuide = g;
        ov.guide = function (s, p, h) { if (window.__drive) g.call(this, s, p, h); };
      }
      const pts = [{ x: 85, y: 360 }, { x: 305, y: 372 }, { x: 296, y: 512 }, { x: 78, y: 498 }];
      window.__drive = true;
      ov.candidate(pts, kind);
      ov.guide('candidate', k, hint);
      window.__drive = false;
    }, k, hint, kind);
    for (const [k, hint, kind, tag] of [[0.05, 'checking', 'checking', 'cand_check'], [0.2, 'closer', 'sber', 'cand_closer'], [0.45, 'steady', 'sber', 'cand_steady'], [0.8, 'steady', 'sber', 'cand_almost'], [0.0, 'other', 'other', 'cand_other'], [0.0, 'back', 'back', 'cand_back'], [0.0, 'notcard', 'notcard', 'cand_notcard']]) {
      for (let t = 0; t < 6; t++) {
        await step(k, hint, kind);
        await wait(70);
      }
      await frame(page, tag);
      if (tag === 'cand_almost') {
        // «нашёл!»: захват (track) — вспышка лапок и звон, потом карта «теряется» для следующих кадров
        await page.evaluate(() => {
          const ov = window.__app.tracker.overlay;
          const pts = [{ x: 85, y: 360 }, { x: 305, y: 372 }, { x: 296, y: 512 }, { x: 78, y: 498 }];
          window.__drive = true;
          ov.guide('candidate', 1, 'found');
          window.__drive = false;
          ov.track({ quad: pts, pose: null, project: () => null }, false);
        });
        await wait(120);
        await frame(page, 'found');
        await wait(250);
        await frame(page, 'found2');
        await page.evaluate(() => window.__app.tracker.overlay.lost());
        await wait(500);
      }
    }
    await page.close();
  }
  {
    // пробуждение и знакомство — кот без карты (на столе), как после посадки
    const { page } = await open('intro-meet', { met: false, wake: false });
    await page.evaluate(() => {
      const b = document.querySelector('[data-a="wake"]');
      b?.click();
    });
    for (let i = 0; i < 40; i++) {
      await wait(500);
      await frame(page, 'meet');
      if (await page.evaluate(() => !document.querySelector('.namebox')?.classList.contains('hidden'))) {
        await wait(600);
        await frame(page, 'name');
        break;
      }
    }
    await page.close();
  }
  // контактный лист всех кадров
  console.log('  ✓ кадры интро:', n);
}

if (errors.length) console.log('ошибки страницы:\n ' + errors.join('\n '));
await browser.close();
srv.close();
