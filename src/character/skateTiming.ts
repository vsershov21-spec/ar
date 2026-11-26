/** Расписание номера «Скейт» (skateRig.ts) без three.js — его читает режиссёр (когда вести кота по дуге). */
export type SkatePhase = 'conjure' | 'place' | 'hop' | 'rise' | 'push' | 'ride' | 'ollie' | 'flip' | 'roll' | 'hopoff' | 'kickup' | 'vanish' | 'fade' | 'done';
export type SkatePh = Exclude<SkatePhase, 'done'>;
export const SKATE_T: Record<SkatePh, number> = { conjure: 0.55, place: 0.45, hop: 0.45, rise: 0.6, push: 0.8, ride: 1.4, ollie: 0.7, flip: 0.75, roll: 0.35, hopoff: 0.45, kickup: 0.6, vanish: 0.4, fade: 0.5 };
export const SKATE_ORDER: SkatePh[] = ['conjure', 'place', 'hop', 'push', 'ride', 'ollie', 'flip', 'roll', 'hopoff', 'kickup', 'vanish'];
export const SKATE_TOTAL = SKATE_ORDER.reduce((a, p) => a + SKATE_T[p], 0);
/** с какого момента кот едет по карте (начало толчка) и до какого (конец доката), с от старта */
export const RIDE_FROM = SKATE_T.conjure + SKATE_T.place + SKATE_T.hop;
export const RIDE_TO = RIDE_FROM + SKATE_T.push + SKATE_T.ride + SKATE_T.ollie + SKATE_T.flip + SKATE_T.roll;

/**
 * Выезд на скейте при появлении Хулигана (skate_show, feature cat.attrs; запись 26.11 — скейт «вылетает из кота,
 * переворачивается, не стильно»): доска из искры прямо под лапами, пока кот подпрыгнул (rise), толчок, проезд дугой,
 * докат, соскок вперёд, доска остаётся сзади и уходит искрой (fade). Без кикфлипа, олли и подброса доски в лапу —
 * доска всё время на колёсах под стопами или на карте.
 */
export const SKATE_SHOW_ORDER: SkatePh[] = ['rise', 'push', 'ride', 'roll', 'hopoff', 'fade'];
export const SKATE_SHOW_T: Partial<Record<SkatePh, number>> = { ride: 1.1 };
export const skateT = (order: readonly SkatePh[], p: SkatePh) => (order === SKATE_SHOW_ORDER ? SKATE_SHOW_T[p] : undefined) ?? SKATE_T[p];
export const SKATE_SHOW_TOTAL = SKATE_SHOW_ORDER.reduce((a, p) => a + skateT(SKATE_SHOW_ORDER, p), 0);
export const SHOW_RIDE_FROM = skateT(SKATE_SHOW_ORDER, 'rise');
export const SHOW_RIDE_TO = SHOW_RIDE_FROM + skateT(SKATE_SHOW_ORDER, 'push') + skateT(SKATE_SHOW_ORDER, 'ride') + skateT(SKATE_SHOW_ORDER, 'roll');
