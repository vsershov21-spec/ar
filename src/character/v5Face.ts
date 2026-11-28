/**
 * Блёстка v5 (models/v2/glitter_v5.glb, scripts/models/build_glitter_v5.sh; v5d — настоящие глаза Eyes_V5 поверх нарисованных,
 * взгляд V5Gaze, ресницы на веке): лицо Tripo как есть — нарисованные глаза,
 * ресницы, нос и открытая улыбка; мимика — поверх, без замены лица (покой — как у Tripo 1:1):
 *  • веки — меш Lids_V5: верхние «шторки» (в покое стянуты в линию у дуги ресниц) — путь закрытия lid{L,R}_1..4 по куполу
 *    глаза; v5c — своя форма кромки (ключи от покоя): lid*_sad (внешний край ниже — грусть), lid*_mad (тяжёлое веко ниже у
 *    переносицы — недовольство/обида), lid*_laugh (кромка дугой «^» — смех, подмигнуть); нижние веки (в покое — линия под
 *    глазом): lid*_lo (щёки поднимают нижнее веко — радость), lid*_lolaugh (до «^»); lid*_wide — веки едут за раскрытым
 *    глазом (ключ тела eyes_wide растягивает нарисованный глаз от центра — удивление);
 *  • рот — ключи тела mouth_A/E/O/U/M, smile, smirk, frown (их ведёт цикл GlbCharacter по MORPH_TARGETS); v5c — накладка
 *    Mouth_V5 (кожа морды без рта, v5_mouth.py) со своими формами рта, которые рисует шейдер: надутый «︿» с губкой
 *    (грусть, обида), кривая ухмылка (недовольство), маленький рот (смущение), круглое «о» с полостью (удивление), смех
 *    с клычками и язычком; под накладкой рот Tripo закрыт (mouth_* × (1 − cover));
 *  • брови — ключи тела по сторонам brow_{up,down,sad}_{L,R} (асимметрия) + тёмная мягкая дуга меха шейдером (тело,
 *    оболочки, пряди — координаты покоя, едет с кожей); слёзы и румянец — тем же шейдером.
 * Чистые функции (веса → ключи, параметры рта) — тесты tests/glitterV5.test.ts.
 */
import * as THREE from 'three';
import { lidPose } from './eyeRig';

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const c01 = (v: number) => clamp(v, 0, 1);

/** число ключей пути закрытия века */
export const V5_LID_KEYS = 4;

/** исходные веса эмоции кадра (до усилений v5Emote) и формы рта накладки — заполняет v5Emote */
export interface V5State {
  sad: number; mad: number; laugh: number; wide: number; gum: number; shy: number; tear: number; frown: number; smile: number;
  /** формы рта накладки 0..1 */
  mSad: number; mOff: number; mAnn: number; mShy: number; mLaugh: number; mO: number;
  /** раскрытие рта речью под накладкой 0..1 и ширина */
  talk: number; talkWide: number;
  /** накладка рта 0..1 (0 — рот Tripo) */
  cover: number;
  /** v5d: открытая улыбка с клычками (радость) и закрытая «ω» (подмигнуть) */
  mHappy: number; mOmega: number;
  /** v5d: сила эмоции кадра 0..1 (брови заметны в каждой эмоции) и тангаж взгляда глаз (рад; < 0 — вниз: веко ниже) */
  emo: number;
  look: number;
}

export function v5State(): V5State {
  return { sad: 0, mad: 0, laugh: 0, wide: 0, gum: 0, shy: 0, tear: 0, frown: 0, smile: 0, mSad: 0, mOff: 0, mAnn: 0, mShy: 0, mLaugh: 0, mO: 0, talk: 0, talkWide: 0, cover: 0, emo: 0, look: 0, mHappy: 0, mOmega: 0 };
}

/** веса лица → влияния ключей век Lids_V5 (имя ключа → вес); st — исходные веса эмоции (v5Emote) */
export function v5LidWeights(w: Record<string, number>, st?: V5State): Record<string, number> {
  const out: Record<string, number> = {};
  const g = (k: string) => w[k] ?? 0;
  const laugh = c01(st ? st.laugh : g('eyes_laugh'));
  const sad = c01(st ? st.sad : 0), mad = c01(st ? st.mad : 0), wide = c01(st ? st.wide : 0);
  for (const side of ['L', 'R'] as const) {
    const wink = c01(g(`wink_${side}`));
    // «^» смеха и подмигивания — своей формой кромки (верхнее + нижнее веко), а не путём закрытия
    const arc = Math.max(laugh, wink);
    const blink = c01(g(`blink_${side}`)) * (1 - arc);
    // путь закрытия: моргание, сонно, прищур (без грусти/злости/смеха — у них своя форма века)
    const p = lidPose({ ...w, eyes_laugh: 0, [`wink_${side}`]: 0, brow_sad: 0, brow_down: 0, eyes_wide: 0 }, side, 0);
    const shapeK = 1 - blink;
    // прищур (нижнее веко eyeRig без моргания) — немного верхним
    const lo0 = lidPose({ ...w, [`blink_${side}`]: 0, [`wink_${side}`]: 0, eyes_laugh: 0, brow_sad: 0, brow_down: 0, eyes_wide: 0 }, side, 0).lo;
    // v5d: взгляд вниз — верхнее веко следует за радужкой (st.look < 0)
    const follow = st ? 0.3 * c01((-st.look - 0.1) / (V5_GAZE_LIM.down - 0.1)) : 0;
    const c = c01((p.up * (1 - 0.6 * Math.max(sad, mad)) + 0.15 * lo0 * (1 - p.up) + follow * (1 - p.up)) * (1 - arc));
    for (let k = 1; k <= V5_LID_KEYS; k++) out[`lid${side}_${k}`] = clamp(V5_LID_KEYS * c - (k - 1), 0, 1);
    out[`lid${side}_sad`] = c01(0.95 * sad) * shapeK * (1 - arc);
    out[`lid${side}_mad`] = c01(1.15 * mad) * shapeK * (1 - arc) * (1 - 0.5 * sad);
    out[`lid${side}_laugh`] = arc;
    // нижнее веко: щёки (улыбка, прищур) — радость; смех — до дуги
    const lo = c01(0.85 * g('cheek_up') * c01(g('smile') * 1.5) + 0.6 * g('eyes_squint') - 0.4 * mad);
    out[`lid${side}_lo`] = lo * (1 - arc) * shapeK;
    out[`lid${side}_lolaugh`] = arc;
    out[`lid${side}_wide`] = wide;
  }
  return out;
}

// ───────────────────────── v5e: поза лица по эмоции (брови шейдером, голова, взгляд, веса пресета) ─────────────────────────
/**
 * Эмоция на рефе (design/cut/glitter/face) — сочетание формы века, бровей, наклона головы и рта; одних весов content/face.json
 * (общие с Хулиганом/Добряком) для нарисованного лица Tripo мало. Только для Блёстки v5:
 *  • brow — сдвиг бровей шейдером, мм (вверх +): [L внутр., L внешн., R внутр., R внешн.]; browIn — внутренние концы к
 *    переносице (мм, сведённые брови); bend — дуга сильнее (+) / прямее (−), мм;
 *  • head — голова, рад: рысканье (> 0 — к +X модели, влево у кота), тангаж (> 0 — вверх/назад), крен;
 *  • gaze — взгляд глаз относительно цели (рад: рысканье к +X, тангаж вверх); null — прямо на зрителя (без «взгляда в сторону»);
 *  • w — веса лица вместо пресета content/face.json (ключи век, рта, щёк).
 * Все каналы сглажены одной постоянной (V5_POSE_TAU): смена эмоции — плавное смешивание за ~0,2 с.
 */
export interface V5Pose {
  brow: [number, number, number, number];
  browIn: number;
  bend: number;
  head: [number, number, number];
  gaze: [number, number] | null;
  w?: Record<string, number>;
  /** v5g: глаза «на мокром месте» (влажный блик по низу радужки, капли катятся) и «сияющие» крупные блики (умиление) 0..1 */
  wet?: number;
  sparkle?: number;
}
const WINK_BOTH: Record<string, number> = { wink_L: 1, wink_R: 1, smile: 0.7, cheek_up: 0.6, brow_up: 0.25 };
export const V5_POSES: Record<string, V5Pose> = {
  happy: { brow: [7, 5, 7, 5], browIn: 0, bend: 2, head: [0, 0.04, 0.05], gaze: null },
  excited: {
    brow: [11, 8, 11, 8], browIn: 0, bend: 3, head: [0, 0.07, 0.08], gaze: null,
    w: { smile: 0.95, cheek_up: 0.75, eyes_wide: 0.55, brow_up: 0.5, mouth_A: 0.45 },
  },
  laugh: {
    brow: [12, 9, 12, 9], browIn: 0, bend: 3, head: [0, 0.22, 0.07], gaze: null,
    w: { smile: 1, mouth_A: 0.85, eyes_laugh: 1, cheek_up: 1, brow_up: 0.5 },
  },
  surprised: {
    brow: [22, 19, 22, 19], browIn: 0, bend: 5, head: [0, 0.1, -0.17], gaze: null,
    w: { eyes_wide: 1, brow_up: 1, mouth_O: 1.3 },
  },
  sad: {
    brow: [16, -7, 16, -7], browIn: 3, bend: -3, head: [0, -0.17, 0.07], gaze: [0, 0.3],
    w: { brow_sad: 1, frown: 0.7, tear: 1 }, wet: 1,
  },
  offended: {
    brow: [-11, 3, -11, 3], browIn: 5, bend: -4, head: [0.3, 0.06, -0.06], gaze: [-0.62, 0.02],
    w: { brow_down: 0.8, frown: 0.9, cheeks_gum: 0.75, blush: 0.95 },
  },
  annoyed: {
    brow: [-10, 0, -6, 4], browIn: 4, bend: -3, head: [0.2, -0.05, 0.05], gaze: [-0.42, -0.02],
    w: { brow_down: 0.85, eyes_squint: 0.55, frown: 0.45 },
  },
  shy: {
    brow: [9, -3, 9, -3], browIn: 1, bend: -1, head: [-0.2, -0.17, 0.15], gaze: [0.4, -0.34],
    w: { blush: 1, brow_sad: 0.55, eyes_sleepy: 0.25, frown: 0.15, smile: 0.2, cheek_up: 0.3 },
  },
  // v5g: умиление («ми-ми»): мягкий домик, голова набок, тёплая улыбка с прищуром снизу, румянец, сияющие глаза
  caring: {
    brow: [9, 3, 9, 3], browIn: 1, bend: 1, head: [-0.06, -0.06, 0.2], gaze: null, sparkle: 1, wet: 0.35,
    w: { smile: 0.5, cheek_up: 0.7, blush: 0.85, brow_sad: 0.3, mouth_omega: 1 },
  },
  wink: { brow: [7, 5, 7, 5], browIn: 0, bend: 2, head: [0, 0.05, 0.11], gaze: null, w: WINK_BOTH },
  wink_r: { brow: [7, 5, 7, 5], browIn: 0, bend: 2, head: [0, 0.05, 0.11], gaze: null, w: WINK_BOTH },
  wink_l: { brow: [7, 5, 7, 5], browIn: 0, bend: 2, head: [0, 0.05, -0.11], gaze: null, w: WINK_BOTH },
};
/** постоянная сглаживания позы (с): 90 % за ~0,2 с */
export const V5_POSE_TAU = 0.085;

