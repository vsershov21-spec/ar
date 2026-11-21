/**
 * Кровать кота в спальне «Мира кота» (как у «говорящего Тома»): чистая логика без DOM и three.js — автомат сна,
 * касания во сне, время суток, голосовые фразы. Исполнение (свет, путь кота, одеяло, клипы, Zzz, реплики) —
 * src/home/bedFlow.ts, модель кровати — src/home/bedProp.ts. Тесты — tests/bed.test.ts.
 *
 *   awake ──«Уложить спать» / «спать» / «баю-бай»──► tucking (подойти к кровати сбоку → залезть → лечь на бок →
 *         одеяло натягивается от изножья до плеч) ──► asleep
 *   asleep ── тап: бормочет / ворочается (не просыпается); 3 тапа за 1,6 с, «Разбудить», «просыпайся», шторка ──► waking
 *   waking — ровно наоборот: одеяло откидывается к изножью → потянуться и сесть на край → спрыгнуть на пол у кровати →
 *         отойти на своё место сбоку, лицом к зрителю ──► awake (реплика: доброе утро / «ну вот, разбудили»)
 *
 * Тишина ребёнка сну не мешает (кот не просыпается сам), уход в другую комнату и из дома — тоже.
 */

export type BedState = 'awake' | 'tucking' | 'asleep' | 'waking';

/** кровать в единицах комнаты (рост кота ≈ 1,1); модель — bedProp.ts */
export const BED = {
  length: 1.32,
  width: 0.95,
  /** верх матраса */
  top: 0.42,
  /** центр кровати от точки зоны (x) и по глубине (z): кровать правее центра, кот стоит слева от неё (zones.ts spot) */
  dx: 0.36,
  z: -0.78,
};
/** где кот стоит в зоне (= CAT_Z комнаты, room.ts; копия — чтобы логика не тянула three.js-модуль комнаты) */
export const STAND_Z = 0.2;

/** шаги перехода: id клипа каталога (content/animations.json) и длительность; путь корня считает bedFlow */
export interface BedStep {
  id: 'approach' | 'get_into_bed' | 'lie_down_side' | 'cover' | 'uncover' | 'wake_stretch_in_bed' | 'hop_out_of_bed' | 'walk_back';
  clip: string;
  ms: number;
}

/** уложить: подойти к длинному краю кровати и повернуться к ней → забраться → лечь на бок → одеяло от изножья до плеч */
export const TUCK_STEPS: readonly BedStep[] = [
  { id: 'approach', clip: 'walk_to_bedside', ms: 1200 },
  { id: 'get_into_bed', clip: 'get_into_bed', ms: 1300 },
  { id: 'lie_down_side', clip: 'lie_down_side', ms: 1200 },
  { id: 'cover', clip: 'sleep_loop_bed', ms: 900 },
];
/** разбудить — обратный порядок: одеяло к изножью → потянуться и сесть на край → спрыгнуть → отойти на место */
export const WAKE_STEPS: readonly BedStep[] = [
  // «Разбудить» отвечал через 0,8 с (бэклог): кот лежал неподвижно, пока сползало одеяло — теперь глаза открываются
  // сразу (bedFlow uncover: лицо sleepy), а потягивание начинается через 0,25 с, одеяло доезжает уже на нём
  { id: 'uncover', clip: 'sleep_loop_bed', ms: 250 },
  { id: 'wake_stretch_in_bed', clip: 'wake_stretch_in_bed', ms: 1700 },
  { id: 'hop_out_of_bed', clip: 'hop_out_of_bed', ms: 1000 },
  { id: 'walk_back', clip: 'walk', ms: 1000 },
];
/** кот проснулся по команде ребёнка (кнопка «Танцуй» посреди сна): тот же порядок, быстрее, без потягивания */
export const QUICK_WAKE_STEPS: readonly BedStep[] = [
  { id: 'uncover', clip: 'sleep_loop_bed', ms: 350 },
  { id: 'hop_out_of_bed', clip: 'hop_out_of_bed', ms: 800 },
  { id: 'walk_back', clip: 'walk', ms: 700 },
];

/** петля сна и «ворочается» во сне */
export const SLEEP_CLIP = 'sleep_loop_bed';
export const TURN_CLIP = 'turn_over_sleep';
export const TURN_MS = 1400;

/** тапы во сне: столько подряд за окно — просыпается */
export const WAKE_TAPS = 3;
export const TAP_WINDOW_MS = 1600;
/** бормочет не чаще (тапы между — только вздрагивает) */
export const MURMUR_GAP_MS = 2500;

export type WakeWhy = 'chip' | 'voice' | 'taps' | 'shade' | 'external' | 'flow';
export type TuckWhy = 'chip' | 'voice' | 'offer' | 'flow';
export type TapResult = 'none' | 'twitch' | 'murmur' | 'turn' | 'wake';

export interface BedProgress {
  state: BedState;
  step: BedStep | null;
  /** доля шага 0..1 */
  k: number;
  /** доля всего перехода 0..1 (tucking/waking), asleep — 1, awake — 0 */
  total: number;
}

