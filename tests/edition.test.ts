import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { FEATURES, PARAMS, NEW_GAMES, featureIn, featuresOf, filterSearch, fromTestPage, namespaceStorage, EDITION, parseEdition, type FeatureId } from '../src/config/edition';
import { editionDialogs } from '../src/persona/content';
import { buildCatalog, catalogEnv } from '../src/ui/actionCatalog';
import { cookieName } from '../src/progress/device';
import { loadTestContent, dialogsFile } from './helpers/content';
import { PERSONA_IDS } from '../src/persona/types';

describe('редакции: таблица функций', () => {
  it('без VITE_EDITION (dev, vitest, QA-стенд) — lab', () => {
    expect(EDITION).toBe('lab');
    expect(parseEdition(undefined)).toBe('lab');
    expect(parseEdition('mvp')).toBe('mvp');
    expect(parseEdition('pilot')).toBe('pilot');
  });
  it('lab — надмножество пилота, кроме ограничений самого пилота (pilot.*)', () => {
    for (const id of featuresOf('pilot')) if (!id.startsWith('pilot.')) expect(featureIn('lab', id), id).toBe(true);
  });
  it('пилот: кровать, пробуждение, прогресс, аналитика, раскраска-заглушка; без новых игр, пака наклеек и отладки', () => {
    expect(featuresOf('pilot')).toEqual(expect.arrayContaining(['home', 'home.bed', 'awake', 'progress.server', 'games.base', 'cat.switch', 'catalog.signature', 'pilot.catalog', 'pilot.fx', 'pilot.switchCooldown', 'glass.gestures', 'analytics', 'card.paint']));
    for (const id of ['games.new', 'stickers.pack', 'anims.new', 'debug.flows', 'card.anycard', 'card.grabExperimental', 'tracker.nocard', 'model.custom'] as FeatureId[]) expect(featureIn('pilot', id), id).toBe(false);
    expect(featureIn('mvp', 'card.paint')).toBe(false);
    // клипы Meshy: пилот — целевой (без манифеста играет как раньше), MVP — после iPhone
    expect(featureIn('pilot', 'anims.meshy')).toBe(true);
    expect(featureIn('lab', 'anims.meshy')).toBe(true);
    expect(featureIn('mvp', 'anims.meshy')).toBe(false);
    expect(featureIn('lab', 'card.paint')).toBe(true);
  });
  it('lab — надмножество MVP', () => {
    for (const id of featuresOf('mvp')) expect(featureIn('lab', id), id).toBe(true);
  });
  it('стартовое предложение продакта: в MVP — ядро, мир кота, пробуждение, серверный прогресс; без новых игр и отладки', () => {
    expect(featuresOf('mvp')).toEqual(expect.arrayContaining(['intro.2screens', 'card.sber', 'card.landing', 'ui.variantA', 'meet', 'play.free', 'games.base', 'silence.doze', 'cat.switch', 'home', 'awake', 'progress.server']));
    for (const id of ['games.new', 'stickers.pack', 'anims.new', 'debug.flows', 'card.anycard', 'card.grabExperimental', 'tracker.nocard', 'model.custom'] as FeatureId[]) expect(featureIn('mvp', id), id).toBe(false);
  });
  it('docs/EDITIONS.md: каждая функция таблицы описана, с готовностью к MVP', () => {
    const md = fs.readFileSync('docs/EDITIONS.md', 'utf8');
    for (const id of Object.keys(FEATURES)) {
      const row = md.split('\n').find((l) => l.startsWith('|') && l.includes('`' + id + '`'));
      expect(row, id).toBeTruthy();
      const f = FEATURES[id as FeatureId];
      const cells = row!.split('|').map((c) => c.trim());
      expect(cells[2], `${id}: MVP`).toBe(f.mvp ? 'да' : '—');
      expect(cells[3], `${id}: lab`).toBe(f.lab ? 'да' : '—');
      expect(cells[4], `${id}: пилот`).toBe(f.pilot ? 'да' : '—');
      expect(['да', 'нет']).toContain(cells[5]);
    }
  });
});

