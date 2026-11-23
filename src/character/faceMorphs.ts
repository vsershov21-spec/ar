/**
 * Мимика морфами (модели p2: scripts/models/face_rig.py — рот геометрией, полость, клычки, язык и ключи лица).
 *
 * Драйвер берёт три слоя и пишет веса морфов во все меши с ключами рига (FaceSkin, его мех-оболочки, полость, клычки,
 * язык, карточки меха, усы, брови):
 *   1) липсинк: визема Rhubarb (A–H, X) → ключ vis_A…vis_H с линейным кроссфейдом LIP_FADE_S (75 мс, в пределах
 *      60–90 мс); без виземы (анализ звука / ?lips=amp без cues) — амплитудный фолбэк: раскрытие 0..1 → смесь vis_B/C/D;
 *   2) лицо (пресеты content/face.json, эмоции, микромимика, действия с предметом) — логические веса прежних имён
 *      (smile, mouth_A, eyes_squint, brow_down…) переводятся в ключи p2 (mapFace): mouth_A → vis_D или smile_open
 *      (с улыбкой), mouth_O → surprise, mouth_U → vis_F, mouth_M → vis_A, eyes_squint/laugh/smug/sleepy → squint кожи,
 *      хмурые брови + морщинка/надутость → brow_angry; веки-накладки и яблоки глаз по-прежнему двигает eyeRig;
 *   3) моргание (blink_L/R кожи век) — из того же W, что получает eyeRig.
 * Во время речи открытые формы рта эмоций приглушаются (рот говорит, улыбка и брови остаются).
 * Сроки и сбросы лица (≤ 8 с, сброс на cancelAct — face.ts, glbCharacter.resetFace) не меняются: драйвер их не держит,
 * он только переводит итоговые веса кадра.
 */
import type * as THREE from 'three';
import type { Viseme } from '../lipsync/visemes';

/** ключи рига p2 (scripts/models/face_rig.py KEYS) */
export const FACE_MORPHS = [
  'vis_A', 'vis_B', 'vis_C', 'vis_D', 'vis_E', 'vis_F', 'vis_G', 'vis_H',
  'smile', 'smile_open', 'smirk', 'frown', 'surprise', 'pout', 'tongue_out',
  'blink_L', 'blink_R', 'squint', 'wide',
  'brow_up', 'brow_down', 'brow_angry', 'brow_sad',
  'cheek_up', 'cheeks_gum', 'nose_wrinkle',
] as const;
export type FaceMorph = (typeof FACE_MORPHS)[number];

/** кроссфейд визем, с (60–90 мс) */
export const LIP_FADE_S = 0.075;

