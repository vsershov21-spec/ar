/**
 * Хват предмета по поверхности (продакт 26.11: «предметы держат очень криво, они проникают в руки»).
 *
 *   PropSDF  — поле расстояний предмета в его системе (узел prop): сетка ~26³, внутри/снаружи — чётностью пересечений
 *              столбцов сетки с треугольниками по трём осям (большинство: сетки Tripo не всегда замкнуты), расстояние —
 *              распространением ближайшей точки границы. Строится один раз на предмет (кэш по id и размеру кисти).
 *   HandCaps — капсулы кисти: ладонь (Hand → Middle1) и фаланги пальцев Mixamo (Thumb/Index/Middle/Ring/Pinky 1–3)
 *              с радиусами по сетке кота (точки сетки, привязанные к кости, — расстояние до оси кости).
 *   solveGrip — каждый кадр после того, как предмет поставлен у ладони: (1) предмет выталкивается из ладони и
 *              оснований пальцев по градиенту поля (кисть на месте, предмет на её поверхности); (2) каждый сустав
 *              каждого пальца сгибается до касания поверхности предмета (двоичный поиск угла) — пальцы обхватывают
 *              ручку/кружку, а не входят в неё. Углы и выталкивание сглажены (без дрожи).
 */
import * as THREE from 'three';
import { rotWorld } from './limbIK';

const tv = new THREE.Vector3();

export class PropSDF {
  private constructor(
    readonly min: THREE.Vector3,
    readonly h: number,
    readonly n: [number, number, number],
    readonly d: Float32Array,
  ) {}

