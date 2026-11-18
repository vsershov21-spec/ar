#!/usr/bin/env node
// Сквозной QA-стенд: сборка → vite preview → headless Chrome как iPhone (390×844, UA iOS, CPU ×4),
// фейковая камера (видео карты на столе) и фейковый микрофон (тихая комната), полный путь ребёнка:
// первый запуск (?fresh) → онбординг → разрешения → посадка на карту → знакомство → кнопки/каталог/чипы →
// фразы → мини-игры → потеря карты → смена кота → 3 мин тишины (время ×K) → дрёма → пробуждение; повторный визит;
// запрет камеры. Отчёт: docs/qa/REPORT.md, снимки: docs/qa/shots/.
//
//   npm run qa                         — всё (сборка ~1,5 мин + прогон ~10 мин)
//   npm run qa -- --no-build           — без пересборки (bench-out/qa/dist уже есть)
//   npm run qa -- --only first,return  — только сессии first | return | denied | chaos
//   npm run qa -- --only chaos --no-build — хаотичные тапы (?flow=chaos, src/debug/flows.ts; docs/qa/CHAOS.md): 40 с бури
//   npm run qa -- --throttle 2 --k 6 --headful --keep (не закрывать браузер) --url http://localhost:5173/ (свой сервер)
//
// Голос: озвучку заменяет scripts/scenario/fake-voice.mjs (тишина длиной как реплика, набор «озвученного» —
// voice-src/el_batch_all.jsonl): работает строгий режим «только озвученные реплики», как на сайте.
// Фразы ребёнка подаются текстом через window.__voice.text (тот же путь, что после распознавания Vosk).
// Селекторы — по data-a / data-act / data-item / ролям, чтобы стенд пережил переделку экрана.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { qaPrelude, qaInstall } from './page-prelude.js';
import { analyze, BUDGET } from './checks.mjs';
import { renderReport } from './report.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const OUT = path.join(root, 'bench-out/qa');
const DIST = path.join(OUT, 'dist');
const MEDIA = path.join(OUT, 'media');
const SHOTS = path.join(root, 'docs/qa/shots');
const REPORT = path.join(root, 'docs/qa/REPORT.md');
const PORT = Number(arg('--port', 4190));
const URL0 = arg('--url', `http://localhost:${PORT}/`);
const THROTTLE = Number(arg('--throttle', 4));
const K = Number(arg('--k', 6));
const GPU = arg('--gpu', 'stub');
const ONLY = arg('--only', 'first,return,denied,chaos').split(',');
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[qa ${new Date().toISOString().slice(11, 19)}]`, ...a);

fs.mkdirSync(MEDIA, { recursive: true });
fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });

// ───────────── 1. медиа: видео карты, стол без карты, тишина микрофона ─────────────
function media() {
  if (!fs.existsSync(path.join(MEDIA, 'still.y4m')) || !fs.existsSync(path.join(MEDIA, 'table.png'))) {
    log('медиа: видео карты (scripts/bench/gen_card_video.py)');
    const r = spawnSync('python3', [path.join(root, 'scripts/bench/gen_card_video.py'), MEDIA], { stdio: 'inherit' });
    if (r.status) throw new Error('gen_card_video.py упал');
    fs.rmSync(path.join(MEDIA, 'move.y4m'), { force: true });
  }
  // микрофон: комната −60 дБFS (шум), 48 кГц моно, 10 с по кругу — без него Chrome подаёт гудок каждую секунду
  const wav = path.join(MEDIA, 'room.wav');
  if (!fs.existsSync(wav)) {
    const sr = 48000, n = sr * 10, b = Buffer.alloc(44 + n * 2);
    b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
    b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28);
    b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
    let s = 1;
    for (let i = 0; i < n; i++) {
      s = (s * 16807) % 2147483647;
      b.writeInt16LE(Math.round(((s / 2147483647) * 2 - 1) * 33), 44 + i * 2); // ≈ −60 дБFS
    }
    fs.writeFileSync(wav, b);
  }
}

// ───────────── 2. сборка и сервер ─────────────
function build() {
  log('сборка: vite build → bench-out/qa/dist');
  let r = spawnSync('npx', ['vite', 'build', '--outDir', DIST, '--emptyOutDir', '--logLevel', 'warn'], { cwd: root, stdio: 'inherit' });
  if (r.status) throw new Error('vite build упал');
  r = spawnSync('node', [path.join(root, 'scripts/scenario/fake-voice.mjs'), DIST, '1'], { cwd: root, stdio: 'inherit' });
  if (r.status) throw new Error('fake-voice упал');
}
const ping = (u) => new Promise((res) => http.get(u, (r) => (r.resume(), res(r.statusCode === 200))).on('error', () => res(false)));
async function serve() {
  if (arg('--url', '')) return null;
  if (await ping(URL0)) throw new Error(`порт ${PORT} занят — освободи или укажи --port`);
  const p = spawn('npx', ['vite', 'preview', '--outDir', DIST, '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'ignore', detached: true });
  for (let i = 0; i < 120 && !(await ping(URL0)); i++) await sleep(250);
  if (!(await ping(URL0))) throw new Error('vite preview не поднялся');
  return p;
}

// ───────────── 3. сессия ─────────────
class Session {
  constructor(name, page, cdp) {
    this.name = name;
    this.page = page;
    this.cdp = cdp;
    this.steps = [];
    this.console = [];
    this.metrics = [];
    this.shotN = 0;
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warn' || m.type() === 'warning') this.console.push({ type: m.type(), text: m.text().slice(0, 400), at: Date.now() });
    });
    page.on('pageerror', (e) => this.console.push({ type: 'pageerror', text: String(e.message || e).slice(0, 400), at: Date.now() }));
  }
  ev(f, ...a) {
    return this.page.evaluate(f, ...a);
  }
  /** ждать условие (функция в странице) — реальные мс */
  async until(f, ms, arg) {
    try {
      await this.page.waitForFunction(f, { timeout: ms, polling: 200 }, arg);
      return true;
    } catch {
      return false;
    }
  }
  /** виртуальные мс (с учётом текущего ускорения) */
  async vwait(ms) {
    const k = await this.ev(() => window.__qaK?.() ?? 1);
    await sleep(ms / k);
  }
  mark(s) {
    return this.ev((s) => window.__qaPush?.('step', { s }), s).catch(() => undefined);
  }
  async shot(label) {
    const f = `${this.name}_${String(++this.shotN).padStart(2, '0')}_${label}.jpg`;
    const t0 = await this.ev(() => (window.__qaReal ? Math.round(window.__qaReal.now()) : 0)).catch(() => 0);
    await this.ev(() => window.__qaDraw?.(2)).catch(() => undefined);
    await this.page.screenshot({ path: path.join(SHOTS, f), type: 'jpeg', quality: 62 }).catch(() => undefined);
    // окно снимка (абсолютное время страницы): длинные задачи в нём — настоящий рендер SwiftShader, не приложение
    await this.ev((t0) => window.__qaDrawWin?.push([t0, Math.round(window.__qaReal.now()) + 300]), t0).catch(() => undefined);
    return f;
  }
  /** метрики: CDP (куча, узлы DOM, слушатели, время главного потока) + three (текстуры, геометрии, программы) */
  async sample(tag, gc = false) {
    // GPU-заглушка: текстуры попадают в renderer.info только при настоящей отрисовке — пара кадров перед замером
    if (gc) await this.ev(() => window.__qaDraw?.(3)).catch(() => undefined);
    if (gc) await this.cdp.send('HeapProfiler.collectGarbage').catch(() => undefined);
    const m = Object.fromEntries((await this.cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
    const dom = await this.cdp.send('Memory.getDOMCounters').catch(() => ({}));
    const app = await this.ev(() => {
      const a = window.__app;
      const i = a?.renderer?.info;
      return a ? { tex: i?.memory?.textures, geo: i?.memory?.geometries, prog: i?.programs?.length, fps: a.fps, mode: a.energy?.out?.mode, target: a.energy?.out?.renderFps, rt: window.__qaT?.().rt, long: window.__qaLong?.length ?? 0 } : null;
    }).catch(() => null);
    const s = { tag, at: Date.now(), heap: m.JSHeapUsedSize, task: m.TaskDuration, script: m.ScriptDuration, style: m.RecalcStyleDuration + m.LayoutDuration, nodes: dom.nodes ?? m.Nodes, listeners: dom.jsEventListeners ?? m.JSEventListeners, docs: dom.documents, ...app };
    this.metrics.push(s);
    return s;
  }
  /** шаг сценария: строка отчёта (ок / замечание / ошибка), снимок, проверки интерфейса */
  async step(id, title, fn, { shot = true, ui = true } = {}) {
    const st = { id, title, issues: [], notes: [], shots: [], t0: Date.now(), ok: true };
    this.cur = st;
    log(`${this.name}: ${title}`);
    await this.mark(`шаг: ${title}`);
    const m0 = await this.sample(`${id}:start`).catch(() => null);
    try {
      await fn(st);
    } catch (e) {
      st.ok = false;
      st.issues.push({ sev: 'error', msg: `исключение стенда: ${String(e.message || e).split('\n')[0]}` });
    }
    const m1 = await this.sample(`${id}:end`).catch(() => null);
    if (m0 && m1) {
      const wall = (m1.at - m0.at) / 1000;
      st.perf = { wall: +wall.toFixed(1), mainPct: +(((m1.task - m0.task) / wall) * 100).toFixed(0), longTasks: (m1.long ?? 0) - (m0.long ?? 0) };
    }
    if (shot) st.shots.push(await this.shot(id));
    if (ui) for (const x of await uiCheck(this)) st.issues.push(x);
    st.dur = +((Date.now() - st.t0) / 1000).toFixed(1);
    if (st.issues.some((x) => x.sev === 'error')) st.ok = false;
    this.steps.push(st);
    return st;
  }
  issue(msg, sev = 'error') {
    this.cur?.issues.push({ sev, msg });
  }
  note(msg) {
    this.cur?.notes.push(msg);
  }
  check(cond, msg, sev = 'error') {
    if (!cond) this.issue(msg, sev);
    return !!cond;
  }
  /** тап пальцем по элементу (настоящий ввод: если элемент чем-то закрыт, тап уйдёт туда) */
  async tap(sel) {
    const r = await this.ev((sel) => {
      const el = typeof sel === 'string' ? document.querySelector(sel) : null;
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }, sel);
    if (!r) return false;
    await this.page.touchscreen.tap(r.x, r.y);
    return true;
  }
  /** прокрутить ленту к элементу (кнопки за краем — как палец ребёнка) и тапнуть по центру; null — элемента нет/не виден */
  async tapEl(sel) {
    const ok = await this.ev((sel) => {
      const el = [...document.querySelectorAll(sel)].find((e) => !e.closest('.hidden') && e.getBoundingClientRect().width > 4);
      if (!el) return false;
      el.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'instant' });
      return true;
    }, sel);
    if (!ok) return null;
    await sleep(350);
    const r = await this.ev((sel) => {
      const el = [...document.querySelectorAll(sel)].find((e) => !e.closest('.hidden') && e.getBoundingClientRect().width > 4);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      const x = b.left + b.width / 2, y = b.top + b.height / 2;
      if (x < 0 || x >= innerWidth || y < 0 || y >= innerHeight) return null;
      return { x, y, label: el.textContent.trim().slice(0, 40) };
    }, sel);
    if (!r) return null;
    await this.page.touchscreen.tap(r.x, r.y);
    return r;
  }
  async tapXY(x, y) {
    await this.page.touchscreen.tap(x, y);
  }
  /** видимые кнопки по селектору: [{key, label, x, y}] */
  visible(sel, key) {
    return this.ev(
      (sel, key) =>
        [...document.querySelectorAll(sel)]
          .filter((el) => {
            const b = el.getBoundingClientRect(), cs = getComputedStyle(el);
            return b.width > 4 && b.height > 4 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.closest('.hidden') && +cs.opacity > 0.05 && b.bottom > 0 && b.top < innerHeight;
          })
          .map((el) => {
            const b = el.getBoundingClientRect();
            return { key: el.getAttribute(key) ?? el.textContent.trim().slice(0, 30), label: el.textContent.trim().slice(0, 40), x: b.left + b.width / 2, y: b.top + b.height / 2 };
          }),
      sel, key,
    );
  }
  catalogOpen() {
    return this.ev(() => [...document.querySelectorAll('.catalog, [role=dialog]')].some((e) => !e.classList.contains('hidden') && e.querySelector('[data-item]')));
  }
  /** каталог «Что умеет кот»: лапка (вариант А) или «Ещё» в панели */
  async openCatalog() {
    if (await this.catalogOpen()) return true;
    if (!(await this.tapEl('[data-a="paw"], [data-act="more"], [aria-haspopup="dialog"]'))) return false;
    return this.until(() => [...document.querySelectorAll('.catalog, [role=dialog]')].some((e) => !e.classList.contains('hidden') && e.querySelector('[data-item]')), 3000);
  }
  async closeCatalog() {
    if (!(await this.catalogOpen())) return;
    if (!(await this.tapEl('[data-a="cat-close"]'))) await this.tapEl('[data-a="paw"]');
    await sleep(400);
  }
  /** выбрать пункт каталога: открыть, раздел (если надо), тап по пункту */
  async catalogPick(id, tab) {
    if (!(await this.openCatalog())) return null;
    const sel = `[data-item="${id}"]`;
    if (tab && !(await this.visible(sel, 'data-item')).length) {
      await this.tapEl(`[data-tab="${tab}"]`);
      await sleep(400);
    }
    if (!(await this.visible(sel, 'data-item')).length)
      for (const t of (await this.visible('[data-tab]', 'data-tab')).map((x) => x.key)) {
        await this.tapEl(`[data-tab="${t}"]`);
        await sleep(400);
        if ((await this.visible(sel, 'data-item')).length) break;
      }
    return this.tapEl(sel);
  }
  /** чип с подписью по шаблону (например /Сдаюсь/) — тапнуть; null, если такого нет */
  async tapChip(re) {
    const c = (await this.visible('.sug, [data-chip]', 'data-chip')).find((x) => re.test(x.label));
    if (!c) return null;
    return this.tapEl(`[data-chip="${c.key}"]`);
  }
  /** голосом (как после распознавания) */
  async say(t) {
    await this.mark(`ребёнок: «${t}»`);
    await this.ev((t) => window.__voice.text(t), t);
  }
  rec() {
    return this.ev(() => window.__qaRec ?? []);
  }
  /** новые записи с момента rt */
  since(rt, kind) {
    // фильтр в странице: запись растёт (опрос каждые 0,5 с), гонять её целиком каждые 250 мс дорого
    return this.ev((rt, kind) => (window.__qaRec ?? []).filter((x) => x.rt >= rt && (!kind || x.kind === kind) && (kind || x.kind !== 'log')), rt, kind ?? null);
  }
  now() {
    return this.ev(() => window.__qaT?.().rt ?? 0);
  }
  /** ждать реплику (speak) после rt; pred по id */
  async waitSpeak(rt, ms, pred = () => true) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const s = (await this.since(rt, 'speak')).find((x) => pred(x.id, x));
      if (s) return s;
      await sleep(250);
    }
    return null;
  }
  /** кот отреагировал после rt: реплика, смена клипа (не idle/talk) или эффект/эмоция в логе */
  async waitReaction(rt, ms) {
    const end = Date.now() + ms;
    // клип, который шёл до нажатия (хвост прошлой реакции), — не ответ на это нажатие
    const before = await this.ev((rt) => [...(window.__qaRec ?? [])].reverse().find((x) => x.kind === 'sample' && x.rt < rt)?.clip ?? null, rt);
    while (Date.now() < end) {
      const r = await this.since(rt);
      const sp = r.find((x) => x.kind === 'speak');
      const clip = r.find((x) => x.kind === 'sample' && x.clip && x.clip !== before && !/^(idle|talk|listen)/.test(x.clip));
      if (sp || clip) return { speak: sp?.id, clip: clip?.clip };
      await sleep(250);
    }
    return null;
  }
  /** кот договорил и ждёт ответа в режиме mode */
  waitListen(mode, ms = 30000) {
    return this.until((m) => !window.__app.director.queue.busy && window.__app.director.state.dialog?.listening === m, ms, mode);
  }
  waitQuiet(ms = 20000) {
    return this.until(() => !window.__app.director.queue.busy && !window.__app.voice.speaking, ms);
  }
  /** закончить мини-игру, если идёт (повторялка — «хватит», вопрос — «нет»): следующие шаги — в свободной игре */
  async endGames() {
    // смена кота ждёт встряски (экран заклеен) — «Сдёрнуть наклейки» или встряска датчиком
    if ((await this.phase()) === 'switching') {
      if (!(await this.tapEl('[data-a="shake"]'))) await this.ev(() => window.__app.input.simulateShake());
      await this.until(() => window.__app.director.state.phase !== 'switching', 20000);
      await this.waitQuiet(15000);
    }
    for (let i = 0; i < 3; i++) {
      const d = await this.ev(() => window.__app.director.state.dialog);
      if (!d) return;
      await this.waitQuiet(10000);
      await this.say(d.id === 'echo' || d.listening === 'echo' ? 'хватит' : 'нет');
      await this.until(() => !window.__app.director.state.dialog, 8000);
    }
  }
  phase() {
    return this.ev(() => window.__app.director.state.phase);
  }
  catCenter() {
    return this.ev(() => {
      const r = window.__app.ui.catRect?.();
      return r ? { x: r.cx, y: (r.headY + r.bottom) / 2, head: r.headY } : null;
    });
  }
}

/** интерфейс: кнопки кликабельны (центр не перекрыт), элементы интерфейса не закрывают морду кота */
async function uiCheck(s) {
  const r = await s
    .ev(() => {
      const out = [];
      const vis = (el) => {
        const b = el.getBoundingClientRect(), cs = getComputedStyle(el);
        return b.width > 4 && b.height > 4 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.closest('.hidden') && +cs.opacity > 0.05 && b.bottom > 0 && b.top < innerHeight && b.right > 0 && b.left < innerWidth;
      };
      const name = (el) => el.getAttribute('data-a') || el.getAttribute('data-act') || el.getAttribute('data-item') || el.getAttribute('aria-label') || el.className || el.tagName;
      // кнопки: центр под пальцем — сама кнопка (не прозрачный слой поверх) и размер ≥ 36 px
      for (const el of document.querySelectorAll('button, [role=button], a.btn')) {
        if (!vis(el) || el.disabled) continue;
        const b = el.getBoundingClientRect();
        const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
        // в ленте с прокруткой кнопка за краем — норма (доедет пальцем); проверяем только то, что на экране
        let sc = el.parentElement;
        while (sc && !/(auto|scroll)/.test(getComputedStyle(sc).overflowX)) sc = sc.parentElement;
        if (cx < 0 || cx >= innerWidth || cy < 0 || cy >= innerHeight) {
          if (!sc) out.push({ sev: 'warn', msg: `кнопка «${name(el)}» за краем экрана (нет прокрутки)` });
          continue;
        }
        const hit = document.elementFromPoint(cx, cy);
        // под модальным экраном/листом кнопка закрыта законно
        const modal = hit?.closest?.('.screen, [role=dialog], [aria-modal=true], .sheet, .catalog');
        if (hit && !el.contains(hit) && !hit.contains(el) && !(modal && !modal.contains(el)))
          out.push({ sev: 'error', msg: `кнопка «${name(el)}» закрыта элементом ${hit.tagName.toLowerCase()}.${String(hit.className).split(' ')[0]}` });
        if (!(modal && !modal.contains(el)) && (b.width < 40 || b.height < 40) && !el.closest('p, span'))
          out.push({ sev: 'warn', msg: `кнопка «${name(el)}» мала для пальца: ${Math.round(b.width)}×${Math.round(b.height)} (Apple HIG — 44)` });
        if (!sc && (b.right > innerWidth + 1 || b.left < -1)) out.push({ sev: 'warn', msg: `кнопка «${name(el)}» выходит за экран` });
      }
      // морда кота: голова ± половина ширины, от макушки до подбородка
      const app = window.__app;
      const c = app?.stage?.root?.visible ? app.ui.catRect?.() : null;
      if (c) {
        const face = { l: c.cx - c.half * 0.7, r: c.cx + c.half * 0.7, t: c.top + (c.headY - c.top) * 0.3, b: c.headY + (c.bottom - c.headY) * 0.12 };
        const fa = Math.max(1, (face.r - face.l) * (face.b - face.t));
        if (face.b > 0 && face.t < innerHeight)
          for (const el of document.querySelectorAll('.bubble.show, .sheet, .catalog, .chips, .dock, .toast, .kids, .shakebtn, .reanchor, .mic-hint, [role=dialog], [role=toolbar]')) {
            if (!vis(el) || el.classList.contains('coach')) continue;
            if (el.classList.contains('mic-hint') && !el.textContent.trim()) continue;
            const b = el.getBoundingClientRect();
            const ix = Math.max(0, Math.min(b.right, face.r) - Math.max(b.left, face.l)), iy = Math.max(0, Math.min(b.bottom, face.b) - Math.max(b.top, face.t));
            const k = (ix * iy) / fa;
            if (k > 0.15) out.push({ sev: k > 0.4 ? 'error' : 'warn', msg: `«${name(el).split(' ')[0]}» закрывает морду кота на ${Math.round(k * 100)}%` });
          }
      }
      // горизонтальный скролл
      if (document.documentElement.scrollWidth > innerWidth + 1) out.push({ sev: 'warn', msg: `горизонтальный скролл: ${document.documentElement.scrollWidth} > ${innerWidth}` });
      return out;
    })
    .catch(() => []);
  // одинаковые замечания — один раз
  const seen = new Set();
  return r.filter((x) => !seen.has(x.msg) && seen.add(x.msg));
}

async function openPage(browser, ctx, name, o = {}) {
  const page = await ctx.newPage();
  await page.setUserAgent(IPHONE_UA);
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const cdp = await page.createCDPSession();
  await cdp.send('Performance.enable');
  const s = new Session(name, page, cdp);
  await page.evaluateOnNewDocument(qaPrelude, { clear: !!o.clear, micMode: o.micMode ?? null, denyCam: !!o.denyCam, memory: o.memory ?? null, tableUrl: `${URL0}__qa/table.jpg` });
  return s;
}

/** онбординг: «Познакомиться» → «Открыть камеру»; кнопки — по data-a */
async function onboarding(s, st) {
  const ok = await s.until(() => !!document.querySelector('[data-a="ob-next"], [data-a="wake"]') && !!window.__app?.director, 60000);
  s.check(ok, 'онбординг не появился за 60 с');
  st.shots.push(await s.shot('onboarding_1'));
  for (let i = 0; i < 4; i++) {
    const wake = await s.visible('[data-a="wake"]', 'data-a');
    if (wake.length) break;
    const next = await s.visible('[data-a="ob-next"]', 'data-a');
    if (!next.length) break;
    await s.tapXY(next[0].x, next[0].y);
    await sleep(700);
  }
  const wake = await s.visible('[data-a="wake"]', 'data-a');
  s.check(wake.length, 'нет кнопки «Открыть камеру» (data-a="wake")');
  st.shots.push(await s.shot('onboarding_2'));
  // кнопка не «думает»: модель кота загружена к нажатию
  const ready = await s.until(() => !!window.__app?.character && !!window.__app?.input, 120000);
  s.check(ready, 'кот не загрузился за 120 с после онбординга');
  return wake[0];
}

/** после «Открыть камеру»: камера и микрофон открылись, кот сел на карту */
async function permissionsAndLanding(s, wakeBtn) {
  await startProfile(s);
  const rt0 = Date.now();
  await s.tapXY(wakeBtn.x, wakeBtn.y);
  await s.ev(qaInstall, GPU).catch(() => undefined);
  await s.until(() => !!window.__qaRec, 5000);
  return rt0;
}

// ───────────── профиль CPU (--profile): что занимало главный поток, в том числе в самом длинном «занятом» отрезке ─────────────
const PROFILE = flag('--profile');
async function startProfile(s) {
  if (!PROFILE) return;
  await s.cdp.send('Profiler.enable');
  await s.cdp.send('Profiler.setSamplingInterval', { interval: 2000 });
  await s.cdp.send('Profiler.start');
}
async function dumpProfile(s) {
  const { profile: pr } = await s.cdp.send('Profiler.stop').catch(() => ({}));
  if (!pr) return;
  const byId = new Map(pr.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of pr.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const name = (n) => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber + 1}`;
  const stack = (id) => {
    const out = [];
    for (let k = id; k && out.length < 8; k = parent.get(k)) out.push(name(byId.get(k)));
    return out.filter((x) => !/^\(root\)/.test(x)).join(' ← ');
  };
  const self = new Map();
  let t = 0, run = null, best = null;
  for (let i = 0; i < pr.samples.length; i++) {
    const dt = pr.timeDeltas[i] ?? 0;
    t += dt;
    const n = byId.get(pr.samples[i]);
    const k = name(n);
    self.set(k, (self.get(k) ?? 0) + dt);
    const idle = /^\((idle|program)\)/.test(n.callFrame.functionName) && n.callFrame.functionName !== '(program)' ? true : n.callFrame.functionName === '(idle)';
    if (idle) {
      if (run && (!best || run.t1 - run.t0 > best.t1 - best.t0)) best = run;
      run = null;
    } else {
      run ??= { t0: t, t1: t, ids: new Map() };
      run.t1 = t;
      run.ids.set(pr.samples[i], (run.ids.get(pr.samples[i]) ?? 0) + dt);
    }
  }
  const L = [`# CPU-профиль сессии ${s.name} (выборка 2 мс)`, '', '## Свои затраты (self), топ-25', ''];
  for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) L.push(`${(v / 1000).toFixed(0).padStart(7)} мс  ${k}`);
  if (best) {
    L.push('', `## Самый длинный отрезок без простоя: ${((best.t1 - best.t0) / 1e6).toFixed(2)} с, через ${(best.t0 / 1e6).toFixed(1)} с от старта профиля`, '');
    for (const [id, v] of [...best.ids].sort((a, b) => b[1] - a[1]).slice(0, 12)) L.push(`${(v / 1000).toFixed(0).padStart(7)} мс  ${stack(id)}`);
  }
  fs.writeFileSync(path.join(OUT, `profile_${s.name}.txt`), L.join('\n') + '\n');
  log(`профиль: bench-out/qa/profile_${s.name}.txt`);
}

