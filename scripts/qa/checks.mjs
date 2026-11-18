// Проверки по записи сессии QA-стенда (scripts/qa/run.mjs): ошибки, утечки, производительность, озвучка, «висящие» состояния.
// analyze({ s, rec, err, long }) → { errors: [], warns: [], facts: {} }. Пороги — BUDGET (комментарии — почему такие).

export const BUDGET = {
  /** посадка от «Открыть камеру» до кота на карте (headless, CPU ×4 — телефон быстрее) */
  landingSec: 20,
  /** рост кучи JS за сессию после сборки мусора (базовая точка — кот только что сел) */
  heapGrowMB: 25,
  /** рост числа слушателей событий (JS) за сессию */
  listenersGrow: 300,
  /** рост узлов DOM за сессию */
  nodesGrow: 2000,
  /** текстуры GPU после смены кота (новая модель вместо старой — примерно столько же) */
  texGrowPerSwitch: 6,
  /** доля кадров ниже половины целевой частоты энергобюджета (в игре) */
  slowFrameShare: 0.5,
  /** длинные задачи главного потока > 500 мс после посадки (кроме загрузки модели при смене кота) */
  longTasks500: 6,
  /** пузырь после конца реплики гаснет не позже, мс реального времени (hideBubble — 250 мс) */
  bubbleLagMs: 900,
  /** кот в мини-игре не говорит и не слушает дольше, с (виртуальных) */
  gameSilentSec: 12,
  /** клип реакции (не idle/сон/речь) держится дольше, с */
  clipStuckSec: 25,
  /** «рот говорит» (клип talk) без голоса дольше, с */
  talkNoVoiceSec: 3,
  /** пузырь на экране без голоса дольше, с (немой пузырь) */
  bubbleNoVoiceSec: 4,
};

/** долгие петли, которые законно держатся: idle-варианты, сон, танец, мурчание */
const LOOP_OK = /^(idle|sleep|doze|nap|dance|purr|hug_screen|talk|echo|listen|sad|switch)/;

