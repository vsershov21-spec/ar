/**
 * Хореография «пробуждения» кота из карты — чистые функции времени (без three.js и DOM, тесты — tests/awake.test.ts).
 *
 * Первая встреча (≈5,4 с): карта светится по контуру → из центра открывается портал и поднимается световой столб,
 * летят искры → на карте проступает тень кота → ПУФ: кот выпрыгивает из карты (масштаб от 0,3 с перелётом,
 * снизу из-под поверхности — маска карты прячет то, что ещё «внутри») → приземление со сквошем, салют и фанфары →
 * встряхивается → открывает глаза (сонный → удивлённый → радость) → машет. На повторном визите — та же сцена
 * за 1,5 с: короткий столб, кот выскакивает, маленький салют.
 *
 * Свой вариант для каждого образа:
 *   hooligan — граффити-брызги на карте и неоновые спреи, вылетает на скейте с переворотом (сальто);
 *   kind     — пузыри и мягкие сердечки, выплывает медленно в облаке пузырей, покачиваясь;
 *   glitter  — звёздная пыль и блёстки по спирали вокруг столба, вылетает с вращением (2 оборота).
 */
import type { PersonaId } from '../persona/types';

export type AwakeKind = 'first' | 'short';

/** поза кота поверх позы на карте (Stage.intro): в ростах кота и радианах */
export interface IntroPose {
  /** подъём вдоль нормали карты, ростов кота (< 0 — ещё «в карте») */
  lift: number;
  /** общий масштаб 0..~1,1 */
  scale: number;
  /** сплющивание: > 0 — ниже и шире (приземление), < 0 — вытянут (взлёт) */
  squash: number;
  /** вращение вокруг своей вертикали (Блёстка) */
  spin: number;
  /** сальто вокруг поперечной оси (Хулиган) */
  flip: number;
  /** крен (встряхивание, покачивание) */
  roll: number;
  /** контактная тень под лапами 0..1 */
  shadow: number;
}

export type AwakeEvent =
  | { t: number; type: 'sound'; id: string; vol?: number }
  | { t: number; type: 'clip'; clip: string }
  | { t: number; type: 'emotion'; name: string; weight: number; ms: number }
  | { t: number; type: 'pop' }
  | { t: number; type: 'land' }
  | { t: number; type: 'salute'; size: 'big' | 'small' }
  | { t: number; type: 'sfx'; id: string; vol?: number };

export interface AwakePlan {
  persona: PersonaId;
  kind: AwakeKind;
  /** вся сцена, с */
  dur: number;
  /** когда сценарий идёт дальше («Ого! Это твоя карта?…»), мс от старта */
  appearDoneMs: number;
  /** ПУФ — кот выходит из карты */
  tPop: number;
  /** приземление */
  tLand: number;
  events: AwakeEvent[];
  pose(t: number): IntroPose;
  /** трещины на карте до ПУФ (как на заставке — «вылупление»): grow — раскрыто 0..1 толчками, k — яркость */
  cracks(t: number): { grow: number; k: number };
  /** свечение контура карты 0..1 */
  glow(t: number): number;
  /** портал в центре карты 0..~1,4 (вспышка на ПУФ) */
  portal(t: number): number;
  /** столб света: высота 0..1 и яркость 0..1 */
  pillar(t: number): { h: number; k: number };
  /** тень-силуэт кота на карте 0..1 */
  silhouette(t: number): number;
  /** скейт под лапами (Хулиган): 0 — нет; 1 — под лапами; > 1 — укатывается (1→2) */
  skate(t: number): number;
  /** частицы: интенсивность струйки искр вдоль столба 0..1 */
  sparks(t: number): number;
  /** частицы образа (спреи / пузыри / звёздная пыль) 0..1 */
  flair(t: number): number;
}

// ───────────── кривые ─────────────
export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smooth = (x: number) => {
  x = clamp01(x);
  return x * x * (3 - 2 * x);
};
const ramp = (t: number, a: number, b: number) => smooth((t - a) / (b - a));
const easeOut = (x: number) => 1 - (1 - clamp01(x)) ** 3;
const easeInOut = (x: number) => {
  x = clamp01(x);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
};
/** 0→1 с перелётом (~10%) */
export const easeOutBack = (x: number, s = 1.9) => {
  x = clamp01(x);
  const c3 = s + 1;
  return 1 + c3 * (x - 1) ** 3 + s * (x - 1) ** 2;
};
/** «окно»: 0 до a, 1 между b и c, 0 после d */
const win = (t: number, a: number, b: number, c: number, d: number) => (t < b ? ramp(t, a, b) : 1 - ramp(t, c, d));

