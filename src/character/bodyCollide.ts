/**
 * Ни рука, ни нога не проходят сквозь тело и одежду: клипы Mixamo / Meshy сделаны под худого человека, а у котов
 * круглый торс, худи, кепка, наушники, шарф, бант, юбка и большая голова с ушами. Каждый кадр после клипа точки рук
 * и голеней выталкиваются из «объёмов» (прокси) тела.
 *
 * Прокси (в системе своей кости, едут вместе с ней), docs/animations/COLLISION.md:
 *  1. <кот>_colliders.json рядом с моделью (v2 — модельщик, v1 — тот же scripts/models/colliders.py) — главнее всего;
 *  2. из меша в позе покоя: вершины, у которых главная кость — таз/спина/шея/голова, дают эллипсоиды торса, шеи и головы;
 *     меши одежды по имени (Cap_*, Headphones_*, Scarf_*, Bow_*, Skirt_*) — свой эллипсоид каждый; бёдра и голени —
 *     капсулы по вершинам ног; уши — капсулы по костям Ear;
 *  3. нет меша одежды — запас по характеру (PERSONA_PAD: кепка, наушники, шарф, бант, юбка) поверх эллипсоидов.
 * Карманы худи — разрешённые зоны: кисть в зоне кармана ложится на поверхность без зазора (у входа в карман), не глубже.
 *
 * Рука у головы проверяется ПО ПОВЕРХНОСТИ (19.11, «руки проникают в наушники»): при загрузке из сетки скина берутся
 * точки поверхности — 16 на кисти, 10 на предплечье, 8 на плече (вершины с наибольшим весом этих костей, равномерно, +
 * мех по нормали); каждый кадр они скинуются на ЦП (только эти точки) и выталкиваются все из прокси головы и одежды на
 * ней (SURF_PROXY). О торс/бёдра рука и ноги обо всё — точками на осях костей, как раньше.
 *
 * Коррекция руки (pushChain): все проникшие пары руки — ограничения по нормали выхода, малые повороты предплечья (без
 * кручения), плеча и кисти — затухающими наименьшими квадратами (плечо «дороже» локтя), шаг с возвратом (сумма квадратов
 * глубин должна уменьшиться), ≤ 25° на кость за шаг, 4 шага за кадр (контакт — 8) + тёплый старт с поправки прошлого
 * кадра. Ноги и модели без точек поверхности: точка внутри прокси → кость поворачивается вокруг сустава на минимальный
 * угол (голень — бедро вокруг тазобедренного).
 * Клипы, где лапа по замыслу касается головы/наушников/ушей (CONTACT_CLIPS: закрыть уши, плакать, почесать, думать,
 * наушники…), — контакт: зазор меньше, ближайшая точка лапы, зависшая над поверхностью ≤ CONTACT_BAND, подтягивается
 * на поверхность (лапа лежит, а не тонет и не висит); вес контакта входит/уходит за 100 мс.
 * Сглаживание во времени: растущая поправка — сразу (проникновения нет ни кадра), но не быстрее MAX_GROW рад/с, уходящая —
 * затухает за ~0,1 с и не быстрее MAX_DECAY рад/с (без «щелчка», когда клип сам вышел из тела).
 * measurePairs() — глубина по парам «часть тела : прокси» (доли роста; рука у головы — по тем же точкам поверхности)
 * для стенда реакций и проверки клипов Meshy. Подробно — docs/animations/COLLISION.md.
 */
import * as THREE from 'three';

export interface Proxy {
  name: string;
  kind: 'ellipsoid' | 'capsule';
  bone: THREE.Object3D;
  /** ellipsoid: центр и полуоси в системе кости */
  center: THREE.Vector3;
  radii: THREE.Vector3;
  /** capsule: концы и радиус в системе кости */
  a: THREE.Vector3;
  b: THREE.Vector3;
  r: number;
  /** меш одежды: прокси работает, пока меш виден (смена характера прячет чужую одежду) */
  mesh?: THREE.Object3D;
  /** запас характера: работает только у него */
  persona?: string;
  /** группы точек, которые этот прокси не проверяет (своя нога своей ноге не мешает) */
  skip?: RegExp;
  src: 'json' | 'mesh' | 'outfit' | 'pad' | 'bones';
  /** кэш кадра (BodyCollider.prepare): обратная матрица кости и её масштаб, ограничивающая сфера (мир) */
  inv?: THREE.Matrix4;
  bs?: number;
  wc?: THREE.Vector3;
  wr?: number;
}
/** карман: точки кисти в этой сфере (система кости) касаются тела без зазора */
export interface Pocket {
  bone: THREE.Object3D;
  center: THREE.Vector3;
  r: number;
  /** кэш кадра: центр и радиус в мире */
  wc?: THREE.Vector3;
  wr?: number;
}

/** формат public/models/v2/<кот>_colliders.json — координаты в пространстве модели (рост 1, поза покоя) */
export interface CollidersJson {
  version?: number;
  volumes?: { name: string; bone: string; type: 'ellipsoid' | 'capsule' | 'hull'; center?: number[]; radii?: number[]; a?: number[]; b?: number[]; r?: number; points?: number[][]; mesh?: string }[];
  pockets?: { bone: string; center: number[]; r: number }[];
}

const GROUPS: Record<string, string[]> = {
  torso: ['Hips', 'Spine', 'Spine1', 'Spine2'],
  neck: ['Neck'],
  head: ['Head'],
};
const REF: Record<string, string> = { torso: 'Spine1', neck: 'Neck', head: 'Head' };
/** меши одежды → прокси (имя, кость-система, перцентиль полуосей) */
const OUTFIT: [RegExp, string, string, number][] = [
  [/^Cap_/i, 'cap', 'Head', 0.95],
  [/^Headphones_/i, 'headphones', 'Neck', 0.95],
  [/^Scarf_/i, 'scarf', 'Neck', 0.92],
  [/^Bow_/i, 'bow', 'Head', 0.95],
  [/^Skirt_/i, 'skirt', 'Hips', 0.9],
];
/**
 * Запас по характеру, если меша одежды нет: эллипсоид-основа × scale, центр сдвинут на shift × полуоси.
 * Кепка — голова выше и шире, наушники и шарф — толще шея, бант — над головой, юбка — таз шире внизу.
 */
export const PERSONA_PAD: Record<string, { name: string; base: 'head' | 'neck' | 'torso'; scale: [number, number, number]; shift?: [number, number, number] }[]> = {
  hooligan: [
    { name: 'cap', base: 'head', scale: [1.12, 1.18, 1.12], shift: [0, 0.15, 0] },
    { name: 'headphones', base: 'neck', scale: [1.45, 1.1, 1.45] },
  ],
  kind: [{ name: 'scarf', base: 'neck', scale: [1.5, 1.15, 1.5] }],
  glitter: [
    { name: 'bow', base: 'head', scale: [0.6, 0.45, 0.6], shift: [0, 0.95, 0] },
    { name: 'skirt', base: 'torso', scale: [1.25, 0.6, 1.25], shift: [0, -0.7, 0] },
  ],
};

const strip = (n: string) => n.replace(/^mixamorig:?/, '');
/** точка, по которой меряется и выталкивается тело */
interface Pt {
  group: string;
  p: THREE.Vector3;
  /** кость, которую поворачиваем, и её сустав */
  bone: THREE.Object3D;
  joint: THREE.Vector3;
  hand: boolean;
  /** нога: «своя сторона» (мир) — для проверки о другую ногу */
  side?: THREE.Vector3;
  /** запасной сустав (кисть: плечо вокруг плечевого), если поворота предплечья не хватило */
  alt?: { bone: THREE.Object3D; joint: THREE.Vector3 };
  /** у этой стороны есть точки поверхности: о прокси головы (SURF_PROXY) проверяют они, а не точка на оси */
  surf?: boolean;
}

/**
 * точка поверхности кисти/предплечья: вершина сетки (+ мех по нормали) в системе каждой своей кости (u = boneInverse ·
 * bindMatrix · v) с весами скина — мир = Σ w·(кость.matrixWorld · u) (скин на ЦП только этих точек)
 */
export interface SurfSample {
  group: string;
  side: 'Left' | 'Right';
  bones: THREE.Object3D[];
  u: THREE.Vector3[];
  w: number[];
  /** меш (detached-привязка: мир = matrixWorld · bindMatrixInverse · Σ…) */
  mesh: THREE.SkinnedMesh;
  p: THREE.Vector3;
  hand: boolean;
  /** плечо (до локтя): его двигает только поворот плеча */
  upper: boolean;
  /** прокси, в которых точка сидит уже в позе покоя (соседние части тела, рукав у капюшона) — не проверяются */
  skip: Set<Proxy>;
}

const tv = new THREE.Vector3();
const tv2 = new THREE.Vector3();
const tv3 = new THREE.Vector3();
const tq = new THREE.Quaternion();
const LEG = /Shin|Knee/;
/** предел поправки на кость, рад: клип совсем мимо тела — пусть лучше заденет, чем вывернет руку */
const MAX_CORR = 2.0;
/** точек поверхности: кисть (с пальцами), предплечье, плечо (от плеча до локтя) */
export const SURF_N = { hand: 16, fore: 10, upper: 8 };
/** толщина меха на кисти/рукаве (доли роста): у моделей v1/v2 _FURLEN на кисти 0, пряди — до ~2 мм модели */
const SURF_FUR = 0.002;
/** зазор точек поверхности до прокси (доли роста): обычно / в клипе-контакте (лапа лежит на поверхности) */
export const SURF_MARGIN = 0.004;
export const CONTACT_MARGIN = 0.0015;
/** контакт: ближайшая точка лапы, зависшая над поверхностью не дальше этого (доли роста), подтягивается на неё */
export const CONTACT_BAND = 0.03;
/** скорость поправки, рад/с: растущая (проникновение убирается сразу, но без телепорта) / уходящая */
const MAX_GROW = 10;
const MAX_DECAY = 5;
/** точки снаружи ближе этого (доли роста) тоже дают строки в шаге коррекции: шаг не вталкивает их в соседний прокси */
const NEAR = 0.012;
/**
 * шагов коррекции точек поверхности на руку за кадр (dt > 0; проверка клипа dt = 0 — до 24): обычно / в клипе-контакте
 * (лапы у головы весь клип — там и нужнее); остальное доберёт следующий кадр (тёплый старт)
 */
