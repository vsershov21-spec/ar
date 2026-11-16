/**
 * Встроенные вкладки debug-панели. Владельцы модулей могут заменить любую вкладку своей —
 * registerDebugTab({ id: '<тот же id>', … }) из своего модуля.
 *  scenario — сценарий, ввод, текст/голос, характер (логика и диалоги)
 *  fx       — анимации и эффекты (интерактив; см. src/debug/fxTab.ts, подменяется при загрузке)
 *  stage    — кот на карте, трекер
 *  voice    — реплики и липсинк (голосовой движок)
 *  log      — общий лог
 */
import { registerDebugTab, type DebugUi } from './tabs';
import { DebugTracker } from '../tracker/debugTracker';
import { saveStage, defaultStage, type StageConfig } from '../config';
import { clearMemory } from '../scenario/memory';
import { VISEMES } from '../lipsync/visemes';
import { registerFxTab } from './fxTab';

let done = false;
export function registerBuiltinTabs() {
  if (done) return;
  done = true;

  registerDebugTab({
    id: 'scenario', title: 'Сценарий', order: 10,
    build(el, ui) {
      const app = ui.app, d = app.director;
      const W = () => app.root.clientWidth, H = () => app.root.clientHeight;
      const tracker = app.tracker as DebugTracker;
      let s = ui.section(el, 'Сценарий');
      ui.btn(s, 'Разбудить', () => void app.wake(), 'wake');
      ui.btn(s, 'Быстро в игру', () => void (window as any).__debugPanel?.fastForward(), 'fast');
      ui.btn(s, 'Сбросить память', () => {
        clearMemory();
        location.reload();
      }, 'reset');
      ui.btn(s, 'Карта найдена', () => tracker.simulate?.(true), 'found');
      ui.btn(s, 'Карта потеряна', () => tracker.simulate?.(false), 'lost');

      s = ui.section(el, 'Ввод');
      const cx = () => app.stage.headScreen(W(), H(), 0.5);
      ui.btn(s, 'Тап по коту', () => d.interaction('tap_cat', cx()), 'tap_cat');
      ui.btn(s, 'Тап мимо', () => d.interaction('tap_screen', { x: W() * 0.2, y: H() * 0.25 }), 'tap_screen');
      ui.btn(s, 'Тап по карте → идти', () => {
        const p = app.stage.headScreen(W(), H(), 0);
        d.interaction('tap_screen', { x: p.x + W() * 0.18, y: p.y + 10 });
      }, 'walk');
      ui.btn(s, 'Долгое', () => d.interaction('longpress', cx()), 'longpress');
      ui.btn(s, 'Свайп →', () => {
        const path = Array.from({ length: 12 }, (_, i) => ({ x: W() * (0.15 + i * 0.06), y: H() * (0.45 + Math.sin(i / 3) * 0.03) }));
        d.interaction('swipe', { x: path[11].x, y: path[11].y, from: path[0], path });
      }, 'swipe');
      ui.btn(s, 'Встряска', () => app.input.simulateShake(), 'shake');
      ui.btn(s, 'Спам ×5', () => d.interaction('spam'), 'spam');
      ui.btn(s, 'Тишина 10 с', () => d.dispatch({ type: 'silence' }), 'silence');

      s = ui.section(el, 'Голос / текст');
      for (const t of ['Меня зовут Маша', 'Привет', 'Сделай сальто', 'Загадай загадку', 'Танцуй', 'Расскажи шутку', 'Сколько у меня денег?', 'Давай другого', 'абырвалг'])
        ui.btn(s, t, () => d.text(t), 'say:' + t);
      const inp = document.createElement('input');
      inp.placeholder = 'свой текст + Enter';
      inp.style.cssText = 'width:100%;margin-top:4px;padding:6px;border-radius:6px;border:0';
      inp.onkeydown = (e) => {
        if (e.key === 'Enter') d.text(inp.value);
      };
      s.appendChild(inp);

      s = ui.section(el, 'Характер');
      for (const id of (d as any).d.personas.keys() as Iterable<string>) ui.btn(s, id, () => d.setPersona(id), 'persona:' + id);
      ui.btn(s, 'Фирменный трюк', () => (d as any).signature(), 'signature');
      ui.btn(s, 'Выбор (стикеры)', () => (d as any).offerChoice(), 'choice');
    },
  });

  registerFxTab();

  registerDebugTab({
    id: 'stage', title: 'Кот на карте', order: 30,
    build(el, ui) {
      const app = ui.app;
      const cfg = app.stage.cfg;
      const s = ui.section(el, 'Привязка к карте');
      const slider = (key: keyof StageConfig, min: number, max: number, step: number) =>
        ui.slider(s, key, min, max, step, () => Number(cfg[key]), (v) => {
          (cfg as any)[key] = v;
          if (key === 'footX' || key === 'footY') app.stage.resetPosition();
          saveStage(cfg);
        });
      slider('footX', -0.5, 0.5, 0.01);
      slider('footY', -0.4, 0.4, 0.01);
      slider('footZ', -0.1, 0.3, 0.01);
      slider('height', 0.4, 1.6, 0.01);
      slider('billboardTilt', 0, 1, 0.05);
      slider('glassHeightFrac', 0.3, 0.8, 0.01);
      slider('walkSpeed', 0.1, 1.5, 0.05);
      ui.btn(s, 'По умолчанию', () => {
        Object.assign(cfg, defaultStage);
        saveStage(cfg);
        app.stage.resetPosition();
      });
      ui.btn(s, 'Кот к стеклу', () => app.stage.setMode(app.stage.atGlass ? 'card' : 'glass'), 'glass');
      const tracker = app.tracker;
      if (tracker instanceof DebugTracker) {
        const t2 = ui.section(el, 'Debug-трекер');
        ui.slider(t2, 'наклон карты', 0, 1.5, 0.01, () => tracker.tilt, (v) => (tracker.tilt = v));
        ui.slider(t2, 'дистанция', 1, 12, 0.05, () => tracker.distance, (v) => (tracker.distance = v));
        ui.slider(t2, 'поворот', -1.5, 1.5, 0.01, () => tracker.yaw, (v) => (tracker.yaw = v));
        ui.btn(t2, 'Дрожание рук', () => (tracker.wobble = !tracker.wobble), 'wobble');
      }
    },
  });

  registerDebugTab({
    id: 'voice', title: 'Голос', order: 40,
    build(el, ui) {
      const app = ui.app, d = app.director;
      const s = ui.section(el, 'Реплики и липсинк');
      const viz = document.createElement('canvas');
      viz.width = 280;
      viz.height = 90;
      viz.style.cssText = 'width:100%;background:#0008;border-radius:6px';
      s.appendChild(viz);
      const vg = viz.getContext('2d')!;
      const drawViz = () => {
        requestAnimationFrame(drawViz);
        if (!el.classList.contains('on')) return;
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
        const sh = lip.shape;
        vg.fillStyle = '#7a2a3a';
        vg.beginPath();
        vg.ellipse(240, 40, 14 + sh.wide * 14 - sh.round * 8, 2 + sh.open * 22, 0, 0, Math.PI * 2);
        vg.fill();
        vg.fillStyle = '#dfe';
        vg.fillText(app.voice.mode ?? '—', 214, 84);
      };
      drawViz();
      const m = app.voice.manifest;
      for (const [pid, lines] of Object.entries(m)) {
        for (const [id, e] of Object.entries(lines)) ui.btn(s, `▶ ${pid}/${id}`, () => d.speakText(pid, e.text), `voice:${pid}/${id}`).title = e.text;
      }
      const opts: [string, string][] = [];
      for (const [pid, per] of (d as any).d.personas as Map<string, any>) {
        const txt = (l: any) => (typeof l === 'string' ? l : l?.text ?? '');
        for (const [k, arr] of Object.entries((per.lines ?? {}) as Record<string, any[]>)) arr.forEach((t) => opts.push([`${pid}|${txt(t)}`, `${pid}:${k} — ${txt(t)}`]));
        for (const [k, r] of Object.entries((per.reactions ?? {}) as Record<string, any>)) (r.lines ?? []).forEach((t: any) => opts.push([`${pid}|${txt(t)}`, `${pid}:${k} — ${txt(t)}`]));
      }
      const sel = ui.select(s, opts.slice(0, 800), () => undefined);
      ui.btn(s, '▶ синтез выбранной', () => {
        const [pid, t] = sel.value.split('|');
        d.speakText(pid, t);
      }, 'voice:synth');
      for (const cat of ['sfx', 'voice', 'ambience'] as const)
        ui.slider(s, `громк. ${cat}`, 0, 1, 0.05, () => app.audio.volume[cat], (v) => app.audio.setVolume(cat, v));
    },
  });

  registerDebugTab({
    id: 'log', title: 'Лог', order: 90,
    build(el, ui: DebugUi) {
      const logEl = document.createElement('div');
      logEl.className = 'log';
      el.appendChild(logEl);
      const p = (window as any).__debugPanel;
      const render = () => {
        logEl.textContent = (p?.logLines ?? []).join('\n');
        logEl.scrollTop = 1e9;
      };
      p?.onLog(() => el.classList.contains('on') && render());
      render();
      ui.btn(el, 'Очистить', () => {
        p?.logLines.splice(0);
        render();
      });
    },
    tick: (el) => {
      const l = el.querySelector('.log') as HTMLElement;
      const p = (window as any).__debugPanel;
      if (l && p) {
        l.textContent = p.logLines.join('\n');
        l.scrollTop = 1e9;
      }
    },
  });
}