/** сглаженная поза кадра (без аллокаций): brow, browIn, bend (мм), head (рад), gaze (рад), focus — 0..1 «смотрит на зрителя» */
/** v5g: фаза капли слезы (0..1, цикл 3.2 с; правый глаз — со сдвигом) по времени плача t (с); в начале — капля у века */
export function v5TearPhase(t: number, eye: 0 | 1): number {
  const T = 3.2;
  const x = (t + 0.3 * T + (eye ? 0.45 * T : 0)) / T;
  return x - Math.floor(x);
}
export class V5PoseMix {
  readonly brow = [0, 0, 0, 0];
  browIn = 0;
  bend = 0;
  readonly head = [0, 0, 0];
  readonly gaze = [0, 0];
  /** доля эмоции с «прямо на зрителя» (без взгляда в сторону) и доля эмоции вообще */
  focus = 0;
  emo = 0;
  /** v5g: влажность глаз и сияние бликов 0..1 */
  wet = 0;
  sparkle = 0;
  /** id — пресет эмоции, s — её сила 0..1 (0 — покой) */
  update(dt: number, id: string | null, s: number) {
    const p = id ? V5_POSES[id] : undefined;
    const k = 1 - Math.exp(-dt / V5_POSE_TAU);
    const w = p ? c01(s) : 0;
    for (let i = 0; i < 4; i++) this.brow[i] += ((p ? p.brow[i] * w : 0) - this.brow[i]) * k;
    this.browIn += ((p ? p.browIn * w : 0) - this.browIn) * k;
    this.bend += ((p ? p.bend * w : 0) - this.bend) * k;
    for (let i = 0; i < 3; i++) this.head[i] += ((p ? p.head[i] * w : 0) - this.head[i]) * k;
    for (let i = 0; i < 2; i++) this.gaze[i] += ((p?.gaze ? p.gaze[i] * w : 0) - this.gaze[i]) * k;
    this.focus += ((p ? w : 0) - this.focus) * k;
    this.emo += (w - this.emo) * k;
    this.wet += ((p?.wet ?? 0) * w - this.wet) * k;
    this.sparkle += ((p?.sparkle ?? 0) * w - this.sparkle) * k;
  }
}

// ───────────────────────── эмоции v5: сильнее и ближе к design/cut/glitter/face ─────────────────────────
/**
 * Пресеты content/face.json рассчитаны на 3D-глаза и рот-накладку других котов; на нарисованном лице Tripo те же веса
 * читаются слабо. Поверх итоговых весов кадра (до морфов и век), только для v5:
 *  • брови сильнее (домик грусти, сведённые при недовольстве, вверх при удивлении) — по сторонам в v5BodyWeights;
 *  • формы рта накладки (st.m*) по эмоции; под накладкой рот Tripo закрыт (mouth_* × (1 − cover)), улыбка гаснет;
 *  • румянец (blush) рисует шейдер щёк — отдельного ключа нет; обида — тоже с румянцем.
 * Меняет w на месте; st — исходные веса и формы рта (без аллокаций в кадре).
 */
// v5e: брови рисует шейдер с позой V5_POSES — ключи кожи (мех у бровей) без усиления
export const V5_EMO = { browSad: 1.0, browDown: 1.0, browUp: 1.0, frown: 1.4 };

const _st = v5State();

export function v5Emote(w: Record<string, number>, st: V5State = _st): Record<string, number> {
  const g = (k: string) => w[k] ?? 0;
  const sad = g('brow_sad'), down = g('brow_down'), frown = g('frown'), blush = g('blush'), gum = g('cheeks_gum');
  st.sad = sad; st.mad = down; st.laugh = g('eyes_laugh'); st.wide = g('eyes_wide'); st.gum = gum; st.shy = blush;
  st.tear = g('tear'); st.frown = frown; st.smile = g('smile');
  // формы рта (закрытые — по сочетанию весов пресетов, открытые — смех и «о» удивления)
  st.mLaugh = c01(st.laugh);
  st.mO = c01(st.wide) * c01(g('mouth_O'));
  // v5d: подмигнуть — закрытая улыбка «ω»; радость — открытая улыбка с клычками (только в эмоции: в покое улыбка «дышит»
  // до 0.38 — рот Tripo)
  const wink = Math.max(g('wink_L'), g('wink_R'));
  // v5g: mouth_omega — закрытая улыбка «ω» без подмигивания (умиление)
  st.mOmega = c01(Math.max(wink * 1.5, g('mouth_omega'))) * (1 - st.mLaugh);
  st.mHappy = c01((g('smile') - 0.55) * 3) * (1 - st.mLaugh) * (1 - st.mOmega) * (1 - st.mO);
  st.mOff = c01(gum * 1.7) * c01(frown * 1.2);
  st.mAnn = c01(down * 1.3) * (1 - c01(gum * 2)) * (1 - st.mO);
  st.mSad = c01(sad * 1.5) * c01(frown * 1.8) * (1 - st.mOff) * (1 - c01(blush));
  st.mShy = c01(blush) * (1 - st.mOff) * c01(sad * 2) * (1 - st.mLaugh);
  const closed = st.mOff + st.mAnn + st.mSad + st.mShy + st.mOmega;
  st.cover = c01(closed + st.mLaugh + st.mO + st.mHappy);
  // речь под накладкой: раскрытие рта — нарисованным ртом
  const open = (k: string) => g(k);
  st.talk = st.cover > 0 ? c01((open('mouth_A') + 0.8 * open('mouth_O') + 0.6 * open('mouth_E') + 0.4 * open('mouth_U')) * (1 - st.mO - st.mLaugh - st.mHappy)) : 0;
  st.talkWide = c01(open('mouth_E') + 0.3 * open('mouth_A') - 0.6 * open('mouth_U'));
  if (sad) w.brow_sad = sad * V5_EMO.browSad;
  if (down) w.brow_down = down * V5_EMO.browDown;
  if (g('brow_up')) w.brow_up = g('brow_up') * V5_EMO.browUp;
  if (frown) w.frown = frown * V5_EMO.frown;
  if (st.cover > 0) {
    const k = 1 - st.cover;
    for (const m of ['mouth_A', 'mouth_E', 'mouth_O', 'mouth_U', 'mouth_M']) if (w[m]) w[m] *= k;
    // уголки Tripo под накладкой не тянуть (кожа губ выходила сквозь накладку); щёки — ключом cheek_up
    if (g('smile')) {
      w.cheek_up = Math.max(g('cheek_up'), 0.6 * g('smile'));
      w.smile = g('smile') * (1 - 0.8 * st.cover);
    }
  }
  // надулась/обиделась (cheeks_gum с хмурым ртом) — по рефу offended тоже с румянцем
  if (gum && frown) w.blush = Math.max(blush, 0.9 * gum);
  return w;
}

/** брови по сторонам (ключи тела brow_{up,down,sad}_{L,R}): недовольство — одна бровь ниже, подмигнуть — бровь над
 * закрытым глазом ниже, над открытым — выше */
export function v5BodyWeights(w: Record<string, number>, st: V5State = _st, out: Record<string, number> = {}): Record<string, number> {
  const g = (k: string) => w[k] ?? 0;
  const ann = st.mAnn;
  const wl = g('wink_L'), wr = g('wink_R');
  for (const s of ['L', 'R'] as const) {
    const one = s === 'L' ? 1 : -1;
    const winkMe = s === 'L' ? wl : wr, winkOther = s === 'L' ? wr : wl;
    // до 2: ключи бровей Tripo мягкие (сдвиг 4–6 мм), усиление V5_EMO не срезать
    out[`brow_up_${s}`] = clamp(g('brow_up') * (1 - 0.6 * winkMe) + 0.35 * winkOther + 0.4 * ann * (one < 0 ? 1 : 0), 0, 2);
    out[`brow_down_${s}`] = clamp(g('brow_down') * (1 + 0.3 * ann * one) + 0.3 * winkMe, 0, 2);
    out[`brow_sad_${s}`] = clamp(g('brow_sad'), 0, 2);
  }
  // v5d: надутые щёки обиды (cheeks_gum пресета)
  out.cheeks_puff = c01(st.gum * 1.6) * c01(st.frown * 1.5);
  return out;
}

/** насыщенность дуги брови 0..1 по сторонам: темнее, когда бровь работает, и в любой эмоции (v5d: st.emo — брови
 * заметны в каждой эмоции, как на рефе); в покое — 0 (вид Tripo) */
export function v5BrowInk(bw: Record<string, number>, s: 'L' | 'R', st?: V5State): number {
  const work = 1.1 * ((bw[`brow_up_${s}`] ?? 0) * 0.8 + (bw[`brow_down_${s}`] ?? 0) + (bw[`brow_sad_${s}`] ?? 0));
  return clamp(Math.max(work, 0.85 * c01(st?.emo ?? 0)), 0, 1);
}

/** параметры нарисованного рта (мм плоскости рта: 0 — середина рта Tripo, y вверх; низ носа ≈ +36) */
export interface V5MouthParams {
  /** линия закрытого рта: полуширина, y уголков, изгиб (> 0 — «︿», < 0 — улыбка), наклон (кривая ухмылка) */
  line: [number, number, number, number];
  /** толщина, сила, губка под серединой, «ω» (v5d) */
  line2: [number, number, number, number];
  /** открытый рот: полуширина, y середины, высота верха, глубина низа */
  open: [number, number, number, number];
  /** сила, плоский верх (смех), клычки, язычок */
  open2: [number, number, number, number];
}

// v5e: грусть — маленький надутый «︿» уголками вниз (реф sad), обида — поджатый, смущение — крошечный
const LINE = {
  sad: [17, 13, 9, 0, 4.6, 1, 0],
  off: [11, 17, 5, 0, 4.6, 1, 0],
  ann: [24, 17, -4, 9, 4.4, 0, 0],
  shy: [10, 18, 3, 0, 4.0, 0.7, 0],
  // v5d: «ω» подмигивания — уголки вверх, посередине две дужки
  omega: [26, 22, -9, 0, 4.4, 0, 1],
} as const;
const OPEN = {
  laugh: [52, 19, 3, 40, 1, 1, 1],
  // v5e: удивление — маленькое круглое «о» с тёмной полостью (реф surprised)
  o: [14, 7, 9, 12, 0, 0, 0.35],
  // v5d: радость — открытая улыбка поменьше смеха, плоский верх, клычки, язычок (v5e: шире и глубже — реф joy)
  happy: [42, 18, 3, 30, 1, 1, 0.9],
} as const;

