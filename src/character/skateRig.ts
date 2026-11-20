/**
 * «Скейт» Хулигана (лист 20.11 не принят: «доска как обломок у ноги, проезд статичный»). Стильный короткий номер, доска
 * всё время в системе кота (никаких отлётов и телепортов):
 *   conjure — доска появляется из лапы с искрой и кручением (вертикально, в правой лапе у бока);
 *   place   — кот ставит её перед собой поперёк (нос — по ходу проезда), отпускает на колёса;
 *   hop     — запрыгивает: стойка боком (передняя стопа у передних болтов, задняя — на хвосте), колени согнуты;
 *   push    — толчок задней лапой от опоры и снова на хвост;
 *   ride    — проезд дугой (режиссёр ведёт кота боком к ходу: stage.walkTo side), корпус кренится в поворот, руки
 *             для баланса, колёса крутятся по пройденному пути;
 *   ollie   — присед → щелчок хвостом (нос вверх) → доска с котом в воздухе → ровная посадка с амортизацией;
 *   flip    — кикфлип: доска в воздухе делает оборот вокруг длинной оси, стопы над декой, ловит и приземляется;
 *   roll    — докат; hopoff — соскок вперёд, доска остаётся сзади;
 *   kickup  — стопа жмёт на хвост, доска встаёт и подлетает в правую лапу;
 *   vanish  — кручение и искра, доска пропадает.
 * Доска — вдоль оси X кота (dir — по ходу), кот стоит к ней боком, лицом к зрителю. Размер — от лап (setSkateFit).
 * Чистое расписание skatePose — tests/holdSkate.test.ts; кости двигает GlbCharacter (skatePre/applySkate).
 */
import * as THREE from 'three';

import { RIDE_FROM, RIDE_TO, SKATE_ORDER as ORDER, SKATE_T, SKATE_TOTAL, type SkatePhase } from './skateTiming';
export { RIDE_FROM, RIDE_TO, SKATE_T, SKATE_TOTAL, type SkatePhase };

/** доска в ростах кота: длина, ширина, высота верха деки над опорой, толщина, радиус колеса */
export const BOARD = { len: 0.36, wid: 0.12, deck: 0.062, thick: 0.012, wheelR: 0.018 };
/** стопы на деке, система доски (z — вдоль, к носу): передняя — у передних болтов, задняя — на хвосте */
export const FEET_ON_DECK = { front: new THREE.Vector3(0, BOARD.deck, 0.07), back: new THREE.Vector3(0, BOARD.deck, -0.11) };

/**
 * Подогнать доску под лапы: footLen — длина стопы (пятка → носок), stance — расстояние между стопами.
 * Длина деки = stance + стопа + запас 35 %, ширина — 0,34 длины, колёса и высота — пропорционально.
 */
export function setSkateFit(footLen: number, stance = 0.15) {
  if (!(footLen > 0.02 && footLen < 0.3)) return;
  const len = THREE.MathUtils.clamp((stance + footLen) * 1.35, 0.26, 0.5);
  BOARD.len = len;
  BOARD.wid = len * 0.34;
  BOARD.wheelR = len * 0.05;
  BOARD.thick = len * 0.034;
  BOARD.deck = BOARD.wheelR * 2 + len * 0.055 + BOARD.thick;
  FEET_ON_DECK.front.set(0, BOARD.deck, len * 0.21);
  FEET_ON_DECK.back.set(0, BOARD.deck, -len * 0.33);
}

export interface SkateFrame {
  phase: SkatePhase;
  k: number;
  /** доска: центр (низ колёс) в системе кота; наклон носа (рад, + — вверх, вокруг хвоста), кикфлип (рад), масштаб */
  board: THREE.Vector3;
  pitch: number;
  roll: number;
  boardScale: number;
  /** доска в правой лапе 0…1 (держит вертикально у бока), кручение в лапе (рад) */
  carry: number;
  spin: number;
  /** куда тянется правая лапа с доской (система кота) */
  hand: THREE.Vector3;
  /** подъём тела: опора (дека) + дуга прыжка; присед 0…1 */
  standOn: number;
  lift: number;
  crouch: number;
  /** вес IK стоп на деке; толчок задней: 0…1 на опоре, мах −1…1 (вперёд → назад); стопы над декой (кикфлип) */
  feetW: number;
  push: number;
  sweep: number;
  feetUp: number;
  /** стопа на хвост (kickup) 0…1 */
  kick: number;
  /** лапы в стороны 0…1, разрешённый крен в поворот 0…1, смотреть на доску 0…1, искра 0…1 */
  arms: number;
  leanK: number;
  lookDown: number;
  spark: number;
}

