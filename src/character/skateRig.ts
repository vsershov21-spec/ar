/**
 * «Скейт» Хулигана (запись 20.11: кнопка была, анимации не было; «скейт не стильный и вылетает из кота»).
 * Короткий уличный номер, доска всё время жёстко в системе кота (никаких отлётов и телепортов):
 *   grab     — доска появляется в правой лапе у бока (хват: IK лапы + кулак на деке);
 *   drop     — кот ставит её перед собой (лапа опускает, присед), отпускает на колёса;
 *   mount    — встаёт: прыжок на деку, стопы — IK на деку (передняя/задняя), доска не двигается;
 *   push     — толчок: задняя лапа сходит с деки, отталкивается от опоры позади, возвращается на деку;
 *   ride     — проезд дугой (режиссёр ведёт кота по карте: stage.walkTo), колени согнуты, лапы в стороны, крен;
 *   ollie    — небольшой олли: присед, хлопок хвостом доски (нос вверх), кот и доска вместе в воздухе, ровная посадка;
 *   roll     — докат;
 *   dismount — мягкий соскок вперёд-вбок, доска остаётся под тем местом и откатывается на 2–3 см;
 *   stow     — доска уменьшается и пропадает.
 * Размер доски — от лап кота (setSkateFit): длина ≈ от пятки задней лапы до носка передней + запас.
 * Доска процедурная (makeSkateboard): дека с загнутыми носом и хвостом, грип-тейп с зерном, графика на низе,
 * подвески и колёса — модели Tripo нет (t2m_prompts_v2.json: «skateboard: нужна»).
 * Чистое расписание skatePose — tests/skateRig.test.ts; кости двигает GlbCharacter (skatePre/applySkate).
 */
import * as THREE from 'three';

import { RIDE_FROM, RIDE_TO, SKATE_ORDER as ORDER, SKATE_T, SKATE_TOTAL, type SkatePhase } from './skateTiming';
export { RIDE_FROM, RIDE_TO, SKATE_T, SKATE_TOTAL, type SkatePhase };

/** доска в ростах кота: длина, ширина, высота верха деки над опорой, толщина, радиус колеса */
export const BOARD = { len: 0.36, wid: 0.12, deck: 0.062, thick: 0.012, wheelR: 0.018 };
/** стопы на деке (система кота: x поперёк, z вдоль доски; передняя — левая) */
export const FEET_ON_DECK = { L: new THREE.Vector3(0.035, BOARD.deck, 0.075), R: new THREE.Vector3(-0.035, BOARD.deck, -0.075) };

/**
 * Подогнать доску под лапы: footLen — длина стопы (пятка → носок), stance — расстояние между стопами вдоль доски.
 * Длина деки = stance + стопа + запас 35 %, ширина — 0,36 длины, колёса и высота — пропорционально.
 */
export function setSkateFit(footLen: number, stance = 0.15) {
  if (!(footLen > 0.02 && footLen < 0.3)) return;
  const len = THREE.MathUtils.clamp((stance + footLen) * 1.35, 0.26, 0.5);
  BOARD.len = len;
  BOARD.wid = len * 0.34;
  BOARD.wheelR = len * 0.05;
  BOARD.thick = len * 0.034;
  BOARD.deck = BOARD.wheelR * 2 + len * 0.055 + BOARD.thick;
  const half = Math.min(stance / 2, len * 0.28);
  FEET_ON_DECK.L.set(BOARD.wid * 0.28, BOARD.deck, half);
  FEET_ON_DECK.R.set(-BOARD.wid * 0.28, BOARD.deck, -half);
}

export interface SkateFrame {
  phase: SkatePhase;
  k: number;
  /** доска: положение в системе кота, наклон носа (рад, + — нос вверх), масштаб 0…1 */
  board: THREE.Vector3;
  pitch: number;
  boardScale: number;
  /** доска в правой лапе (0…1): 1 — держит у бока, доска едет за кистью */
  carry: number;
  /** куда тянется правая лапа с доской (система кота) */
  hand: THREE.Vector3;
  /** подъём тела: опора (дека) + дуга прыжка; присед 0…1 */
  standOn: number;
  lift: number;
  crouch: number;
  /** вес IK стоп на деке; задняя лапа в толчке: 0…1 — на опоре позади */
  feetW: number;
  push: number;
  /** лапы в стороны 0…1, смотреть на доску 0…1 */
  arms: number;
  lookDown: number;
}

const ss = (x: number) => {
  const k = Math.max(0, Math.min(1, x));
  return k * k * (3 - 2 * k);
};

export function newSkateFrame(): SkateFrame {
  return { phase: 'done', k: 1, board: new THREE.Vector3(), pitch: 0, boardScale: 0, carry: 0, hand: new THREE.Vector3(), standOn: 0, lift: 0, crouch: 0, feetW: 0, push: 0, arms: 0, lookDown: 0 };
}

