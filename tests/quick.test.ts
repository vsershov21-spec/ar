// быстрый вход (feature 'intro.quick', src/quick): заставка до бандла, согласие, отказ в камере, метка ?src= в аналитике
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
// jsdom без типов в проекте (другие тесты берут его окружением vitest): отдельное окно на тест
const JSDOM_MOD = 'jsdom';
const { JSDOM } = (await import(/* @vite-ignore */ JSDOM_MOD)) as { JSDOM: new (html: string, o: object) => { window: any } };
import { QUICK_SCRIPT, QUICK_TEXT, quickSplash } from '../src/quick/splash';
import { CONSENT_TEXT, PRIVACY_POLICY_URL, hasPolicyUrl, parseConsentMode } from '../src/config/consent';
import { Analytics, ONCE, readSrc } from '../src/analytics';
import { createProgressServer, type ProgressServer } from '../server/progress/server.mjs';
import { featureIn } from '../src/config/edition';
import { QUICK_HINT_CAPTIONS, QUICK_SEARCH_LINES } from '../src/quick/entry';

const DEV = '0f8fad5b-d9cb-469f-a165-70867728950e';
const html = (consent: 'notice' | 'checkbox' | 'parent' = 'notice') => quickSplash({ consent, policyUrl: PRIVACY_POLICY_URL });

describe('быстрый вход: редакции', () => {
  it('в пилоте и lab — быстрый вход, тур из 4 экранов в пилоте выключен, MVP не трогаем', () => {
    expect(featureIn('pilot', 'intro.quick')).toBe(true);
    expect(featureIn('lab', 'intro.quick')).toBe(true);
    expect(featureIn('mvp', 'intro.quick')).toBe(false);
    expect(featureIn('pilot', 'intro.tour')).toBe(false);
  });
});

