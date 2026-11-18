#!/usr/bin/env node
/**
 * Сервис прогресса AR-кота (без зависимостей, Node 20+; sqlite — Node 22.5+, иначе JSON-файлы).
 * Слушает 127.0.0.1:8787, наружу — через Caddy: handle /api/progress/* { reverse_proxy 127.0.0.1:8787 }.
 *
 *   GET    /api/progress/:device             → { device, code, version, updatedAt, resetAt, data, exists }
 *   PUT    /api/progress/:device             { data: { key: string | null } } → merge по ключам (null — удалить), version+1
 *                                            (+ edition?: "mvp" | "lab" — редакция клиента, docs/EDITIONS.md; хранится в документе)
 *   POST   /api/progress/:device             то же, что PUT (для navigator.sendBeacon)
 *   DELETE /api/progress/:device[?all=1]     сброс прогресса (all=1 — и историю сессий); остаётся отметка resetAt
 *   GET    /api/progress/:device/sessions    → { sessions: [{ id, startedAt, endedAt, cat, events }] }, новые сверху
 *   POST   /api/progress/:device/session     { type: 'start' | 'end', id, cat?, events?: string[] }
 *   GET    /api/progress/admin/code/:code    (Authorization: Bearer $PROGRESS_ADMIN_TOKEN) → устройства с этим кодом
 *   DELETE /api/progress/admin/code/:code    (тот же токен) → сброс всех устройств с этим кодом
 *   GET    /api/progress/health
 *
 * Окружение: PROGRESS_PORT (8787), PROGRESS_HOST (127.0.0.1), PROGRESS_DATA (/srv/ar-extra/progress),
 * PROGRESS_STORE (auto|sqlite|file), PROGRESS_TTL_DAYS (90), PROGRESS_ORIGINS (https://ar.vershov.com, через запятую),
 * PROGRESS_ADMIN_TOKEN (нет — админ-сброс выключен). Тела запросов и токены в лог не пишутся.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openStore, DEVICE_RE, deviceCode } from './store.mjs';

export const LIMITS = {
  dataBytes: 16 * 1024,
  bodyBytes: 20 * 1024,
  keys: 40,
  sessions: 30,
  eventsPerSession: 80,
  eventLen: 48,
};
const KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const SESSION_RE = /^[A-Za-z0-9-]{1,40}$/;
const CAT_RE = /^[a-z_]{1,24}$/;
const EDITION_RE = /^(mvp|lab)$/;
const CODE_RE = /^[0-9A-F]{6}$/;
const DAY = 86_400_000;

class HttpError extends Error {
  constructor(status, msg) {
    super(msg);
    this.status = status;
  }
}

/** окно фиксированной длины: не больше max событий за windowMs на ключ */
export class RateLimiter {
  constructor(max, windowMs, now = Date.now) {
    Object.assign(this, { max, windowMs, now, map: new Map() });
  }
  hit(key) {
    const t = this.now();
    let e = this.map.get(key);
    if (!e || t - e.start >= this.windowMs) this.map.set(key, (e = { start: t, n: 0 }));
    e.n++;
    if (this.map.size > 10_000) for (const [k, v] of this.map) if (t - v.start >= this.windowMs) this.map.delete(k);
    return e.n <= this.max;
  }
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const tokenOk = (given, expected) => !!expected && !!given && crypto.timingSafeEqual(sha(given), sha(expected));

/**
 * opts: { dataDir, store: 'auto'|'sqlite'|'file', ttlDays, origins: string[], adminToken, now, rate: { ip, writes, admin } }
 * → { server, store, handle(req, res), purge(), close() }
 */
export async function createProgressServer(opts = {}) {
  const now = opts.now ?? Date.now;
  const store = await openStore(opts.dataDir ?? '/srv/ar-extra/progress', opts.store ?? 'auto');
  const ttl = (opts.ttlDays ?? 90) * DAY;
  const origins = new Set(opts.origins ?? ['https://ar.vershov.com']);
  const adminToken = opts.adminToken || '';
  const rIp = new RateLimiter(opts.rate?.ip ?? 120, 60_000, now);
  const rWrite = new RateLimiter(opts.rate?.writes ?? 30, 60_000, now);
  const rAdmin = new RateLimiter(opts.rate?.admin ?? 10, 600_000, now);

  const empty = (device) => ({ device, version: 0, createdAt: now(), updatedAt: now(), resetAt: null, data: {}, sessions: [] });
  const load = (device) => {
    const d = store.get(device);
    if (d && now() - (d.updatedAt ?? 0) > ttl) {
      store.delete(device);
      return null;
    }
    return d;
  };
  const pub = (doc, device) => {
    const d = doc ?? empty(device);
    return { device: d.device, code: deviceCode(d.device), version: d.version, createdAt: d.createdAt, updatedAt: d.updatedAt, resetAt: d.resetAt ?? null, data: d.data ?? {}, exists: !!doc, edition: d.edition ?? null };
  };
  // редакция клиента (mvp | lab, src/config/edition.ts): последняя присланная; у lab и mvp разные id устройства
  const setEdition = (doc, b) => {
    if (b && typeof b.edition === 'string' && EDITION_RE.test(b.edition)) doc.edition = b.edition;
  };
  const touch = (doc) => {
    doc.version = (doc.version ?? 0) + 1;
    doc.updatedAt = Math.max(now(), (doc.updatedAt ?? 0) + 1);
    store.put(doc);
    return doc;
  };

  function merge(device, body) {
    const patch = body?.data;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new HttpError(400, 'data: object expected');
    const doc = load(device) ?? empty(device);
    // клиент писал, не зная о сбросе (продакт сбросил устройство во время игры) — не откатываем сброс
    if (body && 'resetAt' in body && doc.resetAt && body.resetAt !== doc.resetAt) throw Object.assign(new HttpError(409, 'reset'), { doc: pub(doc) });
    const data = { ...doc.data };
    for (const [k, v] of Object.entries(patch)) {
      if (!KEY_RE.test(k)) throw new HttpError(400, 'bad key');
      if (v === null) delete data[k];
      else if (typeof v === 'string') data[k] = v;
      else throw new HttpError(400, 'value: string or null');
    }
    if (Object.keys(data).length > LIMITS.keys) throw new HttpError(413, 'too many keys');
    if (Buffer.byteLength(JSON.stringify(data)) > LIMITS.dataBytes) throw new HttpError(413, 'progress > 16 KB');
    doc.data = data;
    setEdition(doc, body);
    return pub(touch(doc));
  }

  function reset(device, all) {
    const doc = load(device);
    if (!doc) return pub(touch({ ...empty(device), resetAt: now() }));
    doc.data = {};
    doc.resetAt = now();
    if (all) doc.sessions = [];
    return pub(touch(doc));
  }

  const clean = (s) => String(s).replace(/[\u0000-\u001f<>]/g, '').slice(0, LIMITS.eventLen);

  function session(device, b) {
    if (!b || (b.type !== 'start' && b.type !== 'end')) throw new HttpError(400, 'type: start | end');
    if (!SESSION_RE.test(b.id ?? '')) throw new HttpError(400, 'bad session id');
    const doc = load(device) ?? empty(device);
    const list = (doc.sessions ??= []);
    let s = list.find((x) => x.id === b.id);
    if (!s) {
      s = { id: b.id, startedAt: now(), endedAt: null, cat: null, events: [] };
      list.push(s);
      while (list.length > LIMITS.sessions) list.shift();
    }
    if (typeof b.cat === 'string' && CAT_RE.test(b.cat)) s.cat = b.cat;
    if (b.type === 'start') setEdition(doc, b);
    if (typeof b.edition === 'string' && EDITION_RE.test(b.edition)) s.edition = b.edition;
    if (Array.isArray(b.events)) {
      for (const e of b.events.slice(0, LIMITS.eventsPerSession)) if (typeof e === 'string' && e) s.events.push(clean(e));
      if (s.events.length > LIMITS.eventsPerSession) s.events.splice(0, s.events.length - LIMITS.eventsPerSession);
    }
    if (b.type === 'end') s.endedAt = now();
    // история не двигает версию прогресса (клиент сравнивает version с тем, что видел)
    doc.updatedAt = Math.max(now(), doc.updatedAt ?? 0);
    store.put(doc);
    return { ok: true, id: s.id };
  }

  function admin(req, code) {
    const ip = clientIp(req);
    if (!adminToken) throw new HttpError(503, 'admin disabled: PROGRESS_ADMIN_TOKEN not set');
    const auth = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!tokenOk(auth, adminToken)) {
      if (!rAdmin.hit(ip)) throw new HttpError(429, 'too many attempts');
      throw new HttpError(401, 'bad token');
    }
    if (!CODE_RE.test(code)) throw new HttpError(400, 'code: 6 hex chars');
    return store.list().filter((d) => deviceCode(d) === code);
  }

