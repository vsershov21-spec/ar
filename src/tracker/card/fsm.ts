/**
 * Машина состояний трекера карты — одна точка правды «где мы»: чистая логика без DOM и без времени браузера
 * (тесты — tests/card/fsm.test.ts). На вход — наблюдения воркера по кадрам и время, на выход — состояние,
 * прогресс посадки 0..1, подсказка ребёнку и журнал переходов (причины — в ?debug).
 *
 *   SEARCH ──карта в кадре──▶ CANDIDATE ──карта Сбера + стабильно──▶ LOCKED
 *     ▲                         │  (нет карты > CAND_MISS_MS)            │ нет карты > HOLD_AFTER_MS
 *     └─────────────────────────┘                                        ▼
 *   LOST ◀──нет дольше LOST_MS── RELOCALIZE ◀──нет дольше HOLD_MS── HOLD (поверхность / гироскоп)
 *     │                               │  та же карта рядом с прогнозом        │ карта вернулась
 *     └──карта Сбера (снова)──▶ CANDIDATE   └──────────────▶ LOCKED ◀────────┘
 *
 * Гистерезис: прогресс посадки копится по времени (а не «N кадров подряд»), плохой кадр его лишь немного
 * отнимает; кандидат переживает короткие пропуски; подсказка меняется не чаще раза в HINT_MIN_MS
 * и только если новая причина держится HINT_DWELL_MS.
 */

export type TrackState = 'search' | 'candidate' | 'locked' | 'hold' | 'relocalize' | 'lost';
/** что сказать ребёнку (текст — overlay.ts) */
export type Hint = 'aim' | 'closer' | 'farther' | 'glare' | 'steady' | 'checking' | 'found' | 'other' | 'back' | 'notcard' | null;
/** что воркер думает о содержимом кандидата */
export type Kind = 'sber' | 'checking' | 'other' | 'back' | 'notcard';

export interface Obs {
  /** мс */
  t: number;
  /** карта найдена и поза правдоподобна */
  found: boolean;
  /** режим воркера: detect | track | key | plane | none */
  mode?: string;
  /** ошибка позы (перепроецирование), px */
  err?: number;
  /** смещение углов к прошлому кадру, доли диагонали */
  jitter?: number;
  /** длинная сторона карты, доля КОРОТКОЙ стороны кадра */
  size?: number;
  /** доля карты в кадре 0..1 (углы за краем → < 1) */
  inFrame?: number;
  /** доля пересвеченных точек на карте */
  glare?: number;
  /** телефон неподвижен (гироскоп; нет гироскопа — true) */
  still?: boolean;
  kind?: Kind;
  /** после посадки: 5+ проверок подряд «под котом не карта» */
  postNotCard?: boolean;
  /** есть намёк на знак Сбера (false — по форме не садим: чужая карта, у которой не поймали чип) */
  maybeSber?: boolean;
  /** воркер видит четырёхугольник карты (даже если поза отброшена — смаз, угол, блик) */
  quad?: boolean;
}

export interface FsmEvent {
  t: number;
  from: TrackState;
  to: TrackState;
  why: string;
}

/** стабильное время до посадки, мс (≈ 0,35 с при неподвижном телефоне) */
export const STABLE_MS = 350;
/** ждём знак Сбера на стабильной карте, прежде чем посадить по форме */
export const CHECK_PATIENCE_MS = 2500;
/** кандидат переживает пропуски до */
export const CAND_MISS_MS = 450;
/** LOCKED → HOLD: карты нет дольше */
export const HOLD_AFTER_MS = 300;
/** HOLD → RELOCALIZE */
export const HOLD_MS = 1500;
/** → LOST (кот спрашивает, где карта) */
export const LOST_MS = 6000;
/**
 * Карта в кадре (воркер видит её четырёхугольник), но поза не проходит — «потерю» откладываем, пока так, но не дольше
 * LOST_MAX_MS: кот не говорит «Ой, карточка пропала», когда карта лежит перед камерой (запись 20.11).
 */
export const LOST_MAX_MS = 12000;
const QUAD_FRESH_MS = 1500;
/**
 * Карта Сбера узнана (знак/дизайн в 2+ проверках) — сажаем не дольше чем через столько, даже если «ровно» ещё не
 * накопилось: на iPhone рукой ровно не удержать, а оценки углов из полного поиска и потока расходятся на 3–6 % диагонали
 * у мелкой карты — кольцо «Держи телефон ровно…» крутилось 10–15 с (запись продакта 18.11). Ложных посадок это не
 * добавляет: «чья карта» решает проверка, а не стабильность; после посадки позу уточняет ключевой кадр.
 */
export const SBER_LAND_MS = 600;
/** кот уже сидел на этой карте (вернули после потери) — снова сажаем почти сразу */
export const RELAND_MS = 150;
/** «ровно»: смещение углов к прошлому ответу воркера, доли диагонали (было 0,04 — меньше шума оценок у карты 60 px) */
const JITTER_OK = 0.07;
const HINT_DWELL_MS = 350;
const HINT_MIN_MS = 1200;

