import { describe, expect, it } from 'vitest';
import { IDLE_MS, SESSION_GAP_MS, SessionMarks, TOUR_MAX_SESSIONS, pickHint, type HintId, type HintState } from '../src/ui/hints';
import { isPlaceholder, kidsTargets, SBERKIDS_DEEPLINK, SBERKIDS_WEB_FALLBACK } from '../src/config/sberkids';
import { whyShort } from '../src/ui/tomMenu';

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const base: HintState = { playing: true, busy: false, home: false, idleMs: 0, playMs: 3000, touched: false };
const none = () => false;

describe('подсказки «нажми сюда»: выбор', () => {
  it('экскурсия — в начале игры, пока ребёнок ничего не трогал', () => {
    expect(pickHint(base, none, 0, null)).toBe('tour');
    expect(pickHint({ ...base, touched: true }, none, 0, null)).toBeNull();
    expect(pickHint({ ...base, playMs: 500 }, none, 0, null)).toBeNull();
    expect(pickHint(base, none, TOUR_MAX_SESSIONS, null)).toBeNull();
  });
  it('нет подсказок вне игры и когда кот занят', () => {
    expect(pickHint({ ...base, playing: false }, none, 0, null)).toBeNull();
    expect(pickHint({ ...base, busy: true, idleMs: IDLE_MS * 2 }, none, 0, 'home')).toBeNull();
  });
  it('бездействие — по одной, каждая раз за сессию', () => {
    const seen = new Set<HintId>(['tour']);
    const s = { ...base, touched: true, idleMs: IDLE_MS };
    const got: (HintId | null)[] = [];
    for (let i = 0; i < 4; i++) {
      const id = pickHint(s, (x) => seen.has(x), 1, null);
      got.push(id);
      if (id) seen.add(id);
    }
    expect(got).toEqual(['idle:1', 'idle:2', 'idle:3', null]);
  });
  it('смена режима — подсказка про новый режим', () => {
    expect(pickHint({ ...base, touched: true, home: true }, none, 1, 'home')).toBe('mode:home');
    expect(pickHint({ ...base, touched: true }, (x) => x === 'mode:card', 1, 'card')).toBeNull();
  });
});

describe('подсказки: память сессии в localStorage', () => {
  it('раз за сессию; через 30 мин — новая сессия, счётчик сессий растёт', () => {
    const st = mem();
    let t = 1_000_000;
    const a = new SessionMarks('k', st, () => t);
    a.mark('tour');
    expect(new SessionMarks('k', st, () => t + 1000).has('tour')).toBe(true);
    t += SESSION_GAP_MS + 1;
    const b = new SessionMarks('k', st, () => t);
    expect(b.has('tour')).toBe(false);
    expect(b.ever('tour')).toBe(1);
  });
  it('хранилище бросает (приватный режим) — не падаем', () => {
    const bad = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
    const m = new SessionMarks('k', bad);
    m.mark('tour');
    expect(m.has('tour')).toBe(true);
  });
});

describe('СберKids: адреса — плейсхолдеры, без выдуманных ссылок', () => {
  it('пока TODO — диплинка нет, ведём на проверенную страницу', () => {
    expect(isPlaceholder(SBERKIDS_DEEPLINK)).toBe(true);
    expect(isPlaceholder(SBERKIDS_WEB_FALLBACK)).toBe(true);
    const t = kidsTargets();
    expect(t.deeplink).toBeNull();
    expect(t.web).toMatch(/^https:\/\//);
  });
});

describe('неактивные кнопки: короткая причина', () => {
  it('карта / сон', () => {
    expect(whyShort('Сначала покажи мне карту')).toBe('нужна карта');
    expect(whyShort('Я уже сплю…')).toBe('спит');
    expect(whyShort('Я и так не сплю!')).toBe('не спит');
  });
});
