/**
 * Процедурные заглушки всех клипов content/animations.json для рига (до финальной модели).
 * Кости — имена Mixamo + Tail1..4, LeftEar1/RightEar1, Jaw. Оси костей рига: +Z — вперёд, +Y — вверх, +X — влево кота.
 * Знаки: Arm z (Left +, Right −) — поднять руку в сторону; Arm x − — вперёд; ForeArm x − — согнуть локоть;
 * UpLeg x − — колено вперёд/вверх; Leg x + — согнуть колено; Spine1 x + — наклон вперёд; Head x − — поднять голову;
 * Tail1 x + — хвост вверх; Ear1 x + — уши вперёд/торчком, − — прижать назад.
 * k — нормированное время 0..1 (для петель — фаза), t — секунды с начала клипа.
 */
import { clamp } from '../core/util';

export type V3 = [number, number, number];
export interface Pose {
  b: Record<string, V3>;
  root?: { x?: number; y?: number; z?: number; rx?: number; ry?: number; rz?: number; s?: number };
  jaw?: number;
  lids?: number;
  /** масштаб костей (хвост трубой) */
  sc?: Record<string, number>;
}
export type ClipFn = (k: number, t: number) => Pose;

const S = Math.sin;
const C = Math.cos;
const PI = Math.PI;
export const tri = (k: number) => S(clamp(k, 0, 1) * PI);
export const smooth = (k: number) => {
  k = clamp(k, 0, 1);
  return k * k * (3 - 2 * k);
};
/** окно: 0 → 1 за [a, a+r], 1 до b, → 0 за [b, b+r] */
const win = (k: number, a: number, b: number, r = 0.12) => smooth((k - a) / r) * (1 - smooth((k - b) / r));
/** затухающая пружина от удара в t=0 */
const spring = (t: number, f = 14, d = 5) => S(t * f) * Math.exp(-t * d);

const idleBreathe: ClipFn = (_k, t) => ({
  b: {
    Spine1: [0.03 * S(t * 1.8), 0, 0.02 * S(t * 0.9)],
    Head: [0.04 * S(t * 1.3), 0.15 * S(t * 0.6), 0.04 * S(t * 0.5)],
    LeftArm: [0.05 * S(t * 2), 0, 0.12 + 0.04 * S(t * 2)],
    RightArm: [0.05 * S(t * 2 + 1), 0, -0.12 - 0.04 * S(t * 2 + 1)],
    Tail1: [0.2, 0.5 * S(t * 1.5), 0],
    Tail2: [0.2, 0.3 * S(t * 1.5 - 0.6), 0],
    Tail3: [0.2, 0.3 * S(t * 1.5 - 1.2), 0],
  },
  root: { y: 0.004 * S(t * 3.6), s: 1 + 0.008 * S(t * 1.8) },
});

const walk: ClipFn = (k) => {
  const p = k * PI * 2;
  return {
    b: {
      LeftUpLeg: [0.6 * S(p), 0, 0], RightUpLeg: [-0.6 * S(p), 0, 0],
      LeftLeg: [Math.max(0, -0.7 * S(p + 0.6)), 0, 0], RightLeg: [Math.max(0, 0.7 * S(p + 0.6)), 0, 0],
      LeftArm: [-0.5 * S(p), 0, 0.15], RightArm: [0.5 * S(p), 0, -0.15],
      Spine1: [0.08, 0.1 * S(p), 0], Head: [-0.05, -0.08 * S(p), 0],
      Tail1: [0.3, 0.3 * S(p), 0], Tail2: [0.2, 0.3 * S(p - 0.5), 0],
    },
    root: { y: 0.025 * Math.abs(S(p)) },
  };
};

const run: ClipFn = (k) => {
  const p = k * PI * 2;
  return {
    b: {
      LeftUpLeg: [1.0 * S(p), 0, 0], RightUpLeg: [-1.0 * S(p), 0, 0],
      LeftLeg: [Math.max(0, -1.1 * S(p + 0.6)), 0, 0], RightLeg: [Math.max(0, 1.1 * S(p + 0.6)), 0, 0],
      LeftArm: [-0.9 * S(p), 0, 0.2], RightArm: [0.9 * S(p), 0, -0.2],
      LeftForeArm: [-0.8, 0, 0], RightForeArm: [-0.8, 0, 0],
      Spine1: [0.25, 0.12 * S(p), 0], Head: [-0.2, 0, 0],
      Tail1: [0.9, 0.2 * S(p), 0], LeftEar1: [-0.6, 0, 0], RightEar1: [-0.6, 0, 0],
    },
    root: { y: 0.05 * Math.abs(S(p)) },
  };
};

const jump: ClipFn = (k) => {
  const crouch = (k < 0.25 ? tri(k / 0.25) : 0) + (k > 0.85 ? tri((k - 0.85) / 0.15) : 0);
  const air = k > 0.2 && k < 0.88 ? S(((k - 0.2) / 0.68) * PI) : 0;
  return {
    b: {
      LeftUpLeg: [-0.9 * crouch + 0.3 * air, 0, 0], RightUpLeg: [-0.9 * crouch + 0.3 * air, 0, 0],
      LeftLeg: [1.4 * crouch, 0, 0], RightLeg: [1.4 * crouch, 0, 0],
      LeftArm: [-0.3 * crouch, 0, 1.2 * air + 0.1], RightArm: [-0.3 * crouch, 0, -1.2 * air - 0.1],
      Spine1: [0.3 * crouch - 0.15 * air, 0, 0], Head: [-0.2 * air, 0, 0],
      Tail1: [1.0 * air, 0, 0],
    },
    root: { y: 0.45 * air - 0.08 * crouch },
  };
};

