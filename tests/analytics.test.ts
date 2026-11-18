// воронка пилота (src/analytics, server/progress POST /event + GET /stats, docs/ANALYTICS.md): без персональных данных
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Analytics, EVENTS, PROPS, sanitize, ENDPOINT } from '../src/analytics';
import { createProgressServer, FUNNEL, cleanProps, type ProgressServer } from '../server/progress/server.mjs';

const DEV = '0f8fad5b-d9cb-469f-a165-70867728950e';
const DEV2 = '1f8fad5b-d9cb-469f-a165-70867728950e';
const TOKEN = 'test-admin-token';
const PII = { name: 'Маша', text: 'меня зовут Маша', card: '2202 2000 1234 5678', pan: '2202200012345678', holder: 'MARIA IVANOVA', email: 'a@b.c' };

describe('аналитика: клиент', () => {
  it('список событий клиента и сервера совпадает', () => {
    expect([...EVENTS]).toEqual(FUNNEL);
  });
  it('неизвестное событие — не уходит', () => {
    expect(sanitize('typed_name', { name: 'Маша' })).toBeNull();
  });
  it.each([...EVENTS])('%s: свойства — только из белого списка, без имён, текста и данных карты', (name) => {
    const ok: Record<string, unknown> = {};
    for (const [k, kind] of Object.entries(PROPS[name] ?? {})) ok[k] = kind === 'num' ? 123.6 : 'riddle';
    const r = sanitize(name, { ...ok, ...PII, id: 'Маша', reason: 'меня зовут Маша', kind: '2202 2000 1234 5678' })!;
    // id / reason / kind подменены «грязными» значениями — выброшены; остальные из белого списка — на месте
    expect(Object.keys(r.props).sort()).toEqual(Object.keys(PROPS[name] ?? {}).filter((k) => !['id', 'reason', 'kind'].includes(k)).sort());
    const s = JSON.stringify(r);
    for (const v of Object.values(PII)) expect(s).not.toContain(v);
    expect(s).not.toMatch(/[а-яё]/i);
  });
  it('числа — целые 0…10⁷, строки — короткие латинские id', () => {
    expect(sanitize('card_landed', { ms: 1234.4 })!.props).toEqual({ ms: 1234 });
    expect(sanitize('card_landed', { ms: -5 })!.props).toEqual({ ms: 0 });
    expect(sanitize('card_landed', { ms: Infinity })!.props).toEqual({});
    expect(sanitize('action', { id: 'pet' })!.props).toEqual({ id: 'pet' });
    expect(sanitize('action', { id: 'x'.repeat(40) })!.props).toEqual({});
    expect(sanitize('home_enter', { reason: 'lost' })!.props).toEqual({ reason: 'lost' });
  });
  it('тело: device, edition, name, props, ts — и больше ничего; once — один раз; лимит на сессию', () => {
    const sent: { url: string; body: string }[] = [];
    const a = new Analytics({ device: DEV, edition: 'pilot', send: (url, body) => (sent.push({ url, body }), true), now: () => 1000, max: 3 });
    a.track('named', { name: 'Маша' }, true);
    a.track('named', {}, true);
    a.track('action', { id: 'pet', text: 'погладить' });
    a.track('card_lost', { count: 2 });
    a.track('card_lost', { count: 3 }); // сверх max
    expect(sent).toHaveLength(3);
    expect(sent.every((x) => x.url === ENDPOINT)).toBe(true);
    const b = sent.map((x) => JSON.parse(x.body));
    for (const e of b) expect(Object.keys(e).sort()).toEqual(['device', 'edition', 'name', 'props', 'ts']);
    expect(b[0]).toEqual({ device: DEV, edition: 'pilot', name: 'named', props: {}, ts: 1000 });
    expect(b[1].props).toEqual({ id: 'pet' });
    expect(sent.map((x) => x.body).join()).not.toMatch(/Маша|погладить/);
  });
});

