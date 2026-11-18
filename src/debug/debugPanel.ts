/**
 * Панель ?debug: вкладки-плагины (см. tabs.ts), FPS-счётчик, общий лог.
 * Встроенные вкладки — builtinTabs.ts; свои вкладки модули регистрируют через registerDebugTab().
 */
import type { App } from '../app';
import { perf } from '../core/perf';
import { debugTabs, onDebugTab, type DebugTab, type DebugUi } from './tabs';
import { registerBuiltinTabs } from './builtinTabs';
import { EDITION } from '../config/edition';

const css = `
.dbg { position: fixed; z-index: 50; right: 0; top: 0; bottom: 0; width: min(320px, 82vw); background: rgba(10,14,18,.88); color: #dfe; font: 12px/1.3 ui-monospace, Menlo, monospace;
  display: flex; flex-direction: column; transform: translateX(0); transition: transform .2s; backdrop-filter: blur(6px); padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom); }
.dbg.closed { transform: translateX(100%); }
.dbg-tabs { display: flex; flex-wrap: wrap; gap: 2px; padding: 6px 6px 4px; border-bottom: 1px solid #2a3a45; flex: none; }
.dbg-tabs button { font: inherit; padding: 5px 7px; border-radius: 6px 6px 0 0; border: 1px solid #3a4a55; border-bottom: 0; background: #141c22; color: #9ab; }
.dbg-tabs button.on { background: #b5e36a; color: #111; }
.dbg-body { overflow-y: auto; padding: 4px 8px 60px; flex: 1; }
.dbg-pane { display: none; }
.dbg-pane.on { display: block; }
.dbg h4 { margin: 10px 0 4px; color: #b5e36a; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
.dbg button { font: inherit; margin: 2px; padding: 5px 7px; border-radius: 6px; border: 1px solid #3a4a55; background: #1b252d; color: #eef; }
.dbg button.on { background: #b5e36a; color: #111; }
.dbg label { display: grid; grid-template-columns: 90px 1fr 44px; gap: 6px; align-items: center; margin: 2px 0; }
.dbg input[type=range] { width: 100%; }
.dbg select { width: 100%; margin: 3px 0; font: inherit; background: #1b252d; color: #eef; border: 1px solid #3a4a55; border-radius: 6px; padding: 4px; }
.dbg .log { white-space: pre-wrap; max-height: 60vh; overflow-y: auto; background: #0007; padding: 4px; border-radius: 6px; }
.dbg-toggle { position: fixed; z-index: 51; left: 0; top: 50%; transform: translateY(-50%); min-width: 44px; height: 44px; padding: 0 8px 0 calc(6px + env(safe-area-inset-left));
  border-radius: 0 12px 12px 0; border: 1px solid rgba(255,255,255,.14); border-left: 0; background: rgba(10,34,40,.55); color: #b5e36a;
  font: 600 11px/1.1 ui-monospace, Menlo, monospace; backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); opacity: .7; }
@media (orientation: landscape) and (max-height: 520px) {
  .dbg-toggle { left: auto; right: 0; top: calc(4px + env(safe-area-inset-top)); transform: none; border-radius: 12px 0 0 12px; border: 1px solid rgba(255,255,255,.14); border-right: 0;
    padding: 0 calc(6px + env(safe-area-inset-right)) 0 8px; }
}
.dbg-toggle b { display: block; font-size: 12px; color: #fff; }
.dbg-fps { flex: none; color: #b5e36a; font: 11px ui-monospace, monospace; padding: 6px 8px; border-bottom: 1px solid #2a3a45; white-space: pre; }
`;

export class DebugPanel {
  private el: HTMLDivElement;
  private bar: HTMLDivElement;
  private body: HTMLDivElement;
  private panes = new Map<string, { tab: DebugTab; pane: HTMLDivElement; btn: HTMLButtonElement }>();
  private active = '';
  private lines: string[] = [];
  private logListeners = new Set<(s: string) => void>();
  readonly ui: DebugUi;

