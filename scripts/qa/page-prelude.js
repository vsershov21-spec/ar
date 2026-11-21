// Скрипт до загрузки страницы (page.evaluateOnNewDocument): стенд QA, scripts/qa/run.mjs.
//  - управляемое ускорение времени: window.__qaSetK(k) — performance.now / Date.now / setTimeout / setInterval идут в k раз быстрее
//    (по умолчанию ×1: трекер и посадка — в реальном времени; ускоряем только «тишину»);
//  - ловушки ошибок: error, unhandledrejection, длинные задачи главного потока;
//  - камера: обёртка getUserMedia — window.__qaCam.cover(true) подменяет видео камеры кадром «стол без карты»
//    (как будто ребёнок убрал карту), cover(false) — возвращает камеру; __qaDenyCam — запрет камеры.
// Функция сериализуется puppeteer'ом: всё — внутри неё.
export function qaPrelude(opts) {
  const real = {
    now: performance.now.bind(performance),
    date: Date.now,
    st: window.setTimeout.bind(window),
    si: window.setInterval.bind(window),
    ci: window.clearInterval.bind(window),
  };
  window.__qaReal = real;
  let K = 1, vBase = real.now(), rBase = vBase, dvBase = real.date(), drBase = dvBase;
  performance.now = () => vBase + (real.now() - rBase) * K;
  Date.now = () => dvBase + (real.date() - drBase) * K;
  window.__qaSetK = (k) => {
    vBase = performance.now();
    rBase = real.now();
    dvBase = Date.now();
    drBase = real.date();
    K = k;
  };
  window.__qaK = () => K;
  // время событий (PointerEvent.timeStamp) — в той же ускоренной шкале, иначе после ускорения распознаватель жестов
  // сравнивает реальное время касания с виртуальным «сейчас» и тап становится долгим нажатием
  const tsDesc = Object.getOwnPropertyDescriptor(Event.prototype, 'timeStamp');
  if (tsDesc?.get)
    Object.defineProperty(Event.prototype, 'timeStamp', {
      configurable: true,
      get() {
        const ts = tsDesc.get.call(this);
        return performance.now() - (real.now() - ts) * K;
      },
    });
  window.setTimeout = (f, ms, ...a) => real.st(f, (Number(ms) || 0) / K, ...a);
  window.setInterval = (f, ms, ...a) => real.si(f, (Number(ms) || 0) / K, ...a);
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf(() => cb(performance.now()));

  window.__qaErr = [];
  window.addEventListener('error', (e) => window.__qaErr.push({ kind: 'error', msg: String(e.message || e.error || e), src: e.filename ? `${e.filename}:${e.lineno}` : '' }));
  window.addEventListener('unhandledrejection', (e) => window.__qaErr.push({ kind: 'unhandledrejection', msg: String(e.reason?.stack || e.reason?.message || e.reason) }));
  window.__qaLong = [];
  try {
    new PerformanceObserver((l) => {
      for (const x of l.getEntries()) window.__qaLong.push({ at: x.startTime, ms: x.duration });
    }).observe({ type: 'longtask', buffered: true });
  } catch {}

  try {
    if (opts.clear) localStorage.clear();
    if (opts.micMode) localStorage.setItem('ar.micMode', opts.micMode);
    // повторный визит без первой сессии (--only return): память «уже знакомы» — как после знакомства
    if (opts.memory && !localStorage.getItem('sber-ar-cat:v1')) localStorage.setItem('sber-ar-cat:v1', JSON.stringify({ ...opts.memory, lastVisitAt: Date.now() - 3600_000 }));
  } catch {}

  // ── камера ──
  const md = navigator.mediaDevices;
  if (md?.getUserMedia) {
    const gum = md.getUserMedia.bind(md);
    md.getUserMedia = async (c) => {
      window.__qaGum = (window.__qaGum || 0) + 1;
      if (opts.denyCam && c?.video) throw new DOMException('Permission denied', 'NotAllowedError');
      return gum(c);
    };
  }
  let cover = null;
  window.__qaCam = {
    covered: () => !!cover,
    async cover(on) {
      const v = window.__app?.tracker?.video;
      if (!v) return false;
      if (on && !cover) {
        const img = new Image();
        img.src = opts.tableUrl;
        await img.decode().catch(() => undefined);
        const c = document.createElement('canvas');
        c.width = v.videoWidth || 1280;
        c.height = v.videoHeight || 720;
        const g = c.getContext('2d');
        let n = 0;
        const draw = () => {
          g.drawImage(img, 0, 0, c.width, c.height);
          // шум сенсора: кадры различаются (иначе сторож камеры увидит «замёрзшее» видео)
          g.fillStyle = `rgba(${(n++ % 7) * 3},0,0,0.02)`;
          g.fillRect(0, 0, c.width, c.height);
        };
        draw();
        const timer = real.si(draw, 33);
        const stream = c.captureStream(30);
        cover = { orig: v.srcObject, stream, timer };
        v.srcObject = stream;
        await v.play().catch(() => undefined);
        return true;
      }
      if (!on && cover) {
        const k = cover;
        cover = null;
        v.srcObject = k.orig;
        await v.play().catch(() => undefined);
        real.ci(k.timer);
        k.stream.getTracks().forEach((t) => t.stop());
        return true;
      }
      return false;
    },
  };
}

