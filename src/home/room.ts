/**
 * Комната-хаб «Мир кота»: низкополигональная процедурная геометрия в three.js, светлая, мягкие формы, фирменные
 * зелёный / бирюзовый / лаймовый акценты Сбера, тёплый свет. Освещение «запечено» в цвета вершин (рассеянный свет
 * от окна и ламп, AO-градиенты у пола, углов и под предметами) — без источников света и теней в реальном времени:
 * вся комната — один MeshBasicMaterial (несколько draw call на всю сцену).
 *
 * Координаты: пол y = 0, задняя стена z = BACK_Z, зрителю — +Z. Рост кота ≈ 1,1 (Stage.cfg.height, 1 ед. = ширина
 * карты — якорь пола без масштаба). Зоны (zones.ts) — участки одной длинной комнаты по X: кухня, гостиная, спальня.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ZONES, type ZoneId } from './zones';

export const BACK_Z = -1.8;
const ROOM_W = 12.4;
const ROOM_H = 3.4;
const FRONT_Z = 4.5;

/** палитра: светлая, тёплая, акценты Сбера */
export const PAL = {
  green: '#21A038',
  teal: '#14B8A6',
  mint: '#9BE3CF',
  lime: '#B8E34A',
  limeSoft: '#E4F5B5',
  cream: '#FFF5E6',
  creamDeep: '#F8E6CC',
  wallKitchen: '#E3F5EE',
  wallLiving: '#FFF3E2',
  wallBed: '#E6EEFA',
  floor: '#EFCFA3',
  floorDark: '#DDB582',
  white: '#FFFFFF',
  coral: '#FF9C7A',
  sun: '#FFD36B',
  sky: '#BFE6FF',
  wood: '#D9A86C',
  plum: '#B9A4F0',
};

/** «солнце» из окна и тёплые лампы: запекаются в цвета вершин */
const SUN_DIR = new THREE.Vector3(0.35, 0.8, 0.55).normalize();
const LAMPS: { p: THREE.Vector3; r: number; k: number }[] = [
  { p: new THREE.Vector3(-0.85, 1.6, -1.1), r: 1.6, k: 0.22 },
  { p: new THREE.Vector3(-3.6, 2.4, -0.6), r: 1.8, k: 0.2 },
  { p: new THREE.Vector3(4.35, 0.9, -1.2), r: 1.3, k: 0.24 },
];
const WARM = new THREE.Color('#FFE2B8');

export interface BakeOpts {
  /** насколько предмет «прижат» к полу (AO у пола) */
  ao?: number;
  /** самосвечение (абажур, окно): свет не запекается */
  emissive?: boolean;
  /** лёгкий вертикальный градиент: низ темнее на столько */
  grad?: number;
}

const tmpN = new THREE.Vector3();
const tmpP = new THREE.Vector3();
const tmpC = new THREE.Color();

/**
 * Запечь освещение в цвета вершин: ambient + рассеянный от «солнца», небо сверху, тёплые пятна ламп,
 * AO у пола (y → 0) и у задней стены, затемнение к углам комнаты.
 */
export function bake(geo: THREE.BufferGeometry, color: THREE.ColorRepresentation, o: BakeOpts = {}): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute('uv');
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nor = g.getAttribute('normal') as THREE.BufferAttribute;
  const base = new THREE.Color(color);
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    tmpP.fromBufferAttribute(pos, i);
    tmpN.fromBufferAttribute(nor, i);
    tmpC.copy(base);
    if (!o.emissive) {
      const diff = Math.max(0, tmpN.dot(SUN_DIR));
      const sky = tmpN.y * 0.5 + 0.5;
      let l = 0.66 + 0.26 * diff + 0.1 * sky;
      // AO: у пола, у задней стены, к углам потолка и к краям комнаты
      const y = Math.max(0, tmpP.y);
      l *= 1 - (o.ao ?? 0.22) * Math.exp(-y / 0.18);
      l *= 1 - 0.16 * Math.exp(-(tmpP.z - BACK_Z) / 0.35);
      l *= 1 - 0.12 * Math.exp(-(ROOM_H - y) / 0.4);
      l *= 1 - 0.1 * Math.min(1, Math.max(0, (Math.abs(tmpP.x) - 4.6) / 1.6));
      if (o.grad) l *= 1 - o.grad * (1 - Math.min(1, y / 2.4));
      tmpC.multiplyScalar(l);
      // тёплые пятна ламп
      for (const lamp of LAMPS) {
        const d2 = tmpP.distanceToSquared(lamp.p) / (lamp.r * lamp.r);
        if (d2 < 4) tmpC.lerp(WARM, lamp.k * Math.exp(-d2 * 1.4));
      }
    }
    col[i * 3] = Math.min(1, tmpC.r);
    col[i * 3 + 1] = Math.min(1, tmpC.g);
    col[i * 3 + 2] = Math.min(1, tmpC.b);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** собиратель: геометрии с запечёнными цветами → одна сетка */
