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

// ───────────── воронка (GET /api/progress/stats, docs/ANALYTICS.md) ─────────────
const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
async function stats() {
  const box = $<HTMLDivElement>('funnel');
  box.textContent = '…';
  try {
    const days = Number($<HTMLInputElement>('days').value) || 14;
    const src = $<HTMLInputElement>('src').value.trim();
    const r = await fetch(`/api/progress/stats?days=${days}${/^([A-Za-z0-9]{1,32}|none)$/.test(src) ? `&src=${src}` : ''}`, { headers: { Authorization: 'Bearer ' + token.value.trim() }, cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      box.textContent = r.status === 401 ? 'Неверный токен.' : r.status === 503 ? 'На сервере не задан PROGRESS_ADMIN_TOKEN.' : `Ошибка ${r.status}: ${j.error ?? ''} (сервис прогресса обновлён? scripts/deploy/pilot-setup.sh)`;
      return;
    }
    const rows = j.rows as { day: string; edition: string; events: Record<string, { n: number; devices: number }> }[];
    if (!rows.length) {
      box.textContent = 'Событий пока нет.';
      return;
    }
    const names = j.funnel as string[];
    const head = `<tr><th>событие</th>${rows.map((x) => `<th>${esc(x.day)}<br>${esc(x.edition)}</th>`).join('')}</tr>`;
    const body = names
      .map((n) => `<tr><td>${esc(n)}</td>${rows.map((x) => (x.events[n] ? `<td>${x.events[n].n} / ${x.events[n].devices}</td>` : '<td>—</td>')).join('')}</tr>`)
      .join('');
    // разрез по точкам раздачи QR (?src=, docs/ANALYTICS.md): сколько устройств пришло с каждой
    const srcs = (j.srcs ?? []) as { src: string; devices: number }[];
    const by = srcs.length ? `<p>Точки (src): ${srcs.map((x) => `${esc(x.src)} — ${x.devices} устр.`).join(', ')}</p>` : '';
    box.innerHTML = `${by}<table>${head}${body}</table>`;
  } catch (e) {
    box.textContent = 'Сервер прогресса недоступен: ' + String(e);
  }
}
$('stats').onclick = () => void stats();
