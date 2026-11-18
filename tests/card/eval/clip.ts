/**
 * Записи для `npm run card:eval`: видео (ffmpeg, кадры потоком — 165 с записи не держим в памяти) + сайдкары.
 *
 * Рядом с видео `name.mp4` могут лежать:
 *  - `name.json` — сайдкар записи `?rec` (src/tracker/cardRecorder.ts): время кадров, гироскоп, фокус, задержка камеры;
 *  - `name.gt.json` — разметка углов карты: `{ "size": [w, h], "frames": { "12": [[x,y],[x,y],[x,y],[x,y]], … } }`
 *    (px исходного видео, TL TR BR BL; между размеченными кадрами — линейно, если разрыв ≤ 15 кадров);
 *  - `name.meta.json` или общий `eval.json` в папке (`{ "clips": { "name": {…} }, "default": {…} }`) — настройки клипа:
 *    `crop` (доли кадра x, y, w, h — область камеры на записи экрана), `negative`, `from`/`to` (с), `hfov` (°) или
 *    `focal` (px кадра детектора), `mask` (доли кадра [{x,y,w,h,from?,to?}] — закрасить, напр. кота старой версии),
 *    `enterAt` (с), `note`.
 * Имя `neg_*` — негатив (карты Сбера в кадре нет).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { focalFromFov } from '../../../src/tracker/card/detector';
import type { Quad } from '../../../src/tracker/card/geometry';
import type { EvalClip, FrameReader } from './replay';

export interface ClipMeta {
  crop?: { x: number; y: number; w: number; h: number };
  negative?: boolean;
  from?: number;
  to?: number;
  hfov?: number;
  focal?: number;
  mask?: { x: number; y: number; w: number; h: number; from?: number; to?: number }[];
  enterAt?: number;
  note?: string;
}

export interface RecSidecar {
  v: number;
  kind: 'card-rec';
  /** размер записанного кадра, px */
  w: number;
  h: number;
  /** performance.now() начала записи (медиа-время 0), мс */
  t0: number;
  /** performance.now() каждого записанного кадра, мс */
  frames?: number[];
  /** [t (performance.now, мс), x, y, z, w] — ориентация камеры в мире (OrientationHold) */
  gyro?: number[][];
  /** фокус / длинная сторона кадра (как ar.focal.v1) */
  fNorm?: number;
  camLatMs?: number;
  ua?: string;
}

const VIDEO = new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v']);

/** файлы видео из путей (папки — рекурсивно, кроме скрытых) */
export function listVideos(paths: string[]): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const e of readdirSync(p).sort()) if (!e.startsWith('.') && !e.startsWith('_')) walk(join(p, e));
    } else if (VIDEO.has(extname(p).toLowerCase())) out.push(p);
  };
  for (const p of paths) walk(p);
  return out;
}

const readJson = <T>(f: string): T | null => (existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as T) : null);

export function metaFor(file: string): ClipMeta {
  const base = basename(file, extname(file));
  const dir = readJson<{ clips?: Record<string, ClipMeta>; default?: ClipMeta }>(join(dirname(file), 'eval.json'));
  const own = readJson<ClipMeta>(join(dirname(file), base + '.meta.json'));
  const m: ClipMeta = { ...(dir?.default ?? {}), ...(dir?.clips?.[base] ?? {}), ...(own ?? {}) };
  if (m.negative === undefined && /^neg[_-]/i.test(base)) m.negative = true;
  return m;
}

function probe(file: string): { w: number; h: number; fps: number; dur: number; rot: number } {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,avg_frame_rate:stream_side_data=rotation:format=duration', '-of', 'json', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffprobe ${file}: ${r.stderr}`);
  const j = JSON.parse(r.stdout);
  const s = j.streams[0];
  const fr = (x: string) => {
    const [a, b] = String(x ?? '0/1').split('/').map(Number);
    return b ? a / b : a;
  };
  const rot = Math.abs(Number(s.side_data_list?.[0]?.rotation ?? 0)) % 180;
  const w = rot === 90 ? s.height : s.width, h = rot === 90 ? s.width : s.height;
  return { w, h, fps: fr(s.avg_frame_rate) || fr(s.r_frame_rate) || 30, dur: Number(j.format?.duration ?? 0), rot };
}

