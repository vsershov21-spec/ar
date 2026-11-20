/**
 * Шаблон «держать предмет» (какао Добряка, зеркальце Блёстки, рыбка-угощение, жвачка Хулигана): одна и та же
 * последовательность поверх любого клипа покоя —
 *   take   — предмет появляется в лапе у груди (лапа поднимается, пальцы сжимаются вокруг ручки/кружки);
 *   raise  — подносит ко рту (зеркальце — к лицу, на расстояние взгляда);
 *   use    — sip: отпивает (кружка наклоняется к морде, голова — к кружке), bite: откусывает (лапа «клюёт» ко рту),
 *            look: смотрится (голова и глаза на зеркальце, лёгкое покачивание), pop: кладёт в рот (предмет пропадает);
 *   lower  — опускает к груди;
 *   away   — предмет уменьшается и пропадает, лапа возвращается к клипу.
 * Лапа — IK двух костей (limbIK.ts) с локтем вниз-наружу; кисть повёрнута ладонью к предмету, пальцы — кулак
 * (curlFingers), предмет ставится в центр ладони по её нормали: кисть обхватывает ручку, а не висит рядом.
 * Масштаб — от длины кисти (PROPS.handK): кружка с ладонь, зеркальце — две с половиной кисти.
 * Здесь — только расписание и цели (чистая функция holdPose, tests/holdAction.test.ts); кости двигает GlbCharacter.
 */
import * as THREE from 'three';

export type HoldUse = 'sip' | 'bite' | 'look' | 'pop';
export type HoldPhase = 'take' | 'raise' | 'use' | 'lower' | 'away' | 'done';
export interface HoldSpec {
  /** реквизит (character/props.ts PROPS) */
  prop: string;
  hand: 'Right' | 'Left';
  use: HoldUse;
  /** длительности фаз, с */
  t: Record<Exclude<HoldPhase, 'done'>, number>;
}

/** действие кнопки → шаблон (id — scenario/actions.ts; у Хулигана «Пузыри» — жвачка) */
export const HOLD_SPECS: Record<string, HoldSpec> = {
  cocoa: { prop: 'hold_cocoa', hand: 'Right', use: 'sip', t: { take: 0.55, raise: 0.6, use: 1.7, lower: 0.5, away: 0.45 } },
  mirror: { prop: 'hold_mirror', hand: 'Left', use: 'look', t: { take: 0.5, raise: 0.55, use: 1.9, lower: 0.45, away: 0.4 } },
  treat: { prop: 'hold_fish', hand: 'Right', use: 'bite', t: { take: 0.5, raise: 0.5, use: 1.3, lower: 0.45, away: 0.4 } },
  gum: { prop: 'hold_gum', hand: 'Right', use: 'pop', t: { take: 0.4, raise: 0.45, use: 0.5, lower: 0.35, away: 0.25 } },
};
export const PHASES: Exclude<HoldPhase, 'done'>[] = ['take', 'raise', 'use', 'lower', 'away'];
export function holdDuration(s: HoldSpec): number {
  return PHASES.reduce((a, p) => a + s.t[p], 0);
}

export interface HoldFrame {
  phase: HoldPhase;
  /** доля фазы 0…1 */
  k: number;
  /** вес IK лапы 0…1 */
  w: number;
  /** сжатие пальцев 0…1 */
  grip: number;
  /** где лапа: 0 — у груди, 1 — у рта/лица */
  toMouth: number;
  /** масштаб предмета 0…1 (появление/уход) */
  scale: number;
  /** наклон предмета (кружка при глотке), рад */
  tilt: number;
  /** голова назад (глоток) / к зеркальцу, рад */
  headPitch: number;
  /** «клюёт» ко рту (откусить), доля смещения 0…1 */
  peck: number;
}

const ss = (x: number) => {
  const k = Math.max(0, Math.min(1, x));
  return k * k * (3 - 2 * k);
};

/** поза шаблона в момент t (с от старта) — чистая функция */
export function holdPose(s: HoldSpec, t: number): HoldFrame {
  let acc = 0;
  for (const ph of PHASES) {
    const d = s.t[ph];
    if (t < acc + d) return frame(s, ph, (t - acc) / d, t - acc);
    acc += d;
  }
  return { phase: 'done', k: 1, w: 0, grip: 0, toMouth: 0, scale: 0, tilt: 0, headPitch: 0, peck: 0 };
}

function frame(s: HoldSpec, ph: Exclude<HoldPhase, 'done'>, k: number, tt: number): HoldFrame {
  const f: HoldFrame = { phase: ph, k, w: 1, grip: 1, toMouth: 0, scale: 1, tilt: 0, headPitch: 0, peck: 0 };
  const e = ss(k);
  switch (ph) {
    case 'take':
      f.w = e;
      f.grip = ss(k * 1.6 - 0.3);
      f.scale = ss(k * 1.8);
      break;
    case 'raise':
      f.toMouth = e;
      break;
    case 'use': {
      f.toMouth = 1;
      // вход и выход из действия — плавно (0,25 с)
      const env = Math.min(1, tt / 0.25, (s.t.use - tt) / 0.25);
      if (s.use === 'sip') {
        // лапы короткие: кот наклоняет голову к кружке и отпивает, кружка наклоняется к морде
        f.tilt = 0.5 * env;
        f.headPitch = 0.16 * env;
      } else if (s.use === 'bite') {
        f.peck = Math.max(0, Math.sin(tt * Math.PI * 2 * 2.2)) * env;
        f.headPitch = 0.05 * env;
      } else if (s.use === 'look') {
        f.headPitch = 0.08 * env;
        f.tilt = 0.12 * Math.sin(tt * Math.PI * 2 * 0.8) * env;
      } else {
        // pop: в рот — предмет уменьшается к концу фазы
        f.peck = e;
        f.scale = 1 - ss(k * 1.4 - 0.2);
      }
      break;
    }
    case 'lower':
      f.toMouth = 1 - e;
      if (s.use === 'pop') f.scale = 0;
      break;
    case 'away':
      f.w = 1 - e;
      f.grip = 1 - e;
      f.scale = s.use === 'pop' ? 0 : 1 - ss(k * 1.5);
      break;
  }
  return f;
}

/** цели лапы в системе персонажа (рост 1, лицом +Z); sx: правая лапа −1 (справа у кота = −X), левая +1 */
export function handTargets(s: HoldSpec, mouth: THREE.Vector3, head: THREE.Vector3, out: { chest: THREE.Vector3; face: THREE.Vector3 }) {
  const sx = s.hand === 'Right' ? -1 : 1;
  out.chest.set(sx * 0.12, 0.4, 0.2);
  if (s.use === 'look') out.face.set(sx * 0.06, head.y - 0.15, head.z + 0.22);
  else if (s.use === 'sip') out.face.set(mouth.x + sx * 0.05, mouth.y - 0.07, mouth.z + 0.15);
  else out.face.set(mouth.x + sx * 0.04, mouth.y - 0.06, mouth.z + 0.14);
  return out;
}