/** доска на опоре перед лапами (куда её ставят) */
const FRONT_Z = 0.26;

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
  f.pitch = 0;
  f.carry = 0;
  f.lift = 0;
  f.standOn = 0;
  f.feetW = 0;
  f.push = 0;
  f.crouch = 0;
  f.arms = 0;
  f.lookDown = 0;
  f.boardScale = 1;
  const D = BOARD.deck;
  switch (ph) {
    case 'grab':
      // доска «из-за спины» в правой лапе у бока
      f.carry = 1;
      f.hand.set(-0.2, 0.3, 0.06 + 0.04 * ss(k));
      f.boardScale = ss(k / 0.9);
      f.lookDown = 0.3 * ss(k);
      break;
    case 'drop': {
      // опускает перед собой: лапа вниз-вперёд, присед; в конце — доска на колёсах, лапа отпускает
      const e = ss(k / 0.8);
      f.carry = 1 - ss((k - 0.75) / 0.25);
      f.hand.set(-0.2 + 0.14 * e, 0.3 - 0.2 * e, 0.1 + (FRONT_Z - 0.1) * e);
      f.crouch = 0.55 * Math.sin(Math.min(1, k) * Math.PI);
      f.board.set(0, 0, FRONT_Z);
      f.lookDown = 1;
      break;
    }
    case 'mount': {
      // шаг-прыжок на деку: доска на месте (в системе кота подъезжает под лапы — кот шагнул вперёд)
      const e = ss(k);
      f.board.set(0, 0, FRONT_Z * (1 - e));
      f.standOn = D * ss(k * 1.5 - 0.3);
      f.lift = Math.sin(k * Math.PI) * 0.08;
      f.feetW = ss(k * 1.8 - 0.6);
      f.crouch = 0.3;
      f.arms = 0.6 * e;
      f.lookDown = 1 - 0.5 * e;
      break;
    }
    case 'push':
      // задняя лапа: деку → опора позади-сбоку → деку
      f.standOn = D;
      f.feetW = 1;
      f.push = Math.sin(k * Math.PI);
      f.crouch = 0.4 + 0.15 * Math.sin(k * Math.PI);
      f.arms = 0.6;
      f.lookDown = 0.3;
      break;
    case 'ride':
      f.standOn = D;
      f.feetW = 1;
      f.crouch = 0.35 + 0.05 * Math.sin(k * Math.PI * 4);
      f.arms = 0.75 + 0.12 * Math.sin(k * Math.PI * 3);
      break;
    case 'ollie': {
      // присед → хлопок хвостом (нос вверх) → в воздухе вместе → ровно на колёса
      const air = k < 0.3 ? 0 : Math.sin(((k - 0.3) / 0.7) * Math.PI);
      f.standOn = D;
      f.feetW = 1;
      f.crouch = k < 0.3 ? 0.35 + 0.35 * ss(k / 0.3) : 0.7 * (1 - ss((k - 0.3) / 0.25)) + 0.3 * ss((k - 0.75) / 0.25);
      f.lift = air * 0.1;
      f.board.y = air * 0.1;
      f.pitch = k < 0.3 ? 0 : 0.42 * Math.sin(((k - 0.3) / 0.7) * Math.PI) * (1 - ss((k - 0.55) / 0.45)) + (k < 0.45 ? 0.15 * ss((k - 0.3) / 0.15) : 0);
      f.arms = 0.9;
      break;
    }
    case 'roll':
      f.standOn = D;
      f.feetW = 1;
      f.crouch = 0.3 * (1 - ss(k)) + 0.2;
      f.arms = 0.7 * (1 - 0.4 * k);
      break;
    case 'dismount': {
      // мягкий соскок вперёд-вбок: доска остаётся за лапами и чуть откатывается
      const e = ss(k);
      f.board.set(-0.2 * e, 0, -0.12 * e);
      f.standOn = D * (1 - ss(k * 1.6));
      f.lift = Math.sin(k * Math.PI) * 0.06;
      f.feetW = 1 - ss(k * 2.2);
      f.crouch = 0.25 + 0.2 * Math.sin(k * Math.PI);
      f.arms = 0.45 * (1 - e);
      break;
    }
    case 'stow':
      f.board.set(-0.2, 0, -0.12);
      f.boardScale = 1 - ss(k);
      f.lookDown = 0.4 * (1 - k);
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
      const w = new THREE.Mesh(new THREE.CylinderGeometry(wheelR, wheelR, wid * 0.17, 16), wheelM);
      w.rotation.z = Math.PI / 2;
      w.position.set(x * wid * 0.47, wheelR, s * tz);
      g.add(w);
      const c = new THREE.Mesh(new THREE.CylinderGeometry(wheelR * 0.45, wheelR * 0.45, wid * 0.175, 10), core);
      c.rotation.z = Math.PI / 2;
      c.position.copy(w.position);
      g.add(c);
    }
  }
  return g;
}
