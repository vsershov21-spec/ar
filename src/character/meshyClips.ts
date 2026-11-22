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

/**
 * Клипы Meshy, выключенные в пилоте (/mvp): на стенде аудита (scripts/qa/anim-audit, прогон 22.11 с клипами сервера)
 * дают ребёнку видимый брак — уход под пол, руку сквозь тело, рывок, скольжение — или выглядят хуже процедурной версии.
 * Не перегенерируем: в пилоте их просто не грузим, играет опора / процедурная версия (как без клипа). id → причина
 * (таблица — docs/qa/anim-audit/2026-11-22_meshy.md). В lab грузятся как раньше.
 */
export const PILOT_MESHY_OFF: Readonly<Record<string, string>> = {
  // скейт по фазам: рука сквозь торс/дугу наушников 7–11,5 мм в 22–70 % кадров (процедурная версия — 2 мм)
  skate_hop_on: 'рука сквозь торс 9 мм в половине кадров',
  skate_cruise: 'рука сквозь торс 11,5 мм в 22 % кадров',
  skate_ollie_air: 'предплечье сквозь наушники 7,8 мм в 70 % кадров',
  skate_hop_off: 'рука сквозь торс 9,7 мм в 26 % кадров',
  // тела «с предметом»: хуже процедурной версии
  hold_sip_body: 'Какао: рывок 58 рад/с, предплечье сквозь капюшон 10,5 мм',
  hold_treat_body: 'Угостить: плечо сквозь шарф/наушники > 5 мм в 1,5–3 раза чаще процедурной версии',
  hold_mirror_body: 'Зеркальце: кисть в голове 8,6 мм (процедурная — 0)',
  // раскраска Хулигана
  spray_low_sweep: 'Раскраска: рывок 78–91 рад/с, предплечье сквозь наушники 7,6 мм',
  jump: 'рывок предплечья 65–67 рад/с в начале прыжка (смена кота у Блёстки; своя версия — ≤ 29)',
  brush_dip_stroke: 'Раскраска (Блёстка): рывок правой лапы 91 рад/с',
  paint_spray: 'стоит боком/спиной к зрителю в 31 % кадров (своя версия — 0 %)',
  // покой
  idle_glitter_twirl: 'кисть в юбке 7,1 мм, спиной к зрителю чаще своей версии (31 % против 12 %)',
  idle_look_around: 'отворачивается от зрителя > 60° в 6–8 % кадров (своя версия — 0 %)',
  sit_down: 'тело уходит под пол на 5,4 мм',
};

/** включено ли: lab (feature) и не ?meshy=0 */
export function meshyWanted(on: boolean, search = typeof location !== 'undefined' ? location.search : ''): boolean {
  return on && new URLSearchParams(search).get('meshy') !== '0';
}

// ───────────── проверка клипа ─────────────

/** пределы поворота сустава от позы покоя, рад (локально): шея/голова/стопа ~100°, спина ~110°, кисть ~120° */
const JOINT_LIMIT: [RegExp, number][] = [
  [/^(neck|head)$/, 1.75],
  [/^spine\d*$/, 1.9],
  [/foot$/, 1.75],
  [/hand$/, 2.1],
  [/(leg|upleg)$/, 2.9],
  [/(arm|forearm|shoulder)$/, Math.PI],
];
/** скачок за кадр (30 к/с), рад: больше — сломанный кадр (сальто — ~0,2 рад/кадр) */
const SPIKE = 1.6;

export interface ClipCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Санитарная проверка клипа после переноса на наш скелет (dst): NaN/∞, длительность, огромное смещение таза
 * (> 3 высот таза по горизонтали, > 2 — по вертикали: ошибка масштаба, единицы см вместо м), поворот сустава за предел
 * (JOINT_LIMIT от позы покоя) или скачок за кадр. Не прошёл — клип не регистрируем, играет опора (fallback).
 */
export function checkClip(clip: THREE.AnimationClip, dst: Skel): ClipCheck {
  if (!Number.isFinite(clip.duration) || clip.duration < 0.3 || clip.duration > 15) return { ok: false, reason: `длительность ${clip.duration}` };
  for (const t of clip.tracks) {
    for (let i = 0; i < t.values.length; i++) if (!Number.isFinite(t.values[i])) return { ok: false, reason: `NaN в ${t.name}` };
    for (let i = 0; i < t.times.length; i++) if (!Number.isFinite(t.times[i])) return { ok: false, reason: `NaN во времени ${t.name}` };
  }
  const byNode = new Map<string, SkelBone>();
  dst.bones.forEach((b) => byNode.set(b.node, b));
  const q = new THREE.Quaternion(), qp = new THREE.Quaternion();
  for (const t of clip.tracks) {
    const b = byNode.get(nodeOf(t.name));
    if (!b) continue;
    if (propOf(t.name) === 'position' && b.key === dst.hips) {
      const p0 = new THREE.Vector3().fromArray(t.values, 0).applyMatrix4(b.parentRest);
      const p = new THREE.Vector3();
      let h = 0, v = 0;
      for (let i = 0; i < t.values.length; i += 3) {
        p.fromArray(t.values, i).applyMatrix4(b.parentRest).sub(p0);
        h = Math.max(h, Math.hypot(p.x, p.z));
        v = Math.max(v, Math.abs(p.y));
      }
      const H = dst.hipsH || 1;
      if (h > 3 * H || v > 2 * H) return { ok: false, reason: `таз уезжает на ${(h / H).toFixed(1)}/${(v / H).toFixed(1)} высоты таза` };
    }
    if (propOf(t.name) !== 'quaternion') continue;
    const lim = JOINT_LIMIT.find(([re]) => re.test(b.key))?.[1] ?? Math.PI;
    for (let i = 0; i < t.values.length; i += 4) {
      q.fromArray(t.values, i);
      const len = Math.hypot(q.x, q.y, q.z, q.w);
      if (Math.abs(len - 1) > 0.05) return { ok: false, reason: `${b.key}: ненормированный поворот` };
      q.normalize();
      if (b.key !== dst.hips && lim < Math.PI && q.angleTo(b.restQ) > lim) return { ok: false, reason: `${b.key}: поворот ${((q.angleTo(b.restQ) * 180) / Math.PI).toFixed(0)}° за предел ${((lim * 180) / Math.PI).toFixed(0)}°` };
      if (i > 0 && q.angleTo(qp) > SPIKE) return { ok: false, reason: `${b.key}: скачок ${((q.angleTo(qp) * 180) / Math.PI).toFixed(0)}° за кадр (t=${t.times[i / 4]?.toFixed(2)})` };
      qp.copy(q);
    }
  }
  return { ok: true };
}

