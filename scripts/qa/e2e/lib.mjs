// E2E пилота (/mvp): сервер, браузер и страница-«телефон» для scripts/qa/e2e/run.mjs (docs/qa/E2E.md).
//  - сервер: dist/ (сборка pilot → dist/mvp), public/, сжатые модели из .cache/model-opt; /api/progress/* — мок,
//    который запоминает КАЖДЫЙ запрос (метод, путь, тело) — по ним сценарий «аналитика» ищет имя ребёнка;
//  - Chrome headless: фейковая камера (still.y4m — синтетическая карта Сбера на столе, scripts/bench/gen_card_video.py),
//    фейковый микрофон (тихая комната), iPhone-вьюпорт 390×844 и UA iOS;
//  - страница: прелюдия QA-стенда (scripts/qa/page-prelude.js — ускорение времени, ловушки ошибок, запрет камеры),
//    свой запрет микрофона, сбор console.error / pageerror / unhandledrejection.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import puppeteer from 'puppeteer-core';
import { qaPrelude, qaInstall } from '../page-prelude.js';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
/** тексты согласия — из config/consent.ts (одно место, которое правят юристы) */
const CONSENT_SRC = fs.readFileSync(path.join(ROOT, 'src/config/consent.ts'), 'utf8');
const consentText = (k) => (new RegExp(`\\b${k}: '([^']*)'`).exec(CONSENT_SRC) ?? [])[1] ?? '';
const CONSENT_TEXT = { checkbox: consentText('checkbox'), parent: consentText('parent'), needCheck: consentText('needCheck') };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ktx2': 'image/ktx2', '.txt': 'text/plain', '.mind': 'application/octet-stream' };
const ZIP = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt', '.wasm']);

/**
 * Режим согласия (config/consent.ts) задаётся сборкой и меняет только разметку заставки в index.html (src/quick/splash.ts,
 * переменная `check`). Чтобы не собирать пилот трижды, сервер отдаёт /mvp/?consent=checkbox|parent с той же разметкой,
 * что сделала бы сборка с VITE_CONSENT_MODE (тексты — из config/consent.ts); скрипт заставки — тот же, из сборки.
 */
function consentVariant(html, mode) {
  if (mode !== 'checkbox' && mode !== 'parent') return html;
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const check = `<label class="q-check"><input type="checkbox" name="consent"><span>${esc(mode === 'parent' ? CONSENT_TEXT.parent : CONSENT_TEXT.checkbox)}</span></label><div class="q-need hidden" role="alert">${esc(CONSENT_TEXT.needCheck)}</div>`;
  return html.replace('data-consent="notice"', `data-consent="${mode}"`).replace(/(<button class="q-cta")/, `${check}$1`);
}

