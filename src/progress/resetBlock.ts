/**
 * Блок «Сбросить прогресс этого устройства» для страницы /test (и debug-вкладки).
 *   import { mountProgressReset } from '../progress/resetBlock';
 *   mountProgressReset(document.getElementById('progress')!);
 * Показывает короткий код устройства (его продакт вводит на /test/admin/), кнопку сброса и статус.
 */
import { deviceCode, getDeviceId, safeStorage } from './device';
import { ProgressSync } from './sync';

export function mountProgressReset(el: HTMLElement, opts: { reloadTo?: string } = {}) {
  const storage = safeStorage();
  const device = getDeviceId(storage);
  const code = deviceCode(device);
  el.classList.add('progress-reset');
  el.innerHTML = `
    <div style="font:600 15px/1.3 system-ui">Прогресс кота на этом устройстве</div>
    <div style="margin:6px 0;font:14px system-ui">Код устройства: <b data-code style="font-family:ui-monospace,monospace;letter-spacing:2px">${code}</b></div>
    <button type="button" data-reset style="padding:10px 14px;border-radius:10px;border:0;background:#c62828;color:#fff;font:600 14px system-ui">Сбросить прогресс этого устройства</button>
    <div data-status style="margin-top:6px;font:13px system-ui;opacity:.8"></div>`;
  const status = el.querySelector<HTMLElement>('[data-status]')!;
  el.querySelector<HTMLButtonElement>('[data-reset]')!.onclick = async () => {
    if (!storage) {
      status.textContent = 'Хранилище браузера недоступно (приватный режим?) — сбрасывать нечего.';
      return;
    }
    if (!confirm('Стереть имя, выбранного кота и всё, что ребёнок открыл, на этом устройстве?')) return;
    status.textContent = 'Сбрасываю…';
    const r = await new ProgressSync({ device, storage }).resetDevice();
    status.textContent = r === 'ok' ? 'Готово: прогресс стёрт и на телефоне, и на сервере.' : 'Стёрто на телефоне; сервер недоступен — сотрём при следующем запуске.';
    if (opts.reloadTo) setTimeout(() => location.assign(opts.reloadTo!), 800);
  };
  return { device, code };
}