/**
 * Запись событий приложения (после того как window.__app готов). Время: t — виртуальное (с ускорением), rt — реальное, мс.
 * gpu === 'stub': renderer.render только считается (SwiftShader в headless рисует кадр кота за сотни мс и душит
 * главный поток — логика шла бы 1–2 кадра в секунду); для снимка — window.__qaDraw(n) рисует n кадров по-настоящему.
 */
export function qaInstall(gpu) {
  if (window.__qaRec) return;
  const app = window.__app, d = app.director, real = window.__qaReal;
  const r = app.renderer, render = r.render.bind(r);
  let drawReal = gpu !== 'stub' ? Infinity : 0;
  window.__qaRenders = 0;
  r.render = (sc, cam) => {
    window.__qaRenders++;
    if (drawReal > 0) {
      drawReal--;
      render(sc, cam);
    }
  };
  // окна, когда стенд сам рисует по-настоящему (снимки, замеры текстур): длинные задачи там — от SwiftShader, не от приложения
  window.__qaDrawWin = [];
  window.__qaDraw = (n = 2) => {
    if (drawReal !== Infinity) drawReal = n;
    const t = real.now();
    return new Promise((res) => {
      const wait = () => {
        if (drawReal <= 0 || drawReal === Infinity || real.now() - t > 4000) {
          window.__qaDrawWin.push([Math.round(t), Math.round(real.now())]);
          res(true);
        } else real.st(wait, 30);
      };
      wait();
    });
  };
  const v0 = performance.now(), r0 = real.now();
  window.__qaR0 = r0; // longtask.startTime — в той же шкале (настоящий performance.now)
  const T = () => +((performance.now() - v0) / 1000).toFixed(2);
  const RT = () => Math.round(real.now() - r0);
  window.__qaT = () => ({ t: T(), rt: RT() });
  const rec = (window.__qaRec = []);
  const push = (kind, o) => rec.push({ t: T(), rt: RT(), kind, ...o });
  window.__qaPush = push;
  d.on('log', (s) => push('log', { s: String(s) }));
  d.on('phase', (p) => push('phase', { p }));
  const v = app.voice;
  const sp = v.speak.bind(v);
  v.speak = async (req, hooks) => {
    let el = false;
    try {
      el = v.elRecorded?.(req.persona, req.lineId, req.template, req.text) ?? false;
    } catch {}
    const t0 = RT();
    push('speak', { id: req.lineId ?? req.template, text: req.text, el, persona: req.persona });
    try {
      return await sp(req, hooks);
    } finally {
      push('speak_end', { id: req.lineId ?? req.template, dur: RT() - t0 });
    }
  };
  if (typeof v.echo === 'function') {
    const ec = v.echo.bind(v);
    v.echo = async (t, o) => {
      push('echo', { text: t });
      try {
        return await ec(t, o);
      } finally {
        push('echo_end', { text: t });
      }
    };
  }
  // пузырь: режиссёр просит скрыть (логика) — отдельно от того, когда DOM реально погас (зависит от загрузки потока)
  const ui = app.ui;
  if (typeof ui.hideBubble === 'function') {
    const hb = ui.hideBubble.bind(ui);
    ui.hideBubble = (text) => {
      push('hide', { text: text ?? null });
      return hb(text);
    };
  }
  const b = document.querySelector('.bubble');
  let shown = false, txt0 = '';
  if (b)
    new MutationObserver(() => {
      const on = b.classList.contains('show');
      const txt = b.querySelector('.txt')?.textContent ?? '';
      // .hint — подсказка кота в пузыре (UI «вариант А»), не реплика
      const hint = b.classList.contains('hint');
      if (on && (!shown || txt !== txt0)) push('bubble', { on: true, txt, hint });
      if (!on && shown) push('bubble', { on: false, txt, hint });
      shown = on;
      txt0 = txt;
    }).observe(b, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true, characterData: true });
  // настоящая частота кадров (app.fps считается по dt, обрезанному energy.maxDt, — при тормозах врёт)
  let rn0 = 0, rt0 = real.now();
  const realFps = () => {
    const n = window.__qaRenders, t = real.now();
    const f = t > rt0 ? ((n - rn0) * 1000) / (t - rt0) : 0;
    rn0 = n;
    rt0 = t;
    return +f.toFixed(1);
  };
  // опрос состояния (реальные 500 мс): клип, фаза, диалог, слушает ли, говорит ли — для поиска «висящих» состояний
  const sample = () => {
    try {
      const st = d.state, ch = d.character, e = app.engine?.state?.();
      push('sample', {
        phase: st.phase, dialog: st.dialog ? `${st.dialog.id}.${st.dialog.node}` : null, listen: st.dialog?.listening ?? null,
        clip: ch?.currentClip ?? null, speaking: !!app.voice.speaking, busy: !!d.queue?.busy, dozing: !!d.dozing,
        energy: app.energy?.out?.mode ?? null, fps: realFps(), appFps: +(app.fps || 0).toFixed(1), target: app.energy?.out?.renderFps ?? null,
        tracking: !!app.tracker.isTracking, visible: !!app.stage.root.visible, card: !!st.cardVisible, walking: !!app.stage.walking,
        persona: d.persona?.id, micOpen: !!app.engine?.mic?.isOpen, asr: e?.asrState ?? null, elistening: !!e?.listening,
        bubble: !!b?.classList.contains('show') && !b.classList.contains('hint'),
      });
    } catch (err) {
      push('sample_err', { msg: String(err) });
    }
  };
  real.si(sample, 500);
}