  /** поле предмета pivot (узел prop): треугольники детей в системе pivot */
  static build(pivot: THREE.Object3D, N = 26): PropSDF | null {
    pivot.updateWorldMatrix(true, true);
    const inv = pivot.matrixWorld.clone().invert();
    const T: number[] = [];
    const v = new THREE.Vector3();
    pivot.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || o === pivot) return;
      const rel = inv.clone().multiply(m.matrixWorld);
      const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute;
      const ix = m.geometry.getIndex();
      const cnt = ix ? ix.count : pos.count;
      for (let i = 0; i + 2 < cnt; i += 3)
        for (let k = 0; k < 3; k++) {
          v.fromBufferAttribute(pos, ix ? ix.getX(i + k) : i + k).applyMatrix4(rel);
          T.push(v.x, v.y, v.z);
        }
    });
    const nt = T.length / 9;
    if (!nt) return null;
    const lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < T.length; i += 3) {
      lo.min(v.set(T[i], T[i + 1], T[i + 2]));
      hi.max(v);
    }
    const size = hi.clone().sub(lo);
    const ext = Math.max(size.x, size.y, size.z);
    const pad = ext * 0.22;
    lo.subScalar(pad);
    hi.addScalar(pad);
    const h = (ext + 2 * pad) / N;
    const n: [number, number, number] = [Math.ceil((hi.x - lo.x) / h), Math.ceil((hi.y - lo.y) / h), Math.ceil((hi.z - lo.z) / h)];
    const [nx, ny, nz] = n;
    const id = (i: number, j: number, k: number) => i + nx * (j + ny * k);
    const votes = new Uint8Array(nx * ny * nz);
    // столбцы вдоль оси A, через центры клеток по двум другим осям; треугольники разложены по 2D-корзинам
    for (let A = 0; A < 3; A++) {
      const U = (A + 1) % 3, W = (A + 2) % 3;
      const nu = n[U], nw = n[W], na = n[A];
      const lU = lo.getComponent(U), lW = lo.getComponent(W), lA = lo.getComponent(A);
      const bins: number[][] = Array.from({ length: nu * nw }, () => []);
      for (let t = 0; t < nt; t++) {
        let u0 = Infinity, u1 = -Infinity, w0 = Infinity, w1 = -Infinity;
        for (let k = 0; k < 3; k++) {
          const u = T[t * 9 + k * 3 + U], w = T[t * 9 + k * 3 + W];
          u0 = Math.min(u0, u);
          u1 = Math.max(u1, u);
          w0 = Math.min(w0, w);
          w1 = Math.max(w1, w);
        }
        const i0 = Math.max(0, Math.ceil((u0 - lU) / h - 0.5)), i1 = Math.min(nu - 1, Math.floor((u1 - lU) / h - 0.5));
        const j0 = Math.max(0, Math.ceil((w0 - lW) / h - 0.5)), j1 = Math.min(nw - 1, Math.floor((w1 - lW) / h - 0.5));
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) bins[i + nu * j].push(t);
      }
      const xs: number[] = [];
      for (let i = 0; i < nu; i++)
        for (let j = 0; j < nw; j++) {
          const pu = lU + (i + 0.5) * h + 1.3e-7, pw = lW + (j + 0.5) * h + 0.7e-7;
          xs.length = 0;
          for (const t of bins[i + nu * j]) {
            const o = t * 9;
            const au = T[o + U], aw = T[o + W], bu = T[o + 3 + U], bw = T[o + 3 + W], cu = T[o + 6 + U], cw = T[o + 6 + W];
            const det = (bw - cw) * (au - cu) + (cu - bu) * (aw - cw);
            if (Math.abs(det) < 1e-18) continue;
            const l1 = ((bw - cw) * (pu - cu) + (cu - bu) * (pw - cw)) / det;
            const l2 = ((cw - aw) * (pu - cu) + (au - cu) * (pw - cw)) / det;
            const l3 = 1 - l1 - l2;
            if (l1 < 0 || l2 < 0 || l3 < 0) continue;
            xs.push(l1 * T[o + A] + l2 * T[o + 3 + A] + l3 * T[o + 6 + A]);
          }
          if (!xs.length) continue;
          xs.sort((a, b) => a - b);
          let c = 0;
          for (let k = 0; k < na; k++) {
            const pa = lA + (k + 0.5) * h;
            while (c < xs.length && xs[c] < pa) c++;
            if (c & 1) {
              const ijk = [0, 0, 0];
              ijk[A] = k;
              ijk[U] = i;
              ijk[W] = j;
              votes[id(ijk[0], ijk[1], ijk[2])]++;
            }
          }
        }
    }
    const inside = new Uint8Array(votes.length);
    for (let q = 0; q < votes.length; q++) inside[q] = votes[q] >= 2 ? 1 : 0;
    // граница: клетка, у которой сосед по грани с другим знаком; ближайшая точка границы — распространением
    const site = new Int32Array(votes.length).fill(-1);
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const q = id(i, j, k), s = inside[q];
          const nb = [i > 0 && inside[q - 1] !== s, i < nx - 1 && inside[q + 1] !== s, j > 0 && inside[q - nx] !== s, j < ny - 1 && inside[q + nx] !== s, k > 0 && inside[q - nx * ny] !== s, k < nz - 1 && inside[q + nx * ny] !== s];
          if (nb.some(Boolean)) site[q] = q;
        }
    const cx = (q: number) => q % nx, cy = (q: number) => Math.floor(q / nx) % ny, cz = (q: number) => Math.floor(q / (nx * ny));
    const d2 = (q: number, s: number) => (cx(q) - cx(s)) ** 2 + (cy(q) - cy(s)) ** 2 + (cz(q) - cz(s)) ** 2;
    const off: [number, number, number][] = [];
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy || dz) off.push([dx, dy, dz]);
    const fwd = off.filter(([x, y, z]) => z < 0 || (z === 0 && (y < 0 || (y === 0 && x < 0))));
    const bwd = off.filter((o) => !fwd.includes(o));
    for (let pass = 0; pass < 2; pass++)
      for (const [dir, nb] of [[1, fwd], [-1, bwd]] as const) {
        for (let kk = 0; kk < nz; kk++)
          for (let jj = 0; jj < ny; jj++)
            for (let ii = 0; ii < nx; ii++) {
              const i = dir > 0 ? ii : nx - 1 - ii, j = dir > 0 ? jj : ny - 1 - jj, k = dir > 0 ? kk : nz - 1 - kk;
              const q = id(i, j, k);
              let best = site[q], bd = best >= 0 ? d2(q, best) : Infinity;
              for (const [dx, dy, dz] of nb) {
                const x = i + dx, y = j + dy, z = k + dz;
                if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue;
                const s = site[id(x, y, z)];
                if (s < 0) continue;
                const dd = d2(q, s);
                if (dd < bd) [bd, best] = [dd, s];
              }
              site[q] = best;
            }
      }
    const d = new Float32Array(votes.length);
    for (let q = 0; q < d.length; q++) {
      const dist = site[q] >= 0 ? Math.sqrt(d2(q, site[q])) * h : 3 * ext;
      // граница проходит между клетками: полклетки к расстоянию снаружи, внутри — от
      d[q] = inside[q] ? -(dist + 0.5 * h) : Math.max(0, dist - 0.5 * h) + (site[q] === q ? 0.5 * h : 0);
      if (!inside[q] && site[q] === q) d[q] = 0.5 * h;
    }
    return new PropSDF(lo, h, n, d);
  }

  /** знаковое расстояние в системе предмета (< 0 — внутри), трилинейно */
  sample(p: THREE.Vector3): number {
    const [nx, ny, nz] = this.n;
    const fx = (p.x - this.min.x) / this.h - 0.5, fy = (p.y - this.min.y) / this.h - 0.5, fz = (p.z - this.min.z) / this.h - 0.5;
    const out = Math.max(0, -fx, fx - (nx - 1), -fy, fy - (ny - 1), -fz, fz - (nz - 1));
    const x = Math.min(nx - 1.001, Math.max(0, fx)), y = Math.min(ny - 1.001, Math.max(0, fy)), z = Math.min(nz - 1.001, Math.max(0, fz));
    const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z), u = x - i, v = y - j, w = z - k;
    const D = this.d, id = (a: number, b: number, c: number) => D[a + nx * (b + ny * c)];
    const l = (a: number, b: number, t: number) => a + (b - a) * t;
    const r = l(l(l(id(i, j, k), id(i + 1, j, k), u), l(id(i, j + 1, k), id(i + 1, j + 1, k), u), v), l(l(id(i, j, k + 1), id(i + 1, j, k + 1), u), l(id(i, j + 1, k + 1), id(i + 1, j + 1, k + 1), u), v), w);
    return r + out * this.h;
  }

  /** градиент (наружу), в системе предмета */
  grad(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const e = this.h * 0.75;
    const s = (dx: number, dy: number, dz: number) => this.sample(tv.set(p.x + dx, p.y + dy, p.z + dz));
    out.set(s(e, 0, 0) - s(-e, 0, 0), s(0, e, 0) - s(0, -e, 0), s(0, 0, e) - s(0, 0, -e));
    const L = out.length();
    return L > 1e-12 ? out.multiplyScalar(1 / L) : out.set(0, 0, 0);
  }
}