  constructor(private app: App) {
    const st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
    const el = document.createElement('div');
    el.className = 'dbg closed'; // свёрнута по умолчанию: открыть — язычок «DBG» слева
    this.el = el;
    this.bar = document.createElement('div');
    this.bar.className = 'dbg-tabs';
    this.body = document.createElement('div');
    this.body.className = 'dbg-body';
    el.append(this.bar, this.body);
    document.body.appendChild(el);
    const tog = document.createElement('button');
    tog.className = 'dbg-toggle';
    tog.innerHTML = `<b>DBG·${EDITION.toUpperCase()}</b><span>—</span>`; // редакция сборки (config/edition.ts)
    tog.setAttribute('aria-label', 'Отладка');
    tog.onclick = () => el.classList.toggle('closed');
    document.body.appendChild(tog);

    // FPS: среднее за 0,5 с + худший кадр + время слоя эффектов
    const fps = document.createElement('div');
    fps.className = 'dbg-fps';
    el.prepend(fps);
    const togFps = tog.querySelector('span')!;
    let acc = 0, worst = 0, tickAcc = 0;
    const prevFrame = app.onFrame;
    app.onFrame = (dt) => {
      prevFrame(dt);
      acc += dt;
      tickAcc += dt;
      worst = Math.max(worst, dt);
      if (acc > 0.5) {
        const fxMs = (app.fx as any).frameMs as number | undefined;
        fps.textContent =
          `${app.fps.toFixed(0)} fps · max ${(worst * 1000).toFixed(0)} мс · fx ${fxMs?.toFixed(2) ?? '—'} мс\n` +
          `${app.director.state.phase} · ${app.director.persona.id} · ${app.character.kind}${app.tracker.isTracking ? '' : ' · карта потеряна'}\n` +
          energyLine(app);
        togFps.textContent = app.fps.toFixed(0);
        acc = 0;
        worst = 0;
      }
      if (tickAcc > 0.25) {
        tickAcc = 0;
        const a = this.panes.get(this.active);
        if (a?.tab.tick && !el.classList.contains('closed')) a.tab.tick(a.pane, this.ui);
      }
    };
    (window as any).__debugPanel = this;

    const self = this;
    this.ui = {
      app,
      btn: (p, label, fn, id) => this.btn(p, label, fn, id),
      section: (p, title) => this.section(p, title),
      slider: (p, label, min, max, step, get, set) => this.slider(p, label, min, max, step, get, set),
      select: (p, opts, on, id) => this.select(p, opts, on, id),
      log: (s) => self.log(s),
    };
    app.director.on('log', (s) => this.log(s));

    registerBuiltinTabs();
    for (const t of debugTabs()) this.add(t);
    onDebugTab((t) => this.add(t));
    this.show(debugTabs()[0]?.id ?? '');
  }

  /** открыть вкладку по id (скрипты скриншотов: __debugPanel.show('voice')) */
  show(id: string) {
    this.active = id;
    for (const [k, v] of this.panes) {
      v.pane.classList.toggle('on', k === id);
      v.btn.classList.toggle('on', k === id);
    }
  }

  open(v = true) {
    this.el.classList.toggle('closed', !v);
  }

  onLog(fn: (s: string) => void) {
    this.logListeners.add(fn);
    return () => this.logListeners.delete(fn);
  }

  get logLines() {
    return this.lines;
  }

  private add(tab: DebugTab) {
    const old = this.panes.get(tab.id);
    if (old) {
      old.pane.remove();
      old.btn.remove();
    }
    const pane = document.createElement('div');
    pane.className = 'dbg-pane';
    pane.dataset.tab = tab.id;
    const btn = document.createElement('button');
    btn.textContent = tab.title;
    btn.dataset.dbgTab = tab.id;
    btn.onclick = () => this.show(tab.id);
    // вставка по order
    const all = debugTabs();
    const idx = all.findIndex((t) => t.id === tab.id);
    const next = all.slice(idx + 1).map((t) => this.panes.get(t.id)).find(Boolean);
    this.bar.insertBefore(btn, next?.btn ?? null);
    this.body.insertBefore(pane, next?.pane ?? null);
    this.panes.set(tab.id, { tab, pane, btn });
    try {
      tab.build(pane, this.ui);
    } catch (e) {
      pane.textContent = `ошибка вкладки: ${String(e)}`;
      console.error('[debug] вкладка', tab.id, e);
    }
    if (old && this.active === tab.id) this.show(tab.id);
  }