export function v5MouthParams(st: V5State, out?: V5MouthParams): V5MouthParams {
  const o = out ?? { line: [0, 0, 0, 0], line2: [0, 0, 0, 0], open: [0, 0, 0, 0], open2: [0, 0, 0, 0] };
  const lw = [st.mSad, st.mOff, st.mAnn, st.mShy, st.mOmega ?? 0];
  const ls = [LINE.sad, LINE.off, LINE.ann, LINE.shy, LINE.omega];
  const sl = lw[0] + lw[1] + lw[2] + lw[3] + lw[4];
  for (let k = 0; k < 4; k++) o.line[k] = 0;
  o.line2[0] = o.line2[2] = o.line2[3] = 0;
  if (sl > 1e-4) {
    for (let i = 0; i < 5; i++) {
      const f = lw[i] / sl;
      for (let k = 0; k < 4; k++) o.line[k] += ls[i][k] * f;
      o.line2[0] += ls[i][4] * f;
      o.line2[2] += ls[i][5] * f;
      o.line2[3] += ls[i][6] * f;
    }
  } else {
    o.line[0] = 20; o.line[1] = 18;
  }
  const ow = [st.mLaugh, st.mO, st.mHappy ?? 0];
  const so = ow[0] + ow[1] + ow[2];
  // v5e: смена закрытой формы на открытую (обида → смех) — короткая перекрёстная смена по доле, без 2–3 кадров двух ртов
  const fo = so + sl > 1e-4 ? so / (so + sl) : 0;
  const ko = fo <= 0.35 ? 0 : fo >= 0.65 ? 1 : ((fo - 0.35) / 0.3) ** 2 * (3 - 2 * (fo - 0.35) / 0.3);
  // речь под закрытой формой: линия гаснет, рот приоткрывается маленьким «о»
  o.line2[1] = c01((sl + so) / Math.max(st.cover, 1e-4)) * (1 - st.talk) * (1 - ko);
  const talkW = st.talk * c01(sl);
  const tot = so + talkW;
  for (let k = 0; k < 4; k++) o.open[k] = 0;
  o.open2[1] = o.open2[2] = o.open2[3] = 0;
  const add = (p: readonly number[], f: number) => {
    for (let k = 0; k < 4; k++) o.open[k] += p[k] * f;
    o.open2[1] += p[4] * f; o.open2[2] += p[5] * f; o.open2[3] += p[6] * f;
  };
  if (tot > 1e-4) {
    add(OPEN.laugh, ow[0] / tot);
    add(OPEN.o, ow[1] / tot);
    add(OPEN.happy, ow[2] / tot);
    const yl = o.line[1] + 0.6 * o.line[2];
    add([8 + 10 * st.talkWide, yl - 2, 1.5 + 2.5 * st.talk, 2 + 9 * st.talk, 0.5, 0, 0.5], talkW / tot);
  } else {
    o.open[0] = 10; o.open[1] = 15; o.open[2] = 1; o.open[3] = 1;
  }
  o.open2[0] = c01((tot + (so > 0 ? sl : 0)) / Math.max(st.cover, 1e-4)) * (tot > 1e-4 ? Math.max(ko, talkW / tot) : 1);
  return o;
}

/** меш век v5 и его ключи; null — у модели нет */
export interface V5Lids {
  mesh: { morphTargetDictionary?: Record<string, number>; morphTargetInfluences?: number[] };
}

export function applyV5Lids(lids: V5Lids, w: Record<string, number>, st?: V5State): Record<string, number> | null {
  const d = lids.mesh.morphTargetDictionary, inf = lids.mesh.morphTargetInfluences;
  if (!d || !inf) return null;
  const lw = v5LidWeights(w, st);
  for (const k in lw) {
    const i = d[k];
    if (i !== undefined) inf[i] = lw[k];
  }
  return lw;
}

/** v5d: насколько опущено верхнее веко (0 — покой: мех между ресницами полосы века прозрачен, 1 — непрозрачен) */
export function v5LidCover(lw: Record<string, number>, s: 'L' | 'R'): number {
  const g = (k: string) => lw[`lid${s}_${k}`] ?? 0;
  const c = (g('1') + g('2') + g('3') + g('4')) / V5_LID_KEYS;
  const k = c01((Math.max(c, 0.3 * g('sad'), 0.4 * g('mad'), g('laugh')) - 0.03) / 0.12);
  return k * k * (3 - 2 * k);
}

/** v5e: глаз закрыт (моргание, сон, «^» смеха и подмигивания) 0..1 — полоса ресниц века становится мехом с тонкой кромкой */
export function v5LidClosed(lw: Record<string, number>, s: 'L' | 'R'): number {
  const g = (k: string) => lw[`lid${s}_${k}`] ?? 0;
  const c = (g('1') + g('2') + g('3') + g('4')) / V5_LID_KEYS;
  const k = c01(Math.max((c - 0.55) / 0.4, g('laugh')));
  return k * k * (3 - 2 * k);
}

/** v5d: шейдер века — доля текстуры века под мехом над полосой ресниц (v < VS) */
export const V5_LID_VS = 0.3;
/**
 * v5f: веко — кожа тела. Мех века (над полосой ресниц, нижнее веко) прозрачен: под ним кожа тела, накладка глаза Eyes_V5
 * над кромкой века прячется (v5LidHide в шейдере накладки), а кожа под накладкой — мех (v5_eyes.py). Сетка века несёт
 * только полосу ресниц Tripo; закрытый глаз (моргание, «^», сон) — тонкая тёмная дуга-щель и ресницы у внешнего края.
 */
export const V5_LID_LINE = { a: 0.9, b: 0.945, col: [0.07, 0.08, 0.16] as [number, number, number] };
function patchLid(m: THREE.Material, cover: { value: THREE.Vector2 }, closed: { value: THREE.Vector2 }, outer: THREE.Vector2) {
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    sh.uniforms.uLidCover = cover;
    sh.uniforms.uLidClosed = closed;
    sh.uniforms.uLidO = { value: outer };
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec2 uLidCover;\nuniform vec2 uLidClosed;\nuniform vec2 uLidO;')
      .replace('#include <map_fragment>', `#include <map_fragment>
  {
    float lv = vMapUv.y * 2.0;
    bool eL = vMapUv.x < 0.5;
    float sc0 = clamp((vMapUv.x - (eL ? 0.0 : 0.5)) * 2.0, 0.0, 1.0);  // столбец сетки века 0..1 (+X модели)
    // v5h: сетка продлена за внешний уголок (L — к +X, R — к −X) на долю uLidO: там только большие ресницы Tripo, они
    // едут с веком; кромка, «^» и нижнее веко — по прежней ширине (sc)
    float fo = eL ? uLidO.x : uLidO.y;
    float sc = eL ? sc0 / (1.0 - fo) : (sc0 - fo) / (1.0 - fo);
    float inW = step(-0.001, sc) * step(sc, 1.001);
    sc = clamp(sc, 0.0, 1.0);
    float cl = eL ? uLidClosed.x : uLidClosed.y;
    if (lv < 1.0) {
      float VS = ${V5_LID_VS.toFixed(3)};
      float f = clamp((lv - VS) / (1.0 - VS), 0.0, 1.0);
      // мех века — кожа тела (прозрачно); полоса ресниц Tripo — как есть
      if (lv <= VS) diffuseColor.a = 0.0;
      // закрытый глаз: тонкая дуга у кромки + ресницы у внешнего края (у переносицы — без ресниц)
      float outer = eL ? smoothstep(0.6, 0.85, sc) : 1.0 - smoothstep(0.15, 0.4, sc);
      float edge = smoothstep(${V5_LID_LINE.a.toFixed(3)}, ${V5_LID_LINE.b.toFixed(3)}, f);
      // три ресницы у внешнего края дуги (реф: закрытый глаз — дуга и 2–3 ресницы наружу)
      float so = eL ? sc : 1.0 - sc;
      float lash = 0.0;
      for (int k = 0; k < 3; k++) {
        float s0 = 0.8 + 0.065 * float(k), ln = 0.1 + 0.035 * float(k);
        float t = clamp((0.93 - f) / ln, 0.0, 1.0);
        float sx = s0 + t * t * (0.035 + 0.02 * float(k));
        float w = 0.009 * (1.0 - 0.8 * t);
        lash = max(lash, (1.0 - smoothstep(w * 0.5, w, abs(so - sx))) * step(f, 0.935) * step(0.93 - ln, f));
      }
      float aC = max(max(edge, lash), clamp(diffuseColor.a * 1.6, 0.0, 1.0) * outer * 0.5 * (1.0 - smoothstep(0.82, 0.9, f)));
      vec3 cC = mix(diffuseColor.rgb, diffuse * vec3(${V5_LID_LINE.col.join(', ')}), max(edge, lash));
      diffuseColor.rgb = mix(diffuseColor.rgb, cC, cl * inW);
      // за уголком закрытое веко гаснет целиком (ресницы закрытого глаза рисует дуга)
      diffuseColor.a = mix(diffuseColor.a, aC * inW, cl);
      diffuseColor.a *= smoothstep(0.0, 0.04, sc0) * smoothstep(1.0, 0.96, sc0) * mix(1.0, smoothstep(0.0, 0.04, sc) * smoothstep(1.0, 0.96, sc), cl);
    } else {
      // нижнее веко: только мягкая линия у кромки (нижние ресницы), у закрытого глаза — нет (дуга верхнего)
      float s2 = lv - 1.0;
      diffuseColor.rgb = diffuse * vec3(${V5_LID_LINE.col.join(', ')}) * 1.6;
      diffuseColor.a = 0.45 * smoothstep(0.9, 0.98, s2) * (1.0 - cl) * smoothstep(0.0, 0.1, sc) * smoothstep(1.0, 0.9, sc) * inW;
    }
  }`);
  };
  m.customProgramCacheKey = () => 'v5-lid-5';
  m.needsUpdate = true;
}

/**
 * v5f: кромки век по столбцам (координаты модели с ключами век): верхнее сейчас/в покое, нижнее сейчас/в покое —
 * для шейдера накладки глаза (прячется над кромкой верхнего и под кромкой нижнего, когда веко сдвинуто).
 * Вершины кромок — по UV сетки века (v5_face.py: верх — v ≈ 0.5, нижнее — v ≈ 1; столбцы по u; L — u < 0.5).
 */
export class V5LidEdges {
  static readonly NC = 30;
  readonly E: THREE.Vector4[] = Array.from({ length: 2 * V5LidEdges.NC }, () => new THREE.Vector4());
  readonly X = new THREE.Vector4();
  private readonly up: number[][] = [[], []];
  private readonly lo: number[][] = [[], []];
  constructor(private readonly mesh: THREE.Mesh) {
    const g = mesh.geometry, uv = g.getAttribute('uv'), pos = g.getAttribute('position');
    const pick = (lower: boolean, e: number) => {
      let vmax = -1;
      for (let i = 0; i < uv.count; i++) {
        const u = uv.getX(i), v = uv.getY(i);
        if ((v >= 0.5) !== lower || (u < 0.5) !== (e === 0)) continue;
        vmax = Math.max(vmax, v);
      }
      const ids: number[] = [];
      for (let i = 0; i < uv.count; i++) {
        const u = uv.getX(i), v = uv.getY(i);
        if ((v >= 0.5) !== lower || (u < 0.5) !== (e === 0)) continue;
        if (v > vmax - 1e-3) ids.push(i);
      }
      // по столбцу — одна вершина (дубликаты по u не нужны)
      ids.sort((a, b) => uv.getX(a) - uv.getX(b));
      const out: number[] = [];
      for (const i of ids) if (!out.length || uv.getX(i) - uv.getX(out[out.length - 1]) > 1e-4) out.push(i);
      return out;
    };
    for (const e of [0, 1]) { this.up[e] = pick(false, e); this.lo[e] = pick(true, e); }
    const ok = this.up.every((a) => a.length === V5LidEdges.NC) && this.lo.every((a) => a.length === V5LidEdges.NC);
    if (!ok) throw new Error(`Lids_V5: кромки ${this.up.map((a) => a.length)} / ${this.lo.map((a) => a.length)}`);
    this.X.set(pos.getX(this.up[0][0]), pos.getX(this.up[0][V5LidEdges.NC - 1]), pos.getX(this.up[1][0]), pos.getX(this.up[1][V5LidEdges.NC - 1]));
    this.update();
  }
  /** после ключей век (morphTargetInfluences) */
  update() {
    const g = this.mesh.geometry, pos = g.getAttribute('position');
    const mt = g.morphAttributes.position ?? [], inf = this.mesh.morphTargetInfluences ?? [];
    const rel = g.morphTargetsRelative;
    const y = (i: number) => {
      let v = pos.getY(i);
      for (let k = 0; k < mt.length; k++) {
        const w = inf[k];
        if (w) v += w * (rel ? mt[k].getY(i) : mt[k].getY(i) - pos.getY(i));
      }
      return v;
    };
    for (const e of [0, 1]) {
      for (let c = 0; c < V5LidEdges.NC; c++) {
        const iu = this.up[e][c], il = this.lo[e][c];
        this.E[e * V5LidEdges.NC + c].set(y(iu), pos.getY(iu), y(il), pos.getY(il));
      }
    }
  }
}