describe('быстрый вход: заставка', () => {
  it('один экран: заголовок-загадка, подзаголовок, одна кнопка wake, юр. плашка и ссылка на условия', () => {
    const h = html();
    expect(h).toContain('Кто-то живёт в&nbsp;твоей карте…');
    expect(h).toContain('Положи карту Сбера на&nbsp;стол — и&nbsp;узнаешь, кто');
    expect(h.match(/data-a="wake"/g)).toHaveLength(1);
    expect(h).toContain(QUICK_TEXT.cta);
    expect(h).toContain(CONSENT_TEXT.notice);
    expect(h).toContain(CONSENT_TEXT.link);
  });
  it('кота до разрешений нет: ни картинок, ни спрайтов, ни моделей — только CSS-карта с глазами', () => {
    const h = html();
    expect(h).not.toMatch(/<img|\.webp|\.png|\.glb|sprites/);
    expect(h).toContain('q-eyes');
    expect(h).toContain('prefers-reduced-motion');
  });
  it('без внешних ресурсов и без запросов до нажатия (скрипт и стили — встроены)', () => {
    expect(html()).not.toMatch(/<link|src="|url\(/);
  });
  it('режимы согласия: notice — без галочки; checkbox / parent — с галочкой и своим текстом', () => {
    expect(html('notice')).not.toContain('type="checkbox"');
    expect(html('checkbox')).toContain(CONSENT_TEXT.checkbox);
    expect(html('parent')).toContain(CONSENT_TEXT.parent);
    expect(parseConsentMode('parent')).toBe('parent');
    expect(parseConsentMode('evil')).toBe('notice');
    expect(parseConsentMode(undefined)).toBe('notice');
  });
  it('URL полной политики — плейсхолдер: ссылку не показываем, пишем TODO', () => {
    expect(hasPolicyUrl()).toBe(false);
    expect(html()).toContain('TODO');
    expect(quickSplash({ consent: 'notice', policyUrl: 'https://www.sberbank.ru/privacy' })).toContain('href="https://www.sberbank.ru/privacy"');
  });
  it('ограничения камеры заставки — те же, что у трекера карты (иначе поток не подойдёт)', () => {
    const tr = fs.readFileSync('src/tracker/cardTracker.ts', 'utf8');
    for (const [a, b] of [
      ['hd ? 1280 : 960', 'hd?1280:960'],
      ['hd ? 720 : 540', 'hd?720:540'],
      ['frameRate: { ideal: 30 }', 'frameRate:{ideal:30}'],
      ["facingMode: 'environment'", "facingMode:'environment'"],
      ['autoGainControl: false, channelCount: 1', 'autoGainControl:false,channelCount:1'],
      ["get('cam') === '720'", "get('cam')==='720'"],
      ["get('aec') !== '0'", "get('aec')!=='0'"],
    ])
      expect([tr.includes(a), QUICK_SCRIPT.includes(b)], a).toEqual([true, true]);
  });
  it('смысл экранов тура не потерян: подписи к кнопкам и фразы поиска', () => {
    const caps = QUICK_HINT_CAPTIONS.map((c) => c.text).join(' ');
    for (const w of ['Погладь', 'накорми', 'Игры', 'раскраска', 'дом', 'Скажи коту']) expect(caps).toContain(w);
    const lines = QUICK_SEARCH_LINES.join(' ');
    expect(lines).toContain('Держи телефон над картой');
    expect(lines).toContain('только маме или папе');
  });
});

/** заставка в jsdom: встроенный скрипт, getUserMedia подменён */
function mount(consent: 'notice' | 'checkbox' | 'parent', gum: (c: MediaStreamConstraints) => Promise<unknown>) {
  const dom = new JSDOM(`<!doctype html><body>${html(consent)}<div id="app"></div></body>`, { runScripts: 'outside-only', url: 'https://ar.vershov.com/mvp/?src=sber123' });
  const w = dom.window as unknown as Window & typeof globalThis & { __quick: Record<string, any>; eval(s: string): unknown };
  const calls: MediaStreamConstraints[] = [];
  Object.defineProperty(w.navigator, 'mediaDevices', { value: { getUserMedia: (c: MediaStreamConstraints) => (calls.push(c), gum(c)) } });
  (w as any).requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
  w.eval(QUICK_SCRIPT);
  const q = (s: string) => w.document.querySelector(s) as HTMLElement;
  return { w, q, calls, Q: w.__quick };
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const stream = (audio: boolean) => ({ getAudioTracks: () => (audio ? [{}] : []), getVideoTracks: () => [{}] });

describe('быстрый вход: встроенный скрипт', () => {
  it('нажатие до бандла: камера+микрофон одним запросом, событие cta_tap (early), кнопка «Будим…»', async () => {
    const { q, calls, Q } = mount('notice', async () => stream(true));
    q('.q-cta').click();
    expect(Q.tapped).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].video).toBeTruthy();
    expect(calls[0].audio).toBeTruthy();
    expect(q('.q-cta').classList.contains('busy')).toBe(true);
    const r = await Q.cam;
    expect(r.stream).toBeTruthy();
    await tick();
    const names = Q.ev.map((e: [string]) => e[0]);
    expect(names).toEqual(expect.arrayContaining(['cta_tap', 'camera_granted', 'mic_granted']));
    expect(Q.ev.find((e: [string]) => e[0] === 'cta_tap')[1].early).toBe(1);
  });
  it('микрофон не дали — камера отдельно, mic_denied, играем без голоса', async () => {
    const { q, calls, Q } = mount('notice', async (c) => {
      if (c.audio) throw Object.assign(new Error('no'), { name: 'NotAllowedError' });
      return stream(false);
    });
    q('.q-cta').click();
    const r = await Q.cam;
    expect(calls).toHaveLength(2);
    expect(r.stream).toBeTruthy();
    expect(r.mic).toBe('NotAllowedError');
    expect(Q.ev.map((e: [string]) => e[0])).toEqual(expect.arrayContaining(['camera_granted', 'mic_denied']));
  });
  it('камеру не дали: экран «Без камеры кот не увидит карту», «Попробовать ещё раз» спрашивает снова', async () => {
    let allow = false;
    const { q, calls, Q } = mount('notice', async () => {
      if (!allow) throw Object.assign(new Error('no'), { name: 'NotAllowedError' });
      return stream(true);
    });
    q('.q-cta').click();
    await Q.cam;
    await tick();
    expect(q('.q-denied').classList.contains('hidden')).toBe(false);
    expect(q('.q-denied').textContent).toContain('Без камеры кот не');
    expect(q('.q-denied').textContent).toContain('Safari');
    expect(q('.q-denied').textContent).toContain('Chrome');
    expect(Q.ev.map((e: [string]) => e[0])).toContain('camera_denied');
    allow = true;
    const n = calls.length;
    q('[data-q="retry"]').click();
    expect(calls.length).toBeGreaterThan(n);
    expect((await Q.cam).stream).toBeTruthy();
    expect(q('.q-denied').classList.contains('hidden')).toBe(true);
  });
  it('согласие checkbox/parent: без галочки кнопка не открывает камеру, с галочкой — открывает', async () => {
    for (const mode of ['checkbox', 'parent'] as const) {
      const { q, calls, Q } = mount(mode, async () => stream(true));
      q('.q-cta').click();
      expect(calls).toHaveLength(0);
      expect(Q.tapped).toBe(false);
      expect(q('.q-need').classList.contains('hidden')).toBe(false);
      const cb = q('.q-check input') as HTMLInputElement;
      cb.checked = true;
      cb.dispatchEvent(new (cb.ownerDocument.defaultView as any).Event('change'));
      q('.q-cta').click();
      expect(calls).toHaveLength(1);
    }
  });
  it('лист «Условия и конфиденциальность» открывается и закрывается', () => {
    const { q, Q } = mount('notice', async () => stream(true));
    q('[data-q="terms"]').click();
    expect(q('.q-sheet').classList.contains('hidden')).toBe(false);
    expect(q('.q-sheet').textContent).toContain('Данные карты не считываются');
    q('[data-q="close"]').click();
    expect(q('.q-sheet').classList.contains('hidden')).toBe(true);
    expect(Q.ev.map((e: [string]) => e[0])).toContain('terms_open');
  });
  it('с ?nocard / ?desktop заставка камеру не открывает (её откроет приложение)', () => {
    const dom = new JSDOM(`<!doctype html><body>${html()}</body>`, { runScripts: 'outside-only', url: 'https://ar.vershov.com/lab/?desktop' });
    const w = dom.window as any;
    let n = 0;
    Object.defineProperty(w.navigator, 'mediaDevices', { value: { getUserMedia: async () => (n++, stream(true)) } });
    w.requestAnimationFrame = () => 0;
    w.eval(QUICK_SCRIPT);
    w.document.querySelector('.q-cta').click();
    expect(n).toBe(0);
    expect(w.__quick.tapped).toBe(true);
  });
});