/**
 * Автомат сна: время — снаружи (performance.now), поэтому тесты гоняют его без таймеров.
 * tick(now) возвращает смену шага/состояния (одна запись за вызов при обычном кадре).
 */
export class BedMachine {
  state: BedState = 'awake';
  private steps: readonly BedStep[] = [];
  private i = 0;
  private t0 = 0;
  private taps: number[] = [];
  private lastMurmur = -1e9;
  private tapN = 0;
  /** почему уложили / разбудили (реплики: goodnight vs tuck_in, wake_morning vs wake_forced) */
  tuckWhy: TuckWhy | null = null;
  wakeWhy: WakeWhy | null = null;
  /** когда уснул (для «доброе утро» и debug) */
  asleepSince = -1;

  get busy() {
    return this.state === 'tucking' || this.state === 'waking';
  }
  /** кот в кровати (лежит или в переходе): сцена держит его на матрасе, тапы — к кровати */
  get inBed() {
    return this.state !== 'awake';
  }

  /** уложить спать; false — уже в кровати */
  tuck(now: number, why: TuckWhy = 'chip'): boolean {
    if (this.state !== 'awake') return false;
    this.state = 'tucking';
    this.tuckWhy = why;
    this.wakeWhy = null;
    this.run(TUCK_STEPS, now);
    return true;
  }

  /** сразу спящим в кровати (утро: ребёнок находит кота спящим; ?bed=sleep) */
  sleepNow(now: number, why: TuckWhy = 'flow') {
    this.state = 'asleep';
    this.tuckWhy = why;
    this.wakeWhy = null;
    this.steps = [];
    this.asleepSince = now;
    this.taps = [];
  }

  /** разбудить; false — не спит (или уже просыпается) */
  wake(now: number, why: WakeWhy): boolean {
    if (this.state === 'awake' || this.state === 'waking') return false;
    this.state = 'waking';
    this.wakeWhy = why;
    this.taps = [];
    this.run(why === 'external' ? QUICK_WAKE_STEPS : WAKE_STEPS, now);
    return true;
  }

  /** сбросить без анимации (кот на карте проснулся от касания, dispose) */
  reset() {
    this.state = 'awake';
    this.steps = [];
    this.taps = [];
    this.asleepSince = -1;
  }

  /**
   * Касание во сне: первый тап — бормочет, второй — ворочается, третий за TAP_WINDOW_MS — просыпается.
   * Медленная серия (тап раз в 2 с) не будит. В переходе (залезает/встаёт) касания съедаются без ответа.
   */
  tap(now: number, gentle = false): TapResult {
    if (this.state !== 'asleep') return this.busy ? 'none' : 'none';
    if (gentle) {
      // гладят спящего — мурчит во сне, к «разбудить» не считается
      if (now - this.lastMurmur < MURMUR_GAP_MS) return 'twitch';
      this.lastMurmur = now;
      return 'murmur';
    }
    this.taps = this.taps.filter((t) => now - t < TAP_WINDOW_MS);
    this.taps.push(now);
    if (this.taps.length >= WAKE_TAPS) {
      this.wake(now, 'taps');
      return 'wake';
    }
    this.tapN++;
    if (this.taps.length === 2) return 'turn';
    if (now - this.lastMurmur < MURMUR_GAP_MS) return 'twitch';
    this.lastMurmur = now;
    return 'murmur';
  }

  private run(steps: readonly BedStep[], now: number) {
    this.steps = steps;
    this.i = 0;
    this.t0 = now;
  }

  /** где автомат сейчас */
  progress(now: number): BedProgress {
    const st = this.steps[this.i] ?? null;
    if (!this.busy || !st) return { state: this.state, step: null, k: 0, total: this.state === 'asleep' ? 1 : 0 };
    const all = this.steps.reduce((s, x) => s + x.ms, 0);
    const before = this.steps.slice(0, this.i).reduce((s, x) => s + x.ms, 0);
    const el = Math.max(0, now - this.t0);
    return { state: this.state, step: st, k: Math.min(1, el / st.ms), total: Math.min(1, (before + el) / all) };
  }

  /** шаг вперёд по времени: что сменилось (шаг, состояние) */
  tick(now: number): { step?: BedStep; done?: 'asleep' | 'awake' }[] {
    const out: { step?: BedStep; done?: 'asleep' | 'awake' }[] = [];
    let guard = 0;
    while (this.busy && guard++ < 10) {
      const st = this.steps[this.i];
      if (!st) break;
      if (now - this.t0 < st.ms) break;
      this.t0 += st.ms;
      this.i++;
      const next = this.steps[this.i];
      if (next) out.push({ step: next });
      else if (this.state === 'tucking') {
        this.state = 'asleep';
        this.asleepSince = now;
        this.taps = [];
        out.push({ done: 'asleep' });
      } else {
        this.state = 'awake';
        this.asleepSince = -1;
        out.push({ done: 'awake' });
      }
    }
    return out;
  }

