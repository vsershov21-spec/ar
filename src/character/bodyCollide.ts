/**
 * Руки не проходят сквозь тело: клипы Mixamo сделаны под худого человека, а у котов круглый торс,
 * толстовка, наушники на шее и большая голова. Каждый кадр после клипа выталкиваем руку из «объёмов» тела.
 *
 * Объёмы строятся один раз из меша в позе покоя: вершины, у которых главная кость — таз/спина/шея/голова,
 * дают эллипсоид в системе этой кости (торс, шея с наушниками, голова). Дальше эллипсоиды едут вместе с костями.
 * Коррекция: точки руки (середина плеча, локоть, середина предплечья, запястье, кончик лапы) проверяются
 * на попадание; предплечье, потом плечо поворачиваются вокруг сустава, пока точка не выйдет на поверхность.
 */
import * as THREE from 'three';

interface Volume {
  bone: THREE.Object3D;
  /** центр и полуоси в системе кости (с учётом её масштаба — в единицах кости) */
  center: THREE.Vector3;
  radii: THREE.Vector3;
  name: string;
}

const GROUPS: Record<string, string[]> = {
  torso: ['Hips', 'Spine', 'Spine1', 'Spine2'],
  neck: ['Neck'],
  head: ['Head'],
};
const REF: Record<string, string> = { torso: 'Spine1', neck: 'Neck', head: 'Head' };

const strip = (n: string) => n.replace(/^mixamorig:?/, '');

export class BodyCollider {
  private vols: Volume[] = [];
  private v = new THREE.Vector3();
  private w = new THREE.Vector3();
  private m = new THREE.Matrix4();
  enabled = true;
  /** сколько раз за последний кадр пришлось выталкивать (для debug) */
  hits = 0;

  constructor(
    private root: THREE.Object3D,
    private bone: (n: string) => THREE.Object3D | undefined,
    /** толщина руки + зазор, в долях роста */
    private margin = 0.028,
  ) {}

