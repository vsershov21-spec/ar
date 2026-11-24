// @vitest-environment jsdom
/**
 * IMG-05 (независимый аудит 24.11): колонки уехали по автоскрытию, ребёнок жмёт язычок «Показать кнопки» у края —
 * колонка выезжает под пальцем, и click того же касания доставался появившейся кнопке («Обнять»). Теперь касание,
 * раскрывшее колонку, только раскрывает (0 действий); следующий отдельный тап — ровно одно выбранное действие.
 * Раскрытие — синхронно в pointerdown, без анимации в логике: с reduced motion поведение то же (проверяем оба).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadTestContent, dialogsFile } from './helpers/content';
import { buildCatalog, catalogEnv, moreSection, type CatalogItem, type CatalogSection } from '../src/ui/actionCatalog';
import { editionDialogs } from '../src/persona/content';
import { groupCatalog } from '../src/ui/catalogGroups';
import { TomMenu } from '../src/ui/tomMenu';
import { TOM_IDLE_MS } from '../src/ui/tomLayout';

const content = loadTestContent();
const env = catalogEnv(content.intents, editionDialogs(dialogsFile, false).triggers);

function groups() {
  const secs: CatalogSection[] = buildCatalog(content.personas.get('kind')!, env, { signature: true, pilot: true });
  const homeIt: CatalogItem = { id: 'home:go', label: 'Мой дом', icon: 'home_house', run: { ui: 'home' } };
  const withHome = secs.map((s) => (s.id === 'games' ? { ...s, items: [homeIt, ...s.items] } : s));
  return groupCatalog([...withHome, moreSection({ reanchor: true, mic: 'auto' })!], []);
}

const W = 390, H = 844;
const PE = (typeof PointerEvent !== 'undefined' ? PointerEvent : MouseEvent) as typeof PointerEvent;
function ev(type: string, x: number, y: number, extra: Record<string, unknown> = {}) {
  const e = new PE(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, detail: type === 'click' ? 1 : 0, ...extra } as PointerEventInit);
  if (!('pointerId' in e) || (e as PointerEvent).pointerId === undefined) Object.defineProperty(e, 'pointerId', { value: 1 });
  return e;
}
/** одно касание: pointerdown → pointerup → click; цель click — то, что под пальцем к моменту отпускания */
function tap(down: Element, x: number, y: number, under: () => Element) {
  down.dispatchEvent(ev('pointerdown', x, y, { pointerId: 1 }));
  const u = under();
  u.dispatchEvent(ev('pointerup', x, y, { pointerId: 1 }));
  u.dispatchEvent(ev('click', x, y));
}

describe.each([false, true])('IMG-05: язычок «Показать кнопки» (reduced motion: %s)', (reduced) => {
  let menu: TomMenu, root: HTMLDivElement, picks: string[];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduced && /reduce/.test(q), media: q, addEventListener() {}, removeEventListener() {} }));
    root = document.createElement('div');
    Object.defineProperty(root, 'clientWidth', { value: W });
    Object.defineProperty(root, 'clientHeight', { value: H });
    const dock = document.createElement('div');
    const micSlot = document.createElement('div');
    dock.append(micSlot);
    root.append(dock);
    document.body.append(root);
    picks = [];
    const tried = new Set<string>();
    menu = new TomMenu({
      root, dock, micSlot,
      groups,
      ctx: () => ({ home: null, busy: null }),
      catRect: () => ({ top: 420, bottom: 700, cx: W / 2, half: 90 }),
      tried: { has: (id) => tried.has(id), mark: (id) => (tried.add(id), true) },
      recent: { push() {} },
      icon: () => '<svg></svg>',
      pick: (it) => picks.push(it.id),
      hint() {},
      playing: () => true,
      scenarioQuiet: () => false,
    });
    menu.setOn(true);
  });
  afterEach(() => {
    menu.setOn(false);
    root.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('тап по язычку после автоскрытия — колонка раскрыта, 0 действий; следующий тап — ровно одно', () => {
    const hug = () => root.querySelector('.tom-col.l [data-item="hug"]') as HTMLElement;
    expect(hug()).toBeTruthy();
    vi.advanceTimersByTime(TOM_IDLE_MS + 500);
    expect(menu.hidden).toBe(true);
    const tab = root.querySelector('.tom-tab.l') as HTMLElement;
    // палец на язычке (видимый центр, как в аудите 11, 376); к отпусканию под ним уже кнопка колонки
    tap(tab, 11, 376, hug);
    expect(menu.hidden).toBe(false);
    expect(picks).toEqual([]);
    // отдельный тап по «Обнять» — одно действие
    vi.advanceTimersByTime(600);
    tap(hug(), 40, 376, hug);
    expect(picks).toEqual(['hug']);
    // и ещё один — ещё одно (поглощение не «залипает»)
    vi.advanceTimersByTime(600);
    tap(hug(), 40, 376, hug);
    expect(picks).toEqual(['hug', 'hug']);
  });

  it('клавиатура: Enter по язычку не глотает следующее действие', () => {
    vi.advanceTimersByTime(TOM_IDLE_MS + 500);
    const tab = root.querySelector('.tom-tab.l') as HTMLElement;
    tab.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect(menu.hidden).toBe(false);
    const hug = root.querySelector('.tom-col.l [data-item="hug"]') as HTMLElement;
    hug.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect(picks).toEqual(['hug']);
  });
});