const SURF_STEPS = 4;
const SURF_STEPS_CONTACT = 8;
/** «цена» поворота плеча против локтя в шаге коррекции точек поверхности (плечо — когда локтя мало) */
const ARM_COST = 30;
/**
 * «цена» наклона кисти в запястье: по прогонам стенда наклон кисти давал «щелчки» кисти (17 рад/с) и застревания лапы
 * в наушниках v1 (поза «наушники»: 99 % кадров > 1 мм против 1 % без него) — запястье почти не трогаем
 */
const HAND_COST = 1e6;
/** вход/выход веса исключения лапы из коррекции, с */
const EXEMPT_FADE = 0.18;
/** разворот локтя исключённой лапы: шаг поиска, рад; предел, рад; скорость, рад/с */
const SWIVEL_STEP = 0.18;
const SWIVEL_MAX = 1.4;
const SWIVEL_RATE = 5.4;
/** вход/выход веса контакта, с */
const CONTACT_FADE = 0.1;
/** клипы, где лапы по замыслу лежат на голове, ушах, наушниках, щеке (контакт вместо проникновения) */
export const CONTACT_CLIPS = /cover_ears|^cry|_cry|scratch(?!_glass)|think|headphones|poke_(head|cheek)|facepalm/;
/** прокси головы и одежды на ней — их кисть и предплечье проверяют точками поверхности (торс, бёдра, юбку — по осям) */
const SURF_PROXY = /^(head|neck|ear_|cap|headphones|hood|scarf|bow)/;
/** прокси-кольца вокруг шеи (дуга наушников, шарф; чашки — нет): выход только наружу (BodyCollider.ringSide) */
const RING = /^(headphones_band|scarf_\d)/;
/** кольцо: ширина перехода «ближний выход → наружу» по косинусу угла к центру кольца (от −0,2 до −0,7) */
const RING_MIN = 0.5;
/** прокси, о которые лапа в клипе-контакте «ложится» */
const CONTACT_PROXY = /^(head|ear_|cap|headphones|hood|bow)/;
const angOf = (q: THREE.Quaternion) => 2 * Math.acos(Math.min(1, Math.abs(q.w)));

const sLp = new THREE.Vector3();
const sAb = new THREE.Vector3();
const sC = new THREE.Vector3();
const sDir = new THREE.Vector3();
const sSl = new THREE.Vector3();
const sSl2 = new THREE.Vector3();
const sAx = new THREE.Vector3();
const sInv = new THREE.Matrix4();
const sJ = new THREE.Vector3();
const sD = new THREE.Vector3();
const sO = new THREE.Vector3();
const sP = new THREE.Vector3();
const sW = new THREE.Vector3();
const sE1 = new THREE.Vector3();
const sE2 = new THREE.Vector3();
const sAx2 = new THREE.Vector3();
const sC2 = new THREE.Vector3();
const sC3 = new THREE.Vector3();
const sS = new THREE.Vector3();
const sWa = new THREE.Vector3();
const sAxR = new THREE.Vector3();
/** неизвестных в шаге коррекции руки: предплечье 2 (без кручения), плечо 3, кисть 3 */
const NU = 8;
const sM: number[] = new Array(NU * NU).fill(0);
const sVv: number[] = new Array(NU).fill(0);
const sX: number[] = new Array(NU).fill(0);
const sWh = new THREE.Vector3();
const sSide = new THREE.Vector3();
const sSc = new THREE.Vector3();
const sNa = new THREE.Vector3();
const sNh = new THREE.Vector3();
const sQid = new THREE.Quaternion();
const sHw = new THREE.Vector3();

/** M·x = v (N×N, Гаусс с выбором ведущего; M и v портятся) */
function solveN(M: number[], v: number[], N: number): number[] | null {
  for (let c = 0; c < N; c++) {
    let piv = c;
    for (let r = c + 1; r < N; r++) if (Math.abs(M[r * N + c]) > Math.abs(M[piv * N + c])) piv = r;
    if (Math.abs(M[piv * N + c]) < 1e-30) return null;
    if (piv !== c) {
      for (let k = 0; k < N; k++) [M[c * N + k], M[piv * N + k]] = [M[piv * N + k], M[c * N + k]];
      [v[c], v[piv]] = [v[piv], v[c]];
    }
    for (let r = c + 1; r < N; r++) {
      const f = M[r * N + c] / M[c * N + c];
      if (!f) continue;
      for (let k = c; k < N; k++) M[r * N + k] -= f * M[c * N + k];
      v[r] -= f * v[c];
    }
  }
  for (let r = N - 1; r >= 0; r--) {
    let acc = v[r];
    for (let k = r + 1; k < N; k++) acc -= M[r * N + k] * sX[k];
    sX[r] = acc / M[r * N + r];
  }
  return sX;
}
const sQ = new THREE.Quaternion();
const sQ2 = new THREE.Quaternion();



/** обратная матрица кости прокси и её масштаб: кэш на кадр (prepare), иначе — заново (без выделения памяти) */
let fBs = 1;
function frameOf(px: Proxy, cached: boolean): THREE.Matrix4 {
  if (cached && px.inv) {
    fBs = px.bs ?? 1;
    return px.inv;
  }
  fBs = tv.setFromMatrixScale(px.bone.matrixWorld).x || 1;
  return sInv.copy(px.bone.matrixWorld).invert();
}

/**
 * Глубина точки p (мир) в прокси (мировые единицы) и ближайшая точка поверхности с запасом mgW (мир); cached — матрицы
 * костей прокси уже посчитаны на этот кадр (BodyCollider.prepare).
 */
export function proxyDepth(px: Proxy, p: THREE.Vector3, mgW: number, out?: THREE.Vector3, side?: THREE.Vector3, cached = false, sideMin = 0): number {
  const mw = px.bone.matrixWorld;
  const inv = frameOf(px, cached);
  const bs = fBs;
  const mg = mgW / bs;
  const lp = sLp.copy(p).applyMatrix4(inv);
  if (px.kind === 'ellipsoid') {
    lp.sub(px.center);
    const rx = px.radii.x + mg, ry = px.radii.y + mg, rz = px.radii.z + mg;
    const d = Math.sqrt((lp.x / rx) ** 2 + (lp.y / ry) ** 2 + (lp.z / rz) ** 2);
    if (d >= 1) return 0;
    if (d < 1e-4) {
      const m = Math.min(rx, ry, rz);
      if (out) out.set(m === rx ? rx : 0, m === ry ? ry : 0, m === rz ? rz : 0).add(px.center).applyMatrix4(mw);
      return m * bs;
    }
    const surf = lp.multiplyScalar(1 / d);
    const len = surf.length();
    if (out) out.copy(surf).add(px.center).applyMatrix4(mw);
    return len * (1 - d) * bs;
  }
  const ab = sAb.copy(px.b).sub(px.a);
  const k = Math.min(1, Math.max(0, sDir.copy(lp).sub(px.a).dot(ab) / Math.max(1e-12, ab.lengthSq())));
  const c = sC.copy(px.a).addScaledVector(ab, k);
  const dir = sDir.copy(lp).sub(c);
  let dist = dir.length();
  const R = px.r + mg;
  // нога о ногу: точка должна быть со своей стороны оси чужой ноги (side — «своя сторона», мир); скрестил — значит
  // проник насквозь: глубина до своей стороны, а не до ближайшей (иначе ногу дотолкнули бы дальше через другую)
  // ноги — в полосе 2,5 R (скрещённая нога глубоко за осью); кольца (sideMin > 0) — только внутри трубки
  if (side && k > 0 && k < 1 && dist < R * (sideMin > 0 ? 1 : 2.5)) {
    const sl = sSl.copy(side).transformDirection(inv);
    const axisN = ab.lengthSq() > 1e-12 ? sAx.copy(ab).normalize() : sAx.set(0, 1, 0);
    sl.addScaledVector(axisN, -sl.dot(axisN));
    if (sl.lengthSq() > 1e-10) {
      sl.normalize();
      const s = dir.dot(sl);
      if (sideMin > 0) {
        // кольца: изнутри (к центру кольца) — выход наружу через ось, плавно по углу (cos от −0,2 до −0,2 − sideMin:
        // ближний выход → наружный), чтобы глубина не прыгала — иначе шаг коррекции застревал бы на скачке
        const cs = dist > 1e-9 ? s / dist : 0;
        let w = Math.min(1, Math.max(0, (-cs - 0.2) / sideMin));
        w = w * w * (3 - 2 * w);
        if (w > 0) {
          if (dist >= R && w < 1e-6) return 0;
          const dn = Math.max(0, R - dist), dout = R - s;
          if (out) {
            const nd = dist > 1e-9 ? sSl2.copy(dir).multiplyScalar(1 / dist) : sSl2.copy(sl);
            out.copy(c).addScaledVector(nd.lerp(sl, w).normalize(), R).applyMatrix4(mw);
          }
          return ((1 - w) * dn + w * dout) * bs;
        }
      } else if (s < 0) {
        // насквозь: на свою сторону — через ось
        if (out) out.copy(c).addScaledVector(sl, R).applyMatrix4(mw);
        return (R - s) * bs;
      }
    }
  }
  if (dist >= R) return 0;
  if (out) {
    if (dist < 1e-6) {
      dir.set(0, 0, 1);
      dist = 1;
    }
    out.copy(c).addScaledVector(dir.normalize(), R).applyMatrix4(mw);
  }
  return (R - dist) * bs;
}

/**
 * Знаковое расстояние от точки p (мир) до поверхности прокси (мир; < 0 — внутри) и точка поверхности (out). Для
 * эллипсоида — по лучу из центра (непрерывно, без нормировки на кривизну) — для подтягивания лапы в клипе-контакте.
 */
export function proxyGap(px: Proxy, p: THREE.Vector3, out: THREE.Vector3, cached = false): number {
  const mw = px.bone.matrixWorld;
  const inv = frameOf(px, cached);
  const bs = fBs;
  const lp = sLp.copy(p).applyMatrix4(inv);
  if (px.kind === 'ellipsoid') {
    lp.sub(px.center);
    const d = Math.sqrt((lp.x / px.radii.x) ** 2 + (lp.y / px.radii.y) ** 2 + (lp.z / px.radii.z) ** 2);
    if (d < 1e-6) return -Math.min(px.radii.x, px.radii.y, px.radii.z) * bs;
    const surf = lp.multiplyScalar(1 / d);
    const len = surf.length();
    out.copy(surf).add(px.center).applyMatrix4(mw);
    return len * (d - 1) * bs;
  }
  const ab = sAb.copy(px.b).sub(px.a);
  const k = Math.min(1, Math.max(0, sDir.copy(lp).sub(px.a).dot(ab) / Math.max(1e-12, ab.lengthSq())));
  const c = sC.copy(px.a).addScaledVector(ab, k);
  const dir = sDir.copy(lp).sub(c);
  const dist = dir.length();
  if (dist < 1e-6) return -px.r * bs;
  out.copy(c).addScaledVector(dir.multiplyScalar(1 / dist), px.r).applyMatrix4(mw);
  return (dist - px.r) * bs;
}

