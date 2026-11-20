/** Расписание номера «Скейт» (skateRig.ts) без three.js — его читает режиссёр (когда вести кота по дуге). */
export type SkatePhase = 'grab' | 'drop' | 'mount' | 'push' | 'ride' | 'ollie' | 'roll' | 'dismount' | 'stow' | 'done';
export type SkatePh = Exclude<SkatePhase, 'done'>;
export const SKATE_T: Record<SkatePh, number> = { grab: 0.5, drop: 0.5, mount: 0.45, push: 0.75, ride: 1.7, ollie: 0.65, roll: 0.45, dismount: 0.55, stow: 0.45 };
export const SKATE_ORDER: SkatePh[] = ['grab', 'drop', 'mount', 'push', 'ride', 'ollie', 'roll', 'dismount', 'stow'];
export const SKATE_TOTAL = SKATE_ORDER.reduce((a, p) => a + SKATE_T[p], 0);
/** с какого момента кот едет по карте (начало толчка) и до какого (конец доката), с от старта */
export const RIDE_FROM = SKATE_T.grab + SKATE_T.drop + SKATE_T.mount;
export const RIDE_TO = RIDE_FROM + SKATE_T.push + SKATE_T.ride + SKATE_T.ollie + SKATE_T.roll;
