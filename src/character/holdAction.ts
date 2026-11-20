/**
 * Шаблон «держать предмет» (какао Добряка, зеркальце Блёстки, рыбка-угощение, жвачка Хулигана): одна и та же
 * последовательность поверх клипа покоя —
 *   take   — предмет появляется в лапе у груди из искры (лапа поднимается, пальцы сжимаются вокруг ручки);
 *   raise  — подносит к морде: голова сама наклоняется навстречу, локоть вверх, плечо (ключица) подаётся вперёд,
 *            лапа чуть мультяшно тянется (GlbCharacter.reachAssist) — кружка до рта, зеркальце — на ширину головы;
 *   use    — sip: два маленьких глотка с прищуром удовольствия → «ах»; bite: укус → жуёт → второй укус → жуёт;
 *            look: кокетливо вертит головой, второй лапой поправляет бант, подмигивает, «чмок»; pop: в рот → жуёт;
 *   lower  — опускает к груди;
 *   away   — предмет уменьшается и пропадает искрой, лапа возвращается к клипу.
 * Здесь — только расписание (чистая функция holdPose, tests/holdSkate.test.ts) и мимика по тактам; кости двигает
 * GlbCharacter.applyHold, предмет ставит placeHold — от фактической кисти каждый кадр (не отрывается).
 */
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
  cocoa: { prop: 'hold_cocoa', hand: 'Right', use: 'sip', t: { take: 0.55, raise: 0.6, use: 2.7, lower: 0.5, away: 0.45 } },
  mirror: { prop: 'hold_mirror', hand: 'Left', use: 'look', t: { take: 0.5, raise: 0.55, use: 3.4, lower: 0.45, away: 0.4 } },
  treat: { prop: 'hold_fish', hand: 'Right', use: 'bite', t: { take: 0.5, raise: 0.5, use: 2.4, lower: 0.45, away: 0.4 } },
  gum: { prop: 'hold_gum', hand: 'Right', use: 'pop', t: { take: 0.4, raise: 0.45, use: 1.7, lower: 0.35, away: 0.25 } },
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
  /** наклон предмета к морде (кружка при глотке; зеркальце — покачивание), рад */
  tilt: number;
  /** голова и шея навстречу предмету (вниз-вперёд), рад; < 0 — назад («ах») */
  headPitch: number;
  /** голова к предмету по горизонтали (доля угла на предмет) */
  headYaw: number;
  /** наклон головы к плечу (кокетливо), рад; + — к лапе с предметом */
  headRoll: number;
  /** предмет ближе ко рту (укус, «в рот», «чмок»), доля смещения 0…1 */
  peck: number;
  /** вторая лапа к банту (зеркальце) 0…1 и «поправляет» 0…1 */
  bow: number;
  bowPat: number;
  /** пар над кружкой 0…1 */
  steam: number;
  /** рыбка: сколько откушено 0…1 (длина от головы) */
  eaten: number;
  /** искра появления / ухода 0…1 (0 — нет) */
  spark: number;
  /** мимика такта поверх лица: веса блендшейпов и глаз (eyes_laugh — «^^») */
  face: Record<string, number>;
}

const ss = (x: number) => {
  const k = Math.max(0, Math.min(1, x));
  return k * k * (3 - 2 * k);
};
/** окно [a, b] с плавным входом/выходом длиной e (с) */
const win = (t: number, a: number, b: number, e = 0.15) => Math.min(ss((t - a) / e), ss((b - t) / e));

/** поза шаблона в момент t (с от старта) — чистая функция */
export function holdPose(s: HoldSpec, t: number): HoldFrame {
  let acc = 0;
  for (const ph of PHASES) {
    const d = s.t[ph];
    if (t < acc + d) return frame(s, ph, (t - acc) / d, t - acc);
    acc += d;
  }
  return { ...blank('done'), k: 1, w: 0, grip: 0, scale: 0 };
}

function blank(phase: HoldPhase): HoldFrame {
  return { phase, k: 0, w: 1, grip: 1, toMouth: 0, scale: 1, tilt: 0, headPitch: 0, headYaw: 0, headRoll: 0, peck: 0, bow: 0, bowPat: 0, steam: 0, eaten: 0, spark: 0, face: {} };
}

/** глотки какао: [начало, конец] в фазе use, с */
export const SIPS: [number, number][] = [
  [0.2, 0.85],
  [1.05, 1.7],
];
/** укусы рыбки, с от начала use */
export const BITES = [0.25, 1.25];

