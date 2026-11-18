/**
 * Клипы Meshy Text-to-Motion (docs/animations/MESHY.md) поверх библиотеки anims_v1.glb — только lab
 * (feature('anims.meshy'); ?meshy=0 — выключить). Сервер кладёт их в /models/anims/meshy/<id>.glb + manifest.json
 * (scripts/meshy/motion-run.sh); здесь — загрузка после кота, перенос на наш скелет и регистрация под id ТЗ.
 *
 * Перенос (retargetClip): у Meshy свой скелет Mixamo, привязанный к той же модели Хулигана, но локальные оси костей
 * другие (у нашего рига Tripo Hips повёрнут на −90° вокруг Y, у Meshy — нет). Поэтому кватернионы не копируются,
 * а переносится поворот кости в мире относительно позы привязки: D = Wсейчас · Wпривязки⁻¹ (источник), у нас
 * Wсейчас = D · Wпривязки, локальный = Wродителя⁻¹ · W. Позы привязки у обоих — поза меша (одна и та же модель).
 * Кости сопоставляются по имени без префикса mixamorig / mixamorig: (регистр не важен); пальцы, *_End, HeadTop —
 * выбрасываются (правило make_anim_lib / animPrep), хвоста и ушей у Meshy нет — их ведёт TailRig. Корень: смещение
 * Hips от привязки × (высота таза у нас / у источника); горизонталь потом обнуляет animPrep (место держит сцена).
 */
import * as THREE from 'three';

/** имя кости → ключ сопоставления: «mixamorig:LeftArm», «mixamorigLeftArm_1», «Armature|mixamorig5:LeftArm» → leftarm */
export function normBone(name: string): string {
  return name
    .replace(/^.*[|/]/, '')
    .replace(/_\d+$/, '')
    .replace(/^.*:/, '')
    .replace(/^mixamorig\d*/i, '')
    .toLowerCase();
}

/** кости, которые не переносим: пальцы, концевые, макушка (как make_anim_lib.py), глаза/челюсть — лицо */
export const SKIP_BONE = /thumb|index|middle|ring|pinky|_end$|end$|headtop|eye|jaw|tongue/;

export interface SkelBone {
  key: string;
  /** имя узла для трека (PropertyBinding) */
  node: string;
  parent: string | null;
  /** локальная поза покоя (TRS узла) */
  restQ: THREE.Quaternion;
  restP: THREE.Vector3;
  /** поза привязки в пространстве корня модели */
  bindQ: THREE.Quaternion;
  bindP: THREE.Vector3;
  /** у корневых костей: матрица родителя в пространстве корня модели */
  parentM: THREE.Matrix4 | null;
  /** матрица родительского узла в покое (для смещения таза: родитель Hips — неподвижный Armature) */
  parentRest: THREE.Matrix4;
}

export interface Skel {
  bones: Map<string, SkelBone>;
  /** родители раньше детей */
  order: string[];
  hips: string | null;
  /** высота таза над стопами в позе привязки (единицы пространства корня) */
  hipsH: number;
}

const tmpS = new THREE.Vector3();

/**
 * Скелет модели: кости (или все узлы с именем, если костей нет — у «облегчённого» GLB Meshy мешей нет) с позой
 * покоя и привязки. Привязка: userData.bindWorld (облегчённый GLB, scripts/meshy/motion.mjs), иначе boneInverses
 * скина, иначе — текущая поза узлов (считаем её позой привязки).
 */