// ───────────── сессия 1: первый запуск ─────────────
async function sessionFirst(browser, ctx) {
  const s = await openPage(browser, ctx, 'first', { clear: true });
  await s.page.goto(`${URL0}?fresh`, { waitUntil: 'domcontentloaded' });
  await s.cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  let wakeBtn;
  await s.step('onboarding', 'Первый запуск (?fresh): онбординг', async (st) => {
    wakeBtn = await onboarding(s, st);
    const err = await s.ev(() => !!document.querySelector('.screen.error:not(.hidden), .err-ico'));
    s.check(!err, 'экран ошибки на онбординге');
  });
  let wakeAt = 0;
  await s.step('permissions', 'Разрешения: камера + микрофон одним нажатием', async () => {
    if (!wakeBtn) throw new Error('нет кнопки wake');
    wakeAt = await permissionsAndLanding(s, wakeBtn);
    const cam = await s.until(() => (window.__app.tracker.video?.readyState ?? 0) >= 2, 15000);
    s.check(cam, 'видео камеры не пошло за 15 с');
    const gum = await s.ev(() => window.__qaGum ?? 0);
    s.check(gum <= 1, `getUserMedia вызван ${gum} раз (на iOS второй запрос рвёт видео)`, 'warn');
    const mic = await s.until(() => window.__app.engine.mic.isOpen, 10000);
    s.check(mic, 'микрофон не открылся (режим «слушаю всегда») за 10 с');
    const hidden = await s.until(() => document.querySelector('.start')?.classList.contains('hidden'), 5000);
    s.check(hidden, 'онбординг не скрылся после «Открыть камеру»');
    s.check(await s.until(() => window.__app.director.state.phase !== 'start', 5000), 'сценарий не перешёл из start после wake');
  });
  await s.step('landing', 'Посадка кота на карту', async () => {
    const ok = await s.until(() => window.__app.stage.root.visible && window.__app.tracker.isTracking, 90000);
    const sec = (Date.now() - wakeAt) / 1000;
    s.note(`кот на карте через ${sec.toFixed(1)} с после «Открыть камеру» (CPU ×${THROTTLE}, headless)`);
    s.check(ok, 'кот не сел на карту за 90 с');
    if (ok) s.check(sec < BUDGET.landingSec, `посадка дольше бюджета: ${sec.toFixed(1)} с > ${BUDGET.landingSec} с`, 'warn');
    await s.sample('baseline', true);
  });
  await s.step('meet', 'Знакомство целиком: поздравление → «как тебя зовут?» → имя → «я — …» → обучалка', async (st) => {
    const asked = await s.until(() => window.__app.director.state.phase === 'ask_name', 60000);
    s.check(asked, 'кот не спросил имя за 60 с (фаза ask_name)');
    st.shots.push(await s.shot('ask_name'));
    const listen = await s.waitListen('name', 40000);
    s.check(listen, 'кот не дождался ответа (dialog.listening = name)');
    await sleep(800);
    await s.say('Маша');
    const play = await s.until(() => ['play', 'free'].includes(window.__app.director.state.phase), 90000);
    s.check(play, 'знакомство не закончилось игрой за 90 с');
    await s.waitQuiet(30000);
    const mem = await s.ev(() => {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (/sber-ar-cat/.test(k)) return localStorage.getItem(k);
      }
      return null;
    });
    s.check(mem && /Маша/.test(mem), 'имя «Маша» не сохранилось в памяти');
    const ids = (await s.since(0, 'speak')).map((x) => x.id);
    s.note(`реплики знакомства: ${ids.join(', ')}`);
    for (const ev of ['ask_name', 'nice_name']) s.check(ids.some((x) => x.includes(ev)), `в знакомстве не прозвучало событие ${ev}`, 'warn');
  });
  await s.step('actions', 'Панель кнопок действий (если есть в этой сборке)', async (st) => {
    const btns = (await s.visible('[data-act]:not(.sug)', 'data-act')).filter((b) => !['more', 'other'].includes(b.key));
    if (!btns.length) {
      s.note('панели кнопок нет (экран «вариант А»: действия — в каталоге по лапке и в чипах кота)');
      return;
    }
    st.shots.push(await s.shot('actions_panel'));
    const res = [];
    for (const b of btns) {
      await s.endGames();
      await s.waitQuiet(8000);
      const rt = await s.now();
      await s.mark(`кнопка: ${b.key}`);
      if (!(await s.tapEl(`[data-act="${b.key}"]:not(.sug)`))) {
        s.issue(`кнопка ${b.key}: не удалось долистать и нажать`, 'warn');
        continue;
      }
      const r = await s.waitReaction(rt, 4000);
      res.push(`${b.key} → ${r ? r.speak ?? r.clip : '—'}`);
      s.check(r, `кнопка «${b.label || b.key}»: кот не отреагировал за 4 с (ни реплики, ни клипа)`);
      await sleep(2000);
    }
    s.note(res.join('; '));
  });
  await s.step('catalog', 'Каталог «Что умеет кот»: каждый пункт каждого раздела', async (st) => {
    await s.endGames();
    await s.waitQuiet(15000);
    if (!(await s.openCatalog())) return s.issue('каталог не открывается (лапка data-a="paw" / «Ещё»)');
    st.shots.push(await s.shot('catalog'));
    const tabs = (await s.visible('[data-tab]', 'data-tab')).map((t) => t.key);
    const items = [];
    for (const t of tabs.length ? tabs : [null]) {
      if (t) {
        await s.tapEl(`[data-tab="${t}"]`);
        await sleep(400);
      }
      for (const it of await s.visible('[data-item]', 'data-item')) if (!items.some((x) => x.id === it.key)) items.push({ id: it.key, label: it.label, tab: t });
    }
    await s.closeCatalog();
    s.note(`разделов ${tabs.length}, пунктов ${items.length}`);
    s.check(items.length >= 10, `в каталоге всего ${items.length} пунктов`);
    const res = [], silent = [];
    // «Другой кот» — отдельный шаг; пункты «Ещё» (ui:*) — не умения кота
    for (const it of items.filter((x) => x.id !== 'other' && !x.id.startsWith('ui:'))) {
      await s.endGames();
      await s.waitQuiet(10000);
      await s.until(() => !window.__app.director.dozing, 9000);
      const rt = await s.now();
      await s.mark(`каталог: ${it.id}`);
      if (!(await s.catalogPick(it.id, it.tab))) {
        s.issue(`каталог: пункт «${it.label}» не нажать`, 'warn');
        continue;
      }
      const r = await s.waitReaction(rt, 4500);
      res.push(`${it.id} → ${r ? r.speak ?? r.clip : '—'}`);
      if (!r) silent.push(it.label);
      await sleep(1500);
    }
    s.check(!silent.length, `каталог: кот не отреагировал за 4,5 с на ${silent.map((x) => `«${x}»`).join(', ')}`);
    s.note(res.join('; '));
    const closed = await s.ev(() => document.querySelector('.catalog')?.classList.contains('hidden') ?? true);
    s.check(closed, 'каталог не закрылся после выбора пункта', 'warn');
  });
  await s.step('chips', 'Чипы-предложения от кота', async (st) => {
    await s.endGames();
    await s.waitQuiet(15000);
    const chips = await s.visible('.sug, [data-chip]', 'data-chip');
    if (!chips.length) {
      s.note('чипов от кота сейчас нет');
      return;
    }
    st.shots.push(await s.shot('chips'));
    s.check(chips.length <= 2, `чипов на экране ${chips.length} (ожидали не больше двух)`, 'warn');
    const res = [];
    for (const c of chips.slice(0, 2)) {
      await s.endGames();
      await s.waitQuiet(10000);
      const rt = await s.now();
      if (!(await s.tapEl(`[data-chip="${c.key}"]`))) continue;
      const r = await s.waitReaction(rt, 4500);
      res.push(`${c.label} → ${r ? r.speak ?? r.clip : '—'}`);
      s.check(r, `чип «${c.label}»: кот не отреагировал за 4,5 с`);
      await sleep(2000);
    }
    s.note(res.join('; '));
  });
  await s.step('speech', 'Голосовые фразы ребёнка', async () => {
    await s.endGames();
    const res = [];
    for (const t of ['привет', 'как тебя зовут', 'сколько тебе лет', 'ты классный', 'абырвалг', 'мне грустно']) {
      await s.waitQuiet(12000);
      const rt = await s.now();
      await s.say(t);
      const sp = await s.waitSpeak(rt, 5000);
      res.push(`«${t}» → ${sp?.id ?? '—'}`);
      s.check(sp, `на «${t}» кот ничего не сказал за 5 с`, t === 'абырвалг' ? 'warn' : 'error');
      await sleep(1500);
    }
    s.note(res.join('; '));
    // «мне грустно» — кот бережно ответил; действие ребёнка всё равно работает (пауза кончается), QA № 9
    await s.waitQuiet(12000);
    const pt = await s.now();
    await s.catalogPick('pet', 'care');
    const pr = await s.waitReaction(pt, 4500);
    s.check(pr, 'после «мне грустно» кот не отреагировал на «Погладить» за 4,5 с');
    s.note(`после «мне грустно» → «Погладить»: ${pr ? pr.speak ?? pr.clip : '—'}`);
  });
  await s.step('riddle', 'Мини-игра «загадка»: неверно → сдаюсь → «ещё?» → нет', async () => {
    await s.endGames();
    await s.waitQuiet(15000);
    await s.say('загадай загадку');
    s.check(await s.waitListen('riddle', 30000), 'загадка: кот не ждёт ответа (listening=riddle)');
    await sleep(1200);
    await s.say('кукуруза');
    await sleep(1000);
    s.check(await s.waitListen('riddle', 20000), 'загадка: после неверного ответа кот не ждёт снова', 'warn');
    await sleep(800);
    // чип «Сдаюсь» от кота (вариант А) — как сказанное «сдаюсь»
    const chips = (await s.visible('.sug, [data-chip]', 'data-chip')).map((c) => c.label);
    s.note(`чипы во время загадки: ${chips.join(', ') || '—'}`);
    if (chips.length || (await s.ev(() => !!document.querySelector('.chips.suggest')))) s.check(chips.some((c) => /сдаюсь/i.test(c)), 'во время загадки нет чипа «Сдаюсь»', 'warn');
    if (!(await s.tapChip(/сдаюсь/i))) await s.say('сдаюсь');
    const more = await s.until(() => !!window.__app.director.state.dialog?.listening && !window.__app.director.queue.busy, 25000);
    s.check(more, 'после «сдаюсь» кот не спросил «ещё загадку?»', 'warn');
    await sleep(800);
    const rt = await s.now();
    await s.say('нет');
    const end = await s.until(() => !window.__app.director.state.dialog, 20000);
    s.check(end, 'загадка не закончилась после «нет» за 20 с');
    const sp = await s.waitSpeak(rt, 6000);
    s.check(sp, 'конец загадки — без слов', 'warn');
  });
  await s.step('echo', 'Мини-игра «повторялка»: фраза → «хватит»', async () => {
    await s.endGames();
    await s.waitQuiet(15000);
    await s.say('повторяй за мной');
    const ok = await s.until(() => window.__app.director.state.dialog?.listening === 'echo', 25000);
    s.check(ok, 'повторялка: кот не перешёл в режим повтора (listening=echo)');
    await sleep(1500);
    await s.say('я кот в сапогах');
    await sleep(3000);
    const rt = await s.now();
    const chips = (await s.visible('.sug, [data-chip]', 'data-chip')).map((c) => c.label);
    s.note(`чипы в повторялке: ${chips.join(', ') || '—'}`);
    if (!(await s.tapChip(/хватит/i))) await s.say('хватит');
    const end = await s.until(() => !window.__app.director.state.dialog, 20000);
    s.check(end, 'повторялка не закончилась по «хватит» за 20 с');
    s.check(await s.waitSpeak(rt, 6000), 'конец повторялки — без слов', 'warn');
  });
  await s.step('riddle_button', 'Кнопка посреди загадки: игра кончается, команда выполняется', async () => {
    await s.endGames();
    await s.waitQuiet(15000);
    await s.say('загадай загадку');
    s.check(await s.waitListen('riddle', 30000), 'загадка не началась');
    // кнопка-команда (LOGIC.md п. 4: «Танцуй» посреди загадки — танец); кнопки-касания (погладить) загадку не прерывают
    const keys = (await s.visible('[data-act]:not(.sug)', 'data-act')).map((b) => b.key);
    const key = ['dance', 'flip', 'jump', 'sing', 'wave'].find((k) => keys.includes(k));
    const rt = await s.now();
    // панель кнопок (старый экран) или каталог по лапке (вариант А): «Танец»
    let btn = key ? await s.tapEl(`[data-act="${key}"]:not(.sug)`) : null;
    if (btn) btn.key = key;
    else if ((btn = await s.catalogPick('dance', 'tricks'))) btn.key = 'dance (каталог)';
    if (!btn) {
      s.issue('нет кнопки действия на экране во время загадки', 'warn');
      await s.say('сдаюсь');
      await sleep(1000);
      await s.say('нет');
      return;
    }
    const r = await s.waitReaction(rt, 4000);
    s.check(r, `кнопка ${btn.key} посреди загадки: нет реакции`);
    const end = await s.until(() => !window.__app.director.state.dialog, 8000);
    s.check(end, `кнопка ${btn.key} посреди загадки: загадка не закончилась`);
    const wrong = (await s.since(rt, 'log')).find((x) => /answer:wrong/.test(x.s));
    s.check(!wrong, `кнопка ${btn.key} посреди загадки засчитана как неверный ответ`);
  });
  await s.step('touch', 'Касания: тап по коту, поглаживание, тап мимо', async () => {
    await s.endGames();
    await s.waitQuiet(15000);
    const c = await s.catCenter();
    if (!c) return s.issue('кота нет на экране');
    let rt = await s.now();
    await s.tapXY(c.x, c.y);
    s.check(await s.waitReaction(rt, 4000), 'тап по коту: нет реакции');
    await sleep(2500);
    rt = await s.now();
    // поглаживание: палец ведём по спине
    const tp = s.page.touchscreen;
    await tp.touchStart(c.x - 30, c.y - 10);
    for (let i = 0; i < 24; i++) {
      await tp.touchMove(c.x - 30 + (i % 12) * 5, c.y - 10 + Math.sin(i / 2) * 4);
      await sleep(60);
    }
    await tp.touchEnd();
    const r = await s.waitReaction(rt, 3000);
    s.check(r, 'поглаживание: нет реакции', 'warn');
    await sleep(2500);
    rt = await s.now();
    await s.tapXY(40, 300);
    s.note(`тап мимо: ${JSON.stringify(await s.waitReaction(rt, 2500))}`);
  });
  await s.step('mute', '«Без звука»: реплика идёт молча, пузырь успевают прочитать', async (st) => {
    await s.endGames();
    await s.waitQuiet(15000);
    const m = await s.tapEl('[data-a="mute"]');
    if (!m) return s.issue('нет кнопки «Без звука» (data-a="mute")', 'warn');
    await sleep(500);
    const rt = await s.now();
    await s.say('привет');
    const sp = await s.waitSpeak(rt, 5000);
    s.check(sp, 'без звука кот не ответил на «привет» (ни пузыря)');
    if (sp) {
      await sleep(1200);
      const on = await s.ev(() => document.querySelector('.bubble')?.classList.contains('show'));
      s.check(on, `без звука пузырь «${sp.text}» погас раньше 1,2 с — не прочитать`);
      st.shots.push(await s.shot('muted_bubble'));
    }
    await s.waitQuiet(15000);
    await s.tapEl('[data-a="mute"]');
    await sleep(500);
    s.check(await s.ev(() => !window.__app.voice.muted), 'звук не включился обратно');
  });
  await s.step('card_lost', 'Карта пропала → «где карта?» → вернулась', async (st) => {
    await s.endGames();
    await s.waitQuiet(15000);
    const rt = await s.now();
    s.check(await s.ev(() => window.__qaCam.cover(true)), 'стенд: не удалось подменить камеру');
    const lost = await s.until(() => !window.__app.director.state.cardVisible, 12000);
    s.check(lost, 'сценарий не заметил потерю карты за 12 с');
    const sp = await s.waitSpeak(rt, 10000, (id) => /card_lost/.test(id));
    s.check(sp, 'кот не спросил про пропавшую карту за 10 с (событие card_lost)');
    s.note(`потеря: ${(await s.since(rt, 'speak')).map((x) => x.id).join(', ') || '—'}`);
    await sleep(3000);
    st.shots.push(await s.shot('card_lost'));
    const rt2 = await s.now();
    await s.ev(() => window.__qaCam.cover(false));
    const back = await s.until(() => window.__app.director.state.cardVisible && window.__app.tracker.isTracking && window.__app.stage.root.visible, 45000);
    s.check(back, 'кот не вернулся на карту за 45 с');
    const sp2 = await s.waitSpeak(rt2, 8000, (id) => /card_found/.test(id));
    s.check(sp2, 'кот не обрадовался возврату карты (card_found)', 'warn');
    s.note(`возврат: ${(await s.since(rt2, 'speak')).map((x) => x.id).join(', ') || '—'}`);
    const ph = await s.phase();
    s.check(['play', 'free'].includes(ph), `после возврата карты фаза ${ph}, а не игра`);
  });
  await s.step('reanchor', 'Долгое нажатие на кота → «Пересадить на другую карту» → кот снова на карте', async (st) => {
    await s.endGames();
    await s.waitQuiet(15000);
    const c = await s.catCenter();
    if (!c) return s.issue('кота нет на экране');
    const tp = s.page.touchscreen;
    await tp.touchStart(c.x, c.y);
    await sleep(900);
    await tp.touchEnd();
    const menu = await s.until(() => !!document.querySelector('.press-menu:not(.hidden) [data-a="press-reanchor"], [role=menu]:not(.hidden) [data-a="press-reanchor"]'), 3000);
    if (!menu) {
      s.note('меню долгого нажатия не появилось — пересадка из каталога');
      if (!(await s.catalogPick('ui:reanchor'))) return s.note('пункта «Пересадить» нет в этой сборке');
    } else {
      st.shots.push(await s.shot('press_menu'));
      await s.tapEl('[data-a="press-reanchor"]');
    }
    await sleep(1500);
    const back = await s.until(() => window.__app.stage.root.visible && window.__app.tracker.isTracking, 45000);
    s.check(back, 'после «Пересадить» кот не вернулся на карту за 45 с');
    const ph = await s.phase();
    s.check(['play', 'free'].includes(ph), `после пересадки фаза ${ph}, а не игра`);
  });
  await s.step('switch', 'Смена кота: «Другой кот» → наклейки → встряска → новый образ', async (st) => {
    await s.endGames();
    await s.waitQuiet(15000);
    const before = await s.ev(() => window.__app.director.persona.id);
    const m0 = await s.sample('switch0', true);
    const ui = (await s.tapEl('[data-act="other"]:not(.sug)')) ?? (await s.catalogPick('other', 'games'));
    if (!ui) {
      s.note('кнопки «Другой кот» на экране нет — фразой «давай другого»');
      await s.say('давай другого кота');
    }
    // кнопка «Другой кот» — кот переспрашивает (чипы «Давай!» / «Не надо», 8 с): одно касание могло быть случайным
    if (ui) {
      const ask = await s.until(() => window.__app.director.state.dialog?.id === 'switch', 6000);
      s.check(ask, 'кнопка «Другой кот»: кот не переспросил (диалог switch)', 'warn');
      if (ask) {
        await s.until(() => !!document.querySelector('.sug[data-chip="yes"]'), 8000);
        const chips = await s.visible('.sug, [data-chip]', 'data-chip');
        s.note(`подтверждение: ${chips.map((c) => c.label).join(' / ') || 'чипов нет'}`);
        if (!(await s.tapEl('.sug[data-chip="yes"]'))) await s.say('давай');
      }
    }
    const sw = await s.until(() => window.__app.director.state.phase === 'switching', 10000);
    s.check(sw, 'смена кота не началась (фаза switching)');
    await sleep(5000);
    st.shots.push(await s.shot('stickers'));
    const shake = await s.tapEl('[data-a="shake"]');
    if (!shake) {
      s.note('кнопки «Сдёрнуть наклейки» нет — встряска датчиком');
      await s.ev(() => window.__app.input.simulateShake?.() ?? window.__app.director.interaction('shake'));
    }
    const done = await s.until((b) => window.__app.director.persona.id !== b && ['play', 'free'].includes(window.__app.director.state.phase), 40000, before);
    s.check(done, 'новый образ не появился за 40 с');
    const after = await s.ev(() => window.__app.director.persona.id);
    s.note(`${before} → ${after}`);
    await s.until(() => window.__app.character?.kind !== 'glb' || window.__app.character.object?.visible !== false, 30000);
    await s.waitQuiet(20000);
    const m1 = await s.sample('switch1', true);
    s.note(`текстуры GPU: ${m0.tex} → ${m1.tex}, геометрии: ${m0.geo} → ${m1.geo}, программы: ${m0.prog} → ${m1.prog}`);
    s.check(m1.tex - m0.tex <= BUDGET.texGrowPerSwitch, `после смены кота текстур GPU больше на ${m1.tex - m0.tex} (утечка старой модели?)`);
  });
  await s.step('silence', `3 мин тишины (время ×${K}): лестница → дрёма`, async (st) => {
    await s.endGames();
    await s.waitQuiet(20000);
    const rt = await s.now();
    await s.ev((k) => window.__qaSetK(k), K);
    await s.mark(`ускорение ×${K}`);
    await s.vwait(180_000);
    const logs = (await s.since(rt, 'log')).map((x) => x.s).filter((x) => /^(тишина|энергия)/.test(x));
    s.note(`лестница: ${logs.join(' · ') || '—'}`);
    const dz = await s.ev(() => ({ dozing: !!window.__app.director.dozing, energy: window.__app.energy?.out?.mode }));
    s.check(dz.dozing, 'через 3 мин тишины кот не дремлет (director.dozing)');
    // энергобюджет: «doze» через 60 с без активности после последней реплики (засыпания)
    const eDoze = await s.until(() => window.__app.energy?.out?.mode === 'doze', 75000 / (await s.ev(() => window.__qaK())));
    const e = await s.ev(() => ({ mode: window.__app.energy?.out?.mode, live: window.__app.fx.activeIds, parts: window.__app.fx.parts.list.length, clip: window.__app.character.currentClip }));
    s.check(eDoze, `спящий кот: энергобюджет не уходит в «doze» (${e.mode}; эффекты: ${e.live.join(',') || '—'}, частиц ${e.parts}, клип ${e.clip})`);
    const sp = await s.since(rt, 'speak');
    const ids = sp.map((x) => x.id);
    const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
    s.check(!dup.length, `за 3 мин тишины запись звучала дважды: ${[...new Set(dup)].join(', ')}`, 'warn');
    s.check(sp.length >= 2, `кот за 3 мин тишины сказал всего ${sp.length} реплик(и)`, 'warn');
    const chips = (await s.visible('.sug, [data-chip]', 'data-chip')).map((c) => c.label);
    s.note(`чипы в дрёме: ${chips.join(', ') || '—'}`);
    st.shots.push(await s.shot('doze'));
  });
  await s.step('wake_up', 'Пробуждение касанием', async () => {
    await s.ev(() => window.__qaSetK(1));
    const c = await s.catCenter();
    const rt = await s.now();
    if (c) await s.tapXY(c.x, c.y);
    const ok = await s.until(() => !window.__app.director.dozing, 5000);
    s.check(ok, 'кот не проснулся от касания за 5 с');
    s.check(await s.waitSpeak(rt, 6000), 'проснулся молча (ожидали «А? Я не спал!»)', 'warn');
    await s.until(() => window.__app.energy?.out?.mode !== 'doze', 3000);
    const e = await s.ev(() => window.__app.energy?.out?.mode);
    s.check(e !== 'doze', 'энергобюджет остался в дрёме после пробуждения', 'warn');
    await sleep(3000);
    const live = await s.ev(() => window.__app.fx.activeIds);
    s.check(!live.includes('zzz'), 'после пробуждения над котом летают «Zzz» (петля не остановлена)');
  });
  await s.step('end', 'Итог сессии: память, утечки', async () => {
    await s.waitQuiet(20000);
    await s.sample('final', true);
  });
  const rec = await s.rec().catch(() => []);
  const err = await s.ev(() => window.__qaErr ?? []).catch(() => []);
  const long = await s.ev(() => (window.__qaLong ?? []).map((x) => ({ ...x, rt: Math.round(x.at - (window.__qaR0 ?? 0)) }))).catch(() => []);
  const draws = await s.ev(() => (window.__qaDrawWin ?? []).map(([a, b]) => [a - (window.__qaR0 ?? 0), b - (window.__qaR0 ?? 0)])).catch(() => []);
  if (PROFILE) await dumpProfile(s);
  return { s, rec, err, long, draws };
}