/** капсулы кисти (система кота: доли роста) */
export interface HandCaps {
  hand: THREE.Object3D;
  /** ладонь: от кисти к основанию среднего пальца */
  palmTo: THREE.Object3D | null;
  palmR: number;
  /** пальцы: кости 1–3 (+ кончик 4, если есть) и радиусы фаланг */
  fingers: { bones: THREE.Object3D[]; tip: THREE.Object3D | null; r: number[]; thumb: boolean; skin: SkinPts[] }[];
  /** точки сетки ладони со стороны подушечек (после скиннинга — поверхность, которой лапа касается предмета) */
  palm: SkinPts;
  palmExtra?: SkinPts[];
}
/** точки сетки кота: меш и номера вершин */
export interface SkinPts {
  mesh: THREE.SkinnedMesh;
  idx: number[];
}

/**
 * Радиусы ладони и фаланг по сетке кота в позе загрузки: точки сетки, у которых кость — главная, их расстояние до оси
 * кости (от неё к следующей), 65-й процентиль. catScale — масштаб кота в мире (радиусы — в долях роста).
 */
export function measureHand(model: THREE.Object3D, side: 'Left' | 'Right', catScale: number, palmNWorld?: THREE.Vector3): HandCaps | null {
  const by = (n: string) => model.getObjectByName('mixamorig' + n) ?? model.getObjectByName('mixamorig:' + n) ?? null;
  const hand = by(side + 'Hand');
  if (!hand) return null;
  const names = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];
  const segs = new Map<THREE.Object3D, { a: THREE.Vector3; b: THREE.Vector3; ds: number[] }>();
  const seg = (bone: THREE.Object3D, next: THREE.Object3D | null) => {
    const a = bone.getWorldPosition(new THREE.Vector3());
    const b = next ? next.getWorldPosition(new THREE.Vector3()) : a.clone();
    segs.set(bone, { a, b, ds: [] });
  };
  model.updateMatrixWorld(true);
  const palmTo = by(side + 'HandMiddle1');
  seg(hand, palmTo);
  const fingers: HandCaps['fingers'] = [];
  for (const f of names) {
    const bones = [1, 2, 3].map((i) => by(`${side}Hand${f}${i}`)).filter((x): x is THREE.Object3D => !!x);
    if (!bones.length) continue;
    const tip = by(`${side}Hand${f}4`);
    bones.forEach((b, i) => seg(b, bones[i + 1] ?? tip));
    fingers.push({ bones, tip, r: [], thumb: f === 'Thumb', skin: [] });
  }
  // кончик без кости 4 — продолжение прошлой фаланги
  for (const f of fingers) {
    const last = segs.get(f.bones[f.bones.length - 1])!;
    if (last.a.distanceTo(last.b) < 1e-9 && f.bones.length > 1) {
      const prev = segs.get(f.bones[f.bones.length - 2])!;
      last.b.copy(last.a).add(prev.b.clone().sub(prev.a).multiplyScalar(0.8));
    }
  }
  const v = new THREE.Vector3(), cp = new THREE.Vector3(), line = new THREE.Line3();
  /** кандидаты в точки касания: кость → [меш, вершина, «к подушечкам»] */
  const cand = new Map<THREE.Object3D, { mesh: THREE.SkinnedMesh; i: number; s: number }[]>();
  model.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh || /fur|shell|card|blush|emotion/i.test(m.name)) return;
    const si = m.geometry.getAttribute('skinIndex') as THREE.BufferAttribute | undefined;
    const sw = m.geometry.getAttribute('skinWeight') as THREE.BufferAttribute | undefined;
    const pos = m.geometry.getAttribute('position');
    if (!si || !sw) return;
    m.updateWorldMatrix(true, false);
    for (let i = 0; i < pos.count; i++) {
      let best = 0, bw = -1;
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (w > bw) [bw, best] = [w, si.getComponent(i, k)];
      }
      const s = segs.get(m.skeleton.bones[best]);
      if (!s) continue;
      m.getVertexPosition(i, v).applyMatrix4(m.matrixWorld);
      line.set(s.a, s.b).closestPointToPoint(v, true, cp);
      s.ds.push(cp.distanceTo(v));
      if (bw > 0.5 && palmNWorld) {
        const bone = m.skeleton.bones[best];
        const arr = cand.get(bone) ?? [];
        arr.push({ mesh: m, i, s: v.clone().sub(cp).normalize().dot(palmNWorld) });
        cand.set(bone, arr);
      }
    }
  });
  const pct = (a: number[], p: number, d: number) => {
    if (a.length < 6) return d;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length * p)];
  };
  const hs = segs.get(hand)!;
  const palmLen = hs.a.distanceTo(hs.b) || 0.02 * catScale;
  const palmR = pct(hs.ds, 0.55, palmLen * 0.5) / catScale;
  for (const f of fingers) f.r = f.bones.map((b) => pct(segs.get(b)!.ds, 0.65, palmLen * 0.22) / catScale);
  /** точки со стороны подушечек (s — косинус к нормали ладони), не больше n, равномерно */
  const pick = (bone: THREE.Object3D, minS: number, n: number): SkinPts[] => {
    const arr = (cand.get(bone) ?? []).filter((c) => c.s > minS);
    const by = new Map<THREE.SkinnedMesh, number[]>();
    const step = Math.max(1, Math.floor(arr.length / n));
    for (let i = 0; i < arr.length; i += step) {
      const l = by.get(arr[i].mesh) ?? [];
      l.push(arr[i].i);
      by.set(arr[i].mesh, l);
    }
    return [...by].map(([mesh, idx]) => ({ mesh, idx }));
  };
  const palmPts = pick(hand, 0.35, 48);
  const palm: SkinPts = palmPts.sort((a, b) => b.idx.length - a.idx.length)[0] ?? { mesh: null as unknown as THREE.SkinnedMesh, idx: [] };
  // остальные меши ладони (подушечки BD_Pads) — тоже: склеиваем в список через отдельные записи пальца «0»
  for (const f of fingers) f.skin = f.bones.map((b) => pick(b, f.thumb ? -0.2 : 0.1, 14).sort((a, c) => c.idx.length - a.idx.length)[0] ?? { mesh: palm.mesh, idx: [] });
  return { hand, palmTo, palmR, fingers, palm: palm.mesh ? palm : { mesh: palm.mesh, idx: [] }, palmExtra: palmPts.filter((p) => p !== palm) } as HandCaps;
}