class Batch {
  readonly parts: THREE.BufferGeometry[] = [];
  add(geo: THREE.BufferGeometry, color: THREE.ColorRepresentation, at: { p?: [number, number, number]; r?: [number, number, number]; s?: [number, number, number] } = {}, o?: BakeOpts) {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(...(at.p ?? [0, 0, 0])),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...(at.r ?? [0, 0, 0]))),
      new THREE.Vector3(...(at.s ?? [1, 1, 1])),
    );
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    geo.dispose();
    g.applyMatrix4(m);
    this.parts.push(bake(g, color, o));
  }
  mesh(mat: THREE.Material, name: string): THREE.Mesh {
    const g = mergeGeometries(this.parts, false)!;
    for (const p of this.parts) p.dispose();
    this.parts.length = 0;
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat);
    m.name = name;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    return m;
  }
}

const rbox = (w: number, h: number, d: number, r = 0.06, seg = 2) => new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3));
const cyl = (rt: number, rb: number, h: number, seg = 14) => new THREE.CylinderGeometry(rt, rb, h, seg, 1);
const ball = (r: number, detail = 1) => new THREE.IcosahedronGeometry(r, detail);
const torus = (r: number, t: number, rs = 8, ts = 18) => new THREE.TorusGeometry(r, t, rs, ts);

