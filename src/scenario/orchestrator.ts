/**
 * Оркестратор действий кота: одно активное действие, понятная очередь и отмена, блок повторных нажатий
 * (запись с iPhone 20.11: реплики и номера накладывались, «Чуть позже!» по кругу, смена кота посреди номера,
 * кнопки срабатывали поверх идущего клипа).
 *
 * Правила (request):
 *  • то же действие, пока оно идёт, или нажатое снова быстрее REPEAT_MS после старта/конца — «повтор», не выполняется;
 *  • идёт сцена снаружи режиссёра (раскраска, переход в дом/из дома, пробуждение, смена кота, сон в кровати) —
 *    действие ждёт в очереди; сцену, которую можно прервать (раскраска, сон), оркестратор просит закончить (interrupt);
 *  • идёт «номер» (show: сальто, танец, скейт, какао, зеркальце…) и он ещё не дошёл до minMs — новое действие ждёт
 *    в очереди (одно место, последнее нажатие выигрывает, устаревает через QUEUE_TTL_MS);
 *  • ласка и команды-фразы (care, say), «номер» после minMs — вытесняются новым действием сразу (cancel).
 * Действие кончается, когда тело в покое и реплик этого действия больше нет (tick), не раньше minMs и не позже maxMs.
 * Реплики помечаются токеном действия (owner): у вытесненного действия они снимаются — реплика всегда «своя».
 *
 * Плюс LineDedupe — одинаковая реплика (пузырь) не чаще раза в DEDUPE_MS («Чуть позже! Давай ещё…» шла 4 раза подряд).
 * Чистая логика без DOM и three.js — tests/orchestrator.test.ts.
 */

export type ActClass = 'care' | 'say' | 'show' | 'game' | 'scene';
export interface ActSpec {
  cls: ActClass;
  /** не вытесняется раньше (мс от старта) */
  minMs: number;
  /** считается законченным не позже (мс от старта), даже если тело/речь ещё заняты */
  maxMs: number;
}

/** повторное нажатие той же кнопки быстрее — игнор */
export const REPEAT_MS = 700;
/** ожидающее действие устаревает */
export const QUEUE_TTL_MS = 6000;
/** одинаковый текст пузыря — не чаще */
export const DEDUPE_MS = 8000;

const SHOW = (minMs: number, maxMs = 12_000): ActSpec => ({ cls: 'show', minMs, maxMs });
const CARE: ActSpec = { cls: 'care', minMs: 0, maxMs: 6000 };
const SAY: ActSpec = { cls: 'say', minMs: 0, maxMs: 8000 };
const GAME: ActSpec = { cls: 'game', minMs: 0, maxMs: 60_000 };

/** классы действий панели/каталога (id — scenario/actions.ts) и сцен снаружи */
export const ACT_SPEC: Record<string, ActSpec> = {
  pet: CARE, scratch: CARE, tickle: CARE, cheek: CARE, paw: CARE, hug: CARE, treat: SHOW(2600, 8000),
  flip: SHOW(1600), dance: SHOW(2500, 10_000), trick: SHOW(1200), jump: SHOW(900), sit: SAY, wave: SAY, sing: SHOW(1500),
  skate: SHOW(6000, 11_000), cocoa: SHOW(4200, 9000), mirror: SHOW(3600, 9000), bubbles: SHOW(1800), sticker: SHOW(900),
  draw: SHOW(800), glass: SHOW(1500), knock: CARE, surprise: CARE, tease: CARE, laugh: SAY, shy: SAY, dizzy: SHOW(1200),
  sleep: CARE,
  riddle: GAME, echo: GAME, emo: GAME, rps: GAME, simon: GAME, other: GAME,
  switch: { cls: 'scene', minMs: 0, maxMs: 30_000 },
};
export function actSpec(id: string): ActSpec {
  return ACT_SPEC[id] ?? SAY;
}

export type Verdict = 'start' | 'queued' | 'repeat';
export interface Act {
  id: string;
  token: number;
  spec: ActSpec;
  at: number;
}
/** сцена снаружи режиссёра: id и можно ли её мягко закончить ради нового действия */
export interface ExternalScene {
  id: string;
  interruptible: boolean;
}

export class Orchestrator {
  current: Act | null = null;
  pending: { id: string; at: number } | null = null;
  private seq = 0;
  private lastStart: { id: string; at: number } | null = null;
  private lastEnd: { id: string; at: number } | null = null;
  /** сцена снаружи (app.ts): раскраска, дом, пробуждение, кровать; null — нет */
  external: (() => ExternalScene | null) | null = null;
  /** попросить сцену закончиться (раскраска — finishNow, сон — разбудить); true — попросили */
  interrupt: ((scene: ExternalScene) => boolean) | null = null;
  /** журнал решений (для лога режиссёра) */
  onLog: ((s: string) => void) | null = null;
  /** вытеснили действие (его реплики снять) */
  onCancel: ((a: Act) => void) | null = null;