export class CardFsm {
  state: TrackState = 'search';
  since = 0;
  /** прогресс посадки 0..1 (по условиям, без сглаживания) */
  progress = 0;
  /** для экрана: плавный, без провалов на одном плохом кадре */
  shown = 0;
  hint: Hint = 'aim';
  /** посадили по знаку Сбера (а не «по форме» из-за терпения) — переверификация такого кота не пересаживает */
  verified = false;
  log: FsmEvent[] = [];
  /** последний раз карту видели (мс) */
  seenAt = -1e9;
  /** последний раз воркер видел четырёхугольник карты (поза могла не пройти) */
  quadAt = -1e9;
  private stableMs = 0;
  private checkingSince = 0;
  /** с какого момента кандидат подряд узнаётся как карта Сбера (0 — нет) */
  private sberSince = 0;
  private lastObsT = -1;
  /** наблюдений подряд без карты (медленный телефон: 0,45 с — это 1–2 кадра, мало) */
  private missRun = 0;
  private hintCand: Hint = 'aim';
  private hintCandAt = 0;
  private hintAt = -1e9;
  /** первая посадка уже была (LOST → снова «нашёл» событием) */
  everLocked = false;

  constructor(readonly verify = true) {}

  private go(to: TrackState, t: number, why: string) {
    if (to === this.state) return;
    this.log.push({ t, from: this.state, to, why });
    if (this.log.length > 60) this.log.shift();
    this.state = to;
    this.since = t;
    if (to === 'search' || to === 'lost') {
      this.stableMs = 0;
      this.checkingSince = 0;
      this.sberSince = 0;
    }
    if (to === 'locked') this.everLocked = true;
  }

  /** «Пересадить кота» — с нуля */
  reset(t: number, why = 'пересадка') {
    this.go('search', t, why);
    this.progress = this.shown = 0;
    this.verified = false;
    this.stableMs = 0;
    this.checkingSince = 0;
    this.sberSince = 0;
    this.everLocked = false;
  }

  /** наблюдение по кадру воркера */
  observe(o: Obs): TrackState {
    const dt = this.lastObsT < 0 ? 0 : Math.min(200, Math.max(0, o.t - this.lastObsT));
    this.lastObsT = o.t;
    if (o.found) this.seenAt = o.t;
    if (o.found || o.quad) this.quadAt = o.t;
    this.missRun = o.found ? 0 : this.missRun + 1;
    const s = this.state;
    if (s === 'locked' || s === 'hold' || s === 'relocalize') {
      if (o.postNotCard && !this.verified && (o.mode === 'detect' || o.mode === 'track' || o.mode === 'key')) {
        // посадили «по форме» (знак не поймали), а под котом 5 проверок подряд без признаков карты — пересадка
        this.reset(o.t, 'переверификация: под котом не карта');
        return this.state;
      }
      if (o.found) {
        if (s !== 'locked') this.go('locked', o.t, `карта снова видна (${o.mode})`);
      } else this.tick(o.t);
      return this.state;
    }
    // SEARCH / CANDIDATE / LOST
    if (!o.found) {
      if (s === 'candidate') {
        // одиночный пропуск (кадр ведения с низкой оценкой, смаз) стабильность не отнимает — только серия: иначе
        // на тёмном столе «детект / пропуск / детект…» обнулял прогресс и кот не садился никогда (стресс-набор)
        if (this.missRun >= 2) this.stableMs = Math.max(0, this.stableMs - dt);
        if (o.t - this.seenAt > CAND_MISS_MS && this.missRun >= 3) this.go(this.everLocked ? 'lost' : 'search', o.t, 'кандидат пропал');
      }
      this.updateProgress(o, o.t);
      return this.state;
    }
    if (s !== 'candidate') this.go('candidate', o.t, `карта в кадре (${o.mode})`);
    const inFrame = (o.inFrame ?? 1) > 0.97;
    const good = (o.err ?? 0) < 3.5 && (o.jitter ?? 0) < JITTER_OK && o.still !== false && inFrame;
    // гистерезис: хороший кадр копит время, плохой — отнимает столько же (не обнуляет)
    this.stableMs = good ? Math.min(STABLE_MS, this.stableMs + dt) : Math.max(0, this.stableMs - dt);
    const kind = this.verify ? o.kind ?? 'checking' : 'sber';
    if (kind === 'sber') this.sberSince ||= o.t;
    else this.sberSince = 0;
    if (kind === 'checking' && this.stableMs >= STABLE_MS * 0.5) this.checkingSince ||= o.t;
    else if (kind !== 'checking') this.checkingSince = 0;
    const patient = kind === 'checking' && o.maybeSber !== false && this.checkingSince > 0 && o.t - this.checkingSince >= CHECK_PATIENCE_MS;
    this.updateProgress(o, o.t, kind);
    // карта Сбера узнана: не ждём идеального «ровно» дольше SBER_LAND_MS (поза правдоподобна, карта целиком в кадре,
    // углы не скачут). Кот уже сидел на этой карте — RELAND_MS.
    const sberFor = kind === 'sber' && this.sberSince ? o.t - this.sberSince : 0;
    const poseOk = (o.err ?? 0) < 4 && inFrame && (o.jitter ?? 0) < 0.25;
    const sberReady = kind === 'sber' && poseOk && sberFor >= (this.everLocked ? RELAND_MS : SBER_LAND_MS);
    if ((this.stableMs >= STABLE_MS && (kind === 'sber' || patient)) || sberReady) {
      this.verified = kind === 'sber';
      this.progress = 1;
      this.go('locked', o.t, kind === 'sber' ? (this.stableMs >= STABLE_MS ? 'карта Сбера, стабильно' : `карта Сбера ${(sberFor / 1000).toFixed(1)} с`) : `знак не пойман за ${CHECK_PATIENCE_MS / 1000} с — по форме карты`);
    }
    return this.state;
  }