  /** текущий шаг (для клипа при входе в шаг) */
  get step(): BedStep | null {
    return this.busy ? this.steps[this.i] ?? null : null;
  }
}

// ───────────── время суток ─────────────

/** часть суток по местным часам: утро 6–11, день, тихий час 13–16, вечер 20–23, ночь 23–6 */
export type Daypart = 'morning' | 'day' | 'nap' | 'afternoon' | 'evening' | 'night';
export function daypart(hour: number): Daypart {
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  if (h >= 6 && h < 11) return 'morning';
  if (h >= 11 && h < 13) return 'day';
  if (h >= 13 && h < 16) return 'nap';
  if (h >= 16 && h < 20) return 'afternoon';
  if (h >= 20 && h < 23) return 'evening';
  return 'night';
}

/** местная дата YYYY-MM-DD (утро «первого открытия» — раз в день) */
export const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** уложили вечером или ночью — «спокойной ночи», а не просто «укрой меня» */
export const isNight = (hour: number) => {
  const p = daypart(hour);
  return p === 'evening' || p === 'night';
};

/** предложение кота по времени суток */
export type BedOffer = 'nap_offer' | 'evening_yawn';
/** тишина дома, после которой кот сам предлагает поспать */
export const OFFER_QUIET_MS = 20_000;
/** после «не хочу» кот не предлагает снова столько */
export const OFFER_DECLINE_MS = 10 * 60_000;
/** чипы предложения держатся */
export const OFFER_SHOW_MS = 15_000;

export interface OfferEnv {
  now: number;
  hour: number;
  state: BedState;
  /** дома, не в переходе, кот не бежит между комнатами */
  home: boolean;
  /** диалог, мини-игра, кот говорит, поддержка, дрёма */
  busy: boolean;
  quietMs: number;
  /** только что вошли в спальню */
  enteredBedroom?: boolean;
}

/**
 * Время суток — только для предложений, кот ничего не делает сам: днём (13–16) «Может, вздремнём?», вечером (20–23)
 * зевает и зовёт в кровать. Раз за сессию на часть суток; «не хочу» — 10 мин тишины.
 */
export class BedOfferRule {
  private offered = new Set<string>();
  private declinedAt = -1e12;

  check(e: OfferEnv): BedOffer | null {
    if (!e.home || e.busy || e.state !== 'awake') return null;
    if (e.now - this.declinedAt < OFFER_DECLINE_MS) return null;
    const p = daypart(e.hour);
    const offer: BedOffer | null = p === 'nap' ? 'nap_offer' : p === 'evening' ? 'evening_yawn' : null;
    if (!offer || this.offered.has(p)) return null;
    if (!(e.enteredBedroom || e.quietMs >= OFFER_QUIET_MS)) return null;
    this.offered.add(p);
    return offer;
  }
  decline(now: number) {
    this.declinedAt = now;
  }
}

/**
 * Утро (6–11): первый вход домой за день — кот ещё спит в кровати, ребёнок его будит («Доброе утро»).
 * lastMorning — день, когда это уже было (память кота).
 */
export const morningWake = (hour: number, today: string, lastMorning: string | undefined) => daypart(hour) === 'morning' && lastMorning !== today;

// ───────────── голос ─────────────

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
/** «спать», «ложись спать», «баю-бай», «спокойной ночи», «в кроватку» */
const SLEEP_RE = /(^| )(спать|спатки|спатеньки|ложись|ложимся|засыпай|засыпаем|баю ?бай|баюшки|бай бай|спокойной ночи|споки|в кровать|в кроватку|уложить|укладываемся|баиньки|спи|поспи|вздремнем|вздремни)( |$)/;
/** «просыпайся», «утро», «вставай», «подъём», «доброе утро» */
const WAKE_RE = /(^| )(просыпайся|проснись|просыпаемся|утро|утречко|вставай|встаем|подъем|подъемчик|хватит спать|открой глаза|доброе утро|не спи|пора вставать)( |$)/;
const YES_RE = /^(да|давай|ага|хочу|угу|ок|окей|конечно|давай спать|пошли|пойдем|ладно|хорошо)( |$)/;
const NO_RE = /^(нет|не хочу|неа|не надо|не буду|потом|не сейчас|еще поиграем|давай играть)( |$)/;

export type BedIntent = 'sleep' | 'wake' | 'yes' | 'no';
/** фраза ребёнка → намерение кровати (в доме; на карте «пора спать» — это «пока») */
export function bedIntent(text: string): BedIntent | null {
  const t = norm(text);
  if (!t) return null;
  // «не спи» / «хватит спать» — про пробуждение, хоть в них и есть «спать»
  if (WAKE_RE.test(t)) return 'wake';
  if (SLEEP_RE.test(t)) return 'sleep';
  if (NO_RE.test(t)) return 'no';
  if (YES_RE.test(t)) return 'yes';
  return null;
}