  log(s: string) {
    const line = `${(performance.now() / 1000).toFixed(1)} ${s}`;
    this.lines.push(line);
    if (this.lines.length > 200) this.lines.shift();
    this.logListeners.forEach((fn) => fn(line));
  }

  private section(parent: HTMLElement, title: string) {
    const h = document.createElement('h4');
    h.textContent = title;
    parent.appendChild(h);
    const d = document.createElement('div');
    parent.appendChild(d);
    return d;
  }

  private btn(parent: HTMLElement, label: string, fn: () => void, id?: string) {
    const b = document.createElement('button');
    b.textContent = label;
    if (id) b.dataset.dbg = id;
    b.onclick = fn;
    parent.appendChild(b);
    return b;
  }

  private slider(parent: HTMLElement, label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void) {
    const l = document.createElement('label');
    l.innerHTML = `<span></span><input type=range min=${min} max=${max} step=${step}><output></output>`;
    l.querySelector('span')!.textContent = label;
    const r = l.querySelector('input')!, o = l.querySelector('output')!;
    r.value = String(get());
    o.textContent = r.value;
    r.oninput = () => {
      set(Number(r.value));
      o.textContent = r.value;
    };
    parent.appendChild(l);
    return r;
  }

  private select(parent: HTMLElement, options: [string, string][], onChange: (v: string) => void, id?: string) {
    const s = document.createElement('select');
    for (const [v, l] of options) s.add(new Option(l, v));
    if (id) s.dataset.dbg = id;
    s.onchange = () => onChange(s.value);
    parent.appendChild(s);
    return s;
  }

  /** пробуждение → появление → пропуск имени → текущий характер */
  async fastForward() {
    const d = this.app.director;
    if (d.state.phase === 'start') await this.app.wake();
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 40 && d.state.phase !== 'ask_name' && d.state.phase !== 'play'; i++) await wait(100);
    if (d.state.phase === 'ask_name') d.dispatch({ type: 'skip_name' });
    if (d.state.phase === 'choose') d.dispatch({ type: 'choose', persona: d.persona.id });
  }
}

/**
 * Строка энергобюджета: режим (boost 60 / normal 30 / calm 20 / doze 12), фактические частоты за ~1 с —
 * рендер (кадры, где реально рисовали WebGL), трекер (кадры в детектор), распознавание (порции звука в Vosk
 * и доля реального времени), микрофон; поворот телефона °/с; pixelRatio.
 */
function energyLine(app: App): string {
  const r = perf.rates();
  const e = app.energy.out;
  const tr = app.tracker as unknown as { maxHz?: number };
  const cap = tr.maxHz ? `≤${tr.maxHz}` : 'камера';
  const asr = r.asr ? `${r.asr.toFixed(0)} Гц (${((r.asrSec ?? 0) * 100).toFixed(0)}% времени)` : 'спит';
  return (
    `⚡ ${app.energy.enabled || app.energy.fixedFps ? e.mode : 'выкл'} · рендер ${(r.render ?? 0).toFixed(0)}/${e.renderFps || '∞'} к/с · трекер ${(r.tracker ?? 0).toFixed(0)} Гц (${cap})\n` +
    `⚡ распознавание ${asr} · мик ${(r.mic ?? 0).toFixed(0)} Гц · поворот ${app.energy.phoneDps.toFixed(0)}°/с · px ${app.renderer.getPixelRatio().toFixed(2)}`
  );
}