describe('аналитика: метка источника ?src=', () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };
  it('только латиница и цифры до 32 символов; иначе — без метки', () => {
    expect(readSrc('?src=sber0451', mem())).toBe('sber0451');
    for (const bad of ['?src=', '?src=сбер', '?src=a-b', '?src=a%20b', '?src=' + 'a'.repeat(33), '?src=<x>', '?src=ivan@mail.ru']) expect(readSrc(bad, mem()), bad).toBeNull();
  });
  it('сохраняется на 30 дней: открыли без метки — метка прошлого QR', () => {
    const s = mem();
    const t = Date.UTC(2026, 10, 22);
    expect(readSrc('?src=lipetsk39', s, t)).toBe('lipetsk39');
    expect(readSrc('', s, t + 86_400_000)).toBe('lipetsk39');
    expect(readSrc('', s, t + 31 * 86_400_000)).toBeNull();
    expect(readSrc('?src=bad-one', s, t)).toBe('lipetsk39');
  });
  it('метка — в каждом событии; шаги воронки входа — под своими именами раз за сессию', () => {
    const sent: Record<string, unknown>[] = [];
    const a = new Analytics({ device: DEV, edition: 'pilot', send: (_u, b) => (sent.push(JSON.parse(b)), true), src: 'sber0451', clock: () => 1234 });
    a.track('open', {}, true);
    a.track('card_landed', { ms: 5000 }, true);
    a.track('action', { id: 'pet' });
    a.track('action', { id: 'hug' });
    expect(sent.every((e) => e.src === 'sber0451')).toBe(true);
    expect(sent.map((e) => e.name)).toEqual(['open', 'page_open', 'card_landed', 'card_found', 'action', 'first_action', 'action']);
    expect(sent.find((e) => e.name === 'first_action')!.props).toEqual({ ms: 1234, id: 'pet' });
    expect(ONCE.has('cta_tap')).toBe(true);
  });
});

for (const kind of ['file', 'sqlite'] as const) {
  describe(`сервер (${kind}): метка src`, () => {
    let dir: string, p: ProgressServer, base: string;
    const TOKEN = 't';
    const post = (body: unknown) => fetch(base + '/api/progress/event', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain' } });
    beforeEach(async () => {
      dir = mkdtempSync(path.join(tmpdir(), 'quick-'));
      p = await createProgressServer({ dataDir: dir, store: kind, adminToken: TOKEN, origins: [], now: () => Date.UTC(2026, 10, 22, 12), rate: { ip: 1000, writes: 1000, events: 100 } });
      await new Promise<void>((r) => p.server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${(p.server.address() as AddressInfo).port}`;
    });
    afterEach(async () => {
      await p.close();
      rmSync(dir, { recursive: true, force: true });
    });
    it('src проверяется и хранится в props (формат строк тот же); stats — разрез bySrc и фильтр ?src=', async () => {
      expect((await post({ device: DEV, edition: 'pilot', name: 'cta_tap', props: { ms: 900, early: 1 }, src: 'sber0451' })).status).toBe(204);
      expect((await post({ device: DEV, edition: 'pilot', name: 'page_open', props: { ms: 300 }, src: 'evil src!' })).status).toBe(204);
      expect((await post({ device: DEV, edition: 'pilot', name: 'splash_shown', props: { ms: 700 } })).status).toBe(204);
      const rows = p.store.eventRows(0);
      expect(rows.map((r) => r.props)).toEqual([{ ms: 900, early: 1, src: 'sber0451' }, { ms: 300 }, { ms: 700 }]);
      expect(Object.keys(rows[0]).sort()).toEqual(['device', 'edition', 'name', 'props', 'ts']);
      const j = await (await fetch(`${base}/api/progress/stats?token=${TOKEN}`)).json();
      expect(j.rows).toHaveLength(1);
      expect(j.bySrc.map((r: { src: string | null }) => r.src)).toEqual([null, 'sber0451']);
      expect(j.srcs).toEqual([{ src: 'sber0451', devices: 1 }]);
      const f = await (await fetch(`${base}/api/progress/stats?token=${TOKEN}&src=sber0451`)).json();
      expect(Object.keys(f.rows[0].events)).toEqual(['cta_tap']);
      const none = await (await fetch(`${base}/api/progress/stats?token=${TOKEN}&src=none`)).json();
      expect(Object.keys(none.rows[0].events).sort()).toEqual(['page_open', 'splash_shown']);
    });
  });
}
