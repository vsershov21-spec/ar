/**
 * BodyCollider по поверхности (19.11, «руки проникают в наушники»): точки поверхности кисти/предплечья из сетки скина,
 * скин на ЦП, выталкивание всех точек из прокси головы/наушников, контакт в клипах «лапы на голове», плавность.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BodyCollider, CAT_MM, CONTACT_BAND, CONTACT_CLIPS, SURF_N, proxyDepth, proxyGap, worstPair, type Proxy } from '../src/character/bodyCollide';

const mm = (d: number) => d * CAT_MM;

/** кот ростом 1 со скином: кисть — «лапа» 10×4×10 см на LeftHand, предплечье — цилиндр r 2,5 см на LeftForeArm */
function rig() {
  const root = new THREE.Group();
  const mk = (name: string, parent: THREE.Object3D, pos: [number, number, number]) => {
    const b = new THREE.Bone();
    b.name = 'mixamorig' + name;
    b.position.set(...pos);
    parent.add(b);
    return b;
  };
  const hips = mk('Hips', root, [0, 0.45, 0]);
  const spine1 = mk('Spine1', hips, [0, 0.15, 0]);
  const neck = mk('Neck', spine1, [0, 0.12, 0]);
  const head = mk('Head', neck, [0, 0.08, 0]);
  const arm = mk('LeftArm', spine1, [0.15, 0.08, 0]);
  const fore = mk('LeftForeArm', arm, [0.12, 0, 0]);
  const hand = mk('LeftHand', fore, [0.12, 0, 0]);
  const finger = mk('LeftHandIndex1', hand, [0.04, 0, 0]);
  const bones = [hips, spine1, neck, head, arm, fore, hand, finger];
  root.updateMatrixWorld(true);
  // сетка в позе привязки (мир = модель): кисть и предплечье
  const geos: THREE.BufferGeometry[] = [];
  const handG = new THREE.BoxGeometry(0.1, 0.04, 0.1, 4, 2, 4).translate(0.15 + 0.12 + 0.12 + 0.04, 0.6 + 0.08, 0);
  const foreG = new THREE.CylinderGeometry(0.025, 0.025, 0.12, 10, 3).rotateZ(Math.PI / 2).translate(0.15 + 0.12 + 0.06, 0.6 + 0.08, 0);
  geos.push(handG, foreG);
  const skin = (g: THREE.BufferGeometry, bi: number) => {
    const n = g.attributes.position.count;
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(n * 4).fill(0).map((_, i) => (i % 4 === 0 ? bi : 0)), 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Array(n * 4).fill(0).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4));
  };
  skin(handG, 6);
  skin(foreG, 5);
  const skeleton = new THREE.Skeleton(bones);
  for (const g of geos) {
    const m = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial());
    m.name = 'Body';
    root.add(m);
    m.bind(skeleton);
  }
  root.updateMatrixWorld(true);
  const by: Record<string, THREE.Object3D> = { Hips: hips, Spine1: spine1, Neck: neck, Head: head, LeftArm: arm, LeftForeArm: fore, LeftHand: hand };
  const col = new BodyCollider(root, (n) => by[n]);
  return { root, col, arm, fore, hand, head, neck, spine1 };
}

/** прокси из json: голова и «наушник» — капсула у левой щеки */
const JSON1 = {
  version: 1,
  volumes: [
    { name: 'head', bone: 'Head', type: 'ellipsoid' as const, center: [0, 0.8, 0], radii: [0.13, 0.12, 0.12] },
    { name: 'headphones_cup_L', bone: 'Neck', type: 'capsule' as const, a: [0.12, 0.7, -0.02], b: [0.12, 0.7, 0.02], r: 0.04 },
  ],
};

/** рука к щеке: плечо вверх-вперёд, локоть согнут — кисть уходит в наушник/голову */
function toCheek(r: ReturnType<typeof rig>, k = 1) {
  r.arm.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.9 * k);
  r.fore.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 1.75 * k);
  r.root.updateMatrixWorld(true);
}

