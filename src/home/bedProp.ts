/**
 * Кровать кота в спальне (src/home): процедурная модель three.js в стиле комнаты (запечённый свет в цветах вершин,
 * мягкие скруглённые формы, палитра Сбера) + живые части: одеяло, которое откидывается и накрывает кота (сетка
 * с настоящим сгибом и «горбом» над котом), ночник и рулонная шторка на окне.
 *
 * GLB вместо процедурной: если есть `public/models/props/bed.glb` — грузится он (узлы-якоря):
 *   bed_root   — корень кровати: ставится в точку кровати (пол, центр); длина по X приводится к BED.length;
 *   sleep_spot — точка, где лежит кот (на матрасе, у подушки): туда сцена кладёт кота;
 *   blanket    — одеяло в позе «накрыт»: откинуто = сжато по X к изножью (scale.x 0,35), накрыто = как в файле.
 * Нет узла — берутся процедурные значения. Ночник и шторка — процедурные в обоих случаях.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { BakeOpts } from './room';
import { BED } from './bed';

export { BED };

const PAL = {
  green: '#21A038',
  greenDeep: '#178A2E',
  teal: '#14B8A6',
  mint: '#9BE3CF',
  lime: '#B8E34A',
  white: '#FFFFFF',
  cream: '#FFF7EA',
  sheet: '#F4F8FF',
  navy: '#2E3A6E',
  sun: '#FFD36B',
};

export interface BatchLike {
  add(geo: THREE.BufferGeometry, color: THREE.ColorRepresentation, at?: { p?: [number, number, number]; r?: [number, number, number]; s?: [number, number, number] }, o?: BakeOpts): void;
}

export interface BedProp {
  /** подключить GLB-кровать (loadBedGlb): процедурная статика прячется */
  attachGlb(root: THREE.Object3D, hideStatic: () => void): void;
  /** живые части (одеяло, ночник, шторка, GLB) — в группе комнаты */
  readonly group: THREE.Group;
  /** где лежит кот (мир): на матрасе у подушки */
  readonly spot: THREE.Vector3;
  /** где кот стоит перед прыжком в кровать (пол у края матраса) */
  readonly foot: THREE.Vector3;
  /** 0 — одеяло откинуто к изножью, 1 — накрывает кота до плеч */
  setCover(k: number): void;
  readonly cover: number;
  /** кот под одеялом (горб): 0..1 */
  setHump(k: number): void;
  /** ночник 0..1 */
  setLamp(k: number): void;
  /** шторка: 0 — открыта, 1 — опущена */
  setShade(k: number): void;
  readonly shade: number;
  /** попал ли луч в окно/шторку */
  hitShade(ray: THREE.Raycaster): boolean;
  /** свет комнаты (ночь — темнее), как у запечённого материала */
  setLight(k: number, night: THREE.Color): void;
  update(dt: number): void;
  /** загружена GLB-кровать */
  readonly glb: boolean;
  dispose(): void;
}

const rbox = (w: number, h: number, d: number, r = 0.06, seg = 2) => new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3));
const cyl = (rt: number, rb: number, h: number, seg = 14) => new THREE.CylinderGeometry(rt, rb, h, seg, 1);

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.Texture {
  const c = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const g = c?.getContext('2d');
  if (!c || !g) return new THREE.Texture();
  c.width = w;
  c.height = h;
  draw(g);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** одеяло: зелёное Сбера, лаймовые звёздочки и мятные точки, белая строчка по краю */
function blanketTexture() {
  return canvasTex(256, 256, (g) => {
    g.fillStyle = PAL.green;
    g.fillRect(0, 0, 256, 256);
    // клетка-стёжка
    g.strokeStyle = 'rgba(255,255,255,0.18)';
    g.lineWidth = 3;
    for (let i = 0; i <= 256; i += 64) {
      g.beginPath();
      g.moveTo(i, 0);
      g.lineTo(i, 256);
      g.moveTo(0, i);
      g.lineTo(256, i);
      g.stroke();
    }
    const star = (x: number, y: number, r: number, c: string) => {
      g.fillStyle = c;
      g.beginPath();
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2 - Math.PI / 2, rr = k % 2 ? r * 0.45 : r;
        g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      }
      g.fill();
    };
    star(32, 32, 14, PAL.lime);
    star(160, 96, 12, PAL.lime);
    star(96, 192, 13, PAL.lime);
    star(224, 224, 11, PAL.lime);
    g.fillStyle = PAL.mint;
    for (const [x, y] of [[96, 64], [224, 32], [32, 160], [160, 224], [200, 150]]) {
      g.beginPath();
      g.arc(x, y, 5, 0, Math.PI * 2);
      g.fill();
    }
  });
}

