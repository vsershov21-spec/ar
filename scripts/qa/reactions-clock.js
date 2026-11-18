// Виртуальное время для аудита реакций (scripts/qa/reactions.mjs): page.evaluateOnNewDocument(reactionClock).
// Пока идёт загрузка — режим «auto»: виртуальное время идёт вместе с реальным (каждые 16 мс). После посадки кота стенд
// переключает «manual»: window.__vt.step(n, dtMs) — n кадров по dtMs (30 к/с): таймеры (setTimeout/setInterval),
// performance.now / Date.now / timeStamp событий и requestAnimationFrame идут строго по кадрам. Так замеры не зависят
// от скорости headless-рендера (swiftshader ~5–10 к/с): кадр приложения = ровно 1/30 с, таймеры режиссёра — в той же шкале.
// Функция сериализуется puppeteer'ом — всё внутри неё.
export function reactionClock(opts = {}) {
  const real = {
    now: performance.now.bind(performance),
    date: Date.now,
    st: window.setTimeout.bind(window),
    ct: window.clearTimeout.bind(window),
    raf: window.requestAnimationFrame.bind(window),
  };
  const t0 = real.now();
  const d0 = real.date();
  let vnow = t0;
  let mode = 'auto';
  let seq = 1;
  const timers = new Map(); // id → { at, f, args, every }
  let rafs = [];
  const vt = {
    real,
    get mode() {
      return mode;
    },
    now: () => vnow,
    frames: 0,
  };
  window.__vt = vt;
  performance.now = () => vnow;
  Date.now = () => Math.round(d0 + (vnow - t0));
  const tsDesc = Object.getOwnPropertyDescriptor(Event.prototype, 'timeStamp');
  if (tsDesc?.get) Object.defineProperty(Event.prototype, 'timeStamp', { configurable: true, get: () => vnow });
  window.setTimeout = (f, ms, ...args) => {
    const id = seq++;
    timers.set(id, { at: vnow + Math.max(0, Number(ms) || 0), f, args, every: 0 });
    return id;
  };
  window.setInterval = (f, ms, ...args) => {
    const id = seq++;
    const every = Math.max(1, Number(ms) || 0);
    timers.set(id, { at: vnow + every, f, args, every });
    return id;
  };
  window.clearTimeout = window.clearInterval = (id) => void timers.delete(id);
  window.requestAnimationFrame = (cb) => {
    const id = seq++;
    rafs.push({ id, cb });
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    rafs = rafs.filter((r) => r.id !== id);
  };
  const run = (fn, args) => {
    try {
      typeof fn === 'function' ? fn(...(args || [])) : new Function(String(fn))();
    } catch (e) {
      (window.__qaErr ||= []).push({ kind: 'timer', msg: String(e?.stack || e) });
    }
  };
  /** таймеры до vnow (в порядке срока, включая поставленные по ходу) */
  const fireTimers = () => {
    for (let guard = 0; guard < 5000; guard++) {
      let best = null, bid = 0;
      for (const [id, t] of timers) if (t.at <= vnow && (!best || t.at < best.at || (t.at === best.at && id < bid))) [best, bid] = [t, id];
      if (!best) return;
      if (best.every) best.at += best.every;
      else timers.delete(bid);
      run(best.f, best.args);
    }
  };
  const flushRaf = () => {
    const list = rafs;
    rafs = [];
    for (const r of list) run(r.cb, [vnow]);
    vt.frames++;
  };
  const macrotask = () => new Promise((r) => real.st(r, 0));
  // auto: как реальное время
  let last = real.now();
  const auto = () => {
    if (mode !== 'auto') return;
    const n = real.now();
    vnow += n - last;
    last = n;
    fireTimers();
    real.raf(() => {
      if (mode !== 'auto') return;
      flushRaf();
    });
    real.st(auto, 16);
  };
  auto();
  vt.manual = () => {
    mode = 'manual';
  };
  vt.autoMode = () => {
    if (mode === 'auto') return;
    mode = 'auto';
    last = real.now();
    auto();
  };
  /** n кадров по dt мс; onFrame(i) — после каждого кадра (в странице), её результат копится */
  vt.step = async (n, dt = 1000 / 30, onFrame) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      vnow += dt;
      fireTimers();
      await macrotask(); // промисы и fetch-колбэки успевают
      fireTimers();
      flushRaf();
      if (onFrame) out.push(onFrame(i));
    }
    return out;
  };
  window.__qaErr = window.__qaErr || [];
  window.addEventListener('error', (e) => window.__qaErr.push({ kind: 'error', msg: String(e.message || e.error || e) }));
  window.addEventListener('unhandledrejection', (e) => window.__qaErr.push({ kind: 'unhandledrejection', msg: String(e.reason?.stack || e.reason?.message || e.reason) }));
  try {
    localStorage.clear();
    // «уже знакомы»: без знакомства, сразу свободная игра (как ?flow=return); префикс пилота — 'pilot:'
    const mem = JSON.stringify({ met: true, persona: opts.persona || 'hooligan', visits: 3, name: 'Маша', lastVisitAt: Date.now() - 3600_000 });
    for (const p of ['', 'pilot:', 'lab:']) {
      localStorage.setItem(p + 'sber-ar-cat:v1', mem);
      localStorage.setItem(p + 'ar.onboarded', '1');
      localStorage.setItem(p + 'ar.micMode', 'off');
    }
  } catch {}
}
