// сервис прогресса (server/progress/server.mjs): оба хранилища, merge, лимиты, сброс, сессии, CORS, админ, TTL
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createProgressServer, RateLimiter, type ProgressServer } from '../../server/progress/server.mjs';

const DEV = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ORIGIN = 'https://ar.vershov.com';
const TOKEN = 'test-admin-token';

for (const kind of ['file', 'sqlite'] as const) {
  describe(`progress server (${kind})`, () => {
    let dir: string, p: ProgressServer, base: string, clock: number;
    const req = (m: string, url: string, body?: unknown, h: Record<string, string> = {}) =>
      fetch(base + url, { method: m, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...h } });

    beforeEach(async () => {
      dir = mkdtempSync(path.join(tmpdir(), 'progress-'));
      clock = 1_800_000_000_000;
      p = await createProgressServer({ dataDir: dir, store: kind, adminToken: TOKEN, origins: [ORIGIN], now: () => clock, rate: { ip: 1000, writes: 1000 } });
      await new Promise<void>((r) => p.server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${(p.server.address() as AddressInfo).port}`;
    });
    afterEach(async () => {
      await p.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('хранилище нужного типа', () => expect(p.store.kind).toBe(kind));

    it('GET неизвестного устройства — пустой документ', async () => {
      const r = await req('GET', `/api/progress/${DEV}`);
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ device: DEV, code: '0F8FAD', version: 0, data: {}, exists: false, resetAt: null });
    });

    it('PUT — merge по ключам, null удаляет, версия растёт; POST (sendBeacon) — то же', async () => {
      let j = await (await req('PUT', `/api/progress/${DEV}`, { data: { 'sber-ar-cat:v1': '{"met":true}', 'ar.catalog.tried': '["a"]' } })).json();
      expect(j.version).toBe(1);
      j = await (await req('POST', `/api/progress/${DEV}`, { data: { 'ar.catalog.tried': null, 'ar.micMode': 'ptt' } })).json();
      expect(j.version).toBe(2);
      expect(j.data).toEqual({ 'sber-ar-cat:v1': '{"met":true}', 'ar.micMode': 'ptt' });
      j = await (await req('GET', `/api/progress/${DEV}`)).json();
      expect(j).toMatchObject({ exists: true, version: 2 });
    });

    it('валидация: id, ключи, значения, JSON, размер 16 КБ', async () => {
      expect((await req('GET', '/api/progress/not-a-uuid')).status).toBe(400);
      expect((await req('PUT', `/api/progress/${DEV}`, { data: { 'bad key!': 'x' } })).status).toBe(400);
      expect((await req('PUT', `/api/progress/${DEV}`, { data: { k: 5 } })).status).toBe(400);
      expect((await req('PUT', `/api/progress/${DEV}`, '{oops')).status).toBe(400);
      expect((await req('PUT', `/api/progress/${DEV}`, { data: { k: 'x'.repeat(17_000) } })).status).toBe(413);
      // по частям: каждый запрос маленький, но сумма > 16 КБ
      for (let i = 0; i < 4; i++) await req('PUT', `/api/progress/${DEV}`, { data: { ['k' + i]: 'x'.repeat(3900) } });
      expect((await req('PUT', `/api/progress/${DEV}`, { data: { k9: 'x'.repeat(3900) } })).status).toBe(413);
    });

    it('DELETE — сброс: данные пусты, resetAt; запись с устаревшим resetAt → 409', async () => {
      await req('PUT', `/api/progress/${DEV}`, { data: { a: '1' }, resetAt: null });
      await req('POST', `/api/progress/${DEV}/session`, { type: 'start', id: 's1', cat: 'kind' });
      clock += 1000;
      const d = await (await req('DELETE', `/api/progress/${DEV}`)).json();
      expect(d).toMatchObject({ data: {}, resetAt: clock });
      const c = await req('PUT', `/api/progress/${DEV}`, { data: { a: '2' }, resetAt: null });
      expect(c.status).toBe(409);
      expect((await c.json()).resetAt).toBe(clock);
      expect((await req('PUT', `/api/progress/${DEV}`, { data: { a: '3' }, resetAt: clock })).status).toBe(200);
      // история сессий после обычного сброса остаётся, после ?all=1 — нет
      expect((await (await req('GET', `/api/progress/${DEV}/sessions`)).json()).sessions).toHaveLength(1);
      await req('DELETE', `/api/progress/${DEV}?all=1`);
      expect((await (await req('GET', `/api/progress/${DEV}/sessions`)).json()).sessions).toHaveLength(0);
    });

    it('сессии: старт/конец, кот, события (обрезаны), новые сверху, версия прогресса не двигается', async () => {
      await req('POST', `/api/progress/${DEV}/session`, { type: 'start', id: 's1', cat: 'hooligan' });
      clock += 60_000;
      await req('POST', `/api/progress/${DEV}/session`, { type: 'end', id: 's1', events: ['phase:play', '<b>' + 'x'.repeat(100)] });
      await req('POST', `/api/progress/${DEV}/session`, { type: 'end', id: 's2', events: ['phase:outro'] }); // конец без старта (beacon)
      const j = await (await req('GET', `/api/progress/${DEV}/sessions`)).json();
      expect(j.sessions.map((s: any) => s.id)).toEqual(['s2', 's1']);
      const s1 = j.sessions[1];
      expect(s1).toMatchObject({ cat: 'hooligan', endedAt: clock });
      expect(s1.endedAt - s1.startedAt).toBe(60_000);
      expect(s1.events[1]).not.toContain('<');
      expect(s1.events[1].length).toBeLessThanOrEqual(48);
      expect((await req('POST', `/api/progress/${DEV}/session`, { type: 'x', id: 's' })).status).toBe(400);
      expect((await (await req('GET', `/api/progress/${DEV}`)).json()).version).toBe(0);
      for (let i = 0; i < 40; i++) await req('POST', `/api/progress/${DEV}/session`, { type: 'start', id: 'n' + i });
      expect((await (await req('GET', `/api/progress/${DEV}/sessions`)).json()).sessions).toHaveLength(30);
    });

    it('CORS: свой домен — да, чужой — 403, preflight', async () => {
      const ok = await req('GET', `/api/progress/${DEV}`, undefined, { Origin: ORIGIN });
      expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
      expect((await req('PUT', `/api/progress/${DEV}`, { data: {} }, { Origin: 'https://evil.example' })).status).toBe(403);
      const pre = await req('OPTIONS', `/api/progress/${DEV}`, undefined, { Origin: ORIGIN });
      expect(pre.status).toBe(204);
      expect(pre.headers.get('access-control-allow-methods')).toContain('PUT');
    });

    it('админ: без токена 401, по коду — список и сброс', async () => {
      await req('PUT', `/api/progress/${DEV}`, { data: { a: '1' } });
      expect((await req('GET', '/api/progress/admin/code/0F8FAD')).status).toBe(401);
      expect((await req('GET', '/api/progress/admin/code/0F8FAD', undefined, { Authorization: 'Bearer nope' })).status).toBe(401);
      const auth = { Authorization: 'Bearer ' + TOKEN };
      const l = await (await req('GET', '/api/progress/admin/code/0f8fad', undefined, auth)).json();
      expect(l.devices).toHaveLength(1);
      expect(l.devices[0].keys).toEqual(['a']);
      expect(JSON.stringify(l)).not.toContain(DEV); // полный id не показываем
      expect(await (await req('DELETE', '/api/progress/admin/code/0F8FAD', undefined, auth)).json()).toEqual({ code: '0F8FAD', reset: 1 });
      expect((await (await req('GET', `/api/progress/${DEV}`)).json()).data).toEqual({});
      expect((await req('GET', '/api/progress/admin/code/ZZZ', undefined, auth)).status).toBe(400);
    });

    it('TTL: старые документы удаляются', async () => {
      await req('PUT', `/api/progress/${DEV}`, { data: { a: '1' } });
      clock += 91 * 86_400_000;
      expect((await (await req('GET', `/api/progress/${DEV}`)).json()).exists).toBe(false);
      await req('PUT', `/api/progress/${DEV}`, { data: { a: '1' } });
      clock += 91 * 86_400_000;
      expect(p.purge()).toBe(1);
      expect(p.store.list()).toEqual([]);
    });

    it('данные переживают перезапуск', async () => {
      await req('PUT', `/api/progress/${DEV}`, { data: { a: '1' } });
      await p.close();
      p = await createProgressServer({ dataDir: dir, store: kind, origins: [ORIGIN], now: () => clock });
      await new Promise<void>((r) => p.server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${(p.server.address() as AddressInfo).port}`;
      expect((await (await req('GET', `/api/progress/${DEV}`)).json()).data).toEqual({ a: '1' });
    });
  });
}

describe('rate limit', () => {
  it('окно: max запросов, потом отказ, новое окно — снова можно', () => {
    let t = 0;
    const r = new RateLimiter(3, 1000, () => t);
    expect([r.hit('a'), r.hit('a'), r.hit('a'), r.hit('a'), r.hit('b')]).toEqual([true, true, true, false, true]);
    t = 1000;
    expect(r.hit('a')).toBe(true);
  });

  it('сервер отвечает 429', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'progress-'));
    const p = await createProgressServer({ dataDir: dir, store: 'file', rate: { ip: 1000, writes: 2 } });
    await new Promise<void>((r) => p.server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(p.server.address() as AddressInfo).port}/api/progress/${DEV}`;
    const put = () => fetch(url, { method: 'PUT', body: '{"data":{}}' }).then((r) => r.status);
    expect([await put(), await put(), await put()]).toEqual([200, 200, 429]);
    await p.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