export function analyze({ s, rec, err, long, draws = [] }) {
  const errors = [], warns = [], facts = {};
  const E = (m) => errors.push(m), W = (m) => warns.push(m);

  // ── ошибки страницы ──
  const cons = s.console.filter((c) => c.type === 'error' || c.type === 'pageerror');
  // шум headless, не относящийся к приложению
  const benign = /Unrecognized archive format|vosk|favicon|ERR_ABORTED.*vosk|Autoplay|WebGL: INVALID_ENUM: getParameter|GPU stall|GL_CLOSE_PATH_NV|swiftshader/i;
  for (const c of cons) (benign.test(c.text) ? W : E)(`консоль ${c.type}: ${c.text}`);
  for (const e of err) E(`${e.kind}: ${e.msg}${e.src ? ` (${e.src})` : ''}`);
  const cw = s.console.filter((c) => c.type !== 'error' && c.type !== 'pageerror');
  facts.consoleWarnings = cw.length;
  const cams = cw.filter((c) => /камера переоткрывается/.test(c.text));
  if (cams.length) W(`сторож камеры переоткрывал камеру ${cams.length} раз: ${[...new Set(cams.map((c) => c.text))].join('; ')}`);

  // ── утечки ──
  const m = s.metrics;
  const base = m.find((x) => x.tag === 'baseline'), fin = [...m].reverse().find((x) => x.tag === 'final');
  if (base && fin) {
    const dh = (fin.heap - base.heap) / 1048576;
    facts.heap = `${(base.heap / 1048576).toFixed(1)} → ${(fin.heap / 1048576).toFixed(1)} МБ (${dh >= 0 ? '+' : ''}${dh.toFixed(1)})`;
    facts.listeners = `${base.listeners} → ${fin.listeners}`;
    facts.nodes = `${base.nodes} → ${fin.nodes}`;
    facts.textures = `${base.tex} → ${fin.tex}`;
    facts.programs = `${base.prog} → ${fin.prog}`;
    if (dh > BUDGET.heapGrowMB) E(`куча JS выросла на ${dh.toFixed(1)} МБ за сессию (бюджет ${BUDGET.heapGrowMB})`);
    if (fin.listeners - base.listeners > BUDGET.listenersGrow) E(`слушателей событий +${fin.listeners - base.listeners} за сессию (бюджет ${BUDGET.listenersGrow})`);
    if (fin.nodes - base.nodes > BUDGET.nodesGrow) E(`узлов DOM +${fin.nodes - base.nodes} за сессию (бюджет ${BUDGET.nodesGrow})`);
    const sw = m.find((x) => x.tag === 'switch1');
    const texRef = sw ?? base;
    if (fin.tex - texRef.tex > 4) E(`текстуры GPU растут без смены кота: ${texRef.tex} → ${fin.tex}`);
  }

  const samples = rec.filter((r) => r.kind === 'sample');
  // ── производительность: частота кадров против цели энергобюджета (кот на экране, игра) ──
  const play = samples.filter((x) => x.visible && (x.phase === 'play' || x.phase === 'free') && x.target);
  if (play.length) {
    const slow = play.filter((x) => x.fps < x.target * 0.5).length / play.length;
    const fpsMed = median(play.map((x) => x.fps));
    facts.fps = `медиана ${fpsMed.toFixed(1)} к/с при цели ${median(play.map((x) => x.target))} (кадров ниже ½ цели: ${(slow * 100).toFixed(0)}%)`;
    if (slow > BUDGET.slowFrameShare) W(`частота кадров ниже половины цели в ${(slow * 100).toFixed(0)}% замеров (headless SwiftShader, CPU ×4 — ориентир, не телефон)`);
    const modes = {};
    for (const x of play) modes[x.energy] = (modes[x.energy] ?? 0) + 1;
    facts.energyModes = Object.entries(modes).map(([k, v]) => `${k} ${((v / play.length) * 100).toFixed(0)}%`).join(', ');
  }
  const landedAt = samples.find((x) => x.visible)?.rt ?? 0;
  // длинные задачи во время снимков стенда (настоящий рендер SwiftShader) — не приложения
  const inDraw = (x) => draws.some(([a, b]) => x.rt + x.ms >= a - 100 && x.rt <= b + 500);
  facts.longStand = long.filter(inDraw).length;
  long = long.filter((x) => !inDraw(x));
  const lt = long.filter((x) => x.ms > 500);
  facts.longTasks = `${long.length} задач > 50 мс, ${lt.length} > 500 мс (макс. ${Math.round(Math.max(0, ...long.map((x) => x.ms)))} мс); на снимках стенда ещё ${facts.longStand} — не в счёт`;
  if (lt.length > BUDGET.longTasks500) W(`длинных задач > 500 мс: ${lt.length} (бюджет ${BUDGET.longTasks500}) — см. «Самые длинные задачи»`);
  // самые длинные — к чему привязаны (последний шаг/событие перед задачей)
  const marks = rec.filter((r) => r.kind === 'step' || r.kind === 'phase' || (r.kind === 'log' && /persona|качество|card_|switch|проснулся|энергия/.test(r.s)));
  facts.longTop = [...long].sort((a, b) => b.ms - a.ms).slice(0, 6).map((x) => {
    const m = [...marks].reverse().find((r) => r.rt <= x.rt + 50);
    return `${Math.round(x.ms)} мс на ${(x.rt / 1000).toFixed(1)} с (после «${m ? (m.s ?? `фаза ${m.p}`).slice(0, 60) : 'загрузки'}»)`;
  }).join('; ');

  // ── озвучка и пузырь ──
  const speaks = rec.filter((r) => r.kind === 'speak');
  const unvoiced = speaks.filter((r) => !r.el && !/^echo:/.test(r.id));
  facts.lines = `${speaks.length} реплик, без записи: ${unvoiced.length}`;
  if (unvoiced.length) E(`реплики без записи ElevenLabs прозвучали: ${[...new Set(unvoiced.map((u) => u.id))].join(', ')}`);
  const speakTexts = new Set(rec.filter((r) => r.kind === 'speak' || r.kind === 'echo').map((r) => r.text));
  // вступление к подсказке загадки показывается вместе с текстом подсказки («Подумай ещё. Подсказка: …», director.bubbleText) —
  // пузырь начинается с озвученного текста
  const voicedBubble = (t) => speakTexts.has(t) || [...speakTexts].some((s) => s && t.startsWith(s + ' '));
  const mute = rec.filter((r) => r.kind === 'bubble' && r.on && r.txt && !r.hint && !voicedBubble(r.txt));
  if (mute.length) E(`немой пузырь (текст без голоса): ${[...new Set(mute.map((x) => `«${x.txt.slice(0, 50)}»`))].join(', ')}`);
  const hints = [...new Set(rec.filter((r) => r.kind === 'bubble' && r.on && r.hint).map((x) => `«${x.txt.slice(0, 50)}»`))];
  if (hints.length) facts.hints = `${hints.length}: ${hints.join(', ')}`;
  // логика: конец реплики → режиссёр сразу просит скрыть её пузырь (hideBubble с тем же текстом)
  const textOf = new Map();
  const lags = [];
  let noHide = 0;
  for (let i = 0; i < rec.length; i++) {
    const r = rec[i];
    if (r.kind === 'speak') textOf.set(r.id, r.text);
    if (r.kind !== 'speak_end') continue;
    const txt = textOf.get(r.id);
    const hide = rec.slice(i + 1, i + 40).find((x) => x.kind === 'hide' && x.rt - r.rt < 300 && (x.text === null || x.text === txt || (!!txt && !!x.text && x.text.startsWith(txt + ' '))));
    if (!hide && rec.some((x) => x.kind === 'hide')) {
      noHide++;
      E(`реплика ${r.id} кончилась, а пузырь не попросили скрыть`);
    }
    // DOM: пузырь именно этой реплики погас (если его не сменила следующая)
    const j = rec.slice(i + 1).findIndex((x) => x.kind === 'bubble');
    if (j < 0) continue;
    const nb = rec[i + 1 + j];
    if (!nb.on && nb.txt === txt) {
      // главный поток был занят (нет опроса > 1,5 с) — задержка не про логику пузыря
      const gap = samples.some((x, k) => k > 0 && x.rt > r.rt && x.rt <= nb.rt + 600 && x.rt - samples[k - 1].rt > 1500);
      lags.push({ ms: nb.rt - r.rt, busy: gap, id: r.id });
    }
  }
  if (lags.length) {
    const free = lags.filter((x) => !x.busy).map((x) => x.ms);
    facts.bubbleLag = `пузырь гаснет через ${median(lags.map((x) => x.ms))} мс после голоса (медиана; без зависаний потока — ${free.length ? `${Math.min(...free)}…${Math.max(...free)}` : '—'} мс)${noHide ? `; без hideBubble: ${noHide}` : ''}`;
    const bad = lags.filter((x) => !x.busy && x.ms > BUDGET.bubbleLagMs);
    if (bad.length) W(`пузырь держался дольше ${BUDGET.bubbleLagMs} мс после голоса ${bad.length} раз без зависания потока (${bad.map((x) => `${x.id} ${x.ms} мс`).join(', ')})`);
  }
  // повтор одной записи подряд (одна и та же реплика дважды за 30 с)
  for (let i = 1; i < speaks.length; i++) {
    const prev = speaks.slice(0, i).reverse().find((x) => x.id === speaks[i].id);
    if (prev && speaks[i].t - prev.t < 30 && !/riddle|echo|^debug/.test(speaks[i].id)) W(`одна реплика дважды за ${(speaks[i].t - prev.t).toFixed(0)} с: ${speaks[i].id}`);
  }

  // ── «висящие» состояния (по опросу каждые 0,5 с) ──
  // отрезки, где условие держится; дыра в опросе > 1,5 с (главный поток занят) рвёт отрезок — состояние там неизвестно
  const runs = (pred, key) => {
    const out = [];
    let start = null, val = null, prev = null;
    for (const x of samples) {
      if (prev && (x.rt - prev.rt > 1500 || draws.some(([a, b]) => x.rt >= a && prev.rt <= b)) && start && val !== null) {
        out.push({ from: start, to: prev, val });
        start = null;
        val = null;
      }
      prev = x;
      const k = pred(x) ? (key ? key(x) : true) : null;
      if (k !== null && k === val) continue;
      if (start && val !== null) out.push({ from: start, to: x, val });
      start = k !== null ? x : null;
      val = k;
    }
    if (start && val !== null && samples.length) out.push({ from: start, to: samples[samples.length - 1], val });
    return out.map((r) => ({ ...r, sec: r.to.t - r.from.t }));
  };
  const at = (x) => `t=${x.t.toFixed(0)} с`;
  for (const r of runs((x) => x.dialog && !x.speaking && !x.busy && !x.listen && !x.elistening, (x) => x.dialog)) if (r.sec > BUDGET.gameSilentSec) E(`мини-игра ${r.val}: кот молчит и не слушает ${r.sec.toFixed(0)} с (${at(r.from)})`);
  for (const r of runs((x) => x.dialog && x.listen, (x) => `${x.dialog}`)) if (r.sec > 45) W(`мини-игра ${r.val}: ждёт ответа ${r.sec.toFixed(0)} с без конца (${at(r.from)})`);
  for (const r of runs((x) => x.clip && !LOOP_OK.test(x.clip) && !x.walking, (x) => x.clip)) if (r.sec > BUDGET.clipStuckSec) E(`клип ${r.val} держится ${r.sec.toFixed(0)} с (${at(r.from)}) — кот застрял в реакции`);
  for (const r of runs((x) => x.clip === 'talk' && !x.speaking)) if (r.sec > BUDGET.talkNoVoiceSec) E(`рот «говорит» (talk) без голоса ${r.sec.toFixed(1)} с (${at(r.from)})`);
  // пузырь — интерфейс: меряем реальным временем (при ускорении ×K виртуальные секунды раздуты)
  for (const r of runs((x) => x.bubble && !x.speaking && !x.busy)) {
    const sec = (r.to.rt - r.from.rt) / 1000;
    if (sec > BUDGET.bubbleNoVoiceSec) E(`пузырь на экране без голоса ${sec.toFixed(1)} с (${at(r.from)})`);
  }
  for (const r of runs((x) => x.phase, (x) => x.phase)) {
    if (r.val === 'switching' && r.sec > 45) E(`смена кота висит ${r.sec.toFixed(0)} с (${at(r.from)})`);
    if (r.val === 'appear' && r.sec > 25) E(`появление кота висит ${r.sec.toFixed(0)} с (${at(r.from)})`);
  }
  for (const r of runs((x) => x.card && !x.tracking && x.phase !== 'start' && x.phase !== 'scanning')) if ((r.to.rt - r.from.rt) / 1000 > 8) W(`сценарий считает карту видимой, а трекер её потерял ${((r.to.rt - r.from.rt) / 1000).toFixed(0)} с реального времени (${at(r.from)})`);
  // в игре кот молчит слишком долго без причины (лестница: «ты тут?» через 12 с, предложение — 30 с)
  let lastVoice = null;
  for (const x of samples) {
    if (!(x.phase === 'play' || x.phase === 'free') || x.dozing || !x.card) {
      lastVoice = null;
      continue;
    }
    if (x.speaking || x.busy || x.dialog || x.elistening) lastVoice = x;
    else if (!lastVoice) lastVoice = x;
    else if (x.t - lastVoice.t > 60) {
      E(`в игре кот молчит ${(x.t - lastVoice.t).toFixed(0)} с без дрёмы (${at(lastVoice)}) — лестница тишины не сработала`);
      lastVoice = x;
    }
  }
  facts.samples = samples.length;
  facts.landedAt = landedAt;
  return { errors: dedupe(errors), warns: dedupe(warns), facts };
}

const median = (a) => {
  if (!a.length) return 0;
  const b = [...a].sort((x, y) => x - y);
  return b[Math.floor(b.length / 2)];
};
const dedupe = (a) => [...new Set(a)];