export function skelFrom(root: THREE.Object3D, pick: (o: THREE.Object3D) => boolean = (o) => (o as THREE.Bone).isBone): Skel {
  root.updateMatrixWorld(true);
  const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const rel = (o: THREE.Object3D) => new THREE.Matrix4().multiplyMatrices(rootInv, o.matrixWorld);
  const inv = new Map<THREE.Object3D, THREE.Matrix4>();
  root.traverse((o) => {
    const sk = (o as THREE.SkinnedMesh).isSkinnedMesh ? (o as THREE.SkinnedMesh).skeleton : null;
    if (sk) sk.bones.forEach((b, i) => !inv.has(b) && sk.boneInverses[i] && inv.set(b, sk.boneInverses[i]));
  });
  const objs = new Map<string, THREE.Object3D>();
  const order: string[] = [];
  root.traverse((o) => {
    if (o === root || !o.name || !pick(o)) return;
    const key = normBone(o.name);
    if (!key || objs.has(key)) return;
    objs.set(key, o);
    order.push(key); // traverse — родитель раньше детей
  });
  const keyOf = new Map<THREE.Object3D, string>();
  objs.forEach((o, k) => keyOf.set(o, k));
  const bones = new Map<string, SkelBone>();
  for (const key of order) {
    const o = objs.get(key)!;
    let par: THREE.Object3D | null = o.parent;
    // ближайший предок из набора (между ними могут быть служебные узлы)
    while (par && par !== root && !keyOf.has(par)) par = par.parent;
    const parent = par && keyOf.has(par) ? keyOf.get(par)! : null;
    const bw = o.userData?.bindWorld as number[] | undefined;
    const m = Array.isArray(bw) && bw.length === 16 ? new THREE.Matrix4().fromArray(bw) : inv.has(o) ? new THREE.Matrix4().copy(inv.get(o)!).invert() : rel(o);
    const bindQ = new THREE.Quaternion();
    const bindP = new THREE.Vector3();
    m.decompose(bindP, bindQ, tmpS);
    bones.set(key, {
      key,
      node: THREE.PropertyBinding.sanitizeNodeName(o.name),
      parent,
      restQ: o.quaternion.clone(),
      restP: o.position.clone(),
      bindQ,
      bindP,
      parentM: parent ? null : o.parent ? rel(o.parent) : new THREE.Matrix4(),
      parentRest: o.parent ? rel(o.parent) : new THREE.Matrix4(),
    });
  }
  const hips = bones.has('hips') ? 'hips' : order[0] ?? null;
  let low = Infinity;
  for (const [k, b] of bones) if (/foot|toebase/.test(k)) low = Math.min(low, b.bindP.y);
  if (!Number.isFinite(low)) for (const b of bones.values()) low = Math.min(low, b.bindP.y);
  const hy = hips ? bones.get(hips)!.bindP.y : 0;
  const hipsH = hy - low > 1e-6 ? hy - low : Math.abs(hy) || 1;
  return { bones, order, hips, hipsH };
}

export interface RetargetInfo {
  matched: string[];
  /** кости источника без пары у нас (или выброшенные правилом SKIP_BONE) */
  dropped: string[];
  scale: number;
}

const nodeOf = (n: string) => n.slice(0, n.lastIndexOf('.'));
const propOf = (n: string) => n.slice(n.lastIndexOf('.') + 1);

/**
 * Клип источника (треки по узлам src) → новый клип на кости dst (исходный не меняется). 30 к/с; дальше — animPrep.
 */
