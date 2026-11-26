/**
 * Блёстка v5 (models/v2/glitter_v5.glb, scripts/models/build_glitter_v5.sh): лицо Tripo как есть — нарисованные глаза,
 * ресницы, нос и открытая улыбка; мимика — поверх, без замены лица:
 *  • веки — меш Lids_V5 (материал и текстура тела): в покое вырожден в линию у верхней дуги ресниц (не виден), при
 *    моргании «шторка» в мех над глазом опускается на нарисованный глаз, у её кромки — та же дуга ресниц Tripo.
 *    Путь закрытия — 4 ключа lid{L,R}_1..4 (каждый — шаг от предыдущего положения): веко идёт по куполу глаза, а не по
 *    хорде (хорда при одном ключе уходила в глаз на 4 мм). Косого века (злость/грусть) нет — одним ключом оно резало
 *    радужку; злость и грусть — брови, рот и общее прикрытие (lidPose: brow_down/brow_sad прикрывают веко);
 *  • рот, брови, щёки — ключи тела с именами весов лица (mouth_A/E/O/U/M, smile, smirk, frown, brow_*, cheek_up):
 *    их ведёт прежний цикл GlbCharacter по MORPH_TARGETS.
 * Здесь — только веки: веса лица → влияния ключей Lids_V5 (чистая функция, тесты tests/glitterV5.test.ts).
 */
import * as THREE from 'three';
import { lidPose } from './eyeRig';

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** число ключей пути закрытия века */
export const V5_LID_KEYS = 4;

/** веса лица → влияния ключей век Lids_V5 (имя ключа → вес) */
export function v5LidWeights(w: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const side of ['L', 'R'] as const) {
    const p = lidPose(w, side, 0);
    // нижнего века у v5 нет: прищур (нижнее веко у eyeRig без моргания и смеха) — немного верхним
    const lo = lidPose({ ...w, [`blink_${side}`]: 0, [`wink_${side}`]: 0, eyes_laugh: 0 }, side, 0).lo;
    const c = clamp(p.up + 0.3 * lo * (1 - p.up), 0, 1);
    for (let k = 1; k <= V5_LID_KEYS; k++) out[`lid${side}_${k}`] = clamp(V5_LID_KEYS * c - (k - 1), 0, 1);
  }
  return out;
}

/** меш век v5 и его ключи; null — у модели нет */
export interface V5Lids {
  mesh: { morphTargetDictionary?: Record<string, number>; morphTargetInfluences?: number[] };
}

export function applyV5Lids(lids: V5Lids, w: Record<string, number>) {
  const d = lids.mesh.morphTargetDictionary, inf = lids.mesh.morphTargetInfluences;
  if (!d || !inf) return;
  const lw = v5LidWeights(w);
  for (const k in lw) {
    const i = d[k];
    if (i !== undefined) inf[i] = lw[k];
  }
}

// ───────────────────────── эмоции v5: сильнее и ближе к design/cut/glitter/face ─────────────────────────
/**
 * Пресеты content/face.json рассчитаны на 3D-глаза и рот-накладку других котов; на нарисованном лице Tripo те же веса
 * читаются слабо («каменное» лицо). Поверх итоговых весов кадра (до морфов и век), только для v5:
 *  • брови сильнее (домик грусти, сведённые при недовольстве, вверх при удивлении);
 *  • хмурый рот закрывает открытую улыбку Tripo (frown → mouth_M), уголки вниз сильнее, улыбка гаснет;
 *  • грусть и смущение — веки ниже (сонно), недовольство — прищур;
 *  • румянец (blush) рисует шейдер щёк (attachV5Blush) — отдельного ключа нет.
 * Меняет w на месте (без аллокаций в кадре).
 */
export const V5_EMO = { browSad: 2.2, browDown: 2.2, browUp: 1.5, frownClose: 1.0, frown: 1.8, sadLid: 0.42, downLid: 0.3, shyLid: 0.35 };

