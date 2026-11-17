#!/usr/bin/env node
// Аудит сценария в headless Chrome: полные сессии каждого характера (новый ребёнок / повторный визит),
// расшифровка «время → событие → реплика (id, текст, озвучена ли) → клип/эмоция → пузырь» в docs/scenario/transcripts/*.md.
//
//   npx vite build && node scripts/scenario/fake-voice.mjs dist 4
//   npx vite preview --port 4173 --strictPort &
//   node scripts/scenario/audit.mjs [--k 4] [--only hooligan] [--scen silence,buttons] [--out docs/scenario/transcripts]
//
// Время на странице ускорено в K раз (setTimeout / performance.now / Date.now), длины «записей» в fake-voice — тоже,
// поэтому в расшифровке — виртуальные секунды, как на телефоне.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const K = Number(arg('--k', 4));
const URL0 = arg('--url', 'http://localhost:4173/');
const OUT = path.resolve(root, arg('--out', 'docs/scenario/transcripts'));
const ONLY = arg('--only', '');
const SCEN = arg('--scen', 'silence,buttons,speech,touch,card,switch').split(',');
const PAR = Number(arg('--par', 3));
const CHAR = arg('--char', 'sprite');
fs.mkdirSync(OUT, { recursive: true });

const PERSONAS = ['hooligan', 'kind', 'glitter'];
const TITLE = { hooligan: 'Хулиган', kind: 'Добряк', glitter: 'Блёстка' };

/** скрипт до загрузки страницы: ускорение времени и память */
const prelude = (K, mem) => {
  const rn = performance.now.bind(performance), p0 = rn();
  performance.now = () => p0 + (rn() - p0) * K;
  const dn = Date.now, d0 = dn();
  Date.now = () => d0 + (dn() - d0) * K;
  const st = window.setTimeout.bind(window), si = window.setInterval.bind(window);
  window.setTimeout = (f, ms, ...a) => st(f, (Number(ms) || 0) / K, ...a);
  window.setInterval = (f, ms, ...a) => si(f, (Number(ms) || 0) / K, ...a);
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf(() => cb(performance.now()));
  try {
    localStorage.clear();
    localStorage.setItem('ar.micMode', 'ptt');
    if (mem) localStorage.setItem('sber-ar-cat:v1', JSON.stringify({ ...mem, lastVisitAt: Date.now() - 3600_000 }));
  } catch {}
  window.__rec = [];
};

/** установить запись событий (после того как приложение готово) */
const install = () => {
  const app = window.__app, d = app.director, t0 = performance.now();
  const T = () => +((performance.now() - t0) / 1000).toFixed(2);
  const rec = (kind, o) => window.__rec.push({ t: T(), kind, ...o });
  window.__T0 = t0;
  d.on('log', (s) => rec('log', { s }));
  d.on('phase', (p) => rec('phase', { p }));
  const v = app.voice;
  const sp = v.speak.bind(v);
  v.speak = async (req) => {
    const el = v.elRecorded?.(req.persona, req.lineId, req.template, req.text) ?? false;
    const t = T();
    rec('speak', { id: req.lineId ?? req.template, text: req.text, el });
    try {
      return await sp(req);
    } finally {
      rec('speak_end', { id: req.lineId ?? req.template, dur: +(T() - t).toFixed(2) });
    }
  };
  const ch = d.character;
  const play = ch.play.bind(ch);
  ch.play = (c, o) => {
    if (c !== 'talk' && c !== 'idle') rec('clip', { c });
    return play(c, o);
  };
  if (ch.setEmotion) {
    const se = ch.setEmotion.bind(ch);
    ch.setEmotion = (n, w, ms) => (rec('emo', { n }), se(n, w, ms));
  }
  const b = document.querySelector('.bubble');
  let shown = false;
  new MutationObserver(() => {
    const on = b.classList.contains('show');
    const txt = b.querySelector('.txt')?.textContent ?? '';
    if (on && (!shown || txt !== window.__bubbleTxt)) rec('bubble', { on: true, txt });
    if (!on && shown) rec('bubble', { on: false, txt });
    shown = on;
    window.__bubbleTxt = txt;
  }).observe(b, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true, characterData: true });
};