  function clientIp(req) {
    const remote = req.socket.remoteAddress ?? '';
    const loop = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    const xff = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    return loop && xff ? xff : remote;
  }

  async function readBody(req, max) {
    const chunks = [];
    let n = 0;
    for await (const c of req) {
      n += c.length;
      if (n > max) throw new HttpError(413, 'body too large');
      chunks.push(c);
    }
    if (!n) return null;
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HttpError(400, 'bad json');
    }
  }

  async function route(req, res) {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname.replace(/\/+$/, '');
    const m = req.method ?? 'GET';
    const origin = req.headers.origin;
    if (origin) {
      if (!origins.has(origin)) throw new HttpError(403, 'origin not allowed');
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (m === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Max-Age', '600');
      return [204, null];
    }
    if (!rIp.hit(clientIp(req))) throw new HttpError(429, 'rate limit');
    if (p === '/api/progress/health') return [200, { ok: true, store: store.kind }];

    let mm = p.match(/^\/api\/progress\/admin\/code\/([^/]+)$/);
    if (mm) {
      const code = mm[1].toUpperCase();
      const list = admin(req, code);
      if (m === 'GET') {
        return [200, { code, devices: list.map((d) => {
          const doc = store.get(d);
          return { code, edition: doc?.edition ?? null, updatedAt: doc?.updatedAt, version: doc?.version, resetAt: doc?.resetAt ?? null, keys: Object.keys(doc?.data ?? {}), sessions: doc?.sessions?.length ?? 0 };
        }) }];
      }
      if (m === 'DELETE') {
        for (const d of list) reset(d, url.searchParams.get('all') === '1');
        return [200, { code, reset: list.length }];
      }
      throw new HttpError(405, 'method');
    }

    mm = p.match(/^\/api\/progress\/([^/]+)(\/sessions?)?$/);
    if (!mm) throw new HttpError(404, 'not found');
    const device = mm[1].toLowerCase();
    if (!DEVICE_RE.test(device)) throw new HttpError(400, 'device: uuid v4');
    const sub = mm[2];
    const write = m !== 'GET';
    if (write && !rWrite.hit(device)) throw new HttpError(429, 'rate limit');

    if (!sub) {
      if (m === 'GET') return [200, pub(load(device), device)];
      if (m === 'PUT' || m === 'POST') return [200, merge(device, await readBody(req, LIMITS.bodyBytes))];
      if (m === 'DELETE') return [200, reset(device, url.searchParams.get('all') === '1')];
    } else if (sub === '/sessions' && m === 'GET') {
      const doc = load(device);
      return [200, { device, sessions: [...(doc?.sessions ?? [])].reverse() }];
    } else if (sub === '/session' && m === 'POST') {
      return [200, session(device, await readBody(req, 4096))];
    }
    throw new HttpError(405, 'method');
  }

  async function handle(req, res) {
    let status = 500, body = { error: 'internal' };
    try {
      [status, body] = await route(req, res);
    } catch (e) {
      if (e instanceof HttpError) [status, body] = [e.status, { error: e.message, ...(e.doc ?? {}) }];
      else console.error('[progress]', e?.message ?? e);
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (body == null) {
      res.writeHead(status).end();
      return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
  }

  const purge = () => store.purge(now() - ttl);
  purge();
  const timer = setInterval(purge, 6 * 3600_000);
  timer.unref();
  const server = http.createServer((req, res) => void handle(req, res));
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  return {
    server, store, handle, purge,
    close: () => new Promise((r) => { clearInterval(timer); server.close(() => { store.close(); r(); }); }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const env = process.env;
  const p = await createProgressServer({
    dataDir: env.PROGRESS_DATA || '/srv/ar-extra/progress',
    store: env.PROGRESS_STORE || 'auto',
    ttlDays: Number(env.PROGRESS_TTL_DAYS) || 90,
    origins: (env.PROGRESS_ORIGINS || 'https://ar.vershov.com').split(',').map((s) => s.trim()).filter(Boolean),
    adminToken: env.PROGRESS_ADMIN_TOKEN || '',
  });
  const port = Number(env.PROGRESS_PORT) || 8787, host = env.PROGRESS_HOST || '127.0.0.1';
  p.server.listen(port, host, () => console.log(`[progress] ${host}:${port}, store=${p.store.kind}, admin=${env.PROGRESS_ADMIN_TOKEN ? 'on' : 'off'}`));
  const stop = () => void p.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