const ss = (x: number) => {
  const k = Math.max(0, Math.min(1, x));
  return k * k * (3 - 2 * k);
};

export function newSkateFrame(): SkateFrame {
  return { phase: 'done', k: 1, board: new THREE.Vector3(), pitch: 0, roll: 0, boardScale: 0, carry: 0, spin: 0, hand: new THREE.Vector3(), standOn: 0, lift: 0, crouch: 0, feetW: 0, push: 0, sweep: 0, feetUp: 0, kick: 0, arms: 0, leanK: 0, lookDown: 0, spark: 0 };
}

/** доска перед лапами (куда её ставят) и под ними (на ней), позади после соскока */
const FRONT_Z = 0.19;
const UNDER_Z = 0.015;
const BEHIND_Z = -0.16;
/** правая лапа держит доску у бока */
const HAND_SIDE = new THREE.Vector3(-0.19, 0.34, 0.12);

/** прыжок с доской (ollie / flip): присед до 0.3, в воздухе 0.3…0.85, посадка */
function air(k: number) {
  return k < 0.3 || k > 0.85 ? 0 : Math.sin(((k - 0.3) / 0.55) * Math.PI);
}

export function skatePose(t: number, out?: SkateFrame): SkateFrame {
  const f = out ?? newSkateFrame();
  let acc = 0;
  let ph: SkatePhase = 'done', k = 1;
  for (const p of ORDER) {
    if (t < acc + SKATE_T[p]) {
      ph = p;
      k = (t - acc) / SKATE_T[p];
      break;
    }
    acc += SKATE_T[p];
  }
  f.phase = ph;
  f.k = k;
  f.pitch = f.roll = f.carry = f.spin = f.lift = f.standOn = f.feetW = f.push = f.sweep = f.feetUp = f.kick = f.crouch = f.arms = f.leanK = f.lookDown = f.spark = 0;
  f.boardScale = 1;
  f.board.set(0, 0, UNDER_Z);
  const D = BOARD.deck;
  const onBoard = () => {
    f.standOn = D;
    f.feetW = 1;
  };
  switch (ph) {
    case 'conjure': {
      // из искры в лапе: растёт с кручением (два оборота, замедляясь), лапа поднимается к боку
      f.carry = 1;
      f.hand.copy(HAND_SIDE).add(new THREE.Vector3(0, -0.06 * (1 - ss(k)), 0));
      f.boardScale = Math.min(1, ss(k / 0.7) * 1.06);
      f.spin = Math.PI * 4 * (1 - ss(k));
      f.spark = k;
      f.lookDown = 0.4 * ss(k);
      f.board.set(0, 0, FRONT_Z);
      break;
    }
    case 'place': {
      // перед собой поперёк, присед; в конце отпускает — доска на колёсах
      const e = ss(k / 0.8);
      f.carry = 1 - ss((k - 0.7) / 0.3);
      f.hand.set(HAND_SIDE.x + 0.14 * e, HAND_SIDE.y - 0.22 * e, HAND_SIDE.z + (FRONT_Z - HAND_SIDE.z) * e);
      f.crouch = 0.6 * Math.sin(Math.min(1, k) * Math.PI);
      f.board.set(0, 0, FRONT_Z);
      f.lookDown = 1;
      break;
    }
    case 'hop': {
      // прыжок на деку: доска под лапы (кот прыгнул вперёд), стопы — IK на деку в воздухе
      const e = ss(k);
      f.board.set(0, 0, FRONT_Z + (UNDER_Z - FRONT_Z) * e);
      f.standOn = D * ss(k * 1.6 - 0.3);
      f.lift = Math.sin(k * Math.PI) * 0.09;
      f.feetW = ss(k * 1.8 - 0.5);
      f.crouch = k < 0.25 ? 0.45 * ss(k / 0.25) : k > 0.75 ? 0.5 * ss((k - 0.75) / 0.25) : 0.15;
      f.arms = 0.7 * e;
      f.lookDown = 1 - 0.6 * e;
      break;
    }
    case 'push':
      // задняя лапа: хвост → опора сбоку, мах назад → снова на хвост
      onBoard();
      f.push = Math.sin(k * Math.PI);
      f.sweep = -Math.cos(k * Math.PI);
      f.crouch = 0.45 + 0.15 * Math.sin(k * Math.PI);
      f.arms = 0.6 + 0.2 * Math.sin(k * Math.PI);
      f.lookDown = 0.25;
      f.leanK = 0.3;
      break;
    case 'ride':
      onBoard();
      f.crouch = 0.4 + 0.08 * Math.sin(k * Math.PI * 4);
      f.arms = 0.8 + 0.12 * Math.sin(k * Math.PI * 3);
      f.leanK = 1;
      break;
    case 'ollie': {
      // присед → щелчок хвостом (нос вверх) → в воздухе вместе → ровно на колёса, амортизация
      const a = air(k);
      onBoard();
      f.crouch = k < 0.3 ? 0.4 + 0.4 * ss(k / 0.3) : k < 0.85 ? 0.8 * (1 - ss((k - 0.3) / 0.2)) + 0.15 : 0.15 + 0.5 * Math.sin(((k - 0.85) / 0.15) * Math.PI);
      f.lift = a * 0.11;
      f.board.y = a * 0.11;
      f.pitch = k < 0.3 ? 0 : 0.45 * Math.sin(Math.min(1, (k - 0.3) / 0.35) * Math.PI) * (1 - ss((k - 0.5) / 0.25)) + (k < 0.4 ? 0.2 * ss((k - 0.3) / 0.1) : 0);
      f.arms = 0.95;
      f.leanK = 0.4;
      break;
    }
    case 'flip': {
      // кикфлип: в воздухе доска — оборот вокруг длинной оси, стопы поднимаются над декой и ловят её
      const a = air(k);
      onBoard();
      f.crouch = k < 0.3 ? 0.4 + 0.4 * ss(k / 0.3) : k < 0.85 ? 0.8 * (1 - ss((k - 0.3) / 0.2)) + 0.15 : 0.15 + 0.5 * Math.sin(((k - 0.85) / 0.15) * Math.PI);
      f.lift = a * 0.15;
      f.board.y = a * 0.1;
      f.pitch = k < 0.3 ? 0 : 0.3 * Math.sin(Math.min(1, (k - 0.3) / 0.2) * Math.PI) * (1 - ss((k - 0.4) / 0.15));
      f.roll = Math.PI * 2 * ss((k - 0.36) / 0.4);
      f.feetUp = Math.sin(Math.min(1, Math.max(0, (k - 0.33) / 0.47)) * Math.PI) * 0.06;
      f.feetW = 1;
      f.arms = 1;
      break;
    }
    case 'roll':
      onBoard();
      f.crouch = 0.4 * (1 - ss(k)) + 0.2;
      f.arms = 0.75 * (1 - 0.4 * k);
      f.leanK = 0.5;
      break;
    case 'hopoff': {
      // соскок вперёд (к зрителю): доска остаётся сзади
      const e = ss(k);
      f.board.set(0, 0, UNDER_Z + (BEHIND_Z - UNDER_Z) * e);
      f.standOn = D * (1 - ss(k * 1.7));
      f.lift = Math.sin(k * Math.PI) * 0.07;
      f.feetW = 1 - ss(k * 2.2);
      f.crouch = 0.3 + 0.25 * Math.sin(k * Math.PI);
      f.arms = 0.5 * (1 - e);
      break;
    }
    case 'kickup': {
      // стопа на хвост → доска встаёт (нос вверх) и подлетает в правую лапу
      f.board.set(0, 0, BEHIND_Z);
      f.kick = Math.sin(Math.min(1, k / 0.55) * Math.PI);
      const pop = ss((k - 0.25) / 0.45);
      f.pitch = (Math.PI / 2) * pop;
      f.board.y = 0.14 * Math.sin(Math.min(1, Math.max(0, (k - 0.25) / 0.5)) * Math.PI) * (1 - ss((k - 0.7) / 0.3));
      f.carry = ss((k - 0.6) / 0.25);
      f.hand.copy(HAND_SIDE).add(new THREE.Vector3(0.03, -0.06, -0.08 * (1 - f.carry)));
      f.lookDown = 0.8 * (1 - f.carry);
      f.crouch = 0.25 * Math.sin(Math.min(1, k / 0.5) * Math.PI);
      break;
    }
    case 'vanish':
      f.carry = 1;
      f.hand.copy(HAND_SIDE).add(new THREE.Vector3(0.03, -0.06, 0));
      f.spin = Math.PI * 3 * ss(k);
      f.boardScale = 1 - ss(k * 1.15);
      f.spark = k;
      f.board.set(0, 0, BEHIND_Z);
      break;
    case 'done':
      f.board.set(0, 0, 0);
      f.boardScale = 0;
  }
  return f;
}

