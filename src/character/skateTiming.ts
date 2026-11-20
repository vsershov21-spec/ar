/** Расписание номера «Скейт» (skateRig.ts) без three.js — его читает режиссёр (когда вести кота по дуге). */
export type SkatePhase = 'conjure' | 'place' | 'hop' | 'push' | 'ride' | 'ollie' | 'flip' | 'roll' | 'hopoff' | 'kickup' | 'vanish' | 'done';
export type SkatePh = Exclude<SkatePhase, 'done'>;
export const SKATE_T: Record<SkatePh, number> = { conjure: 0.55, place: 0.45, hop: 0.45, push: 0.8, ride: 1.4, ollie: 0.7, flip: 0.75, roll: 0.35, hopoff: 0.45, kickup: 0.6, vanish: 0.4 };
export const SKATE_ORDER: SkatePh[] = ['conjure', 'place', 'hop', 'push', 'ride', 'ollie', 'flip', 'roll', 'hopoff', 'kickup', 'vanish'];
export const SKATE_TOTAL = SKATE_ORDER.reduce((a, p) => a + SKATE_T[p], 0);
/** с какого момента кот едет по карте (начало толчка) и до какого (конец доката), с от старта */
export const RIDE_FROM = SKATE_T.conjure + SKATE_T.place + SKATE_T.hop;
export const RIDE_TO = RIDE_FROM + SKATE_T.push + SKATE_T.ride + SKATE_T.ollie + SKATE_T.flip + SKATE_T.roll;