export interface GripState {
  /** сглаженные углы суставов [палец][фаланга] и выталкивание предмета (доли роста) */
  ang: number[][];
  push: number;
  /** стенд: проникновение после решения (доли роста) */
  pen: number;
  /** направление выталкивания (мир), сглаженное */
  dir: THREE.Vector3;
}
export const newGripState = (): GripState => ({ ang: [], push: 0, pen: 0, dir: new THREE.Vector3() });

const MAX_ANG = [1.3, 1.5, 1.25];
const THUMB_MAX = [0.6, 0.75, 0.6];
/** зазор, на котором пальцы останавливаются (доли роста ≈ 0,5 мм на карте; у точек сетки, не попавших в выборку, — запас) */
const TOL = 0.005;
/** скорость выталкивания: наружу / обратно, долей роста в секунду (≈ 47 / 28 мм/с на карте) */
const PUSH_OUT = 0.5;
const PUSH_BACK = 0.3;

const sv = new THREE.Vector3();
/** точки сетки после скиннинга (мир) */
function skinPts(p: SkinPts, out: THREE.Vector3[], from = 0): number {
  let n = from;
  if (!p.mesh) return n;
  for (const i of p.idx) {
    out[n] ??= new THREE.Vector3();
    p.mesh.getVertexPosition(i, out[n]).applyMatrix4(p.mesh.matrixWorld);
    n++;
  }
  return n;
}

