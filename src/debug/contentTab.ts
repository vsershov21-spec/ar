/**
 * Вкладка «Контент» debug-панели: характер → событие → любая реплика по id, запуск диалога, outro.
 * Работает через window.__cat (src/debug/catApi.ts). Регистрируется в реестре вкладок src/debug/tabs.ts.
 */
import { registerDebugTab } from './tabs';
import { PERSONA_IDS, type PersonaId } from '../persona/types';
import type { CatApi } from './catApi';

export function registerContentTab(api: CatApi) {
  registerDebugTab({
    id: 'content',
    title: 'Контент',
    order: 15,
    build(el, ui) {
      const d = ui.app.director;
      const box = ui.section(el, 'Характер · событие · реплика');
      const info = document.createElement('div');
      info.style.cssText = 'opacity:.75;margin:2px 0;white-space:pre-wrap';
      let persona: PersonaId = d.personas.id;
      let event = 'intro';
      let line = '';
      const selP = ui.select(box, PERSONA_IDS.map((id) => [id, d.personas.get(id)?.name ?? id]), (v) => {
        persona = v as PersonaId;
        api.persona(persona);
        fillLines();
      }, 'content:persona');
      selP.value = persona;
      const selE = ui.select(box, api.events().map((e) => [e, e]), (v) => {
        event = v;
        fillLines();
      }, 'content:event');
      selE.value = event;
      box.appendChild(info);
      let selL = ui.select(box, [], (v) => (line = v), 'content:line');
      function fillLines() {
        const opts = api.lines(persona, event).map((l) => [l.id, `${l.id.split('.').pop()} ${l.emotion}: ${l.text}`] as [string, string]);
        const fresh = ui.select(box, opts, (v) => (line = v), 'content:line');
        selL.replaceWith(fresh);
        selL = fresh;
        selL.size = Math.min(6, Math.max(2, opts.length));
        line = opts[0]?.[0] ?? '';
        const ev = d.personas.content.events.get(event);
        info.textContent = ev ? `prio ${ev.priority} · cooldown ${ev.cooldownMs} мс · ${ev.interruptible ? 'можно перебить' : 'не перебивается'}\n${ev.trigger}` : '';
      }
      const off = d.on('persona', (id) => {
        persona = id;
        selP.value = id;
        fillLines();
      });
      const row = ui.section(el, 'Проиграть');
      ui.btn(row, '▶ реплика', () => line && ui.log(`say ${line}: ${api.say(line)}`), 'content:say');
      ui.btn(row, '▶ событие', () => ui.log(`event ${event}: ${api.event(event)}`), 'content:event');
      ui.btn(row, '▶ как диалог / интент', () => api.event(event, true), 'content:dialog');
      ui.btn(row, 'Outro', () => api.outro(), 'content:outro');
      const talk = ui.section(el, 'Сказать за ребёнка');
      for (const t of ['меня зовут Маша', 'не скажу', 'добряк', 'загадай загадку', 'не знаю', 'да', 'нет', 'повторяй за мной', 'хватит', 'пока', 'сколько у меня денег', 'мне грустно', 'мне страшно'])
        ui.btn(talk, t, () => api.text(t), 'content:text:' + t);
      fillLines();
      return off;
    },
  });
}
