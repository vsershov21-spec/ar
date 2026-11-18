/** /test/admin/: продакт вводит токен и код устройства → смотрит или сбрасывает прогресс (server/progress, admin/code/:code) */
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const token = $<HTMLInputElement>('token'), code = $<HTMLInputElement>('code'), all = $<HTMLInputElement>('all'), out = $<HTMLPreElement>('out');
token.value = sessionStorage.getItem('ar.adminToken') ?? '';
token.onchange = () => sessionStorage.setItem('ar.adminToken', token.value.trim());
const qc = new URLSearchParams(location.search).get('code');
if (qc) code.value = qc;

async function call(method: 'GET' | 'DELETE') {
  const c = code.value.trim().toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(c)) {
    out.textContent = 'Код — 6 символов: цифры 0–9 и буквы A–F.';
    return;
  }
  if (method === 'DELETE' && !confirm(`Сбросить прогресс устройства ${c}?`)) return;
  out.textContent = '…';
  try {
    const r = await fetch(`/api/progress/admin/code/${c}${method === 'DELETE' && all.checked ? '?all=1' : ''}`, {
      method, headers: { Authorization: 'Bearer ' + token.value.trim() }, cache: 'no-store',
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      out.textContent = r.status === 401 ? 'Неверный токен.' : r.status === 503 ? 'Админ-сброс выключен: на сервере не задан PROGRESS_ADMIN_TOKEN.' : `Ошибка ${r.status}: ${j.error ?? ''}`;
      return;
    }
    if (method === 'DELETE') out.textContent = j.reset ? `Сброшено устройств: ${j.reset}. На телефоне прогресс сотрётся при следующем запуске.` : 'Устройство с таким кодом не найдено.';
    else if (!j.devices?.length) out.textContent = 'Устройство с таким кодом не найдено (ещё не синхронизировалось или удалено через 90 дней).';
    else
      out.textContent = j.devices
        .map((d: any) => `обновлено: ${new Date(d.updatedAt).toLocaleString()}\nверсия: ${d.version}${d.resetAt ? `\nсброшено: ${new Date(d.resetAt).toLocaleString()}` : ''}\nключи: ${d.keys.join(', ') || '—'}\nсессий: ${d.sessions}`)
        .join('\n\n');
  } catch (e) {
    out.textContent = 'Сервер прогресса недоступен: ' + String(e);
  }
}
$('find').onclick = () => void call('GET');
$('reset').onclick = () => void call('DELETE');