  /** время идёт и без кадров воркера (воркер занят/камера замерла) */
  tick(t: number) {
    const gone = t - this.seenAt;
    if (this.state === 'locked' && gone > HOLD_AFTER_MS) this.go('hold', t, 'карты не видно — держим по поверхности/гироскопу');
    if (this.state === 'hold' && gone > HOLD_MS) this.go('relocalize', t, 'ищем ту же карту рядом с прогнозом');
    if (this.state === 'relocalize' && gone > LOST_MS && (t - this.quadAt > QUAD_FRESH_MS || gone > LOST_MAX_MS)) this.go('lost', t, `карты нет ${(gone / 1000).toFixed(0)} с`);
    // воркер молчит (нет ответов) — кандидат живёт дольше
    if (this.state === 'candidate' && gone > 3 * CAND_MISS_MS) this.go(this.everLocked ? 'lost' : 'search', t, 'кандидат пропал');
  }

  /** кот на экране (поза валидна) */
  get anchored() {
    return this.state === 'locked' || this.state === 'hold' || this.state === 'relocalize';
  }

  /** насколько широко искать ту же карту (доли диагонали) — растёт со временем потери */
  hintRadius(t: number): number {
    const gone = Math.max(0, t - this.seenAt);
    return Math.min(2.5, 0.6 + gone / 1000 * 0.5);
  }

  private updateProgress(o: Obs, t: number, kind?: Kind) {
    let p = 0;
    let want: Hint = null;
    if (this.state === 'candidate' && o.found && kind) {
      // карта в кадре 0,15 → проверка «Сбер» до 0,6 → стабильность до 1
      const ver = kind === 'sber' ? 1 : kind === 'checking' ? (this.checkingSince ? Math.min(1, (t - this.checkingSince) / CHECK_PATIENCE_MS) * 0.9 : 0) : 0;
      // у карты Сбера шкала «ровно» досчитывается и по времени узнавания (сядем не позже SBER_LAND_MS)
      const sberT = kind === 'sber' && this.sberSince ? (t - this.sberSince) / (this.everLocked ? RELAND_MS : SBER_LAND_MS) : 0;
      const stab = Math.min(1, Math.max(this.stableMs / STABLE_MS, sberT));
      p = kind === 'other' || kind === 'back' || kind === 'notcard' ? 0.1 : 0.15 + 0.45 * ver + 0.4 * stab * (kind === 'sber' ? 1 : 0.75);
      const size = o.size ?? 0.5;
      if (kind === 'other' || kind === 'back' || kind === 'notcard') want = kind;
      else if ((o.inFrame ?? 1) < 0.97 || size > 0.97) want = 'farther';
      else if (size < 0.33) want = 'closer';
      else if ((o.glare ?? 0) > 0.06) want = 'glare';
      else if (kind === 'sber') want = 'found';
      else if (o.still === false || (o.jitter ?? 0) > JITTER_OK) want = 'steady';
      else want = 'checking';
    } else if (this.state === 'candidate') {
      p = this.progress; // короткий пропуск — прогресс держим
      want = this.hint;
    } else if (this.state === 'search' || this.state === 'lost') {
      want = 'aim';
    }
    this.progress = p;
    this.setHint(want, t);
  }

  private setHint(want: Hint, t: number) {
    if (want !== this.hintCand) {
      this.hintCand = want;
      this.hintCandAt = t;
    }
    if (want === this.hint) return;
    // «наведи» после кандидата и подсказки о чужой карте — сразу; остальное — после выдержки
    const dwell = t - this.hintCandAt >= HINT_DWELL_MS && t - this.hintAt >= HINT_MIN_MS;
    if (dwell || this.hint === null || want === 'other' || want === 'back') {
      this.hint = want;
      this.hintAt = t;
    }
  }

  /** плавный прогресс для экрана: вверх быстро, вниз медленно (без мигания кольца) */
  animate(dtSec: number): number {
    const target = this.state === 'candidate' ? this.progress : this.state === 'locked' ? 1 : 0;
    const d = target - this.shown;
    this.shown += d > 0 ? Math.min(d, dtSec * 3) : Math.max(d, -dtSec * (this.state === 'candidate' ? 0.6 : 4));
    return this.shown;
  }
}