describe('редакции: параметры адреса', () => {
  it('mvp вырезает отладочные и экспериментальные параметры, остальное — как было (и ?debug без «=»)', () => {
    const r = filterSearch('?debug&anycard&grab=bitmap&flow=doze&dur=30&glb=models/x.glb&nocard&char=kind&fresh', 'mvp');
    expect(r.search).toBe('debug&char=kind&fresh');
    expect(r.removed).toEqual(['anycard', 'grab=bitmap', 'flow=doze', 'dur=30', 'glb=models/x.glb', 'nocard']);
  });
  it('mvp: ?grab=main (по-старому) остаётся', () => {
    expect(filterSearch('?grab=main', 'mvp').search).toBe('grab=main');
  });
  it('mvp со страницы /test (?from=test или referrer /test/): флоу и nocard остаются, новые игры — нет', () => {
    expect(filterSearch('?from=test&flow=riddle&nocard', 'mvp').search).toBe('from=test&flow=riddle&nocard');
    expect(filterSearch('?flow=echo', 'mvp', 'https://ar.vershov.com/test/').search).toBe('flow=echo');
    for (const g of NEW_GAMES) expect(filterSearch(`?from=test&flow=${g}`, 'mvp').search).toBe('from=test');
    expect(filterSearch('?from=test&anycard', 'mvp').search).toBe('from=test'); // anycard — только lab
  });
  it('пилот — как MVP: отладка только со страницы /test, новые игры — никогда; кровать — да', () => {
    expect(filterSearch('?debug&anycard&flow=doze&nocard&glb=x.glb', 'pilot').search).toBe('debug');
    expect(filterSearch('?from=test&flow=riddle&nocard=off', 'pilot').search).toBe('from=test&flow=riddle&nocard=off');
    for (const g of NEW_GAMES) expect(filterSearch(`?from=test&flow=${g}`, 'pilot').search).toBe('from=test');
    expect(filterSearch('?from=test&flow=home&zone=bedroom&bed=sleep', 'pilot').search).toBe('from=test&flow=home&zone=bedroom&bed=sleep');
    expect(fromTestPage('', 'https://ar.vershov.com/mvp/test/')).toBe(true);
  });
  it('lab оставляет всё', () => {
    const q = '?debug&anycard&grab=bitmap&flow=rps&nocard';
    expect(filterSearch(q, 'lab')).toEqual({ search: q.slice(1), removed: [], added: [] });
  });
  it('referrer: только страница /test (и /lab/test)', () => {
    expect(fromTestPage('', 'https://ar.vershov.com/test/')).toBe(true);
    expect(fromTestPage('', 'https://ar.vershov.com/lab/test/')).toBe(true);
    expect(fromTestPage('', 'https://ar.vershov.com/testing')).toBe(false);
    expect(fromTestPage('', '')).toBe(false);
  });
  it('выключатели: функция включена — адрес не меняется (awake в обеих редакциях)', () => {
    expect(filterSearch('?debug', 'mvp').added).toEqual([]);
    expect(filterSearch('', 'mvp').search).toBe('');
  });
  it('каждый параметр привязан к функции из таблицы', () => {
    for (const [k, r] of Object.entries(PARAMS)) expect(FEATURES[r.feature], k).toBeTruthy();
  });
});

