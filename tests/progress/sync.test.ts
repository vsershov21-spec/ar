// клиент синхронизации прогресса (src/progress/sync.ts) против настоящего сервиса (server/progress) + id устройства
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createProgressServer, type ProgressServer } from '../../server/progress/server.mjs';
import { ProgressSync, META_KEY, type SyncStorage } from '../../src/progress/sync';
import { getDeviceId, deviceCode, newUuid, isDeviceId, DEVICE_KEY } from '../../src/progress/device';

class MemStorage implements SyncStorage {
  m = new Map<string, string>();
  constructor(init: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(init)) this.m.set(k, v);
  }
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

const MEM = 'sber-ar-cat:v1';
let dir: string, p: ProgressServer, endpoint: string;
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'progress-sync-'));
  p = await createProgressServer({ dataDir: dir, store: 'file', rate: { ip: 10_000, writes: 10_000 } });
  await new Promise<void>((r) => p.server.listen(0, '127.0.0.1', r));
  endpoint = `http://127.0.0.1:${(p.server.address() as AddressInfo).port}/api/progress`;
});
afterAll(async () => {
  await p.close();
  rmSync(dir, { recursive: true, force: true });
});

const mk = (storage: SyncStorage, device: string, o: Partial<ConstructorParameters<typeof ProgressSync>[0]> = {}) =>
  new ProgressSync({ device, storage, endpoint, debounceMs: 10, maxWaitMs: 50, ...o });
