/**
 * Тестовые флоу (страница https://ar.vershov.com/test, test/index.html): ?flow=… — после посадки кота прыжок в нужное
 * состояние, чтобы продакт и команды проверяли изменения без долгого пути.
 *
 *   ?flow=return                       — повторный визит (память «уже знакомы», имя «Маша», если имени нет)
 *   ?flow=riddle|echo|emo|rps|simon    — мини-игра сразу (как кнопка каталога)
 *   ?flow=doze                         — кот дремлет (как после 110 с тишины): касание будит
 *   ?flow=switch                       — «давай другого»: экран заклеен, ждём встряску
 *   ?flow=sad                          — «мне грустно»: бережный ответ и пауза
 *   ?flow=outro                        — зов в СберKids (конец сессии)
 *   ?flow=paint[&swatch=0..2]          — раскраска карты (card.paint): лист цветов или сразу цвет swatch (src/card/paint.ts)
 *   ?flow=chaos[&rate=5..15][&dur=60]  — автотапер: хаотичные тапы ребёнка по коту и мимо, глажка, долгое нажатие,
 *                                        кнопки и фразы; счётчик кадров и время обработки касания — табличка сверху
 * Знакомство (?fresh) флоу не нужен. Флоу, кроме fresh, пропускают знакомство: память «знакомы» ставится до режиссёра.
 */
import type { App } from '../app';
import { loadMemory, saveMemory } from '../scenario/memory';
import { ACTIONS } from '../scenario/actions';

export const FLOWS = ['return', 'riddle', 'echo', 'emo', 'rps', 'simon', 'doze', 'switch', 'sad', 'outro', 'chaos', 'paint'] as const;
export type FlowId = (typeof FLOWS)[number];

const q = () => new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
export const flowParam = (): FlowId | null => {
  const f = q().get('flow');
  return f && (FLOWS as readonly string[]).includes(f) ? (f as FlowId) : null;
};

/** до создания режиссёра: флоу (кроме ?fresh) — сразу игра, без знакомства */
export function prepareFlowMemory() {
  const f = flowParam();
  if (!f || q().has('fresh')) return;
  const m = loadMemory();
  if (m.met && (f !== 'return' || m.name)) return;
  saveMemory({ met: true, persona: m.persona ?? 'hooligan', visits: Math.max(m.visits, 2), ...(f === 'return' && !m.name ? { name: 'Маша' } : {}), lastVisitAt: Date.now() - 3600_000 });
}

/** после init: дождаться, когда кот вышел и договорил приветствие, и прыгнуть во флоу */
export function runFlow(app: App) {
  const f = flowParam();
  if (!f || f === 'return') return;
  const d = app.director;
  let started = false;
  const tryStart = () => {
    if (started) return;
    const st = d.state;
    if ((st.phase !== 'play' && st.phase !== 'free') || d.queue.busy) return;
    started = true;
    clearInterval(timer);
    setTimeout(() => {
      d.log(`флоу ?flow=${f}`);
      if (f === 'chaos') startChaos(app);
      else if (f === 'paint') app.paint?.flow();
      else d.flow(f);
    }, 700);
  };
  const timer = window.setInterval(tryStart, 250);
}

/**
 * Автотапер ?flow=chaos: настоящие pointer-события на слое касаний (тот же путь, что палец) с частотой rate в секунду
 * (по умолчанию 5–15), вперемешку — поглаживание, долгое нажатие, кнопка каталога, фраза. dur секунд, потом стоп.
 * window.__chaos — счётчики (для QA-стенда): касаний, худшее время обработки, к/с минимум.
 */
