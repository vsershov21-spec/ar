/**
 * Ни рука, ни нога не проходят сквозь тело и одежду: клипы Mixamo / Meshy сделаны под худого человека, а у котов
 * круглый торс, худи, кепка, наушники, шарф, бант, юбка и большая голова с ушами. Каждый кадр после клипа точки рук
 * и голеней выталкиваются из «объёмов» (прокси) тела.
 *
 * Прокси (в системе своей кости, едут вместе с ней), docs/animations/COLLISION.md:
 *  1. public/models/<кот>_colliders.json (экспорт модельщика) — если есть, главнее всего;
 *  2. из меша в позе покоя: вершины, у которых главная кость — таз/спина/шея/голова, дают эллипсоиды торса, шеи и головы;
 *     меши одежды по имени (Cap_*, Headphones_*, Scarf_*, Bow_*, Skirt_*) — свой эллипсоид каждый; бёдра и голени —
 *     капсулы по вершинам ног; уши — капсулы по костям Ear;
 *  3. нет меша одежды — запас по характеру (PERSONA_PAD: кепка, наушники, шарф, бант, юбка) поверх эллипсоидов.
 * Карманы худи — разрешённые зоны: кисть в зоне кармана ложится на поверхность без зазора (у входа в карман), не глубже.
 *
 * Коррекция без IK: точка внутри прокси → кость поворачивается вокруг сустава на минимальный угол, чтобы точка вышла на
 * поверхность (предплечье вокруг локтя, потом плечо вокруг плеча; голень — бедро вокруг тазобедренного), не больше 25° за
 * итерацию и 1,2 рад всего. Сглаживание во времени: растущая поправка — сразу (проникновения нет ни кадра), уходящая —
 * плавно за ~0,1 с (без «щелчка», когда клип сам вышел из тела).
 * measurePairs() — глубина по парам «часть тела : прокси» (доли роста) для стенда реакций и проверки клипов Meshy.
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
}
/** карман: точки кисти в этой сфере (система кости) касаются тела без зазора */
export interface Pocket {
  bone: THREE.Object3D;
  center: THREE.Vector3;
  r: number;
}

/** формат public/models/<кот>_colliders.json — координаты в пространстве модели (рост 1, поза покоя) */
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
}

const tv = new THREE.Vector3();
const tm = new THREE.Matrix4();
const tq = new THREE.Quaternion();
const LEG = /Shin|Knee/;
/** предел поправки на кость, рад: клип совсем мимо тела — пусть лучше заденет, чем вывернет руку */
const MAX_CORR = 2.0;
const angOf = (q: THREE.Quaternion) => 2 * Math.acos(Math.min(1, Math.abs(q.w)));