const server = (device: string) => fetch(`${endpoint}/${device}`).then((r) => r.json());
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('ProgressSync', () => {
  it('первый запуск: локальная память уходит на сервер; очищенный localStorage восстанавливается', async () => {
    const dev = newUuid();
    const a = new MemStorage({ [MEM]: '{"name":"Маша","persona":"kind","met":true}', 'ar.catalog.tried': '["x"]', 'other.key': '1' });
    const s = mk(a, dev);
    expect(await s.start()).toBe('synced');
    await s.flush();
    const doc = await server(dev);
    expect(doc.data).toEqual({ [MEM]: a.getItem(MEM), 'ar.catalog.tried': '["x"]' }); // чужие ключи не уходят

    const b = new MemStorage(); // родитель очистил данные сайта, cookie с id осталась
    expect(await mk(b, dev).start()).toBe('synced');
    expect(b.getItem(MEM)).toBe(a.getItem(MEM));
    expect(b.getItem('ar.catalog.tried')).toBe('["x"]');
  });

  it('изменения — отложенная запись; удаление ключа — null на сервере', async () => {
    const dev = newUuid();
    const st = new MemStorage({ [MEM]: '{"met":true}' });
    const s = mk(st, dev);
    await s.start();
    await s.flush();
    st.setItem('ar.catalog.tried', '["a","b"]');
    st.removeItem(MEM);
    s.tick();
    await wait(40);
    await s.flush();
    expect((await server(dev)).data).toEqual({ 'ar.catalog.tried': '["a","b"]' });
    expect(Object.keys(s.diff())).toEqual([]);
  });

  it('флаг sendName=false: имя на сервер не уходит, при восстановлении не теряется', async () => {
    const dev = newUuid();
    const st = new MemStorage({ [MEM]: '{"name":"Петя","persona":"hooligan"}' });
    const s = mk(st, dev, { sendName: false });
    await s.start();
    await s.flush();
    expect(JSON.parse((await server(dev)).data[MEM])).toEqual({ persona: 'hooligan' });
    expect(s.diff()).toEqual({}); // имя локально есть, но разницей не считается
    expect(JSON.parse(st.getItem(MEM)!).name).toBe('Петя');
  });

  it('сброс на сервере → при следующем старте локальная память очищается, id устройства остаётся', async () => {
    const dev = newUuid();
    const st = new MemStorage({ [MEM]: '{"met":true}', [DEVICE_KEY]: dev });
    const s = mk(st, dev);
    await s.start();
    await s.flush();
    await fetch(`${endpoint}/${dev}`, { method: 'DELETE' });
    const s2 = mk(st, dev);
    expect(await s2.start()).toBe('reset');
    expect(st.getItem(MEM)).toBeNull();
    expect(st.getItem(DEVICE_KEY)).toBe(dev);
    // после сброса новая память пишется как обычно
    st.setItem(MEM, '{"persona":"kind"}');
    await s2.flush();
    expect((await server(dev)).data).toEqual({ [MEM]: '{"persona":"kind"}' });
  });

  it('сброс во время игры: запись получает 409 → память чистится, запись на паузе, onRemoteReset', async () => {
    const dev = newUuid();
    const st = new MemStorage({ [MEM]: '{"met":true}' });
    const s = mk(st, dev);
    const onReset = vi.fn();
    s.onRemoteReset = onReset;
    await s.start();
    await s.flush();
    await fetch(`${endpoint}/${dev}`, { method: 'DELETE' });
    st.setItem(MEM, '{"met":true,"visits":2}');
    await s.flush();
    expect(onReset).toHaveBeenCalledOnce();
    expect(s.state).toBe('paused');
    expect(st.getItem(MEM)).toBeNull();
    expect((await server(dev)).data).toEqual({});
  });

  it('?reset=1 / кнопка: локально сразу, на сервере — DELETE (офлайн — при следующем старте)', async () => {
    const dev = newUuid();
    const st = new MemStorage({ [MEM]: '{"met":true}' });
    const s = mk(st, dev);
    await s.start();
    await s.flush();

    const off = mk(st, dev, { fetch: (() => Promise.reject(new Error('offline'))) as any });
    expect(await off.resetDevice()).toBe('pending');
    expect(st.getItem(MEM)).toBeNull();
    expect(JSON.parse(st.getItem(META_KEY)!).pr).toBe(true);

    const s2 = mk(st, dev);
    expect(await s2.start()).toBe('synced');
    expect((await server(dev)).data).toEqual({});
    expect((await server(dev)).resetAt).toBeTruthy();
    expect(JSON.parse(st.getItem(META_KEY)!).pr).toBeUndefined();

    st.setItem(MEM, '{"met":true}');
    await s2.flush();
    const s3 = mk(st, dev);
    s3.markReset();
    expect(st.getItem(MEM)).toBeNull();
    await s3.start();
    expect((await server(dev)).data).toEqual({});
  });

  it('сервер молчит: ready не позже таймаута, состояние offline, без успешного GET ничего не пишем', async () => {
    const dev = newUuid();
    const hang = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_, rej) => init.signal?.addEventListener('abort', () => rej(new Error('abort')))));
    const st = new MemStorage({ [MEM]: '{"met":true}' });
    const s = mk(st, dev, { fetch: hang as any, timeoutMs: 80 });
    const t0 = Date.now();
    await s.start();
    expect(Date.now() - t0).toBeLessThan(400);
    await wait(30);
    expect(s.state).toBe('offline');
    await s.flush();
    expect(hang).toHaveBeenCalledTimes(1);
    expect(st.getItem(MEM)).toBe('{"met":true}'); // localStorage как был
  });

  it('уход со страницы: sendBeacon с разницей и концом сессии', async () => {
    const dev = newUuid();
    const st = new MemStorage();
    const sent: [string, string][] = [];
    const s = mk(st, dev, { beacon: (u, b) => (sent.push([u, b]), true) });
    await s.start();
    s.sessionStart('glitter');
    s.sessionEvent('phase:play');
    s.sessionEvent('phase:play');
    s.sessionEvent('cat:kind');
    st.setItem(MEM, '{"persona":"kind"}');
    s.flushBeacon();
    expect(sent[0][0]).toBe(`${endpoint}/${dev}`);
    expect(JSON.parse(sent[0][1]).data).toEqual({ [MEM]: '{"persona":"kind"}' });
    expect(sent[1][0]).toBe(`${endpoint}/${dev}/session`);
    expect(JSON.parse(sent[1][1])).toMatchObject({ type: 'end', events: ['phase:play', 'cat:kind'] });
    expect(s.diff()).toEqual({});
  });
});

describe('id устройства', () => {
  it('UUID v4, код — 6 символов, восстанавливается из cookie', () => {
    const st = new MemStorage();
    const jar = { cookie: '' };
    const id = getDeviceId(st, jar);
    expect(isDeviceId(id)).toBe(true);
    expect(deviceCode(id)).toMatch(/^[0-9A-F]{6}$/);
    expect(jar.cookie).toContain('ar_device=' + id);
    expect(getDeviceId(st, jar)).toBe(id);
    expect(getDeviceId(new MemStorage(), { cookie: 'x=1; ar_device=' + id })).toBe(id);
    expect(getDeviceId(new MemStorage(), { cookie: '' })).not.toBe(id);
    expect(isDeviceId(newUuid((b) => b.fill(7)))).toBe(true);
  });
});