describe('BodyCollider: точки поверхности', () => {
  it('из сетки скина: кисть 16 и предплечье 10 точек, на поверхности (не на оси), скин следует за костью', () => {
    const r = rig();
    r.col.build(r.root, JSON1);
    const hand = r.col.samples.filter((s) => s.group === 'LHand');
    const fore = r.col.samples.filter((s) => s.group === 'LForeArm');
    expect(hand.length).toBe(SURF_N.hand);
    expect(fore.length).toBe(SURF_N.fore);
    // точки предплечья — на цилиндре (≈ 2,5 см + мех от оси), не на оси
    for (const s of fore) {
      const p = (r.col as any).skin(s) as THREE.Vector3;
      expect(Math.hypot(p.y - 0.68, p.z)).toBeGreaterThan(0.02);
    }
    // равномерно: точки кисти не слиплись
    const P = hand.map((s) => ((r.col as any).skin(s) as THREE.Vector3).clone());
    let dmin = Infinity;
    for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) dmin = Math.min(dmin, P[i].distanceTo(P[j]));
    expect(dmin).toBeGreaterThan(0.005);
    // поворот предплечья — точки кисти едут вместе с ним (скин на ЦП = матрицы костей)
    const before = ((r.col as any).skin(hand[0]) as THREE.Vector3).clone();
    r.fore.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.5);
    r.root.updateMatrixWorld(true);
    const after = ((r.col as any).skin(hand[0]) as THREE.Vector3).clone();
    const expected = before.clone().sub(r.fore.getWorldPosition(new THREE.Vector3())).applyAxisAngle(new THREE.Vector3(0, 0, 1), 0.5).add(r.fore.getWorldPosition(new THREE.Vector3()));
    expect(after.distanceTo(expected)).toBeLessThan(1e-6);
  });

  it('кисть в наушнике/голове → все точки поверхности снаружи (≤ 1 мм на карте), ось кости одна этого бы не дала', () => {
    const r = rig();
    r.col.build(r.root, JSON1);
    toCheek(r);
    const d0 = worstPair(r.col.measurePairs());
    expect(d0.pair).toMatch(/^L(Hand|ForeArm):(head|headphones_cup_L)$/);
    expect(mm(d0.depth)).toBeGreaterThan(1.5);
    r.col.apply(0);
    expect(mm(r.col.measure())).toBeLessThan(1);
  });

  it('прошлая коррекция по осям (?collide=axis) оставляет край лапы в наушнике — по поверхности выталкивается', () => {
    const r = rig();
    r.col.build(r.root, JSON1);
    // наушник сбоку от кисти (вдоль неё): край лапы (z = 5 см) в нём, точки на оси кисти (z = 0) — снаружи с запасом
    const cup = r.col.proxies.find((p) => p.name === 'headphones_cup_L')!;
    const inv = r.neck.matrixWorld.clone().invert();
    cup.a.set(0.36, 0.68, 0.075).applyMatrix4(inv);
    cup.b.set(0.48, 0.68, 0.075).applyMatrix4(inv);
    cup.r = 0.03;
    r.root.updateMatrixWorld(true);
    expect(mm(worstPair(r.col.measurePairs()).depth)).toBeGreaterThan(0.5);
    r.col.axis = true;
    r.col.apply(0);
    const axis = mm(r.col.measure());
    expect(axis).toBeGreaterThan(0.5); // оси не видят — лапа так и осталась в наушнике
    r.col.axis = false;
    r.col.reset();
    r.arm.quaternion.identity();
    r.fore.quaternion.identity();
    r.root.updateMatrixWorld(true);
    r.col.apply(0);
    expect(mm(r.col.measure())).toBeLessThan(0.1);
  });

  it('клип-контакт: лапа, зависшая над наушником ≤ полосы, ложится на поверхность (зазор ~0), вне клипа — нет', () => {
    const r = rig();
    r.col.build(r.root, JSON1);
    expect(CONTACT_CLIPS.test('cover_ears')).toBe(true);
    expect(CONTACT_CLIPS.test('idle_hooligan_headphones')).toBe(true);
    expect(CONTACT_CLIPS.test('scratch_glass')).toBe(false);
    expect(CONTACT_CLIPS.test('wave_goodbye_01')).toBe(false);
    const gapOf = () => {
      let g = Infinity;
      const o = new THREE.Vector3();
      for (const s of r.col.samples) if (s.hand) for (const px of r.col.proxies) g = Math.min(g, proxyGap(px, (r.col as any).skin(s), o));
      return g;
    };
    // подобрать позу «чуть не дотянулась»: зазор 1…2 % роста
    let k = 0.7;
    for (; k < 1; k += 0.01) {
      toCheek(r, k);
      const g = gapOf();
      if (g < 0.02) break;
    }
    const g0 = gapOf();
    expect(g0).toBeGreaterThan(0.003);
    expect(g0).toBeLessThan(CONTACT_BAND);
    r.col.setClip('wave');
    r.col.apply(0);
    expect(gapOf()).toBeCloseTo(g0, 4); // не контакт — не трогаем
    toCheek(r, k);
    r.col.setClip('cover_ears');
    r.col.reset();
    r.col.apply(0);
    const g1 = gapOf();
    expect(g1).toBeLessThan(0.003);
    expect(g1).toBeGreaterThan(-0.0005); // на поверхности, не внутри
  });

  it('плавность: поправка не прыгает (≤ 20 рад/с; предел — 10), вход/выход контакта — за ~100 мс', () => {
    const r = rig();
    r.col.build(r.root, JSON1);
    const ang = (q: THREE.Quaternion) => 2 * Math.acos(Math.min(1, Math.abs(q.w)));
    let prev: THREE.Quaternion | null = null;
    let maxW = 0;
    r.col.setClip('cover_ears');
    // рука медленно (как клип) идёт к щеке и обратно, 30 к/с
    for (let i = 0; i <= 60; i++) {
      const k = 0.6 + 0.4 * Math.sin((Math.PI * i) / 60);
      toCheek(r, k);
      r.col.apply(1 / 30);
      const q = r.fore.quaternion.clone().premultiply(r.arm.quaternion);
      // скорость самой поправки: поза минус клип
      const clip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.9 * k).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 1.75 * k));
      const corr = q.clone().multiply(clip.invert());
      if (prev) maxW = Math.max(maxW, ang(corr.clone().multiply(prev.clone().invert())) * 30);
      prev = corr;
      expect(mm(r.col.measure())).toBeLessThan(1);
    }
    expect(maxW).toBeLessThan(20);
    // вес контакта: за 1 кадр не весь, за 0,2 с — весь
    r.col.setClip('wave');
    r.col.apply(1 / 30);
    expect(r.col.contactW).toBeGreaterThan(0.5);
    for (let i = 0; i < 6; i++) r.col.apply(1 / 30);
    expect(r.col.contactW).toBe(0);
  });

  it('точка, сидящая в прокси уже в позе покоя (рукав у капюшона), не толкается', () => {
    const r = rig();
    r.col.build(r.root, { version: 1, volumes: [...JSON1.volumes, { name: 'hood', bone: 'Spine1', type: 'ellipsoid', center: [0.3, 0.68, 0], radii: [0.05, 0.05, 0.05] }] });
    const hood = r.col.proxies.find((p: Proxy) => p.name === 'hood')!;
    expect(r.col.samples.some((s) => s.skip.has(hood))).toBe(true);
    expect(Object.keys(r.col.measurePairs()).filter((k) => /^L(Hand|ForeArm):hood$/.test(k))).toEqual([]);
    expect(proxyDepth(hood, new THREE.Vector3(0.3, 0.68, 0), 0)).toBeGreaterThan(0);
  });
});