// ───────────────────────── шейдер лица: румянец, дуги бровей, слёзы (тело, оболочки и пряди меха) ─────────────────────────
interface Marks {
  eyeOuterL: number[]; eyeInnerL: number[]; eyeOuterR: number[]; eyeInnerR: number[]; eyeBottomL: number[]; eyeBottomR: number[];
  eyeTopL?: number; eyeTopR?: number; browL?: number[]; browR?: number[];
}

/** центры щёк (координаты покоя модели): под серединой глаза, ближе к краю лица */
export function v5CheekCenters(m: Marks): [number, number, number][] {
  return (['L', 'R'] as const).map((s) => {
    const o = m[`eyeOuter${s}`], i = m[`eyeInner${s}`], b = m[`eyeBottom${s}`];
    return [(0.4 * i[0] + 0.6 * o[0]) * 1.08, b[1] - 0.042, b[2] - 0.004] as [number, number, number];
  });
}

const PAINT_VS = `
varying vec3 vBlushP;`;
const PAINT_FS = `
uniform float uBlush;
uniform vec3 uBlushC[2];
uniform vec2 uBrowInk;
uniform vec4 uBrowG[2];
uniform vec4 uBrowS[2];
uniform vec4 uBrowP[2];
uniform vec3 uBrowK;
uniform float uTear;
uniform vec2 uTearT;
uniform vec4 uEye[2];
varying vec3 vBlushP;`;
const PAINT_APPLY = `
  {
    // румянец: два мягких овала на щеках (координаты покоя), только спереди — ярче, как на рефе
    float bw = 0.0;
    for (int i = 0; i < 2; i++) {
      vec3 d = (vBlushP - uBlushC[i]) / vec3(0.04, 0.026, 0.05);
      bw = max(bw, exp(-dot(d, d) * 1.3));
    }
    bw = clamp(bw * uBlush * 1.15, 0.0, 1.0);
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.12, 0.52, 0.66) + vec3(0.16, 0.0, 0.03), bw);
    // брови (v5e): мазок по форме брови Tripo (её в текстуре нет — v5_brows.py) с позой эмоции: сдвиг внутреннего и
    // внешнего концов, концы к переносице, дуга; к внешнему концу тоньше, концы мягкие (координаты покоя — едет с кожей)
    for (int i = 0; i < 2; i++) {
      float ink = i == 0 ? uBrowInk.x : uBrowInk.y;
      vec4 G = uBrowG[i], S = uBrowS[i], Q = uBrowP[i];
      if (ink > 0.001 && vBlushP.z > S.z - 0.045) {
        float sg = sign(G.x);
        float u = (vBlushP.x - (G.x - sg * Q.z)) * sg / G.z;  // −1 у переносицы, +1 снаружи
        float uc = clamp(u, -1.0, 1.0);
        float bd = S.y + Q.w;
        float yc = G.y + S.x * uc * G.z + bd * (1.0 - uc * uc) + Q.x * 0.5 * (1.0 - uc) + Q.y * 0.5 * (1.0 + uc);
        float dd = (S.x * G.z - 2.0 * bd * uc + 0.5 * (Q.y - Q.x)) / G.z;
        float d = abs(vBlushP.y - yc) / sqrt(1.0 + dd * dd);
        float ht = G.w * 0.5 * mix(1.2, 0.6, uc * 0.5 + 0.5);
        float a = (1.0 - smoothstep(ht * 0.15, ht * 1.25, d)) * (1.0 - smoothstep(0.78, 1.1, abs(u)));
        diffuseColor.rgb *= pow(uBrowK, vec3(a * ink));
      }
    }
    // слёзы: голубая «лужица» по нижнему краю глаза и капля под ним
    if (uTear > 0.001) {
      for (int i = 0; i < 2; i++) {
        vec4 e = uEye[i];  // центр x, y, полуоси
        float u = (vBlushP.x - e.x) / e.z;
        if (abs(u) < 1.0 && vBlushP.z > 0.08) {
          float yb = e.y - e.w * sqrt(1.0 - u * u);
          float dy = vBlushP.y - yb;
          // v5h: голубая лужица вдоль всего нижнего века (реф грусти)
          float edge = 1.0 - smoothstep(0.82, 0.98, abs(u));
          float pool = smoothstep(-0.0045, -0.002, dy) * (1.0 - smoothstep(0.0055, 0.0085, dy)) * edge;
          float hl = (1.0 - smoothstep(0.0, 0.0011, abs(dy - 0.0052))) * edge * step(abs(u), 0.7);
          vec3 tc = mix(vec3(0.55, 0.80, 1.0), vec3(1.0), hl);
          diffuseColor.rgb = mix(diffuseColor.rgb, tc, clamp(pool * 0.8 + hl, 0.0, 1.0) * uTear);
        }
        // v5d: крупная блестящая капля у нижнего века (реф sad): вытянута вверх, тёмный край, два блика
        // v5g: капля нарастает у века (фаза 0…0.3), скатывается по щеке (до 42 мм) и гаснет; за ней — влажная дорожка
        float ph = i == 0 ? uTearT.x : uTearT.y;
        float grow = smoothstep(0.0, 0.28, ph), run = smoothstep(0.3, 0.92, ph), fadeD = 1.0 - smoothstep(0.86, 1.0, ph);
        float dsc = 1.35 * mix(0.45, 1.0, grow) * (1.0 - 0.25 * run);  // v5h: капля крупнее (читается на телефоне)
        float x0d = e.x - 0.3 * e.z * sign(e.x), y0d = e.y - e.w - 0.006;
        float yd = y0d - 0.004 * grow - 0.042 * run;
        vec2 dc = vec2(vBlushP.x - x0d, vBlushP.y - yd) / dsc;
        dc.y = dc.y > 0.0 ? dc.y * 0.5 : dc.y;
        float dr = length(dc);
        float tr = (1.0 - smoothstep(0.0012, 0.0022, abs(vBlushP.x - x0d))) * step(yd, vBlushP.y) * step(vBlushP.y, y0d) * step(0.08, vBlushP.z);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.08 + vec3(0.05, 0.08, 0.12), tr * run * fadeD * uTear * 0.55);
        float drop = (1.0 - smoothstep(0.0048, 0.0058, dr)) * step(0.08, vBlushP.z);
        float edgeD = smoothstep(0.0032, 0.0056, dr);
        float spec = 1.0 - smoothstep(0.0006, 0.0016, length(dc - vec2(-0.0016, 0.0016)));
        float spec2 = 1.0 - smoothstep(0.0003, 0.0008, length(dc - vec2(0.0018, -0.0018)));
        vec3 dcol = mix(vec3(0.45, 0.74, 1.0), vec3(0.22, 0.45, 0.85), edgeD);
        dcol = mix(dcol, vec3(1.0), max(spec, spec2));
        diffuseColor.rgb = mix(diffuseColor.rgb, dcol, drop * uTear * 0.9 * fadeD);
      }
    }
  }`;

export interface V5PaintU {
  blush: { value: number };
  browInk: { value: THREE.Vector2 };
  /** v5e: поза бровей по сторонам (м): сдвиг внутр./внешн. конца, концы к переносице, доп. дуга */
  browPose: { value: THREE.Vector4[] };
  tear: { value: number };
  /** v5g: фаза капли слезы по глазам 0..1 (v5TearPhase) */
  tearT: { value: THREE.Vector2 };
  /** v5e: брови рисует шейдер и в покое (в текстуре их нет — asset.extras.glitterV5.brows) */
  browsDrawn: boolean;
}

/** подключить шейдер лица к материалу (обёртка поверх его onBeforeCompile; ключ программы — свой) */
function patchPaint(m: THREE.Material, u: V5PaintU, centers: THREE.Vector3[], bg: THREE.Vector4[], bs: THREE.Vector4[], bk: THREE.Vector3, eyes: THREE.Vector4[]) {
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    sh.uniforms.uBlush = u.blush;
    sh.uniforms.uBlushC = { value: centers };
    sh.uniforms.uBrowInk = u.browInk;
    sh.uniforms.uBrowG = { value: bg };
    sh.uniforms.uBrowS = { value: bs };
    sh.uniforms.uBrowP = u.browPose;
    sh.uniforms.uBrowK = { value: bk };
    sh.uniforms.uTear = u.tear;
    sh.uniforms.uTearT = u.tearT;
    sh.uniforms.uEye = { value: eyes };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>' + PAINT_VS)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vBlushP = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>' + PAINT_FS)
      .replace('#include <color_fragment>', '#include <color_fragment>' + PAINT_APPLY);
  };
  const prevKey = m.customProgramCacheKey?.bind(m);
  m.customProgramCacheKey = () => (prevKey ? prevKey() : '') + '|v5-paint-5';
  m.needsUpdate = true;
}

/** брови Tripo (v5_brows.py: центр, полуширина, толщина, наклон, дуга, цвет) */
export interface V5BrowShape { x: number; y: number; z: number; hw: number; th: number; slope: number; bend: number; col: number[]; dk: number }

/** брови (форма) и глаза (центр x, y, полуоси) из точек лица; нет extras.brows (до v5e) — дуга над глазом по точкам */
function browsEyes(marks: Marks, bro?: { L?: V5BrowShape; R?: V5BrowShape }): { bg: THREE.Vector4[]; bs: THREE.Vector4[]; eyes: THREE.Vector4[] } {
  const bg: THREE.Vector4[] = [], bs: THREE.Vector4[] = [], eyes: THREE.Vector4[] = [];
  for (const s of ['L', 'R'] as const) {
    const o = marks[`eyeOuter${s}`], i = marks[`eyeInner${s}`], b = marks[`eyeBottom${s}`];
    const top = marks[`eyeTop${s}`] ?? b[1] + 0.06;
    const cx = (o[0] + i[0]) / 2, hw = Math.abs(o[0] - i[0]) / 2;
    const sh = bro?.[s];
    if (sh) {
      // v5f: бровь как на рефе — тонкая короткая дуга ближе к глазу (бровь Tripo — широкий тёмный мазок высоко на валике)
      const B = V5_BROW_SHAPE;
      bg.push(new THREE.Vector4(sh.x + Math.sign(sh.x) * B.dx, sh.y + B.dy, sh.hw * B.hw, B.th));
      bs.push(new THREE.Vector4(sh.slope * B.slope, sh.bend * B.bend, sh.z, sh.dk));
    } else {
      const br = marks[`brow${s}`] ?? [cx, top + 0.02, hw];
      bg.push(new THREE.Vector4(br[0], br[1] - 0.012, br[2], 0.008));
      bs.push(new THREE.Vector4(0, 0.006, 0.1, 1));
    }
    // низ белка — eyeBottom; верх — ниже верха полосы ресниц
    const yTop = top - 0.008, cy = (yTop + b[1]) / 2;
    eyes.push(new THREE.Vector4(cx, cy, hw * 0.95, (yTop - b[1]) / 2));
  }
  return { bg, bs, eyes };
}

/**
 * Шейдер лица v5 на теле, мех-оболочках и прядях (они в тех же координатах покоя): румянец (W.blush), дуги бровей
 * (насыщенность — v5BrowInk), слёзы (W.tear). Возвращает униформы; null — у модели нет точек лица.
 */