export function startServer({ dist, pub, cache }) {
  const requests = [];
  const file = (base, p) => {
    const f = path.join(base, p);
    if (!f.startsWith(base)) return null;
    return fs.existsSync(f) && fs.statSync(f).isFile() ? f : null;
  };
  const optCached = (p) => {
    const m = /\/opt\/[^/]+\.([0-9a-f]{10})\.glb$/.exec(p);
    if (!m || !fs.existsSync(cache)) return null;
    const n = fs.readdirSync(cache).find((x) => x.startsWith(m[1]));
    return n ? path.join(cache, n) : null;
  };
  const gz = new Map();
  let version = 0;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = decodeURIComponent(u.pathname);
    if (p.startsWith('/api/')) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        requests.push({ method: req.method, path: req.url, body, at: Date.now() });
        // мок сервиса прогресса (server/progress): пустой документ; запись — новая версия
        if (p.startsWith('/api/progress/event')) return void (res.writeHead(204), res.end());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: req.method === 'GET' ? version : ++version, resetAt: null, data: {} }));
      });
      return;
    }
    let f = file(dist, p) || file(pub, p) || optCached(p);
    if (!f && p.startsWith('/mvp') && (!path.extname(p) || p.endsWith('/'))) f = file(dist, '/mvp/index.html');
    if (!f) {
      requests.push({ method: req.method, path: req.url, body: '', at: Date.now(), status: 404 });
      return void (res.writeHead(404), res.end());
    }
    const ext = path.extname(f);
    const h = { 'Content-Type': TYPES[ext] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' };
    requests.push({ method: req.method, path: req.url, body: '', at: Date.now() });
    if (ext === '.html' && u.searchParams.get('consent')) {
      res.writeHead(200, h);
      return void res.end(consentVariant(fs.readFileSync(f, 'utf8'), u.searchParams.get('consent')));
    }
    if (ZIP.has(ext) && /gzip/.test(req.headers['accept-encoding'] ?? '')) {
      if (!gz.has(f)) gz.set(f, zlib.gzipSync(fs.readFileSync(f), { level: 1 }));
      res.writeHead(200, { ...h, 'Content-Encoding': 'gzip' });
      return void res.end(gz.get(f));
    }
    res.writeHead(200, h);
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) =>
    srv.listen(0, '127.0.0.1', () => r({ base: `http://127.0.0.1:${srv.address().port}`, requests, close: () => new Promise((rr) => srv.close(rr)) })),
  );
}