const flip: ClipFn = (k) => {
  const air = k > 0.15 && k < 0.85 ? (k - 0.15) / 0.7 : k >= 0.85 ? 1 : 0;
  const tuck = tri(air);
  return {
    b: {
      LeftUpLeg: [-1.4 * tuck, 0, 0], RightUpLeg: [-1.4 * tuck, 0, 0],
      LeftLeg: [1.8 * tuck, 0, 0], RightLeg: [1.8 * tuck, 0, 0],
      LeftArm: [-1.0 * tuck, 0, 0.3 + 1.4 * win(k, 0.85, 1.1)], RightArm: [-1.0 * tuck, 0, -0.3 - 1.4 * win(k, 0.85, 1.1)],
      Spine1: [0.4 * tuck, 0, 0], Head: [0.3 * tuck, 0, 0],
    },
    root: { y: 0.55 * S(air * PI), rx: -smooth(air) * PI * 2 },
  };
};

const tumble: ClipFn = (k) => {
  const roll = smooth((k - 0.15) / 0.6);
  const curl = tri((k - 0.1) / 0.7);
  const dust = win(k, 0.82, 1.1, 0.05);
  return {
    b: {
      Spine1: [0.8 * curl, 0, 0], Neck: [0.5 * curl, 0, 0], Head: [0.4 * curl, 0, 0],
      LeftUpLeg: [-1.5 * curl, 0, 0], RightUpLeg: [-1.5 * curl, 0, 0], LeftLeg: [1.8 * curl, 0, 0], RightLeg: [1.8 * curl, 0, 0],
      LeftArm: [-1.2 * curl, 0, 0.3 * dust * S(k * 80)], RightArm: [-1.2 * curl, 0, -0.3 * dust * S(k * 80)],
    },
    root: { y: 0.12 * S(roll * PI) - 0.15 * curl, z: 0.25 * roll, rx: roll * PI * 2 },
  };
};

const sitPose = (d: number, t = 0, dangle = 0): Pose => ({
  b: {
    LeftUpLeg: [-1.5 * d, 0, 0.15 * d], RightUpLeg: [-1.5 * d, 0, -0.15 * d],
    LeftLeg: [0.2 * d + dangle * 0.4 * (1 + S(t * 3)), 0, 0], RightLeg: [0.2 * d + dangle * 0.4 * (1 + S(t * 3 + PI)), 0, 0],
    Spine1: [-0.15 * d, 0, 0], Tail1: [1.2 * d, 0.3 * d * S(t), 0],
    LeftArm: [-0.2 * d, 0, 0.1], RightArm: [-0.2 * d, 0, -0.1],
  },
  root: { y: -0.14 * d },
});

const knockGlass: ClipFn = (k, t) => ({
  b: { RightArm: [-1.4 * tri(k), 0, -0.1], RightForeArm: [-0.6 * tri(k) - 0.5 * Math.max(0, S(t * 16)) * tri(k), 0, 0], Spine1: [0.15 * tri(k), 0, 0], Head: [-0.1 * tri(k), 0, 0] },
  root: { z: 0.06 * tri(k) },
});

const pressGlass: ClipFn = (k, t) => {
  const p = Math.min(1, t / 0.3);
  return {
    b: { Spine1: [0.3 * p, 0, 0], Head: [0.15 * p, 0, 0.35 * p], LeftArm: [-1.5 * p, 0, 0.2], RightArm: [-1.5 * p, 0, -0.2] },
    root: { z: 0.12 * p, s: 1 + 0.02 * S(t * 3) },
    lids: 0.7 * p,
  };
  void k;
};

const scratch: ClipFn = (k, t) => ({
  b: { RightArm: [-1.5 * tri(k), 0, -0.4 * S(t * 14)], LeftArm: [-1.5 * tri(k), 0, 0.4 * S(t * 14 + 1)], Spine1: [0.2 * tri(k), 0, 0] },
  root: { z: 0.05 * tri(k) },
  jaw: 0.3 * tri(k),
});

const stickerSlap: ClipFn = (k) => {
  const hit = tri(k / 0.5);
  return { b: { RightArm: [-1.6 * hit, 0, -0.2], RightForeArm: [-0.3 * hit, 0, 0], Spine1: [0.12 * hit, 0, 0], Head: [-0.1 * hit, 0, 0] }, root: { z: 0.08 * hit } };
};

const talk: ClipFn = (_k, t) => ({ b: { Head: [0.05 * S(t * 6), 0.06 * S(t * 2), 0], RightArm: [-0.35 - 0.15 * S(t * 3), 0, -0.25], RightForeArm: [-0.4 * S(t * 3) - 0.3, 0, 0] } });

const talkExcited: ClipFn = (_k, t) => ({
  b: {
    Head: [0.08 * S(t * 8), 0.1 * S(t * 3), 0.05 * S(t * 4)],
    RightArm: [-0.5 - 0.3 * S(t * 5), 0, -0.4 - 0.3 * Math.max(0, S(t * 2.5))], RightForeArm: [-0.6 - 0.3 * S(t * 5), 0, 0],
    LeftArm: [-0.4 - 0.25 * S(t * 5 + 1.5), 0, 0.4 + 0.3 * Math.max(0, S(t * 2.5 + 2))], LeftForeArm: [-0.5, 0, 0],
    Spine1: [0, 0.1 * S(t * 2.5), 0], Tail1: [0.5, 0.5 * S(t * 6), 0],
  },
  root: { y: 0.025 * Math.abs(S(t * 5)) },
});

const listen: ClipFn = (_k, t) => ({ b: { Head: [0.05, 0, 0.28 + 0.03 * S(t * 1.3)], Spine1: [0.05, 0, 0.04], LeftEar1: [0.35, 0, 0], RightEar1: [0.35, 0, 0], RightArm: [-0.3, 0, -0.9], RightForeArm: [-1.4, 0, 0] } });