export function attachV5Paint(model: THREE.Object3D, marks: Marks | undefined, bro?: { L?: V5BrowShape; R?: V5BrowShape }): V5PaintU | null {
  if (!marks) return null;
  const u: V5PaintU = {
    blush: { value: 0 }, browInk: { value: new THREE.Vector2() }, browPose: { value: [new THREE.Vector4(), new THREE.Vector4()] },
    tear: { value: 0 }, tearT: { value: new THREE.Vector2(0.3, 0.3) }, browsDrawn: !!(bro?.L && bro?.R),
  };
  const centers = v5CheekCenters(marks).map((c) => new THREE.Vector3(...c));
  const { bg, bs, eyes } = browsEyes(marks, bro);
  // цвет брови — во столько раз темнее меха (бровь Tripo: ~0.7 меха, к синему — меньше)
  const bk = new THREE.Vector3(...V5_BROW_K);
  const done = new Set<THREE.Material>();
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !/^(Body_Glitter_V5|BD_FurShell_|BD_FurShellX|BD_FurCards)/.test(m.name)) return;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      if (done.has(mat)) continue;
      done.add(mat);
      patchPaint(mat, u, centers, bg, bs, bk, eyes);
    }
  });
  return u;
}

/** прежнее имя (v5b): только сила румянца */
/** v5e: множитель цвета брови к меху (покой — как бровь Tripo) и насыщенность в покое / в эмоции */
export const V5_BROW_K: [number, number, number] = [0.64, 0.67, 0.78];
export const V5_BROW_INK = { rest: 1, emo: 1.2 };
/** v5f: форма брови к брови Tripo: сдвиг (м: наружу, вниз), доли полуширины, наклона и дуги, толщина (м) */
export const V5_BROW_SHAPE = { dx: 0.002, dy: -0.009, hw: 0.68, slope: 0.6, bend: 0.45, th: 0.0062 };

export function attachV5Blush(model: THREE.Object3D, marks: Marks | undefined): { value: number } | null {
  return attachV5Paint(model, marks)?.blush ?? null;
}

// ───────────────────────── накладка рта: формы рта шейдером ─────────────────────────
const MOUTH_FS = `
uniform vec2 uMouthUV0;
uniform vec2 uMouthMM;
uniform vec4 uLine;
uniform vec4 uLine2;
uniform vec4 uOpen;
uniform vec4 uOpen2;
uniform float uCover;`;
const MOUTH_APPLY = `
  {
    vec2 mp = (vMapUv - uMouthUV0) * uMouthMM * vec2(1.0, -1.0);
    float aa = max(length(fwidth(mp)), 0.05);
    float outA = 0.0;
    // закрытый рот: линия y(x) = y уголков + изгиб·(1 − |u|^1.5) + наклон·u, к уголкам тоньше; губка под серединой
    if (uLine2.y > 0.001) {
      float hw = uLine.x, u = mp.x / hw, au = abs(u);
      float yl = uLine.y + uLine.z * (1.0 - pow(min(au, 1.0), 1.5)) + uLine.w * u;
      // «ω»: две дужки вниз посередине (v5d, подмигнуть)
      float om = 2.0 * min(au, 1.0) - 1.0;
      yl -= uLine2.w * 4.5 * (1.0 - om * om) * step(au, 1.0);
      float sl = (-uLine.z * 1.5 * sqrt(max(au, 1e-3)) * sign(u) + uLine.w) / hw;
      float d = abs(mp.y - yl) / sqrt(1.0 + sl * sl);
      float th = uLine2.x * (1.0 - 0.5 * au * au);
      float la = (1.0 - smoothstep(th * 0.5 - aa * 0.5, th * 0.5 + aa * 0.5, d)) * (1.0 - smoothstep(0.9, 1.0, au));
      vec2 q = vec2(mp.x / (hw * 0.3), (mp.y - (uLine.y + uLine.z * 0.78 - 1.6)) / 1.8);
      float lip = (1.0 - smoothstep(0.75, 1.0, length(q))) * uLine2.z * step(mp.y, yl);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.88, 0.58, 0.64), lip * uLine2.y);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.22, 0.13, 0.20), la * uLine2.y);
      outA = max(outA, max(la, lip) * uLine2.y);
    }
    // открытый рот: между верхом (дуга или плоский — смех) и низом-полуэллипсом; полость, язычок, клычки, кромка
    if (uOpen2.x > 0.001) {
      float hw = uOpen.x, u = mp.x / hw, au = abs(u);
      float s = sqrt(max(1.0 - u * u, 0.0));
      float top = uOpen.y + uOpen.z * mix(s, 1.0 - u * u, uOpen2.y);
      float bot = uOpen.y - uOpen.w * s;
      float sd = max(max(mp.y - top, bot - mp.y), (au - 1.0) * hw * 0.5);
      float ins = 1.0 - smoothstep(-aa * 0.5, aa * 0.5, sd);
      float rim = 1.0 - smoothstep(0.45 - aa * 0.5, 0.45 + aa * 0.5, abs(sd + 0.2));
      float dt = clamp((mp.y - bot) / max(top - bot, 1e-3), 0.0, 1.0);
      vec3 cav = mix(vec3(0.40, 0.07, 0.13), vec3(0.16, 0.02, 0.06), smoothstep(0.0, 0.45, dt));
      vec2 tq = vec2(mp.x / (hw * 0.5), (mp.y - (uOpen.y - uOpen.w * 0.95)) / (uOpen.w * 0.38 + 0.3));
      float tg = (1.0 - smoothstep(0.8, 1.0, length(tq))) * uOpen2.w;
      cav = mix(cav, vec3(0.93, 0.50, 0.60) * (0.9 + 0.1 * tq.y), tg);
      for (int k = 0; k < 2; k++) {
        float fx = (k == 0 ? -0.55 : 0.55) * hw;
        float uf = fx / hw;
        float ft = uOpen.y + uOpen.z * mix(sqrt(max(1.0 - uf * uf, 0.0)), 1.0 - uf * uf, uOpen2.y);
        float fl = clamp(0.16 * (top - bot), 1.5, 3.6), fw = 0.45 * fl;
        float ty = (ft - mp.y) / fl;
        float fa = step(0.0, ty) * (1.0 - smoothstep(fw * (1.0 - ty) - aa * 0.5, fw * (1.0 - ty) + aa * 0.5, abs(mp.x - fx)));
        cav = mix(cav, vec3(0.98, 0.97, 0.95), fa * uOpen2.z * step(ty, 1.0));
      }
      vec3 col = mix(cav, vec3(0.30, 0.12, 0.18), rim * (1.0 - ins * 0.3));
      float a = max(ins, rim) * uOpen2.x;
      diffuseColor.rgb = mix(diffuseColor.rgb, col, a);
      outA = max(outA, a);
    }
    diffuseColor.a = max(diffuseColor.a, outA) * uCover;
  }`;

export interface V5MouthU {
  uv0: { value: THREE.Vector2 }; mm: { value: THREE.Vector2 };
  line: { value: THREE.Vector4 }; line2: { value: THREE.Vector4 }; open: { value: THREE.Vector4 }; open2: { value: THREE.Vector4 };
  cover: { value: number };
}

/** накладка рта Mouth_V5 (v5_mouth.py): шейдер форм рта; null — у модели нет */
export function attachV5Mouth(model: THREE.Object3D, info: { uv0: number[]; mm: number[] } | undefined): { mesh: THREE.Mesh; u: V5MouthU } | null {
  const mesh = model.getObjectByName('Mouth_V5') as THREE.Mesh | undefined;
  if (!mesh?.isMesh || !info) return null;
  const u: V5MouthU = {
    uv0: { value: new THREE.Vector2(info.uv0[0], info.uv0[1]) }, mm: { value: new THREE.Vector2(info.mm[0], info.mm[1]) },
    line: { value: new THREE.Vector4() }, line2: { value: new THREE.Vector4() }, open: { value: new THREE.Vector4() }, open2: { value: new THREE.Vector4() },
    cover: { value: 0 },
  };
  const m = mesh.material as THREE.MeshStandardMaterial;
  m.transparent = true;
  m.depthWrite = false;
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    sh.uniforms.uMouthUV0 = u.uv0; sh.uniforms.uMouthMM = u.mm;
    sh.uniforms.uLine = u.line; sh.uniforms.uLine2 = u.line2; sh.uniforms.uOpen = u.open; sh.uniforms.uOpen2 = u.open2;
    sh.uniforms.uCover = u.cover;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>' + MOUTH_FS)
      .replace('#include <map_fragment>', '#include <map_fragment>' + MOUTH_APPLY);
  };
  m.customProgramCacheKey = () => 'v5-mouth-1';
  m.needsUpdate = true;
  mesh.renderOrder = 2;
  mesh.visible = false;
  return { mesh, u };
}

// ───────────────────────── v5d: настоящие глаза поверх нарисованных (Eyes_V5, v5_eyes.py) ─────────────────────────
/** один глаз в asset.extras.glitterV5.eyes: px снимка 0.1 мм ↔ uv атласа, эллипс радужки, зрачок */
export interface V5EyeSide {
  /** uv = (plate[0] + x·plate[2], plate[1] + y·plate[2]) — x, y — px снимка (y вниз) */
  plate: number[];
  /** центр радужки, px снимка */
  c: number[];
  /** px − c → единичный круг радужки (2×2 по строкам) */
  ai: number[];
  /** центр квадрата радужки в атласе (uv) и uv на единицу радиуса */
  iris: number[];
  /** радиус зрачка в единицах радиуса радужки */
  pupil: number;
}
export interface V5EyesInfo {
  mmPerPx: number;
  L: V5EyeSide;
  R: V5EyeSide;
}