export function launch({ media, room, headful = false }) {
  return puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/bin/google-chrome',
    headless: !headful,
    protocolTimeout: 300000,
    args: [
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${media}`,
      ...(room ? [`--use-file-for-fake-audio-capture=${room}`] : []),
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required',
      '--lang=ru-RU', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      '--enable-precise-memory-info', '--js-flags=--expose-gc',
    ],
  });
}

/**
 * Известные ограничения headless-стенда — не ошибки приложения (каждая строка с причиной):
 */
export const ALLOW = [
  // офлайн-модель распознавания (public/models/vosk-ru-small, ~45 МБ) в репозиторий не входит (.gitignore) — на стенде
  // её нет: голос недоступен, это и есть путь «голос недоступен → поле ввода / кнопки»
  { re: /vosk|no-model/i, why: 'модели Vosk нет на стенде' },
  // «Failed to load resource: 404» не говорит, что за файл: все 404 сервер стенда собирает сам и прогон падает на любом,
  // кроме модели Vosk (run.mjs, 10_no_404)
  { re: /Failed to load resource: the server responded with a status of 404/i, why: '404 — проверяется списком запросов сервера (10_no_404)' },
];
export const allowed = (text, extra = []) => [...ALLOW, ...extra].find((a) => a.re.test(text)) ?? null;

/** «телефон»: новая вкладка в отдельном контексте (свой localStorage), iPhone 390×844 */
export async function openPhone(browser, server, o = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setUserAgent(IPHONE_UA);
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push({ kind: 'console.error', text: m.text().slice(0, 500), at: Date.now() });
  });
  page.on('pageerror', (e) => errors.push({ kind: 'pageerror', text: String(e.message || e).slice(0, 500), at: Date.now() }));
  page.on('requestfailed', (r) => {
    const u = r.url();
    if (/\/api\//.test(u)) return; // sendBeacon при закрытии вкладки
    if (r.failure()?.errorText === 'net::ERR_ABORTED') return; // отменённые загрузки (смена кота, уход со страницы)
    errors.push({ kind: 'requestfailed', text: `${u} ${r.failure()?.errorText}`, at: Date.now() });
  });
  await page.evaluateOnNewDocument(qaPrelude, { clear: false, denyCam: !!o.denyCam, tableUrl: '' });
  await page.evaluateOnNewDocument(textWatcher);
  if (o.denyMic)
    await page.evaluateOnNewDocument(() => {
      const md = navigator.mediaDevices, gum = md.getUserMedia.bind(md);
      md.getUserMedia = (c) => (c?.audio ? Promise.reject(new DOMException('Permission denied', 'NotAllowedError')) : gum(c));
    });
  if (o.memory)
    await page.evaluateOnNewDocument((m) => {
      try {
        if (!localStorage.getItem('pilot:sber-ar-cat:v1')) localStorage.setItem('pilot:sber-ar-cat:v1', JSON.stringify({ ...m, lastVisitAt: Date.now() - 3600_000 }));
      } catch {}
    }, o.memory);
  const P = new Phone(page, ctx, server, errors);
  if (o.url !== null) await P.go(o.q ?? '');
  return P;
}

export class Phone {
  constructor(page, ctx, server, errors) {
    this.page = page;
    this.ctx = ctx;
    this.server = server;
    this.errors = errors;
    this.navAt = 0;
  }
  async go(q) {
    this.navAt = Date.now();
    await this.page.goto(`${this.server.base}/mvp/${q ? '?' + q.replace(/^\?/, '') : ''}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  }
  ev(f, ...a) {
    return this.page.evaluate(f, ...a);
  }
  /** ждать условие в странице; false — не дождались (сценарий сам решает, провал ли это) */
  async until(f, ms = 30000, arg) {
    try {
      await this.page.waitForFunction(f, { timeout: ms, polling: 100 }, arg);
      return true;
    } catch {
      return false;
    }
  }
  /** то же, но провал теста с понятным текстом */
  async must(f, ms, what, arg) {
    if (!(await this.until(f, ms, arg))) throw new Error(`не дождались за ${(ms / 1000).toFixed(0)} с: ${what}`);
  }
  /** видим ли элемент (есть, не .hidden, не display:none, ненулевой размер) */
  visible(sel) {
    return this.ev((s) => {
      const el = document.querySelector(s);
      if (!el) return false;
      if (el.closest('.hidden')) return false;
      const cs = getComputedStyle(el), r = el.getBoundingClientRect();
      return cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.05 && r.width > 0 && r.height > 0;
    }, sel);
  }
  /** тап пальцем по центру элемента (настоящее касание: закрытый чем-то элемент не нажмётся) */
  async tap(sel) {
    const r = await this.ev((s) => {
      const el = typeof s === 'string' ? document.querySelector(s) : null;
      if (!el) return null;
      // кнопка внизу прокручиваемого листа — как палец ребёнка: сначала прокрутить к ней
      let b = el.getBoundingClientRect();
      if (b.top < 0 || b.bottom > innerHeight) {
        el.scrollIntoView({ block: 'center', inline: 'center' });
        b = el.getBoundingClientRect();
      }
      if (!b.width || !b.height) return null;
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }, sel);
    if (!r) throw new Error(`нечего нажать: ${sel}`);
    await this.page.touchscreen.tap(r.x, r.y);
  }
  async tapXY(x, y) {
    await this.page.touchscreen.tap(x, y);
  }
  /** приложение готово, режиссёр и запись событий стенда (qaInstall: рендер — заглушка, рисуем только для снимков) */
  async install(gpu = 'stub') {
    await this.must(() => !!window.__app?.input && !!window.__app?.director, 180000, 'приложение готово (window.__app.input)');
    await this.ev(qaInstall, gpu);
  }
  phase() {
    return this.ev(() => window.__app?.director?.state?.phase ?? null);
  }
  /** время ×k (performance.now, Date.now, таймеры — prelude) */
  setK(k) {
    return this.ev((k) => window.__qaSetK(k), k);
  }
  log() {
    return this.ev(() => (window.__qaRec ?? []).filter((r) => r.kind === 'log').map((r) => r.s));
  }
  rec(kind) {
    return this.ev((k) => (window.__qaRec ?? []).filter((r) => !k || r.kind === k), kind);
  }
  async shot(file) {
    await this.ev(() => window.__qaDraw?.(2)).catch(() => undefined);
    await this.page.screenshot({ path: file, type: 'png' }).catch(() => undefined);
  }
  /** ошибки страницы, кроме белого списка */
  badErrors(extra = []) {
    return this.errors.filter((e) => !allowed(e.text, extra));
  }
  close() {
    return this.ctx.close().catch(() => undefined);
  }
}

