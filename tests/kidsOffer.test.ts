// @vitest-environment jsdom
/**
 * Карточка «Войти в СберKids» (src/ui/kidsOffer.ts): место (дом / после игры) тратится, только когда ребёнок карточку
 * видел. Убрал её «занятый» кот сразу же (позвал домой, уснул — диалог начался в ту же секунду) — карточка вернётся.
 * E2E 24.11 (07_sberkids): карточка (play) показалась и через секунду ушла под «кот зовёт домой» — и больше не появлялась.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KidsOffer } from '../src/ui/kidsOffer';
import { KIDS_OFFER } from '../src/config/sberkids';

function memStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe('KidsOffer: показ в счёт, только если ребёнок его видел', () => {
  let st: { playing: boolean; home: boolean; busy: boolean };
  let k: KidsOffer;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
    st = { playing: true, home: false, busy: false };
    const root = document.createElement('div');
    document.body.appendChild(root);
    k = new KidsOffer({ root, playing: () => st.playing, home: () => st.home, busy: () => st.busy, showSheet: () => undefined }, memStore());
  });
  afterEach(() => {
    k.dispose();
    vi.useRealTimers();
  });

  it('после игры: убрана «занятым» котом через 1 с — вернётся, когда кот освободится', () => {
    for (let i = 0; i < KIDS_OFFER.actions; i++) k.noteAction();
    vi.advanceTimersByTime((KIDS_OFFER.minPlaySec + 2) * 1000);
    expect(k.visible).toBe(true);
    st.busy = true; // кот позвал домой
    vi.advanceTimersByTime(1000);
    expect(k.visible).toBe(false);
    vi.advanceTimersByTime(20_000);
    expect(k.visible).toBe(false);
    st.busy = false;
    vi.advanceTimersByTime(2000);
    expect(k.visible).toBe(true);
    expect(k.el.dataset.where).toBe('play');
  });

  it('видел (≥ seenMs) и кот занялся — больше не показываем', () => {
    for (let i = 0; i < KIDS_OFFER.actions; i++) k.noteAction();
    vi.advanceTimersByTime((KIDS_OFFER.minPlaySec + 2) * 1000);
    expect(k.visible).toBe(true);
    vi.advanceTimersByTime(KIDS_OFFER.seenMs + 1000);
    st.busy = true;
    vi.advanceTimersByTime(1000);
    expect(k.visible).toBe(false);
    st.busy = false;
    vi.advanceTimersByTime(60_000);
    expect(k.visible).toBe(false);
  });

  it('ушла сама (autoHide) — место потрачено', () => {
    for (let i = 0; i < KIDS_OFFER.actions; i++) k.noteAction();
    vi.advanceTimersByTime((KIDS_OFFER.minPlaySec + 2) * 1000);
    expect(k.visible).toBe(true);
    vi.advanceTimersByTime((KIDS_OFFER.autoHideSec + 1) * 1000);
    expect(k.visible).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(k.visible).toBe(false);
  });

  it('дома: закрыл крестиком — дома больше нет, после игры — да', () => {
    st.home = true;
    vi.advanceTimersByTime((KIDS_OFFER.homeDelaySec + 2) * 1000);
    expect(k.visible).toBe(true);
    expect(k.el.dataset.where).toBe('home');
    (k.el.querySelector('.kc-x') as HTMLButtonElement).click();
    expect(k.visible).toBe(false);
    vi.advanceTimersByTime(30_000);
    expect(k.visible).toBe(false);
    st.home = false;
    for (let i = 0; i < KIDS_OFFER.actions; i++) k.noteAction();
    // игра идёт с начала (≥ minPlaySec наберётся по ходу) — ждём показа, не дольше autoHide
    for (let s = 0; s < KIDS_OFFER.minPlaySec + 2 && !k.visible; s++) vi.advanceTimersByTime(1000);
    expect(k.visible).toBe(true);
    expect(k.el.dataset.where).toBe('play');
  });
});
