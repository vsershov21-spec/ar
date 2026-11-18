/** вкладка ?debug «Прогресс»: код устройства, состояние синхронизации, сброс, история сессий */
import { registerDebugTab } from '../debug/tabs';
import { progressHandle } from './index';
import { mountProgressReset } from './resetBlock';

export function registerProgressTab() {
  registerDebugTab({
    id: 'progress', title: 'Прогресс', order: 80,
    build(el, ui) {
      const h = progressHandle();
      const box = document.createElement('div');
      el.append(box);
      mountProgressReset(box, { reloadTo: location.pathname + location.search });
      const st = document.createElement('div');
      st.dataset.st = '';
      st.style.cssText = 'margin:8px 0;font:12px ui-monospace,monospace;white-space:pre-wrap';
      el.append(st);
      const s = ui.section(el, 'Сервер');
      ui.btn(s, 'Записать сейчас', () => void h?.sync?.flush().then(() => ui.log('прогресс: ' + h.sync!.state)), 'progress_flush');
      ui.btn(s, 'История сессий', async () => {
        try {
          const r = await fetch(`/api/progress/${h!.device}/sessions`, { cache: 'no-store' });
          const j = await r.json();
          for (const x of (j.sessions ?? []).slice(0, 5))
            ui.log(`${new Date(x.startedAt).toLocaleString()} ${x.cat ?? ''} ${x.endedAt ? Math.round((x.endedAt - x.startedAt) / 1000) + ' с' : '…'} ${x.events.slice(-6).join(' ')}`);
        } catch (e) {
          ui.log('история: ' + String(e));
        }
      }, 'progress_sessions');
    },
    tick(el) {
      const h = progressHandle();
      const st = el.querySelector<HTMLElement>('[data-st]');
      if (!st || !h) return;
      const s = h.sync;
      st.textContent = s
        ? `синхронизация: ${s.state}${s.lastError ? ' (' + s.lastError + ')' : ''}\nпоследняя запись: ${s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleTimeString() : '—'}\nнеотправлено: ${Object.keys(s.diff()).join(', ') || '—'}`
        : 'синхронизация выключена (?progress=0 или нет localStorage)';
    },
  });
}