describe('прокси v1 (public/models/<кот>_v1_colliders.json, scripts/models/colliders.py по v1 GLB)', () => {
  it('у всех трёх котов есть голова, уши, шея, туловище, ноги; у Хулигана — кепка и наушники (чашки + дуга), у Добряка — шарф, у Блёстки — бант', async () => {
    const fs = await import('node:fs');
    const want: Record<string, RegExp[]> = {
      hooligan: [/^cap$/, /^headphones_cup_L$/, /^headphones_cup_R$/, /^headphones_band_\d+$/],
      kind: [/^scarf_\d+$/],
      glitter: [/^bow$/],
    };
    for (const cat of ['hooligan', 'kind', 'glitter']) {
      const j = JSON.parse(fs.readFileSync(`public/models/${cat}_v1_colliders.json`, 'utf8'));
      const names: string[] = j.volumes.map((v: { name: string }) => v.name);
      for (const re of [/^head$/, /^ear_L$/, /^ear_R$/, /^neck$/, /^torso$/, /^thigh_L$/, /^shin_R$/, ...want[cat]]) expect(names.some((n) => re.test(n)), `${cat}: ${re}`).toBe(true);
      // дуга наушников v1 — по самой детали, не толще 5 % роста (кольцо-окружность было бы толще)
      for (const v of j.volumes) if (/^headphones_band/.test(v.name)) expect(v.r).toBeLessThan(0.05);
    }
  });
});

describe('кольца у шеи: продетая рука выходит наружу, а не к шее', () => {
  it('точка внутри трубки дуги со стороны центра кольца — выход наружу (глубже, чем ближний выход), плавно по углу', () => {
    const b = new THREE.Bone();
    b.updateMatrixWorld(true);
    const px: Proxy = { name: 'headphones_band_0', kind: 'capsule', bone: b, center: new THREE.Vector3(), radii: new THREE.Vector3(), a: new THREE.Vector3(0.15, 0, -0.05), b: new THREE.Vector3(0.15, 0, 0.05), r: 0.03, src: 'json' };
    const out = new THREE.Vector3();
    const side = new THREE.Vector3(1, 0, 0); // наружу — +X (центр кольца в 0)
    const inner = new THREE.Vector3(0.135, 0, 0); // внутри трубки, со стороны центра
    const near = proxyDepth(px, inner, 0);
    const ring = proxyDepth(px, inner, 0, out, side, false, 0.5);
    expect(near).toBeCloseTo(0.015, 5);
    expect(ring).toBeGreaterThan(near);
    expect(out.x).toBeGreaterThan(0.15); // выход — снаружи кольца
    // по углу — без скачка: точки на окружности вокруг оси дают непрерывную глубину
    let prev = -1, jump = 0;
    for (let a = 0; a <= Math.PI; a += Math.PI / 90) {
      const p = new THREE.Vector3(0.15 - 0.015 * Math.cos(a), 0.015 * Math.sin(a), 0);
      const d = proxyDepth(px, p, 0, undefined, side, false, 0.5);
      if (prev >= 0) jump = Math.max(jump, Math.abs(d - prev));
      prev = d;
    }
    expect(jump).toBeLessThan(0.005); // шаг 2°: плавно (жёсткое «насквозь», как у ног, дало бы скачок 0,015)
  });
});