// ───────────── отчёт ─────────────

export type MeshyState = 'loaded' | 'missing' | 'rejected';
export interface MeshyStatus {
  id: string;
  state: MeshyState;
  reason?: string;
  dur?: number;
  bones?: number;
}
/** что стало с каждым клипом (вкладка «Тест» ?meshyreport, deskPanel); общее для всех котов — последняя загрузка */
export const meshyStatus = new Map<string, MeshyStatus>();
function setStatus(s: MeshyStatus) {
  meshyStatus.set(s.id, s);
}

/** то, что нужно загрузчику от персонажа (GlbCharacter.addExternalClip); строка — клип отвергнут (причина) */
export interface ExternalClipHost {
  readonly skel: Skel | null;
  addExternalClip(id: string, clip: THREE.AnimationClip, loop: boolean, src: string): Promise<string | void>;
}

type Parsed = { clip: THREE.AnimationClip; skel: Skel } | null;
/** разобранные GLB — общие для всех котов (смена характера не качает заново) */
const cache = new Map<string, Promise<Parsed>>();
let manifestP: Promise<MeshyEntry[]> | null = null;

export interface LoadDeps {
  /** ожидаемые id (clips.MESHY_IDS): чего нет в манифесте — «missing» */
  expected?: readonly string[];
  /** выключенные id (PILOT_MESHY_OFF в пилоте): не грузим, статус «rejected» с причиной — играет прежний клип */
  blocked?: Readonly<Record<string, string>>;
  /** петля клипа: правило каталога (meshy.loop) главнее манифеста */
  loopOf?: (id: string, manifestLoop: boolean) => boolean;
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
  const inList = new Set(list.map((e) => e.id));
  for (const id of deps.expected ?? []) if (!inList.has(id)) setStatus({ id, state: 'missing', reason: list.length ? 'нет в манифесте' : 'нет манифеста' });
  const done: string[] = [];
  const errs = new Map<string, string>();
  for (const e of list) {
    const off = deps.blocked && Object.prototype.hasOwnProperty.call(deps.blocked, e.id) ? deps.blocked[e.id] : null;
    if (off !== null) {
      setStatus({ id: e.id, state: 'rejected', reason: `выключен в пилоте: ${off}` });
      continue;
    }
    const url = base + e.file;
    if (!cache.has(url))
      cache.set(url, deps.loadGlb(url).then(parse).catch((err) => {
        const m = String((err as Error)?.message ?? err);
        errs.set(url, m);
        deps.log?.(`[meshy] ${e.id}: ${m}`);
        return null;
      }));
    const p = await cache.get(url)!;
    if (!p) {
      const m = errs.get(url) ?? 'GLB без клипа или костей';
      setStatus({ id: e.id, state: /\b404\b/.test(m) ? 'missing' : 'rejected', reason: m });
      continue;
    }
    const { clip, info } = retargetClip(p.clip, p.skel, host.skel, e.id);
    if (!clip.tracks.length) {
      deps.log?.(`[meshy] ${e.id}: ни одной общей кости`);
      setStatus({ id: e.id, state: 'rejected', reason: 'ни одной общей кости' });
      continue;
    }
    const chk = checkClip(clip, host.skel);
    if (!chk.ok) {
      deps.log?.(`[meshy] ${e.id}: отвергнут — ${chk.reason}; играет прежний клип`);
      setStatus({ id: e.id, state: 'rejected', reason: chk.reason });
      continue;
    }
    const loop = deps.loopOf ? deps.loopOf(e.id, e.loop) : e.loop;
    const why = await host.addExternalClip(e.id, clip, loop, `meshy ${info.matched.length} костей`);
    if (typeof why === 'string') {
      deps.log?.(`[meshy] ${e.id}: отвергнут — ${why}; играет прежний клип`);
      setStatus({ id: e.id, state: 'rejected', reason: why });
      continue;
    }
    setStatus({ id: e.id, state: 'loaded', dur: +clip.duration.toFixed(2), bones: info.matched.length });
    done.push(e.id);
  }
  if (done.length) deps.log?.(`[meshy] клипы: ${done.join(', ')}`);
  return done;
}

/** для тестов: сбросить кэш манифеста и GLB */
export function resetMeshyCache() {
  cache.clear();
  manifestP = null;
  meshyStatus.clear();
}