export function retargetClip(clip: THREE.AnimationClip, src: Skel, dst: Skel, name = clip.name, fps = 30): { clip: THREE.AnimationClip; info: RetargetInfo } {
  const byNode = new Map<string, string>();
  src.bones.forEach((b) => byNode.set(b.node, b.key));
  const rotT = new Map<string, THREE.Interpolant>();
  let posT: THREE.Interpolant | null = null;
  for (const t of clip.tracks) {
    const key = byNode.get(nodeOf(t.name)) ?? byNode.get(nodeOf(t.name).replace(/_\d+$/, ''));
    if (!key) continue;
    const it = (t as unknown as { createInterpolant(): THREE.Interpolant }).createInterpolant();
    if (propOf(t.name) === 'quaternion') rotT.set(key, it);
    else if (propOf(t.name) === 'position' && key === src.hips) posT = it;
  }
  const matched = dst.order.filter((k) => src.bones.has(k) && !SKIP_BONE.test(k));
  const matchedSet = new Set(matched);
  const dropped = src.order.filter((k) => !matchedSet.has(k) && rotT.has(k));
  const scale = dst.hipsH / (src.hipsH || 1);

  const dur = Math.max(clip.duration, 1 / fps);
  const n = Math.max(2, Math.round(dur * fps) + 1);
  const times = new Float32Array(n);
  const qv = new Map<string, Float32Array>(matched.map((k) => [k, new Float32Array(n * 4)]));
  const hv = dst.hips && src.hips && matchedSet.has(dst.hips) ? new Float32Array(n * 3) : null;

  // постоянное: обратные позы привязки источника, рамки корневых костей
  const srcBindInv = new Map<string, THREE.Quaternion>();
  src.bones.forEach((b, k) => srcBindInv.set(k, b.bindQ.clone().invert()));
  const frameQ = (b: SkelBone) => {
    const q = new THREE.Quaternion();
    b.parentM!.decompose(tmpS.set(0, 0, 0), q, new THREE.Vector3());
    return q;
  };
  const srcFrame = new Map<string, THREE.Quaternion>();
  src.bones.forEach((b, k) => b.parentM && srcFrame.set(k, frameQ(b)));
  const dstFrame = new Map<string, THREE.Quaternion>();
  dst.bones.forEach((b, k) => b.parentM && dstFrame.set(k, frameQ(b)));
  const dstParentInvM = dst.hips ? new THREE.Matrix4().copy(dst.bones.get(dst.hips)!.parentRest).invert() : null;
  const srcHips = src.hips ? src.bones.get(src.hips)! : null;
  const dstHips = dst.hips ? dst.bones.get(dst.hips)! : null;

  const Ws = new Map<string, THREE.Quaternion>();
  const Wt = new Map<string, THREE.Quaternion>();
  src.order.forEach((k) => Ws.set(k, new THREE.Quaternion()));
  dst.order.forEach((k) => Wt.set(k, new THREE.Quaternion()));
  const L = new THREE.Quaternion();
  const D = new THREE.Quaternion();
  const loc = new THREE.Quaternion();
  const p = new THREE.Vector3();

  for (let i = 0; i < n; i++) {
    const t = Math.min(clip.duration, i / fps);
    times[i] = i / fps;
    for (const k of src.order) {
      const b = src.bones.get(k)!;
      const it = rotT.get(k);
      if (it) L.fromArray(it.evaluate(t) as unknown as number[]).normalize();
      else L.copy(b.restQ);
      const w = Ws.get(k)!;
      if (b.parent) w.multiplyQuaternions(Ws.get(b.parent)!, L);
      else w.multiplyQuaternions(srcFrame.get(k)!, L);
    }
    for (const k of dst.order) {
      const b = dst.bones.get(k)!;
      const w = Wt.get(k)!;
      const pw = b.parent ? Wt.get(b.parent)! : dstFrame.get(k)!;
      if (matchedSet.has(k)) {
        D.multiplyQuaternions(Ws.get(k)!, srcBindInv.get(k)!);
        w.multiplyQuaternions(D, b.bindQ);
        loc.copy(pw).invert().multiply(w);
        const arr = qv.get(k)!;
        // непрерывность знака (иначе slerp между кадрами — через длинную дугу)
        if (i > 0 && arr[(i - 1) * 4] * loc.x + arr[(i - 1) * 4 + 1] * loc.y + arr[(i - 1) * 4 + 2] * loc.z + arr[(i - 1) * 4 + 3] * loc.w < 0) loc.set(-loc.x, -loc.y, -loc.z, -loc.w);
        loc.toArray(arr, i * 4);
      } else w.multiplyQuaternions(pw, b.restQ);
    }
    if (hv && srcHips && dstHips && dstParentInvM) {
      if (posT) {
        p.fromArray(posT.evaluate(t) as unknown as number[]).applyMatrix4(srcHips.parentRest);
        p.sub(srcHips.bindP).multiplyScalar(scale).add(dstHips.bindP);
      } else p.copy(dstHips.bindP);
      p.applyMatrix4(dstParentInvM).toArray(hv, i * 3);
    }
  }
  const tracks: THREE.KeyframeTrack[] = matched.map((k) => new THREE.QuaternionKeyframeTrack(`${dst.bones.get(k)!.node}.quaternion`, times, qv.get(k)!));
  if (hv && dstHips) tracks.push(new THREE.VectorKeyframeTrack(`${dstHips.node}.position`, times, hv));
  return { clip: new THREE.AnimationClip(name, (n - 1) / fps, tracks), info: { matched, dropped, scale } };
}

// ───────────── манифест ─────────────

export interface MeshyEntry {
  id: string;
  file: string;
  loop: boolean;
  duration: number;
}