async function session(browser, persona, fresh) {
  // своя «вкладка-профиль»: localStorage параллельных сессий не пересекается
  const bctx = await browser.createBrowserContext();
  const page = await bctx.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const mem = fresh ? null : { name: 'Маша', persona, visits: 3, met: true };
  await page.evaluateOnNewDocument(prelude, K, mem);
  await page.goto(`${URL0}?debug&mic=ptt&char=${CHAR}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__app?.director?.character, { timeout: 60_000 });
  await page.evaluate(install);
  const vwait = (ms) => new Promise((r) => setTimeout(r, ms / K));
  const ev = (f, ...a) => page.evaluate(f, ...a);
  const mark = (s) => ev((s) => window.__rec.push({ t: +((performance.now() - window.__T0) / 1000).toFixed(2), kind: 'step', s }), s);
  const phase = () => ev(() => window.__app.director.state.phase);
  const say = async (t) => {
    await mark(`ребёнок: «${t}»`);
    await ev((t) => window.__voice.text(t), t);
  };
  const act = async (id) => {
    await mark(`кнопка: ${id}`);
    await ev((id) => window.__app.director.action(id), id);
  };
  const touch = async (k) => {
    await mark(`касание: ${k}`);
    await ev((k) => window.__app.director.interaction(k), k);
  };
  const waitPhase = async (ps, ms = 60_000) => {
    for (let i = 0; i < ms / 250; i++) {
      if (ps.includes(await phase())) return true;
      await vwait(250);
    }
    return false;
  };
  const waitListen = async (mode, ms = 30_000) => {
    for (let i = 0; i < ms / 250; i++) {
      // как у ребёнка: отвечает, когда кот договорил вопрос и микрофон открылся
      if ((await ev(() => !window.__app.director.queue.busy && window.__app.director.state.dialog?.listening)) === mode) return true;
      await vwait(250);
    }
    return false;
  };

  await mark(fresh ? 'старт: новый ребёнок (память пуста)' : `старт: повторный визит (Маша, ${TITLE[persona]})`);
  await ev(() => window.__app.wake());
  await waitPhase(['ask_name', 'play', 'free']);
  if (fresh) {
    // знакомство: имя голосом после вопроса
    if (await waitListen('name')) {
      await vwait(1200);
      await say('Маша');
    }
    await waitPhase(['play', 'free']);
    await vwait(3000);
    if (persona !== 'hooligan') {
      // новый ребёнок знакомится с Хулиганом; другие характеры — через «Другой кот»
      await act('other');
      await vwait(5000);
      await ev((p) => (window.__app.director.state.switchTo = p), persona);
      await touch('shake');
      await vwait(6000);
    }
  } else await vwait(4000);

  const S = {
    async silence() {
      await mark('сценарий: ребёнок молчит 3 мин');
      await vwait(180_000);
    },
    async buttons() {
      await mark('сценарий: кнопки панели подряд');
      for (const id of ['pet', 'tickle', 'dance', 'flip', 'treat', 'laugh', 'jump', 'sing', 'scratch', 'paw']) {
        await act(id);
        await vwait(1500);
      }
      await vwait(6000);
      await mark('сценарий: кнопки по одной, с паузой');
      for (const id of ['hug', 'wave', 'bubbles', 'shy']) {
        await act(id);
        await vwait(7000);
      }
      await act('riddle');
      await waitListen('riddle');
      await vwait(2000);
      await say('не знаю');
      await waitListen('intent', 20_000);
      await vwait(1500);
      await say('нет');
      await vwait(5000);
    },
    async speech() {
      await mark('сценарий: ребёнок говорит');
      for (const t of ['привет', 'как тебя зовут', 'сколько тебе лет', 'ты классный']) {
        await say(t);
        await vwait(5000);
      }
      await say('загадай загадку');
      await waitListen('riddle');
      await vwait(2000);
      await say('кукуруза');
      await waitListen('riddle', 15_000);
      await vwait(2000);
      await say('сдаюсь');
      await waitListen('intent', 15_000);
      await vwait(1000);
      await say('давай');
      await waitListen('riddle');
      await vwait(9000); // молчит — подсказка
      await waitListen('riddle', 15_000);
      await vwait(9000); // снова молчит — ответ
      await vwait(8000);
      await say('повторяй за мной');
      await waitListen('echo');
      await vwait(1500);
      await say('я кот в сапогах');
      await vwait(5000);
      await say('мама мыла раму');
      await vwait(5000);
      await say('хватит');
      await vwait(5000);
      await say('абырвалг');
      await vwait(4000);
      await say('кря кря');
      await vwait(5000);
      await say('мне скучно');
      await vwait(6000);
      await say('пока');
      await waitListen('intent', 10_000);
      await vwait(1500);
      await say('нет');
      await vwait(6000);
    },
    async touch() {
      await mark('сценарий: тапы и встряска');
      for (const k of ['tap_cat', 'tap_cat_head', 'tap_cat_belly', 'tap_cat', 'tap_cat_tail']) {
        await touch(k);
        await vwait(900);
      }
      await vwait(3000);
      await touch('spam');
      await vwait(4000);
      await touch('shake');
      await vwait(3000);
      await touch('double_tap');
      await vwait(5000);
      await touch('stroke');
      await vwait(4000);
      await touch('clap');
      await vwait(6000);
    },
    async card() {
      await mark('сценарий: карта пропала и вернулась');
      await ev(() => window.__app.tracker.simulate(false));
      await vwait(6000);
      await ev(() => window.__app.tracker.simulate(true));
      await vwait(5000);
      await ev(() => window.__app.tracker.simulate(false));
      await vwait(1500);
      await ev(() => window.__app.tracker.simulate(true));
      await vwait(6000);
    },
    async switch() {
      await mark('сценарий: смена кота');
      await act('other');
      await vwait(5000);
      await touch('shake');
      await vwait(8000);
      await act('pet');
      await vwait(5000);
    },
  };
  for (const s of SCEN) if (S[s]) await S[s]();
  await vwait(3000);
  const rec = await ev(() => window.__rec);
  await bctx.close();
  return { rec, errors };
}

/** расшифровка: строки событий + сводка проблем */
function render(persona, fresh, { rec, errors }) {
  const L = [];
  L.push(`# ${TITLE[persona]} — ${fresh ? 'новый ребёнок' : 'повторный визит'}`, '');
  L.push(`Стенд: headless Chrome, \`?debug&mic=ptt\`, время ×${K}, озвучка — манифест \`el_batch_all\` (scripts/scenario/fake-voice.mjs). Время — секунды сессии.`, '');
  L.push('| t, с | событие | реплика (id) | текст | озв. | клип / эмоция | пузырь |', '|---|---|---|---|---|---|---|');
  const esc = (s) => String(s ?? '').replace(/\|/g, '/').replace(/\n/g, ' ');
  let pendingClip = [];
  const flushClip = () => {
    const s = pendingClip.join(', ');
    pendingClip = [];
    return s;
  };
  const rows = [];
  for (const r of rec) {
    if (r.kind === 'clip') pendingClip.push(r.c);
    else if (r.kind === 'emo') pendingClip.push(`☺${r.n}`);
    else if (r.kind === 'step') rows.push([r.t, `**${esc(r.s)}**`, '', '', '', flushClip(), '']);
    else if (r.kind === 'phase') rows.push([r.t, `фаза → ${r.p}`, '', '', '', flushClip(), '']);
    else if (r.kind === 'speak') rows.push([r.t, 'речь', esc(r.id), esc(r.text), r.el ? 'да' : '**НЕТ**', flushClip(), '']);
    else if (r.kind === 'speak_end') rows.push([r.t, `конец речи (${r.dur} с)`, esc(r.id), '', '', flushClip(), '']);
    else if (r.kind === 'bubble') rows.push([r.t, '', '', '', '', flushClip(), r.on ? `▶ ${esc(r.txt)}` : '✕ скрыт']);
    else if (r.kind === 'log') {
      const s = r.s;
      if (/^🗨/.test(s)) continue; // дублирует «речь»
      if (/не выбрана|отброшена|нет записи|нет реакции|пропущен|снят|проснулся|тишина|→ /.test(s) || /^(«|walk|persona|загадка)/.test(s)) rows.push([r.t, esc(s), '', '', '', flushClip(), '']);
    }
  }
  for (const r of rows) L.push(`| ${r.join(' | ')} |`);
  if (errors.length) L.push('', '**Ошибки страницы:**', ...errors.map((e) => `- ${esc(e)}`));
  // сводка
  const speaks = rec.filter((r) => r.kind === 'speak');
  const unvoiced = speaks.filter((r) => !r.el);
  const dropped = rec.filter((r) => r.kind === 'log' && /отброшена|не выбрана/.test(r.s));
  // пузырь пережил речь: от конца речи до скрытия пузыря
  let lag = [];
  for (let i = 0; i < rec.length; i++) {
    if (rec[i].kind !== 'speak_end') continue;
    // реплику перебили следующей — пузырь занят новой, это не «висит»
    if (rec.some((x) => x.kind === 'speak' && x.id !== rec[i].id && Math.abs(x.t - rec[i].t) < 0.8)) continue;
    const nxt = rec.slice(i + 1).find((x) => x.kind === 'bubble' || x.kind === 'speak');
    if (nxt?.kind === 'bubble' && !nxt.on) lag.push(+(nxt.t - rec[i].t).toFixed(1));
  }
  // паузы кота: промежутки без речи > 25 с вне сценария «молчит»
  const ids = speaks.map((s) => s.id);
  const rep = ids.filter((x, i) => ids.indexOf(x) !== i);
  L.push('', '## Сводка', '');
  L.push(`- реплик: ${speaks.length}, без записи: ${unvoiced.length}${unvoiced.length ? ` (${[...new Set(unvoiced.map((u) => u.id))].join(', ')})` : ''}`);
  L.push(`- отброшено/не выбрано: ${dropped.length}${dropped.length ? ` — ${[...new Set(dropped.map((d) => d.s.replace(/^.*«|».*$/g, '')))].slice(0, 20).join(', ')}` : ''}`);
  L.push(`- повторы одной и той же записи: ${rep.length}${rep.length ? ` (${[...new Set(rep)].slice(0, 15).join(', ')})` : ''}`);
  L.push(`- пузырь после конца речи держится (с): ${lag.length ? `${Math.min(...lag)}…${Math.max(...lag)}, среднее ${(lag.reduce((a, b) => a + b, 0) / lag.length).toFixed(1)}` : '—'}`);
  return L.join('\n') + '\n';
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--lang=ru-RU'],
});
const jobs = [];
for (const p of PERSONAS.filter((p) => !ONLY || p === ONLY)) for (const fresh of [true, false]) jobs.push({ p, fresh });
const summary = [];
async function worker() {
  while (jobs.length) {
    const j = jobs.shift();
    const t = Date.now();
    try {
      const r = await session(browser, j.p, j.fresh);
      const md = render(j.p, j.fresh, r);
      const f = path.join(OUT, `${j.p}_${j.fresh ? 'new' : 'return'}.md`);
      fs.writeFileSync(f, md);
      summary.push(`${path.relative(root, f)}: ${md.split('## Сводка')[1].trim().split('\n').join(' ')}`);
      console.log(`✓ ${j.p} ${j.fresh ? 'new' : 'return'} (${((Date.now() - t) / 1000).toFixed(0)} с)`);
    } catch (e) {
      console.log(`✗ ${j.p} ${j.fresh ? 'new' : 'return'}: ${e.message}`);
    }
  }
}
await Promise.all(Array.from({ length: PAR }, worker));
await browser.close();
console.log(summary.join('\n'));
