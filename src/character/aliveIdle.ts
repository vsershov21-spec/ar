/**
 * «Живой» покой Блёстки (запись с iPhone 20.11, 12:38–12:40: «деревянная поза, руки висят, ноги не работают, фатин и
 * хвост неподвижны»). Процедурный слой поверх клипа покоя, без новых клипов:
 *   - перенос веса с ноги на ногу (таз в сторону и чуть вниз, крен таза, корпус и голова — против, стопы стоят: IK ног
 *     к точкам, где они стояли до слоя);
 *   - лёгкое покачивание корпуса, наклон головы (кокетливо), мелкие движения ушей — хвост и уши ведёт tailRig;
 *   - руки не висят палками: позы сменяются раз в 3,5–6 с с плавным переходом — «лапка на поясе», «лапки вместе у
 *     живота», «лапки у щёчек», «свободно» (локти согнуты). Лапы — IK к точкам у тела с запасом (коррекция тела
 *     BodyCollider работает как обычно — без проникновений);
 *   - фатин — пружина от скорости таза (вершинный сдвиг к подолу, tulleFx), хвост — от поворота таза (tailRig).
 * Здесь — расписание (чистая функция alivePose, tests/aliveIdle.test.ts); кости двигает GlbCharacter.applyAlive.
 */

export type ArmPose = 'free' | 'hip' | 'clasp' | 'cheeks';
export const ARM_POSES: ArmPose[] = ['hip', 'free', 'clasp', 'hip', 'cheeks', 'free'];

export interface AliveFrame {
  /** таз вбок (доли роста, + — влево кота), вниз, крен таза (рад) */
  hipX: number;
  hipDown: number;
  hipRoll: number;
  /** корпус: крен и поворот (рад), голова: наклон к плечу и кивок (рад) */
  chestRoll: number;
  chestYaw: number;
  headRoll: number;
  headPitch: number;
  /** веса поз рук (сумма ≤ 1): какая лапа на поясе — hipSide (+1 левая, −1 правая) */
  arms: Record<ArmPose, number>;
  hipSide: 1 | -1;
}

const ss = (x: number) => {
  const k = Math.max(0, Math.min(1, x));
  return k * k * (3 - 2 * k);
};

/** длительность позы рук i (детерминированно 3,5–6 с) */
export function poseDur(i: number): number {
  return 3.5 + ((i * 7919) % 25) / 10;
}

/** поза слоя в момент t (с), w — вес слоя (вход/выход из покоя) */
export function alivePose(t: number, out?: AliveFrame): AliveFrame {
  const f: AliveFrame = out ?? { hipX: 0, hipDown: 0, hipRoll: 0, chestRoll: 0, chestYaw: 0, headRoll: 0, headPitch: 0, arms: { free: 0, hip: 0, clasp: 0, cheeks: 0 }, hipSide: 1 };
  // перенос веса: период 3,6 с, задерживается на ноге (форма — сглаженная «ступенька»)
  const ph = (t / 3.6) * Math.PI * 2;
  const shift = Math.tanh(1.8 * Math.sin(ph)) / Math.tanh(1.8);
  f.hipX = 0.032 * shift;
  f.hipDown = 0.008 * (1 - Math.abs(shift)) + 0.006;
  f.hipRoll = -0.1 * shift;
  // корпус — против таза (контрапост), лёгкое покачивание
  f.chestRoll = 0.08 * shift + 0.02 * Math.sin(t * 1.3);
  f.chestYaw = 0.08 * Math.sin(t * 0.55 + 0.7);
  // голова: кокетливый наклон к плечу, раз в несколько секунд — в другую сторону; лёгкий кивок
  const hs = Math.sin(t * 0.42 + 1.1);
  f.headRoll = 0.16 * Math.tanh(2.2 * hs) + 0.03 * Math.sin(t * 1.7);
  f.headPitch = 0.03 * Math.sin(t * 0.9);
  // руки: позы по кругу, переход 0,6 с
  let acc = 0, i = 0;
  while (acc + poseDur(i) <= t) acc += poseDur(i++);
  const cur = ARM_POSES[i % ARM_POSES.length], prev = ARM_POSES[(i + ARM_POSES.length - 1) % ARM_POSES.length];
  const k = i === 0 ? 1 : ss((t - acc) / 0.6);
  for (const p of Object.keys(f.arms) as ArmPose[]) f.arms[p] = 0;
  f.arms[cur] += k;
  f.arms[prev] += 1 - k;
  // лапка на поясе — со стороны опорной ноги (таз туда и уходит)
  f.hipSide = i % 4 < 2 ? 1 : -1;
  return f;
}
