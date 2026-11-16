/** Панель ?debug: события, характеры, режимы персонажа, эффекты, слайдеры привязки к карте, FPS, лог. */
import type { App, CharacterMode } from '../app';
import { DebugTracker } from '../tracker/debugTracker';
import { saveStage, defaultStage, type StageConfig } from '../config';
import { clearMemory } from '../scenario/memory';
import { CLIPS, type ClipName } from '../character/types';
import type { FxName } from '../persona/types';
import { VISEMES, VISEME_SHAPE } from '../lipsync/visemes';

const css = `
.dbg { position: fixed; z-index: 50; right: 0; top: 0; bottom: 0; width: min(300px, 78vw); background: rgba(10,14,18,.86); color: #dfe; font: 12px/1.3 ui-monospace, Menlo, monospace;
  overflow-y: auto; padding: 8px; transform: translateX(0); transition: transform .2s; backdrop-filter: blur(6px); }
.dbg.closed { transform: translateX(100%); }
.dbg h4 { margin: 10px 0 4px; color: #b6ff3b; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
.dbg button { font: inherit; margin: 2px; padding: 5px 7px; border-radius: 6px; border: 1px solid #3a4a55; background: #1b252d; color: #eef; }
.dbg button.on { background: #b6ff3b; color: #111; }
.dbg label { display: grid; grid-template-columns: 80px 1fr 44px; gap: 6px; align-items: center; margin: 2px 0; }
.dbg input[type=range] { width: 100%; }
.dbg .log { white-space: pre-wrap; max-height: 160px; overflow-y: auto; background: #0007; padding: 4px; border-radius: 6px; }
.dbg-toggle { position: fixed; z-index: 51; right: 8px; bottom: calc(8px + env(safe-area-inset-bottom)); width: 40px; height: 40px; border-radius: 50%; border: 0; background: #b6ff3b; font-weight: 900; }
.dbg-fps { position: fixed; z-index: 51; left: 8px; bottom: calc(8px + env(safe-area-inset-bottom)); color: #b6ff3b; font: 12px ui-monospace, monospace; background: #0008; padding: 3px 6px; border-radius: 6px; pointer-events: none; }
`;

export class DebugPanel {
  private el: HTMLDivElement;
  private logEl!: HTMLDivElement;
  private lines: string[] = [];

  constructor(private app: App) {
    const st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
    const el = document.createElement('div');
    el.className = 'dbg' + (window.innerWidth < 700 ? ' closed' : '');
    this.el = el;
    document.body.appendChild(el);
    const tog = document.createElement('button');
    tog.className = 'dbg-toggle';
    tog.textContent = 'D';
    tog.onclick = () => el.classList.toggle('closed');
    document.body.appendChild(tog);
    const fps = document.createElement('div');
    fps.className = 'dbg-fps';
    document.body.appendChild(fps);
    let acc = 0;
    app.onFrame = (dt) => {
      acc += dt;
      if (acc > 0.25) {
        acc = 0;
        fps.textContent = `${app.fps.toFixed(0)} fps · ${app.director.state.phase} · ${app.director.persona.id} · ${app.character.kind}${app.tracker.isTracking ? '' : ' · карта потеряна'}`;
      }
    };
    app.director.on('log', (s) => this.log(s));
    this.build();
  }

  private log(s: string) {
    this.lines.push(`${(performance.now() / 1000).toFixed(1)} ${s}`);
    if (this.lines.length > 80) this.lines.shift();
    if (this.logEl) {
      this.logEl.textContent = this.lines.join('\n');
      this.logEl.scrollTop = 1e9;
    }
  }

