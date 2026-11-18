/**
 * Хранилище прогресса по устройствам. Документ устройства:
 *   { device, version, createdAt, updatedAt, resetAt, data: { [ключ localStorage]: строка }, sessions: [...] }
 * Два бэкенда с одинаковым интерфейсом (get/put/delete/list/purge):
 *   sqlite — node:sqlite (Node 22.5+), одна таблица с JSON-документом;
 *   file   — один JSON-файл на устройство, атомарная запись (tmp + fsync + rename).
 * Все операции синхронные: процесс один, гонок нет.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEVICE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** короткий код устройства — первые 6 hex-символов UUID, заглавными (так же считает клиент: src/progress/device.ts) */
export const deviceCode = (device) => device.replace(/-/g, '').slice(0, 6).toUpperCase();

class FileStore {
  constructor(dir) {
    this.kind = 'file';
    this.dir = path.join(dir, 'devices');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o750 });
  }
  file(device) {
    return path.join(this.dir, device + '.json');
  }
  get(device) {
    try {
      return JSON.parse(fs.readFileSync(this.file(device), 'utf8'));
    } catch {
      return null;
    }
  }
  put(doc) {
    const f = this.file(doc.device);
    const tmp = `${f}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o640);
    try {
      fs.writeSync(fd, JSON.stringify(doc));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, f);
  }
  delete(device) {
    fs.rmSync(this.file(device), { force: true });
  }
  list() {
    return fs
      .readdirSync(this.dir)
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -5))
      .filter((d) => DEVICE_RE.test(d));
  }
  purge(before) {
    let n = 0;
    for (const d of this.list()) {
      const doc = this.get(d);
      if (!doc || (doc.updatedAt ?? 0) < before) {
        this.delete(d);
        n++;
      }
    }
    // недописанные tmp от упавшего процесса
    for (const t of fs.readdirSync(this.dir).filter((x) => x.endsWith('.tmp'))) fs.rmSync(path.join(this.dir, t), { force: true });
    return n;
  }
  close() {}
}

class SqliteStore {
  constructor(dir, DatabaseSync) {
    this.kind = 'sqlite';
    fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
    this.db = new DatabaseSync(path.join(dir, 'progress.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS docs (device TEXT PRIMARY KEY, doc TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS docs_updated ON docs(updated_at);`);
    this.qGet = this.db.prepare('SELECT doc FROM docs WHERE device = ?');
    this.qPut = this.db.prepare('INSERT INTO docs (device, doc, updated_at) VALUES (?, ?, ?) ON CONFLICT(device) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at');
    this.qDel = this.db.prepare('DELETE FROM docs WHERE device = ?');
    this.qList = this.db.prepare('SELECT device FROM docs');
    this.qPurge = this.db.prepare('DELETE FROM docs WHERE updated_at < ?');
  }
  get(device) {
    const r = this.qGet.get(device);
    return r ? JSON.parse(r.doc) : null;
  }
  put(doc) {
    this.qPut.run(doc.device, JSON.stringify(doc), doc.updatedAt);
  }
  delete(device) {
    this.qDel.run(device);
  }
  list() {
    return this.qList.all().map((r) => r.device);
  }
  purge(before) {
    return Number(this.qPurge.run(before).changes ?? 0);
  }
  close() {
    this.db.close();
  }
}

/** kind: 'sqlite' | 'file' | 'auto' (sqlite, если node:sqlite есть, иначе файлы) */
export async function openStore(dir, kind = 'auto') {
  if (kind === 'file') return new FileStore(dir);
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return new SqliteStore(dir, DatabaseSync);
  } catch (e) {
    if (kind === 'sqlite') throw e;
    return new FileStore(dir);
  }
}