/** мягкое пятно-тень (прозрачная плоскость с радиальным градиентом) */
function blobTexture(): THREE.Texture {
  const c = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  if (!c) return new THREE.Texture();
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (!g) return new THREE.Texture();
  const grd = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  grd.addColorStop(0, 'rgba(90,60,30,0.5)');
  grd.addColorStop(0.55, 'rgba(90,60,30,0.2)');
  grd.addColorStop(1, 'rgba(90,60,30,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
function glowTexture(): THREE.Texture {
  const c = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  if (!c) return new THREE.Texture();
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (!g) return new THREE.Texture();
  const grd = g.createRadialGradient(32, 32, 1, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,236,190,0.95)');
  grd.addColorStop(0.35, 'rgba(255,214,140,0.45)');
  grd.addColorStop(1, 'rgba(255,200,120,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export interface Room {
  readonly group: THREE.Group;
  /** якорь пола зоны: «плоскость карты» для Stage (XY → пол, +Z → вверх) */
  readonly anchor: THREE.Group;
  /** 0 — ночь (приглушено), 1 — день */
  setLight(k: number): void;
  /** текущий свет (плавно идёт к заданному) */
  readonly light: number;
  /** миска с рыбкой у лап кота (кухня, «Угостить») */
  showBowl(on: boolean): void;
  /** мячик на коврике прыгает (гостиная) */
  bounceBall(): void;
  /** ставит якорь кота в точку зоны (x — центр зоны, y — пол) */
  placeAnchor(x: number, y: number, yaw?: number): void;
  update(dt: number): void;
  dispose(): void;
}

/** точка, где стоит кот в зоне (по Z — чуть ближе к зрителю, чем центр коврика) */
export const CAT_Z = 0.2;

export function buildRoom(): Room {
  const group = new THREE.Group();
  group.name = 'home-room';
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
  mat.name = 'home-baked';
  const skyMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  const blobMat = new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false });
  const glowMat = new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.55 });
  const b = new Batch();
  const sky = new Batch();

  // ───────── пол, стены, потолок ─────────
  const floor = new THREE.PlaneGeometry(ROOM_W, FRONT_Z - BACK_Z, 62, 16);
  floor.rotateX(-Math.PI / 2);
  floor.translate(0, 0, (FRONT_Z + BACK_Z) / 2);
  b.add(floor, PAL.floor, {}, { ao: 0 });
  // доски: полосы чуть темнее (тонкие плашки над полом)
  for (let x = -6; x <= 6; x += 0.62) b.add(new THREE.PlaneGeometry(0.018, FRONT_Z - BACK_Z).rotateX(-Math.PI / 2), PAL.floorDark, { p: [x, 0.001, (FRONT_Z + BACK_Z) / 2] }, { ao: 0 });
  const wallSeg = (x0: number, x1: number, color: string) => {
    const w = new THREE.PlaneGeometry(x1 - x0, ROOM_H, Math.max(2, Math.round((x1 - x0) * 3)), 10);
    b.add(w, color, { p: [(x0 + x1) / 2, ROOM_H / 2, BACK_Z] }, { grad: 0.05 });
  };
  wallSeg(-6.2, -1.75, PAL.wallKitchen);
  wallSeg(-1.75, 1.75, PAL.wallLiving);
  wallSeg(1.75, 6.2, PAL.wallBed);
  // нижняя часть стены — панель (как в детской): лайм / мята / лаванда
  b.add(rbox(4.45, 0.9, 0.04, 0.02), PAL.mint, { p: [-3.975, 0.45, BACK_Z + 0.02] });
  b.add(rbox(3.5, 0.9, 0.04, 0.02), PAL.limeSoft, { p: [0, 0.45, BACK_Z + 0.02] });
  b.add(rbox(4.45, 0.9, 0.04, 0.02), '#CFDDF5', { p: [3.975, 0.45, BACK_Z + 0.02] });
  b.add(rbox(ROOM_W, 0.05, 0.06, 0.02), PAL.white, { p: [0, 0.92, BACK_Z + 0.04] });
  b.add(rbox(ROOM_W, 0.1, 0.05, 0.02), PAL.white, { p: [0, 0.05, BACK_Z + 0.03] });
  // пилястры-арки между зонами
  for (const x of [-1.75, 1.75]) {
    b.add(rbox(0.26, ROOM_H, 0.34, 0.08), PAL.white, { p: [x, ROOM_H / 2, BACK_Z + 0.12] });
    b.add(rbox(0.3, 0.12, 0.38, 0.05), PAL.creamDeep, { p: [x, 0.06, BACK_Z + 0.14] });
  }
  // боковые стены и потолок (видны в альбомной)
  for (const s of [-1, 1]) {
    const w = new THREE.PlaneGeometry(FRONT_Z - BACK_Z, ROOM_H, 8, 6);
    w.rotateY((-s * Math.PI) / 2);
    b.add(w, s < 0 ? PAL.wallKitchen : PAL.wallBed, { p: [s * ROOM_W / 2, ROOM_H / 2, (FRONT_Z + BACK_Z) / 2] });
  }
  const ceil = new THREE.PlaneGeometry(ROOM_W, FRONT_Z - BACK_Z, 6, 4);
  ceil.rotateX(Math.PI / 2);
  b.add(ceil, PAL.cream, { p: [0, ROOM_H, (FRONT_Z + BACK_Z) / 2] });

  // окно (небо — отдельный материал: ночью темнеет иначе, чем стены)
  const windowAt = (x: number, y: number, w: number, h: number, frame: string) => {
    const s = new THREE.PlaneGeometry(w, h, 1, 6);
    // градиент неба: снизу светлее
    sky.add(s, PAL.sky, { p: [x, y, BACK_Z + 0.015] }, { emissive: true });
    const skyG = sky.parts[sky.parts.length - 1];
    const sp = skyG.getAttribute('position') as THREE.BufferAttribute, sc = skyG.getAttribute('color') as THREE.BufferAttribute;
    const top = new THREE.Color('#8FD3FF'), bot = new THREE.Color('#E8F7FF');
    for (let i = 0; i < sp.count; i++) {
      const k = (sp.getY(i) - (y - h / 2)) / h;
      tmpC.copy(bot).lerp(top, k);
      sc.setXYZ(i, tmpC.r, tmpC.g, tmpC.b);
    }
    // облака
    for (const [cx, cy, r] of [[-0.22, 0.12, 0.13], [-0.08, 0.15, 0.16], [0.08, 0.12, 0.12], [0.3, -0.18, 0.09], [0.42, -0.16, 0.11]] as const)
      sky.add(new THREE.CircleGeometry(r, 12), '#FFFFFF', { p: [x + cx * w, y + cy * h, BACK_Z + 0.02], s: [1.4, 1, 1] }, { emissive: true });
    // рама и подоконник
    const t = 0.07;
    b.add(rbox(w + t * 2, t, 0.1, 0.03), frame, { p: [x, y + h / 2 + t / 2, BACK_Z + 0.05] });
    b.add(rbox(w + t * 2, t, 0.1, 0.03), frame, { p: [x, y - h / 2 - t / 2, BACK_Z + 0.05] });
    b.add(rbox(t, h, 0.1, 0.03), frame, { p: [x - w / 2 - t / 2, y, BACK_Z + 0.05] });
    b.add(rbox(t, h, 0.1, 0.03), frame, { p: [x + w / 2 + t / 2, y, BACK_Z + 0.05] });
    b.add(rbox(0.035, h, 0.06, 0.015), frame, { p: [x, y, BACK_Z + 0.05] });
    b.add(rbox(w + 0.3, 0.06, 0.24, 0.03), PAL.white, { p: [x, y - h / 2 - 0.08, BACK_Z + 0.12] });
  };

  // ───────── ГОСТИНАЯ (x ≈ 0): окно, коврик, кресло-мешок, торшер, полка, растение, игрушки ─────────
  windowAt(0.12, 1.95, 1.05, 0.95, PAL.white);
  // занавески-волны (бирюза)
  for (const s of [-1, 1]) for (let k = 0; k < 3; k++) b.add(cyl(0.05, 0.07, 1.25, 8), PAL.teal, { p: [0.12 + s * (0.66 + k * 0.07), 1.85, BACK_Z + 0.16] });
  b.add(cyl(0.02, 0.02, 1.7, 6), PAL.white, { p: [0.12, 2.52, BACK_Z + 0.16], r: [0, 0, Math.PI / 2] });
  // круглый коврик: зелёный с лаймовым кантом
  b.add(cyl(0.95, 0.95, 0.02, 28), PAL.green, { p: [0, 0.01, CAT_Z - 0.15], s: [1, 1, 0.62] }, { ao: 0 });
  b.add(cyl(0.78, 0.78, 0.022, 28), PAL.lime, { p: [0, 0.012, CAT_Z - 0.15], s: [1, 1, 0.62] }, { ao: 0 });
  b.add(cyl(0.6, 0.6, 0.024, 28), '#5BC46A', { p: [0, 0.014, CAT_Z - 0.15], s: [1, 1, 0.62] }, { ao: 0 });
  // кресло-мешок справа
  b.add(ball(0.5, 2), PAL.coral, { p: [0.95, 0.32, -0.95], s: [1.05, 0.66, 0.95] });
  b.add(ball(0.34, 2), '#FFB79C', { p: [0.95, 0.62, -1.15], s: [1.1, 0.7, 0.6] });
  // подушка-пуфик слева
  b.add(cyl(0.26, 0.28, 0.24, 16), PAL.teal, { p: [-0.85, 0.12, -0.25] });
  b.add(torus(0.24, 0.05, 6, 16), '#5FD3C3', { p: [-0.85, 0.24, -0.25], r: [Math.PI / 2, 0, 0] });
  // торшер
  b.add(cyl(0.16, 0.18, 0.04, 14), PAL.white, { p: [-0.85, 0.02, -1.15] });
  b.add(cyl(0.02, 0.02, 1.4, 6), PAL.white, { p: [-0.85, 0.72, -1.15] });
  b.add(cyl(0.16, 0.26, 0.3, 14), PAL.sun, { p: [-0.85, 1.55, -1.15] }, { emissive: true });
  // полка с книжками и кубиками
  b.add(rbox(0.8, 0.05, 0.22, 0.02), PAL.wood, { p: [-0.95, 1.4, BACK_Z + 0.11] });
  const books = [PAL.green, PAL.lime, PAL.teal, PAL.coral, PAL.plum];
  books.forEach((c, k) => b.add(rbox(0.07, 0.2 + (k % 2) * 0.05, 0.16, 0.015), c, { p: [-1.25 + k * 0.085, 1.53 + (k % 2) * 0.025, BACK_Z + 0.11] }));
  b.add(ball(0.08, 1), PAL.lime, { p: [-0.7, 1.5, BACK_Z + 0.12] });
  // растение в горшке
  b.add(cyl(0.16, 0.12, 0.3, 12), PAL.white, { p: [1.42, 0.15, -1.3] });
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2;
    b.add(ball(0.14, 0), k % 2 ? PAL.green : '#43B85A', { p: [1.42 + Math.cos(a) * 0.12, 0.48 + (k % 3) * 0.12, -1.3 + Math.sin(a) * 0.1], s: [0.7, 1.4, 0.5], r: [0.3 * Math.sin(a), a, 0.35 * Math.cos(a)] });
  }
  // игрушки на коврике: кубики
  b.add(rbox(0.16, 0.16, 0.16, 0.03), PAL.sun, { p: [0.55, 0.08, 0.75], r: [0, 0.4, 0] });
  b.add(rbox(0.14, 0.14, 0.14, 0.03), PAL.teal, { p: [0.62, 0.23, 0.72], r: [0, -0.3, 0] });
  b.add(rbox(0.15, 0.15, 0.15, 0.03), PAL.plum, { p: [0.36, 0.075, 0.9], r: [0, 0.9, 0] });
  // картина-рамка (кот-силуэт: круг и уши)
  b.add(rbox(0.5, 0.42, 0.04, 0.03), PAL.white, { p: [1.15, 1.75, BACK_Z + 0.03] });
  b.add(rbox(0.42, 0.34, 0.02, 0.02), PAL.limeSoft, { p: [1.15, 1.75, BACK_Z + 0.055] });
  b.add(new THREE.CircleGeometry(0.1, 14), PAL.green, { p: [1.15, 1.72, BACK_Z + 0.07] }, { emissive: true });
  for (const s of [-1, 1]) b.add(new THREE.CircleGeometry(0.05, 3), PAL.green, { p: [1.15 + s * 0.065, 1.82, BACK_Z + 0.07], r: [0, 0, Math.PI / 2 + s * 0.3] }, { emissive: true });

  // ───────── КУХНЯ (x ≈ −3.6): шкафчики, столешница, чайник, подвесная лампа, столик с кружкой, окно ─────────
  const kx = -3.6;
  b.add(rbox(2.3, 0.82, 0.6, 0.05), PAL.mint, { p: [kx - 0.2, 0.43, BACK_Z + 0.32] });
  for (let k = 0; k < 4; k++) {
    b.add(rbox(0.52, 0.66, 0.03, 0.03), '#B6EBDB', { p: [kx - 1.06 + k * 0.575, 0.45, BACK_Z + 0.63] });
    b.add(rbox(0.16, 0.035, 0.035, 0.015), PAL.green, { p: [kx - 1.06 + k * 0.575, 0.7, BACK_Z + 0.66] });
  }
  b.add(rbox(2.4, 0.07, 0.66, 0.03), PAL.white, { p: [kx - 0.2, 0.87, BACK_Z + 0.33] });
  b.add(rbox(0.36, 0.06, 0.24, 0.02), '#4B4F58', { p: [kx - 0.85, 0.92, BACK_Z + 0.33] });
  // чайник
  b.add(ball(0.13, 1), PAL.coral, { p: [kx - 0.85, 1.05, BACK_Z + 0.33], s: [1, 0.85, 1] });
  b.add(cyl(0.02, 0.03, 0.12, 6), PAL.coral, { p: [kx - 0.71, 1.07, BACK_Z + 0.33], r: [0, 0, -0.9] });
  // банки на полке
  b.add(rbox(1.4, 0.05, 0.24, 0.02), PAL.wood, { p: [kx + 0.15, 1.62, BACK_Z + 0.12] });
  [[PAL.lime, 0.16], [PAL.sun, 0.13], [PAL.teal, 0.18], [PAL.coral, 0.12]].forEach(([c, h], k) => {
    b.add(cyl(0.065, 0.065, h as number, 10), c as string, { p: [kx - 0.35 + k * 0.28, 1.65 + (h as number) / 2, BACK_Z + 0.12] });
    b.add(cyl(0.07, 0.07, 0.03, 10), PAL.white, { p: [kx - 0.35 + k * 0.28, 1.66 + (h as number), BACK_Z + 0.12] });
  });
  // ваза с фруктами на столешнице
  b.add(cyl(0.17, 0.09, 0.08, 12), PAL.white, { p: [kx + 0.45, 0.95, BACK_Z + 0.35] });
  b.add(ball(0.06, 1), PAL.lime, { p: [kx + 0.4, 1.02, BACK_Z + 0.35] });
  b.add(ball(0.065, 1), PAL.coral, { p: [kx + 0.5, 1.03, BACK_Z + 0.33] });
  b.add(ball(0.055, 1), PAL.sun, { p: [kx + 0.46, 1.06, BACK_Z + 0.4] });
  // круглое окно над столешницей
  windowAt(kx - 0.2, 2.2, 0.75, 0.62, PAL.white);
  // подвесная лампа
  b.add(cyl(0.008, 0.008, 0.85, 4), '#6B6F78', { p: [kx, 2.98, -0.6] });
  b.add(new THREE.SphereGeometry(0.24, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2), PAL.teal, { p: [kx, 2.42, -0.6] });
  b.add(ball(0.08, 1), '#FFF3C4', { p: [kx, 2.42, -0.6] }, { emissive: true });
  // столик с кружкой (справа от кота)
  const tx = kx + 0.85, tz = -0.45;
  b.add(cyl(0.34, 0.34, 0.05, 20), PAL.white, { p: [tx, 0.62, tz] });
  b.add(cyl(0.035, 0.035, 0.6, 8), PAL.green, { p: [tx, 0.3, tz] });
  b.add(cyl(0.2, 0.22, 0.03, 16), PAL.green, { p: [tx, 0.015, tz] });
  b.add(cyl(0.065, 0.055, 0.12, 12), PAL.lime, { p: [tx - 0.1, 0.7, tz + 0.05] });
  b.add(torus(0.04, 0.012, 5, 10), PAL.lime, { p: [tx - 0.035, 0.7, tz + 0.05], r: [0, 0, 0] });
  b.add(cyl(0.055, 0.055, 0.005, 12), '#8A5A3C', { p: [tx - 0.1, 0.758, tz + 0.05] }, { emissive: true });
  // коврик кухни — полосатый
  b.add(rbox(1.4, 0.02, 0.7, 0.01), PAL.cream, { p: [kx, 0.01, CAT_Z - 0.05] }, { ao: 0 });
  for (let k = 0; k < 4; k++) b.add(rbox(0.16, 0.022, 0.7, 0.01), k % 2 ? PAL.teal : PAL.lime, { p: [kx - 0.5 + k * 0.33, 0.012, CAT_Z - 0.05] }, { ao: 0 });
  // холодильник у края
  b.add(rbox(0.8, 2.0, 0.7, 0.12), PAL.white, { p: [kx - 1.85, 1.0, BACK_Z + 0.4] });
  b.add(rbox(0.04, 0.4, 0.04, 0.02), PAL.green, { p: [kx - 1.55, 1.3, BACK_Z + 0.77] });
  b.add(new THREE.CircleGeometry(0.06, 10), PAL.coral, { p: [kx - 1.9, 1.5, BACK_Z + 0.76] }, { emissive: true });
  b.add(new THREE.CircleGeometry(0.05, 5), PAL.lime, { p: [kx - 1.75, 1.62, BACK_Z + 0.76] }, { emissive: true });

  // ───────── СПАЛЬНЯ (x ≈ 3.6): лежанка, тумбочка с ночником, гирлянда, картина с луной, плед, мишка ─────────
  const bx = 3.6;
  // лежанка-корзинка: на ней кот спит (floorY зоны)
  b.add(cyl(0.62, 0.6, 0.07, 26), PAL.plum, { p: [bx, 0.035, CAT_Z - 0.05], s: [1, 1, 0.72] }, { ao: 0.1 });
  b.add(torus(0.58, 0.11, 8, 26), '#CDBDF7', { p: [bx, 0.1, CAT_Z - 0.05], r: [Math.PI / 2, 0, 0], s: [1, 0.72, 1] });
  // подушка у изголовья
  b.add(ball(0.3, 2), PAL.white, { p: [bx + 0.05, 0.22, CAT_Z - 0.55], s: [1.3, 0.45, 0.6] });
  // ковёр-облако
  b.add(cyl(1.0, 1.0, 0.015, 26), '#F2F6FF', { p: [bx, 0.008, CAT_Z], s: [1.15, 1, 0.6] }, { ao: 0 });
  // тумбочка с ночником
  b.add(rbox(0.5, 0.55, 0.42, 0.06), PAL.white, { p: [bx + 1.0, 0.28, -1.15] });
  b.add(rbox(0.38, 0.03, 0.03, 0.01), PAL.teal, { p: [bx + 1.0, 0.4, -0.93] });
  b.add(ball(0.15, 2), PAL.sun, { p: [bx + 1.0, 0.72, -1.15], s: [1, 1.15, 1] }, { emissive: true });
  b.add(cyl(0.08, 0.1, 0.1, 10), PAL.teal, { p: [bx + 1.0, 0.6, -1.15] });
  // картина с луной и звёздами
  b.add(rbox(0.62, 0.5, 0.04, 0.03), PAL.white, { p: [bx - 0.55, 1.8, BACK_Z + 0.03] });
  b.add(rbox(0.54, 0.42, 0.02, 0.02), '#2E3A6E', { p: [bx - 0.55, 1.8, BACK_Z + 0.055] }, { emissive: true });
  b.add(new THREE.CircleGeometry(0.11, 16), '#FFE59A', { p: [bx - 0.62, 1.84, BACK_Z + 0.07] }, { emissive: true });
  b.add(new THREE.CircleGeometry(0.1, 16), '#2E3A6E', { p: [bx - 0.57, 1.87, BACK_Z + 0.075] }, { emissive: true });
  for (const [sx, sy] of [[0.14, 0.1], [0.05, -0.1], [0.18, -0.06], [-0.18, -0.12]] as const)
    b.add(new THREE.CircleGeometry(0.018, 5), '#FFFFFF', { p: [bx - 0.55 + sx, 1.8 + sy, BACK_Z + 0.07] }, { emissive: true });
  // окно спальни
  windowAt(bx + 0.6, 1.95, 0.8, 0.85, PAL.white);
  // гирлянда-провисание
  const garland: THREE.Vector3[] = [];
  for (let k = 0; k <= 12; k++) {
    const t = k / 12;
    garland.push(new THREE.Vector3(bx - 1.3 + t * 2.6, 2.65 - Math.sin(t * Math.PI) * 0.25, BACK_Z + 0.06));
  }
  garland.forEach((p, k) => b.add(ball(0.045, 1), [PAL.lime, PAL.teal, PAL.sun, PAL.coral][k % 4], { p: [p.x, p.y - 0.05, p.z] }, { emissive: true }));
  // мишка
  const tb = new THREE.Vector3(bx - 0.95, 0, -0.6);
  b.add(ball(0.2, 1), '#E8B98A', { p: [tb.x, 0.2, tb.z], s: [1, 1.1, 0.9] });
  b.add(ball(0.14, 1), '#E8B98A', { p: [tb.x, 0.5, tb.z] });
  for (const s of [-1, 1]) b.add(ball(0.055, 1), '#D9A472', { p: [tb.x + s * 0.11, 0.62, tb.z] });
  b.add(ball(0.06, 1), '#F6DCC0', { p: [tb.x, 0.47, tb.z + 0.12], s: [1, 0.8, 0.6] });
  b.add(torus(0.07, 0.02, 5, 12), PAL.teal, { p: [tb.x, 0.38, tb.z + 0.02], r: [Math.PI / 2, 0, 0] });

  const room = b.mesh(mat, 'home-baked');
  group.add(room);
  const skyMesh = sky.mesh(skyMat, 'home-sky');
  group.add(skyMesh);

  // ───────── пятна-тени под предметами (запечённые, прозрачные) ─────────
  const blobs = new THREE.Group();
  const blobGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const blob = (x: number, z: number, sx: number, sz: number, a = 1) => {
    const m = new THREE.Mesh(blobGeo, a === 1 ? blobMat : blobMat);
    m.position.set(x, 0.02, z);
    m.scale.set(sx, 1, sz);
    m.renderOrder = 1;
    blobs.add(m);
  };
  blob(0.95, -0.95, 1.5, 1.1);
  blob(-0.85, -0.25, 0.75, 0.6);
  blob(-0.85, -1.15, 0.5, 0.4);
  blob(1.42, -1.3, 0.5, 0.4);
  blob(0.55, 0.78, 0.55, 0.45);
  blob(kx + 0.85, tz, 0.8, 0.6);
  blob(kx - 0.2, BACK_Z + 0.7, 2.6, 0.5);
  blob(bx, CAT_Z - 0.05, 1.5, 1.1);
  blob(bx + 1.0, -1.15, 0.7, 0.55);
  blob(tb.x, tb.z, 0.55, 0.45);
  group.add(blobs);

  // ───────── свечение ламп (ночью ярче) ─────────
  const glows = new THREE.Group();
  const glowGeo = new THREE.PlaneGeometry(1, 1);
  const glow = (x: number, y: number, z: number, s: number) => {
    const m = new THREE.Mesh(glowGeo, glowMat);
    m.position.set(x, y, z);
    m.scale.setScalar(s);
    m.renderOrder = 2;
    glows.add(m);
  };
  glow(-0.85, 1.55, -1.05, 1.1);
  glow(kx, 2.38, -0.5, 1.2);
  glow(bx + 1.0, 0.72, -1.0, 0.75);
  for (const p of garland.filter((_, k) => k % 2 === 0)) glow(p.x, p.y - 0.05, p.z + 0.02, 0.28);
  group.add(glows);

  // ───────── миска (кухня) и мячик (гостиная) — живые предметы ─────────
  const bowl = new THREE.Group();
  bowl.name = 'home-bowl';
  {
    const bb = new Batch();
    bb.add(cyl(0.17, 0.12, 0.09, 16), PAL.teal, { p: [0, 0.045, 0] }, { ao: 0.1 });
    bb.add(torus(0.165, 0.02, 5, 16), '#5FD3C3', { p: [0, 0.09, 0], r: [Math.PI / 2, 0, 0] });
    bb.add(cyl(0.145, 0.145, 0.01, 16), '#FFF7E8', { p: [0, 0.085, 0] });
    // рыбка
    bb.add(ball(0.07, 1), PAL.coral, { p: [0, 0.12, 0], s: [1.4, 0.6, 0.7] });
    bb.add(new THREE.ConeGeometry(0.05, 0.08, 4), PAL.coral, { p: [0.12, 0.12, 0], r: [0, 0, Math.PI / 2] });
    bowl.add(bb.mesh(mat, 'home-bowl-mesh'));
    const bs = new THREE.Mesh(blobGeo, blobMat);
    bs.scale.set(0.5, 1, 0.42);
    bs.position.y = 0.003;
    bowl.add(bs);
  }
  bowl.position.set(kx + 0.36, ZONES[0].floorY, CAT_Z + 0.22);
  bowl.visible = false;
  bowl.scale.setScalar(0.001);
  const BOWL_S = 0.8;
  group.add(bowl);

  const ballObj = new THREE.Group();
  {
    const bb = new Batch();
    bb.add(ball(0.11, 1), PAL.coral, {});
    bb.add(torus(0.111, 0.018, 4, 16), PAL.white, { r: [Math.PI / 2, 0, 0] });
    bb.add(torus(0.111, 0.018, 4, 16), PAL.white, {});
    ballObj.add(bb.mesh(mat, 'home-ball-mesh'));
  }
  const ballHome = new THREE.Vector3(-0.5, 0.11, 0.78);
  ballObj.position.copy(ballHome);
  group.add(ballObj);

  // ───────── якорь кота: «плоскость карты» = пол (+Z карты → вверх, +Y карты → в глубину) ─────────
  const anchor = new THREE.Group();
  anchor.name = 'home-anchor';
  anchor.rotation.set(-Math.PI / 2, 0, 0);
  group.add(anchor);

  let light = 1, lightGoal = 1;
  let bowlK = 0, bowlGoal = 0;
  let ballT = -1;
  const dayColor = new THREE.Color(1, 1, 1), nightColor = new THREE.Color(0.3, 0.32, 0.55), skyNight = new THREE.Color(0.12, 0.15, 0.4);
  const applyLight = () => {
    mat.color.copy(nightColor).lerp(dayColor, light);
    skyMat.color.copy(skyNight).lerp(dayColor, light);
    glowMat.opacity = 0.45 + (1 - light) * 0.5;
    blobMat.opacity = 0.6 + 0.4 * light;
  };
  applyLight();

  return {
    group,
    anchor,
    get light() {
      return light;
    },
    setLight(k) {
      lightGoal = Math.max(0, Math.min(1, k));
    },
    showBowl(on) {
      bowlGoal = on ? 1 : 0;
      if (on) bowl.visible = true;
    },
    bounceBall() {
      ballT = 0;
    },
    placeAnchor(x, y, yaw = 0) {
      // точка опоры Stage (footY = −0,1 карты) — на 0,1 ближе к зрителю: кот стоит ровно на CAT_Z
      anchor.position.set(x, y, CAT_Z - 0.1);
      // сначала «карта на пол» (−90° по X), потом поворот вокруг вертикали (бег между зонами)
      anchor.rotation.set(-Math.PI / 2, yaw, 0, 'YXZ');
      anchor.updateMatrixWorld(true);
    },
    update(dt) {
      if (light !== lightGoal) {
        light += Math.sign(lightGoal - light) * Math.min(Math.abs(lightGoal - light), dt / 1.2);
        applyLight();
      }
      if (bowlK !== bowlGoal) {
        bowlK += Math.sign(bowlGoal - bowlK) * Math.min(Math.abs(bowlGoal - bowlK), dt / 0.35);
        // «поп» с перелётом
        const s = bowlGoal ? 1 + 0.25 * Math.sin(bowlK * Math.PI) : bowlK;
        bowl.scale.setScalar(Math.max(0.001, bowlK * s * BOWL_S));
        if (bowlK <= 0) bowl.visible = false;
      }
      if (ballT >= 0) {
        ballT += dt;
        const T = 1.6;
        const k = Math.min(1, ballT / T);
        // три затухающих прыжка и откат
        const hop = Math.abs(Math.sin(k * Math.PI * 3)) * 0.5 * (1 - k);
        ballObj.position.set(ballHome.x + Math.sin(k * Math.PI) * 0.25, ballHome.y + hop, ballHome.z);
        ballObj.rotation.z -= dt * 6 * (1 - k);
        if (k >= 1) ballT = -1;
      }
    },
    dispose() {
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
      for (const m of [mat, skyMat, blobMat, glowMat]) {
        m.map?.dispose();
        m.dispose();
      }
      group.removeFromParent();
    },
  };
}

/** зона по id → центр по X */
export const zoneX = (id: ZoneId) => ZONES.find((z) => z.id === id)?.x ?? 0;