const laugh: ClipFn = (k, t) => ({
  b: { Spine1: [-0.15 * tri(k) + 0.08 * S(t * 25) * tri(k), 0, 0], Head: [-0.3 * tri(k), 0, 0], LeftArm: [-0.6 * tri(k), 0, 0.3], RightArm: [-0.6 * tri(k), 0, -0.3], LeftForeArm: [-1.2 * tri(k), 0, 0], RightForeArm: [-1.2 * tri(k), 0, 0] },
  root: { y: 0.02 * Math.abs(S(t * 25)) * tri(k) },
  jaw: 0.8 * tri(k), lids: 0.8 * tri(k),
});

const dance: ClipFn = (k, t) => ({
  b: { Hips: [0, 0, 0.15 * S(t * 8)], Spine1: [0, 0.25 * S(t * 4), -0.15 * S(t * 8)], LeftArm: [0, 0, 1.6 + 0.4 * S(t * 8)], RightArm: [0, 0, -1.6 + 0.4 * S(t * 8)], Head: [0, 0, 0.2 * S(t * 8)], LeftUpLeg: [0.3 * Math.max(0, S(t * 8)), 0, 0], RightUpLeg: [0.3 * Math.max(0, -S(t * 8)), 0, 0] },
  root: { y: 0.03 * Math.abs(S(t * 8)), ry: 0.4 * S(t * 2) * Math.min(1, k * 4) },
});

const gumBlow: ClipFn = (k, t) => ({
  b: { Head: [-0.35 * win(k, 0.05, 0.75), 0, 0.05 * S(t * 3)], Spine1: [-0.12 * win(k, 0.05, 0.75), 0, 0], RightArm: [-1.0 * win(k, 0.78, 0.98), 0, -0.25], RightForeArm: [-1.4 * win(k, 0.78, 0.98), 0, 0], LeftArm: [0, 0, 0.25 * tri(k)] },
  jaw: 0.25 * win(k, 0.05, 0.75), lids: 0.4 * win(k, 0.1, 0.75),
  root: { y: k > 0.78 && k < 0.85 ? 0.04 : 0 },
});

const glitterThrow: ClipFn = (k) => {
  const reach = win(k, 0, 0.35, 0.15);
  const thr = win(k, 0.35, 0.7, 0.08);
  return {
    b: { RightArm: [0.4 * reach - 1.6 * thr, 0, -0.3], RightForeArm: [-1.0 * reach, 0, 0], LeftArm: [0, 0, 1.0 * thr], Head: [-0.2 * thr, 0, 0], Spine1: [-0.1 * reach + 0.15 * thr, 0, 0] },
    root: { y: 0.08 * thr, z: 0.05 * thr },
    jaw: 0.5 * thr,
  };
};

const breathDraw: ClipFn = (k, t) => {
  const breath = win(k, 0, 0.35, 0.1);
  const draw = win(k, 0.35, 0.95, 0.1);
  const a = ((k - 0.35) / 0.6) * PI * 2;
  return {
    b: {
      Spine1: [0.25 * (breath + draw), 0, 0], Head: [0.1 * breath, 0, 0],
      RightArm: [-1.5 * draw + 0.35 * C(a) * draw, 0, -0.35 * S(a) * draw], RightForeArm: [-0.3 * draw, 0, 0],
    },
    root: { z: 0.12 * Math.max(breath, draw) },
    jaw: 0.6 * breath * (0.7 + 0.3 * S(t * 10)),
  };
};

/** удар → затухающая реакция */
const poke = (mk: (sp: number, k: number, t: number) => Pose): ClipFn => (k, t) => mk(spring(t), k, t);