export function v5Emote(w: Record<string, number>): Record<string, number> {
  const g = (k: string) => w[k] ?? 0;
  const sad = g('brow_sad'), down = g('brow_down'), frown = g('frown'), blush = g('blush');
  if (sad) w.brow_sad = sad * V5_EMO.browSad;
  if (down) w.brow_down = down * V5_EMO.browDown;
  if (g('brow_up')) w.brow_up = g('brow_up') * V5_EMO.browUp;
  if (frown) {
    // открытая улыбка Tripo закрывается, иначе уголки вниз не читаются
    w.mouth_M = Math.max(g('mouth_M'), clamp(V5_EMO.frownClose * frown, 0, 1) * (1 - clamp(g('mouth_A') + g('mouth_O'), 0, 1)));
    w.smile = g('smile') * (1 - 0.7 * clamp(frown, 0, 1));
    w.frown = frown * V5_EMO.frown;
  }
  // надулась/обиделась (cheeks_gum с хмурым ртом) — по рефу offended тоже с румянцем
  if (g('cheeks_gum') && frown) w.blush = Math.max(blush, 0.8 * g('cheeks_gum'));
  const sleepy = Math.max(V5_EMO.sadLid * sad, V5_EMO.shyLid * blush);
  if (sleepy > g('eyes_sleepy')) w.eyes_sleepy = sleepy;
  if (down) w.eyes_squint = Math.max(g('eyes_squint'), V5_EMO.downLid * down + g('eyes_squint'));
  return w;
}

// ───────────────────────── румянец шейдером (тело, оболочки и пряди меха щёк) ─────────────────────────
interface Marks { eyeOuterL: number[]; eyeInnerL: number[]; eyeOuterR: number[]; eyeInnerR: number[]; eyeBottomL: number[]; eyeBottomR: number[] }

/** центры щёк (координаты покоя модели): под серединой глаза, ближе к краю лица */
export function v5CheekCenters(m: Marks): [number, number, number][] {
  return (['L', 'R'] as const).map((s) => {
    const o = m[`eyeOuter${s}`], i = m[`eyeInner${s}`], b = m[`eyeBottom${s}`];
    return [(0.4 * i[0] + 0.6 * o[0]) * 1.08, b[1] - 0.042, b[2] - 0.004] as [number, number, number];
  });
}

const BLUSH_VS = `
varying vec3 vBlushP;`;
const BLUSH_FS = `
uniform float uBlush;
uniform vec3 uBlushC[2];
varying vec3 vBlushP;`;
const BLUSH_APPLY = `
  {
    // румянец: два мягких овала на щеках (координаты покоя), только спереди
    float bw = 0.0;
    for (int i = 0; i < 2; i++) {
      vec3 d = (vBlushP - uBlushC[i]) / vec3(0.036, 0.024, 0.045);
      bw = max(bw, exp(-dot(d, d) * 1.4));
    }
    bw *= uBlush;
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.18, 0.62, 0.72) + vec3(0.1, 0.0, 0.015), clamp(bw, 0.0, 1.0));
  }`;

/** подключить румянец к материалу (обёртка поверх его onBeforeCompile; ключ программы — свой) */
function patchBlush(m: THREE.Material, uBlush: { value: number }, centers: THREE.Vector3[]) {
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    sh.uniforms.uBlush = uBlush;
    sh.uniforms.uBlushC = { value: centers };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>' + BLUSH_VS)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vBlushP = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>' + BLUSH_FS)
      .replace('#include <color_fragment>', '#include <color_fragment>' + BLUSH_APPLY);
  };
  const prevKey = m.customProgramCacheKey?.bind(m);
  m.customProgramCacheKey = () => (prevKey ? prevKey() : '') + '|v5-blush-1';
  m.needsUpdate = true;
}

/**
 * Румянец v5 на теле, мех-оболочках и прядях (они в тех же координатах покоя): вес — W.blush кадра (смущение, микромимика).
 * Возвращает униформу силы 0..1; null — у модели нет точек лица.
 */
export function attachV5Blush(model: THREE.Object3D, marks: Marks | undefined): { value: number } | null {
  if (!marks) return null;
  const u = { value: 0 };
  const centers = v5CheekCenters(marks).map((c) => new THREE.Vector3(...c));
  const done = new Set<THREE.Material>();
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !/^(Body_Glitter_V5|BD_FurShell_|BD_FurShellX|BD_FurCards)/.test(m.name)) return;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      if (done.has(mat)) continue;
      done.add(mat);
      patchBlush(mat, u, centers);
    }
  });
  return u;
}

// ───────────────────────── живое лицо v5 (покой и речь) ─────────────────────────
/**
 * Микромимика нарисованного лица Tripo поверх FaceLife (глаза не двигаются — 24–30 вершин на глаз, сдвиг радужки
 * искажал бы круг; взгляд — микроповоротами головы и век):
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