export class BodyCollider {
  proxies: Proxy[] = [];
  pockets: Pocket[] = [];
  private m = new THREE.Matrix4();
  enabled = true;
  /**
   * Коррекция как до 18.11 (только руки, только эллипсоиды торса/шеи/головы, без сглаживания): ?collide=legacy — для
   * сравнения на стенде реакций (замер — всегда по всем прокси).
   */
  legacy = false;
  /**
   * Коррекция как 18.11–19.11 (кисть и предплечье — точки на осях костей, без контакта), замер — по точкам поверхности:
   * ?collide=axis — «до» для стенда реакций и листов docs/qa/hands.
   */
  axis = false;
  /** сколько раз за последний кадр пришлось выталкивать и сколько итераций (для debug и стенда) */
  hits = 0;
  iters = 0;
  /** отладка (tools/hands-probe.html): шаги коррекции точек поверхности за кадр */
  trace: string[] | null = null;
  /** характер: какие запасы PERSONA_PAD действуют */
  persona = 'hooligan';
  /** откуда прокси: json (экспорт модельщика) / mesh (меш + запасы) */
  source: 'json' | 'mesh' = 'mesh';
  /** поправка прошлого кадра по кости (локальная, поверх клипа) — уходящая гаснет плавно */
  private held = new Map<THREE.Object3D, THREE.Quaternion>();
  /** точки поверхности кисти и предплечья (buildSamples); нет — кисть по точкам на осях, как раньше */
  samples: SurfSample[] = [];
  /** клип-контакт (CONTACT_CLIPS) и его вес (вход/выход за CONTACT_FADE) */
  private contactOn = false;
  /** центры колец (дуга наушников, шарф) в мире — кэш кадра */
  private ringC = new Map<string, THREE.Vector3>();
  /** прокси головы рядом со стороной (отсев по сферам) — на шаг коррекции */
  private cand: Proxy[] = [];
  contactW = 0;
  /**
   * лапы без коррекции на этот кадр ('Left' | 'Right'): предмет в лапе (holdAction) ведёт IK сам — цели подобраны
   * вне тела, а выталкивание уводило кружку от рта на 0,2 роста (стенд 20.11); замер (measurePairs) — как обычно
   */
  exempt = new Set<'Left' | 'Right'>();
  /**
   * вес исключения стороны 0..1 (цель — exempt или exemptTo; входит и уходит за EXEMPT_FADE): поправка лапы — с весом
   * (1 − w), без прыжка, когда исключение снимается (зеркальце, бант, конец действия с предметом)
   */
  readonly exemptW = { Left: 0, Right: 0 };
  /** цель веса исключения на этот кадр (applyHold: по весу позы предмета); exempt.has — то же, что 1 */
  readonly exemptTo = { Left: 0, Right: 0 };
  /**
   * разворот локтя исключённой лапы вокруг оси «плечо — запястье» (рад): кисть с предметом на месте, плечо и
   * предплечье — из дуги наушников, шарфа, шеи (точка стороны с наименьшей суммой квадратов глубин, ≤ SWIVEL_RATE)
   */
  readonly swivelA = { Left: 0, Right: 0 };

  constructor(
    private root: THREE.Object3D,
    private bone: (n: string) => THREE.Object3D | undefined,
    /** толщина руки + зазор, в долях роста */
    private margin = 0.028,
    /** толщина голени + зазор, в долях роста */
    private legMargin = 0.03,
  ) {}

