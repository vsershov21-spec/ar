/**
 * Синхронизация прогресса с сервером (server/progress). localStorage остаётся главным источником во время игры:
 * модули (scenario/memory.ts, каталог действий, калибровка…) пишут туда как раньше, ничего о сервере не зная.
 * Этот модуль раз в pollMs сравнивает «синхронизируемые» ключи с тем, что уже на сервере, и отправляет разницу
 * (debounce; при уходе со страницы — sendBeacon). При старте — один GET с таймаутом 1,5 с: если localStorage
 * очистили (cookie с id устройства осталась) — восстанавливаем; если продакт сбросил устройство — чистим локально.
 * Сеть недоступна / ошибка — работаем только с localStorage, запуск ничего не ждёт дольше таймаута.
 *
 * Конфликты: устройство одно, поэтому по ключам «кто менялся после последней синхронизации, тот и прав»;
 * сервер выигрывает, только если локально ключ не менялся с прошлой синхронизации (или localStorage пустой).
 */
export interface SyncStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
  key(i: number): string | null;
  readonly length: number;
}

export interface ServerDoc {
  device: string;
  code?: string;
  version: number;
  updatedAt?: number;
  resetAt: number | null;
  data: Record<string, string>;
  exists?: boolean;
}

export interface SyncOptions {
  device: string;
  storage: SyncStorage;
  fetch?: typeof fetch;
  beacon?: (url: string, body: string) => boolean;
  endpoint?: string;
  /** false — имя ребёнка (поле name в sber-ar-cat:v1) на сервер не отправляется */
  sendName?: boolean;
  /** редакция (mvp | lab, src/config/edition.ts): уходит на сервер полем edition в записи прогресса и в начале сессии */
  edition?: string;
  timeoutMs?: number;
  pollMs?: number;
  debounceMs?: number;
  maxWaitMs?: number;
  log?: (s: string) => void;
}

export type SyncState = 'idle' | 'loading' | 'synced' | 'offline' | 'reset' | 'paused' | 'error';
export const META_KEY = 'ar.progress.meta';
const MEMORY_KEY = 'sber-ar-cat:v1';
/** ключи прогресса: память кота и всё с префиксом sber-ar-cat:, что пробовал ребёнок, режим микрофона, калибровка камеры */
const EXTRA_KEYS = new Set(['ar.catalog.tried', 'ar.micMode', 'ar.focal.v1']);
export const isProgressKey = (k: string) => k.startsWith('sber-ar-cat:') || EXTRA_KEYS.has(k);

interface Meta {
  /** версия документа на сервере, которую видели последней */
  v: number;
  /** resetAt сервера, который уже применён локально */
  r: number | null;
  /** что лежит на сервере (после нашей последней успешной записи/чтения) */
  s: Record<string, string>;
  /** сброс нажат офлайн — повторить DELETE при следующем старте */
  pr?: boolean;
}

export class ProgressSync {
  state: SyncState = 'idle';
  lastSyncAt = 0;
  lastError = '';
  /** вызывается, если сервер сообщил о сбросе после того, как игра уже прочитала память */
  onRemoteReset: (() => void) | null = null;
  /** разрешается не позже timeoutMs после start() */
  ready: Promise<SyncState> = Promise.resolve('idle');

  private o: Required<Omit<SyncOptions, 'beacon' | 'log' | 'edition'>> & Pick<SyncOptions, 'beacon' | 'log' | 'edition'>;
  private loaded = false;
  private readyDone = false;
  private dirtySince = 0;
  private lastDiffSig = '';
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;
  private lastRetry = 0;
  private sessionId = '';
  private events: string[] = [];
  private stopped = false;

  constructor(opts: SyncOptions) {
    this.o = {
      fetch: opts.fetch ?? ((...a) => fetch(...a)),
      endpoint: '/api/progress',
      sendName: true,
      timeoutMs: 1500,
      pollMs: 2000,
      debounceMs: 2500,
      maxWaitMs: 15000,
      ...opts,
    } as ProgressSync['o'];
  }

