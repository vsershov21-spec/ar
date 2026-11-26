/**
 * Настоящие 3D-глаза кота (модель — scripts/models/face_detail.py):
 *   Eye_L/Eye_R (дочерние к кости Head, +Z — вперёд) → EyeS_* (масштаб эллипсоида A, B, C) → EyeBall_*, LidUp_*, LidLo_*.
 * Яблоко вращается к цели взгляда (камера, палец) с микросаккадами и редкими взглядами в сторону; веки — поворот
 * оболочек вокруг оси X (моргание, прищур, смех «дугой», сонный взгляд) и вокруг оси Z (злость — внутренний уголок
 * вниз, грусть — вверх). Размер зрачка, спирали «головокружения» и два блика — в шейдере яблока (блики считаются
 * в пространстве камеры, поэтому всегда сверху-слева и «живые» при повороте глаза).
 * Без аллокаций в кадре; случайность — через rnd (тесты).
 */
import * as THREE from 'three';

export interface EyeExtras {
  side: 'L' | 'R';
  A: number;
  B: number;
  C: number;
  /** угол (рад) полного закрытия верхнего / нижнего века */
  closeUp: number;
  closeLo: number;
  /** радиусы радужки в uv (0.5 = вся сфера) */
  irisUV: [number, number];
  /** радиус зрачка в долях радужки (как нарисован) */
  pupil: number;
  /** верхнее веко в покое (доля закрытия) */
  restUp?: number;
  /**
   * тон мягкого века своей модели (persona_tune.py, Блёстка p4): яркость, подсветка, насыщенность, сила прядей шума;
   * без него — LID_FUR по характеру и 0.9 / 1 (как было)
   */
  lidTone?: [number, number, number, number];
}

