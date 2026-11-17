// Отчёт QA-стенда → docs/qa/REPORT.md (таблица шагов, сводка проверок по сессиям, ссылки на снимки docs/qa/shots/).
import { BUDGET } from './checks.mjs';

const esc = (s) => String(s ?? '').replace(/\|/g, '/').replace(/\n/g, ' ');
const TITLE = { first: 'Первый запуск (новый ребёнок)', return: 'Повторный визит (тот же телефон)', denied: 'Камера запрещена' };

export function renderReport(results, o) {
  const L = [];
  const date = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const steps = results.flatMap((r) => r.steps);
  const bad = steps.filter((s) => !s.ok).length, warn = steps.filter((s) => s.ok && s.issues.length).length;
  const aErr = results.reduce((n, r) => n + r.analysis.errors.length, 0);
  L.push('# QA-стенд: отчёт прогона', '');
  L.push(`${date} UTC · коммит \`${o.commit}\` · ${o.minutes.toFixed(1)} мин · headless Chrome 390×844, UA iPhone, CPU ×${o.throttle}, SwiftShader · тишина ×${o.k}`, '');
  L.push(`**Итог: шагов ${steps.length}, ок ${steps.length - bad - warn}, с замечаниями ${warn}, с ошибками ${bad}; ошибок сквозных проверок ${aErr}.**`, '');
  L.push('Запуск: `npm run qa` (подробности — `scripts/qa/run.mjs`, пороги — `BUDGET` в `scripts/qa/checks.mjs`). Найденные баги — `docs/qa/BUGS.md`.', '');
  L.push('Ограничения стенда: GPU программный (FPS — ориентир, не телефон); голос кота — тишина длиной как реплика (fake-voice, набор озвученного `voice-src/el_batch_all.jsonl`);', 'фразы ребёнка — текстом через `window.__voice.text` (тот же путь, что после Vosk); микрофон — тихая комната (VAD, хлопки, громкость не проверяются); камера — синтетическое видео карты (`scripts/bench/gen_card_video.py`), «карта пропала» — подмена видео кадром стола без карты.', '');
  for (const r of results) {
    L.push(`## ${TITLE[r.name] ?? r.name}`, '');
    L.push('| # | Шаг | Итог | Замечания | Время, с | Главный поток | Снимки |', '|---|---|---|---|---|---|---|');
    r.steps.forEach((s, i) => {
      const res = !s.ok ? '❌ ошибка' : s.issues.length ? '⚠️ замечания' : '✅ ок';
      const iss = [...s.issues.map((x) => `${x.sev === 'error' ? '**' : ''}${esc(x.msg)}${x.sev === 'error' ? '**' : ''}`), ...s.notes.map((n) => `<sub>${esc(n)}</sub>`)].join('<br>');
      const perf = s.perf ? `${s.perf.mainPct}%${s.perf.longTasks ? `, длинных задач ${s.perf.longTasks}` : ''}` : '';
      const shots = s.shots.filter(Boolean).map((f) => `[${f.replace(/^\w+_\d+_/, '').replace(/\.(png|jpg)$/, '')}](shots/${f})`).join(' ');
      L.push(`| ${i + 1} | ${esc(s.title)} | ${res} | ${iss || '—'} | ${s.dur} | ${perf} | ${shots} |`);
    });
    const a = r.analysis;
    L.push('', '**Сквозные проверки сессии**', '');
    L.push('| Проверка | Результат |', '|---|---|');
    const f = a.facts;
    const row = (k, v) => v !== undefined && L.push(`| ${k} | ${esc(v)} |`);
    row('Реплики (озвучены ли)', f.lines);
    row('Пузырь гаснет с голосом', f.bubbleLag);
    row('Подсказки кота в пузыре (без голоса, UI)', f.hints);
    row('Куча JS (после GC: посадка → конец)', f.heap);
    row('Слушатели событий', f.listeners);
    row('Узлы DOM', f.nodes);
    row('Текстуры GPU', f.textures);
    row('Программы шейдеров', f.programs);
    row('Частота кадров в игре', f.fps);
    row('Режимы энергобюджета в игре', f.energyModes);
    row('Длинные задачи главного потока', f.longTasks);
    row('Самые длинные задачи', f.longTop);
    row('Предупреждения консоли', f.consoleWarnings);
    L.push('');
    if (a.errors.length) L.push('Ошибки:', '', ...a.errors.map((e) => `- ❌ ${esc(e)}`), '');
    if (a.warns.length) L.push('Замечания:', '', ...a.warns.map((e) => `- ⚠️ ${esc(e)}`), '');
    if (!a.errors.length && !a.warns.length) L.push('Ошибок и замечаний нет.', '');
  }
  L.push('## Пороги', '', '| Порог | Значение |', '|---|---|', ...Object.entries(BUDGET).map(([k, v]) => `| \`${k}\` | ${v} |`), '');
  return L.join('\n');
}
