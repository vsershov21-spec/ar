/**
 * Отчёт по клипам Meshy (?meshyreport → вкладка «Тест» панели, docs/animations/MESHY.md): каждый ожидаемый id
 * (clips.MESHY_IDS) → загружен / нет / отвергнут (причина) и где играет (события реакций, кнопки, точки кода).
 * Чистая функция без DOM — tests/meshyMap.test.ts.
 */
import { MESHY_IDS, clipDef } from './clips';
import type { MeshyStatus } from './meshyClips';

export interface MeshyRow {
  id: string;
  /** pending — манифест ещё не прочитан (клипы грузятся после кота) */
  state: 'loaded' | 'missing' | 'rejected' | 'pending';
  reason?: string;
  dur?: number;
  /** остаток проникновения рук/ног после коррекции, мм (проверка при загрузке) */
  pen?: number;
  persona: string;
  usedBy: string[];
  /** что играет без клипа (опора / прежний клип реакции) */
  fallback: string;
}

const P1: Record<string, string> = { hooligan: 'Х', kind: 'Д', glitter: 'Б' };

/** reactions — persona → событие → { clip } (content/personas/*.json) */
export function meshyRows(status: ReadonlyMap<string, MeshyStatus>, reactions: Record<string, Record<string, { clip?: string }>>, pen?: ReadonlyMap<string, number>, ids: readonly string[] = MESHY_IDS): MeshyRow[] {
  return ids.map((id) => {
    const d = clipDef(id);
    const r = d?.meshy;
    const used = new Set<string>();
    for (const w of r?.on ?? []) used.add(w);
    for (const [p, evs] of Object.entries(reactions))
      for (const [ev, def] of Object.entries(evs)) if (def?.clip === id && (d?.persona === 'all' || d?.persona === p)) used.add(d?.persona === 'all' ? `${ev} (${P1[p] ?? p})` : ev);
    for (const u of d?.usedBy ?? []) if (u.startsWith('code:')) used.add(u);
    // у всех котов одно событие — без пометок характера
    const merged = new Map<string, string[]>();
    for (const u of used) {
      const m = u.match(/^(.*) \((.)\)$/);
      if (!m) merged.set(u, []);
      else merged.set(m[1], [...(merged.get(m[1]) ?? []), m[2]]);
    }
    const usedBy = [...merged].map(([k, ps]) => (ps.length && ps.length < 3 ? `${k} (${ps.join('')})` : k));
    const st = status.get(id);
    const fb = d?.fallback ?? (r?.from?.join('/') || (r?.on ? 'прежний клип реакции' : d?.cut ? `${id} (монтаж cut)` : `${id} (anims_v1 / псевдоним)`));
    return { id, state: st?.state ?? 'pending', reason: st?.reason, dur: st?.dur, pen: pen?.get(id), persona: d?.persona ?? 'all', usedBy, fallback: fb };
  });
}

const STATE: Record<MeshyRow['state'], string> = { loaded: 'загружен', missing: 'нет', rejected: 'отвергнут', pending: 'ждём манифест' };

/** текстовая таблица (консоль, Markdown) */
export function meshyReportText(rows: MeshyRow[]): string {
  const n = (s: MeshyRow['state']) => rows.filter((r) => r.state === s).length;
  const L = [
    `Клипы Meshy: загружено ${n('loaded')}, нет ${n('missing')}, отвергнуто ${n('rejected')}, ждём ${n('pending')} (из ${rows.length})`,
    '| id | состояние | длит., с | проникн., мм | играет на | без клипа |',
    '|---|---|---|---|---|---|',
  ];
  for (const r of rows)
    L.push(`| ${r.id} | ${STATE[r.state]}${r.reason ? `: ${r.reason}` : ''} | ${r.dur ?? '—'} | ${r.pen ?? '—'} | ${r.usedBy.join(', ') || '—'} | ${r.fallback} |`);
  return L.join('\n');
}

/** ?meshyreport разрешён: lab — всегда, пилот/MVP — только со страницы /test (from=test) */
export function meshyReportWanted(search: string, lab: boolean, fromTest: boolean): boolean {
  return new URLSearchParams(search).has('meshyreport') && (lab || fromTest);
}

export { STATE as MESHY_STATE_LABEL };