export interface LidPose {
  /** закрытие верхнего века: 0 — покой, 1 — до встречи с нижним, < 0 — шире (удивление) */
  up: number;
  /** подъём нижнего века 0..1 */
  lo: number;
  /** наклон: > 0 — внутренний уголок вниз (злость), < 0 — вверх (грусть) */
  tilt: number;
  /** «дуга» 0..1 (смех, подмигивание): глаз закрывает нижнее веко, видна линия верхнего — «^», как на референсе */
  arc: number;
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const smooth01 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** веса лица → положение век одного глаза (чистая функция) */
export function lidPose(w: Record<string, number>, side: 'L' | 'R', rest = 0.05): LidPose {
  const g = (k: string) => w[k] ?? 0;
  const blink = Math.max(g(`blink_${side}`), g(`wink_${side}`));
  const laugh = g('eyes_laugh');
  const squint = g('eyes_squint');
  const smug = g('eyes_smug');
  const sleepy = g('eyes_sleepy');
  const wide = g('eyes_wide');
  const sad = g('brow_sad');
  const angry = g('brow_down');
  let up = rest * (1 - wide) + 0.22 * squint + 0.34 * smug + 0.55 * sleepy + 0.12 * sad + 0.2 * angry - 0.5 * wide;
  let lo = 0.42 * squint + 0.42 * smug + 0.18 * g('smile') + 0.25 * g('cheek_up') + 0.12 * sleepy;
  const shut = Math.max(blink, laugh);
  up += (1 - up) * shut;
  lo += (1 - lo) * Math.max(blink, laugh * 0.85);
  const arc = clamp(Math.max(laugh, g(`wink_${side}`)), 0, 1);
  return { up: clamp(up, -0.5, 1), lo: clamp(lo, 0, 1), tilt: clamp(0.3 * angry - 0.42 * sad, -0.45, 0.45), arc };
}

interface Eye {
  side: 'L' | 'R';
  pivot: THREE.Object3D;
  ball: THREE.Object3D;
  up: THREE.Object3D;
  lo: THREE.Object3D;
  ex: EyeExtras;
  /** слёзка (грусть), может отсутствовать */
  tear: THREE.Object3D | null;
  yaw: number;
  pitch: number;
}

export interface EyeInput {
  /** итоговые веса лица (пресет + эмоция + живость + моргание) */
  weights: Record<string, number>;
  /** зрачки 0.6 … 1.4 */
  pupils: number;
  /** куда смотреть (мир); null — прямо */
  target: THREE.Vector3 | null;
  /** кот в покое (можно смотреть в сторону) */
  idle: boolean;
  /** сдвиг взгляда от пресета (рад): x > 0 — влево для кота, y > 0 — вверх (смущение — в сторону и вниз) */
  bias?: [number, number] | null;
}

/**
 * Материал век (LidUp/LidLo, вершинный цвет — мех вокруг глаза и подводка у кромки): освещение как у кожи морды
 * (нормаль оболочки — сфера вокруг яблока: верх века смотрел в небо и светился полосой над глазом, низ темнел в серое),
 * пряди меха шумом в координатах века, без блика; подводка и ресницы (тёмный вершинный цвет) — как были.
 *
 * soft (мягкие веки, Хулиган и Добряк, 23.11): у геометрии есть атрибут aLid (см. softLidGeometry) — расстояние от кромки
 * (рад по оболочке) и сила ресниц. Вершинный цвет у кромки уже мех (без тёмных рядов), подводка рисуется в шейдере:
 * тонкая линия у самого края + ресницы разной длины, мягкий переход в мех (без «козырька» и резкой полосы); нормаль
 * всей оболочки, включая скруглённую кромку, сведена к оси глаза (закрытое веко не темнеет книзу); тон чуть теплее и
 * светлее — под мех вокруг (оболочки меха светлеют наружу, голая оболочка века выходила голубее и темнее).
 */
export function patchLid(m: THREE.MeshStandardMaterial, soft = false, lidN?: { value: THREE.Vector3 }, cut?: LidCut) {
  m.roughness = 0.95;
  m.metalness = 0;
  m.envMapIntensity = 0;
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    prev?.call(m, sh, r);
    if (lidN) sh.uniforms.uLidN = lidN;
    if (cut) {
      sh.uniforms.uLidCut = { value: cut.tex };
      sh.uniforms.uLidR = cut.rot;
      sh.uniforms.uLidBand = cut.band;
      sh.uniforms.uLidTone = { value: cut.tone };
    }
    sh.vertexShader = 'varying vec3 vLidP;\n' + (soft ? 'attribute vec2 aLid;\nvarying vec2 vLid;\n' : '') + (lidN ? 'uniform vec3 uLidN;\n' : '') +
      (cut ? 'uniform mat3 uLidR;\nvarying vec3 vLidE;\n' : '') + sh.vertexShader
      .replace(
        '#include <beginnormal_vertex>',
        // нормаль к «лицу» (ось глаза +Z) — веко освещено, как кожа вокруг глаза; у кромки — своя (скруглённый край)
        soft
          ? `#include <beginnormal_vertex>
  objectNormal = normalize(mix(objectNormal, ${lidN ? 'uLidN' : 'vec3(0.0, 0.25, 1.0)'}, 0.94));`
          : `#include <beginnormal_vertex>
  objectNormal = normalize(mix(objectNormal, vec3(0.0, 0.25, 1.0), 0.8));`,
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vLidP = position;' + (soft ? '\n  vLid = aLid;' : '') + (cut ? '\n  vLidE = uLidR * position;' : ''));
    const furCode = soft
      ? `{
    ${cut ? `// только в разрезе глаза (+ поле растворения): оболочка за разрезом торчала из морды диском с резким краем;
    // край — дизеринг по шуму экрана (без сортировки прозрачности и без полупрозрачного холста в AR), лепестки ресниц (aLid.x < 0) — всегда
    {
      vec3 cutE = normalize(vLidE);
      float cutD = cutE.z > 0.05 ? (texture2D(uLidCut, cutE.xy * ${(0.5 / CUT_SPAN).toFixed(4)} + 0.5).r - 0.5) * ${(2 * CUT_RANGE).toFixed(3)} : 1.0;
      float cutV = 1.0 - smoothstep(${CUT_FADE[0].toFixed(3)}, ${CUT_FADE[1].toFixed(3)}, cutD);
      // порог растворения: пряди (столбцы вдоль x, вытянуты по y, как мех морды) + мелкий шум экрана
      float cutS = fract(sin(dot(floor(cutE.xy * vec2(90.0, 14.0)), vec2(12.9898, 78.233))) * 43758.5453);
      float cutN = mix(fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))), cutS, 0.6);
      if (vLid.x >= 0.0 && cutV < 0.02 + 0.96 * cutN) discard;
      lidCutD = vLid.x >= 0.0 ? cutD : -1.0;
    }` : ''}
    // мех по всей оболочке (вершинный цвет у кромки — тоже мех), тон — под мех вокруг: чуть светлее и теплее
    float lidL0 = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
    diffuseColor.rgb = mix(vec3(lidL0), diffuseColor.rgb, ${cut ? 'uLidTone.z' : '0.9'}) * ${cut ? 'vec3(1.0)' : 'vec3(1.1, 1.0, 0.96)'};
    vec3 q1 = vLidP * vec3(140.0, 22.0, 140.0);
    vec3 q2 = vLidP * vec3(60.0, 10.0, 60.0) + 7.0;
    float n1 = fract(sin(dot(floor(q1), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    float n2 = fract(sin(dot(floor(q2), vec3(39.346, 11.135, 83.155))) * 43758.5453);
    diffuseColor.rgb *= ${cut ? 'uLidTone.x + uLidTone.w * (0.08 * (n1 - 0.5) + 0.1 * (n2 - 0.5))' : '1.34 + 0.08 * (n1 - 0.5) + 0.1 * (n2 - 0.5)'};
    ${cut ? `// закрытое веко — мягкий купол (реф: светлее к середине), к краю разреза — тон кожи вокруг
    diffuseColor.rgb *= 1.0 + 0.07 * smoothstep(0.0, -0.45, lidCutD);` : ''}
    // подводка: тонкая линия у края (≈ 0.02 рад) + ресницы (по столбцам вдоль кромки — разной длины), мягко в мех
    float e = vLid.x, ls = vLid.y;
    float col = vLidP.x * 38.0;
    float hc = fract(sin(floor(col) * 91.345) * 47453.53);
    float strand = smoothstep(0.5, 0.15, abs(fract(col) - 0.5)); // поперёк ресницы: центр столбца
    float len = mix(0.09, 0.16, hc) * ls;
    float lash = max(1.0 - smoothstep(0.032 * ls + 0.004, 0.08 * ls + 0.014, e), strand * (1.0 - smoothstep(0.3 * len, len, e)) * 0.85);
    float shade = 1.0 - smoothstep(0.0, 0.16 * ls + 0.04, e); // мягкая тень к кромке
    vec3 lashC = diffuseColor.rgb * 0.12 + vec3(0.006, 0.006, 0.012);
    diffuseColor.rgb *= 1.0 - 0.16 * shade * ls;
    diffuseColor.rgb = mix(diffuseColor.rgb, lashC, clamp(lash * (0.35 + 0.65 * ls), 0.0, 1.0));
    // изнанка оболочки (снизу при широко открытом глазе) — в тени, как ресницы, а не светлой полосой по радужке
    if (!gl_FrontFacing) { diffuseColor.rgb = lashC * 1.6; lash = 1.0; }
    lidFur = 1.0 - lash;
  }`
      : `{
    // мех: только там, где цвет светлый (не подводка), тонкие пряди вдоль века
    float lidL = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
    float fur = smoothstep(0.08, 0.2, lidL);
    // пряди: вытянуты вдоль века (по y), два масштаба — как мех оболочек вокруг
    vec3 q1 = vLidP * vec3(140.0, 22.0, 140.0);
    vec3 q2 = vLidP * vec3(60.0, 10.0, 60.0) + 7.0;
    float n1 = fract(sin(dot(floor(q1), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    float n2 = fract(sin(dot(floor(q2), vec3(39.346, 11.135, 83.155))) * 43758.5453);
    diffuseColor.rgb *= mix(1.0, 1.3 + 0.16 * (n1 - 0.5) + 0.1 * (n2 - 0.5), fur);
    lidFur = fur;
  }`;
    sh.fragmentShader = 'varying vec3 vLidP;\nfloat lidFur = 0.0;\nfloat lidCutD = -1.0;\n' + (soft ? 'varying vec2 vLid;\n' : '') +
      (cut ? 'uniform sampler2D uLidCut;\nuniform vec2 uLidBand;\nuniform vec4 uLidTone;\nuniform mat4 projectionMatrix;\nvarying vec3 vLidE;\n' : '') + sh.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
  ${furCode}`,
    ).replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
  totalEmissiveRadiance += diffuseColor.rgb * ${cut ? 'uLidTone.y' : soft ? '0.2' : '0.16'} * lidFur;`,
    );
    // закрывающееся веко поверх кромки глазницы: у края разреза и в поле растворения фрагмент чуть ближе к камере
    // (uLidBand.y — сдвиг, мир; .x — закрытие века 0..1): край кожи больше не режет веко резкой линией, оно уходит в мех
    if (cut)
      sh.fragmentShader = sh.fragmentShader.replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
  {
    float lidPull = uLidBand.x * uLidBand.y * (gl_FrontFacing ? 1.0 : 0.0);
    vec3 lidVp = -vViewPosition;
    lidVp *= 1.0 - lidPull / max(length(lidVp), 1e-4);
    vec4 lidClip = projectionMatrix * vec4(lidVp, 1.0);
    gl_FragDepth = lidPull > 0.0 ? clamp(0.5 * lidClip.z / lidClip.w + 0.5, 0.0, 1.0) : gl_FragCoord.z;
  }`,
      );
  };
  m.customProgramCacheKey = () => (soft ? (lidN ? (cut ? 'cat-lid-soft-cut-v1' : 'cat-lid-soft-n-v1') : 'cat-lid-soft-v1') : 'cat-lid-v2');
  m.needsUpdate = true;
}

/** ряды оболочки века от кромки (рад по оболочке) — как lid_mesh в scripts/models/face_detail.py */
export const LID_ROWS = [0, 0.05, 0.12, 0.26, 0.44, 0.825, 1.21, 1.595, 1.98, 2.365, 2.75];
/** тон меха мягкого века к вершинному цвету (сверка по листам docs/qa/face: закрытое веко = мех вокруг глаза) */
const LID_TONE: Record<string, number> = {};
/** мягкие веки с тоном меха (FurTone, маска лица): яркость и подсветка меха века по коту — сверка по lids.jpg */
const LID_FUR: Record<string, [number, number]> = { hooligan: [0.98, 0.08], kind: [0.98, 0.08], glitter: [0.95, 0.08] };
/** сила ресниц верхнего века (ширина подводки и длина ресниц; Блёстка — подводка толще, как на рефе) */
const LID_LASH: Record<string, number> = { glitter: 1.6 };

/**
 * Мягкие веки: атрибут aLid (x — расстояние от кромки по рядам LID_ROWS, y — сила ресниц: верхнее 1, нижнее 0.35) и
 * вершинный цвет кромочных рядов = мех того же столбца (подводку рисует шейдер). Сетка века — nu столбцов × 11 рядов
 * (nu — по нижнему веку); лишние вершины верхнего (лепестки Блёстки) — ресницы (кромка, тёмные). Не та сетка — false (веко как было).
 */
export function softLidGeometry(g: THREE.BufferGeometry, nu: number, lash: number, tone = 1): boolean {
  const n = g.attributes.position?.count ?? 0;
  const R = LID_ROWS.length;
  if (!nu || n < nu * R || g.userData.softLid) return !!g.userData.softLid;
  const a = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    // лишние вершины (лепестки ресниц Блёстки) — x = −1: ресница целиком, не растворяется за разрезом
    a[i * 2] = i < nu * R ? LID_ROWS[Math.floor(i / nu)] : -1;
    a[i * 2 + 1] = lash;
  }
  g.setAttribute('aLid', new THREE.BufferAttribute(a, 2));
  const c = g.attributes.color as THREE.BufferAttribute | undefined;
  if (c) {
    for (let j = 0; j < 4; j++)
      for (let k = 0; k < nu; k++) {
        const src = 4 * nu + k, dst = j * nu + k;
        c.setXYZ(dst, c.getX(src), c.getY(src), c.getZ(src));
      }
    if (tone !== 1) for (let i = 0; i < n; i++) c.setXYZ(i, c.getX(i) * tone, c.getY(i) * tone, c.getZ(i) * tone);
    c.needsUpdate = true;
  }
  g.userData.softLid = true;
  return true;
}

/** разрез глаза для мягких век: поле расстояния (единичное пространство глаза, вид спереди) и поворот века */
export interface LidCut {
  tex: THREE.DataTexture;
  /** поворот века (пространство века → пространство глаза EyeS), обновляется в update */
  rot: { value: THREE.Matrix3 };
  /** x — закрытие века 0..1, y — сдвиг к камере у кромки глазницы (мир); обновляется в update */
  band: { value: THREE.Vector2 };
  /** яркость меха века (x), подсветка (y) — под мех оболочек вокруг (у века оболочек нет), насыщенность (z) и сила прядей шума (w) */
  tone: THREE.Vector4;
}
/** поле разреза: квадрат ±CUT_SPAN единиц глаза, расстояние ±CUT_RANGE (> 0 — снаружи разреза) */
const CUT_SPAN = 1.3;
const CUT_RANGE = 0.5;
const CUT_N = 64;
/** растворение века за разрезом (единицы глаза): до [0] — непрозрачно, к [1] — нет */
export const CUT_FADE: [number, number] = [0.0, 0.16];
/** сдвиг закрывающегося века к камере у кромки глазницы (доля высоты глаза B) */
export const LID_PULL = 0.7;
/** закрытый глаз: яблоко меньше на эту долю (под кожу) */
export const BALL_SHUT = 0.12;

/**
 * Контур разреза из сеток мягких век: кромка (ряд 0) верхнего — верх разреза, нижнего — низ; вид спереди (x, y)
 * направления в единичном пространстве глаза. Возвращает многоугольник по часовой: верх слева направо, низ обратно.
 */
export function lidCutPolygon(up: THREE.BufferGeometry, lo: THREE.BufferGeometry, nu: number): [number, number][] {
  const v = new THREE.Vector3();
  const cols: [number, number, number][] = []; // x, y верха, y низа
  for (let k = 0; k < nu; k++) {
    v.fromBufferAttribute(up.attributes.position, k).normalize();
    const x = v.x, yu = v.y;
    v.fromBufferAttribute(lo.attributes.position, k).normalize();
    cols.push([(x + v.x) / 2, yu, v.y]);
  }
  cols.sort((a, b) => a[0] - b[0]);
  // уголки за разрезом (края сошлись) — прочь: иначе вдоль них тянется полоса века; по одному сошедшемуся столбцу с краёв
  const open = cols.map((c) => c[1] - c[2] > 1e-3);
  let a = open.indexOf(true), b = open.lastIndexOf(true);
  if (a < 0) return cols.map((c) => [c[0], c[1]] as [number, number]);
  a = Math.max(0, a - 1);
  b = Math.min(cols.length - 1, b + 1);
  const keep = cols.slice(a, b + 1);
  const pts: [number, number][] = keep.map((c) => [c[0], c[1]]);
  for (let k = keep.length - 1; k >= 0; k--) pts.push([keep[k][0], keep[k][2]]);
  return pts;
}

/** знаковое расстояние до многоугольника (> 0 — снаружи) */
export function polyDist(poly: [number, number][], x: number, y: number): number {
  let d = Infinity, inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j], [bx, by] = poly[i];
    const ex = bx - ax, ey = by - ay;
    const l2 = ex * ex + ey * ey;
    const t = l2 > 0 ? clamp(((x - ax) * ex + (y - ay) * ey) / l2, 0, 1) : 0;
    d = Math.min(d, Math.hypot(x - ax - t * ex, y - ay - t * ey));
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay || 1e-9) + ax) inside = !inside;
  }
  return inside ? -d : d;
}

/** центр клетки поля разреза (единицы глаза) */
const cutXY = (i: number) => ((i + 0.5) / CUT_N - 0.5) * 2 * CUT_SPAN;

/** записать поле расстояния (d(x, y) > 0 — снаружи) в данные текстуры разреза */
export function fillCut(data: Uint8Array, dist: (x: number, y: number, i: number, j: number) => number) {
  for (let j = 0; j < CUT_N; j++)
    for (let i = 0; i < CUT_N; i++) {
      const d = dist(cutXY(i), cutXY(j), i, j);
      const o = (j * CUT_N + i) * 4;
      data[o] = Math.round(clamp(d / (2 * CUT_RANGE) + 0.5, 0, 1) * 255);
      data[o + 3] = 255;
    }
}

export function lidCutTexture(poly: [number, number][]): THREE.DataTexture {
  const data = new Uint8Array(CUT_N * CUT_N * 4);
  fillCut(data, (x, y) => polyDist(poly, x, y));
  const t = new THREE.DataTexture(data, CUT_N, CUT_N, THREE.RGBAFormat);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

export class EyeRig {
  readonly eyes: Eye[] = [];
  readonly uniforms = {
    uPupil: { value: 1 },
    uSpiral: { value: 0 },
    uTime: { value: 0 },
    uIris: { value: new THREE.Vector2(0.2, 0.2) },
    uPr0: { value: 0.5 },
    uHi: { value: 1 },
  };
  private t = 0;
  private sacT = 0.6;
  private sac = { x: 0, y: 0 };
  private awayT = 6;
  private awayLeft = 0;
  private away = { x: 0, y: 0 };
  private glanceLeft = 0;
  private glance = { x: 0, y: 0 };
  private pupil = 1;
  private tearS = 0;
  private biasS = { x: 0, y: 0 };
  private v = new THREE.Vector3();
  private qa = new THREE.Quaternion();
  private qb = new THREE.Quaternion();
  private e = new THREE.Euler(0, 0, 0, 'YXZ');
  /** мягкие веки: ось глаза в пространстве века (обновляется в update) */
  readonly lidN = new Map<THREE.Object3D, THREE.Vector3>();
  /** мягкие веки: поворот века в пространство глаза (поле разреза в шейдере) */
  readonly lidR = new Map<THREE.Object3D, THREE.Matrix3>();
  private m4 = new THREE.Matrix4();
  /** мягкие веки: закрытие и сдвиг к камере у кромки глазницы (см. patchLid) */
  readonly lidBand = new Map<THREE.Object3D, THREE.Vector2>();
  private ws = new THREE.Vector3();
  private static AX = new THREE.Vector3(1, 0, 0);
  private static FACE_N = new THREE.Vector3(0, 0.25, 1).normalize();
  private static AZ = new THREE.Vector3(0, 0, 1);

  constructor(private rnd: () => number = Math.random) {}

  /** найти глаза в модели; null — модель без 3D-глаз (старая) */
  static find(root: THREE.Object3D, rnd?: () => number): EyeRig | null {
    const rig = new EyeRig(rnd);
    for (const side of ['L', 'R'] as const) {
      const pivot = root.getObjectByName(`Eye_${side}`);
      const ball = root.getObjectByName(`EyeBall_${side}`);
      const up = root.getObjectByName(`LidUp_${side}`);
      const lo = root.getObjectByName(`LidLo_${side}`);
      if (!pivot || !ball || !up || !lo) return null;
      const ex = pivot.userData as EyeExtras;
      const tear = root.getObjectByName(`Tear_${side}`) ?? null;
      if (tear) tear.visible = false;
      rig.eyes.push({ side, pivot, ball, up, lo, ex: { ...ex, side }, tear, yaw: 0, pitch: 0 });
    }
    const ex = rig.eyes[0].ex;
    rig.uniforms.uIris.value.set(ex.irisUV?.[0] ?? 0.2, ex.irisUV?.[1] ?? 0.2);
    rig.uniforms.uPr0.value = ex.pupil ?? 0.5;
    const done = new Set<THREE.Material>();
    // веки: мех, а не серые «заслонки» (продакт 23.11: плоские серые оболочки с резким светлым краем над глазом);
    // мягкая кромка (подводка и ресницы шейдером) — если сетки век узнаются (softLidGeometry)
    const meshOf = (o: THREE.Object3D) => {
      let r: THREE.Mesh | null = null;
      o.traverse((x) => { if (!r && (x as THREE.Mesh).isMesh) r = x as THREE.Mesh; });
      return r as THREE.Mesh | null;
    };
    const persona = (rig.eyes[0].pivot.userData as { persona?: string }).persona ?? '';
    const tone = LID_TONE[persona] ?? 1;
    // тон века: своей модели (extras.lidTone, Блёстка p4) или по характеру
    const lt = rig.eyes[0].ex.lidTone;
    const lidTone = lt?.length === 4 ? lt : [...(LID_FUR[persona] ?? LID_FUR.kind), 0.9, 1];
    const lids = rig.eyes.map((e) => {
      const lo = meshOf(e.lo), up = meshOf(e.up);
      const nu = lo ? lo.geometry.attributes.position.count / LID_ROWS.length : 0;
      return { lo, up, nu };
    });
    const soft = lids.every((l) => l.lo && l.up && Number.isInteger(l.nu) && l.nu > 2 && l.up.geometry.attributes.position.count >= l.nu * LID_ROWS.length);
    const cuts = new Map<THREE.Object3D, LidCut>();
    if (soft)
      rig.eyes.forEach((e, i) => {
        const l = lids[i];
        // контур — до правки цвета/атрибутов (позиции те же); одна текстура на глаз, поворот — свой у каждого века
        const tex = lidCutTexture(lidCutPolygon(l.up!.geometry, l.lo!.geometry, l.nu));
        for (const lid of [e.up, e.lo]) cuts.set(lid, { tex, rot: { value: new THREE.Matrix3() }, band: { value: new THREE.Vector2() }, tone: new THREE.Vector4(...lidTone) });
        softLidGeometry(l.lo!.geometry, l.nu, 0.35, tone);
        softLidGeometry(l.up!.geometry, l.nu, LID_LASH[persona] ?? 1, tone);
      });
    for (const e of rig.eyes)
      for (const lid of [e.up, e.lo])
        lid.traverse((o) => {
          const mesh = o as THREE.Mesh;
          const m = mesh.material as THREE.MeshStandardMaterial | undefined;
          if (!m?.isMeshStandardMaterial || done.has(m)) return;
          if (soft) {
            // своя копия материала на каждое веко: нормаль «к лицу» (ось глаза) — в пространстве века, оно вращается
            // (закрытое веко не темнеет к кромке, как кожа вокруг)
            const own = m.clone();
            const n = { value: new THREE.Vector3(0, 0.25, 1).normalize() };
            const cut = cuts.get(lid);
            patchLid(own, true, n, cut);
            mesh.material = own;
            done.add(own);
            rig.lidN.set(lid, n.value);
            if (cut) {
              rig.lidR.set(lid, cut.rot.value);
              rig.lidBand.set(lid, cut.band.value);
            }
          } else {
            done.add(m);
            patchLid(m, false);
          }
        });
    for (const e of rig.eyes) {
      e.ball.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (m && !done.has(m)) {
          done.add(m);
          rig.patch(m);
        }
      });
    }
    return rig;
  }

  /** мягкие веки: матрица «вершина века → координаты покоя тела» (тон меха с маской лица), по векам */
  private lidRest: { lid: THREE.Object3D; m0: THREE.Matrix4; u: { value: THREE.Matrix4 } }[] = [];

  /**
   * Тон меха векам (копии материалов мягких век — без патча тона, он был на исходном материале): маска лица по месту
   * века в координатах покоя тела — светлое кольцо вокруг глаза и морда те же, что у кожи рядом (иначе закрытое веко
   * выходило тёмно-голубой «наклейкой»: тон без маски). body — сетка тела (скин с костью Head), patch — FurTone.patch.
   * Без сетки тела или кости — тон без маски. Возвращает true, если веки получили маску.
   */
  toneLids(body: THREE.SkinnedMesh | null, patch: (m: THREE.MeshStandardMaterial, spatial: boolean, rest?: { value: THREE.Matrix4 }) => void): boolean {
    const bones = body?.skeleton?.bones ?? [];
    let masked = true;
    for (const e of this.eyes) {
      // кость, к которой привязан глаз (Head): первый предок из скелета тела
      let o: THREE.Object3D | null = e.pivot.parent, bi = -1;
      while (o && (bi = bones.indexOf(o as THREE.Bone)) < 0) o = o.parent;
      let m0: THREE.Matrix4 | null = null;
      if (body && o && bi >= 0) {
        // EyeS → кость (локальные матрицы, статичны) → мир позы связывания → координаты сетки тела
        const chain = new THREE.Matrix4();
        const eyeS = e.up.parent!;
        for (let x: THREE.Object3D | null = eyeS; x && x !== o; x = x.parent) {
          x.updateMatrix();
          chain.premultiply(x.matrix);
        }
        m0 = body.bindMatrixInverse.clone().multiply(body.skeleton.boneInverses[bi].clone().invert()).multiply(chain);
      } else masked = false;
      for (const lid of [e.up, e.lo])
        lid.traverse((x) => {
          const mesh = x as THREE.Mesh;
          const m = mesh.material as THREE.MeshStandardMaterial | undefined;
          if (!m?.isMeshStandardMaterial || !this.lidN.has(lid)) return;
          if (m0) {
            const u = { value: m0.clone() };
            this.lidRest.push({ lid, m0, u });
            patch(m, true, u);
          } else patch(m, false);
        });
    }
    return masked && this.lidRest.length > 0;
  }

  /** шейдер яблока: зрачок шире/уже, спирали, блики в пространстве камеры */
  private patch(m: THREE.MeshStandardMaterial) {
    const U = this.uniforms;
    m.roughness = 0.12;
    m.metalness = 0;
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      sh.fragmentShader =
        'uniform float uPupil;\nuniform float uSpiral;\nuniform float uTime;\nuniform vec2 uIris;\nuniform float uPr0;\nuniform float uHi;\n' +
        sh.fragmentShader
          .replace(
            '#include <map_fragment>',
            `#ifdef USE_MAP
  vec2 eyD = (vMapUv - 0.5) / uIris;
  float eyR = length(eyD);
  float eyPr = uPr0 * uPupil;
  float eyRR = eyR < eyPr ? eyR * uPr0 / eyPr : (eyR < 1.0 ? uPr0 + (eyR - eyPr) * (1.0 - uPr0) / (1.0 - eyPr) : eyR);
  vec2 eyUv = 0.5 + eyD * (eyR > 1e-5 ? eyRR / eyR : 1.0) * uIris;
  vec4 sampledDiffuseColor = texture2D(map, eyUv);
  diffuseColor *= sampledDiffuseColor;
  if (uSpiral > 0.001) {
    float eyA = atan(eyD.y, eyD.x);
    float sp = sin(eyR * 16.0 + eyA - uTime * 7.0);
    vec3 spc = mix(vec3(0.95), vec3(0.05), smoothstep(-0.3, 0.3, sp));
    diffuseColor.rgb = mix(diffuseColor.rgb, spc, uSpiral * (1.0 - smoothstep(1.0, 1.25, eyR)));
  }