let gripTex: THREE.Texture | null = null;
let artTex: THREE.Texture | null = null;
/** текстуры: грип-тейп (тёмное зерно с лаймовой окантовкой) и графика низа (полосы и звезда в цветах Хулигана) */
function textures(): { grip: THREE.Texture | null; art: THREE.Texture | null } {
  if (typeof document === 'undefined') return { grip: null, art: null };
  if (!gripTex) {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 192;
    const g = c.getContext('2d');
    if (g) {
      g.fillStyle = '#1c1e21';
      g.fillRect(0, 0, 64, 192);
      let seed = 7;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      for (let i = 0; i < 1400; i++) {
        const v = 30 + Math.floor(rnd() * 40);
        g.fillStyle = `rgb(${v},${v},${v + 4})`;
        g.fillRect(rnd() * 64, rnd() * 192, 1, 1);
      }
      g.strokeStyle = '#B5E36A';
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(10, 40);
      g.lineTo(54, 40);
      g.moveTo(10, 152);
      g.lineTo(54, 152);
      g.stroke();
    }
    gripTex = new THREE.CanvasTexture(c);
    gripTex.colorSpace = THREE.SRGBColorSpace;
  }
  if (!artTex) {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 192;
    const g = c.getContext('2d');
    if (g) {
      g.fillStyle = '#B5E36A';
      g.fillRect(0, 0, 64, 192);
      g.fillStyle = '#21A038';
      for (let y = -64; y < 192; y += 28) {
        g.beginPath();
        g.moveTo(0, y);
        g.lineTo(64, y + 40);
        g.lineTo(64, y + 52);
        g.lineTo(0, y + 12);
        g.fill();
      }
      g.fillStyle = '#16181b';
      g.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2 - Math.PI / 2, r = i % 2 ? 9 : 20;
        g.lineTo(32 + Math.cos(a) * r, 96 + Math.sin(a) * r);
      }
      g.fill();
    }
    artTex = new THREE.CanvasTexture(c);
    artTex.colorSpace = THREE.SRGBColorSpace;
  }
  return { grip: gripTex, art: artTex };
}