const EYE_FS = `
uniform vec3 uEPlate[2];
uniform vec2 uEC[2];
uniform vec4 uEAi[2];
uniform vec3 uEIris[2];
uniform vec4 uEGaze[2];
uniform float uEPr0;
uniform float uEPupil;
uniform float uEHi;
uniform float uESpiral;
uniform float uETime;
uniform float uEWet;
uniform float uESpark;
uniform vec2 uEClosed;
uniform vec4 uLidE[60];
uniform vec4 uLidX;
uniform float uETear;
uniform vec4 uETearE[2];
varying vec3 vEP;
// v5f: накладка прячется над кромкой опущенного верхнего века и под кромкой поднятого нижнего (там — кожа тела)
float v5LidHide(vec3 p) {
  int e = p.x > 0.0 ? 0 : 1;
  float x0 = e == 0 ? uLidX.x : uLidX.z, x1 = e == 0 ? uLidX.y : uLidX.w;
  float t = (p.x - x0) / (x1 - x0);
  if (t < -0.02 || t > 1.02) return 0.0;
  float k = clamp(t, 0.0, 1.0) * 29.0;
  int i0 = int(floor(k));
  int i1 = min(i0 + 1, 29);
  vec4 E = mix(uLidE[e * 30 + i0], uLidE[e * 30 + i1], k - float(i0));
  float hu = smoothstep(0.0002, 0.0008, E.y - E.x) * smoothstep(E.x - 0.0007, E.x - 0.0002, p.y);
  float hl = smoothstep(0.0002, 0.0008, E.z - E.w) * (1.0 - smoothstep(E.z, E.z + 0.0005, p.y));
  return max(hu, hl);
}`;
/** v5h: лужица слёз в накладке глаза — высота воды над низом разреза у центра, м */
export const V5_TEAR_POOL = { h: 0.006 };
/** v5f: радужка крупнее (реф: крупная радужка, белка мало) — масштаб круга радужки на плашке */
export const V5_IRIS_SCALE = 1.18;
const EYE_MAP = `
  float v5Hl = 0.0;
  #ifdef USE_MAP
  {
    int si = vMapUv.x < 0.5 ? 0 : 1;
    vec3 pl = uEPlate[si];
    vec2 px = (vMapUv - pl.xy) / pl.z;
    vec4 base = texture2D(map, vMapUv);
    vec4 gz = uEGaze[si];  // сдвиг радужки (px), cos рысканья и тангажа (ракурс круга)
    vec2 d = px - uEC[si] - gz.xy;
    d /= vec2(gz.z, gz.w);
    vec4 a = uEAi[si];
    vec2 q = vec2(a.x * d.x + a.y * d.y, a.z * d.x + a.w * d.y) / ${V5_IRIS_SCALE.toFixed(3)};
    float r = length(q);
    // зрачок: радиальный перерасчёт (как у 3D-глаз eyeRig): шире/уже, радужка сжимается к кайме
    float pr = uEPr0 * uEPupil;
    float rr = r < pr ? r * uEPr0 / pr : (r < 1.0 ? uEPr0 + (r - pr) * (1.0 - uEPr0) / (1.0 - pr) : r);
    vec2 qs = r > 1e-5 ? q * (rr / r) : q;
    vec3 ir = uEIris[si];
    vec4 ic = r < 1.08 ? texture2D(map, ir.xy + qs * ir.z) : vec4(0.0);
    // альфа плашки: 0…0.75 — кайма за разрезом (пиксели Tripo), 0.75…1 — разрез; радужка — только в разрезе
    float inE = smoothstep(0.76, 0.95, base.a);
    vec3 col = mix(base.rgb, ic.rgb, ic.a * inE);
    if (uESpiral > 0.001) {
      float an = atan(q.y, q.x);
      float sp = sin(r * 16.0 + an - uETime * 7.0);
      vec3 spc = mix(vec3(0.95), vec3(0.06), smoothstep(-0.3, 0.3, sp));
      col = mix(col, spc, uESpiral * inE * (1.0 - smoothstep(1.0, 1.08, r)));
    }
    // влажные блики: большой мягкий сверху-справа (свет сцены) и маленький снизу-слева — едут с радужкой
    // v5g: умиление — блики крупнее («сияющие» глаза), слёзы — влажная дуга-блик по низу радужки и третий блик
    float sk = 1.0 + 0.7 * uESpark;
    vec2 h1 = q - vec2(0.34, -0.36) * mix(1.0, 0.92, uESpark), h2 = q - vec2(-0.30, 0.34);
    float b1 = 1.0 - smoothstep(0.11 * sk, 0.2 * sk, length(h1 * vec2(1.0, 1.25)));
    float b2 = 1.0 - smoothstep(0.035 * (1.0 + 1.3 * uESpark), 0.075 * (1.0 + 1.3 * uESpark), length(h2));
    vec2 h3 = q - vec2(0.0, 0.5);
    float wa = abs(length(h3 * vec2(0.62, 1.0)) - 0.42);
    float b3 = (1.0 - smoothstep(0.015, 0.045, wa)) * smoothstep(0.55, 0.85, q.y) * (1.0 - smoothstep(0.5, 0.75, abs(q.x)));
    float b4 = 1.0 - smoothstep(0.02, 0.05, length(q - vec2(0.12, -0.52)));
    v5Hl = (b1 * 0.85 + b2 * 0.7 + (b3 * 0.55 + b4 * 0.6) * uEWet) * uEHi * inE * (1.0 - uESpiral);
    col = mix(col, col * 1.12 + vec3(0.02, 0.04, 0.06), 0.6 * uEWet * inE);
    // v5h: слёзы — голубая «лужица» вдоль всего нижнего края разреза (реф sad): вода по низу белка и радужки, светлая
    // кромка-блик сверху; координаты покоя (едет с веком и кожей). Под накладкой кожа не видна — лужица здесь, не на теле
    if (uETear > 0.001) {
      vec4 te = vEP.x > 0.0 ? uETearE[0] : uETearE[1];
      float tu = (vEP.x - te.x) / te.z;
      if (abs(tu) < 1.1) {
        float tuc = clamp(tu, -0.995, 0.995);
        float yb = te.y - te.w * sqrt(1.0 - tuc * tuc);
        float dy = vEP.y - yb;
        float side = 1.0 - smoothstep(0.78, 1.02, abs(tu));
        float lvl = ${V5_TEAR_POOL.h.toFixed(4)} * (1.0 - 0.35 * tuc * tuc);
        float pool = smoothstep(-0.0025, -0.0008, dy) * (1.0 - smoothstep(lvl - 0.0012, lvl, dy)) * side;
        float hl = (1.0 - smoothstep(0.0003, 0.0011, abs(dy - lvl + 0.0007))) * (1.0 - smoothstep(0.5, 0.85, abs(tu)));
        vec3 wc = mix(vec3(0.30, 0.58, 0.98), vec3(0.55, 0.80, 1.0), smoothstep(-0.001, lvl, dy));
        col = mix(col, mix(col, wc, 0.55) * 1.08 + vec3(0.0, 0.05, 0.12), pool * uETear);
        col = mix(col, vec3(0.95, 0.98, 1.0), hl * 0.85 * uETear);
        v5Hl = max(v5Hl, hl * 0.5 * uETear * uEHi);
      }
    }
    // влага у нижнего края (слёзы): блестящая полоска по низу белка
    // v5e: глаз закрыт (моргание, «^») — накладки нет: под кромкой века не просвечивает полоска радужки
    diffuseColor *= vec4(col, clamp(base.a / 0.75, 0.0, 1.0) * (1.0 - (si == 0 ? uEClosed.x : uEClosed.y)) * (1.0 - v5LidHide(vEP)));
  }
  #endif`;
const EYE_EMIT = `#include <emissivemap_fragment>
  totalEmissiveRadiance += vec3(1.0) * v5Hl;`;

export interface V5EyesU {
  gaze: { value: THREE.Vector4[] };
  /** v5e: закрытость глаз L, R (как у века) — накладка гаснет */
  closed: { value: THREE.Vector2 };
  /** v5f: кромки век (V5LidEdges.E) и столбцы (X) */
  lidE: { value: THREE.Vector4[] };
  lidX: { value: THREE.Vector4 };
  pupil: { value: number };
  hi: { value: number };
  spiral: { value: number };
  time: { value: number };
  /** v5g: влажность глаз и сияние бликов */
  wet: { value: number };
  spark: { value: number };
  /** v5h: слёзы 0..1 (лужица по низу разреза) и овалы глаз (центр x, y, полуоси; L, R — как uEye шейдера лица) */
  tear: { value: number };
  tearE: { value: THREE.Vector4[] };
}

/** накладка глаз Eyes_V5: шейдер белка/радужки/зрачка/бликов; null — у модели нет */
export function attachV5Eyes(model: THREE.Object3D, info: V5EyesInfo | undefined): { mesh: THREE.Mesh; u: V5EyesU; info: V5EyesInfo } | null {
  const mesh = model.getObjectByName('Eyes_V5') as THREE.Mesh | undefined;
  if (!mesh?.isMesh || !info) return null;
  const u: V5EyesU = {
    gaze: { value: [new THREE.Vector4(0, 0, 1, 1), new THREE.Vector4(0, 0, 1, 1)] },
    pupil: { value: 1 }, hi: { value: 1 }, spiral: { value: 0 }, time: { value: 0 }, closed: { value: new THREE.Vector2() },
    wet: { value: 0 }, spark: { value: 0 }, tear: { value: 0 }, tearE: { value: [new THREE.Vector4(0, 0, 1, 1), new THREE.Vector4(0, 0, 1, 1)] },
    lidE: { value: Array.from({ length: 60 }, () => new THREE.Vector4(0, 0, -1, -1)) }, lidX: { value: new THREE.Vector4(0, 0, 0, 0) },
  };
  const sides = [info.L, info.R];
  const plate = sides.map((s) => new THREE.Vector3(s.plate[0], s.plate[1], s.plate[2]));
  const cc = sides.map((s) => new THREE.Vector2(s.c[0], s.c[1]));
  const ai = sides.map((s) => new THREE.Vector4(s.ai[0], s.ai[1], s.ai[2], s.ai[3]));
  const iris = sides.map((s) => new THREE.Vector3(s.iris[0], s.iris[1], s.iris[2]));
  const m = mesh.material as THREE.MeshStandardMaterial;
  // v5f: без зеркальной полосы окружения по радужке (блики рисует шейдер)
  m.roughness = 0.75;
  m.transparent = true;
  m.depthWrite = false;
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    sh.uniforms.uEPlate = { value: plate }; sh.uniforms.uEC = { value: cc }; sh.uniforms.uEAi = { value: ai };
    sh.uniforms.uEIris = { value: iris }; sh.uniforms.uEGaze = u.gaze; sh.uniforms.uEPr0 = { value: (info.L.pupil + info.R.pupil) / 2 };
    sh.uniforms.uEPupil = u.pupil; sh.uniforms.uEHi = u.hi; sh.uniforms.uESpiral = u.spiral; sh.uniforms.uETime = u.time;
    sh.uniforms.uEWet = u.wet; sh.uniforms.uESpark = u.spark;
    sh.uniforms.uEClosed = u.closed;
    sh.uniforms.uLidE = u.lidE; sh.uniforms.uLidX = u.lidX;
    sh.uniforms.uETear = u.tear; sh.uniforms.uETearE = u.tearE;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vEP;')
      .replace('#include <morphtarget_vertex>', '#include <morphtarget_vertex>\n  vEP = transformed;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>' + EYE_FS)
      .replace('#include <map_fragment>', EYE_MAP)
      .replace('#include <emissivemap_fragment>', EYE_EMIT);
  };
  m.customProgramCacheKey = () => 'v5-eyes-6';
  m.needsUpdate = true;
  mesh.renderOrder = 1;
  return { mesh, u, info };
}

/** вход взгляда v5 за кадр */
export interface V5GazeInput {
  /** направление на цель у каждого глаза (рад): рысканье (> 0 — к +X модели, влево у кота) и тангаж (> 0 — вверх); null — прямо */
  aim: [number, number, number, number] | null;
  /** зрачок пресета (content/face.json pupils) */
  pupils: number;
  /** покой без речи — иногда взгляд в сторону */
  idle: boolean;
  /** смещение взгляда пресета (face.json gaze, рад: x — рысканье, y > 0 — вверх) */
  bias: [number, number] | null;
  /** удивление 0..1 — зрачок шире; спираль (dizzy) */
  wide: number;
  spiral: number;
  /** v5e: взгляд позы эмоции (рад, прибавка) и «смотрит на зрителя» 0..1 (без взгляда в сторону, саккады мельче) */
  emo?: [number, number];
  focus?: number;
}

/** «радиус яблока» для перевода угла в сдвиг радужки, мм (глаз Tripo ~82 мм шириной, радужка ~50 мм) */
export const V5_EYE_R = 34;
/** пределы взгляда (рад) */
export const V5_GAZE_LIM = { yaw: 0.62, up: 0.4, down: 0.5 };

/**
 * Взгляд нарисованных глаз (как EyeRig у 3D-глаз): цель (камера/палец) → сдвиг радужки; микросаккады 0.4–2 с, в покое
 * иногда взгляд в сторону, смещение пресета (обида — вбок); зрачок по пресету (удивление — шире). Скачок ~40 мс.
 * Без аллокаций в кадре; детерминирован при заданном rnd (tests/glitterV5.test.ts).
 */
export class V5Gaze {
  readonly yaw = [0, 0];
  readonly pitch = [0, 0];
  pupil = 1;
  /** тангаж обоих глаз (для век: взгляд вниз — веко ниже), рад */
  get lookPitch() { return (this.pitch[0] + this.pitch[1]) / 2; }
  private t = 0;
  private sacT = 0.6;
  private sac = { x: 0, y: 0 };
  private awayT = 5;
  private awayLeft = 0;
  private away = { x: 0, y: 0 };
  private biasS = { x: 0, y: 0 };
  /** выключить микросаккады и взгляд в сторону (листы: «взгляд влево/вправо…» ровно) */
  still = false;
  /** принудительный взгляд (рад, листы), null — по цели */
  force: [number, number] | null = null;
  constructor(private rnd: () => number = Math.random) {}