  /** вызвать один раз после загрузки, модель в позе покоя; json — public/models/v2/<кот>_colliders.json, если есть */
  build(model: THREE.Object3D, json?: CollidersJson | null): string[] {
    model.updateMatrixWorld(true);
    this.proxies = [];
    this.pockets = [];
    this.held.clear();
    this.buildSamples(model);
    if (json?.volumes?.length) {
      this.fromJson(model, json);
      if (this.proxies.length) {
        this.source = 'json';
        this.restSkip();
        return this.proxies.map((v) => v.name);
      }
    }
    this.source = 'mesh';
    const rs = this.root.getWorldScale(new THREE.Vector3()).x || 1;
    const pts: Record<string, THREE.Vector3[]> = { torso: [], neck: [], head: [] };
    const legPts: Record<string, THREE.Vector3[]> = {};
    const outfit = new Map<string, { pts: THREE.Vector3[]; mesh: THREE.Object3D; bone: string; q: number }>();
    const owner: Record<string, string> = {};
    for (const [g, list] of Object.entries(GROUPS)) for (const b of list) owner[b] = g;
    model.traverse((o) => {
      const sm = o as THREE.SkinnedMesh;
      // накладки и оболочки меха стадии body_detail (BD_*) объём тела не меняют — их не считаем
      if (!sm.isSkinnedMesh || /^BD_/.test(sm.name)) return;
      const pos = sm.geometry.attributes.position;
      const si = sm.geometry.attributes.skinIndex;
      const sw = sm.geometry.attributes.skinWeight;
      if (!pos || !si || !sw) return;
      const of = OUTFIT.find(([re]) => re.test(sm.name) || re.test(sm.parent?.name ?? ''));
      const step = Math.max(1, Math.floor(pos.count / 6000));
      for (let i = 0; i < pos.count; i += step) {
        let best = 0;
        let bw = -1;
        for (let k = 0; k < 4; k++) {
          const wk = sw.getComponent(i, k);
          if (wk > bw) {
            bw = wk;
            best = si.getComponent(i, k);
          }
        }
        const bn = strip(sm.skeleton.bones[best]?.name ?? '');
        const p = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(sm.matrixWorld);
        if (of) {
          if (!outfit.has(of[1])) outfit.set(of[1], { pts: [], mesh: sm, bone: of[2], q: of[3] });
          outfit.get(of[1])!.pts.push(p);
          continue;
        }
        const g = owner[bn];
        if (g) pts[g].push(p);
        else if (/^(Left|Right)(UpLeg|Leg)$/.test(bn)) (legPts[bn] ??= []).push(p);
      }
    });
    const ell = (name: string, boneName: string, P: THREE.Vector3[], q: number, src: Proxy['src'], mesh?: THREE.Object3D) => {
      const b = this.bone(boneName);
      if (!b || P.length < 30) return;
      const inv = this.m.copy(b.matrixWorld).invert();
      const L = P.map((p) => p.clone().applyMatrix4(inv));
      const c = L.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / L.length);
      // полуоси — перцентиль отклонения по осям (тело — 85-й: без торчащих деталей вроде капюшона)
      const pc = (arr: number[]) => arr.sort((x, y) => x - y)[Math.floor(arr.length * q)];
      const r = new THREE.Vector3(pc(L.map((p) => Math.abs(p.x - c.x))), pc(L.map((p) => Math.abs(p.y - c.y))), pc(L.map((p) => Math.abs(p.z - c.z))));
      const px = this.mkEll(name, b, c, r, src);
      px.mesh = mesh;
      this.proxies.push(px);
    };
    for (const g of Object.keys(GROUPS)) ell(g, REF[g], pts[g], 0.85, 'mesh');
    // шея без своих вершин (у Tripo шея — часть головы/худи): эллипсоид от Neck до середины пути к голове
    const nb = this.bone('Neck'), hb = this.bone('Head');
    if (!this.proxies.some((v) => v.name === 'neck') && nb && hb) {
      const ns = nb.getWorldScale(new THREE.Vector3()).x || 1;
      const c = hb.getWorldPosition(new THREE.Vector3()).applyMatrix4(this.m.copy(nb.matrixWorld).invert()).multiplyScalar(0.4);
      this.proxies.push(this.mkEll('neck', nb, c, new THREE.Vector3(0.06, 0.05, 0.06).multiplyScalar(rs / ns), 'bones'));
    }
    for (const [name, o] of outfit) ell(name, o.bone, o.pts, o.q, 'outfit', o.mesh);
    // запасы по характеру — только то, чего нет среди мешей одежды
    for (const [persona, pads] of Object.entries(PERSONA_PAD))
      for (const pad of pads) {
        if (outfit.has(pad.name)) continue;
        const base = this.proxies.find((v) => v.name === pad.base && v.kind === 'ellipsoid');
        if (!base) continue;
        const r = base.radii.clone().multiply(new THREE.Vector3(...pad.scale));
        const c = base.center.clone().add(new THREE.Vector3(...(pad.shift ?? [0, 0, 0])).multiply(base.radii));
        const px = this.mkEll(pad.name, base.bone, c, r, 'pad');
        px.persona = persona;
        this.proxies.push(px);
      }
    for (const side of ['Left', 'Right']) {
      const S = side[0];
      // ноги: капсулы бедра и голени по вершинам (70-й перцентиль расстояния до оси)
      for (const [seg, child] of [['UpLeg', 'Leg'], ['Leg', 'Foot']] as const) {
        const b = this.bone(side + seg), c = this.bone(side + child);
        if (!b || !c) continue;
        const bs = b.getWorldScale(new THREE.Vector3()).x || 1;
        const inv = this.m.copy(b.matrixWorld).invert();
        const a = new THREE.Vector3();
        const e = c.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
        const P = (legPts[side + seg] ?? []).map((p) => p.clone().applyMatrix4(inv));
        let r = (0.05 * rs) / bs;
        if (P.length >= 20 && e.lengthSq() > 1e-12) {
          const ds = P.map((p) => {
            const k = Math.min(1, Math.max(0, p.dot(e) / e.lengthSq()));
            return p.distanceTo(e.clone().multiplyScalar(k));
          }).sort((x, y) => x - y);
          r = ds[Math.floor(ds.length * 0.7)];
        }
        // бедро для рук — «сердцевина» (0,8): кисть, опущенная вдоль бедра, его не толкает
        const px = this.mkCap(`${seg === 'UpLeg' ? 'thigh' : 'shin'}_${S}`, b, a, e, seg === 'UpLeg' ? r * 0.8 : r, 'bones');
        px.skip = new RegExp(`^${S}(Shin|Knee)$`);
        this.proxies.push(px);
      }
      // ухо: капсула от основания до кончика в системе головы (уши ведёт TailRig уже после коррекции)
      const head = this.bone('Head'), e1 = this.bone(side + 'Ear1');
      if (head && e1) {
        const hs = head.getWorldScale(new THREE.Vector3()).x || 1;
        const base = e1.getWorldPosition(new THREE.Vector3());
        const last = this.lastChild(e1);
        const tip = last !== e1 ? last.getWorldPosition(new THREE.Vector3()) : base.clone().add(base.clone().sub(head.getWorldPosition(new THREE.Vector3())).multiplyScalar(0.6));
        const inv = this.m.copy(head.matrixWorld).invert();
        this.proxies.push(this.mkCap(`ear_${S}`, head, base.applyMatrix4(inv), tip.applyMatrix4(inv), (0.03 * rs) / hs, 'bones'));
      }
    }
    this.addPockets();
    this.restSkip();
    return this.proxies.map((v) => v.name);
  }

  /**
   * Точки поверхности кисти и предплечья (SURF_N): вершины сеток скина (кроме накладок BD_*) с весом кости кисти (вместе с
   * пальцами) / предплечья ≥ 0,6, равномерно по поверхности (самые далёкие друг от друга), + мех по нормали.
   */
  private buildSamples(model: THREE.Object3D) {
    this.samples = [];
    const groups: { side: 'Left' | 'Right'; hand: boolean; upper: boolean; n: number; want: (b: string) => boolean }[] = [];
    for (const side of ['Left', 'Right'] as const) {
      groups.push({ side, hand: true, upper: false, n: SURF_N.hand, want: (b) => b.startsWith(side + 'Hand') });
      groups.push({ side, hand: false, upper: false, n: SURF_N.fore, want: (b) => b === side + 'ForeArm' });
      groups.push({ side, hand: false, upper: true, n: SURF_N.upper, want: (b) => b === side + 'Arm' });
    }
    const cand = groups.map(() => [] as { sm: THREE.SkinnedMesh; i: number; p: THREE.Vector3 }[]);
    model.traverse((o) => {
      const sm = o as THREE.SkinnedMesh;
      if (!sm.isSkinnedMesh || /^BD_/.test(sm.name) || !sm.skeleton) return;
      const g = sm.geometry;
      const pos = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
      if (!pos || !si || !sw) return;
      const names = sm.skeleton.bones.map((b) => strip(b?.name ?? ''));
      const masks = groups.map((gr) => names.map((n) => gr.want(n)));
      if (!masks.some((m) => m.some(Boolean))) return;
      for (let i = 0; i < pos.count; i++)
        for (let gi = 0; gi < groups.length; gi++) {
          let w = 0;
          for (let k = 0; k < 4; k++) if (masks[gi][si.getComponent(i, k)]) w += sw.getComponent(i, k);
          if (w >= 0.6) cand[gi].push({ sm, i, p: new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(sm.matrixWorld) });
        }
    });
    groups.forEach((gr, gi) => {
      let C = cand[gi];
      // плечо — только дальняя от плечевого сустава половина (у сустава кожа мнётся скином, рядом капюшон и шея)
      if (gr.upper) {
        const a = this.bone(gr.side + 'Arm'), f = this.bone(gr.side + 'ForeArm');
        if (!a || !f) return;
        const A = new THREE.Vector3().setFromMatrixPosition(a.matrixWorld), F = new THREE.Vector3().setFromMatrixPosition(f.matrixWorld);
        const ax = F.clone().sub(A);
        const L2 = Math.max(ax.lengthSq(), 1e-12);
        C = C.filter((x) => x.p.clone().sub(A).dot(ax) / L2 > 0.45);
      }
      if (C.length < gr.n) return;
      // самые далёкие друг от друга (farthest point sampling): от самой далёкой от центра
      const c = C.reduce((a, x) => a.add(x.p), new THREE.Vector3()).multiplyScalar(1 / C.length);
      const d2 = C.map((x) => x.p.distanceToSquared(c));
      const pick: number[] = [];
      let k = d2.indexOf(Math.max(...d2));
      d2.fill(Infinity);
      for (let n = 0; n < gr.n; n++) {
        pick.push(k);
        let best = -1;
        for (let i = 0; i < C.length; i++) {
          d2[i] = Math.min(d2[i], C[i].p.distanceToSquared(C[k].p));
          if (best < 0 || d2[i] > d2[best]) best = i;
        }
        k = best;
      }
      for (const idx of pick) this.samples.push(this.mkSample(C[idx].sm, C[idx].i, gr.side, gr.hand, gr.upper));
    });
  }

  private mkSample(sm: THREE.SkinnedMesh, i: number, side: 'Left' | 'Right', hand: boolean, upper = false): SurfSample {
    const g = sm.geometry;
    const v = new THREE.Vector3().fromBufferAttribute(g.attributes.position, i);
    if (g.attributes.normal) v.addScaledVector(new THREE.Vector3().fromBufferAttribute(g.attributes.normal, i).normalize(), SURF_FUR / (sm.getWorldScale(tv).x / (this.root.getWorldScale(tv2).x || 1) || 1));
    v.applyMatrix4(sm.bindMatrix);
    const si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    const s: SurfSample = { group: `${side[0]}${hand ? 'Hand' : upper ? 'UpperArm' : 'ForeArm'}`, side, bones: [], u: [], w: [], mesh: sm, p: new THREE.Vector3(), hand, upper, skip: new Set() };
    let tot = 0;
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      const bi = si.getComponent(i, k);
      const b = sm.skeleton.bones[bi];
      if (w < 1e-4 || !b) continue;
      s.bones.push(b);
      s.u.push(v.clone().applyMatrix4(sm.skeleton.boneInverses[bi]));
      s.w.push(w);
      tot += w;
    }
    for (let k = 0; k < s.w.length; k++) s.w[k] /= tot || 1;
    return s;
  }

  /** скин точки поверхности в текущей позе (мир) */
  private skin(s: SurfSample): THREE.Vector3 {
    const p = s.p.set(0, 0, 0);
    for (let k = 0; k < s.bones.length; k++) p.addScaledVector(tv3.copy(s.u[k]).applyMatrix4(s.bones[k].matrixWorld), s.w[k]);
    if (s.mesh.bindMode === 'detached') p.applyMatrix4(s.mesh.bindMatrixInverse).applyMatrix4(s.mesh.matrixWorld);
    return p;
  }

  /** пары «точка поверхности : прокси», где точка внутри уже в позе покоя (с зазором) — соседние части, не проверяются */
  private restSkip() {
    if (!this.samples.length) return;
    this.root.updateMatrixWorld(true);
    const rs = this.root.getWorldScale(tv).x || 1;
    for (const s of this.samples) {
      s.skip.clear();
      this.skin(s);
      for (const px of this.proxies) if (proxyDepth(px, s.p, SURF_MARGIN * rs) > 0) s.skip.add(px);
    }
  }

  /** карманы худи: у переднего нижнего края торса, слева и справа (система кости торса) */
  private addPockets() {
    const torso = this.proxies.find((v) => v.name === 'torso' && v.kind === 'ellipsoid');
    if (!torso || this.pockets.length) return;
    // «вперёд» и «вниз» торса в системе кости: оси модели (+Z, −Y) через поворот кости
    const qi = torso.bone.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(this.root.getWorldQuaternion(new THREE.Quaternion()));
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(qi);
    const down = new THREE.Vector3(0, -1, 0).applyQuaternion(qi);
    const side = new THREE.Vector3(1, 0, 0).applyQuaternion(qi);
    const R = torso.radii;
    const ext = (v: THREE.Vector3) => Math.abs(v.x) * R.x + Math.abs(v.y) * R.y + Math.abs(v.z) * R.z;
    for (const sx of [-1, 1]) {
      const c = torso.center.clone().addScaledVector(side, 0.5 * sx * ext(side)).addScaledVector(down, 0.55 * ext(down)).addScaledVector(fwd, 0.8 * ext(fwd));
      this.pockets.push({ bone: torso.bone, center: c, r: 0.3 * Math.min(R.x, R.y, R.z) });
    }
  }

  private lastChild(o: THREE.Object3D): THREE.Object3D {
    let cur = o;
    for (let i = 0; i < 6; i++) {
      const next = cur.children.find((c) => (c as THREE.Bone).isBone || /Ear/.test(c.name));
      if (!next) break;
      cur = next;
    }
    return cur;
  }

  private mkEll(name: string, bone: THREE.Object3D, center: THREE.Vector3, radii: THREE.Vector3, src: Proxy['src']): Proxy {
    return { name, kind: 'ellipsoid', bone, center, radii, a: new THREE.Vector3(), b: new THREE.Vector3(), r: 0, src };
  }
  private mkCap(name: string, bone: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, r: number, src: Proxy['src']): Proxy {
    return { name, kind: 'capsule', bone, center: new THREE.Vector3(), radii: new THREE.Vector3(), a, b, r, src };
  }

  /** прокси из экспорта модельщика: координаты пространства модели (поза покоя) → система кости */
  private fromJson(model: THREE.Object3D, j: CollidersJson) {
    const toBone = (b: THREE.Object3D, v: number[]) => new THREE.Vector3(v[0], v[1], v[2]).applyMatrix4(model.matrixWorld).applyMatrix4(this.m.copy(b.matrixWorld).invert());
    const unit = (b: THREE.Object3D) => (model.getWorldScale(new THREE.Vector3()).x || 1) / (b.getWorldScale(new THREE.Vector3()).x || 1);
    for (const v of j.volumes ?? []) {
      const b = this.bone(v.bone);
      if (!b) continue;
      let px: Proxy | null = null;
      if (v.type === 'capsule' && v.a && v.b && typeof v.r === 'number') px = this.mkCap(v.name, b, toBone(b, v.a), toBone(b, v.b), v.r * unit(b), 'json');
      else if (v.type === 'ellipsoid' && v.center && v.radii) {
        const r = new THREE.Vector3(v.radii[0], v.radii[1], v.radii[2]).multiplyScalar(unit(b));
        px = this.mkEll(v.name, b, toBone(b, v.center), this.rotRadii(b, model, r), 'json');
      } else if (v.type === 'hull' && v.points?.length) {
        // выпуклая оболочка → описанный эллипсоид по точкам (в системе кости), +5 %
        const L = v.points.map((p) => toBone(b, p));
        const c = L.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / L.length);
        const r = new THREE.Vector3();
        for (const p of L) r.max(new THREE.Vector3(Math.abs(p.x - c.x), Math.abs(p.y - c.y), Math.abs(p.z - c.z)));
        px = this.mkEll(v.name, b, c, r.multiplyScalar(1.05), 'json');
      }
      if (!px) continue;
      if (v.mesh) px.mesh = model.getObjectByName(v.mesh) ?? undefined;
      if (/^(thigh|shin)_([LR])$/.test(v.name)) px.skip = new RegExp(`^${v.name.slice(-1)}(Shin|Knee)$`);
      this.proxies.push(px);
    }
    for (const p of j.pockets ?? []) {
      const b = this.bone(p.bone);
      if (b) this.pockets.push({ bone: b, center: toBone(b, p.center), r: p.r * unit(b) });
    }
  }

  /** полуоси, заданные по осям модели, → по осям кости (габарит повёрнутого эллипсоида) */
  private rotRadii(b: THREE.Object3D, model: THREE.Object3D, r: THREE.Vector3) {
    const q = b.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(model.getWorldQuaternion(new THREE.Quaternion()));
    const e = new THREE.Matrix4().makeRotationFromQuaternion(q).elements;
    return new THREE.Vector3(Math.hypot(e[0] * r.x, e[4] * r.y, e[8] * r.z), Math.hypot(e[1] * r.x, e[5] * r.y, e[9] * r.z), Math.hypot(e[2] * r.x, e[6] * r.y, e[10] * r.z));
  }

  /** сменить характер: действуют его запасы PERSONA_PAD (меши одежды переключает видимость) */
  setPersona(id: string) {
    this.persona = id;
    this.held.clear();
  }

  /** прокси сейчас действует: одежда видна, запас — своего характера */
  private active(px: Proxy): boolean {
    if (px.persona) return px.persona === this.persona;
    if (!px.mesh) return true;
    for (let o: THREE.Object3D | null = px.mesh; o; o = o.parent) if (!o.visible) return false;
    return true;
  }

  private inPocket(p: THREE.Vector3): boolean {
    for (const pk of this.pockets) {
      // центр и радиус в мире — из кэша кадра (prepare), иначе заново
      const c = pk.wc ?? tv2.copy(pk.center).applyMatrix4(pk.bone.matrixWorld);
      const r = pk.wr ?? pk.r * (tv3.setFromMatrixScale(pk.bone.matrixWorld).x || 1);
      if (p.distanceToSquared(c) < r * r) return true;
    }
    return false;
  }

  /** точки рук и голеней в текущей позе */
  private points(only?: 'Left' | 'Right'): Pt[] {
    const out: Pt[] = [];
    // матрицы костей уже свежие (apply/measurePairs обновили дерево; повёрнутые кости — своё поддерево)
    const wp = (o: THREE.Object3D) => new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
    for (const side of ['Left', 'Right']) {
      if (only && side !== only) continue;
      const S = side[0];
      const arm = this.bone(side + 'Arm'), fore = this.bone(side + 'ForeArm'), hand = this.bone(side + 'Hand');
      if (arm && fore && hand) {
        const Sh = wp(arm), E = wp(fore), H = wp(hand);
        const T = H.clone().add(H.clone().sub(E).multiplyScalar(0.45)); // кончик лапы
        const alt = { bone: arm, joint: Sh };
        // у головы и одежды на ней кисть и предплечье — точки поверхности (samples), если они есть у этой стороны; о торс,
        // бёдра, юбку — по осям, как раньше (рука вдоль тела и «в карманах» касается худи по замыслу)
        const surf = !this.legacy && !this.axis && this.samples.some((x) => x.side === side);
        out.push(
          { group: `${S}Hand`, p: T, bone: fore, joint: E, hand: true, alt, surf },
          { group: `${S}Hand`, p: H, bone: fore, joint: E, hand: true, alt, surf },
          { group: `${S}ForeArm`, p: E.clone().lerp(H, 0.5), bone: fore, joint: E, hand: false, alt, surf },
          { group: `${S}Elbow`, p: E, bone: arm, joint: Sh, hand: false, surf },
          { group: `${S}UpperArm`, p: Sh.clone().lerp(E, 0.5), bone: arm, joint: Sh, hand: false, surf },
        );
      }
      const up = this.bone(side + 'UpLeg'), leg = this.bone(side + 'Leg'), foot = this.bone(side + 'Foot');
      const other = this.bone((side === 'Left' ? 'Right' : 'Left') + 'UpLeg');
      if (up && leg && foot) {
        const Hp = wp(up), K = wp(leg), F = wp(foot);
        // своя сторона: от тазобедренного другой ноги к своему (поза таза — не клипа ног)
        const sd = other ? Hp.clone().sub(wp(other)).normalize() : undefined;
        out.push(
          { group: `${S}Shin`, p: F, bone: up, joint: Hp, hand: false, side: sd },
          { group: `${S}Shin`, p: K.clone().lerp(F, 0.5), bone: up, joint: Hp, hand: false, side: sd },
          { group: `${S}Knee`, p: K, bone: up, joint: Hp, hand: false, side: sd },
        );
      }
    }
    return out;
  }

  /** какие прокси проверяет точка */
  private relevant(pt: Pt, px: Proxy): boolean {
    if (!this.active(px)) return false;
    if (px.skip?.test(pt.group)) return false;
    // голень и колено — только о другую ногу (о юбку и торс ноги «трутся» по замыслу — их ведёт скин)
    if (LEG.test(pt.group)) return /^(thigh|shin)_/.test(px.name);
    // плечо, локоть, предплечье о бёдра не толкаем (рука вдоль тела); кисть — да
    if (!pt.hand && /^(thigh|shin)_/.test(px.name)) return false;
    if (pt.surf && SURF_PROXY.test(px.name)) return false;
    return true;
  }

  /** какие прокси проверяет точка поверхности: голова и одежда на ней (SURF_PROXY), кроме сидящих в ней в позе покоя */
  private relevantS(s: SurfSample, px: Proxy): boolean {
    if (!SURF_PROXY.test(px.name) || s.skip.has(px) || !this.active(px)) return false;
    if (px.skip?.test(s.group)) return false;
    return true;
  }

  /**
   * Кольца и дуги (дуга наушников вокруг шеи у v1 / над капюшоном у v2, шарф): рука выходит из них только наружу — от
   * центра кольца (среднее капсул), иначе предплечье, продетое клипом между шеей и дугой, «выталкивалось» бы внутрь
   * кольца, к шее. undefined — прокси не кольцо.
   */
  private ringSide(px: Proxy, p: THREE.Vector3): THREE.Vector3 | undefined {
    if (!RING.test(px.name)) return undefined;
    const c = this.ringC.get(px.name.replace(/_\d+$/, ''));
    if (!c) return undefined;
    const v = sSide.copy(p).sub(c);
    return v.lengthSq() > 1e-12 ? v.normalize() : undefined;
  }

  /** кэш кадра: обратные матрицы костей прокси (кости тела/одежды за итерации коррекции рук не двигаются) */
  private prepare() {
    for (const px of this.proxies) {
      const mw = px.bone.matrixWorld;
      (px.inv ??= new THREE.Matrix4()).copy(mw).invert();
      const bs = (px.bs = tv.setFromMatrixScale(mw).x || 1);
      // ограничивающая сфера (мир) — отсев точек, далёких от прокси
      const wc = (px.wc ??= new THREE.Vector3());
      if (px.kind === 'ellipsoid') {
        wc.copy(px.center).applyMatrix4(mw);
        px.wr = Math.max(px.radii.x, px.radii.y, px.radii.z) * bs;
      } else {
        wc.copy(px.a).add(px.b).multiplyScalar(0.5).applyMatrix4(mw);
        px.wr = (px.a.distanceTo(px.b) / 2 + px.r) * bs;
      }
    }
    for (const pk of this.pockets) {
      (pk.wc ??= new THREE.Vector3()).copy(pk.center).applyMatrix4(pk.bone.matrixWorld);
      pk.wr = pk.r * (tv.setFromMatrixScale(pk.bone.matrixWorld).x || 1);
    }
    // центры колец (ringSide): среднее центров капсул группы
    for (const v of this.ringC.values()) v.set(0, 0, 0);
    const cnt = new Map<string, number>();
    for (const px of this.proxies) {
      if (!RING.test(px.name) || !px.wc) continue;
      const g = px.name.replace(/_\d+$/, '');
      let c = this.ringC.get(g);
      if (!c) this.ringC.set(g, (c = new THREE.Vector3()));
      c.add(px.wc);
      cnt.set(g, (cnt.get(g) ?? 0) + 1);
    }
    for (const [g, n] of cnt) this.ringC.get(g)!.multiplyScalar(1 / n);
  }

  /** клип кадра (id каталога и имя клипа GLB): клип-контакт — лапы ложатся на голову/наушники/уши, а не тонут */
  setClip(id: string, name?: string) {
    this.contactOn = CONTACT_CLIPS.test(id) || (!!name && CONTACT_CLIPS.test(name));
  }

  /** глубина самого сильного проникновения (доли роста, 0 — нет), без изменений позы */
  measure(): number {
    return worstPair(this.measurePairs()).depth;
  }

  /**
   * Глубина по парам «группа точек:прокси» (доли роста; без зазора — только настоящее проникновение, кость в кость).
   */
  measurePairs(): Record<string, number> {
    this.root.updateMatrixWorld(true);
    const rs = this.root.getWorldScale(new THREE.Vector3()).x || 1;
    const out: Record<string, number> = {};
    this.prepare();
    for (const pt of this.points())
      for (const px of this.proxies) {
        if (!this.relevant(pt, px)) continue;
        const d = proxyDepth(px, pt.p, 0, undefined, pt.side, true) / rs;
        if (d <= 1e-5) continue;
        const k = `${pt.group}:${px.name}`;
        out[k] = Math.max(out[k] ?? 0, d);
      }
    // кисть и предплечье — по точкам поверхности (то, что видно: сетка лапы, а не ось кости)
    if (!this.legacy)
      for (const sm of this.samples) {
        this.skin(sm);
        for (const px of this.proxies) {
          if (!this.relevantS(sm, px)) continue;
          const d = proxyDepth(px, sm.p, 0, undefined, sm.hand ? undefined : this.ringSide(px, sm.p), true, RING_MIN) / rs;
          if (d <= 1e-5) continue;
          const k = `${sm.group}:${px.name}`;
          out[k] = Math.max(out[k] ?? 0, d);
        }
      }
    return out;
  }

  /** после клипа (кости уже в позе кадра); dt — сглаживание уходящей поправки (0 — без сглаживания: проверка клипа) */
  apply(dt = 1 / 30) {
    this.hits = 0;
    // вес контакта: входит и уходит за CONTACT_FADE (dt = 0 — проверка клипа: сразу)
    const cw = this.contactOn ? 1 : 0;
    this.contactW = dt > 0 ? this.contactW + Math.max(-dt / CONTACT_FADE, Math.min(dt / CONTACT_FADE, cw - this.contactW)) : cw;
    // вес исключения сторон: к цели плавно (dt = 0 — сразу); полностью исключённая — как раньше, без коррекции
    for (const side of ['Left', 'Right'] as const) {
      const to = this.exempt.has(side) ? 1 : Math.max(0, Math.min(1, this.exemptTo[side]));
      const w = this.exemptW[side];
      this.exemptW[side] = dt > 0 ? w + Math.max(-dt / EXEMPT_FADE, Math.min(dt / EXEMPT_FADE, to - w)) : to;
      this.exemptTo[side] = 0;
    }
    const off = this.offSides;
    off.clear();
    if (this.exemptW.Left > 0.999) off.add('Left');
    if (this.exemptW.Right > 0.999) off.add('Right');
    if (!this.enabled || !this.proxies.length) return;
    this.root.updateMatrixWorld(true);
    this.prepare();
    const rs = this.root.getWorldScale(tv).x || 1;
    const before = new Map<THREE.Object3D, THREE.Quaternion>();
    for (const n of ['LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand', 'LeftUpLeg', 'RightUpLeg']) {
      const b = this.bone(n);
      if (!b) continue;
      if (off.size && /Arm|Hand/.test(n) && off.has(n.startsWith('Left') ? 'Left' : 'Right')) {
        this.held.delete(b);
        continue;
      }
      before.set(b, b.quaternion.clone());
    }
    const surf = !this.legacy && !this.axis && this.samples.length > 0;
    // тёплый старт: поправка прошлого кадра, уже затухшая на этот кадр (τ 0,08 с, не быстрее MAX_DECAY) — дальше
    // итерации добирают только новое проникновение (обычно 0–2 шага вместо 10–20) и гасить вручную не нужно: поправка
    // сама уходит, пока лапа снаружи
    const k = dt > 0 && !this.legacy ? 1 - Math.exp(-dt / 0.08) : 1;
    const warm = dt > 0 && !this.legacy && this.held.size > 0;
    if (warm) {
      for (const [b, q0] of before) {
        const h = this.held.get(b);
        if (!h) continue;
        // доля затухания: k, но поворот за кадр не больше MAX_DECAY·dt
        const f = Math.min(k, (MAX_DECAY * dt) / Math.max(angOf(h), 1e-9));
        const dec = sQ2.copy(h).slerp(sQid, f);
        b.quaternion.copy(dec).multiply(q0);
      }
      for (const b of before.keys()) if (this.held.has(b)) b.updateMatrixWorld(true);
      this.prepare();
    }
    // 0. клип-контакт: ближайшая к голове/наушникам точка лапы, зависшая над поверхностью, — на поверхность
    // (два шага: поворот считается в линейном приближении)
    if (surf && this.contactW > 0) for (const side of ['Left', 'Right'] as const) if (!off.has(side)) for (let k = 0; k < 2; k++) this.pull(side, rs);
    // рука далеко от головы (ни одного прокси головы рядом) — как раньше, точками на осях (мягкий вход, проверено стендом:
    // общий шаг по торсу/бёдрам/юбке в танце, сальто, прыжке давал «щелчки» 17–26 рад/с); у головы — точки поверхности
    const sides = (['Left', 'Right'] as const).map((side) => {
      const chain = surf && this.nearCheap(side, rs) && this.near(side, rs * (SURF_MARGIN + NEAR + CONTACT_BAND)).length > 0;
      const ex = off.has(side);
      return { side, arm: false, stop: !chain || ex, chain: chain || ex, prev: 0, stall: 0, steps: 0 };
    });
    const chainSide = { L: sides[0].chain, R: sides[1].chain };
    // 1. выталкивание: за итерацию — точки на осях (локоть, плечо, ноги) о первый прокси, в который вошли; кисть и
    // предплечье — все точки поверхности стороны разом; потом заново (до 24 итераций; без проникновения — одна)
    for (let it = 0; it < 24; it++) {
      this.iters = it + 1;
      let moved = false;
      // кость, уже повёрнутая в этой итерации, ждёт пересчёта точек (иначе перетолкнём по устаревшим)
      const done = new Set<THREE.Object3D>();
      let legMoved = false;
      if (surf)
        for (const st of sides) {
          // предел шагов за кадр: тёплый старт доберёт остальное на следующих кадрах (цена кадра — ограничена)
          if (st.stop || ++st.steps > (dt > 0 ? (this.contactW > 0 ? SURF_STEPS_CONTACT : SURF_STEPS) : 24)) continue;
          const arm = this.bone(st.side + 'Arm'), fore = this.bone(st.side + 'ForeArm');
          if (!arm || !fore || done.has(arm) || done.has(fore)) continue;
          // сначала — локтем (плечо «дорогое»); глубина почти не уменьшилась (кисть в щели между головой и наушниками,
          // нужна и рука от плеча) — плечо наравне с локтем; и так встало 4 раза — сторона закончена
          // 0 — сейчас снаружи (но плечо могут сдвинуть точки локтя — на следующей итерации проверим снова)
          const d0 = this.pushChain(st.side, rs, st.arm ? 1 : ARM_COST);
          if (d0 === 0) {
            st.prev = 0;
            continue;
          }
          const d = Math.abs(d0);
          if (d0 < 0 || (st.prev > 0 && d > st.prev * 0.85)) {
            if (st.arm) st.stop = ++st.stall >= 4;
            else st.arm = true;
          }
          st.prev = d;
          moved = true;
          done.add(arm);
          done.add(fore);
        }
      for (const p0 of this.points()) {
        // вторая половина итераций: кисть и предплечье толкают и плечо (локтя одного не хватает — кисть глубоко)
        const pt = it >= 6 && p0.alt ? { ...p0, bone: p0.alt.bone, joint: p0.alt.joint } : p0;
        if (done.has(pt.bone) || done.has(pt.bone.parent!)) continue;
        if (this.legacy && LEG.test(pt.group)) continue;
        if (off.size && !LEG.test(pt.group) && off.has(pt.group[0] === 'L' ? 'Left' : 'Right')) continue;
        // рука у головы — целиком в pushChain; иначе — по осям, без прокси головы (их рядом нет)
        if (pt.surf && chainSide[pt.group[0] as 'L' | 'R']) continue;
        const mg = pt.hand && this.inPocket(pt.p) ? 0 : (LEG.test(pt.group) ? this.legMargin : this.margin) * rs;
        const how = this.push(pt, mg);
        if (how === 'hard') {
          moved = true;
          done.add(pt.bone);
          if (LEG.test(pt.group)) legMoved = true;
        }
      }
      if (!moved) break;
      // бёдра повернулись — прокси ног (бёдра/голени) в новом месте
      if (legMoved) this.prepare();
    }
    // 2. сглаживание: поправка = after · before⁻¹ (локально); растёт — сразу, но не быстрее MAX_GROW; уходит — уже
    // затухла в тёплом старте (~0,1 с, не быстрее MAX_DECAY)
    const changed: THREE.Object3D[] = [];
    for (const [b, q0] of before) {
      const corr = b.quaternion.clone().multiply(q0.clone().invert());
      const prev = this.held.get(b) ?? new THREE.Quaternion();
      let use = corr;
      if (dt > 0 && !this.legacy) {
        // скорость поправки: шаг от прошлой — не больше предела за кадр (рост — MAX_GROW, спад — MAX_DECAY)
        const grow = angOf(corr) > angOf(prev) + 1e-4;
        const step = angOf(tq.copy(use).multiply(prev.clone().invert()));
        const lim = (grow ? MAX_GROW : MAX_DECAY) * dt;
        if (step > lim) use = prev.clone().slerp(use, lim / step);
      } else if (dt > 0 && k < 1 && angOf(prev) > angOf(corr) + 1e-4) use = prev.clone().slerp(corr, k);
      // не больше MAX_CORR всего: клип совсем мимо тела — пусть лучше заденет, чем вывернет руку
      const a = angOf(use);
      if (a > MAX_CORR) use.slerp(new THREE.Quaternion(), 1 - MAX_CORR / a);
      if (angOf(use) < 1e-5) this.held.delete(b);
      else this.held.set(b, use.clone());
      // сторона частично исключена (вход/выход исключения): поправка — с весом (1 − w)
      const ew = /Arm|Hand/.test(b.name) ? this.exemptW[/Left/.test(b.name) ? 'Left' : 'Right'] : 0;
      if (ew > 1e-3) use = use.clone().slerp(sQid, ew);
      if (use !== corr || a > MAX_CORR) changed.push(b);
      b.quaternion.copy(use).multiply(q0);
    }
    // поправку сгладили — матрицы только поддеревьев этих костей (не всего кота)
    for (const b of changed) b.updateMatrixWorld(true);
    // 3. исключённая лапа (предмет): локоть — вокруг оси «плечо — запястье» из одежды и шеи, кисть не двигается
    for (const side of ['Left', 'Right'] as const) this.swivel(side, rs, dt);
  }

  private offSides = new Set<'Left' | 'Right'>();
  private swivelS = { Left: { n: 0, goal: null as number | null }, Right: { n: 0, goal: null as number | null } };

  /**
   * Разворот локтя исключённой лапы (вес исключения > 0): плечо поворачивается вокруг оси «плечо — запястье» (кисть на
   * оси — на месте), кисть — обратно (её поворот в мире не меняется). Угол — поиском по соседям прошлого (±SWIVEL_STEP)
   * по сумме квадратов глубин точек стороны (с зазором), не быстрее SWIVEL_RATE; без исключения — к нулю.
   */
  private swivel(side: 'Left' | 'Right', rs: number, dt: number) {
    const ew = this.exemptW[side];
    const arm = this.bone(side + 'Arm'), hand = this.bone(side + 'Hand');
    if (!arm || !hand || !this.samples.length || this.legacy) return;
    const prev = this.swivelA[side];
    if (ew < 0.01 && Math.abs(prev) < 1e-3) {
      this.swivelA[side] = 0;
      return;
    }
    const S = new THREE.Vector3().setFromMatrixPosition(arm.matrixWorld);
    const ax = new THREE.Vector3().setFromMatrixPosition(hand.matrixWorld).sub(S);
    if (ax.lengthSq() < 1e-12) return;
    ax.normalize();
    const q0 = arm.quaternion.clone(), hq = hand.getWorldQuaternion(new THREE.Quaternion());
    const pq = new THREE.Quaternion(), hpq = new THREE.Quaternion();
    const set = (th: number) => {
      arm.parent!.matrixWorld.decompose(tv2, pq, tv3);
      const local = pq.clone().invert().multiply(new THREE.Quaternion().setFromAxisAngle(ax, th)).multiply(pq);
      arm.quaternion.copy(local).multiply(q0);
      arm.updateMatrixWorld(true);
      hand.parent!.getWorldQuaternion(hpq);
      hand.quaternion.copy(hpq.invert().multiply(hq));
      hand.updateMatrixWorld(true);
    };
    const cost = (th: number) => {
      set(th);
      return this.evalSide(side, rs, null).f / (rs * rs) + 2e-6 * th * th;
    };
    let best = prev, bc = Infinity;
    if (ew >= 0.01 && dt > 0) {
      const step = Math.min(SWIVEL_STEP, SWIVEL_RATE * dt);
      for (const th of [prev, prev - step / 3, prev + step / 3, prev - step, prev + step]) {
        if (Math.abs(th) > SWIVEL_MAX) continue;
        const c = cost(th);
        if (c < bc - 1e-12) [best, bc] = [th, c];
      }
      // местный минимум с остатком (предплечье в шарфе у рта): раз в 4 кадра — обзор всего диапазона; лучше заметно —
      // туда, но с той же скоростью
      const st = this.swivelS[side];
      if (bc > 1e-6 && ++st.n % 4 === 0) {
        let gb = best, gc = bc;
        for (let th = -SWIVEL_MAX; th <= SWIVEL_MAX + 1e-6; th += 0.35) {
          const c = cost(th);
          if (c < gc * 0.6) [gb, gc] = [th, c];
        }
        st.goal = gb !== best ? gb : null;
      }
      if (st.goal !== null) {
        if (Math.abs(st.goal - prev) < step) st.goal = null;
        else {
          const th = prev + Math.sign(st.goal - prev) * step;
          const c = cost(th);
          if (c < bc * 1.5) [best, bc] = [th, c];
          else st.goal = null;
        }
      }
    } else best = prev - Math.sign(prev) * Math.min(Math.abs(prev), SWIVEL_RATE * Math.max(dt, 1 / 30));
    this.swivelA[side] = best;
    set(best * Math.min(1, ew * 1.5 + (ew < 0.01 ? 1 : 0)));
  }

  /** строки ограничений текущего шага коррекции (по 6 чисел: 5 коэффициентов и глубина) */
  private rows: number[] = [];
  private act: boolean[] = [];
  private saveQ = [new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion()];

  /** зазор точки поверхности: в кармане — 0 (кисть у входа), в клипе-контакте — меньше */
  private surfMargin(s: SurfSample, rs: number): number {
    if (s.hand && this.pockets.length && this.inPocket(s.p)) return 0;
    return (SURF_MARGIN + (CONTACT_MARGIN - SURF_MARGIN) * this.contactW) * rs;
  }

  /**
   * Все точки поверхности стороны (кисть + предплечье) вне прокси головы: малый поворот предплечья (поперёк кости, без
   * кручения) и плеча (3 оси) по ограничениям нормали n·Δp ≥ d для каждой проникшей пары «точка : прокси» — затухающие
   * наименьшие квадраты (плечо дороже локтя в armCost раз), лапа может скользить вдоль поверхности; поворот
   * растягивается, чтобы самая глубокая точка вышла целиком, ≤ 25° на кость за итерацию. Возвращает глубину до
   * поворота (мир; 0 — проникновения нет).
   */
  private pushChain(side: 'Left' | 'Right', rs: number, armCost: number): number {
    const ch = this.chain(side);
    if (!ch) return 0;
    this.rows.length = 0;
    const e0 = this.evalSide(side, rs, ch);
    if (this.trace) this.trace.push(`${side[0]}${armCost === 1 ? '+' : ''}:${((e0.maxD / rs) * CAT_MM).toFixed(2)}`);
    if (e0.maxD < 0.0003 * rs) return 0;
    const x = this.solveChain(armCost, e0.deep);
    if (!x) return -e0.maxD;
    // шаг с возвратом: сумма квадратов глубин должна уменьшиться, иначе — назад и полшага (до 4 раз); так руку не
    // «бросает» между головой, наушником и грудью (каждый шаг — не хуже прошлого)
    const save = this.saveQ;
    save[0].copy(ch.arm.quaternion);
    save[1].copy(ch.fore.quaternion);
    save[2].copy(ch.hand.quaternion);
    for (let t = 0; t < 5; t++) {
      this.applyX(ch, x);
      const f1 = this.evalSide(side, rs, null).f;
      if (this.trace) this.trace.push(`(${(e0.f * 1e6).toFixed(1)}→${(f1 * 1e6).toFixed(1)} |x| ${Math.hypot(...x).toFixed(3)})`);
      if (f1 < e0.f) return e0.maxD;
      ch.arm.quaternion.copy(save[0]);
      ch.fore.quaternion.copy(save[1]);
      ch.hand.quaternion.copy(save[2]);
      ch.arm.updateMatrixWorld(true);
      for (let i = 0; i < NU; i++) x[i] *= 0.5;
    }
    // ни один шаг не помог — «застряла» (отрицательное: глубина есть, шага нет)
    return -e0.maxD;
  }

  /**
   * Глубины точек стороны (поверхность у головы + точки на осях о торс/бёдра) с зазором: f — сумма квадратов глубин,
   * maxD — самая глубокая; ch задан — строки ограничений для шага (и точки рядом, до NEAR снаружи: шаг не должен их
   * вталкивать — иначе «пинг-понг» между прокси).
   */
  private evalSide(side: 'Left' | 'Right', rs: number, ch: ReturnType<BodyCollider['chain']>): { f: number; maxD: number; deep: number } {
    const R = this.rows;
    let maxD = 0, deep = -1, f = 0;
    const near = ch ? NEAR * rs : 0;
    // сфера точек стороны → прокси головы рядом (обычно ни одного: рука у тела — дальше ничего не считаем)
    const cand = this.near(side, rs * (SURF_MARGIN + NEAR));
    const add = (p: THREE.Vector3, d: number, hand: boolean, upper: boolean) => {
      if (d > 0) f += d * d;
      if (d > maxD) [maxD, deep] = [d, R.length];
      if (!ch) return;
      const n = sO.sub(p);
      const nl = n.length();
      if (nl < 1e-9) return;
      this.row(ch, p, n.multiplyScalar(1 / nl), d, hand, upper);
    };
    if (cand.length)
      for (const s of this.samples) {
        if (s.side !== side) continue;
        const mg = this.surfMargin(s, rs);
        for (const px of cand) {
          const lim = (px.wr ?? 0) + mg + near;
          if (px.wc && px.wc.distanceToSquared(s.p) > lim * lim) continue;
          if (s.skip.has(px) || (px.skip && px.skip.test(s.group))) continue;
          const d = proxyDepth(px, s.p, mg + near, sO, s.hand ? undefined : this.ringSide(px, s.p), true, RING_MIN) - near;
          if (d > -near + 1e-7) add(s.p, d, s.hand, s.upper);
        }
      }
    // точки на осях той же руки (кисть, предплечье — о торс, бёдра; локоть, плечо — обо всё, кроме головы) — в тот же
    // шаг: порознь две коррекции толкали бы руку друг в друга (кисть между грудью и наушником)
    const arm = this.bone(side + 'Arm');
    for (const pt of this.points(side)) {
      if (LEG.test(pt.group)) continue;
      const mgA = pt.hand && this.inPocket(pt.p) ? 0 : this.margin * rs;
      for (const px of this.proxies) {
        const lim = (px.wr ?? 0) + mgA + near;
        if (px.wc && px.wc.distanceToSquared(pt.p) > lim * lim) continue;
        if (!this.relevant(pt, px)) continue;
        let d = proxyDepth(px, pt.p, mgA + near, sO, undefined, true) - near;
        if (d <= -near + 1e-7) continue;
        // мягкий вход (как push): во внешней половине зазора толкание растёт плавно (d²/2·band), глубже — d − band/2;
        // иначе рука о торс/бёдра/юбку в быстрых клипах (прыжок, танец) получала поправку рывком
        const band = Math.max(0.5 * mgA, 0.006 * rs);
        if (d > 0) d = d < band ? (d * d) / (2 * band) : d - band / 2;
        add(pt.p, d, false, pt.bone === arm);
      }
    }
    return { f, maxD, deep };
  }


  /** дёшево, без скина: сфера «плечо — кисть» (+ лапа) задевает сферу хоть одного прокси головы? */
  private nearCheap(side: 'Left' | 'Right', rs: number): boolean {
    const a = this.bone(side + 'Arm'), h = this.bone(side + 'Hand');
    if (!a || !h) return true;
    const A = sNa.setFromMatrixPosition(a.matrixWorld), Hh = sNh.setFromMatrixPosition(h.matrixWorld);
    const r = A.distanceTo(Hh) / 2 + 0.17 * rs; // лапа за костью кисти ~0,1 + зазоры и полоса контакта
    A.add(Hh).multiplyScalar(0.5);
    for (const px of this.proxies) {
      if (!px.wc || !SURF_PROXY.test(px.name)) continue;
      const lim = r + (px.wr ?? 0);
      if (px.wc.distanceToSquared(A) < lim * lim) return true;
    }
    return false;
  }

  /** скин точек стороны и прокси головы (SURF_PROXY, действующие), чьи сферы ближе pad к сфере точек */
  private near(side: 'Left' | 'Right', pad: number): Proxy[] {
    const c = sSc.set(0, 0, 0);
    let n = 0;
    for (const s of this.samples)
      if (s.side === side) {
        c.add(this.skin(s));
        n++;
      }
    const cand = this.cand;
    cand.length = 0;
    if (!n) return cand;
    c.multiplyScalar(1 / n);
    let r2 = 0;
    for (const s of this.samples) if (s.side === side) r2 = Math.max(r2, s.p.distanceToSquared(c));
    const r = Math.sqrt(r2) + pad;
    for (const px of this.proxies) {
      if (!SURF_PROXY.test(px.name) || !px.wc || !this.active(px)) continue;
      const lim = r + (px.wr ?? 0);
      if (px.wc.distanceToSquared(c) < lim * lim) cand.push(px);
    }
    return cand;
  }

  /** клип-контакт: ближайшая точка кисти над головой/ушами/наушниками/кепкой (≤ CONTACT_BAND) — на поверхность + зазор */
  private pull(side: 'Left' | 'Right', rs: number) {
    const ch = this.chain(side);
    if (!ch) return;
    let best: SurfSample | null = null;
    let gap = Infinity;
    const cand = this.near(side, CONTACT_BAND * rs);
    for (const s of this.samples) {
      if (s.side !== side || !s.hand) continue;
      for (const px of cand) {
        if (!CONTACT_PROXY.test(px.name) || !this.relevantS(s, px)) continue;
        const g = proxyGap(px, s.p, sO, true);
        if (g < gap) {
          gap = g;
          best = s;
          sP.copy(sO);
        }
      }
    }
    const band = CONTACT_BAND * rs;
    const mg = CONTACT_MARGIN * rs;
    if (!best || gap <= mg || gap >= band) return;
    // спад к краю полосы: подтягивание непрерывно (на входе в полосу — от нуля, без щелчка)
    const f = (gap < band / 2 ? 1 : (band - gap) / (band / 2)) * this.contactW;
    const n = sD.copy(sP).sub(best.p).normalize();
    this.rows.length = 0;
    this.row(ch, best.p, n, (gap - mg) * f, true);
    // только локтем и кистью: контакт — мелкая поправка, плечо не трогаем
    const x = this.solveChain(1e6, 0);
    if (x) this.applyX(ch, x);
  }

  /** рука стороны в текущей позе: кости, суставы, базис поперёк предплечья */
  private chain(side: 'Left' | 'Right') {
    const arm = this.bone(side + 'Arm'), fore = this.bone(side + 'ForeArm'), hand = this.bone(side + 'Hand');
    if (!arm || !fore || !hand) return null;
    const S = sS.setFromMatrixPosition(arm.matrixWorld), E = sJ.setFromMatrixPosition(fore.matrixWorld), Hw = sHw.setFromMatrixPosition(hand.matrixWorld);
    const ax = sAx2.copy(Hw).sub(E);
    if (ax.lengthSq() < 1e-12) ax.set(0, 1, 0);
    ax.normalize();
    const e1 = sE1.set(1, 0, 0);
    if (Math.abs(ax.x) > 0.8) e1.set(0, 1, 0);
    e1.addScaledVector(ax, -e1.dot(ax)).normalize();
    const e2 = sE2.crossVectors(ax, e1);
    return { arm, fore, hand, S, E, Hw, e1, e2 };
  }

  /**
   * строка ограничения: n·(ω_f × (p − E) + ω_a × (p − S) + ω_h × (p − H)) = d → коэффициенты [ω_f·e1, ω_f·e2, ω_a.xyz,
   * ω_h.xyz] и d (кисть — только у точек кисти: запястье наклоняет лапу, предплечье не трогает)
   */
  private row(ch: NonNullable<ReturnType<BodyCollider['chain']>>, p: THREE.Vector3, n: THREE.Vector3, d: number, hand: boolean, upper = false) {
    const cS = sC3.copy(p).sub(ch.S).cross(n);
    if (upper) {
      this.rows.push(0, 0, cS.x, cS.y, cS.z, 0, 0, 0, d);
      return;
    }
    const cE = sC2.copy(p).sub(ch.E).cross(n);
    this.rows.push(cE.dot(ch.e1), cE.dot(ch.e2), cS.x, cS.y, cS.z);
    if (hand) {
      const cH = sC2.copy(p).sub(ch.Hw).cross(n);
      this.rows.push(cH.x, cH.y, cH.z, d);
    } else this.rows.push(0, 0, 0, d);
  }

  /** затухающие наименьшие квадраты по строкам this.rows (8 неизвестных) → повороты плеча, предплечья и кисти */
  private solveChain(armCost: number, deep: number): number[] | null {
    const R = this.rows, N = NU, W = N + 1;
    // активные строки: проникшие (d > 0) + те, что шаг вталкивает (d − J·x > 0) — до 3 уточнений
    const act = this.act;
    act.length = R.length / W;
    for (let k = 0; k < act.length; k++) act[k] = R[k * W + N] > 0;
    let x: number[] | null = null;
    for (let pass = 0; pass < 3; pass++) {
      const M = sM.fill(0), v = sVv.fill(0);
      for (let r = 0; r < act.length; r++) {
        if (!act[r]) continue;
        const k = r * W;
        for (let i = 0; i < N; i++) {
          v[i] += R[k + i] * R[k + N];
          for (let j = 0; j < N; j++) M[i * N + j] += R[k + i] * R[k + j];
        }
      }
      let tr = 1e-14;
      for (let i = 0; i < N; i++) tr += M[i * N + i] / N;
      for (let i = 0; i < N; i++) M[i * N + i] += tr * 1e-2 * (i < 2 ? 1 : i < 5 ? armCost : HAND_COST);
      x = solveN(M, v, N);
      if (!x) return null;
      let added = false;
      for (let r = 0; r < act.length; r++) {
        if (act[r]) continue;
        const k = r * W;
        let jx = 0;
        for (let i = 0; i < N; i++) jx += R[k + i] * x[i];
        if (R[k + N] - jx > 0) act[r] = added = true;
      }
      if (!added) break;
    }
    if (!x) return null;
    // самая глубокая точка — целиком (до ×3)
    if (deep >= 0) {
      let got = 0;
      for (let i = 0; i < N; i++) got += R[deep + i] * x[i];
      const need = R[deep + N];
      if (got > 1e-12 && got < need) {
        const k = Math.min(3, need / got);
        for (let i = 0; i < N; i++) x[i] *= k;
      }
    }
    // ≤ 25° на кость за итерацию — общим множителем (плечо и локоть часто гасят друг друга: порознь урезать нельзя)
    const big = Math.max(Math.hypot(x[0], x[1]), Math.hypot(x[2], x[3], x[4]), Math.hypot(x[5], x[6], x[7]));
    if (big > 0.44) for (let i = 0; i < N; i++) x[i] *= 0.44 / big;
    return x;
  }

  /** применить шаг x: повороты плеча, предплечья (поперёк кости) и кисти */
  private applyX(ch: NonNullable<ReturnType<BodyCollider['chain']>>, x: number[]) {
    const wa = sWa.set(x[2], x[3], x[4]);
    const wf = sW.copy(ch.e1).multiplyScalar(x[0]).addScaledVector(ch.e2, x[1]);
    const wh = sWh.set(x[5], x[6], x[7]);
    // кости ниже едут вместе с верхними: их оси поворота — повёрнутые так же
    const qa = this.rotWorld(ch.arm, wa);
    if (qa) {
      wf.applyQuaternion(qa);
      wh.applyQuaternion(qa);
    }
    const qf = this.rotWorld(ch.fore, wf);
    if (qf) wh.applyQuaternion(qf);
    this.rotWorld(ch.hand, wh);
  }

  /** повернуть кость на мировой вектор поворота ω (≤ 25°) вокруг её сустава; null — поворот ничтожный */
  private rotWorld(b: THREE.Object3D, w: THREE.Vector3): THREE.Quaternion | null {
    let ang = w.length();
    if (ang < 1e-6) return null;
    ang = Math.min(ang, 0.44); // ≤ 25° за итерацию
    const q = tq.setFromAxisAngle(sAxR.copy(w).multiplyScalar(1 / w.length()), ang);
    b.parent!.matrixWorld.decompose(tv2, sQ, tv3);
    const local = sQ2.copy(sQ).invert().multiply(q).multiply(sQ);
    b.quaternion.premultiply(local);
    b.updateMatrixWorld(true);
    this.hits++;
    return q;
  }

  /** сбросить память сглаживания (проверка клипа, смена кота) */
  reset() {
    this.held.clear();
    this.swivelA.Left = this.swivelA.Right = 0;
  }

  /**
   * Точка внутри прокси (+ зазор) — повернуть кость вокруг сустава так, чтобы точка вышла наружу. Мягкий контакт (без
   * «щелчка» на входе): во внешней половине зазора толкание растёт плавно (d²/2·band), глубже — точка выходит на ¾ зазора.
   */
  private push(pt: Pt, marginW: number): 'hard' | 'soft' | false {
    const rs = tv.setFromMatrixScale(this.root.matrixWorld).x || 1;
    // полоса мягкого входа — внешняя половина зазора; на глубине точка остаётся снаружи на ¾ зазора
    const band = Math.max(0.5 * marginW, 0.006 * rs);
    // точка сразу в нескольких прокси (кисть между головой и торсом, под козырьком): сдвиги складываются — наружу
    // по диагонали, а не «из головы в торс и обратно»
    const sum = new THREE.Vector3();
    const out = new THREE.Vector3();
    let soft = true;
    for (const px of this.proxies) {
      // отсев по сфере (кэш кадра); нога о ногу — без отсева (скрещённая нога глубже сферы)
      if (!pt.side && px.wc && px.wc.distanceTo(pt.p) > (px.wr ?? 0) + marginW) continue;
      if (!this.relevant(pt, px) || (this.legacy && px.src !== 'mesh')) continue;
      const d = proxyDepth(px, pt.p, marginW, out, pt.side, true);
      if (d <= 1e-6) continue;
      const s = d < band;
      if (!s) soft = false;
      const disp = s ? (d * d) / (2 * band) : d - band / 2;
      sum.addScaledVector(out.sub(pt.p), disp / d);
    }
    if (sum.length() < 0.002 * rs) return false;
    const target = pt.p.clone().add(sum);
    const a = pt.p.clone().sub(pt.joint);
    const b = target.sub(pt.joint);
    if (a.lengthSq() < 1e-10 || b.lengthSq() < 1e-10) return false;
    const q = new THREE.Quaternion().setFromUnitVectors(a.normalize(), b.normalize());
    const ang = angOf(q);
    if (ang < 1e-5) return false;
    if (ang > 0.44) q.slerp(new THREE.Quaternion(), 1 - 0.44 / ang); // ≤ 25° за итерацию
    pt.bone.parent!.matrixWorld.decompose(tv2, tq, tv3);
    const pq = tq;
    const local = pq.clone().invert().multiply(q).multiply(pq);
    pt.bone.quaternion.premultiply(local);
    pt.bone.updateMatrixWorld(true);
    this.hits++;
    return soft ? 'soft' : 'hard';
  }
}

/** самая глубокая пара и её глубина (доли роста) */
export function worstPair(pairs: Record<string, number>): { pair: string; depth: number } {
  let pair = '', depth = 0;
  for (const [k, v] of Object.entries(pairs)) if (v > depth) [pair, depth] = [k, v];
  return { pair, depth };
}

/** мм на карте: рост кота ≈ 0,9 ширины карты (85,6 мм) — как стенд реакций */
export const CAT_MM = 77;