/**
 * Процедурная доска: низ колёс — y = 0, верх деки — BOARD.deck, вдоль +Z (нос — +Z). Дека — профиль «поппин»
 * с загнутыми носом и хвостом (изгиб по Z), сверху грип-тейп, снизу графика; подвески (база + ось) и 4 колеса.
 */
export function makeSkateboard(): THREE.Object3D {
  const g = new THREE.Group();
  g.name = 'skateboard';
  const { len, wid, deck, thick, wheelR } = BOARD;
  const tx = textures();
  // дека: сетка-лента по длине со скруглёнными концами и подъёмом носа/хвоста
  const nz = 28, nx = 8;
  const top: number[] = [], uv: number[] = [], idx: number[] = [];
  const kick = 0.2; // доля длины на загиб
  const prof = (z: number) => {
    const u = Math.abs(z) / (len / 2);
    return u > 1 - kick ? Math.pow((u - (1 - kick)) / kick, 2) * len * 0.07 : 0;
  };
  const halfW = (z: number) => {
    const u = Math.abs(z) / (len / 2);
    const r = wid / 2;
    const zc = len / 2 - r;
    return Math.abs(z) <= zc ? r : Math.sqrt(Math.max(0, r * r - Math.pow(Math.abs(z) - zc, 2))) * 0.98 + 0.002 * (1 - u);
  };
  for (let j = 0; j <= nz; j++) {
    const z = -len / 2 + (len * j) / nz;
    const hw = Math.max(0.004, halfW(z));
    for (let i = 0; i <= nx; i++) {
      const x = -hw + (2 * hw * i) / nx;
      top.push(x, prof(z), z);
      uv.push(i / nx, j / nz);
    }
  }
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  const mk = (dy: number, flip: boolean, map: THREE.Texture | null, color: string) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(top.map((v, i) => (i % 3 === 1 ? v + dy : v)), 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(flip ? idx.slice().reverse() : idx);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: map ? '#ffffff' : color, map, roughness: 0.75, side: THREE.FrontSide }));
    m.position.y = deck;
    return m;
  };
  g.add(mk(0, false, tx.grip, '#1c1e21'));
  g.add(mk(-thick, true, tx.art, '#B5E36A'));
  // кромка деки: «ламинат» — светлая полоса по периметру
  const edgeM = new THREE.MeshStandardMaterial({ color: '#f1e7cf', roughness: 0.6, side: THREE.DoubleSide });
  const edge: number[] = [], eIdx: number[] = [];
  const ring: [number, number, number][] = [];
  for (let j = 0; j <= nz; j++) ring.push([Math.max(0.004, halfW(-len / 2 + (len * j) / nz)), 0, -len / 2 + (len * j) / nz]);
  for (let j = nz; j >= 0; j--) ring.push([-Math.max(0.004, halfW(-len / 2 + (len * j) / nz)), 0, -len / 2 + (len * j) / nz]);
  ring.forEach(([x, , z]) => edge.push(x, prof(z), z, x, prof(z) - thick, z));
  for (let i = 0; i < ring.length - 1; i++) eIdx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 2, i * 2 + 1, i * 2 + 3);
  const eg = new THREE.BufferGeometry();
  eg.setAttribute('position', new THREE.Float32BufferAttribute(edge, 3));
  eg.setIndex(eIdx);
  eg.computeVertexNormals();
  const em = new THREE.Mesh(eg, edgeM);
  em.position.y = deck;
  g.add(em);
  // подвески и колёса
  const metal = new THREE.MeshStandardMaterial({ color: '#c9ced6', roughness: 0.3, metalness: 0.7 });
  const wheelM = new THREE.MeshStandardMaterial({ color: '#f5f2e8', roughness: 0.45 });
  const core = new THREE.MeshStandardMaterial({ color: '#21A038', roughness: 0.4 });
  const tz = len * 0.31;
  for (const s of [-1, 1]) {
    const base = new THREE.Mesh(new THREE.BoxGeometry(wid * 0.42, thick * 0.6, len * 0.09), metal);
    base.position.set(0, deck - thick - thick * 0.3, s * tz);
    g.add(base);
    const hanger = new THREE.Mesh(new THREE.CylinderGeometry(wheelR * 0.45, wheelR * 0.55, deck - thick - wheelR * 1.2, 8), metal);
    hanger.position.set(0, wheelR + (deck - thick - wheelR) / 2, s * tz);
    g.add(hanger);
    const axle = new THREE.Mesh(new THREE.CylinderGeometry(wheelR * 0.18, wheelR * 0.18, wid * 1.02, 8), metal);
    axle.rotation.z = Math.PI / 2;
    axle.position.set(0, wheelR, s * tz);
    g.add(axle);
    for (const x of [-1, 1]) {
      // колесо — узел «wheel» на оси (крутится вокруг X: GlbCharacter по пройденному пути), с метками на ядре
      const hub = new THREE.Group();
      hub.name = 'wheel';
      hub.position.set(x * wid * 0.47, wheelR, s * tz);
      g.add(hub);
      const w = new THREE.Mesh(new THREE.CylinderGeometry(wheelR, wheelR, wid * 0.17, 16), wheelM);
      w.rotation.z = Math.PI / 2;
      hub.add(w);
      const c = new THREE.Mesh(new THREE.CylinderGeometry(wheelR * 0.45, wheelR * 0.45, wid * 0.175, 10), core);
      c.rotation.z = Math.PI / 2;
      hub.add(c);
      const mark = new THREE.Mesh(new THREE.BoxGeometry(wid * 0.18, wheelR * 0.22, wheelR * 0.9), metal);
      mark.position.set(0, wheelR * 0.55, 0);
      hub.add(mark);
    }
  }
  return g;
}