/** кадры потоком из ffmpeg: rawvideo RGBA фиксированного размера */
class FfmpegReader implements FrameReader {
  private p: ChildProcess;
  private chunks: Buffer[] = [];
  private have = 0;
  private ended = false;
  private wake: (() => void) | null = null;
  private idx = -1;
  constructor(args: string[], private size: number, private post?: (i: number, f: Uint8ClampedArray) => void) {
    this.p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    this.p.stdout!.on('data', (c: Buffer) => {
      this.chunks.push(c);
      this.have += c.length;
      // поток быстрее разбора — притормозим (не держим в памяти минуты видео)
      if (this.have > this.size * 8) this.p.stdout!.pause();
      this.wake?.();
    });
    this.p.on('close', () => {
      this.ended = true;
      this.wake?.();
    });
  }
  private async next(): Promise<Uint8ClampedArray | null> {
    while (this.have < this.size && !this.ended) {
      this.p.stdout!.resume();
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
    if (this.have < this.size) return null;
    const buf = Buffer.concat(this.chunks);
    const frame = new Uint8ClampedArray(buf.buffer.slice(buf.byteOffset, buf.byteOffset + this.size));
    const rest = buf.subarray(this.size);
    this.chunks = rest.length ? [Buffer.from(rest)] : [];
    this.have = rest.length;
    if (this.have < this.size * 4) this.p.stdout!.resume();
    return frame;
  }
  async get(i: number): Promise<Uint8ClampedArray | null> {
    let f: Uint8ClampedArray | null = null;
    while (this.idx < i) {
      f = await this.next();
      this.idx++;
      if (!f) return null;
    }
    if (f) this.post?.(i, f);
    return f;
  }
  close() {
    this.p.kill('SIGKILL');
  }
}

/** клип записи: кадр детектора — длинная сторона 320 после обрезки, источник — ×2 (как камера 960 → 320 + фрагмент) */
export function loadClip(file: string, over: ClipMeta = {}): EvalClip & { meta: ClipMeta; file: string } {
  const meta = { ...metaFor(file), ...over };
  const pr = probe(file);
  const base = basename(file, extname(file));
  const side = readJson<RecSidecar>(join(dirname(file), base + '.json'));
  const c = meta.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const cw = Math.round(pr.w * c.w), ch = Math.round(pr.h * c.h), cx = Math.round(pr.w * c.x), cy = Math.round(pr.h * c.y);
  const k = 320 / Math.max(cw, ch);
  const w = Math.round((cw * k) / 2) * 2, h = Math.round((ch * k) / 2) * 2;
  const hiK = Math.max(cw, ch) >= 600 ? 2 : 1;
  const W = w * hiK, H = h * hiK;
  const fps = 30;
  const from = meta.from ?? 0;
  const to = Math.min(meta.to ?? Infinity, pr.dur || Infinity);
  const n = Math.max(1, Math.floor(((Number.isFinite(to) ? to : pr.dur) - from) * fps));
  const vf = `crop=${cw}:${ch}:${cx}:${cy},fps=${fps},scale=${W}:${H}:flags=area`;
  const args = ['-v', 'error', '-ss', String(from), ...(Number.isFinite(to) ? ['-t', String(to - from)] : []), '-i', file, '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'];
  const masks = meta.mask ?? [];
  const post = masks.length
    ? (i: number, f: Uint8ClampedArray) => {
        const t = from + i / fps;
        for (const m of masks) if ((m.from ?? -1) <= t && t <= (m.to ?? 1e9)) fillRect(f, W, H, m);
      }
    : undefined;
  // фокус: сайдкар записи (калибровка телефона) → meta → угол обзора по умолчанию
  const focal = meta.focal ?? (side?.fNorm ? side.fNorm * Math.max(w, h) : focalFromFov(w, h, meta.hfov));
  // гироскоп: время записи → секунды клипа
  let gyro: EvalClip['gyro'];
  if (side?.gyro?.length) {
    gyro = side.gyro.map((g) => ({ t: (g[0] - side.t0) / 1000 - from, q: [g[1], g[2], g[3], g[4]] as [number, number, number, number] })).filter((g) => g.t > -1);
  }
  // разметка → px кадра детектора
  let gt: EvalClip['gt'];
  const ann = readJson<{ size?: [number, number]; frames: Record<string, number[][]> }>(join(dirname(file), base + '.gt.json'));
  if (ann) {
    const [aw, ah] = ann.size ?? [pr.w, pr.h];
    const keys = Object.keys(ann.frames).map(Number).sort((a, b) => a - b);
    const conv = (q: number[][]): Quad => q.map(([x, y]) => ({ x: ((x * pr.w) / aw - cx) * k - 0.5, y: ((y * pr.h) / ah - cy) * k - 0.5 })) as Quad;
    const srcFps = pr.fps;
    gt = (i) => {
      const fi = (from + i / fps) * srcFps; // номер кадра исходного видео
      let lo = -1, hi = -1;
      for (const kk of keys) {
        if (kk <= fi) lo = kk;
        if (kk >= fi) {
          hi = kk;
          break;
        }
      }
      if (lo < 0 || hi < 0 || hi - lo > 15) return null;
      const a = conv(ann.frames[lo]), b = conv(ann.frames[hi]);
      const u = hi === lo ? 0 : (fi - lo) / (hi - lo);
      return a.map((p, j) => ({ x: p.x + (b[j].x - p.x) * u, y: p.y + (b[j].y - p.y) * u })) as Quad;
    };
  }
  return {
    name: base,
    file,
    meta,
    w,
    h,
    hiK,
    n,
    frameTime: (i) => i / fps,
    frames: () => new FfmpegReader(args, W * H * 4, post),
    focal,
    verify: true,
    negative: !!meta.negative,
    gt,
    gyro,
    enterAt: meta.enterAt !== undefined ? meta.enterAt - from : undefined,
  };
}

function fillRect(f: Uint8ClampedArray, W: number, H: number, m: { x: number; y: number; w: number; h: number }) {
  const x0 = Math.max(0, Math.floor(m.x * W)), y0 = Math.max(0, Math.floor(m.y * H));
  const x1 = Math.min(W, Math.ceil((m.x + m.w) * W)), y1 = Math.min(H, Math.ceil((m.y + m.h) * H));
  // ровный средний цвет области: детектор не видит в ней ни краёв, ни текстуры
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y1; y += 2)
    for (let x = x0; x < x1; x += 2) {
      const i = (y * W + x) * 4;
      r += f[i];
      g += f[i + 1];
      b += f[i + 2];
      n++;
    }
  if (!n) return;
  r /= n;
  g /= n;
  b /= n;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      f[i] = r;
      f[i + 1] = g;
      f[i + 2] = b;
    }
}
