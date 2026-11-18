/**
 * Состояние клипов персонажа (общее для рига, GLB и спрайта): текущий клип тела + предыдущий для перехода
 * (blendInMs из каталога), additive-слой (уши, хвост) поверх любого клипа, idle по весам характера
 * со сменой каждые 4–9 с. Чистая логика без three.js — покрыта тестами.
 */
import { IdlePicker, clipDef, resolveClip, type ClipDef } from './clips';
import type { PlayOptions } from './types';

export interface Track { id: string; def: ClipDef; t: number; loop: boolean; onEnd?: () => void }

/**
 * Приоритет клипа тела (реакции не обрывают друг друга на полпути): 3 — «номер» (сальто, прыжок, танец, фирменное,
 * появление/уход), 2 — реакция на касание, 1 — разговорные позы, 0 — покой. Клип ниже приоритетом, позванный во время
 * защищённого окна «номера» (первые PROTECT доли длины, у петель — PROTECT_LOOP_S), не обрывает его, а ждёт в очереди
 * (одно место, последний выигрывает, устаревает через QUEUE_TTL_S). Лицо и эффекты новой реакции идут сразу (их ведёт
 * режиссёр) — ребёнок видит ответ без задержки, а тело доигрывает номер и переходит к следующему.
 */
export const SHOW_CLIP = /^(flip|jump|celebrate|dance_|tumble|appear_jump_in|dive_out|idle_hooligan_skate|idle_kind_cocoa|idle_glitter_mirror|gum_blow|kind_bubbles|glitter_throw|sticker_slap|wake_startle|run)/;
export const TALK_CLIP = /^(talk_|listen|echo_speak|point_button|think)/;
export function clipPriority(id: string): number {
  if (/^(idle|sit_idle|walk)/.test(id) && !SHOW_CLIP.test(id)) return 0;
  if (SHOW_CLIP.test(id)) return 3;
  if (TALK_CLIP.test(id)) return 1;
  return 2;
}
/**
 * Варианты покоя, которые сами по себе не играем (аудит реакций, docs/qa/REACTIONS.md): наушники — петля «надевает
 * снова» каждые 4,6 с (шов 0,57 рад), скейт — без скейта и с дрожью ног, кружение/обнимашки — заглушки 12 с и чужой
 * клип, игра с хвостом крутит корпус против поворота к зрителю. Фирменные действия остаются кнопками каталога.
 * Остальные варианты — реже: дыхание основное (вес ×2).
 */
export const IDLE_SKIP = /^(idle_hooligan_headphones|idle_hooligan_skate|idle_glitter_twirl|idle_kind_hug_self|idle_tail_play)$/;
export function calmIdles(idles: { clip: string; weight: number }[]) {
  const out = idles.filter((i) => !IDLE_SKIP.test(i.clip)).map((i) => (i.clip === 'idle_breathe' ? { ...i, weight: i.weight * 2 } : i));
  return out.length ? out : idles;
}
const PROTECT = 0.75;
const PROTECT_LOOP_S = 3;
const QUEUE_TTL_S = 2.5;
/** после реакции — спокойный покой (дыхание) столько секунд, потом варианты покоя по весам */
export const CALM_AFTER_S = [2.5, 4] as const;

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
  /** клип, ждущий конца защищённого окна текущего «номера» */
  queued: { name: string; opts: PlayOptions; at: number } | null = null;

  constructor(idles: { clip: string; weight: number }[] = [], private rnd: () => number = Math.random) {
    this.picker = new IdlePicker(calmIdles(idles), rnd);
    this.cur = this.track(clipDef('idle_breathe') ?? FALLBACK, true);
    this.idleLeft = this.picker.holdS();
  }

  setIdles(idles: { clip: string; weight: number }[], persona: string) {
    this.picker.idles = calmIdles(idles);
    this.persona = persona;
    if (this.idleMode) this.startIdle();
  }

  /** реальная длина клипов из модели (GLB): каталог даёт ориентир, а играть надо до конца движения */
  readonly realDuration = new Map<string, number>();

  private track(def: ClipDef, loop?: boolean, onEnd?: () => void): Track {
    const real = this.realDuration.get(def.id);
    if (real && def.layer !== 'additive') def = { ...def, durationS: real };
    return { id: def.id, def, t: 0, loop: loop ?? def.loop, onEnd };
  }

  /**
   * Играть клип. 'idle' — выбрать по весам. Additive-клипы (ear_twitch, tail_wag…) идут в отдельный слой.
   * Возвращает id каталога (или 'idle_breathe' для неизвестного).
   */
  play(name: string, opts: PlayOptions = {}): string {
    if (name === 'none') return this.cur.id;
    if (name === 'idle') {
      this.queued = null;
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
    if (!opts.force && this.protects(def.id)) {
      this.queued = { name, opts, at: this.time };
      return def.id;
    }
    this.queued = null;
    this.idleMode = false;
    this.requested = name;
    this.switchTo(this.track(def, opts.loop, opts.onEnd));
    return def.id;
  }

  /** текущий «номер» ещё в защищённом окне и новый клип ниже приоритетом */
  protects(next: string): boolean {
    if (this.idleMode) return false;
    const cur = this.cur;
    const pc = clipPriority(cur.id);
    if (pc < 3 || clipPriority(next) >= pc || next === cur.id) return false;
    return cur.loop ? cur.t < PROTECT_LOOP_S : cur.t < cur.def.durationS * PROTECT;
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

  private startIdle(onEnd?: () => void, calm = false) {
    // после реакции — сначала спокойное дыхание (а не вариант покоя с большим движением: наушники, скейт, потягивание)
    const id = calm && clipDef('idle_breathe') ? 'idle_breathe' : this.picker.next(this.cur.def.persona !== undefined && this.cur.id.startsWith('idle') ? this.cur.id : undefined);
    const def = clipDef(id) ?? FALLBACK;
    // петлю idle держим 4–9 с, одноразовый — до конца клипа
    if (this.cur.id !== def.id || !this.cur.id.startsWith('idle')) this.switchTo(this.track(def, def.loop, onEnd));
    this.idleLeft = calm ? CALM_AFTER_S[0] + this.rnd() * (CALM_AFTER_S[1] - CALM_AFTER_S[0]) : def.loop ? this.picker.holdS() : def.durationS;
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
      this.startIdle(undefined, true);
      cb?.();
    }
    // очередь: окно «номера» кончилось (или он сам кончился) — играет ждавший клип, если не устарел
    const q = this.queued;
    if (q && this.time - q.at > QUEUE_TTL_S) this.queued = null;
    else if (q && !this.protects(resolveClip(q.name, this.persona)?.id ?? q.name)) {
      this.queued = null;
      this.play(q.name, { ...q.opts, force: true });
    }
  }
}