#endif`,
          )
          .replace(
            '#include <emissivemap_fragment>',
            `#include <emissivemap_fragment>
  {
    vec3 eyH1 = normalize(vec3(-0.42, 0.5, 0.76));
    vec3 eyH2 = normalize(vec3(0.32, -0.3, 0.9));
    float eyS1 = smoothstep(0.968, 0.978, dot(normal, eyH1));
    float eyS2 = smoothstep(0.9925, 0.9965, dot(normal, eyH2));
    totalEmissiveRadiance += vec3(1.0) * (eyS1 * 1.2 + eyS2 * 0.9) * uHi * (1.0 - 0.6 * uSpiral);
  }`,
          );
    };
    m.customProgramCacheKey = () => 'cat-eyeball-v1';
    m.needsUpdate = true;
  }

  /** короткий взгляд в сторону точки (доли роста кота на экране: dx > 0 — правее, dy > 0 — ниже) */
  glanceAt(dx: number, dy: number, s = 1.3) {
    this.glance.x = clamp(-dx * 0.9, -0.45, 0.45); // правее на экране = левее для кота (он смотрит на зрителя)
    this.glance.y = clamp(-dy * 0.7, -0.3, 0.3);
    this.glanceLeft = s;
  }

  update(dt: number, i: EyeInput) {
    this.updateEyes(dt, i);
    for (const r of this.lidRest) r.u.value.multiplyMatrices(r.m0, this.m4.makeRotationFromQuaternion(r.lid.quaternion));
  }

  private updateEyes(dt: number, i: EyeInput) {
    this.t += dt;
    const U = this.uniforms;
    U.uTime.value = this.t;
    const spiral = clamp(i.weights.eyes_spiral ?? 0, 0, 1);
    U.uSpiral.value = spiral;
    this.pupil += (clamp(i.pupils, 0.55, 1.5) - this.pupil) * (1 - Math.exp(-dt / 0.12));
    U.uPupil.value = this.pupil;
    const closed = Math.max(i.weights.eyes_laugh ?? 0, Math.min(i.weights.blink_L ?? 0, i.weights.blink_R ?? 0));
    // микросаккады: каждые 0.4–2 с маленький скачок
    if ((this.sacT -= dt) <= 0) {
      this.sacT = 0.4 + this.rnd() * 1.6;
      this.sac.x = (this.rnd() - 0.5) * 0.09;
      this.sac.y = (this.rnd() - 0.5) * 0.06;
    }
    // иногда в покое — взгляд в сторону
    if (this.awayLeft > 0) this.awayLeft -= dt;
    else if (i.idle && (this.awayT -= dt) <= 0) {
      this.awayT = 5 + this.rnd() * 7;
      this.awayLeft = 0.7 + this.rnd() * 1.0;
      this.away.x = (this.rnd() < 0.5 ? -1 : 1) * (0.22 + this.rnd() * 0.18);
      this.away.y = (this.rnd() - 0.6) * 0.18;
    }
    if (this.glanceLeft > 0) this.glanceLeft -= dt;
    const bx = i.bias?.[0] ?? 0, by = i.bias?.[1] ?? 0;
    this.biasS.x += (bx - this.biasS.x) * (1 - Math.exp(-dt / 0.15));
    this.biasS.y += (by - this.biasS.y) * (1 - Math.exp(-dt / 0.15));
    let ox = this.sac.x + this.biasS.x, oy = this.sac.y + this.biasS.y;
    if (this.glanceLeft > 0) {
      ox += this.glance.x;
      oy += this.glance.y;
    } else if (this.awayLeft > 0) {
      ox += this.away.x;
      oy += this.away.y;
    }
    // слёзка: набухает за ~0.4 с, чуть стекает вниз и покачивается
    const tw = clamp(i.weights.tear ?? 0, 0, 1);
    this.tearS += (tw - this.tearS) * (1 - Math.exp(-dt / 0.25));
    for (const e of this.eyes) {
      const ex = e.ex;
      if (e.tear) {
        const k = this.tearS;
        e.tear.visible = k > 0.03;
        if (e.tear.userData.y0 === undefined) e.tear.userData.y0 = e.tear.position.y;
        e.tear.scale.setScalar(Math.max(0.001, k * (1 + 0.04 * Math.sin(this.t * 3))));
        e.tear.position.y = e.tear.userData.y0 - ex.B * 0.12 * k;
      }
      // цель в пространстве глаза → направление в «единичном» пространстве эллипсоида
      let yaw = 0, pitch = 0;
      if (i.target && spiral < 0.5) {
        e.pivot.updateWorldMatrix(true, false);
        const p = e.pivot.worldToLocal(this.v.copy(i.target));
        const x = p.x / ex.A, y = p.y / ex.B, z = Math.max(1e-3, p.z / ex.C);
        yaw = Math.atan2(x, z);
        pitch = Math.atan2(y, Math.hypot(x, z));
      }
      yaw = clamp(yaw + ox, -0.65, 0.65);
      pitch = clamp(pitch + oy, -0.35, 0.75); // сверху (кот на столе) смотрим выше
      if (spiral > 0.5) {
        yaw = 0.06 * Math.sin(this.t * 5 + (e.side === 'L' ? 0 : 2));
        pitch = 0.05 * Math.cos(this.t * 5);
      }
      // скачок глаза быстрый (саккада ~40 мс)
      const k = 1 - Math.exp(-dt / 0.04);
      e.yaw += (yaw - e.yaw) * k;
      e.pitch += (pitch - e.pitch) * k;
      this.e.set(-e.pitch, e.yaw, 0, 'YXZ');
      e.ball.quaternion.setFromEuler(this.e);
      // веки: закрытие + слежение за взглядом по вертикали + наклон
      const lp = lidPose(i.weights, e.side, ex.restUp ?? 0.05);
      const follow = 1 - closed;
      let upA = lp.up * ex.closeUp - e.pitch * (e.pitch > 0 ? 1.0 : 0.55) * follow;
      let loA = lp.lo * ex.closeLo + e.pitch * 0.3 * follow;
      if (lp.arc > 0) {
        // «^»: верхнее веко опускается на 40 %, нижнее поднимается до него — линия смыкания выгнута вверх
        const k = lp.arc * lp.arc * (3 - 2 * lp.arc);
        upA += (0.4 * ex.closeUp - upA) * k;
        loA += (ex.closeUp * 0.6 + ex.closeLo + 0.4 - loA) * k; // с запасом: нижнее веко уходит под верхнее (оно снаружи)
      }
      const sgn = e.side === 'L' ? 1 : -1;
      e.up.quaternion.setFromAxisAngle(EyeRig.AZ, lp.tilt * sgn).multiply(this.qa.setFromAxisAngle(EyeRig.AX, upA));
      e.lo.quaternion.setFromAxisAngle(EyeRig.AZ, lp.tilt * sgn * 0.35).multiply(this.qb.setFromAxisAngle(EyeRig.AX, -loA));
      for (const lid of [e.up, e.lo]) {
        const n = this.lidN.get(lid);
        if (n) n.copy(EyeRig.FACE_N).applyQuaternion(this.qa.copy(lid.quaternion).invert());
        const r = this.lidR.get(lid);
        if (r) r.setFromMatrix4(this.m4.makeRotationFromQuaternion(lid.quaternion));
        const b = this.lidBand.get(lid);
        if (b) {
          // закрытие (0 — покой, 1 — сомкнуто): сдвиг включается, когда веко почти закрыто (сонный/прищур — как было);
          // верхнее — не меньше нижнего: при «^» (смех, подмигивание) нижнее поднимается под верхнее, линия ресниц сверху
          const cu = (upA - (ex.restUp ?? 0.05) * ex.closeUp) / (ex.closeUp * 0.6), cLo = loA / (ex.closeLo * 0.6);
          const c = clamp(lid === e.up ? Math.max(cu, cLo) : cLo, 0, 1);
          e.pivot.getWorldScale(this.ws);
          b.set(smooth01((c - 0.35) / 0.55), LID_PULL * ex.B * this.ws.y * (lid === e.up ? 1 : 0.85));
        }
      }
      if (this.lidBand.size) {
        // закрытый глаз: яблоко чуть меньше (под кожу) — в щели между кромкой глазницы и веком (поле растворения)
        // не мелькают белок и блик
        const c = Math.max(clamp((upA - (ex.restUp ?? 0.05) * ex.closeUp) / (ex.closeUp * (1 - (ex.restUp ?? 0.05))), 0, 1), lp.arc);
        const sh = c * c * (3 - 2 * c);
        e.ball.scale.setScalar(1 - BALL_SHUT * sh * sh);
      }
    }
  }
}