interface Style {
  /** длительность полёта (ПУФ → приземление) */
  flight: number;
  /** пик подъёма над картой, ростов */
  peak: number;
  /** из-под карты на старте, ростов */
  depth: number;
  flips: number;
  spins: number;
  /** покачивание в полёте (Добряк) */
  sway: number;
  flightClip: string;
}

const STYLE: Record<PersonaId, Style> = {
  hooligan: { flight: 0.9, peak: 0.62, depth: 0.75, flips: 1, spins: 0, sway: 0, flightClip: 'jump' },
  kind: { flight: 1.2, peak: 0.42, depth: 0.7, flips: 0, spins: 0, sway: 0.16, flightClip: 'idle_yawn' },
  glitter: { flight: 0.95, peak: 0.55, depth: 0.75, flips: 0, spins: 2, sway: 0, flightClip: 'jump' },
};

/** толчки трещин до ПУФ: [за сколько секунд до ПУФ, раскрытие] (первая встреча) и [доля tPop до ПУФ, раскрытие] (короткая) */
const CRACK_BEATS_FIRST: [number, number][] = [[1.3, 0.3], [0.8, 0.5], [0.6, 0.7], [0.18, 1]];
const CRACK_BEATS_SHORT: [number, number][] = [[0.85, 0.55], [0.3, 1]];