  update(dt: number, i: V5GazeInput) {
    this.t += dt;
    if (!this.still && (this.sacT -= dt) <= 0) {
      this.sacT = 0.4 + this.rnd() * 1.6;
      this.sac.x = (this.rnd() - 0.5) * 0.1;
      this.sac.y = (this.rnd() - 0.5) * 0.07;
    }
    const focus = i.focus ?? 0;
    if (focus > 0.3) this.awayLeft = 0;
    if (this.awayLeft > 0) this.awayLeft -= dt;
    else if (!this.still && i.idle && focus < 0.3 && (this.awayT -= dt) <= 0) {
      this.awayT = 4 + this.rnd() * 6;
      this.awayLeft = 0.7 + this.rnd() * 1.0;
      this.away.x = (this.rnd() < 0.5 ? -1 : 1) * (0.25 + this.rnd() * 0.2);
      this.away.y = (this.rnd() - 0.6) * 0.2;
    }
    const k0 = 1 - Math.exp(-dt / 0.15);
    // смещение пресета — рад, как у EyeRig (прибавка к рысканью и тангажу; sad [0, −0.15] — вниз)
    this.biasS.x += ((i.bias?.[0] ?? 0) * 1.3 - this.biasS.x) * k0;
    this.biasS.y += ((i.bias?.[1] ?? 0) * 1.3 - this.biasS.y) * k0;
    // v5e: поза эмоции (уже сглажена V5PoseMix) — вместо смещения пресета
    let ox = focus > 0 ? this.biasS.x * (1 - focus) : this.biasS.x, oy = focus > 0 ? this.biasS.y * (1 - focus) : this.biasS.y;
    if (i.emo) { ox += i.emo[0]; oy += i.emo[1]; }
    if (!this.still) {
      ox += this.sac.x * (1 - 0.6 * focus); oy += this.sac.y * (1 - 0.6 * focus);
      if (this.awayLeft > 0) { ox += this.away.x; oy += this.away.y; }
    }
    const k = 1 - Math.exp(-dt / 0.04);
    for (let e = 0; e < 2; e++) {
      let y = (i.aim ? i.aim[e * 2] : 0) + ox, p = (i.aim ? i.aim[e * 2 + 1] : 0) + oy;
      if (i.spiral > 0.5) { y = 0; p = 0; }
      if (this.force) { y = this.force[0]; p = this.force[1]; }
      y = clamp(y, -V5_GAZE_LIM.yaw, V5_GAZE_LIM.yaw);
      p = clamp(p, -V5_GAZE_LIM.down, V5_GAZE_LIM.up);
      this.yaw[e] += (y - this.yaw[e]) * k;
      this.pitch[e] += (p - this.pitch[e]) * k;
    }
    // зрачок: пресет; удивление — шире (продакт), к свету не привязан
    // v5e: на рефах зрачок почти не меняется (удивление — даже меньше): крупный зрачок радости/грусти с поворотом головы
    // заливал дальний глаз чёрным — пределы уже
    const pt = clamp(i.pupils, 0.85, 1.12) * (1 - 0.12 * c01(i.wide));
    this.pupil += (pt - this.pupil) * (1 - Math.exp(-dt / 0.12));
  }

  /** записать в униформы накладки (px снимка: x вправо = +X модели, y вниз) */
  write(u: V5EyesU, mmPerPx: number, spiral: number) {
    const rpx = V5_EYE_R / mmPerPx;
    for (let e = 0; e < 2; e++) {
      const y = this.yaw[e], p = this.pitch[e];
      u.gaze.value[e].set(rpx * Math.sin(y), -rpx * Math.sin(p) * 0.8, Math.max(0.55, Math.cos(y)), Math.max(0.6, Math.cos(p)));
    }
    u.pupil.value = this.pupil;
    u.time.value = this.t;
    u.spiral.value = clamp(spiral, 0, 1);
  }
}

/**
 * Направление на цель от глаз в осях головы (оси меша тела в позе привязки → кость Head): рысканье к +X меша, тангаж к +Y.
 * Глаза Tripo смотрят вперёд по +Z меша.
 */
export class V5EyeAim {
  private readonly loc: THREE.Vector3[] = [];
  private readonly ax = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  private readonly w = new THREE.Vector3();
  private readonly d = new THREE.Vector3();
  private readonly m3 = new THREE.Matrix3();
  readonly out: [number, number, number, number] = [0, 0, 0, 0];
  constructor(private readonly head: THREE.Object3D, body: THREE.SkinnedMesh, marks: Marks) {
    const bi = body.skeleton.bones.indexOf(head as THREE.Bone);
    const inv = (bi >= 0 ? body.skeleton.boneInverses[bi] : new THREE.Matrix4()).clone().multiply(body.bindMatrix);
    for (const s of ['L', 'R'] as const) {
      const o = marks[`eyeOuter${s}`], i = marks[`eyeInner${s}`];
      this.loc.push(new THREE.Vector3((o[0] + i[0]) / 2, (o[1] + i[1]) / 2, (o[2] + i[2]) / 2 - 0.02).applyMatrix4(inv));
    }
    const m3 = new THREE.Matrix3().setFromMatrix4(inv);
    // оси меша X, Y, Z → в осях кости
    this.ax[0].set(1, 0, 0).applyMatrix3(m3).normalize();
    this.ax[1].set(0, 1, 0).applyMatrix3(m3).normalize();
    this.ax[2].set(0, 0, 1).applyMatrix3(m3).normalize();
  }

  /** target — мир; результат в out: [yawL, pitchL, yawR, pitchR] */
  aim(target: THREE.Vector3) {
    this.head.updateWorldMatrix(true, false);
    const M = this.head.matrixWorld;
    this.m3.setFromMatrix4(M).invert();
    const X = this.ax[0], Y = this.ax[1], Z = this.ax[2];
    for (let e = 0; e < 2; e++) {
      this.w.copy(this.loc[e]).applyMatrix4(M);
      // направление на цель в осях кости → проекции на оси меша
      const lx = this.d.copy(target).sub(this.w).applyMatrix3(this.m3);
      const x = lx.dot(X), y = lx.dot(Y), z = Math.max(1e-4, lx.dot(Z));
      this.out[e * 2] = Math.atan2(x, z);
      this.out[e * 2 + 1] = Math.atan2(y, Math.hypot(x, z));
    }
    // сведение глаз — на четверть (мультяшный взгляд: близкая камера не делает кота косым)
    const o = this.out, my = (o[0] + o[2]) / 2, mp = (o[1] + o[3]) / 2;
    o[0] = my + 0.25 * (o[0] - my); o[2] = my + 0.25 * (o[2] - my);
    o[1] = o[3] = mp;
    return o;
  }
}

/** всё лицо v5c/v5d вместе: веки, брови по сторонам, накладка рта, глаза, шейдер лица — вызывать после цикла MORPH_TARGETS */
export class V5FaceRig {
  readonly st = v5State();
  private readonly bw: Record<string, number> = {};
  private readonly mp = v5MouthParams(v5State());
  /** v5d: взгляд нарисованных глаз (Eyes_V5) */
  readonly gaze = new V5Gaze();
  /** v5d: «закрытость» верхних век L, R (шейдер полосы ресниц века) */
  lidCover: { value: THREE.Vector2 } | null = null;
  /** v5e: закрытый глаз (моргание, «^»): полоса ресниц века → мех и тонкая кромка (шейдер века) */
  lidClosed: { value: THREE.Vector2 } | null = null;
  /** v5f: кромки век для накладки глаза (она прячется под опущенным веком — там кожа тела) */
  lidEdges: V5LidEdges | null = null;
  private lidW: Record<string, number> | null = null;
  /** v5e: поза эмоции (брови, голова, взгляд) — сглаженная; задаёт GlbCharacter (setPose) */
  readonly pose = new V5PoseMix();
  private readonly gz: [number, number] = [0, 0];
  constructor(
    private readonly lids: V5Lids | null,
    private readonly morph: THREE.Mesh[],
    readonly paint: V5PaintU | null,
    readonly mouth: { mesh: THREE.Mesh; u: V5MouthU } | null,
    readonly eyes: { mesh: THREE.Mesh; u: V5EyesU; info: V5EyesInfo } | null = null,
    readonly aimer: V5EyeAim | null = null,
  ) {}

  apply(W: Record<string, number>) {
    const st = this.st;
    st.look = this.eyes ? this.gaze.lookPitch : 0;
    if (this.lids) {
      const lw = applyV5Lids(this.lids, W, st);
      this.lidW = lw;
      if (lw && this.lidCover) this.lidCover.value.set(v5LidCover(lw, 'L'), v5LidCover(lw, 'R'));
      if (lw && this.lidClosed) this.lidClosed.value.set(v5LidClosed(lw, 'L'), v5LidClosed(lw, 'R'));
      this.lidEdges?.update();
      if (lw && this.eyes) {
        // накладка глаза гаснет только у почти закрытого (полоска радужки под кромкой), в «^» — сразу
        // v5h: раньше (0.45…0.75 вместо 0.6…0.95): веко уже рисует дугу закрытого глаза — под ней не просвечивает
        // бледный серп накладки (открытие после моргания)
        const e = (sd: 'L' | 'R') => { const c = v5LidClosed(lw, sd); return c01((c - 0.45) / 0.3); };
        this.eyes.u.closed.value.set(e('L'), e('R'));
      }
    }
    const bw = v5BodyWeights(W, st, this.bw);
    // v5f: кожа закрытого века (ключи тела eyeskin_L/R) — по закрытости глаза
    bw.eyeskin_L = this.lidW ? v5LidClosed(this.lidW, 'L') : 0;
    bw.eyeskin_R = this.lidW ? v5LidClosed(this.lidW, 'R') : 0;
    for (const m of this.morph) {
      const d = m.morphTargetDictionary!, inf = m.morphTargetInfluences!;
      for (const k in bw) {
        const i = d[k];
        if (i !== undefined) inf[i] = bw[k];
      }
    }
    if (this.paint) {
      this.paint.blush.value = clamp(W.blush ?? 0, 0, 1);
      if (this.paint.browsDrawn) {
        const ps = this.pose, ink = V5_BROW_INK.rest + (V5_BROW_INK.emo - V5_BROW_INK.rest) * c01(ps.emo);
        this.paint.browInk.value.set(ink, ink);
        const bp = this.paint.browPose.value;
        bp[0].set(ps.brow[0] / 1000, ps.brow[1] / 1000, ps.browIn / 1000, ps.bend / 1000);
        bp[1].set(ps.brow[2] / 1000, ps.brow[3] / 1000, ps.browIn / 1000, ps.bend / 1000);
      } else this.paint.browInk.value.set(v5BrowInk(bw, 'L', st), v5BrowInk(bw, 'R', st));
      this.paint.tear.value = c01(st.tear);
    }
    if (this.mouth) {
      const p = v5MouthParams(st, this.mp), u = this.mouth.u;
      u.line.value.fromArray(p.line); u.line2.value.fromArray(p.line2);
      u.open.value.fromArray(p.open); u.open2.value.fromArray(p.open2);
      u.cover.value = st.cover;
      this.mouth.mesh.visible = st.cover > 0.002;
    }
  }