/**
 * Быстрый путь до игры: «Узнать, кто там» → камера → карта → пробуждение → знакомство (имя полем ввода или «Пропустить»)
 * → phase play/free. memory — «уже знакомы» (без знакомства).
 */
export async function toPlay(P, { name = null, timeout = 240000 } = {}) {
  await P.must(() => !!document.querySelector('#quick .q-cta'), 20000, 'кнопка «Узнать, кто там»');
  await P.tap('#quick .q-cta');
  await P.install();
  await watchTexts(P);
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const ph = await P.phase();
    if (ph === 'play' || ph === 'free') return;
    if (ph === 'ask_name' && (await P.visible('.namebox input'))) {
      if (name) {
        await P.tap('.namebox input');
        await P.page.keyboard.type(name);
        await P.tap('.namebox [data-a="name"]');
      } else await P.tap('.namebox [data-a="skip"]');
      await sleep(500);
      continue;
    }
    await sleep(300);
  }
  throw new Error(`не дошли до игры за ${timeout / 1000} с (фаза ${await P.phase()})`);
}

/** что кот и интерфейс показали ребёнку: пузырь, тост, подсказка у микрофона, подписи подсказок, чипы (window.__e2eTexts) —
 * с первого кадра страницы (скрипт до загрузки), чтобы не пропустить ранний тост */