/** шторка: тёмно-синяя ночь, луна и звёзды */
function shadeTexture() {
  return canvasTex(128, 128, (g) => {
    const grd = g.createLinearGradient(0, 0, 0, 128);
    grd.addColorStop(0, '#3B4A86');
    grd.addColorStop(1, PAL.navy);
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = '#FFE59A';
    g.beginPath();
    g.arc(84, 40, 16, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#3A4884';
    g.beginPath();
    g.arc(92, 34, 14, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#FFFFFF';
    for (const [x, y, r] of [[30, 30, 2.5], [50, 70, 2], [22, 96, 2.5], [100, 92, 2], [70, 108, 1.8], [110, 16, 1.6]]) {
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
    // планка снизу
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.fillRect(0, 120, 128, 8);
  });
}

function glowTex() {
  return canvasTex(64, 64, (g) => {
    const grd = g.createRadialGradient(32, 32, 1, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,230,170,1)');
    grd.addColorStop(0.35, 'rgba(255,200,120,0.5)');
    grd.addColorStop(1, 'rgba(255,190,110,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
  });
}

const SUN = new THREE.Vector3(0.35, 0.8, 0.55).normalize();

/**
 * Кровать в точке (cx — центр зоны спальни). Статика (каркас, матрас, подушка, ночник-гриб) — в batch комнаты
 * (запечённый свет, один материал); живые части — в group. win — окно спальни (для шторки).
 */
export function buildBed(batch: BatchLike, cx: number, win: { x: number; y: number; w: number; h: number; z: number }, stand: { x: number; z: number }): BedProp {
  const group = new THREE.Group();
  group.name = 'home-bed';
  const L = BED.length, W = BED.width, x0 = cx + BED.dx, z0 = BED.z;
  const proc = new THREE.Group();
  proc.name = 'bed-procedural';
  group.add(proc);

  // ───────── статика: каркас, ножки, изголовье, изножье, матрас, простыня, подушка ─────────
  const S = batch.add.bind(batch);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) S(cyl(0.045, 0.04, 0.08, 10), PAL.greenDeep, { p: [x0 + sx * (L / 2 - 0.06), 0.04, z0 + sz * (W / 2 - 0.06)] }, { ao: 0.1 });
  S(rbox(L + 0.06, 0.2, W + 0.06, 0.07), PAL.white, { p: [x0, 0.17, z0] });
  S(rbox(L + 0.08, 0.05, W + 0.08, 0.025), PAL.teal, { p: [x0, 0.085, z0] });
  // изголовье (справа, у ночника): бирюзовая арка с лаймовым кантом
  const hx = x0 + L / 2 + 0.03;
  S(rbox(0.09, 0.72, W + 0.1, 0.045), PAL.teal, { p: [hx, 0.5, z0] });
  S(cyl(W / 2 + 0.05, W / 2 + 0.05, 0.09, 24), PAL.teal, { p: [hx, 0.86, z0], r: [0, 0, Math.PI / 2], s: [1, 1, 0.55] });
  S(cyl(W / 2 - 0.08, W / 2 - 0.08, 0.1, 24), PAL.lime, { p: [hx - 0.005, 0.86, z0], r: [0, 0, Math.PI / 2], s: [1, 1, 0.42] });
  S(cyl(W / 2 - 0.15, W / 2 - 0.15, 0.105, 24), PAL.mint, { p: [hx - 0.01, 0.86, z0], r: [0, 0, Math.PI / 2], s: [1, 1, 0.35] });
  // изножье (слева): ниже, белое с зелёной планкой
  const fx = x0 - L / 2 - 0.03;
  S(rbox(0.08, 0.42, W + 0.1, 0.04), PAL.white, { p: [fx, 0.33, z0] });
  S(rbox(0.09, 0.05, W + 0.1, 0.02), PAL.green, { p: [fx, 0.52, z0] });
  // матрас и простыня
  S(rbox(L, 0.16, W, 0.06, 3), PAL.cream, { p: [x0, BED.top - 0.08, z0] });
  S(rbox(L - 0.04, 0.012, W - 0.04, 0.006), PAL.sheet, { p: [x0, BED.top + 0.002, z0] }, { ao: 0 });
  // подушка у изголовья
  S(rbox(0.36, 0.13, W * 0.68, 0.06, 3), PAL.white, { p: [x0 + L / 2 - 0.25, BED.top + 0.07, z0], r: [0, 0, 0.12] });
  S(rbox(0.3, 0.02, W * 0.6, 0.01), PAL.mint, { p: [x0 + L / 2 - 0.25, BED.top + 0.14, z0], r: [0, 0, 0.12] });

  const spot = new THREE.Vector3(x0 + 0.12, BED.top - 0.01, z0 + 0.06);
  const foot = new THREE.Vector3(stand.x, 0, stand.z);

  // ───────── одеяло: сетка с настоящим сгибом ─────────
  const NU = 30, NV = 14;
  const LB = L * 0.78, WB = W + 0.26;
  const geo = new THREE.PlaneGeometry(1, 1, NU, NV);
  const uvAttr = geo.getAttribute('uv') as THREE.BufferAttribute;
  // u — вдоль одеяла от изножья, v — поперёк; храним исходные u,v (позиции пересчитываются)
  const base = Float32Array.from(uvAttr.array as ArrayLike<number>);
  // текстура: несколько повторов звёзд
  for (let i = 0; i < uvAttr.count; i++) uvAttr.setXY(i, base[i * 2] * 2.2, base[i * 2 + 1] * 1.6);
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(uvAttr.count * 3), 3));
  const blanketMat = new THREE.MeshBasicMaterial({ map: blanketTexture(), vertexColors: true, side: THREE.DoubleSide });
  const blanket = new THREE.Mesh(geo, blanketMat);
  blanket.name = 'bed-blanket';
  blanket.frustumCulled = false;
  proc.add(blanket);
  let cover = 0, coverGoal = 0, hump = 0, humpGoal = 0, dirty = true;
  const footX = x0 - L / 2 + 0.04;
  const humpC = () => ({ x: spot.x - 0.22, z: spot.z + 0.04 });
  const shape = () => {
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const col = geo.getAttribute('color') as THREE.BufferAttribute;
    // откинуто — 0,32 длины лежит у изножья в два слоя, накрыто — во всю длину
    const c = 0.32 + 0.68 * cover;
    const hc = humpC();
    for (let i = 0; i < pos.count; i++) {
      const u = base[i * 2], v = base[i * 2 + 1];
      const folded = u > c;
      const along = folded ? 2 * c - u : u;
      const x = footX + along * LB;
      let z = z0 + (v - 0.5) * WB;
      let y = BED.top + 0.025 + (folded ? 0.035 + (u - c) * 0.02 : 0);
      // горб: кот под одеялом
      if (hump > 0) {
        const dx = (x - hc.x) / 0.52, dz = (z - hc.z) / 0.42;
        const q = 1 - dx * dx - dz * dz;
        if (q > 0) y += hump * 0.36 * Math.pow(q, 0.6);
      }
      // свисает по бокам матраса
      const over = Math.abs(z - z0) - W / 2;
      if (over > 0) {
        y -= Math.min(0.2, over * 1.6);
        z -= Math.sign(z - z0) * over * 0.55;
      }
      pos.setXYZ(i, x, y, z);
      void col;
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    const nor = geo.getAttribute('normal') as THREE.BufferAttribute;
    const n = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      n.fromBufferAttribute(nor, i);
      if (n.y < 0) n.negate();
      const l = 0.72 + 0.26 * Math.max(0, n.dot(SUN)) + 0.06 * n.y;
      const fold = base[i * 2] > c ? 1.06 : 1;
      col.setXYZ(i, Math.min(1, l * fold), Math.min(1, l * fold), Math.min(1, l * fold));
    }
    col.needsUpdate = true;
    geo.computeBoundingSphere();
    dirty = false;
  };
  shape();

  // ───────── ночник на тумбочке (свечение) ─────────
  const lampAt = new THREE.Vector3(cx + 1.06, 0.7, -1.45);
  const lampMat = new THREE.MeshBasicMaterial({ map: glowTex(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 });
  const lampGlow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), lampMat);
  lampGlow.position.copy(lampAt).add(new THREE.Vector3(0, 0, 0.12));
  lampGlow.scale.setScalar(1.3);
  lampGlow.renderOrder = 3;
  group.add(lampGlow);
  const poolMat = lampMat.clone();
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), poolMat);
  pool.position.set(lampAt.x - 0.2, 0.9, BACK_Z_WALL + 0.02);
  pool.scale.set(2.2, 1.8, 1);
  pool.renderOrder = 2;
  group.add(pool);
  let lamp = 0, lampGoal = 0;

  // ───────── шторка на окне ─────────
  const shadeMat = new THREE.MeshBasicMaterial({ map: shadeTexture() });
  const shadeMesh = new THREE.Mesh(new THREE.PlaneGeometry(win.w + 0.08, 1), shadeMat);
  shadeMesh.name = 'bed-shade';
  shadeMesh.position.set(win.x, win.y + win.h / 2, win.z + 0.06);
  group.add(shadeMesh);
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, win.w + 0.16, 10).rotateZ(Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#F2F2F2' }));
  tube.position.set(win.x, win.y + win.h / 2 + 0.06, win.z + 0.08);
  group.add(tube);
  const winHit = new THREE.Mesh(new THREE.PlaneGeometry(win.w + 0.2, win.h + 0.2), new THREE.MeshBasicMaterial({ visible: false }));
  winHit.position.set(win.x, win.y, win.z + 0.07);
  group.add(winHit);
  let shade = 0, shadeGoal = 0;
  const shadeShape = () => {
    const h = Math.max(0.001, shade * (win.h + 0.04));
    shadeMesh.scale.y = h;
    shadeMesh.position.y = win.y + win.h / 2 + 0.02 - h / 2;
    shadeMesh.visible = shade > 0.01;
    // текстура не растягивается: показываем верхнюю часть рисунка
    const t = shadeMat.map!;
    t.repeat.set(1, Math.max(0.05, shade));
    t.offset.set(0, 1 - Math.max(0.05, shade));
  };
  shadeShape();

  // ───────── GLB вместо процедурной (если лежит в public/models/props/bed.glb) ─────────
  let glb: THREE.Object3D | null = null;
  let glbBlanket: { o: THREE.Object3D; p: THREE.Vector3; s: THREE.Vector3; len: number } | null = null;
  const glbMats: { m: THREE.MeshStandardMaterial | THREE.MeshBasicMaterial; c: THREE.Color }[] = [];

  const api: BedProp = {
    group,
    spot,
    foot,
    get cover() {
      return cover;
    },
    get shade() {
      return shade;
    },
    get glb() {
      return !!glb;
    },
    setCover(k) {
      coverGoal = THREE.MathUtils.clamp(k, 0, 1);
    },
    setHump(k) {
      humpGoal = THREE.MathUtils.clamp(k, 0, 1);
    },
    setLamp(k) {
      lampGoal = THREE.MathUtils.clamp(k, 0, 1);
    },
    setShade(k) {
      shadeGoal = THREE.MathUtils.clamp(k, 0, 1);
    },
    hitShade(ray) {
      return ray.intersectObjects([winHit, shadeMesh], false).length > 0;
    },
    setLight(k, night) {
      const c = new THREE.Color().copy(night).lerp(new THREE.Color(1, 1, 1), k);
      blanketMat.color.copy(c);
      shadeMat.color.copy(new THREE.Color().copy(night).lerp(new THREE.Color(1, 1, 1), 0.55 + 0.45 * k));
      for (const g of glbMats) g.m.color.copy(g.c).multiply(c);
    },
    update(dt) {
      const step = (cur: number, goal: number, sec: number) => (cur === goal ? cur : cur + Math.sign(goal - cur) * Math.min(Math.abs(goal - cur), dt / sec));
      const c0 = cover, h0 = hump;
      cover = step(cover, coverGoal, 0.8);
      hump = step(hump, humpGoal, 0.6);
      if (c0 !== cover || h0 !== hump) dirty = true;
      if (dirty) shape();
      if (glbBlanket) {
        const b = glbBlanket, k = 0.35 + 0.65 * cover;
        b.o.scale.set(b.s.x * k, b.s.y * (1 + 0.6 * (1 - cover)), b.s.z);
        b.o.position.set(b.p.x - (1 - k) * b.len * 0.5, b.p.y + 0.02 * (1 - cover), b.p.z);
      }
      const l0 = lamp;
      lamp = step(lamp, lampGoal, 0.7);
      if (l0 !== lamp || lamp > 0) {
        lampMat.opacity = 0.95 * lamp * (0.94 + 0.06 * Math.sin(performance.now() / 700));
        poolMat.opacity = 0.35 * lamp;
        lampGlow.visible = pool.visible = lamp > 0.01;
      }
      const s0 = shade;
      shade = step(shade, shadeGoal, 0.9);
      if (s0 !== shade) shadeShape();
    },
    /** GLB-кровать: процедурная статика прячется, якоря — из узлов */
    attachGlb(root, hideStatic) {
      const box = new THREE.Box3().setFromObject(root);
      const size = box.getSize(new THREE.Vector3());
      const s = size.x > 0.01 ? L / size.x : 1;
      root.scale.multiplyScalar(s);
      root.position.set(x0, 0, z0);
      root.updateMatrixWorld(true);
      const b2 = new THREE.Box3().setFromObject(root);
      root.position.y -= b2.min.y;
      root.updateMatrixWorld(true);
      const sp = root.getObjectByName('sleep_spot');
      if (sp) sp.getWorldPosition(spot);
      const bl = root.getObjectByName('blanket');
      if (bl) {
        const bb = new THREE.Box3().setFromObject(bl).getSize(new THREE.Vector3());
        const ps = bl.parent ? bl.parent.getWorldScale(new THREE.Vector3()).x : 1;
        glbBlanket = { o: bl, p: bl.position.clone(), s: bl.scale.clone(), len: bb.x / Math.max(1e-6, ps) };
        blanket.visible = false;
      } else blanket.visible = true;
      root.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if ((o as THREE.Mesh).isMesh && m && 'color' in m) glbMats.push({ m, c: m.color.clone() });
      });
      glb = root;
      group.add(root);
      hideStatic();
    },
    dispose() {
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
      for (const m of [blanketMat, lampMat, poolMat, shadeMat]) {
        m.map?.dispose();
        m.dispose();
      }
      group.removeFromParent();
    },
  };
  return api;
}

/** задняя стена комнаты (как BACK_Z в room.ts; копия, чтобы не было цикла импорта) */
const BACK_Z_WALL = -1.8;

/** есть ли GLB кровати: файл может отсутствовать — тогда процедурная (SPA-фолбэк отдаёт html — тоже «нет») */
export async function loadBedGlb(url: string): Promise<THREE.Object3D | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    const magic = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(4, buf.byteLength)));
    if (magic !== 'glTF') return null;
    const { makeGltfLoader } = await import('../character/gltfLoad');
    const g = await makeGltfLoader().parseAsync(buf, url.replace(/[^/]*$/, ''));
    return g.scene.getObjectByName('bed_root') ?? g.scene;
  } catch {
    return null;
  }
}