// ───────────── сессия 2: повторный визит (тот же профиль браузера — память первой сессии) ─────────────
async function sessionReturn(browser, ctx) {
  const s = await openPage(browser, ctx, 'return', { memory: { name: 'Маша', persona: 'kind', met: true, visits: 2 } });
  await s.page.goto(URL0, { waitUntil: 'domcontentloaded' });
  await s.cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  let wakeBtn, wakeAt = 0;
  await s.step('ret_onboarding', 'Повторный визит: стартовый экран', async (st) => {
    wakeBtn = await onboarding(s, st);
    const mem = await s.ev(() => window.__app.director.state);
    s.check(mem.met && mem.name === 'Маша', `память не подхватилась: met=${mem.met}, name=${mem.name}`);
  });
  await s.step('ret_landing', 'Повторный визит: посадка и «с возвращением»', async () => {
    if (!wakeBtn) throw new Error('нет кнопки wake');
    wakeAt = await permissionsAndLanding(s, wakeBtn);
    const ok = await s.until(() => window.__app.stage.root.visible && window.__app.tracker.isTracking, 90000);
    s.check(ok, 'кот не сел на карту за 90 с');
    s.note(`посадка через ${((Date.now() - wakeAt) / 1000).toFixed(1)} с`);
    const play = await s.until(() => ['play', 'free'].includes(window.__app.director.state.phase), 40000);
    s.check(play, 'повторный визит не перешёл в игру за 40 с');
    const asked = (await s.since(0, 'phase')).some((x) => x.p === 'ask_name');
    s.check(!asked, 'повторный визит: кот снова спрашивает имя');
    const sp = await s.waitSpeak(0, 15000);
    s.check(sp, 'повторный визит: нет приветствия');
    s.note(`приветствие: ${sp?.id ?? '—'} «${sp?.text ?? ''}»`);
    await s.waitQuiet(20000);
  });
  await s.step('ret_play', 'Повторный визит: кнопка и фраза', async () => {
    const b = (await s.visible('[data-act]', 'data-act')).find((x) => !['more', 'other'].includes(x.key));
    if (b) {
      const rt = await s.now();
      await s.tapXY(b.x, b.y);
      s.check(await s.waitReaction(rt, 4000), `кнопка ${b.key}: нет реакции`);
      await sleep(3000);
    }
    await s.waitQuiet(15000);
    const rt = await s.now();
    await s.say('привет');
    s.check(await s.waitSpeak(rt, 5000), 'на «привет» нет ответа');
    await s.waitQuiet(15000);
    await s.sample('final', true);
  });
  const rec = await s.rec().catch(() => []);
  const err = await s.ev(() => window.__qaErr ?? []).catch(() => []);
  const long = await s.ev(() => (window.__qaLong ?? []).map((x) => ({ ...x, rt: Math.round(x.at - (window.__qaR0 ?? 0)) }))).catch(() => []);
  const draws = await s.ev(() => (window.__qaDrawWin ?? []).map(([a, b]) => [a - (window.__qaR0 ?? 0), b - (window.__qaR0 ?? 0)])).catch(() => []);
  if (PROFILE) await dumpProfile(s);
  return { s, rec, err, long, draws };
}