/** глубина точки p (мир) в прокси (мировые единицы) и ближайшая точка поверхности с запасом mgW (мир) */
export function proxyDepth(px: Proxy, p: THREE.Vector3, mgW: number, out?: THREE.Vector3, side?: THREE.Vector3): number {
  const mw = px.bone.matrixWorld;
  const bs = px.bone.getWorldScale(tv).x || 1;
  const mg = mgW / bs;
  const lp = new THREE.Vector3().copy(p).applyMatrix4(tm.copy(mw).invert());
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
    const surf = lp.clone().multiplyScalar(1 / d);
    if (out) out.copy(surf).add(px.center).applyMatrix4(mw);
    return surf.length() * (1 - d) * bs;
  }
  const ab = new THREE.Vector3().copy(px.b).sub(px.a);
  const k = Math.min(1, Math.max(0, lp.clone().sub(px.a).dot(ab) / Math.max(1e-12, ab.lengthSq())));
  const c = px.a.clone().addScaledVector(ab, k);
  const dir = lp.clone().sub(c);
  let dist = dir.length();
  const R = px.r + mg;
  // нога о ногу: точка должна быть со своей стороны оси чужой ноги (side — «своя сторона», мир); скрестил — значит
  // проник насквозь: глубина до своей стороны, а не до ближайшей (иначе ногу дотолкнули бы дальше через другую)
  if (side && k > 0 && k < 1 && dist < R * 2.5) {
    const sl = side.clone().transformDirection(tm.copy(mw).invert());
    const axisN = ab.lengthSq() > 1e-12 ? ab.clone().normalize() : new THREE.Vector3(0, 1, 0);
    sl.addScaledVector(axisN, -sl.dot(axisN));
    if (sl.lengthSq() > 1e-10) {
      sl.normalize();
      const s = dir.dot(sl);
      if (s < 0) {
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
  /** сколько раз за последний кадр пришлось выталкивать (для debug) */
  hits = 0;
  /** характер: какие запасы PERSONA_PAD действуют */
  persona = 'hooligan';
  /** откуда прокси: json (экспорт модельщика) / mesh (меш + запасы) */
  source: 'json' | 'mesh' = 'mesh';
  /** поправка прошлого кадра по кости (локальная, поверх клипа) — уходящая гаснет плавно */
  private held = new Map<THREE.Object3D, THREE.Quaternion>();

  constructor(
    private root: THREE.Object3D,
    private bone: (n: string) => THREE.Object3D | undefined,
    /** толщина руки + зазор, в долях роста */
    private margin = 0.028,
    /** толщина голени + зазор, в долях роста */
    private legMargin = 0.03,
  ) {}

  /** вызвать один раз после загрузки, модель в позе покоя; json — public/models/<кот>_colliders.json, если есть */
  build(model: THREE.Object3D, json?: CollidersJson | null): string[] {
    model.updateMatrixWorld(true);
    this.proxies = [];
    this.pockets = [];
    this.held.clear();
    if (json?.volumes?.length) {
      this.fromJson(model, json);
      if (this.proxies.length) {
        this.source = 'json';
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
    return this.proxies.map((v) => v.name);
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
      const lp = new THREE.Vector3().copy(p).applyMatrix4(this.m.copy(pk.bone.matrixWorld).invert());
      if (lp.distanceTo(pk.center) < pk.r) return true;
    }
    return false;
  }

  /** точки рук и голеней в текущей позе */
  private points(): Pt[] {
    const out: Pt[] = [];
    const wp = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());
    for (const side of ['Left', 'Right']) {
      const S = side[0];
      const arm = this.bone(side + 'Arm'), fore = this.bone(side + 'ForeArm'), hand = this.bone(side + 'Hand');
      if (arm && fore && hand) {
        const Sh = wp(arm), E = wp(fore), H = wp(hand);
        const T = H.clone().add(H.clone().sub(E).multiplyScalar(0.45)); // кончик лапы
        const alt = { bone: arm, joint: Sh };
        out.push(
          { group: `${S}Hand`, p: T, bone: fore, joint: E, hand: true, alt },
          { group: `${S}Hand`, p: H, bone: fore, joint: E, hand: true, alt },
          { group: `${S}ForeArm`, p: E.clone().lerp(H, 0.5), bone: fore, joint: E, hand: false, alt },
          { group: `${S}Elbow`, p: E, bone: arm, joint: Sh, hand: false },
          { group: `${S}UpperArm`, p: Sh.clone().lerp(E, 0.5), bone: arm, joint: Sh, hand: false },
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
    return true;
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
    for (const pt of this.points())
      for (const px of this.proxies) {
        if (!this.relevant(pt, px)) continue;
        const d = proxyDepth(px, pt.p, 0, undefined, pt.side) / rs;
        if (d <= 1e-5) continue;
        const k = `${pt.group}:${px.name}`;
        out[k] = Math.max(out[k] ?? 0, d);
      }
    return out;
  }

  /** после клипа (кости уже в позе кадра); dt — сглаживание уходящей поправки (0 — без сглаживания: проверка клипа) */
  apply(dt = 1 / 30) {
    this.hits = 0;
    if (!this.enabled || !this.proxies.length) return;
    this.root.updateMatrixWorld(true);
    const rs = this.root.getWorldScale(new THREE.Vector3()).x || 1;
    const before = new Map<THREE.Object3D, THREE.Quaternion>();
    for (const n of ['LeftArm', 'LeftForeArm', 'RightArm', 'RightForeArm', 'LeftUpLeg', 'RightUpLeg']) {
      const b = this.bone(n);
      if (b) before.set(b, b.quaternion.clone());
    }
    // 1. выталкивание: за итерацию — каждая точка о первый прокси, в который она вошла; потом точки заново (до 24; без проникновения — одна)
    for (let it = 0; it < 24; it++) {
      let moved = false;
      // кость, уже повёрнутая в этой итерации, ждёт пересчёта точек (иначе перетолкнём по устаревшим)
      const done = new Set<THREE.Object3D>();
      for (const p0 of this.points()) {
        // вторая половина итераций: кисть и предплечье толкают и плечо (локтя одного не хватает — кисть глубоко)
        const pt = it >= 6 && p0.alt ? { ...p0, bone: p0.alt.bone, joint: p0.alt.joint } : p0;
        if (done.has(pt.bone) || done.has(pt.bone.parent!)) continue;
        if (this.legacy && LEG.test(pt.group)) continue;
        const mg = pt.hand && this.inPocket(pt.p) ? 0 : (LEG.test(pt.group) ? this.legMargin : this.margin) * rs;
        const how = this.push(pt, this.proxies.filter((px) => this.relevant(pt, px) && (!this.legacy || px.src === 'mesh')), mg);
        if (how === 'hard') {
          moved = true;
          done.add(pt.bone);
        }
      }
      if (!moved) break;
    }
    // 2. сглаживание: поправка = after · before⁻¹ (локально); растёт — сразу, уходит — плавно (~0,1 с)
    const k = dt > 0 && !this.legacy ? 1 - Math.exp(-dt / 0.08) : 1;
    let changed = false;
    for (const [b, q0] of before) {
      const corr = b.quaternion.clone().multiply(q0.clone().invert());
      const prev = this.held.get(b);
      let use = corr;
      if (prev && k < 1 && angOf(prev) > angOf(corr) + 1e-4) use = prev.clone().slerp(corr, k);
      // не больше 1,2 рад всего: клип совсем мимо тела — пусть лучше заденет, чем вывернет руку
      const a = angOf(use);
      if (a > MAX_CORR) use.slerp(new THREE.Quaternion(), 1 - MAX_CORR / a);
      if (angOf(use) < 1e-5) this.held.delete(b);
      else this.held.set(b, use.clone());
      if (use !== corr || a > MAX_CORR) changed = true;
      b.quaternion.copy(use).multiply(q0);
    }
    if (changed) this.root.updateMatrixWorld(true);
  }

  /** сбросить память сглаживания (проверка клипа, смена кота) */
  reset() {
    this.held.clear();
  }

  /**
   * Точка внутри прокси (+ зазор) — повернуть кость вокруг сустава так, чтобы точка вышла наружу. Мягкий контакт (без
   * «щелчка» на входе): во внешней половине зазора толкание растёт плавно (d²/2·band), глубже — точка выходит на ¾ зазора.
   */
  private push(pt: Pt, list: Proxy[], marginW: number): 'hard' | 'soft' | false {
    const rs = this.root.getWorldScale(tv).x || 1;
    // полоса мягкого входа — внешняя половина зазора; на глубине точка остаётся снаружи на ¾ зазора
    const band = Math.max(0.5 * marginW, 0.006 * rs);
    // точка сразу в нескольких прокси (кисть между головой и торсом, под козырьком): сдвиги складываются — наружу
    // по диагонали, а не «из головы в торс и обратно»
    const sum = new THREE.Vector3();
    const out = new THREE.Vector3();
    let soft = true;
    for (const px of list) {
      const d = proxyDepth(px, pt.p, marginW, out, pt.side);
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
    const pq = pt.bone.parent!.getWorldQuaternion(tq);
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
