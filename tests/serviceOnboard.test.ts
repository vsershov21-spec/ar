// @vitest-environment jsdom
/**
 * Онборды в сервисы (src/ui/serviceOnboard.ts, config/onboards.ts, docs/scenario/ONBOARDS.md):
 *   Самокат — реплики кота → 6 продуктов в корзину (счётчик) → лист «Перекус от <кота>» → «Отправить маме на оплату»;
 *   СберKids — копилка (монетки, прогресс) → экскурс 3 шага → «Войти в СберKids» (существующий переход с меткой точки).
 * Каждый шаг — событие onb_step без имени ребёнка (152-ФЗ).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sent: { name: string; props: Record<string, unknown> }[] = [];
vi.mock('../src/analytics', () => ({ track: (name: string, props: Record<string, unknown> = {}) => void sent.push({ name, props }) }));

import { ServiceOnboard, type OnbHost } from '../src/ui/serviceOnboard';
import { KIDS_TOUR, ONB_LINES, ONB_MS, ONB_VOICE_LINES, PIGGY, SNACKS, SVC_ITEMS, withMark } from '../src/config/onboards';

function host(over: Partial<OnbHost> = {}) {
  const root = document.createElement('div');
  root.className = 'ui';
  document.body.appendChild(root);
  const said: string[] = [];
  const clips: string[] = [];
  const shifts: unknown[] = [];
  const sheets: string[] = [];
  const h: OnbHost = {
    root,
    persona: () => ({ id: 'kind', name: 'Добряк' }),
    say: (t) => void said.push(t),
    clip: (c) => void clips.push(c),
    sound: () => undefined,
    catPoint: () => ({ x: 195, y: 300 }),
    activity: () => undefined,
    shift: (f) => void shifts.push(f),
    showSheet: (u) => void sheets.push(u),
    src: () => 'lipetsk39',
    ...over,
  };
  return { h, root, said, clips, shifts, sheets };
}
const steps = (svc: string) => sent.filter((e) => e.name === 'onb_step' && e.props.svc === svc).map((e) => e.props.step);
const tap = (root: HTMLElement, k: string) => (root.querySelector(`[data-k="${k}"]`) as HTMLElement).click();

describe('онборд Самоката', () => {
  beforeEach(() => {
    sent.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('реплики кота → 6 продуктов в корзину (счётчик) → лист «Перекус от Добряка» → «Отправить маме на оплату»', () => {
    const { h, root, said } = host();
    const o = new ServiceOnboard(h);
    o.open('samokat');
    expect(o.active).toBe('samokat');
    expect(root.classList.contains('onb-on')).toBe(true);
    expect(said[0]).toBe(ONB_LINES.samokat.hello);
    expect(o.stage).toBe('store');
    vi.advanceTimersByTime(ONB_MS.hello + 10);
    expect(said[1]).toBe(ONB_LINES.samokat.collect);
    // jsdom без Web Animations: предмет «долетает» по таймеру
    vi.advanceTimersByTime(SNACKS.length * ONB_MS.snack + ONB_MS.fly);
    expect(o.cart).toBe(SNACKS.length);
    expect(root.querySelector('.onb-count')?.textContent).toBe(String(SNACKS.length));
    vi.advanceTimersByTime(ONB_MS.toSheet + 100);
    expect(o.stage).toBe('sheet');
    expect(root.querySelector('.onb-head b')?.textContent).toBe('Перекус от Добряка');
    expect(root.querySelectorAll('.onb-list li').length).toBe(SNACKS.length);
    expect(root.querySelector('[data-k="send"]')?.textContent).toBe('Отправить маме на оплату');
    tap(root, 'send');
    // диплинка Самоката пока нет — честная заглушка «покажи маме»
    expect(o.stage).toBe('sent');
    expect(said.at(-1)).toBe(ONB_LINES.samokat.stub);
    tap(root, 'done');
    expect(o.active).toBe(null);
    expect(root.classList.contains('onb-on')).toBe(false);
    expect(steps('samokat')).toEqual(['open', 'hello', 'collect', 'item', 'item', 'item', 'item', 'item', 'item', 'sheet', 'send', 'done']);
    const send = sent.find((e) => e.props.step === 'send')!;
    expect(send.props.kind).toBe('stub');
    expect(sent.filter((e) => e.props.step === 'item').map((e) => e.props.n)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('× посреди — событие close с шагом, таймеры не срабатывают, кот возвращается на место', () => {
    const { h, root, shifts } = host();
    const o = new ServiceOnboard(h);
    o.open('samokat');
    vi.advanceTimersByTime(ONB_MS.hello + ONB_MS.snack * 2);
    tap(root, 'close');
    expect(o.active).toBe(null);
    const n = o.cart;
    vi.advanceTimersByTime(20_000);
    expect(o.cart).toBe(n);
    expect(steps('samokat').at(-1)).toBe('close');
    expect(sent.at(-1)!.props.at).toBe('store');
    expect(shifts.at(-1)).toBe(null);
  });
});

describe('онборд СберKids', () => {
  beforeEach(() => {
    sent.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('копилка наполняется монетками → экскурс 3 шага («Дальше») → «Войти в СберKids» с меткой точки', () => {
    const opened: string[] = [];
    vi.spyOn(window, 'open').mockImplementation((u) => (opened.push(String(u)), { opener: {} } as Window));
    const { h, root, said } = host();
    const o = new ServiceOnboard(h);
    o.open('kids');
    expect(said[0]).toBe(ONB_LINES.kids.hello);
    expect(o.stage).toBe('piggy');
    expect(o.piggy).toBe(PIGGY.from);
    vi.advanceTimersByTime(ONB_MS.hello * 0.6 + PIGGY.coins * ONB_MS.coin + ONB_MS.fly);
    expect(o.piggy).toBe(PIGGY.to);
    vi.advanceTimersByTime(ONB_MS.toSheet + 100);
    expect(o.stage).toBe('tour');
    for (let k = 0; k < KIDS_TOUR.length; k++) {
      expect(root.querySelector('.onb-tour')?.getAttribute('data-t')).toBe(KIDS_TOUR[k].id);
      expect(said.at(-1)).toBe(ONB_LINES.kids.tour[k]);
      tap(root, 'next');
    }
    expect(o.stage).toBe('go');
    expect(root.querySelector('[data-k="kids_go"]')?.textContent).toContain('Войти в СберKids');
    tap(root, 'kids_go');
    expect(opened.length).toBe(1);
    expect(opened[0]).toContain('utm_source=ar_cat');
    expect(opened[0]).toContain('utm_content=onb');
    expect(opened[0]).toContain('utm_campaign=lipetsk39');
    vi.advanceTimersByTime(500);
    expect(o.active).toBe(null);
    expect(steps('kids')).toEqual(['open', 'hello', 'piggy', 'coin', 'coin', 'coin', 'coin', 'coin', 'tour', 'tour', 'tour', 'go_offer', 'go']);
    expect(sent.some((e) => e.name === 'sberkids_click' && e.props.kind === 'web_onb')).toBe(true);
  });

  it('экскурс листается сам, если ребёнок не жмёт «Дальше»', () => {
    const { h } = host();
    const o = new ServiceOnboard(h);
    o.open('kids');
    vi.advanceTimersByTime(ONB_MS.hello + PIGGY.coins * ONB_MS.coin + ONB_MS.fly + ONB_MS.toSheet + KIDS_TOUR.length * ONB_MS.tourAuto + 500);
    expect(o.stage).toBe('go');
  });
});

describe('онборды: конфиг и аналитика без персональных данных', () => {
  it('в меню — два значка сервиса; все реплики онбордов — в списке для озвучки', () => {
    expect(SVC_ITEMS.map((s) => s.id)).toEqual(['svc:samokat', 'svc:kids']);
    for (const t of [...Object.values(ONB_LINES.samokat), ONB_LINES.kids.hello, ONB_LINES.kids.piggy, ...ONB_LINES.kids.tour, ONB_LINES.kids.go, ONB_LINES.kids.later]) expect(ONB_VOICE_LINES).toContain(t);
    // ни одна реплика не зовёт «погладить» (pilot.noCare)
    for (const t of ONB_VOICE_LINES) expect(t).not.toMatch(/глад|щекоч|обним|ласк/i);
  });
  it('onb_step: только сервис, метка шага, номер, способ; текст/имя выбрасываются', async () => {
    const { sanitize } = await vi.importActual<typeof import('../src/analytics')>('../src/analytics');
    expect(sanitize('onb_step', { svc: 'samokat', step: 'item', n: 3, name: 'Маша', text: 'Ой!' })).toEqual({ name: 'onb_step', props: { svc: 'samokat', step: 'item', n: 3 } });
    expect(sanitize('onb_step', { svc: 'kids', step: 'go', kind: 'web' })!.props).toEqual({ svc: 'kids', step: 'go', kind: 'web' });
  });
  it('withMark: метка источника к https-ссылке и к схеме приложения', () => {
    expect(withMark('https://example.org/app?x=1', 'onb', 'msk1')).toBe('https://example.org/app?x=1&utm_source=ar_cat&utm_content=onb&utm_campaign=msk1');
    expect(withMark('https://example.org/', 'onb', null)).toBe('https://example.org/?utm_source=ar_cat&utm_content=onb');
    expect(withMark('sberkids:open', 'onb', 'a')).toBe('sberkids:open?utm_source=ar_cat&utm_content=onb&utm_campaign=a');
  });
});