function frame(s: HoldSpec, ph: Exclude<HoldPhase, 'done'>, k: number, tt: number): HoldFrame {
  const f = blank(ph);
  f.k = k;
  const e = ss(k);
  const U = s.t.use;
  const face = f.face;
  switch (ph) {
    case 'take':
      f.w = e;
      f.grip = ss(k * 1.6 - 0.3);
      // из искры: предмет растёт с лёгким «перелётом» (1.08) и садится в кулак
      f.scale = k < 0.75 ? ss(k / 0.75) * 1.08 : 1.08 - 0.08 * ss((k - 0.75) / 0.25);
      f.spark = k;
      f.steam = 0.5 * e;
      face.smile = 0.5 * e;
      face.eyes_wide = 0.25 * Math.sin(k * Math.PI);
      break;
    case 'raise':
      f.toMouth = e;
      f.steam = 0.5 + 0.5 * e;
      f.headPitch = (s.use === 'look' ? 0.03 : s.use === 'sip' ? 0.16 : 0.1) * e;
      f.headYaw = 0.5 * e;
      face.smile = 0.5 + 0.2 * e;
      if (s.use === 'bite' || s.use === 'pop') face.mouth_A = 0.25 * e;
      break;
    case 'use':
      f.toMouth = 1;
      if (s.use === 'sip') {
        f.steam = 1 - 0.3 * ss((tt - 1.7) / 0.6);
        let sip = 0;
        for (const [a, b] of SIPS) sip = Math.max(sip, win(tt, a, b, 0.18));
        f.tilt = 0.55 * sip;
        f.headPitch = 0.16 + 0.12 * sip;
        f.headYaw = 0.5;
        // «ах»: кружку чуть от морды, голова назад, рот открыт, глаза «^^»
        const ah = ss((tt - 1.85) / 0.3) * (1 - ss((tt - (U - 0.15)) / 0.15));
        f.toMouth = 1 - 0.25 * ah;
        f.headPitch -= 0.26 * ah;
        face.eyes_laugh = Math.max(0.85 * sip, 0.8 * ah, 0.5 * win(tt, 0.85, 1.05, 0.1));
        face.smile = 0.55 + 0.4 * ah;
        face.mouth_U = 0.35 * sip;
        face.mouth_A = 0.6 * ah;
        face.cheek_up = 0.6 * Math.max(sip, ah);
        face.blush = 0.5 * ah;
      } else if (s.use === 'bite') {
        let bite = 0;
        for (const b of BITES) bite = Math.max(bite, win(tt, b - 0.18, b + 0.12, 0.12));
        f.peck = bite;
        f.headPitch = 0.1 + 0.06 * bite;
        f.headYaw = 0.5;
        f.eaten = 0.35 * ss((tt - BITES[0]) / 0.1) + 0.3 * ss((tt - BITES[1]) / 0.1);
        // жуёт: челюсть 4 раза в секунду между укусами, щёки надуты, глаза «^^»
        const chew = Math.max(win(tt, BITES[0] + 0.15, BITES[1] - 0.2, 0.1), win(tt, BITES[1] + 0.15, U - 0.05, 0.1));
        const jaw = 0.5 + 0.5 * Math.sin(tt * Math.PI * 2 * 4);
        face.mouth_A = Math.max(0.75 * bite, 0.3 * chew * jaw);
        face.mouth_M = 0.4 * chew * (1 - jaw);
        face.cheeks_gum = 0.45 * chew;
        face.eyes_laugh = 0.75 * chew;
        face.smile = 0.5 + 0.3 * chew;
      } else if (s.use === 'look') {
        // кокетливо: голова туда-сюда к зеркальцу с наклоном к плечу
        const flirt = win(tt, 0.0, 1.0, 0.2);
        f.headYaw = 0.65 + 0.35 * Math.sin(tt * Math.PI * 2 * 1.1) * flirt;
        f.headRoll = 0.16 * Math.sin(tt * Math.PI * 2 * 1.1 + 0.6) * flirt;
        f.tilt = 0.1 * Math.sin(tt * Math.PI * 2 * 0.7);
        f.headPitch = 0.03;
        // поправить бант второй лапой
        f.bow = win(tt, 0.85, 2.05, 0.3);
        f.bowPat = f.bow * (0.5 + 0.5 * Math.sin((tt - 0.85) * Math.PI * 2 * 2.2));
        f.headRoll += -0.14 * f.bow; // голова к лапе у банта
        // подмигнуть и «чмок» в зеркальце
        const wink = win(tt, 2.1, 2.5, 0.08);
        const kiss = win(tt, 2.6, 3.05, 0.1);
        f.peck = 0.25 * kiss;
        face.smile = 0.7 * (1 - kiss) + 0.25;
        face.cheek_up = 0.5;
        face.blush = 0.35 + 0.35 * kiss;
        face[s.hand === 'Left' ? 'wink_R' : 'wink_L'] = wink;
        face.mouth_U = kiss;
        face.eyes_laugh = 0.6 * kiss;
        face.brow_up = 0.3 * flirt;
      } else {
        // pop: в рот (предмет уменьшается у рта) → жуёт с надутыми щеками
        f.peck = ss(tt / 0.35);
        f.scale = 1 - ss((tt - 0.15) / 0.3);
        f.headPitch = 0.08;
        f.headYaw = 0.4;
        const chew = ss((tt - 0.45) / 0.15);
        const jaw = 0.5 + 0.5 * Math.sin(tt * Math.PI * 2 * 3.5);
        face.mouth_A = Math.max(0.6 * (1 - chew) * ss(tt / 0.2), 0.25 * chew * jaw);
        face.mouth_M = 0.45 * chew * (1 - jaw);
        face.cheeks_gum = 0.7 * chew;
        face.eyes_laugh = 0.4 * chew;
        face.smile = 0.4;
      }
      break;
    case 'lower':
      f.toMouth = 1 - e;
      f.headPitch = 0.06 * (1 - e);
      f.headYaw = 0.5 * (1 - e);
      f.steam = 0.7;
      if (s.use === 'pop') f.scale = 0;
      if (s.use === 'bite') f.eaten = 0.65;
      face.smile = 0.75;
      face.cheek_up = 0.4;
      break;
    case 'away':
      f.w = 1 - e;
      f.grip = 1 - e;
      f.scale = s.use === 'pop' ? 0 : 1 - ss(k * 1.5);
      f.spark = s.use === 'pop' ? 0 : k;
      f.steam = 0.7 * (1 - e);
      if (s.use === 'bite') f.eaten = 0.65;
      face.smile = 0.7 * (1 - e);
      break;
  }
  if (s.use !== 'sip') f.steam = 0;
  return f;
}