export function startChaos(app: App) {
  const p = q();
  const rate = Number(p.get('rate')) || 0;
  const dur = (Number(p.get('dur')) || 60) * 1000;
  const surface = app.fx.canvas as HTMLElement;
  const stats = { taps: 0, strokes: 0, longs: 0, buttons: 0, phrases: 0, maxMs: 0, sumMs: 0, n: 0, fpsMin: Infinity, fps: 0, running: true, startedAt: performance.now() };
  (window as unknown as { __chaos: typeof stats }).__chaos = stats;
  const box = document.createElement('div');
  Object.assign(box.style, {
    position: 'fixed', left: '8px', right: '8px', top: 'calc(env(safe-area-inset-top, 0px) + 8px)', zIndex: '9999', pointerEvents: 'none',
    font: '600 12px/1.35 -apple-system, system-ui, sans-serif', color: '#fff', background: 'rgba(11,94,107,.82)', borderRadius: '12px', padding: '6px 10px',
  });
  document.body.appendChild(box);
  let id = 1000;
  const fire = (type: string, x: number, y: number, pid: number) => {
    const t0 = performance.now();
    surface.dispatchEvent(new PointerEvent(type, { pointerId: pid, clientX: x, clientY: y, bubbles: true, isPrimary: true, pointerType: 'touch' }));
    const ms = performance.now() - t0;
    stats.maxMs = Math.max(stats.maxMs, ms);
    stats.sumMs += ms;
    stats.n++;
  };
  const cat = () => {
    const r = app.ui.catRect?.();
    if (!r) return null;
    return { cx: r.cx, top: r.top, bottom: r.bottom, head: r.headY, half: r.half };
  };
  const zonePt = () => {
    const c = cat();
    const w = innerWidth, h = innerHeight;
    if (!c || Math.random() < 0.12) return { x: 20 + Math.random() * (w - 40), y: 120 + Math.random() * (h - 320) }; // мимо
    const k = Math.random();
    const y = k < 0.3 ? c.head : k < 0.6 ? (c.head + c.bottom) / 2 : k < 0.85 ? c.bottom - 12 : (c.head + c.bottom) / 2 + 10;
    const x = c.cx + (k >= 0.85 ? c.half * 0.8 : (Math.random() - 0.5) * c.half);
    return { x, y };
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const tap = async () => {
    const { x, y } = zonePt();
    const pid = ++id;
    fire('pointerdown', x, y, pid);
    await sleep(40 + Math.random() * 40);
    fire('pointerup', x, y, pid);
    stats.taps++;
  };
  const stroke = async () => {
    const c = cat();
    if (!c) return tap();
    const pid = ++id;
    let x = c.cx - c.half * 0.5, y = (c.head + c.bottom) / 2;
    fire('pointerdown', x, y, pid);
    const n = 12 + Math.floor(Math.random() * 25);
    for (let i = 0; i < n; i++) {
      await sleep(50);
      x = c.cx - c.half * 0.5 + ((i * 6) % (c.half * 1.2));
      fire('pointermove', x, y + Math.sin(i / 2) * 5, pid);
    }
    fire('pointerup', x, y, pid);
    stats.strokes++;
  };
  const long = async () => {
    const { x, y } = zonePt();
    const pid = ++id;
    fire('pointerdown', x, y, pid);
    await sleep(800);
    fire('pointerup', x, y, pid);
    stats.longs++;
  };
  const buttons = ACTIONS.filter((a) => a !== 'other' && a !== 'sleep');
  const phrases = ['привет', 'танцуй', 'загадай загадку', 'ты классный', 'расскажи шутку', 'как дела', 'сдаюсь', 'да', 'нет', 'камень', 'весёлый'];
  const end = performance.now() + dur;
  const loop = async () => {
    while (performance.now() < end && stats.running) {
      // меню «Пересадить» (долгое нажатие) закрываем — автотапер не должен застрять в нём
      app.ui.hidePressMenu();
      const t0 = performance.now();
      const k = Math.random();
      if (k < 0.72) await tap();
      else if (k < 0.8) await stroke();
      else if (k < 0.84) await long();
      else if (k < 0.93) {
        app.director.action(buttons[Math.floor(Math.random() * buttons.length)]);
        stats.buttons++;
      } else {
        app.director.text(phrases[Math.floor(Math.random() * phrases.length)]);
        stats.phrases++;
      }
      const r = rate || 5 + Math.random() * 10;
      const gap = 1000 / r - (performance.now() - t0);
      if (gap > 0) await sleep(gap);
    }
    stats.running = false;
  };
  const draw = window.setInterval(() => {
    stats.fps = app.fps;
    if (performance.now() - stats.startedAt > 2000 && app.fps > 0) stats.fpsMin = Math.min(stats.fpsMin, app.fps);
    const d = app.director;
    box.textContent = `${stats.running ? '🐾 хаос' : '✓ хаос закончен'} · тапов ${stats.taps} · глажек ${stats.strokes} · долгих ${stats.longs} · кнопок ${stats.buttons} · фраз ${stats.phrases} · касание ≤ ${stats.maxMs.toFixed(1)} мс (ср. ${(stats.sumMs / Math.max(1, stats.n)).toFixed(2)}) · ${app.fps.toFixed(0)} к/с (мин ${Number.isFinite(stats.fpsMin) ? stats.fpsMin.toFixed(0) : '—'}) · очередь ${d.queue.pending.length} · ${d.character?.currentClip ?? ''}`;
    if (!stats.running && performance.now() > end + 15_000) clearInterval(draw);
  }, 500);
  void loop();
  return stats;
}