/**
 * Решить хват кадра: предмет prop (узел, уже на месте у ладони), его поле sdf, точки кисти caps, нормаль ладони
 * palmN (мир). w — вес хвата 0…1 (шаблон: пальцы сжимаются/разжимаются), push — выталкивать предмет из ладони вдоль
 * нормали ладони. obj — кот (масштаб мира), st — сглаживание между кадрами.
 */
export function solveGrip(o: { prop: THREE.Object3D; sdf: PropSDF; caps: HandCaps; palmN: THREE.Vector3; w: number; push: boolean; pushW?: number; obj: THREE.Object3D; st: GripState; dt: number }) {
  const { prop, sdf, caps, palmN, w, obj, st, dt } = o;
  const cs = obj.getWorldScale(new THREE.Vector3()).y || 1;
  caps.hand.updateWorldMatrix(true, true);
  prop.updateWorldMatrix(true, false);
  let inv = prop.matrixWorld.clone().invert();
  const ps = prop.getWorldScale(new THREE.Vector3());
  const pScale = Math.min(ps.x, ps.y, ps.z) || 1;
  const lp = new THREE.Vector3();
  /** проникновение точки p (мир): > 0 — внутри предмета или ближе TOL к поверхности (доли роста) */
  const pen = (p: THREE.Vector3) => TOL - (sdf.sample(lp.copy(p).applyMatrix4(inv)) * pScale) / cs;
  const k = 1 - Math.exp(-dt / 0.045);
  // 1. подушечки ладони и первых фаланг — снаружи предмета: предмет отодвигается вдоль нормали ладони (лапа на месте)
  const base: THREE.Vector3[] = [];
  let nb = skinPts(caps.palm, base);
  for (const x of caps.palmExtra ?? []) nb = skinPts(x, base, nb);
  for (const f of caps.fingers) nb = skinPts(f.skin[0], base, nb);
  base.length = nb;
  let want = 0;
  const dirW = palmN.clone();
  if (o.push && w > 0.01) {
    const sh = new THREE.Vector3();
    const worstAt = (d: THREE.Vector3, s: number) => {
      sh.copy(d).multiplyScalar(s * cs);
      let m = -Infinity;
      for (const b of base) m = Math.max(m, pen(sv.copy(b).sub(sh)));
      return m;
    };
    /** наименьший сдвиг вдоль d, при котором ладонь снаружи; нет такого — сдвиг с наименьшим проникновением */
    const solve = (d: THREE.Vector3, top: number): { s: number; v: number } => {
      let best = 0, bv = worstAt(d, 0), free = -1;
      for (let i = 1; i <= 12; i++) {
        const s = (top * i) / 12, v = worstAt(d, s);
        if (v <= 0) {
          free = s;
          break;
        }
        if (v < bv - 1e-5) [best, bv] = [s, v];
      }
      if (free < 0) return { s: best, v: bv };
      let lo = free - top / 12, hi = free;
      for (let it = 0; it < 6; it++) {
        const m = (lo + hi) / 2;
        if (worstAt(d, m) > 0) lo = m;
        else hi = m;
      }
      return { s: hi, v: 0 };
    };
    if (worstAt(dirW, 0) > 0) {
      const top = Math.max(0.02, caps.palmR * 2.5);
      // вдоль нормали ладони (предмет лежит на подушечках); не освобождается (предмет поперёк кисти) — ещё от самой
      // глубокой точки по градиенту поля: берём направление с меньшим проникновением и сдвигом
      let r = solve(dirW, top);
      if (r.v > 0) {
        let deep: THREE.Vector3 | null = null, dv = 0;
        for (const b of base) {
          const v = pen(b);
          if (v > dv) [dv, deep] = [v, b];
        }
        if (deep) {
          const g = sdf.grad(lp.copy(deep).applyMatrix4(inv), new THREE.Vector3()).transformDirection(prop.matrixWorld).negate();
          const dir2 = g.add(palmN).normalize();
          const r2 = solve(dir2, top);
          if (r2.v < r.v - 1e-5) {
            r = r2;
            dirW.copy(dir2);
          }
        }
      }
      want = r.s;
    }
  }
  // выталкивание входит с весом позы лапы (pushW) — пока лапа не развернулась ладонью к предмету, толкать вдоль нормали
  // ладони — значит в тело
  // к цели с ограничением скорости: наружу ≤ PUSH_OUT, обратно ≤ PUSH_BACK (долей роста в секунду) — одиночный кадр
  // с неверной нормалью ладони (разворот кисти на подъёме) не уводит предмет навсегда и не даёт рывка
  st.push += Math.max(-PUSH_BACK * dt, Math.min(PUSH_OUT * dt, want - st.push));
  const pushNow = st.push * (o.pushW ?? 1);
  if (pushNow > 1e-6 && prop.parent) {
    // направление сглажено между кадрами (без скачка, когда «вдоль ладони» сменяется «по градиенту»)
    st.dir.lerp(dirW, st.dir.lengthSq() < 0.5 ? 1 : k).normalize();
    const pw = prop.getWorldPosition(new THREE.Vector3()).addScaledVector(st.dir, pushNow * cs);
    prop.position.copy(prop.parent.worldToLocal(pw));
    prop.updateWorldMatrix(true, false);
    inv = prop.matrixWorld.clone().invert();
  }
  // 2. пальцы: каждый сустав сгибается до касания подушечками (двоичный поиск угла), от основания к кончику
  const pts: THREE.Vector3[] = [];
  let worstAll = 0;
  caps.fingers.forEach((f, fi) => {
    st.ang[fi] ??= f.bones.map(() => 0);
    const lim = f.thumb ? THUMB_MAX : MAX_ANG;
    for (let j = 0; j < f.bones.length; j++) {
      const b = f.bones[j];
      const q0 = b.quaternion.clone();
      const next = f.bones[j + 1] ?? f.tip;
      const a0 = b.getWorldPosition(new THREE.Vector3());
      const dir0 = next ? next.getWorldPosition(new THREE.Vector3()).sub(a0) : new THREE.Vector3(0, 1, 0).transformDirection(b.matrixWorld);
      const ax = dir0.normalize().cross(palmN);
      if (ax.lengthSq() < 1e-10) continue;
      ax.normalize();
      /** проникновение фаланг j..конец при угле a */
      const test = (a: number) => {
        b.quaternion.copy(q0);
        if (a) rotWorld(b, ax, a);
        else b.updateMatrixWorld(true);
        let n = 0;
        for (let m = j; m < f.bones.length; m++) n = skinPts(f.skin[m], pts, n);
        let worst = -Infinity;
        for (let i = 0; i < n; i++) worst = Math.max(worst, pen(pts[i]));
        return worst;
      };
      let target = 0;
      if (w > 0.01) {
        const hi = lim[j] ?? 1;
        if (test(hi) <= 0) target = hi;
        else if (test(-0.3) > 0) target = -0.3;
        else {
          let a = -0.3, c = hi;
          for (let it = 0; it < 7; it++) {
            const m = (a + c) / 2;
            if (test(m) <= 0) a = m;
            else c = m;
          }
          target = a;
        }
        target *= w;
      }
      // сгиб плавный (без дрожи), но не глубже касания: разжать — сразу, сжать — с постоянной ~45 мс
      const prev = st.ang[fi][j];
      const cur = target < prev ? target : prev + (target - prev) * k;
      st.ang[fi][j] = cur;
      b.quaternion.copy(q0);
      if (cur) rotWorld(b, ax, cur);
      else b.updateMatrixWorld(true);
    }
    let n = 0;
    for (let m = 0; m < f.bones.length; m++) n = skinPts(f.skin[m], pts, n);
    for (let i = 0; i < n; i++) worstAll = Math.max(worstAll, pen(pts[i]) - TOL);
  });
  for (const b of base) worstAll = Math.max(worstAll, pen(b) - TOL);
  st.pen = Math.max(0, worstAll);
}