  /** вызвать один раз после загрузки, модель в позе покоя */
  build(model: THREE.Object3D) {
    model.updateMatrixWorld(true);
    const pts: Record<string, THREE.Vector3[]> = { torso: [], neck: [], head: [] };
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
        const g = owner[bn];
        if (!g) continue;
        pts[g].push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(sm.matrixWorld));
      }
    });
    this.vols = [];
    for (const g of Object.keys(GROUPS)) {
      const b = this.bone(REF[g]);
      const P = pts[g];
      if (!b || P.length < 30) continue;
      const inv = this.m.copy(b.matrixWorld).invert();
      const L = P.map((p) => p.clone().applyMatrix4(inv));
      const c = L.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / L.length);
      // полуоси — 85-й перцентиль отклонения по осям (без торчащих деталей вроде капюшона)
      const q = (arr: number[]) => arr.sort((a, b) => a - b)[Math.floor(arr.length * 0.85)];
      const r = new THREE.Vector3(q(L.map((p) => Math.abs(p.x - c.x))), q(L.map((p) => Math.abs(p.y - c.y))), q(L.map((p) => Math.abs(p.z - c.z))));
      this.vols.push({ bone: b, center: c, radii: r, name: g });
    }
    return this.vols.map((v) => v.name);
  }

  /** глубина самого сильного проникновения руки в тело (0 — нет), без изменений позы — для проверки */
  measure(): number {
    this.root.updateMatrixWorld(true);
    let worst = 0;
    for (const side of ['Left', 'Right']) {
      const arm = this.bone(side + 'Arm');
      const fore = this.bone(side + 'ForeArm');
      const hand = this.bone(side + 'Hand');
      if (!arm || !fore || !hand) continue;
      const S = arm.getWorldPosition(new THREE.Vector3());
      const E = fore.getWorldPosition(new THREE.Vector3());
      const H = hand.getWorldPosition(new THREE.Vector3());
      const T = H.clone().add(H.clone().sub(E).multiplyScalar(0.45));
      for (const p of [S.clone().lerp(E, 0.5), E, E.clone().lerp(H, 0.5), H, T])
        for (const vol of this.vols) {
          const lp = p.clone().applyMatrix4(this.m.copy(vol.bone.matrixWorld).invert()).sub(vol.center);
          const d = Math.sqrt((lp.x / vol.radii.x) ** 2 + (lp.y / vol.radii.y) ** 2 + (lp.z / vol.radii.z) ** 2);
          if (d < 1) worst = Math.max(worst, 1 - d);
        }
    }
    return worst;
  }

  /** после клипа (кости уже в позе кадра) */
  apply() {
    this.hits = 0;
    if (!this.enabled || !this.vols.length) return;
    this.root.updateMatrixWorld(true);
    const rootScale = this.root.getWorldScale(this.v).x || 1;
    const marginW = this.margin * rootScale; // в мировых единицах
    for (const side of ['Left', 'Right']) {
      const arm = this.bone(side + 'Arm');
      const fore = this.bone(side + 'ForeArm');
      const hand = this.bone(side + 'Hand');
      if (!arm || !fore || !hand) continue;
      for (let it = 0; it < 8; it++) {
        const S = arm.getWorldPosition(new THREE.Vector3());
        const E = fore.getWorldPosition(new THREE.Vector3());
        const H = hand.getWorldPosition(new THREE.Vector3());
        const T = H.clone().add(H.clone().sub(E).multiplyScalar(0.45)); // кончик лапы
        let moved = false;
        // предплечье: точки ниже локтя, вращаем вокруг локтя
        for (const p of [T, H, E.clone().lerp(H, 0.5)]) if (this.push(fore, E, p, marginW)) { moved = true; break; }
        if (moved) continue;
        // плечо: середина плеча и локоть, вращаем вокруг плечевого сустава
        for (const p of [E, S.clone().lerp(E, 0.5)]) if (this.push(arm, S, p, marginW)) { moved = true; break; }
        if (!moved) break;
      }
    }
  }

  /** если точка внутри объёма — повернуть кость вокруг сустава так, чтобы точка вышла наружу */
  private push(bone: THREE.Object3D, joint: THREE.Vector3, p: THREE.Vector3, marginW: number) {
    for (const vol of this.vols) {
      const mw = vol.bone.matrixWorld;
      const inv = this.m.copy(mw).invert();
      const lp = this.v.copy(p).applyMatrix4(inv).sub(vol.center);
      // запас в единицах кости
      const bs = vol.bone.getWorldScale(this.w).x || 1;
      const mg = marginW / bs;
      const rx = vol.radii.x + mg;
      const ry = vol.radii.y + mg;
      const rz = vol.radii.z + mg;
      const d = Math.sqrt((lp.x / rx) ** 2 + (lp.y / ry) ** 2 + (lp.z / rz) ** 2);
      if (d >= 1 || d < 1e-4) continue;
      // ближайшая точка поверхности (по лучу из центра) → мировые координаты
      const target = lp.clone().multiplyScalar(1 / d).add(vol.center).applyMatrix4(mw);
      const a = p.clone().sub(joint);
      const b = target.sub(joint);
      if (a.lengthSq() < 1e-10 || b.lengthSq() < 1e-10) continue;
      const q = new THREE.Quaternion().setFromUnitVectors(a.normalize(), b.normalize());
      // мягко: не больше 25° за итерацию
      const ang = 2 * Math.acos(Math.min(1, Math.abs(q.w)));
      if (ang > 0.44) q.slerp(new THREE.Quaternion(), 1 - 0.44 / ang);
      const pq = bone.parent!.getWorldQuaternion(new THREE.Quaternion());
      const local = pq.clone().invert().multiply(q).multiply(pq);
      bone.quaternion.premultiply(local);
      bone.updateMatrixWorld(true);
      this.hits++;
      return true;
    }
    return false;
  }
}