/** план сцены пробуждения для образа и вида визита */
export function awakePlan(persona: PersonaId, kind: AwakeKind): AwakePlan {
  const st = STYLE[persona] ?? STYLE.hooligan;
  const first = kind === 'first';
  // короткая версия: всё в ~1,5 с
  const tPop = first ? 1.55 : 0.32;
  const flight = first ? st.flight : Math.min(0.62, st.flight * 0.62);
  const tLand = tPop + flight;
  const peak = first ? st.peak : st.peak * 0.6;
  const depth = st.depth;
  const flips = st.flips;
  const spins = first ? st.spins : Math.min(1, st.spins);
  const dur = first ? tLand + 2.95 : 1.5;

  const ev: AwakeEvent[] = [];
  const add = (e: AwakeEvent) => ev.push(e);
  if (first) {
    add({ t: 0, type: 'sound', id: 'rise', vol: 0.8 });
    add({ t: tPop - 0.05, type: 'sound', id: `pop_${persona}`, vol: 0.95 });
    add({ t: tPop, type: 'pop' });
    add({ t: tPop, type: 'clip', clip: st.flightClip });
    // глаза закрыты ещё до появления (эмоция входит плавно — к ПУФ уже спит)
    add({ t: tPop - 0.35, type: 'emotion', name: 'sleep', weight: 1, ms: (tLand - tPop + 1.55) * 1000 });
    add({ t: tLand, type: 'land' });
    add({ t: tLand, type: 'salute', size: 'big' });
    add({ t: tLand - 0.04, type: 'sound', id: `fanfare_${persona}`, vol: 0.85 });
    add({ t: tLand + 0.02, type: 'clip', clip: 'idle_breathe' });
    // встряхивается (крен — в pose), звук встряски из общего спрайта
    add({ t: tLand + 0.3, type: 'sfx', id: 'shake', vol: 0.45 });
    // открывает глаза: сонный → удивлённый → радость; «протирает глаза» — wake_startle
    add({ t: tLand + 0.95, type: 'emotion', name: 'sleepy', weight: 1, ms: 700 });
    add({ t: tLand + 1.0, type: 'clip', clip: 'wake_startle' });
    add({ t: tLand + 1.5, type: 'emotion', name: 'surprised', weight: 1, ms: 800 });
    add({ t: tLand + 2.15, type: 'emotion', name: 'happy', weight: 1, ms: 2400 });
    add({ t: tLand + 2.15, type: 'clip', clip: 'wave' });
  } else {
    add({ t: 0, type: 'sound', id: `pop_${persona}`, vol: 0.7 });
    add({ t: tPop, type: 'pop' });
    add({ t: tPop, type: 'clip', clip: 'jump' });
    add({ t: tPop, type: 'emotion', name: 'surprised', weight: 1, ms: 700 });
    add({ t: tLand - 0.1, type: 'sound', id: `fanfare_short_${persona}`, vol: 0.75 });
    add({ t: tLand, type: 'land' });
    add({ t: tLand, type: 'salute', size: 'small' });
    add({ t: tLand + 0.05, type: 'emotion', name: 'happy', weight: 1, ms: 1800 });
    add({ t: tLand + 0.05, type: 'clip', clip: 'wave' });
  }
  ev.sort((a, b) => a.t - b.t);

  const pose = (t: number): IntroPose => {
    if (t < tPop) return { lift: -depth, scale: 0, squash: 0, spin: 0, flip: 0, roll: 0, shadow: 0 };
    if (t < tLand) {
      const u = (t - tPop) / flight;
      // из-под карты по дуге: -depth → пик → 0 (у Добряка дуга мягче: выплывает)
      const uu = st.sway ? easeInOut(u) : u;
      const lift = -depth * (1 - uu) ** 1.4 + 4 * (peak + depth * 0.25) * uu * (1 - uu);
      const scale = 0.3 + 0.7 * easeOutBack(u * 1.15);
      // взлёт — вытянут, к земле — обычный
      const squash = -0.18 * Math.sin(Math.PI * clamp01(u * 2)) * (1 - u);
      const flip = flips * Math.PI * 2 * easeInOut((u - 0.12) / 0.72);
      const spin = spins * Math.PI * 2 * easeOut(u / 0.92);
      const roll = st.sway * Math.sin(u * Math.PI * 3) * (1 - u);
      return { lift, scale, squash, spin, flip, roll, shadow: smooth(u * 1.5) * 0.6 };
    }
    const s = t - tLand;
    // приземление: затухающая пружина сквоша
    const squash = 0.24 * Math.exp(-s * 7) * Math.cos(s * 22);
    // встряхивание (первая встреча): крен туда-сюда ~9 Гц, горбом 0,7 с
    let roll = 0;
    if (first) {
      const a = s - 0.3;
      // было 0,17 рад × 8,5 Гц: на телефоне читалось как дрожь трекинга в конце появления («кота трясёт», записи
      // 20.11) — теперь мягкое «отряхнулся»: 5 Гц, 0,07 рад, тот же горб огибающей
      if (a > 0 && a < 0.75) roll = 0.07 * Math.sin(a * Math.PI * 2 * 5) * Math.sin((a / 0.75) * Math.PI);
    }
    return { lift: 0, scale: 1, squash, spin: 0, flip: 0, roll, shadow: 1 };
  };

  return {
    persona,
    kind,
    dur,
    appearDoneMs: Math.round((first ? tLand + 2.75 : dur) * 1000),
    tPop,
    tLand,
    events: ev,
    pose,
    cracks: (t) => {
      // толчки как на заставке: тук… тук-тук… ТУК → ПУФ; после ПУФ трещины гаснут
      const beats = first ? CRACK_BEATS_FIRST : CRACK_BEATS_SHORT;
      let grow = 0, hit = 0;
      for (const [bt, lv] of beats) {
        const b = first ? tPop - bt : tPop * (1 - bt);
        grow = Math.max(grow, lv * easeOut((t - b) / 0.12));
        hit += Math.exp(-(((t - b) / 0.07) ** 2));
      }
      const fade = 1 - clamp01((t - tPop - 0.04) / 0.5);
      const flash = 0.9 * Math.exp(-(((t - tPop) / 0.08) ** 2));
      return { grow, k: grow > 0 ? (0.7 + 0.7 * Math.min(1, hit) + flash) * fade : 0 };
    },
    glow: (t) => (first ? win(t, 0, 0.45, tLand + 0.1, tLand + 0.8) : win(t, 0, 0.18, tLand, tLand + 0.4)),
    portal: (t) => {
      const base = first ? win(t, 0.3, 0.8, tPop + 0.05, tLand + 0.2) : win(t, 0.05, 0.2, tPop, tLand);
      const flash = 0.45 * Math.exp(-(((t - tPop) / 0.09) ** 2));
      return base + flash;
    },
    pillar: (t) => {
      if (first) return { h: easeOut((t - 0.6) / 0.7), k: win(t, 0.6, 0.9, tPop + 0.1, tLand + 0.15) * (1 + 0.6 * Math.exp(-(((t - tPop) / 0.12) ** 2))) };
      return { h: easeOut((t - 0.05) / 0.3) * 0.75, k: win(t, 0.05, 0.2, tPop + 0.05, tLand) };
    },
    silhouette: (t) => (first ? win(t, 0.85, 1.45, tPop, tPop + 0.25) * 0.75 : 0),
    skate: (t) => {
      if (persona !== 'hooligan' || !first || t < tPop) return 0;
      if (t < tLand + 0.55) return 1;
      return 1 + clamp01((t - tLand - 0.55) / 0.8) + (t > tLand + 1.35 ? 1 : 0);
    },
    sparks: (t) => (first ? win(t, 0.4, 0.8, tLand - 0.2, tLand + 0.3) : win(t, 0, 0.1, tPop, tLand)),
    flair: (t) => (first ? win(t, 0.65, 0.95, tLand + 0.5, tLand + 1.6) : win(t, 0.1, 0.2, tLand, tLand + 0.4)),
  };
}