export const RIG_CLIPS: Record<string, ClipFn> = {
  // ── покой ──
  idle_breathe: idleBreathe,
  idle_look_around: (k, t) => {
    const yaw = 0.7 * S(k * PI * 2) * win(k, 0, 0.8, 0.15);
    return { ...idleBreathe(k, t), b: { ...idleBreathe(k, t).b, Head: [0.05 * S(k * PI * 4), yaw, 0.1 * yaw], Spine1: [0, yaw * 0.3, 0] } };
  },
  idle_stretch: (k) => {
    const s = win(k, 0.05, 0.75, 0.2);
    return {
      b: { LeftArm: [-0.4 * s, 0, 2.6 * s], RightArm: [-0.4 * s, 0, -2.6 * s], LeftForeArm: [0, 0, 0], Spine1: [-0.25 * s, 0, 0], Head: [-0.3 * s, 0, 0], Tail1: [1.3 * s, 0, 0], Tail2: [0.3 * s, 0, 0] },
      root: { y: 0.03 * s, s: 1 + 0.04 * s },
      jaw: 0.5 * win(k, 0.3, 0.6), lids: 0.9 * win(k, 0.25, 0.65),
    };
  },
  idle_yawn: (k) => {
    const y = win(k, 0.1, 0.7, 0.15);
    return { b: { Head: [-0.35 * y, 0, 0.1 * y], Spine1: [-0.1 * y, 0, 0], RightArm: [-1.2 * y, 0, -0.3], RightForeArm: [-1.4 * y, 0, 0], LeftEar1: [-0.4 * y, 0, 0], RightEar1: [-0.4 * y, 0, 0] }, jaw: y, lids: 0.85 * y };
  },
  idle_tail_play: (k, t) => {
    const w = win(k, 0.05, 0.85, 0.15);
    return {
      b: { Head: [0.3 * w, -0.8 * w, 0], Spine1: [0.3 * w, -0.4 * w, 0], LeftArm: [-1.0 * w, 0, 0.3 * S(t * 9) * w], RightArm: [-1.0 * w, 0, -0.3 * S(t * 9 + 1) * w], Tail1: [0.4, 1.0 * w * S(t * 5), 0], Tail2: [0.3, 0.6 * w * S(t * 5 - 0.5), 0] },
      root: { ry: 1.6 * S(k * PI) * w },
    };
  },
  idle_hooligan_skate: (k, t) => {
    const kick = win(k, 0.1, 0.3, 0.06), cat = win(k, 0.3, 0.45, 0.06), ride = win(k, 0.45, 0.95, 0.1);
    return {
      b: {
        RightUpLeg: [-1.1 * kick - 0.6 * ride, 0, 0], RightLeg: [0.8 * kick + 0.5 * ride, 0, 0], LeftUpLeg: [-0.5 * ride, 0, 0], LeftLeg: [0.6 * ride, 0, 0],
        RightArm: [-1.1 * cat, 0, -0.2 - 0.6 * ride], LeftArm: [0, 0, 0.6 * ride + 0.2 * S(t * 3) * ride], RightForeArm: [-0.8 * cat, 0, 0],
        Spine1: [0.1 * ride, 0.3 * ride, 0.1 * S(t * 3) * ride], Head: [0, -0.3 * ride, 0], Tail1: [0.6 * ride, 0.3 * S(t * 3), 0],
      },
      root: { y: -0.05 * ride + 0.06 * kick, x: 0.03 * S(t * 3) * ride, ry: 0.5 * ride },
    };
  },
  idle_hooligan_headphones: (_k, t) => {
    const beat = Math.abs(S(t * PI * 2));
    return {
      b: { Head: [0.12 * beat, 0.1 * S(t * PI), 0.06 * S(t * PI * 2)], Spine1: [0.04 * beat, 0, 0], RightArm: [-0.6, 0, -0.35], RightForeArm: [-1.0 - 0.25 * beat, 0, 0], LeftArm: [0.05, 0, 0.2], Tail1: [0.3, 0.5 * S(t * PI * 2), 0] },
      root: { y: -0.01 * beat },
      lids: 0.5,
    };
  },
  idle_kind_hug_self: (k, t) => {
    const h = win(k, 0.08, 0.85, 0.15);
    return { b: { LeftArm: [-1.1 * h, -0.3 * h, -0.3 * h], RightArm: [-1.1 * h, 0.3 * h, 0.3 * h], LeftForeArm: [-1.5 * h, 0, 0], RightForeArm: [-1.5 * h, 0, 0], Head: [0.1 * h, 0, 0.18 * S(t * 1.6) * h], Spine1: [0, 0, 0.08 * S(t * 1.6) * h] }, lids: 0.95 * h };
  },
  idle_kind_cocoa: (k, t) => {
    const hold = win(k, 0.05, 0.92, 0.12), sip = win(k, 0.35, 0.55, 0.08) + win(k, 0.65, 0.8, 0.08);
    return { b: { RightArm: [-0.8 * hold - 0.4 * sip, 0, -0.15], RightForeArm: [-1.2 * hold - 0.4 * sip, 0, 0], LeftArm: [-0.6 * hold, 0, 0.1], LeftForeArm: [-1.0 * hold, 0, 0], Head: [0.12 * hold - 0.2 * sip, 0, 0] }, jaw: 0.25 * win(k, 0.15, 0.3) * (0.6 + 0.4 * S(t * 12)), lids: 0.5 * sip };
  },
  idle_glitter_mirror: (k, t) => {
    const m = win(k, 0.05, 0.9, 0.12), fix = win(k, 0.4, 0.75, 0.1);
    return { b: { Spine1: [0.15 * m, 0, 0], Head: [0.05 * m, 0.15 * S(t * 2) * m, 0.25 * S(t * 1.5) * m], LeftArm: [-0.3 * fix, 0, 2.2 * fix], LeftForeArm: [-1.3 * fix, 0, 0.2 * S(t * 9) * fix], LeftEar1: [0.2 * fix * S(t * 9), 0, 0] }, root: { z: 0.06 * m } };
  },
  idle_glitter_twirl: (k) => {
    const w = win(k, 0.05, 0.9, 0.12);
    return { b: { LeftArm: [0, 0, 1.3 * w], RightArm: [0, 0, -1.3 * w], Head: [-0.15 * w, 0, 0], Tail1: [1.1 * w, 0, 0] }, root: { ry: smooth((k - 0.05) / 0.8) * PI * 2, y: 0.02 * w } };
  },
  // ── появление / уход / карта ──
  appear_jump_in: (k) => {
    const j = jump(clamp(k * 1.1, 0, 1), 0);
    const shake = win(k, 0.8, 1.1, 0.05);
    return { ...j, b: { ...j.b, Head: [0, 0.4 * shake * S(k * 90), 0] }, root: { ...j.root, y: (j.root?.y ?? 0) - 0.5 * (1 - smooth(k * 3)), s: Math.min(1, 0.15 + k * 2.5), ry: (1 - smooth(k * 1.3)) * PI * 2 } };
  },
  dive_out: (k, t) => {
    const wave = win(k, 0, 0.45, 0.1), dive = smooth((k - 0.5) / 0.45);
    return {
      b: { RightArm: [0, 0, -2.3 * wave], RightForeArm: [0, 0, -0.5 * S(t * 12) * wave], LeftArm: [0, 0, 1.6 * dive], Spine1: [0.5 * dive, 0, 0], Head: [0.4 * dive, 0, 0], LeftUpLeg: [-0.8 * dive, 0, 0], RightUpLeg: [-0.8 * dive, 0, 0] },
      root: { y: 0.25 * tri((k - 0.45) / 0.25) - 1.0 * smooth((k - 0.65) / 0.35), s: 1 - 0.8 * smooth((k - 0.7) / 0.3), rx: 0.8 * dive },
    };
  },
  fall_off_card: (k, t) => {
    const flail = win(k, 0, 0.75, 0.1);
    return {
      b: { LeftArm: [-0.5, 0, 1.6 + 0.8 * S(t * 18)], RightArm: [-0.5, 0, -1.6 - 0.8 * S(t * 18 + 1)], LeftUpLeg: [-0.6 * S(t * 14) * flail, 0, 0], RightUpLeg: [0.6 * S(t * 14) * flail, 0, 0], Spine1: [-0.3 * flail, 0, 0], Head: [-0.2 * flail, 0, 0], Tail1: [1.2 * flail, 0, 0] },
      root: { y: 0.1 * tri(k / 0.3) - 0.15 * smooth((k - 0.3) / 0.4), z: 0.3 * smooth((k - 0.5) / 0.5), rz: 0.4 * S(t * 6) * flail },
      jaw: 0.6 * flail,
    };
  },
  peek_from_edge: (_k, t) => {
    const look = S(t * 1.6);
    return {
      b: { Spine1: [0.1, 0, -0.35], Head: [0.05, 0.3 * look, -0.25], LeftEar1: [0.35, 0, 0], RightEar1: [0.35, 0, 0], LeftArm: [-1.3, 0, 0.6], LeftForeArm: [-0.6, 0, 0] },
      root: { x: -0.32 + 0.04 * S(t * 0.8), rz: 0.35, y: -0.05 },
    };
  },
  // ── перемещение ──
  walk,
  run,
  turn_left: (k) => ({ b: { Head: [0, 0.4 * tri(k), 0], LeftUpLeg: [0.4 * S(k * 12), 0, 0], RightUpLeg: [-0.4 * S(k * 12), 0, 0] }, root: { ry: smooth(k) * PI / 2 } }),
  turn_right: (k) => ({ b: { Head: [0, -0.4 * tri(k), 0], LeftUpLeg: [0.4 * S(k * 12), 0, 0], RightUpLeg: [-0.4 * S(k * 12), 0, 0] }, root: { ry: -smooth(k) * PI / 2 } }),
  jump,
  flip,
  tumble,
  dizzy: (k, t) => {
    const d = win(k, 0, 0.85, 0.1);
    return { b: { Head: [0.15 * S(t * 7) * d, 0.2 * C(t * 7) * d, 0.2 * S(t * 7) * d], Spine1: [0, 0, 0.12 * S(t * 3.5) * d], LeftArm: [0, 0, 0.5 * d], RightArm: [0, 0, -0.5 * d], LeftEar1: [-0.4 * d, 0, 0], RightEar1: [-0.4 * d, 0, 0] }, root: { rz: 0.1 * S(t * 3.5) * d, x: 0.03 * S(t * 3.5) * d }, jaw: 0.3 * d };
  },
  // ── сидеть / спать ──
  sit_down: (k) => sitPose(smooth(k)),
  sit_idle: (_k, t) => sitPose(1, t, 1),
  stand_up: (k) => sitPose(1 - smooth(k)),
  sleep_loop: (_k, t) => {
    const s = sitPose(1, t);
    return { ...s, b: { ...s.b, Spine1: [0.9, 0, 0], Neck: [0.4, 0, 0], Head: [0.5, 0, 0.3], LeftArm: [-1.2, 0, -0.2], RightArm: [-1.2, 0, 0.2], LeftForeArm: [-1.2, 0, 0], RightForeArm: [-1.2, 0, 0], Tail1: [-0.2, 1.2, 0], LeftEar1: [-0.5, 0, 0], RightEar1: [-0.5, 0, 0] }, root: { y: -0.24, s: 1 + 0.025 * S(t * 1.6) }, lids: 1 };
  },
  // ── кровать (мир кота, src/home/bedFlow.ts): путь корня — у сцены, здесь только поза ──
  walk_to_bedside: (k, t) => RIG_CLIPS.walk(k, t),
  get_into_bed: (k, t) => jump(k, t),
  lie_down_side: (k, t) => {
    const s = RIG_CLIPS.sleep_loop(k, t);
    return { ...s, root: { ...s.root, y: (s.root?.y ?? 0) * smooth(k) } };
  },
  sleep_loop_bed: (k, t) => RIG_CLIPS.sleep_loop(k, t),
  turn_over_sleep: (k, t) => {
    const s = RIG_CLIPS.sleep_loop(k, t);
    return { ...s, root: { ...s.root, rz: 0.25 * S(k * PI) } };
  },
  wake_stretch_in_bed: (k, t) => RIG_CLIPS.idle_stretch(k, t),
  hop_out_of_bed: (k, t) => jump(k, t),
  wake_startle: (k, t) => {
    const jolt = tri(k / 0.25), rub = win(k, 0.35, 0.95, 0.1);
    return {
      b: { LeftArm: [0, 0, 1.2 * jolt], RightArm: [-1.3 * rub, 0, -1.2 * jolt], RightForeArm: [-1.5 * rub, 0, 0.4 * S(t * 16) * rub], Spine1: [-0.2 * jolt, 0, 0], Head: [-0.25 * jolt + 0.1 * rub, 0, 0], LeftEar1: [0.4 * jolt, 0, 0], RightEar1: [0.4 * jolt, 0, 0], Tail1: [1.2 * jolt, 0, 0] },
      root: { y: 0.08 * jolt },
      sc: { Tail1: 1 + 0.4 * jolt },
      lids: 0.7 * rub,
    };
  },
  // ── общение ──
  wave: (k, t) => ({
    b: { RightArm: [-0.3 * tri(k), 0, -2.4 * win(k, 0, 0.85, 0.2)], RightForeArm: [0, 0, -0.5 * S(t * 12)], Head: [0, 0, -0.15 * tri(k)], Tail1: [0.5, 0.6 * S(t * 8), 0] },
  }),
  point_button: (k) => {
    const p = win(k, 0.05, 0.85, 0.15);
    return { b: { RightArm: [-0.55 * p, 0, -0.4 * p], RightForeArm: [0.1 * p, 0, 0], RightHand: [0.3 * p, 0, 0], Spine1: [0.12 * p, -0.15 * p, 0], Head: [0.35 * p, -0.2 * p, 0] }, root: { z: 0.04 * p } };
  },
  talk_casual: talk,
  talk_excited: talkExcited,
  listen,
  think: (k, t) => {
    const p = win(k, 0.05, 0.9, 0.15);
    return { b: { RightArm: [-1.1 * p, 0, -0.25], RightForeArm: [-1.7 * p, 0, 0.1 * S(t * 4) * p], LeftArm: [-0.6 * p, 0, 0.1], LeftForeArm: [-1.2 * p, 0, 0], Head: [-0.25 * p, 0.15 * p, 0.15 * p] } };
  },
  laugh,
  shy: (k, t) => {
    const p = win(k, 0.05, 0.85, 0.15);
    return { b: { Head: [0.3 * p, 0.35 * p, 0.15 * p], LeftArm: [-1.1 * p, 0, 0.2], RightArm: [-1.0 * p, 0, -0.2], LeftForeArm: [-1.3 * p, 0, 0], RightForeArm: [-1.4 * p, 0, 0], RightUpLeg: [0, 0, -0.25 * p * (0.5 + 0.5 * S(t * 6))], LeftEar1: [-0.3 * p, 0, 0], RightEar1: [-0.3 * p, 0, 0] } };
  },
  surprised: (k) => {
    const p = tri(k / 0.6) * (k < 0.6 ? 1 : 0) + (k >= 0.6 ? 1 - smooth((k - 0.6) / 0.4) : 0);
    return { b: { Spine1: [-0.3 * p, 0, 0], Head: [-0.2 * p, 0, 0], LeftArm: [-0.4 * p, 0, 1.0 * p], RightArm: [-0.4 * p, 0, -1.0 * p], LeftEar1: [0.4 * p, 0, 0], RightEar1: [0.4 * p, 0, 0], Tail1: [1.3 * p, 0, 0] }, root: { y: 0.06 * tri(k / 0.3), z: -0.05 * p }, sc: { Tail1: 1 + 0.4 * p }, jaw: 0.5 * p };
  },
  offended: (k) => {
    const cross = win(k, 0.05, 0.9, 0.12), away = win(k, 0.05, 0.92, 0.15), glance = win(k, 0.72, 0.9, 0.06);
    return {
      b: { LeftArm: [-1.1 * cross, 0.4 * cross, -0.35 * cross], RightArm: [-1.1 * cross, -0.4 * cross, 0.35 * cross], LeftForeArm: [-1.6 * cross, 0, 0], RightForeArm: [-1.6 * cross, 0, 0], Head: [-0.2 * cross, -0.9 * glance, 0], LeftEar1: [-0.6 * cross, 0, 0], RightEar1: [-0.6 * cross, 0, 0], Tail1: [0.1, 0.6 * cross, 0] },
      root: { ry: 0.9 * away },
    };
  },
  proud: (k) => {
    const p = win(k, 0.05, 0.9, 0.12);
    return { b: { LeftArm: [0.3 * p, 0, 0.8 * p], RightArm: [0.3 * p, 0, -0.8 * p], LeftForeArm: [-1.3 * p, 0, 0], RightForeArm: [-1.3 * p, 0, 0], Spine1: [-0.18 * p, 0, 0], Head: [-0.2 * p, 0, 0.1 * p], Tail1: [1.0 * p, 0, 0] }, root: { y: 0.02 * p, s: 1 + 0.03 * p } };
  },
  comfort: (k, t) => {
    const p = win(k, 0.1, 0.9, 0.2);
    return { b: { Spine1: [0.2 * p, 0, 0], RightArm: [-1.5 * p, 0, -0.1], RightForeArm: [-0.15 * p, 0, 0], Head: [0.12 * p + 0.08 * S(t * 3) * p, 0, 0.15 * p], LeftEar1: [-0.2 * p, 0, 0], RightEar1: [-0.2 * p, 0, 0] }, root: { z: 0.14 * p }, lids: 0.3 * p };
  },
  cover_ears: (k) => {
    const p = win(k, 0, 0.85, 0.1);
    return { b: { LeftArm: [-0.3 * p, 0, 2.5 * p], RightArm: [-0.3 * p, 0, -2.5 * p], LeftForeArm: [-1.3 * p, 0, 0], RightForeArm: [-1.3 * p, 0, 0], Head: [0.15 * p, 0, 0], LeftEar1: [-0.9 * p, 0, 0], RightEar1: [-0.9 * p, 0, 0], Spine1: [0.15 * p, 0, 0] }, root: { y: -0.03 * p }, lids: p };
  },
  lean_in: (k) => {
    const p = win(k, 0.05, 0.9, 0.15);
    return { b: { Spine1: [0.3 * p, 0, 0], Head: [0.1 * p, 0, 0.1 * p], RightArm: [-1.1 * p, 0, -0.3], RightForeArm: [-1.6 * p, 0, 0] }, root: { z: 0.15 * p } };
  },
  celebrate: (k, t) => {
    const p = win(k, 0, 0.9, 0.1);
    return { b: { LeftArm: [0, 0, 2.6 * p], RightArm: [0, 0, -2.6 * p], LeftForeArm: [0, 0, 0.3 * S(t * 12)], RightForeArm: [0, 0, -0.3 * S(t * 12)], Head: [-0.2 * p, 0, 0], Tail1: [1.2 * p, 0.4 * S(t * 10), 0], LeftUpLeg: [-0.3 * Math.abs(S(k * PI * 4)), 0, 0], RightUpLeg: [-0.3 * Math.abs(S(k * PI * 4)), 0, 0] }, root: { y: 0.14 * Math.abs(S(k * PI * 4)) * p }, jaw: 0.6 * p, lids: 0.5 * p };
  },
  sing: (k, t) => {
    const p = win(k, 0.03, 0.95, 0.08);
    return { b: { RightArm: [-1.15 * p, 0, -0.25], RightForeArm: [-1.45 * p, 0, 0], LeftArm: [-0.3 * p, 0, (0.6 + 0.5 * S(t * 2)) * p], Head: [-0.15 * p, 0, 0.15 * S(t * 2) * p], Spine1: [0, 0, 0.08 * S(t * 2) * p] }, root: { rz: 0.04 * S(t * 2) * p }, jaw: (0.3 + 0.4 * Math.abs(S(t * 7))) * p, lids: 0.6 * p };
  },
  // ── стекло ──
  knock_glass: knockGlass,
  press_glass: pressGlass,
  scratch_glass: scratch,
  slide_down_glass: (k, t) => {
    const pg = pressGlass(1, t);
    const sl = smooth((k - 0.2) / 0.7);
    return { ...pg, b: { ...pg.b, LeftArm: [-1.5, 0, 0.2 + 0.4 * sl], RightArm: [-1.5, 0, -0.2 - 0.4 * sl], Head: [0.15, 0, 0.35 - 0.2 * sl] }, root: { z: 0.12, y: -0.25 * sl, rz: 0.05 * S(t * 20) * (1 - sl) } };
  },
  breath_draw: breathDraw,
  hug_screen: (k, t) => {
    const lean = win(k, 0.05, 0.9, 0.15), wrap = win(k, 0.2, 0.85, 0.15);
    return { b: { Spine1: [0.3 * lean, 0, 0], LeftArm: [-1.4 * wrap, 0, 0.9 * lean - 0.5 * wrap], RightArm: [-1.4 * wrap, 0, -0.9 * lean + 0.5 * wrap], LeftForeArm: [-0.6 * wrap, 0, 0], RightForeArm: [-0.6 * wrap, 0, 0], Head: [0.1 * lean, 0, 0.45 * wrap + 0.05 * S(t * 2)] }, root: { z: 0.18 * lean }, lids: 0.9 * wrap };
  },
  sticker_slap: stickerSlap,
  sticker_react: (k) => {
    const p = win(k, 0, 0.85, 0.1);
    const follow = smooth(k / 0.8);
    return { b: { Head: [-0.4 * follow * p, 0.5 * follow * p, 0.15 * p], LeftEar1: [0.3 * p, 0, 0], RightEar1: [0.3 * p, 0, 0], Spine1: [-0.1 * p, 0.2 * follow * p, 0] }, root: { z: 0.04 * p } };
  },
  // ── фирменные ──
  gum_blow: gumBlow,
  kind_bubbles: (k, t) => {
    const hold = win(k, 0.03, 0.7, 0.1), blow = win(k, 0.15, 0.6, 0.08), catchP = win(k, 0.7, 0.98, 0.08);
    return {
      b: { RightArm: [-1.1 * hold, 0, -0.2], RightForeArm: [-1.3 * hold, 0, 0], LeftArm: [-1.3 * catchP, 0, 0.6 * catchP], LeftForeArm: [-0.3 * catchP, 0, 0], Head: [-0.1 * blow, 0, 0], Spine1: [-0.05 * blow, 0, 0] },
      jaw: 0.2 * blow * (0.7 + 0.3 * S(t * 14)), root: { y: 0.04 * catchP },
    };
  },
  glitter_throw: glitterThrow,
  snowglobe_shake: (k, t) => {
    const p = win(k, 0, 0.9, 0.1);
    return { b: { LeftArm: [-0.4 * p, 0, 2.3 * p], RightArm: [-0.4 * p, 0, -2.3 * p], LeftForeArm: [-1.6 * p, 0, 0], RightForeArm: [-1.6 * p, 0, 0], Head: [0.1 * p, 0.4 * S(t * 4) * p, 0], LeftEar1: [-0.5 * p, 0, 0], RightEar1: [-0.5 * p, 0, 0] }, root: { rz: 0.06 * S(t * 9) * p, y: -0.03 * p } };
  },
  // ── касания ──
  purr_stroke: (_k, t) => ({
    b: { Head: [0.05, 0.12 * S(t * 1.5), 0.3 + 0.1 * S(t * 1.5)], Spine1: [0.08, 0, 0.1 * S(t * 1.5)], LeftEar1: [-0.25, 0, 0], RightEar1: [-0.25, 0, 0], Tail1: [0.9, 0.08 * S(t * 40), 0], Tail2: [0.2, 0.08 * S(t * 40 + 1), 0], LeftArm: [-0.2, 0, 0.1], RightArm: [-0.2, 0, -0.1] },
    root: { rz: 0.04 * S(t * 1.5), z: 0.03 },
    lids: 0.75,
  }),
  poke_head: poke((sp, k) => ({ b: { Head: [0.4 * Math.abs(sp) + 0.1 * tri(k), 0, 0.1 * sp], Neck: [0.15 * Math.abs(sp), 0, 0], LeftEar1: [-0.8 * tri(k), 0, 0], RightEar1: [-0.8 * tri(k), 0, 0] }, root: { y: -0.02 * Math.abs(sp) }, lids: 0.6 * tri(k / 0.5) })),
  poke_cheek: poke((sp, k) => ({ b: { Head: [0, 0.15 * sp, -0.4 * Math.abs(sp) - 0.1 * tri(k)], Spine1: [0, 0, -0.1 * Math.abs(sp)] }, root: { rz: -0.04 * Math.abs(sp) }, lids: 0.5 * tri(k / 0.4) })),
  poke_belly: (k, t) => {
    const p = win(k, 0, 0.8, 0.08);
    return { b: { Spine1: [0.6 * p + 0.06 * S(t * 30) * p, 0, 0], Head: [0.3 * p, 0, 0], LeftArm: [-1.0 * p, 0, -0.2 * p], RightArm: [-1.0 * p, 0, 0.2 * p], LeftForeArm: [-1.3 * p, 0, 0], RightForeArm: [-1.3 * p, 0, 0] }, root: { y: -0.04 * p, z: -0.04 * p }, jaw: 0.6 * p, lids: 0.8 * p };
  },
  poke_paw: poke((sp, k, t) => {
    const back = tri(k / 0.4), shake = win(k, 0.35, 0.9, 0.08);
    return { b: { RightArm: [0.7 * back - 0.5 * shake, 0, -0.5 * shake], RightForeArm: [-0.4 * back + 0.4 * S(t * 30) * shake, 0, 0], Spine1: [0, 0.2 * back, 0], Head: [0.2 * shake, 0.3 * shake, 0] }, root: { rz: 0.03 * sp } };
  }),
  poke_tail: (k) => {
    const hop = tri(k / 0.35), turn = win(k, 0.15, 0.75, 0.12);
    return { b: { Tail1: [1.4 * win(k, 0, 0.8, 0.05), 0, 0], Tail2: [0.4, 0, 0], LeftArm: [0, 0, 1.0 * hop], RightArm: [0, 0, -1.0 * hop], Head: [0, 0.7 * turn, 0], LeftEar1: [0.4 * hop, 0, 0], RightEar1: [0.4 * hop, 0, 0] }, root: { y: 0.15 * hop, ry: 0.9 * turn }, sc: { Tail1: 1 + 0.45 * win(k, 0, 0.8, 0.05) }, jaw: 0.4 * hop };
  },
  flinch: (k, t) => {
    const p = Math.exp(-t * 4) * Math.min(1, t / 0.06);
    return { b: { Spine1: [-0.4 * p, 0, 0], Head: [-0.3 * p, 0.2 * p, 0], LeftArm: [-1.1 * p, 0, 0.5 * p], RightArm: [-1.1 * p, 0, -0.5 * p], LeftForeArm: [-1.2 * p, 0, 0], RightForeArm: [-1.2 * p, 0, 0], LeftEar1: [-0.9 * p, 0, 0], RightEar1: [-0.9 * p, 0, 0] }, root: { z: -0.1 * p, y: 0.03 * p }, lids: 0.7 * p };
    void k;
  },
  // ── танцы ──
  dance_hooligan: (k, t) => {
    const wave = S(t * 6);
    const d = dance(k, t);
    return { ...d, b: { ...d.b, LeftArm: [0, 0, 1.4 + 0.5 * wave], RightArm: [0, 0, -1.4 + 0.5 * S(t * 6 - 1.2)], LeftForeArm: [0.6 * S(t * 6 - 0.6), 0, 0], RightForeArm: [0.6 * S(t * 6 - 1.8), 0, 0] } };
  },
  dance_kind: (_k, t) => {
    const clap = Math.max(0, S(t * 5));
    return { b: { LeftArm: [-1.0, 0, 0.5 - 0.4 * clap], RightArm: [-1.0, 0, -0.5 + 0.4 * clap], LeftForeArm: [-0.4, 0, 0], RightForeArm: [-0.4, 0, 0], Spine1: [0, 0, 0.12 * S(t * 2.5)], Head: [0, 0, 0.18 * S(t * 2.5)], Tail1: [0.5, 0.6 * S(t * 2.5), 0] }, root: { x: 0.04 * S(t * 2.5), rz: 0.06 * S(t * 2.5), y: 0.01 * Math.abs(S(t * 5)) }, lids: 0.6 };
  },
  dance_glitter: (k, t) => {
    const ph = (t % 4) / 4;
    const twirl = win(ph, 0, 0.45, 0.08), heart = win(ph, 0.5, 0.95, 0.08);
    return {
      b: { LeftArm: [-0.3 * heart, 0, 1.3 * twirl + 2.5 * heart], RightArm: [-0.3 * heart, 0, -1.3 * twirl - 2.5 * heart], LeftForeArm: [-1.2 * heart, 0, 0], RightForeArm: [-1.2 * heart, 0, 0], Head: [-0.15, 0, 0.15 * S(t * 3)], Tail1: [1.0, 0.3 * S(t * 6), 0], LeftUpLeg: [0.15 * heart, 0, 0], RightUpLeg: [0.15 * heart, 0, 0] },
      root: { ry: smooth(ph / 0.45) * PI * 2 * (ph < 0.5 ? 1 : 0), y: 0.03 * heart + 0.02 * twirl },
      lids: 0.4 * heart,
    };
    void k;
  },
  // ── additive (только уши/хвост) ──
  ear_twitch: (k) => ({ b: { LeftEar1: [0.5 * tri(k / 0.5) * (k < 0.5 ? 1 : 0), 0, -0.3 * S(k * 40) * tri(k)] } }),
  ears_back: (k) => ({ b: { LeftEar1: [-0.9 * win(k, 0, 0.9, 0.15), 0, 0], RightEar1: [-0.9 * win(k, 0, 0.9, 0.15), 0, 0] } }),
  tail_wag: (k) => ({ b: { Tail1: [0.4, 0.8 * S(k * PI * 2), 0], Tail2: [0.1, 0.5 * S(k * PI * 2 - 0.8), 0], Tail3: [0, 0.4 * S(k * PI * 2 - 1.6), 0] } }),
  tail_puff: (k) => ({ b: { Tail1: [1.3 * win(k, 0, 0.8, 0.1), 0, 0], Tail2: [0.2 * win(k, 0, 0.8, 0.1), 0, 0] }, sc: { Tail1: 1 + 0.5 * win(k, 0, 0.8, 0.1), Tail2: 1 + 0.4 * win(k, 0, 0.8, 0.1) } }),
  // ── повтор фразы ──
  echo_speak: (k, t) => {
    const e = talkExcited(k, t);
    return { ...e, b: { ...e.b, Head: [0.12 * S(t * 9), 0.25 * S(t * 3), 0.2 * S(t * 4.5)], LeftEar1: [0.4 * S(t * 6), 0, 0], RightEar1: [0.4 * S(t * 6 + 1), 0, 0] }, jaw: 0.3 + 0.3 * Math.abs(S(t * 8)) };
  },
};