// ───────────── сессия 3: камера запрещена ─────────────
async function sessionDenied(browser) {
  const ctx = await browser.createBrowserContext();
  const s = await openPage(browser, ctx, 'denied', { clear: true, denyCam: true });
  await s.page.goto(`${URL0}?fresh`, { waitUntil: 'domcontentloaded' });
  let wakeBtn;
  await s.step('denied', 'Камера запрещена: понятный экран и кнопка «повторить»', async (st) => {
    wakeBtn = await onboarding(s, st);
    if (!wakeBtn) throw new Error('нет кнопки wake');
    await s.tapXY(wakeBtn.x, wakeBtn.y);
    const err = await s.until(() => [...document.querySelectorAll('[data-a="reload"]')].some((b) => b.getBoundingClientRect().width > 0 && !b.closest('.hidden')), 15000);
    s.check(err, 'нет экрана ошибки с кнопкой (data-a="reload")');
    const txt = await s.ev(() => document.body.innerText);
    s.check(/камер/i.test(txt), 'на экране ошибки не сказано про камеру');
  });
  const err = await s.ev(() => window.__qaErr ?? []).catch(() => []);
  await ctx.close();
  // запрет камеры здесь ожидаем: приложение пишет его в console.error и показывает экран ошибки
  s.console = s.console.filter((c) => !/NotAllowedError/.test(c.text));
  return { s, rec: [], err, long: [] };
}

