/**
 * Состояние клипов персонажа (общее для рига, GLB и спрайта): текущий клип тела + предыдущий для перехода
 * (blendInMs из каталога), additive-слой (уши, хвост) поверх любого клипа, idle по весам характера
 * со сменой каждые 4–9 с. Чистая логика без three.js — покрыта тестами.
 */
import { IdlePicker, clipDef, resolveClip, type ClipDef } from './clips';
import type { PlayOptions } from './types';

export interface Track { id: string; def: ClipDef; t: number; loop: boolean; onEnd?: () => void }

const FALLBACK: ClipDef = { id: 'idle_breathe', durationS: 4, loop: true, rootMotion: false, layer: 'body', blendInMs: 300, persona: 'all', priority: 'P0', usedBy: [], notes: '' };

export class ClipState {
  cur: Track;
  prev: Track | null = null;
  /** вес текущего клипа 0..1 (переход от prev) */
  blend = 1;
  private blendDur = 0.3;
  additive: Track[] = [];
  /** сейчас «свободное» поведение (idle по весам) */
  idleMode = true;
  private idleLeft = 0;
  readonly picker: IdlePicker;
  persona = 'hooligan';
  /** имя, с которым позвали play() ('idle', 'talk', 'walk', id каталога) — для совместимости с director */
  requested = 'idle';
  private nextTwitch = 3;
  private time = 0;

  constructor(idles: { clip: string; weight: number }[] = [], private rnd: () => number = Math.random) {
    this.picker = new IdlePicker(idles, rnd);
    this.cur = this.track(clipDef('idle_breathe') ?? FALLBACK, true);
    this.idleLeft = this.picker.holdS();
  }

  setIdles(idles: { clip: string; weight: number }[], persona: string) {
    this.picker.idles = idles;
    this.persona = persona;
    if (this.idleMode) this.startIdle();
  }

  private track(def: ClipDef, loop?: boolean, onEnd?: () => void): Track {
    return { id: def.id, def, t: 0, loop: loop ?? def.loop, onEnd };
  }

  /**
   * Играть клип. 'idle' — выбрать по весам. Additive-клипы (ear_twitch, tail_wag…) идут в отдельный слой.
   * Возвращает id каталога (или 'idle_breathe' для неизвестного).
   */
  play(name: string, opts: PlayOptions = {}): string {
    if (name === 'none') return this.cur.id;
    if (name === 'idle') {
      this.requested = 'idle';
      this.idleMode = true;
      this.startIdle(opts.onEnd);
      return this.cur.id;
    }
    const def = resolveClip(name, this.persona);
    if (!def) {
      this.requested = 'idle';
      this.idleMode = true;
      this.startIdle();
      opts.onEnd?.();
      return this.cur.id;
    }
    if (def.layer === 'additive') {
      this.additive = this.additive.filter((a) => a.id !== def.id);
      this.additive.push(this.track(def, opts.loop, opts.onEnd));
      return def.id;
    }
    this.idleMode = false;
    this.requested = name;
    this.switchTo(this.track(def, opts.loop, opts.onEnd));
    return def.id;
  }

  /** остановить additive-петлю (tail_wag) */
  stopAdditive(id: string) {
    this.additive = this.additive.filter((a) => a.id !== id);
  }

  private switchTo(t: Track) {
    this.prev = this.cur;
    this.cur = t;
    this.blendDur = Math.max(0.0001, t.def.blendInMs / 1000);
    this.blend = t.def.blendInMs > 0 ? 0 : 1;
  }

  private startIdle(onEnd?: () => void) {
    const id = this.picker.next(this.cur.def.persona !== undefined && this.cur.id.startsWith('idle') ? this.cur.id : undefined);
    const def = clipDef(id) ?? FALLBACK;
    // петлю idle держим 4–9 с, одноразовый — до конца клипа
    if (this.cur.id !== def.id || !this.cur.id.startsWith('idle')) this.switchTo(this.track(def, def.loop, onEnd));
    this.idleLeft = def.loop ? this.picker.holdS() : def.durationS;
  }

  /** нормированное время 0..1 (для петель — фаза) */
  static k(tr: Track) {
    const d = tr.def.durationS || 1;
    return tr.loop ? (tr.t / d) % 1 : Math.min(1, tr.t / d);
  }

  update(dt: number) {
    this.time += dt;
    this.cur.t += dt;
    if (this.prev) this.prev.t += dt;
    this.blend = Math.min(1, this.blend + dt / this.blendDur);
    if (this.blend >= 1) this.prev = null;
    for (const a of this.additive) a.t += dt;
    const ended = this.additive.filter((a) => !a.loop && a.t >= a.def.durationS);
    if (ended.length) {
      this.additive = this.additive.filter((a) => !ended.includes(a));
      ended.forEach((a) => a.onEnd?.());
    }
    if (this.idleMode) {
      // случайное подёргивание уха в покое
      if (this.time >= this.nextTwitch) {
        this.nextTwitch = this.time + 3 + this.rnd() * 5;
        if (clipDef('ear_twitch')) this.play('ear_twitch');
      }
      this.idleLeft -= dt;
      if (this.idleLeft <= 0) this.startIdle();
    } else if (!this.cur.loop && this.cur.t >= this.cur.def.durationS) {
      const cb = this.cur.onEnd;
      this.requested = 'idle';
      this.idleMode = true;
      this.startIdle();
      cb?.();
    }
  }
}
