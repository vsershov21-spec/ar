/**
 * Вкладка «Голос» debug-панели (?debug → D): распознанный текст, интент, уверенность, уровень микрофона,
 * шумовой порог, режим, повтор; визуализация липсинка; проигрыш реплик; громкости.
 * То же доступно без панели: window.__voice (см. src/voice/engine.ts → api()).
 */
import { registerDebugTab } from '../debug/tabs';
import { VISEMES } from '../lipsync/visemes';

export function registerVoiceTab() {
  registerDebugTab({
    id: 'voice', title: 'Голос', order: 40,
    build(el, ui) {
      const app = ui.app, d = app.director, eng = app.engine;
      // ── вход ──
      const sIn = ui.section(el, 'Слух');
      const info = document.createElement('pre');
      info.className = 'voice-state';
      info.style.cssText = 'margin:4px 0;font:11px/1.35 monospace;white-space:pre-wrap;color:#dfe';
      sIn.appendChild(info);
      const meter = document.createElement('canvas');
      meter.width = 280;
      meter.height = 18;
      meter.style.cssText = 'width:100%;background:#0008;border-radius:4px';
      sIn.appendChild(meter);
      const mg = meter.getContext('2d')!;
      const hold = ui.btn(sIn, '🎤 держи и говори', () => undefined, 'voice:ptt');
      hold.addEventListener('pointerdown', () => eng.pttDown());
      hold.addEventListener('pointerup', () => eng.pttUp());
      hold.addEventListener('pointerleave', () => eng.pttUp());
      ui.btn(sIn, 'Окно ответа 5 с', () => eng.listen({ windowMs: 5000 }), 'voice:listen');
      ui.select(sIn, [['ptt', 'режим: push-to-talk'], ['auto', 'режим: слушаю сам']], (v) => eng.setMode(v as 'ptt' | 'auto'), 'voice:mode').value = eng.mode;
      ui.btn(sIn, '🔁 повтор (без сценария)', () => (eng.echo.active ? eng.echo.stop('button') : void eng.echo.start('direct')), 'voice:echo');
      ui.btn(sIn, '🔁 повтор через сценарий', () => eng.handleText('повторяй за мной', 'api'), 'voice:echo-dialog');
      ui.btn(sIn, 'Загрузить Vosk', () => void eng.asr.preload?.(), 'voice:vosk');
      const txt = document.createElement('input');
      txt.placeholder = 'как будто ребёнок сказал…';
      txt.style.cssText = 'width:100%;margin-top:4px';
      txt.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && txt.value.trim()) {
          eng.handleText(txt.value.trim(), 'api');
          txt.value = '';
        }
      });
      sIn.appendChild(txt);

      // ── выход: липсинк ──
      const s = ui.section(el, 'Реплики и липсинк');
      const viz = document.createElement('canvas');
      viz.width = 280;
      viz.height = 90;
      viz.style.cssText = 'width:100%;background:#0008;border-radius:6px';
      s.appendChild(viz);
      const vg = viz.getContext('2d')!;
      let raf = 0;
      const draw = () => {
        raf = requestAnimationFrame(draw);
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
        vg.ellipse(240, 40, Math.max(2, 14 + sh.wide * 14 - sh.round * 8), 2 + sh.open * 22, 0, 0, Math.PI * 2);
        vg.fill();
        vg.fillStyle = '#dfe';
        vg.fillText(`${app.voice.mode ?? '—'} ${app.voice.lipStrategy}`, 200, 84);
        // уровень микрофона и пороги
        const st = eng.state();
        mg.clearRect(0, 0, 280, 18);
        mg.fillStyle = st.catSpeaking ? '#666' : '#b6ff3b';
        mg.fillRect(0, 0, 280 * eng.mic.level, 18);
        const x = (dbv: number) => ((dbv + 60) / 50) * 280;
        mg.fillStyle = '#f80';
        mg.fillRect(x(st.floorDb), 0, 2, 18);
        mg.fillStyle = '#f33';
        mg.fillRect(x(st.floorDb + 12), 0, 2, 18);
      };
      draw();
      ui.select(s, [['phon', 'липсинк: фонемы (ru)'], ['amp', 'липсинк: амплитуда']], (v) => (app.voice.lipStrategy = v as 'phon' | 'amp'), 'voice:lips').value = app.voice.lipStrategy;
      const opts: [string, string][] = [];
      const manifest = app.voice.manifest;
      const pm = (d as any).personaMap as Map<string, any> | undefined;
      for (const [pid, per] of pm ?? new Map()) {
        void app.voice.usePersona(pid);
        const txt2 = (l: any) => (typeof l === 'string' ? l : l?.text ?? '');
        for (const [k, arr] of Object.entries((per.lines ?? {}) as Record<string, any[]>)) (arr ?? []).forEach((t) => opts.push([`${pid}|${txt2(t)}`, `${pid}:${k} — ${txt2(t)}`]));
      }
      const sel = ui.select(s, opts.slice(0, 900), () => undefined, 'voice:line');
      ui.btn(s, '▶ выбранная', () => {
        const [pid, t] = sel.value.split('|');
        d.speakText(pid, t);
      }, 'voice:synth');
      ui.btn(s, '▶ случайная записанная', () => {
        const pid = d.persona.id;
        const ids = Object.keys(manifest[pid] ?? {});
        if (ids.length) d.speakText(pid, manifest[pid][ids[Math.floor(Math.random() * ids.length)]].text);
      }, 'voice:random');
      for (const cat of ['sfx', 'voice', 'ambience'] as const)
        ui.slider(s, `громк. ${cat}`, 0, 1, 0.05, () => app.audio.volume[cat], (v) => app.audio.setVolume(cat, v));
      const offs = [eng.on('event', (e) => ui.log(`🎙 ${e.id}${e.data ? ' ' + JSON.stringify(e.data) : ''}`))];
      return () => {
        cancelAnimationFrame(raf);
        offs.forEach((f) => f());
      };
    },
    tick(el, ui) {
      const st = ui.app.engine.state();
      const v = ui.app.voice;
      const pre = el.querySelector('.voice-state');
      if (!pre) return;
      pre.textContent =
        `режим: ${st.mode}  движок: ${st.asr} (${st.asrState}${st.modelProgress && st.modelProgress < 1 ? ` ${Math.round(st.modelProgress * 100)}%` : ''})\n` +
        `слушаю: ${st.listening ? st.listenReason : 'нет'}  кот говорит: ${st.catSpeaking ? 'да' : 'нет'}  окно вопроса: ${st.question ? 'да' : 'нет'}\n` +
        `шум: ${st.floorDb} dBFS  повтор: ${st.echo}\n` +
        `текст: «${st.lastText}»\nинтент: ${st.lastIntent || '—'}  уверенность: ${st.lastConfidence}\n` +
        `событие: ${st.lastEvent || '—'}${st.micError ? `\nмикрофон: ${st.micError}` : ''}\n` +
        `озвучка: ${v.index ? `${v.index.codec}, ${v.index.lipsync}` : 'нет (синтез)'}  последняя: ${v.last ? `${v.last.source} ${v.last.id ?? ''}` : '—'}`;
    },
  });
}