// ───────────── сессия 4: хаотичные тапы (?flow=chaos — автотапер в странице, настоящие pointer-события) ─────────────
// Ассерты: касание обрабатывается быстро (худшее и среднее время dispatchEvent), кадры не проваливаются, очередь реплик
// не растёт, после бури кот договаривает и возвращается в покой, ошибок нет. Пороги — для headless CPU ×THROTTLE.
async function sessionChaos(browser, ctx) {
  const DUR = Number(arg('--chaos-dur', 40));
  const s = await openPage(browser, ctx, 'chaos', { memory: { name: 'Маша', persona: 'hooligan', met: true, visits: 3 } });
  await s.page.goto(`${URL0}?flow=chaos&dur=${DUR}`, { waitUntil: 'domcontentloaded' });
  await s.cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  let wakeBtn;
  await s.step('chaos_start', 'Хаос: старт и посадка (повторный визит, ?flow=chaos)', async (st) => {
    wakeBtn = await onboarding(s, st);
    if (!wakeBtn) throw new Error('нет кнопки wake');
    await permissionsAndLanding(s, wakeBtn);
    const ok = await s.until(() => window.__app.stage.root.visible && ['play', 'free'].includes(window.__app.director.state.phase), 90000);
    s.check(ok, 'кот не вышел в игру за 90 с');
    // зона под пальцем: капсулы костей (быстро) против луча по скинованной сетке (старый путь) — сетка точек вокруг кота
    const z = await s.ev(() => {
      const app = window.__app, ch = app.character, r = app.ui.catRect?.();
      if (!r || !ch.hitZoneMesh) return null;
      const THREE_RAY = app.ray ?? null;
      const w = app.root.clientWidth, h = app.root.clientHeight;
      let n = 0, same = 0, onBoth = 0, onlyMesh = 0, onlyProxy = 0, tm = 0, tp = 0;
      const diff = {};
      for (let i = 0; i <= 10; i++)
        for (let j = 0; j <= 12; j++) {
          const x = r.cx + (i / 10 - 0.5) * r.half * 3.2, y = r.top + (j / 12) * (r.bottom - r.top) * 1.1 - 10;
          const ray = THREE_RAY;
          ray.setFromCamera({ x: (x / w) * 2 - 1, y: -(y / h) * 2 + 1 }, app.tracker.camera);
          app.stage.root.updateMatrixWorld(true);
          let t0 = performance.now();
          const a = ch.hitZoneMesh(ray);
          tm += performance.now() - t0;
          t0 = performance.now();
          const b = ch.hitZone(ray);
          tp += performance.now() - t0;
          n++;
          if (a === b) same++;
          else diff[`${a}→${b}`] = (diff[`${a}→${b}`] ?? 0) + 1;
          if (a && b) onBoth++;
          else if (a) onlyMesh++;
          else if (b) onlyProxy++;
        }
      return { n, same, onBoth, onlyMesh, onlyProxy, meshMs: tm / n, proxyMs: tp / n, diff };
    }).catch((e) => ({ err: String(e) }));
    if (z?.n) {
      s.note(`зоны касания: капсулы против сетки — совпало ${z.same}/${z.n} (${Math.round((z.same / z.n) * 100)}%), «на коте» только по сетке ${z.onlyMesh}, только по капсулам ${z.onlyProxy}; время на точку: сетка ${z.meshMs.toFixed(2)} мс, капсулы ${z.proxyMs.toFixed(3)} мс; расхождения ${JSON.stringify(z.diff)}`);
      s.check(z.same / z.n >= 0.8, `зоны капсул расходятся с сеткой: совпало ${z.same}/${z.n}`, 'warn');
    } else s.note(`сверка зон: ${JSON.stringify(z)}`);
    await s.sample('baseline', true);
  });
  await s.step('chaos_storm', `Хаос: ${DUR} с тапов 5–15/с по коту и мимо, глажка, долгое, кнопки, фразы`, async (st) => {
    const go = await s.until(() => !!window.__chaos, 20000);
    if (!s.check(go, 'автотапер не запустился (window.__chaos)')) return;
    const long0 = await s.ev(() => window.__qaLong.length);
    let maxQ = 0, clips = new Set(), samples = 0;
    const end = Date.now() + (DUR + 60) * 1000;
    while (Date.now() < end) {
      const r = await s.ev(() => ({ run: window.__chaos.running, q: window.__app.director.queue.pending.length, clip: window.__app.character.currentClip }));
      maxQ = Math.max(maxQ, r.q);
      clips.add(r.clip);
      samples++;
      if (!r.run) break;
      await sleep(500);
    }
    st.shots.push(await s.shot('chaos_mid'));
    const c = await s.ev(() => ({ ...window.__chaos, avg: window.__chaos.sumMs / Math.max(1, window.__chaos.n) }));
    const long = await s.ev((n) => window.__qaLong.slice(n).filter((x) => x.ms > 200).length, long0);
    s.note(`касаний ${c.taps}, глажек ${c.strokes}, долгих ${c.longs}, кнопок ${c.buttons}, фраз ${c.phrases}; обработка pointer-события: ср. ${c.avg.toFixed(2)} мс, худшее ${c.maxMs.toFixed(1)} мс (CPU ×${THROTTLE}); к/с мин ${Number.isFinite(c.fpsMin) ? c.fpsMin.toFixed(0) : '—'}; длинных задач > 200 мс: ${long}; очередь реплик макс. ${maxQ}; клипов за бурю ${clips.size}`);
    s.check(!c.running, 'буря не закончилась вовремя');
    // headless: главный поток занят SwiftShader и чтением кадра камеры (BUGS № 13) — таймеры автотапера опаздывают
    s.check(c.taps > DUR, `автотапер сделал мало касаний: ${c.taps}`, 'warn');
    // 2 мс на телефоне ≈ 2×THROTTLE в headless; худшее — с запасом на сборку мусора
    s.check(c.avg < 2 * THROTTLE, `касание обрабатывается в среднем ${c.avg.toFixed(2)} мс (бюджет ${2 * THROTTLE} мс при CPU ×${THROTTLE})`);
    s.check(c.maxMs < 16 * THROTTLE, `худшее касание ${c.maxMs.toFixed(1)} мс — дольше кадра (×${THROTTLE})`, 'warn');
    s.check(maxQ <= 4, `очередь реплик выросла до ${maxQ}`);
    s.check(long <= 3, `длинных задач > 200 мс во время бури: ${long}`, 'warn');
  });
  await s.step('chaos_after', 'Хаос: после бури кот договаривает и возвращается в покой', async () => {
    const quiet = await s.waitQuiet(30000);
    s.check(quiet, 'кот не замолчал за 30 с после бури');
    await sleep(5000);
    const r = await s.ev(() => ({ clip: window.__app.character.currentClip, q: window.__app.director.queue.busy, phase: window.__app.director.state.phase, zzz: window.__app.fx.activeIds?.includes?.('zzz') }));
    s.check(/^(idle|talk|listen|sleep|walk)/.test(r.clip) || r.q, `кот «залип» в клипе ${r.clip}`);
    s.check(['play', 'free'].includes(r.phase), `после бури фаза ${r.phase}`);
    await s.sample('final', true);
  });
  const rec = await s.rec().catch(() => []);
  const err = await s.ev(() => window.__qaErr ?? []).catch(() => []);
  const long = await s.ev(() => (window.__qaLong ?? []).map((x) => ({ ...x, rt: Math.round(x.at - (window.__qaR0 ?? 0)) }))).catch(() => []);
  const draws = await s.ev(() => (window.__qaDrawWin ?? []).map(([a, b]) => [a - (window.__qaR0 ?? 0), b - (window.__qaR0 ?? 0)])).catch(() => []);
  if (PROFILE) await dumpProfile(s);
  return { s, rec, err, long, draws };
}