  /** v5d: взгляд — после позы головы (цель: камера, палец, точка lookAt) */
  updateEyes(dt: number, target: THREE.Vector3 | null, W: Record<string, number>, pupils: number, idle: boolean, bias: [number, number] | null) {
    if (!this.eyes) return;
    const aim = target && this.aimer ? this.aimer.aim(target) : null;
    const spiral = W.eyes_spiral ?? 0;
    const ps = this.pose;
    this.gz[0] = ps.gaze[0]; this.gz[1] = ps.gaze[1];
    this.gaze.update(dt, { aim, pupils, idle, bias, wide: this.st.wide, spiral, emo: this.gz, focus: ps.focus });
    this.gaze.write(this.eyes.u, this.eyes.info.mmPerPx, spiral);
    // v5g: влага и сияние — по позе эмоции; капля слезы — свой цикл (нарастает у века и скатывается по щеке)
    this.eyes.u.wet.value = c01(Math.max(ps.wet, this.st.tear));
    this.eyes.u.spark.value = c01(ps.sparkle);
    this.eyes.u.tear.value = c01(this.st.tear);
    if (this.paint) {
      this.tearClock = this.st.tear > 0.02 ? this.tearClock + dt : 0;
      this.paint.tearT.value.set(v5TearPhase(this.tearClock, 0), v5TearPhase(this.tearClock, 1));
    }
  }
  private tearClock = 0;
}

/** собрать лицо v5c/v5d модели (asset.extras.glitterV5) */
export function attachV5Face(
  model: THREE.Object3D,
  ex: { marks?: Marks; mouth?: { uv0: number[]; mm: number[] }; eyes?: V5EyesInfo; brows?: { L?: V5BrowShape; R?: V5BrowShape }; lidOuter?: { L?: number; R?: number } } | undefined,
  morph: THREE.Mesh[],
): V5FaceRig {
  const lids = model.getObjectByName('Lids_V5') as THREE.Mesh | undefined;
  // v5d: веко с альфой (мех над ресницами растворяется в мех тела) — поверх накладки глаз, с записью глубины
  const lm = lids?.material as THREE.MeshStandardMaterial | undefined;
  const cover = { value: new THREE.Vector2() }, closedU = { value: new THREE.Vector2() };
  if (lids && lm?.transparent) {
    lm.depthWrite = true;
    lids.renderOrder = 2;
    patchLid(lm, cover, closedU, new THREE.Vector2(ex?.lidOuter?.L ?? 0, ex?.lidOuter?.R ?? 0));
  }
  const eyes = attachV5Eyes(model, ex?.eyes);
  let aimer: V5EyeAim | null = null;
  const body = model.getObjectByName('Body_Glitter_V5') as THREE.SkinnedMesh | undefined;
  if (eyes && ex?.marks && body?.isSkinnedMesh) {
    const head = body.skeleton.bones.find((b) => /(^|:)Head$/.test(b.name.replace(/^mixamorig/, '')));
    if (head) aimer = new V5EyeAim(head, body, ex.marks);
  }
  const rig = new V5FaceRig(lids?.morphTargetDictionary ? { mesh: lids } : null, morph.filter((m) => m.name !== 'Lids_V5'), attachV5Paint(model, ex?.marks, ex?.brows), attachV5Mouth(model, ex?.mouth), eyes, aimer);
  if (lm?.transparent) { rig.lidCover = cover; rig.lidClosed = closedU; }
  if (eyes && ex?.marks) eyes.u.tearE.value = browsEyes(ex.marks, ex.brows).eyes;
  if (lids && eyes) {
    rig.lidEdges = new V5LidEdges(lids);
    eyes.u.lidE.value = rig.lidEdges.E;
    eyes.u.lidX.value = rig.lidEdges.X;
  }
  return rig;
}

// ───────────────────────── живое лицо v5 (покой и речь) ─────────────────────────
/**
 * Микромимика нарисованного лица Tripo поверх FaceLife (v5d: глаза смотрят сами — V5Gaze; голова по-прежнему
 * доворачивается микроповоротами):
 *  • моргания с естественным ритмом: интервал 1,8–6 с (чаще короткие), каждое ~5-е — двойное (второе через 0,22 с);
 *    длительность 0,13–0,18 с, закрытие быстрее открытия;
 *  • «взгляд»: раз в 0,7–2,6 с голова чуть доворачивает (саккада ≤ 2,2° по рысканью, ≤ 1,3° по тангажу, ≈ 70 мс), веки
 *    следуют за взглядом вниз; в речи иногда «отводит взгляд» (вверх-вбок, на 0,6–1,2 с — думает);
 *  • улыбка дышит: уголки и щёки в такт дыханию (период 3,4 с, как FaceLife.head.breath) и медленный дрейф;
 *  • речь: брови и щёки живут от огибающей рта (ударные слоги — брови вверх, широкие гласные — щёки вверх), раз в
 *    1,5–3,5 с — акцент бровями (вверх или «домиком»).
 * Детерминировано при заданном rnd (тесты tests/glitterV5.test.ts), без аллокаций в кадре.
 */
export class V5Life {
  /** выключить (листы-кадры: статичное лицо) */
  off = false;
  /** доп. поворот головы (рад), поверх FaceLife.head */
  readonly head = { yaw: 0, pitch: 0 };
  /** моргание 0..1 (оба века) */
  blink = 0;
  private t = 0;
  private readonly out: Record<string, number> = {};
  private nextBlink: number;
  private blinkT = -1;
  private blinkDur = 0.15;
  private second = false;
  private wasFirst = false;
  /** счётчики (тесты): морганий всего и двойных */
  blinks = 0;
  doubles = 0;
  private nextSac: number;
  private gaze = { yaw: 0, pitch: 0 };
  private away = 0;
  private nextAccent = 2;
  private accent = { t: -1, kind: 0 };
  private env = 0;
  private envSlow = 0;
  private wide = 0;

  constructor(private rnd: () => number = Math.random) {
    this.nextBlink = 1.5 + rnd() * 2;
    this.nextSac = 0.8 + rnd();
  }

  /** интервал до следующего моргания: логнормально около 3,2 с, 1,8–6 с */
  private blinkGap() {
    const u = this.rnd(), v = this.rnd();
    const n = Math.sqrt(-2 * Math.log(Math.max(1e-6, u))) * Math.cos(2 * Math.PI * v);
    return clamp(3.2 * Math.exp(0.35 * n), 1.8, 6);
  }

  /**
   * dt — с; open — открытие рта липсинка 0..1; wide — ширина рта 0..1; talk — огибающая речи FaceLife.talk 0..1;
   * calm — спокойное лицо (нейтральное/слушает: микромимика и улыбка дышат), noBlink — пресет без морганий
   */
  update(dt: number, open: number, wide: number, talk: number, calm: boolean, noBlink: boolean): Record<string, number> {
    for (const k in this.out) this.out[k] = 0;
    this.head.yaw = this.head.pitch = 0;
    this.blink = 0;
    if (this.off) return this.out;
    this.t += dt;
    const t = this.t;
    // ── моргания ──
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const p = this.blinkT / this.blinkDur;
      // закрытие ~40 % времени, открытие медленнее
      this.blink = p < 0.4 ? Math.sin((p / 0.4) * Math.PI * 0.5) : p < 1 ? Math.cos(((p - 0.4) / 0.6) * Math.PI * 0.5) ** 1.5 : 0;
      if (p >= 1) {
        this.blinkT = -1;
        // двойное: второе через ~0,07 с после открытия (≈ 0,22 с от начала первого)
        if (this.second) this.nextBlink = t + 0.07;
        else this.nextBlink = t + this.blinkGap();
        this.second = false;
      }
    } else if (t >= this.nextBlink && !noBlink) {
      this.blinkT = 0;
      this.blinkDur = 0.13 + 0.05 * this.rnd();
      // двойное — примерно каждое 5-е; второе моргание пары само двойным не бывает
      const pairSecond = this.wasFirst;
      this.second = !pairSecond && this.rnd() < 0.2;
      this.wasFirst = this.second;
      this.doubles += this.second ? 1 : 0;
      this.blinks++;
    }
    if (noBlink) {
      this.blinkT = -1;
      this.blink = 0;
    }
    // ── взгляд: саккады головой ──
    if (t >= this.nextSac) {
      const thinking = talk > 0.3 && this.rnd() < 0.25;
      this.nextSac = t + (thinking ? 0.6 + 0.6 * this.rnd() : 0.7 + 1.9 * this.rnd());
      this.away = thinking ? 1 : 0;
      this.gaze.yaw = (this.rnd() * 2 - 1) * (thinking ? 0.06 : 0.038);
      this.gaze.pitch = thinking ? 0.035 + 0.015 * this.rnd() : (this.rnd() * 2 - 1) * 0.022;
    }
    const k = 1 - Math.exp(-dt / 0.07);
    this.sacY += (this.gaze.yaw - this.sacY) * k;
    this.sacP += (this.gaze.pitch - this.sacP) * k;
    this.head.yaw = this.sacY;
    this.head.pitch = this.sacP;
    // взгляд вниз — веки чуть ниже (как глаз под веком), вверх — без изменений
    const lookDown = clamp(-this.sacP / 0.022, 0, 1);
    // ── речь: огибающая рта ──
    this.env += (open - this.env) * (1 - Math.exp(-dt / 0.06));
    this.envSlow += (open - this.envSlow) * (1 - Math.exp(-dt / 0.35));
    this.wide += (wide - this.wide) * (1 - Math.exp(-dt / 0.1));
    const o = this.out;
    if (talk > 0.05) {
      // ударный слог: рот открылся сильнее среднего — брови вверх
      const stress = clamp((this.env - this.envSlow) * 3, 0, 1);
      o.brow_up = talk * (0.12 + 0.35 * stress + 0.06 * Math.sin(t * 2.3));
      o.cheek_up = talk * (0.15 + 0.35 * this.wide + 0.1 * Math.sin(t * 1.7 + 1));
      o.smile = talk * (0.1 + 0.08 * Math.sin(t * 0.9));
      if (t >= this.nextAccent) {
        this.nextAccent = t + 1.5 + 2 * this.rnd();
        this.accent = { t: 0, kind: this.rnd() < 0.7 ? 0 : 1 };
      }
    }
    if (this.accent.t >= 0) {
      this.accent.t += dt;
      const p = this.accent.t / 0.7;
      if (p >= 1) this.accent.t = -1;
      else {
        const e = Math.sin(Math.PI * p) * talk;
        if (this.accent.kind === 0) o.brow_up = Math.max(o.brow_up ?? 0, 0.55 * e);
        else o.brow_sad = 0.45 * e;
      }
    }
    if (calm) {
      // улыбка «дышит»: в такт дыханию + медленный дрейф; щёки — следом; брови изредка чуть приподняты
      const br = 0.5 + 0.5 * Math.sin((t * Math.PI * 2) / 3.4);
      const drift = 0.5 + 0.5 * Math.sin(t * 0.31 + 0.7);
      o.smile = Math.max(o.smile ?? 0, (0.12 + 0.14 * br + 0.12 * drift) * (1 - talk));
      o.cheek_up = Math.max(o.cheek_up ?? 0, (0.08 + 0.1 * br) * (1 - talk));
      o.brow_up = Math.max(o.brow_up ?? 0, 0.12 * Math.max(0, Math.sin(t * 0.47 + 2)) ** 3 * (1 - talk));
    }
    o.eyes_sleepy = 0.22 * lookDown;
    // «думает» (взгляд вверх-вбок в речи) — брови чуть вверх
    if (this.away && talk > 0.05) o.brow_up = Math.max(o.brow_up ?? 0, 0.22 * talk);
    return o;
  }

  private sacY = 0;
  private sacP = 0;
}