export const MESHY_DIR = 'models/anims/meshy/';

/** manifest.json → записи (битые пропускаем; файл — только имя в папке meshy, без «..» и путей) */
export function parseManifest(j: unknown): MeshyEntry[] {
  const list = (j as { clips?: unknown })?.clips;
  if (!Array.isArray(list)) return [];
  const out: MeshyEntry[] = [];
  const seen = new Set<string>();
  for (const c of list as Record<string, unknown>[]) {
    const id = typeof c?.id === 'string' ? c.id : '';
    const file = typeof c?.file === 'string' ? c.file : `${id}.glb`;
    if (!/^[a-z0-9_]+$/.test(id) || !/^[\w.-]+\.glb$/.test(file) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, file, loop: c.loop === true, duration: typeof c.duration === 'number' ? c.duration : 0 });
  }
  return out;
}

/** включено ли: lab (feature) и не ?meshy=0 */
export function meshyWanted(on: boolean, search = typeof location !== 'undefined' ? location.search : ''): boolean {
  return on && new URLSearchParams(search).get('meshy') !== '0';
}

/** то, что нужно загрузчику от персонажа (GlbCharacter.addExternalClip) */
export interface ExternalClipHost {
  readonly skel: Skel | null;
  addExternalClip(id: string, clip: THREE.AnimationClip, loop: boolean, src: string): Promise<void>;
}

type Parsed = { clip: THREE.AnimationClip; skel: Skel } | null;
/** разобранные GLB — общие для всех котов (смена характера не качает заново) */
const cache = new Map<string, Promise<Parsed>>();
let manifestP: Promise<MeshyEntry[]> | null = null;

export interface LoadDeps {
  fetchJson: (url: string) => Promise<unknown | null>;
  loadGlb: (url: string) => Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] }>;
  log?: (m: string) => void;
}

/** самый длинный клип GLB (у Meshy один) и скелет источника */
function parse(g: { scene: THREE.Object3D; animations: THREE.AnimationClip[] }): Parsed {
  const clip = [...g.animations].sort((a, b) => b.duration - a.duration)[0];
  if (!clip) return null;
  let hasBones = false;
  g.scene.traverse((o) => (hasBones ||= !!(o as THREE.Bone).isBone));
  const skel = skelFrom(g.scene, hasBones ? (o) => !!(o as THREE.Bone).isBone : (o) => !(o as THREE.Mesh).isMesh);
  // геометрия и текстуры источника не нужны (облегчённый GLB их и не содержит)
  g.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
    for (const x of mats) {
      for (const v of Object.values(x)) if ((v as THREE.Texture)?.isTexture) (v as THREE.Texture).dispose();
      x.dispose();
    }
  });
  return skel.bones.size ? { clip, skel } : null;
}

/**
 * Загрузить клипы из манифеста и отдать персонажу (по одному, лениво — после того как кот уже стоит).
 * Нет манифеста (404) — ничего. Возвращает id зарегистрированных клипов.
 */
export async function loadMeshyClips(host: ExternalClipHost, deps: LoadDeps, base = MESHY_DIR): Promise<string[]> {
  if (!host.skel) return [];
  manifestP ??= deps.fetchJson(base + 'manifest.json').then((j) => parseManifest(j)).catch(() => []);
  const list = await manifestP;
  const done: string[] = [];
  for (const e of list) {
    const url = base + e.file;
    if (!cache.has(url)) cache.set(url, deps.loadGlb(url).then(parse).catch((err) => (deps.log?.(`[meshy] ${e.id}: ${(err as Error).message ?? err}`), null)));
    const p = await cache.get(url)!;
    if (!p) continue;
    const { clip, info } = retargetClip(p.clip, p.skel, host.skel, e.id);
    if (!clip.tracks.length) {
      deps.log?.(`[meshy] ${e.id}: ни одной общей кости`);
      continue;
    }
    await host.addExternalClip(e.id, clip, e.loop, `meshy ${info.matched.length} костей`);
    done.push(e.id);
  }
  if (done.length) deps.log?.(`[meshy] клипы: ${done.join(', ')}`);
  return done;
}

/** для тестов: сбросить кэш манифеста и GLB */
export function resetMeshyCache() {
  cache.clear();
  manifestP = null;
}