// ───────────── запуск ─────────────
media();
if (!flag('--no-build') && !arg('--url', '')) build();
fs.mkdirSync(path.join(DIST, '__qa'), { recursive: true });
spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', path.join(MEDIA, 'table.png'), '-q:v', '3', path.join(DIST, '__qa/table.jpg')]);
const server = await serve();
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/usr/bin/google-chrome',
  headless: !flag('--headful'),
  protocolTimeout: 600_000,
  args: [
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${path.join(MEDIA, 'still.y4m')}`, `--use-file-for-fake-audio-capture=${path.join(MEDIA, 'room.wav')}`,
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--autoplay-policy=no-user-gesture-required',
    '--lang=ru-RU', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--enable-precise-memory-info',
  ],
});
const started = Date.now();
const sessions = [];
try {
  const ctx = await browser.createBrowserContext();
  if (ONLY.includes('first')) {
    const r = await sessionFirst(browser, ctx);
    sessions.push(r);
    if (!flag('--keep')) await r.s.page.close();
  }
  if (ONLY.includes('return')) {
    const r = await sessionReturn(browser, ctx);
    sessions.push(r);
    if (!flag('--keep')) await r.s.page.close();
  }
  if (ONLY.includes('denied')) sessions.push(await sessionDenied(browser));
  if (ONLY.includes('chaos')) {
    const r = await sessionChaos(browser, await browser.createBrowserContext());
    sessions.push(r);
    if (!flag('--keep')) await r.s.page.close();
  }
} finally {
  const results = sessions.map((x) => ({ name: x.s.name, steps: x.s.steps, metrics: x.s.metrics, console: x.s.console, err: x.err, long: x.long, rec: x.rec, analysis: analyze(x) }));
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results.map(({ rec, ...r }) => r), null, 1));
  for (const r of results) fs.writeFileSync(path.join(OUT, `rec_${r.name}.json`), JSON.stringify(r.rec));
  const md = renderReport(results, { throttle: THROTTLE, k: K, url: URL0, minutes: (Date.now() - started) / 60000, commit: spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).stdout?.toString().trim() });
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, md);
  log(`отчёт: ${path.relative(root, REPORT)}`);
  if (!flag('--keep')) await browser.close();
  if (server) process.kill(-server.pid);
  const bad = results.flatMap((r) => r.steps).filter((s) => !s.ok).length + results.reduce((n, r) => n + r.analysis.errors.length, 0);
  log(bad ? `ОШИБОК: ${bad}` : 'всё ок');
  process.exitCode = bad ? 1 : 0;
}