describe('редакции: новые мини-игры', () => {
  const content = loadTestContent();
  it('mvp: диалогов, триггеров, игр и предложений emo/rps/simon нет; загадка и повторялка — есть', () => {
    const f = editionDialogs(dialogsFile, false);
    for (const g of NEW_GAMES) {
      expect(f.dialogs[g], g).toBeUndefined();
      expect(f.games?.[g], g).toBeUndefined();
      expect(f.dialogs.offer.nodes[g], g).toBeUndefined();
    }
    expect(Object.values(f.triggers).some((t) => (NEW_GAMES as readonly string[]).includes(t.split(':')[0]))).toBe(false);
    expect(f.triggers.riddle).toBe('riddle');
    expect(f.triggers.echo_start).toBe('echo');
    expect(f.dialogs.offer.nodes.riddle).toBeTruthy();
  });
  it.each(PERSONA_IDS)('%s: каталог mvp без новых игр, lab — с ними', (pid) => {
    const p = content.personas.get(pid)!;
    const ids = (on: boolean) => buildCatalog(p, catalogEnv(content.intents, editionDialogs(dialogsFile, on).triggers)).flatMap((s) => s.items.map((i) => i.id));
    for (const g of NEW_GAMES) expect(ids(false)).not.toContain(g);
    expect(ids(false)).toEqual(expect.arrayContaining(['riddle', 'echo']));
    for (const g of NEW_GAMES) expect(ids(true)).toContain(g);
  });
  it('lab: диалоги без изменений', () => {
    expect(editionDialogs(dialogsFile, true)).toBe(dialogsFile);
  });
});

describe('редакции: раздельное хранилище', () => {
  // свой класс на тест: namespaceStorage меняет прототип (в браузере — Storage.prototype, length — на нём же)
  const fake = () => class FakeStorage {
    m = new Map<string, string>();
    getItem(k: string) {
      return this.m.has(k) ? this.m.get(k)! : null;
    }
    setItem(k: string, v: string) {
      this.m.set(k, String(v));
    }
    removeItem(k: string) {
      this.m.delete(k);
    }
    key(i: number) {
      return [...this.m.keys()][i] ?? null;
    }
    clear() {
      this.m.clear();
    }
    get length() {
      return this.m.size;
    }
  };
  it('lab: ключи с префиксом, key()/length/clear — только свои; другой объект хранилища не трогаем', () => {
    const S = fake();
    const ls = new S(), other = new S();
    ls.m.set('sber-ar-cat:v1', '{"met":true}'); // память MVP
    ls.m.set('ar.device', 'mvp-id');
    namespaceStorage(S.prototype as any, ls, 'lab:');
    expect(ls.getItem('sber-ar-cat:v1')).toBeNull(); // lab не видит память MVP
    ls.setItem('sber-ar-cat:v1', '{"met":false}');
    ls.setItem('ar.device', 'lab-id');
    expect(ls.m.get('sber-ar-cat:v1')).toBe('{"met":true}'); // MVP не испорчен
    expect(ls.m.get('lab:sber-ar-cat:v1')).toBe('{"met":false}');
    expect(ls.length).toBe(2);
    expect([ls.key(0), ls.key(1)].sort()).toEqual(['ar.device', 'sber-ar-cat:v1']);
    expect(ls.key(2)).toBeNull();
    ls.removeItem('ar.device');
    expect(ls.m.get('ar.device')).toBe('mvp-id');
    ls.clear();
    expect([...ls.m.keys()].sort()).toEqual(['ar.device', 'sber-ar-cat:v1']);
    other.setItem('x', '1');
    expect(other.m.get('x')).toBe('1');
    expect(other.length).toBe(1);
  });
  it('без префикса (mvp) — хранилище как есть', () => {
    const S = fake();
    const ls = new S();
    namespaceStorage(S.prototype as any, ls, '');
    ls.setItem('a', '1');
    expect(ls.m.get('a')).toBe('1');
  });
  it('cookie id устройства: mvp — ar_device, lab — lab_ar_device, пилот — pilot_ar_device', () => {
    expect(cookieName('')).toBe('ar_device');
    expect(cookieName('lab:')).toBe('lab_ar_device');
    expect(cookieName('pilot:')).toBe('pilot_ar_device');
  });
});

describe('редакции: ?asr (аудит голоса 20.11)', () => {
  it('?asr=web вырезается в mvp и пилоте (и со страницы /test), в lab остаётся', () => {
    for (const ed of ['mvp', 'pilot'] as const) {
      expect(filterSearch('?asr=web&char=kind', ed).search, ed).toBe('char=kind');
      expect(filterSearch('?asr=web&from=test', ed).search, ed).toBe('from=test');
    }
    expect(filterSearch('?asr=web', 'lab').search).toBe('asr=web');
  });
});