  private ed() {
    return this.o.edition ? { edition: this.o.edition } : {};
  }

  get url() {
    return `${this.o.endpoint}/${this.o.device}`;
  }

  // ---------- старт ----------

  /** запускает первую загрузку; ready разрешится по ответу или по таймауту (что раньше) */
  start(): Promise<SyncState> {
    this.state = 'loading';
    const job = this.pull();
    this.ready = new Promise<SyncState>((res) => {
      const t = setTimeout(() => {
        this.readyDone = true;
        res(this.state);
      }, this.o.timeoutMs);
      void job.then(() => {
        clearTimeout(t);
        this.readyDone = true;
        res(this.state);
      });
    });
    return this.ready;
  }

  private async pull(): Promise<void> {
    try {
      let meta = this.readMeta();
      if (meta?.pr) {
        const r = await this.req('DELETE', undefined, this.o.timeoutMs);
        if (!r.ok) throw new Error('reset ' + r.status);
        const d = (await r.json()) as ServerDoc;
        meta = { v: d.version, r: d.resetAt, s: {} };
        this.writeMeta(meta);
      }
      const r = await this.req('GET', undefined, this.o.timeoutMs);
      if (!r.ok) throw new Error('GET ' + r.status);
      this.apply((await r.json()) as ServerDoc, meta);
    } catch (e) {
      this.state = 'offline';
      this.lastError = String((e as Error)?.message ?? e);
      this.o.log?.(`прогресс: сервер недоступен (${this.lastError}) — только localStorage`);
    }
  }

  private apply(doc: ServerDoc, meta: Meta | null) {
    const late = this.readyDone;
    const fresh = !meta;
    if (meta && doc.resetAt && doc.resetAt !== meta.r) {
      this.clearLocal();
      this.writeMeta({ v: doc.version, r: doc.resetAt, s: { ...doc.data } });
      this.loaded = true;
      this.state = 'reset';
      this.o.log?.('прогресс: устройство сброшено на сервере — локальная память очищена');
      if (late) this.remoteReset();
      return;
    }
    const local = this.snapshot();
    const st = this.o.storage;
    for (const [k, sv] of Object.entries(doc.data ?? {})) {
      if (!isProgressKey(k)) continue;
      const lv = local[k];
      const prev = meta?.s[k];
      const takeServer = lv === undefined ? fresh || prev !== sv : !fresh && lv === prev && lv !== sv;
      if (takeServer) {
        try {
          st.setItem(k, this.inbound(k, sv));
        } catch {
          /* переполнено / запрещено */
        }
      }
    }
    this.writeMeta({ v: doc.version, r: doc.resetAt ?? null, s: { ...(doc.data ?? {}) } });
    this.loaded = true;
    this.state = 'synced';
    this.lastSyncAt = Date.now();
    if (Object.keys(this.diff()).length) this.schedule(true);
  }

  // ---------- запись ----------