const VIS: readonly Viseme[] = ['X', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const VIS_KEY: Record<Viseme, FaceMorph | null> = {
  X: null, A: 'vis_A', B: 'vis_B', C: 'vis_C', D: 'vis_D', E: 'vis_E', F: 'vis_F', G: 'vis_G', H: 'vis_H',
};
/** «открытые» ключи эмоций: во время речи уступают виземам */
const MOUTH_EMO: readonly FaceMorph[] = ['smile_open', 'surprise', 'pout', 'tongue_out', 'vis_A', 'vis_B', 'vis_C', 'vis_D', 'vis_E', 'vis_F', 'vis_G', 'vis_H'];

const c01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** амплитудный фолбэк: раскрытие рта 0..1 → веса визем (сумма ≤ 1) */
export function ampVisemes(open: number, out: Partial<Record<Viseme, number>> = {}): Partial<Record<Viseme, number>> {
  const o = c01(open);
  for (const v of VIS) out[v] = 0;
  // опорные точки: 0.2 — B, 0.45 — C, 0.9 — D (как OPEN в lipsync/ru.ts)
  if (o < 0.04) out.X = 1;
  else if (o < 0.2) (out.B = o / 0.2), (out.X = 1 - out.B);
  else if (o < 0.45) (out.C = (o - 0.2) / 0.25), (out.B = 1 - out.C);
  else if (o < 0.9) (out.D = (o - 0.45) / 0.45), (out.C = 1 - out.D);
  else out.D = 1;
  return out;
}

/**
 * Логические веса лица (имена content/face.json и прочих слоёв) → ключи p2, без липсинка.
 * talk — доля речи 0..1 (сумма визем): открытые формы рта эмоций приглушаются.
 */
export function mapFace(W: Readonly<Record<string, number>>, talk = 0, out: Record<string, number> = {}): Record<string, number> {
  const g = (k: string) => W[k] ?? 0;
  for (const k of FACE_MORPHS) out[k] = 0;
  const smile = c01(g('smile'));
  const open = Math.max(0, g('mouth_A'));
  // улыбка с открытым ртом (happy, laugh, excited, глоток «ах»): smile_open; без улыбки — «а»
  const so = c01(open / 0.5) * c01(smile / 0.6);
  out.smile_open = so;
  out.smile = smile * (1 - so);
  out.vis_D = c01(open * (1 - so) * 1.1);
  out.vis_C = c01(g('mouth_E'));
  out.surprise = c01(g('mouth_O'));
  out.vis_F = c01(g('mouth_U'));
  out.vis_A = c01(g('mouth_M'));
  out.tongue_out = c01(g('tongue_out'));
  out.smirk = c01(g('smirk'));
  out.frown = c01(g('frown'));
  out.pout = c01(g('pout'));
  // кожа век (сами веки и яблоки — eyeRig)
  const wink = Math.max(g('wink_L'), g('wink_R'));
  out.blink_L = c01(Math.max(g('blink_L'), g('wink_L')));
  out.blink_R = c01(Math.max(g('blink_R'), g('wink_R')));
  out.squint = c01(Math.max(g('eyes_squint'), g('eyes_laugh'), 0.6 * g('eyes_smug'), 0.45 * g('eyes_sleepy'), 0.5 * wink, g('squint')));
  out.wide = c01(Math.max(g('eyes_wide'), g('wide')));
  // брови: хмурость с морщинкой / надутостью / прищуром — «злые» брови (внутренний край вниз)
  const down = c01(g('brow_down'));
  const angry = c01(Math.max(g('brow_angry'), Math.min(down, Math.max(g('nose_wrinkle'), g('cheeks_gum'), g('frown')) * 1.3)));
  out.brow_angry = angry;
  out.brow_down = c01(down - 0.6 * angry);
  out.brow_up = c01(g('brow_up'));
  out.brow_sad = c01(g('brow_sad'));
  out.cheek_up = c01(g('cheek_up'));
  out.cheeks_gum = c01(g('cheeks_gum'));
  out.nose_wrinkle = c01(g('nose_wrinkle'));
  if (talk > 0) {
    const k = 1 - 0.8 * c01(talk);
    for (const m of MOUTH_EMO) out[m] *= k;
    out.smile *= 1 - 0.3 * c01(talk);
    out.frown *= 1 - 0.3 * c01(talk);
  }
  return out;
}

interface Bound { inf: number[]; idx: Int16Array }

export class FaceMorphs {
  /** веса визем после кроссфейда (X — покой) */
  readonly vis: Record<Viseme, number> = { X: 1, A: 0, B: 0, C: 0, D: 0, E: 0, F: 0, G: 0, H: 0 };
  /** итоговые веса ключей последнего кадра */
  readonly out: Record<string, number> = {};
  /** доля речи 0..1 (сумма визем кроме X) */
  talk = 0;
  private target: Partial<Record<Viseme, number>> = { X: 1 };
  private readonly amp: Partial<Record<Viseme, number>> = {};
  private readonly bound: Bound[] = [];

  constructor(meshes: readonly THREE.Mesh[] = []) {
    for (const m of meshes) this.add(m);
    for (const k of FACE_MORPHS) this.out[k] = 0;
  }

  /** меш рига p2? (ключи vis_* или brow_angry) */
  static isRigMesh(m: THREE.Mesh): boolean {
    const d = m.morphTargetDictionary;
    return !!d && ('vis_D' in d || 'brow_angry' in d);
  }

  /** все меши модели с ключами рига (после buildFurShells — оболочки меха тоже); нет ни одного — null */
  static find(meshes: readonly THREE.Mesh[]): FaceMorphs | null {
    const rig = meshes.filter((m) => FaceMorphs.isRigMesh(m));
    return rig.some((m) => 'vis_D' in (m.morphTargetDictionary ?? {})) ? new FaceMorphs(rig) : null;
  }

  add(m: THREE.Mesh) {
    const d = m.morphTargetDictionary;
    const inf = m.morphTargetInfluences;
    if (!d || !inf) return;
    const idx = new Int16Array(FACE_MORPHS.length).fill(-1);
    FACE_MORPHS.forEach((k, i) => {
      if (k in d) idx[i] = d[k];
    });
    this.bound.push({ inf, idx });
  }

  get meshCount() {
    return this.bound.length;
  }

  /**
   * Липсинк на этот кадр: визема Rhubarb (cues — офлайн Rhubarb / русские фонемы / амплитуда по кадрам) или null —
   * тогда амплитудный фолбэк по раскрытию open (0..1).
   */
  setLip(v: Viseme | null, open = 0) {
    // визема есть (и X — пауза между словами: рот закрывается, даже пока сглаженное раскрытие ещё > 0)
    if (v) this.target = { [v]: 1 } as Partial<Record<Viseme, number>>;
    else this.target = ampVisemes(open, this.amp);
  }

  /** кроссфейд визем: каждая — к цели линейно за LIP_FADE_S (смена формы рта — 60–90 мс) */
  stepLip(dt: number) {
    const step = dt / LIP_FADE_S;
    let talk = 0;
    for (const v of VIS) {
      const t = this.target[v] ?? 0;
      const w = this.vis[v];
      this.vis[v] = t > w ? Math.min(t, w + step) : Math.max(t, w - step);
      if (v !== 'X') talk += this.vis[v];
    }
    this.talk = c01(talk);
  }

  /** кадр: W — логические веса лица (пресет, эмоция, моргание, действие); пишет веса во все меши рига */
  update(dt: number, W: Readonly<Record<string, number>>): Record<string, number> {
    this.stepLip(dt);
    const o = mapFace(W, this.talk, this.out);
    for (const v of VIS) {
      const k = VIS_KEY[v];
      if (k) o[k] = Math.max(o[k], this.vis[v]);
    }
    for (const b of this.bound) {
      for (let i = 0; i < FACE_MORPHS.length; i++) {
        const j = b.idx[i];
        if (j >= 0) b.inf[j] = o[FACE_MORPHS[i]];
      }
    }
    return o;
  }
}