  constructor(private now: () => number) {}

  /** токен текущего действия (0 — нет) */
  get token(): number {
    return this.current?.token ?? 0;
  }

  /** занято ли: идёт действие, не дошедшее до minMs, или сцена снаружи */
  blocking(): string | null {
    const ext = this.external?.();
    if (ext) return ext.id;
    const c = this.current;
    if (c && c.spec.cls !== 'care' && c.spec.cls !== 'say' && this.now() - c.at < c.spec.minMs) return c.id;
    return null;
  }

  request(id: string): { verdict: Verdict; token: number } {
    const t = this.now();
    const c = this.current;
    if (c && c.id === id && t - c.at < Math.max(c.spec.minMs, REPEAT_MS)) return this.say('repeat', `«${id}» уже идёт`);
    if (this.lastStart?.id === id && t - this.lastStart.at < REPEAT_MS) return this.say('repeat', `«${id}» нажато повторно`);
    if (this.lastEnd?.id === id && t - this.lastEnd.at < REPEAT_MS && !c) return this.say('repeat', `«${id}» только что кончилось`);
    const ext = this.external?.();
    if (ext) {
      if (this.pending?.id === id) return this.say('repeat', `«${id}» уже ждёт (${ext.id})`);
      this.pending = { id, at: t };
      if (ext.interruptible && this.interrupt?.(ext)) this.onLog?.(`⏸ ${ext.id}: заканчиваем ради «${id}»`);
      return this.say('queued', `«${id}» ждёт конца сцены ${ext.id}`);
    }
    if (c) {
      const soft = c.spec.cls === 'care' || c.spec.cls === 'say' || t - c.at >= c.spec.minMs;
      if (!soft) {
        if (this.pending?.id === id) return this.say('repeat', `«${id}» уже ждёт`);
        this.pending = { id, at: t };
        return this.say('queued', `«${id}» ждёт конца «${c.id}»`);
      }
      this.end(c, 'вытеснено');
      this.onCancel?.(c);
    }
    return { verdict: 'start', token: this.begin(id, t) };
  }

  private say(v: Verdict, msg: string): { verdict: Verdict; token: number } {
    this.onLog?.(`🎬 ${msg}`);
    return { verdict: v, token: 0 };
  }

  private begin(id: string, t: number): number {
    const tok = ++this.seq;
    this.current = { id, token: tok, spec: actSpec(id), at: t };
    this.lastStart = { id, at: t };
    if (this.pending?.id === id) this.pending = null;
    return tok;
  }

  private end(a: Act, why: string) {
    if (this.current?.token !== a.token) return;
    this.current = null;
    this.lastEnd = { id: a.id, at: this.now() };
    this.onLog?.(`🎬 «${a.id}» — конец (${why}, ${Math.round(this.now() - a.at)} мс)`);
  }

  /** действие закончено явно (сцена сообщила) */
  done(token: number) {
    if (this.current?.token === token) this.end(this.current, 'готово');
  }

  /** сбросить всё (смена кота, уход) */
  reset() {
    this.current = null;
    this.pending = null;
  }

  /**
   * Каждый кадр: busy — тело/речь ещё заняты текущим действием. Возвращает id ожидавшего действия, которое пора
   * запустить (режиссёр вызовет action(id) ещё раз), или null.
   */
  tick(busy: boolean): string | null {
    const t = this.now();
    const c = this.current;
    if (c) {
      const age = t - c.at;
      if (age >= c.spec.maxMs) this.end(c, 'по времени');
      else if (!busy && age >= c.spec.minMs) this.end(c, 'тело в покое');
    }
    const p = this.pending;
    if (!p) return null;
    if (t - p.at > QUEUE_TTL_MS) {
      this.pending = null;
      this.onLog?.(`🎬 «${p.id}» устарело в очереди`);
      return null;
    }
    if (this.external?.()) return null;
    const cur = this.current;
    if (cur && cur.spec.cls !== 'care' && cur.spec.cls !== 'say' && t - cur.at < cur.spec.minMs) return null;
    this.pending = null;
    return p.id;
  }
}

/** одинаковая реплика (текст пузыря) не чаще раза в DEDUPE_MS */
export class LineDedupe {
  private seen = new Map<string, number>();
  constructor(private now: () => number, private ms = DEDUPE_MS) {}
  allow(text: string): boolean {
    const k = text.trim().toLowerCase();
    if (!k) return true;
    const t = this.now();
    const last = this.seen.get(k);
    if (last !== undefined && t - last < this.ms) return false;
    this.seen.set(k, t);
    if (this.seen.size > 64) for (const [kk, v] of this.seen) if (t - v > this.ms) this.seen.delete(kk);
    return true;
  }
  forget(text: string) {
    this.seen.delete(text.trim().toLowerCase());
  }
}