  private section(title: string) {
    const h = document.createElement('h4');
    h.textContent = title;
    this.el.appendChild(h);
    const d = document.createElement('div');
    this.el.appendChild(d);
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

  private build() {
    const app = this.app;
    const d = app.director;
    const W = () => app.root.clientWidth, H = () => app.root.clientHeight;
    const tracker = app.tracker as DebugTracker;

    let s = this.section('Сценарий');
    this.btn(s, 'Разбудить', () => void app.wake(), 'wake');
    this.btn(s, 'Быстро в игру', () => this.fastForward(), 'fast');
    this.btn(s, 'Сбросить память', () => {
      clearMemory();
      location.reload();
    }, 'reset');
    this.btn(s, 'Карта найдена', () => tracker.simulate?.(true), 'found');
    this.btn(s, 'Карта потеряна', () => tracker.simulate?.(false), 'lost');

    s = this.section('Ввод');
    const cx = () => d['d'].stage.headScreen(W(), H(), 0.5);
    this.btn(s, 'Тап по коту', () => d.interaction('tap_cat', cx()), 'tap_cat');
    this.btn(s, 'Тап мимо', () => d.interaction('tap_screen', { x: W() * 0.2, y: H() * 0.25 }), 'tap_screen');
    this.btn(s, 'Тап по карте → идти', () => {
      const p = d['d'].stage.headScreen(W(), H(), 0);
      d.interaction('tap_screen', { x: p.x + W() * 0.18, y: p.y + 10 });
    }, 'walk');
    this.btn(s, 'Долгое', () => d.interaction('longpress', cx()), 'longpress');
    this.btn(s, 'Свайп →', () => {
      const path = Array.from({ length: 12 }, (_, i) => ({ x: W() * (0.15 + i * 0.06), y: H() * (0.45 + Math.sin(i / 3) * 0.03) }));
      d.interaction('swipe', { x: path[11].x, y: path[11].y, from: path[0], path });
    }, 'swipe');
    this.btn(s, 'Встряска', () => app.input.simulateShake(), 'shake');
    this.btn(s, 'Спам ×5', () => d.interaction('spam'), 'spam');
    this.btn(s, 'Тишина 10 с', () => d.dispatch({ type: 'silence' }), 'silence');

    s = this.section('Голос / текст');
    for (const t of ['Меня зовут Маша', 'Привет', 'Сделай сальто', 'Загадай загадку', 'Танцуй', 'Расскажи шутку', 'Сколько у меня денег?', 'Давай другого', 'абырвалг'])
      this.btn(s, t, () => d.text(t), 'say:' + t);
    const inp = document.createElement('input');
    inp.placeholder = 'свой текст + Enter';
    inp.style.cssText = 'width:100%;margin-top:4px;padding:6px;border-radius:6px;border:0';
    inp.onkeydown = (e) => {
      if (e.key === 'Enter') d.text(inp.value);
    };
    s.appendChild(inp);

    s = this.section('Характер');
    for (const id of ['hooligan', 'glitter']) this.btn(s, id, () => d.setPersona(id), 'persona:' + id);
    this.btn(s, 'Фирменный трюк', () => d['signature'](), 'signature');
    this.btn(s, 'Выбор (2 стикера)', () => d['offerChoice'](), 'choice');

    s = this.section('Режим персонажа');
    for (const m of ['sprite', 'rig', 'glb'] as CharacterMode[]) this.btn(s, m, () => void app.setCharacterMode(m), 'mode:' + m);

    s = this.section('Клипы');
    for (const c of Object.keys(CLIPS) as ClipName[]) this.btn(s, c, () => app.character.play(c), 'clip:' + c);

    s = this.section('Эффекты');
    const fxs: FxName[] = ['glitter_burst', 'glitter_trail', 'snow_globe', 'gum_bubble', 'claws', 'glitch', 'steam_heart', 'glass_cat', 'knock', 'sticker'];
    for (const f of fxs) this.btn(s, f, () => void d.runFx(f), 'fx:' + f);
    this.btn(s, 'Заклеить экран', () => void app.fx.cover(d.persona.stickers, d.persona.palette, 1500), 'cover');
    this.btn(s, 'Сдуть наклейки', () => app.fx.blowStickers(), 'blow');
    this.btn(s, 'Очистить эффекты', () => app.fx.reset(), 'fxreset');
    this.btn(s, 'Кот к стеклу', () => app.stage.setMode(app.stage.atGlass ? 'card' : 'glass'), 'glass');

    s = this.section('Кот на карте');
    const cfg = app.stage.cfg;
    const slider = (key: keyof StageConfig, min: number, max: number, stepv: number) => {
      const l = document.createElement('label');
      l.innerHTML = `<span>${key}</span><input type=range min=${min} max=${max} step=${stepv}><output></output>`;
      const r = l.querySelector('input')!, o = l.querySelector('output')!;
      r.value = String(cfg[key]);
      o.textContent = String(cfg[key]);
      r.oninput = () => {
        (cfg as any)[key] = Number(r.value);
        o.textContent = r.value;
        if (key === 'footX' || key === 'footY') app.stage.resetPosition();
        saveStage(cfg);
      };
      s.appendChild(l);
    };
    slider('footX', -0.5, 0.5, 0.01);
    slider('footY', -0.4, 0.4, 0.01);
    slider('footZ', -0.1, 0.3, 0.01);
    slider('height', 0.4, 1.6, 0.01);
    slider('billboardTilt', 0, 1, 0.05);
    slider('glassHeightFrac', 0.3, 0.8, 0.01);
    slider('walkSpeed', 0.1, 1.5, 0.05);
    this.btn(s, 'По умолчанию', () => {
      Object.assign(cfg, defaultStage);
      saveStage(cfg);
      app.stage.resetPosition();
    });
    if (tracker instanceof DebugTracker) {
      const l2 = (name: string, get: () => number, set: (v: number) => void, min: number, max: number) => {
        const l = document.createElement('label');
        l.innerHTML = `<span>${name}</span><input type=range min=${min} max=${max} step=0.01><output></output>`;
        const r = l.querySelector('input')!, o = l.querySelector('output')!;
        r.value = String(get());
        o.textContent = r.value;
        r.oninput = () => {
          set(Number(r.value));
          o.textContent = r.value;
        };
        s.appendChild(l);
      };
      l2('наклон карты', () => tracker.tilt, (v) => (tracker.tilt = v), 0, 1.5);
      l2('дистанция', () => tracker.distance, (v) => (tracker.distance = v), 1, 5);
      l2('поворот', () => tracker.yaw, (v) => (tracker.yaw = v), -1.5, 1.5);
      this.btn(s, 'Дрожание рук', (() => {
        return () => (tracker.wobble = !tracker.wobble);
      })(), 'wobble');
    }

    s = this.section('Реплики и липсинк');
    const viz = document.createElement('canvas');
    viz.width = 280;
    viz.height = 90;
    viz.style.cssText = 'width:100%;background:#0008;border-radius:6px';
    s.appendChild(viz);
    const vg = viz.getContext('2d')!;
    const drawViz = () => {
      requestAnimationFrame(drawViz);
      const lip = app.voice.lip;
      vg.clearRect(0, 0, 280, 90);
      VISEMES.forEach((v, i) => {
        const w = lip.weights[v];
        vg.fillStyle = v === lip.dominant ? '#b6ff3b' : '#5a7';
        vg.fillRect(8 + i * 22, 70 - w * 55, 16, w * 55);
        vg.fillStyle = '#dfe';
        vg.font = '11px monospace';
        vg.fillText(v, 12 + i * 22, 84);
      });
      // схематичный рот
      const sh = lip.shape;
      vg.fillStyle = '#7a2a3a';
      vg.beginPath();
      vg.ellipse(240, 40, 14 + sh.wide * 14 - sh.round * 8, 2 + sh.open * 22, 0, 0, Math.PI * 2);
      vg.fill();
      vg.fillStyle = '#dfe';
      vg.fillText(app.voice.mode ?? '—', 214, 84);
      void VISEME_SHAPE;
    };
    drawViz();
    const m = app.voice.manifest;
    for (const [pid, lines] of Object.entries(m)) {
      for (const [id, e] of Object.entries(lines)) this.btn(s, `▶ ${pid}/${id}`, () => d.speakText(pid, e.text), `voice:${pid}/${id}`).title = e.text;
    }
    const sel = document.createElement('select');
    sel.style.cssText = 'width:100%;margin-top:4px';
    for (const [pid, per] of (d as any).d.personas as Map<string, any>) {
      for (const [k, arr] of Object.entries(per.lines as Record<string, string[]>)) arr.forEach((t: string) => sel.add(new Option(`${pid}:${k} — ${t}`, `${pid}|${t}`)));
      for (const [k, r] of Object.entries(per.reactions as Record<string, any>)) (r.lines ?? []).forEach((t: string) => sel.add(new Option(`${pid}:${k} — ${t}`, `${pid}|${t}`)));
    }
    s.appendChild(sel);
    this.btn(s, '▶ синтез выбранной', () => {
      const [pid, t] = sel.value.split('|');
      d.speakText(pid, t);
    }, 'voice:synth');
    for (const cat of ['sfx', 'voice', 'ambience'] as const) {
      const l = document.createElement('label');
      l.innerHTML = `<span>громк. ${cat}</span><input type=range min=0 max=1 step=0.05 value=${app.audio.volume[cat]}><output>${app.audio.volume[cat]}</output>`;
      const r = l.querySelector('input')!;
      r.oninput = () => {
        app.audio.setVolume(cat, Number(r.value));
        l.querySelector('output')!.textContent = r.value;
      };
      s.appendChild(l);
    }

    s = this.section('Лог');
    this.logEl = document.createElement('div');
    this.logEl.className = 'log';
    s.appendChild(this.logEl);
  }

  /** пробуждение → появление → пропуск имени → Хулиган */
  async fastForward() {
    const d = this.app.director;
    if (d.state.phase === 'start') await this.app.wake();
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 40 && d.state.phase !== 'ask_name' && d.state.phase !== 'play'; i++) await wait(100);
    if (d.state.phase === 'ask_name') d.dispatch({ type: 'skip_name' });
    if (d.state.phase === 'choose') d.dispatch({ type: 'choose', persona: d.persona.id });
  }
}