export function textWatcher() {
  const start = () => {
    if (window.__e2eTexts) return;
    const out = (window.__e2eTexts = []);
    const sels = ['.bubble .txt', '.toast', '.mic-hint', '.hintp-cap', '.chips.suggest', '.cs-tip', '.tom-tip'];
    const seen = new Map();
    const scan = () => {
      for (const s of sels)
        for (const el of document.querySelectorAll(s)) {
          if (el.closest('.hidden')) continue;
          const t = (el.textContent || '').trim();
          if (!t || seen.get(el) === t) continue;
          seen.set(el, t);
          out.push({ sel: s, t, at: performance.now() });
        }
    };
    new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'] });
    scan();
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
}
export const watchTexts = (P) => P.ev(textWatcher);

/** пункты каталога пилота текущего кота (ui → app.catalog: те же, что видит ребёнок) */
export function catalogItems(P) {
  return P.ev(() => {
    const c = window.__app.ui.h.catalog();
    return (c?.sections ?? []).flatMap((s) => s.items.map((i) => ({ sec: s.id, id: i.id, label: i.label, action: i.run?.action ?? null, ui: i.run?.ui ?? null })));
  });
}

/**
 * Нажать пункт каталога: если его кнопка видна в меню (колонки «как у Тома», ряд комнаты) — настоящим касанием,
 * иначе — тем же путём, что тап по кнопке каталога (app.runCatalogItem). Возвращает 'tap' | 'run' | null.
 */
export async function pick(P, id) {
  const where = await P.ev((id) => {
    const tom = document.querySelector('.tom');
    const b = [...document.querySelectorAll(`.tom [data-item="${id}"], .chips [data-chip="${id}"]`)].find((el) => {
      if (el.closest('.hidden') || el.closest('.tom-pop')) return false;
      if (tom?.classList.contains('cols-out') && el.closest('.tom-col')) return false;
      const r = el.getBoundingClientRect();
      return r.width > 10 && r.height > 10 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
    });
    if (b) {
      const r = b.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (hit && (hit === b || b.contains(hit))) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    return null;
  }, id);
  if (where) {
    await P.tapXY(where.x, where.y);
    return 'tap';
  }
  const ok = await P.ev((id) => {
    const a = window.__app, c = a.ui.h.catalog();
    const it = (c?.sections ?? []).flatMap((s) => s.items).find((i) => i.id === id) ?? a.extraItems?.().map((x) => x.item).find((i) => i.id === id);
    if (!it) return false;
    a.runCatalogItem(it);
    return true;
  }, id);
  return ok ? 'run' : null;
}

/** кот свободен: нет активного действия и очереди, клип — покой/речь, не идёт */
export const SETTLED = () => {
  const a = window.__app, d = a.director, ch = d.character;
  return !d.orch.current && !d.orch.pending && /^(idle|talk)/.test(ch?.currentClip ?? 'idle') && !a.stage.walking;
};

/** экранная точка кота (голова, середина тела) */
export function catBox(P) {
  return P.ev(() => {
    const r = window.__app.rawCatRect();
    return r ? { cx: r.cx, head: r.headY, top: r.top, bottom: r.bottom, mid: (r.top + r.bottom) / 2 + (r.bottom - r.top) * 0.12, half: r.half } : null;
  });
}

/** провести пальцем (touch) по точкам, ms на весь путь */
export async function swipe(P, pts, ms = 500) {
  const ts = P.page.touchscreen;
  const h = await ts.touchStart(pts[0].x, pts[0].y);
  const steps = Math.max(6, Math.round(ms / 25));
  for (let i = 1; i <= steps; i++) {
    const k = i / steps, seg = k * (pts.length - 1), j = Math.min(pts.length - 2, Math.floor(seg)), f = seg - j;
    await h.move(pts[j].x + (pts[j + 1].x - pts[j].x) * f, pts[j].y + (pts[j + 1].y - pts[j].y) * f);
    await sleep(ms / steps);
  }
  await h.end();
}

/** долгое нажатие пальцем */
export async function longPress(P, x, y, ms = 900) {
  const h = await P.page.touchscreen.touchStart(x, y);
  await sleep(ms);
  await h.end();
}

/** запросы к /api/progress/event с номера n: [{name, props, src, device}] */
export function events(server, from = 0) {
  return server.requests.slice(from).filter((r) => r.path.startsWith('/api/progress/event') && r.body).map((r) => {
    try {
      return JSON.parse(r.body);
    } catch {
      return { bad: r.body };
    }
  });
}

/** чип кота по подписи (regexp-строка): ждёт до ms и жмёт пальцем; false — чипа нет */
export async function tapChip(P, re, ms = 8000) {
  const ok = await P.until((re) => [...document.querySelectorAll('.chips .sug')].some((b) => !b.closest('.hidden') && new RegExp(re, 'i').test(b.textContent)), ms, re);
  if (!ok) return false;
  // чипы въезжают (анимация): ждём, пока чип встанет на место (два замера подряд совпали) — палец ребёнка не мгновенный
  const at = () => P.ev((re) => {
    const b = [...document.querySelectorAll('.chips .sug')].find((x) => !x.closest('.hidden') && new RegExp(re, 'i').test(x.textContent));
    if (!b) return null;
    const q = b.getBoundingClientRect();
    return { x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height / 2) };
  }, re);
  let r = await at();
  for (let i = 0; i < 20; i++) {
    await sleep(150);
    const r2 = await at();
    if (!r2) return false;
    if (r && r2.x === r.x && r2.y === r.y) break;
    r = r2;
  }
  // под пальцем должен оказаться именно этот чип
  const ok2 = await P.ev(({ x, y, re }) => {
    const top = document.elementFromPoint(x, y), e = top?.closest('.sug');
    return e && new RegExp(re, 'i').test(e.textContent) ? '' : `${top?.tagName}.${top?.className?.baseVal ?? top?.className} «${(top?.textContent ?? '').trim().slice(0, 30)}»`;
  }, { x: r.x, y: r.y, re });
  if (ok2) throw new Error(`чип «${re}» закрыт другим элементом: ${ok2}`);
  await P.tapXY(r.x, r.y);
  return true;
}