  /** разница «локально» → «на сервере»: { ключ: значение | null (удалить) } */
  diff(): Record<string, string | null> {
    const meta = this.readMeta();
    const s = meta?.s ?? {};
    const local = this.snapshot();
    const out: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(local)) if (s[k] !== v) out[k] = v;
    for (const k of Object.keys(s)) if (!(k in local) && isProgressKey(k)) out[k] = null;
    return out;
  }

  /** опрос localStorage: заметили изменение — отложенная запись */
  tick() {
    if (this.stopped || this.state === 'paused') return;
    if (!this.loaded) {
      // сервер был недоступен — пробуем снова не чаще раза в 30 с (без успешного GET не пишем: можно затереть прогресс)
      if (Date.now() - this.lastRetry > 30_000 && !this.inflight) {
        this.lastRetry = Date.now();
        this.inflight = this.pull().finally(() => (this.inflight = null));
      }
      return;
    }
    const d = this.diff();
    const sig = JSON.stringify(d);
    if (sig === '{}') {
      this.dirtySince = 0;
      this.lastDiffSig = '';
      return;
    }
    if (sig !== this.lastDiffSig) {
      this.lastDiffSig = sig;
      this.schedule(false);
    }
  }

  private schedule(now: boolean) {
    const t = Date.now();
    if (!this.dirtySince) this.dirtySince = t;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    const wait = now ? 0 : Math.max(0, Math.min(this.o.debounceMs, this.dirtySince + this.o.maxWaitMs - t));
    this.flushTimer = setTimeout(() => void this.flush(), wait);
  }

  async flush(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.loaded || this.state === 'paused') return;
    if (this.inflight) await this.inflight;
    const d = this.diff();
    if (!Object.keys(d).length) return;
    const meta = this.readMeta();
    this.inflight = (async () => {
      try {
        const r = await this.req('PUT', JSON.stringify({ data: d, resetAt: meta?.r ?? null, ...this.ed() }), 8000);
        if (r.status === 409) {
          const doc = (await r.json()) as ServerDoc;
          this.clearLocal();
          this.writeMeta({ v: doc.version, r: doc.resetAt, s: {} });
          this.remoteReset();
          return;
        }
        if (!r.ok) {
          this.state = r.status === 413 ? 'error' : 'offline';
          this.lastError = 'PUT ' + r.status;
          return;
        }
        const doc = (await r.json()) as ServerDoc;
        this.writeMeta({ v: doc.version, r: doc.resetAt ?? null, s: { ...doc.data } });
        this.state = 'synced';
        this.lastSyncAt = Date.now();
        this.dirtySince = 0;
        this.lastDiffSig = '';
      } catch (e) {
        this.state = 'offline';
        this.lastError = String((e as Error)?.message ?? e);
      }
    })().finally(() => (this.inflight = null));
    await this.inflight;
  }

  /** уход со страницы: последняя разница и конец сессии — sendBeacon (не ждём ответа) */
  flushBeacon() {
    if (this.loaded && this.state !== 'paused') {
      const d = this.diff();
      if (Object.keys(d).length) {
        const meta = this.readMeta()!;
        if (this.beacon(this.url, JSON.stringify({ data: d, resetAt: meta.r, ...this.ed() }))) {
          const s = { ...meta.s };
          for (const [k, v] of Object.entries(d)) if (v === null) delete s[k];
          else s[k] = v;
          this.writeMeta({ ...meta, s });
        }
      }
    }
    this.sessionEnd();
  }

  // ---------- сессии (история для продакта) ----------

  sessionStart(cat: string | null) {
    this.sessionId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    this.events = [];
    void this.req('POST', JSON.stringify({ type: 'start', id: this.sessionId, cat, ...this.ed() }), 5000, '/session').catch(() => {});
  }

  /** короткое событие сессии ('phase:play', 'cat:kind'); повтор подряд не пишем, не больше 80 */
  sessionEvent(e: string) {
    if (!this.sessionId || this.events[this.events.length - 1] === e || this.events.length >= 80) return;
    this.events.push(e.slice(0, 48));
  }

  private sessionEnd() {
    if (!this.sessionId) return;
    const body = JSON.stringify({ type: 'end', id: this.sessionId, events: this.events });
    if (this.beacon(this.url + '/session', body)) this.events = [];
  }

  // ---------- сброс ----------

  /** «Сбросить прогресс этого устройства»: локально — сразу, на сервере — DELETE (офлайн — при следующем старте) */
  async resetDevice(): Promise<'ok' | 'pending'> {
    this.clearLocal();
    const meta = this.readMeta();
    this.writeMeta({ v: meta?.v ?? 0, r: meta?.r ?? null, s: {}, pr: true });
    this.state = 'paused';
    try {
      const r = await this.req('DELETE', undefined, 5000);
      if (!r.ok) throw new Error('DELETE ' + r.status);
      const d = (await r.json()) as ServerDoc;
      this.writeMeta({ v: d.version, r: d.resetAt, s: {} });
      return 'ok';
    } catch {
      return 'pending';
    }
  }

  /** ?reset=1 при загрузке: локально — сразу (до того, как игра прочитает память), на сервере — в start() */
  markReset() {
    this.clearLocal();
    const meta = this.readMeta();
    this.writeMeta({ v: meta?.v ?? 0, r: meta?.r ?? null, s: {}, pr: true });
  }

  /** только локально: удалить ключи прогресса (id устройства остаётся) */
  clearLocal() {
    const st = this.o.storage;
    const keys: string[] = [];
    try {
      for (let i = 0; i < st.length; i++) {
        const k = st.key(i);
        if (k && isProgressKey(k)) keys.push(k);
      }
      for (const k of keys) st.removeItem(k);
    } catch {
      /* ignore */
    }
  }

  private remoteReset() {
    // игра уже прочитала память: до перезапуска ничего не пишем, иначе сброс частично откатится
    this.state = 'paused';
    this.onRemoteReset?.();
  }

  // ---------- жизненный цикл ----------

  /** опрос + pagehide/visibilitychange; возвращает отписку */
  attach(win: Pick<Window, 'addEventListener' | 'removeEventListener'> & { document?: Document } = window) {
    this.pollTimer = setInterval(() => this.tick(), this.o.pollMs);
    const hide = () => this.flushBeacon();
    const vis = () => {
      if (win.document?.visibilityState === 'hidden') this.flushBeacon();
    };
    win.addEventListener('pagehide', hide);
    win.addEventListener('visibilitychange', vis);
    return () => {
      this.stop();
      win.removeEventListener('pagehide', hide);
      win.removeEventListener('visibilitychange', vis);
    };
  }

  stop() {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
  }

  // ---------- внутреннее ----------

  private snapshot(): Record<string, string> {
    const st = this.o.storage;
    const out: Record<string, string> = {};
    try {
      for (let i = 0; i < st.length; i++) {
        const k = st.key(i);
        if (!k || !isProgressKey(k)) continue;
        const v = st.getItem(k);
        if (v != null) out[k] = this.outbound(k, v);
      }
    } catch {
      /* ignore */
    }
    return out;
  }

  /** что уходит на сервер: без имени ребёнка, если sendName=false */
  private outbound(k: string, v: string): string {
    if (this.o.sendName || k !== MEMORY_KEY) return v;
    try {
      const o = JSON.parse(v);
      if (o && typeof o === 'object' && 'name' in o) {
        delete o.name;
        return JSON.stringify(o);
      }
    } catch {
      /* не JSON — как есть */
    }
    return v;
  }

  /** что пишем локально с сервера: имя, которого на сервере нет, берём из локальной памяти */
  private inbound(k: string, sv: string): string {
    if (k !== MEMORY_KEY) return sv;
    try {
      const o = JSON.parse(sv);
      const lo = JSON.parse(this.o.storage.getItem(k) ?? 'null');
      if (o && typeof o === 'object' && !('name' in o) && lo?.name) o.name = lo.name;
      return JSON.stringify(o);
    } catch {
      return sv;
    }
  }

  private readMeta(): Meta | null {
    try {
      const m = JSON.parse(this.o.storage.getItem(META_KEY) ?? 'null');
      return m && typeof m === 'object' && m.s && typeof m.s === 'object' ? (m as Meta) : null;
    } catch {
      return null;
    }
  }

  private writeMeta(m: Meta) {
    try {
      this.o.storage.setItem(META_KEY, JSON.stringify(m));
    } catch {
      /* ignore */
    }
  }

  private beacon(url: string, body: string): boolean {
    try {
      if (this.o.beacon) return this.o.beacon(url, body);
      if (typeof navigator !== 'undefined' && navigator.sendBeacon) return navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
    } catch {
      /* ignore */
    }
    return false;
  }

  private async req(method: string, body: string | undefined, timeoutMs: number, sub = ''): Promise<Response> {
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = setTimeout(() => ac?.abort(), timeoutMs);
    try {
      return await this.o.fetch(this.url + sub, {
        method,
        body,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        signal: ac?.signal,
        keepalive: method !== 'GET' && (body?.length ?? 0) < 60_000,
        credentials: 'omit',
        cache: 'no-store',
      });
    } finally {
      clearTimeout(t);
    }
  }
}