for (const kind of ['file', 'sqlite'] as const) {
  describe(`аналитика: сервер (${kind})`, () => {
    let dir: string, p: ProgressServer, base: string, clock: number;
    const post = (body: unknown, h: Record<string, string> = {}) => fetch(base + '/api/progress/event', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'Content-Type': 'text/plain', ...h } });
    beforeEach(async () => {
      dir = mkdtempSync(path.join(tmpdir(), 'analytics-'));
      clock = Date.UTC(2026, 10, 18, 12);
      p = await createProgressServer({ dataDir: dir, store: kind, adminToken: TOKEN, origins: ['https://ar.vershov.com'], now: () => clock, rate: { ip: 1000, writes: 1000, events: 5 } });
      await new Promise<void>((r) => p.server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${(p.server.address() as AddressInfo).port}`;
    });
    afterEach(async () => {
      await p.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('событие пишется (204), лишние поля и персональные данные выбрасываются', async () => {
      const r = await post({ ...PII, device: DEV, edition: 'pilot', name: 'action', props: { id: 'pet', ...PII } });
      expect(r.status).toBe(204);
      const rows = p.store.eventRows(0);
      expect(rows).toEqual([{ ts: clock, device: DEV, edition: 'pilot', name: 'action', props: { id: 'pet' } }]);
      const raw = kind === 'file' ? readFileSync(path.join(dir, 'events.jsonl'), 'utf8') : JSON.stringify(rows);
      for (const v of Object.values(PII)) expect(raw).not.toContain(v);
      expect(cleanProps('named', { name: 'Маша' })).toEqual({});
    });
    it('неизвестное событие, редакция, устройство, большое тело — 400/413', async () => {
      expect((await post({ device: DEV, edition: 'pilot', name: 'name_typed' })).status).toBe(400);
      expect((await post({ device: DEV, edition: 'evil', name: 'open' })).status).toBe(400);
      expect((await post({ device: 'x', edition: 'pilot', name: 'open' })).status).toBe(400);
      expect((await post('{bad')).status).toBe(400);
      expect((await post({ device: DEV, edition: 'pilot', name: 'open', pad: 'x'.repeat(2000) })).status).toBe(413);
      expect(p.store.eventRows(0)).toEqual([]);
    });
    it('лимит на устройство в минуту — 429, другое устройство — дальше', async () => {
      for (let i = 0; i < 5; i++) expect((await post({ device: DEV, edition: 'pilot', name: 'open' })).status).toBe(204);
      expect((await post({ device: DEV, edition: 'pilot', name: 'open' })).status).toBe(429);
      expect((await post({ device: DEV2, edition: 'lab', name: 'open' })).status).toBe(204);
      clock += 61_000;
      expect((await post({ device: DEV, edition: 'pilot', name: 'open' })).status).toBe(204);
    });
    it('stats: 401 без токена и с неверным, с токеном — воронка по дням и редакциям', async () => {
      expect((await fetch(base + '/api/progress/stats')).status).toBe(401);
      expect((await fetch(base + '/api/progress/stats?token=nope')).status).toBe(401);
      await post({ device: DEV, edition: 'pilot', name: 'open' });
      await post({ device: DEV, edition: 'pilot', name: 'open' });
      await post({ device: DEV2, edition: 'pilot', name: 'open' });
      await post({ device: DEV2, edition: 'pilot', name: 'card_landed', props: { ms: 2400 } });
      await post({ device: DEV, edition: 'lab', name: 'open' });
      clock += 86_400_000 + 3_600_000;
      await post({ device: DEV, edition: 'pilot', name: 'session_end', props: { sec: 300 } });
      const j = await (await fetch(base + `/api/progress/stats?token=${TOKEN}`)).json();
      expect(j.funnel).toEqual(FUNNEL);
      expect(j.rows.map((r: { day: string; edition: string }) => `${r.day} ${r.edition}`)).toEqual(['2026-11-19 pilot', '2026-11-18 lab', '2026-11-18 pilot']);
      expect(j.rows[2].events).toEqual({ open: { n: 3, devices: 2 }, card_landed: { n: 1, devices: 1 } });
      const h = await (await fetch(base + '/api/progress/stats?days=1', { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
      expect(h.rows.map((r: { day: string }) => r.day)).toEqual(['2026-11-19']);
    });
    it('health сообщает о событиях; TTL чистит и события', async () => {
      expect((await (await fetch(base + '/api/progress/health')).json()).events).toBe(true);
      await post({ device: DEV, edition: 'pilot', name: 'open' });
      clock += 91 * 86_400_000;
      p.purge();
      expect(p.store.eventRows(0)).toEqual([]);
      if (kind === 'file') expect(existsSync(path.join(dir, 'events.jsonl'))).toBe(true);
    });
  });
}
