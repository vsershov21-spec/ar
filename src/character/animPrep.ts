/**
 * Подготовка клипов библиотеки движений (anims_v1.glb, Mixamo/Tripo Text-to-Motion) при загрузке GLB:
 *  1. перепривязка треков: в склеенной библиотеке три скелета, GLTFLoader делает имена узлов уникальными
 *     (mixamorigHips_1, …_2) — клипы второго/третьего скелета не находили костей модели и кот стоял в bind-позе;
 *  2. равномерная пересборка 30 к/с + сглаживание по Гауссу (шумные T2M-кривые дрожат), для петель — по кругу;
 *  3. одноразовые клипы: обрезка неподвижного «мусорного» начала и хвоста (реакция начинается сразу);
 *  4. петли: шов закрыт перекрёстным смешиванием конца с началом (talk_casual «щёлкал» каждые 5 с);
 *  5. корень: у Hips только вертикаль, горизонталь — сцена; затем высота нормализуется по самой низкой
 *     точке тела за клип (лапы на карте, без провала и парения), прыжки сохраняются;
 *  6. timeScale по клипу — слишком резкие (p95 угловой скорости) клипы чуть замедляются.
 * Чистая обработка кривых — без рендера; measureGround сэмплирует позу временным миксером.
 */
import * as THREE from 'three';

export interface ClipPrepInfo {
  name: string;
  /** треков перепривязано (суффикс _N) / выброшено (нет кости) */
  retargeted: number;
  dropped: number;
  dur0: number;
  dur: number;
  trimStart: number;
  trimEnd: number;
  loop: boolean;
  /** шов петли до/после, рад (макс. по костям) */
  seam0: number;
  seam: number;
  /** σ сглаживания, кадров при 30 к/с */
  smooth: number;
  /** шум кривых: |середина − slerp(соседей)| / шаг */
  noise: number;
  /** p95 угловой скорости костей тела, рад/с (после сглаживания) */
  p95: number;
  timeScale: number;
  /** сдвиг корня по высоте (доли роста) */
  groundDy: number;
  /** скорость опорной лапы относительно таза, роста/с (для ходьбы без скольжения) */
  footSpeed: number;
  /** лёжа: сдвиг по горизонтали, чтобы тело лежало на месте кота (доли роста) */
  lieShift: number;
}

export interface PrepOptions {
  /** клип петлевой (по каталогу и псевдонимам) */
  isLoop: (name: string) => boolean;
  /** не трогать скорость (танцы, бег — резкость задумана) */
  keepSpeed?: (name: string) => boolean;
  fps?: number;
}

const FPS = 30;
/** кости, по которым меряется движение (без пальцев ног, хвоста и ушей) */
const BODY_RX = /(Hips|Spine|Neck|Head|Shoulder|Arm|ForeArm|Hand|UpLeg|Leg|Foot)$/;
const done = new WeakSet<THREE.AnimationClip>();

const nodeOf = (trackName: string) => trackName.slice(0, trackName.lastIndexOf('.'));
const propOf = (trackName: string) => trackName.slice(trackName.lastIndexOf('.') + 1);

/** все имена узлов модели (в том виде, как их ищет PropertyBinding) */
export function nodeNames(model: THREE.Object3D) {
  const s = new Set<string>();
  model.traverse((o) => s.add(THREE.PropertyBinding.sanitizeNodeName(o.name)));
  return s;
}

/** 1. имена узлов треков → кости модели (mixamorigLeftArm_1 → mixamorigLeftArm) */
export function retargetTracks(clip: THREE.AnimationClip, names: Set<string>) {
  let retargeted = 0, dropped = 0;
  const keep: THREE.KeyframeTrack[] = [];
  for (const t of clip.tracks) {
    let n = nodeOf(t.name);
    if (!names.has(n)) {
      const base = n.replace(/_\d+$/, '');
      if (names.has(base)) {
        t.name = `${base}.${propOf(t.name)}`;
        n = base;
        retargeted++;
      }
    }
    if (!names.has(n)) {
      dropped++;
      continue;
    }
    // кости не тянутся и не масштабируются: вращения всех + смещение только у Hips
    const p = propOf(t.name);
    if (p === 'scale' || (p === 'position' && !/Hips$/.test(n))) continue;
    keep.push(t);
  }
  clip.tracks = keep;
  return { retargeted, dropped };
}

/** 2a. трек → равномерные кадры (интерполяция трека: slerp для кватернионов) */
function resample(t: THREE.KeyframeTrack, dur: number, fps: number): { n: number; stride: number; v: Float32Array } {
  const n = Math.max(2, Math.round(dur * fps) + 1);
  const stride = t.getValueSize();
  const v = new Float32Array(n * stride);
  const it = (t as unknown as { createInterpolant(): THREE.Interpolant }).createInterpolant();
  for (let i = 0; i < n; i++) {
    const r = it.evaluate(Math.min(dur, i / fps));
    for (let k = 0; k < stride; k++) v[i * stride + k] = r[k];
  }
  if (stride === 4) for (let i = 1; i < n; i++) alignQuat(v, (i - 1) * 4, v, i * 4);
  return { n, stride, v };
}

/** q[b] в ту же полусферу, что q[a] */
function alignQuat(a: ArrayLike<number>, ia: number, b: Float32Array, ib: number) {
  const d = a[ia] * b[ib] + a[ia + 1] * b[ib + 1] + a[ia + 2] * b[ib + 2] + a[ia + 3] * b[ib + 3];
  if (d < 0) for (let k = 0; k < 4; k++) b[ib + k] = -b[ib + k];
}

const qa = new THREE.Quaternion();
const qb = new THREE.Quaternion();
const qc = new THREE.Quaternion();
const angleAt = (v: Float32Array, i: number, j: number) => qa.fromArray(v, i * 4).angleTo(qb.fromArray(v, j * 4));

/** 2b. сглаживание по Гауссу (σ в кадрах); петля — по кругу (последний кадр = первый) */
export function gaussSmooth(v: Float32Array, n: number, stride: number, sigma: number, loop: boolean) {
  if (sigma <= 0.05 || n < 3) return v;
  const R = Math.ceil(sigma * 2.5);
  const w: number[] = [];
  for (let k = -R; k <= R; k++) w.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
  const out = new Float32Array(v.length);
  const period = n - 1; // в петле кадр n-1 совпадает с 0
  const acc = new Float32Array(stride);
  for (let i = 0; i < n; i++) {
    acc.fill(0);
    let ws = 0;
    for (let k = -R; k <= R; k++) {
      let j = i + k;
      if (loop) j = ((j % period) + period) % period;
      else if (j < 0 || j >= n) continue;
      const wk = w[k + R];
      if (stride === 4) {
        // соседний кватернион — в полусферу центрального
        const s = v[i * 4] * v[j * 4] + v[i * 4 + 1] * v[j * 4 + 1] + v[i * 4 + 2] * v[j * 4 + 2] + v[i * 4 + 3] * v[j * 4 + 3] < 0 ? -1 : 1;
        for (let c = 0; c < 4; c++) acc[c] += s * wk * v[j * 4 + c];
      } else for (let c = 0; c < stride; c++) acc[c] += wk * v[j * stride + c];
      ws += wk;
    }
    if (stride === 4) {
      const l = Math.hypot(acc[0], acc[1], acc[2], acc[3]) || 1;
      for (let c = 0; c < 4; c++) out[i * 4 + c] = acc[c] / l;
    } else for (let c = 0; c < stride; c++) out[i * stride + c] = acc[c] / ws;
  }
  return out;
}

/** смешать кадр a и b с весом k (кватернионы — slerp), результат в dst[i] */
function mixFrame(src: Float32Array, stride: number, a: number, b: number, k: number, dst: Float32Array, i: number) {
  if (stride === 4) {
    qa.fromArray(src, a * 4);
    qb.fromArray(src, b * 4);
    qc.copy(qa).slerp(qb, k).toArray(dst, i * 4);
  } else for (let c = 0; c < stride; c++) dst[i * stride + c] = src[a * stride + c] * (1 - k) + src[b * stride + c] * k;
}

const smooth01 = (x: number) => x * x * x * (x * (x * 6 - 15) + 10);

interface Samp { t: THREE.KeyframeTrack; n: number; stride: number; v: Float32Array; body: boolean }

/**
 * Обработка одного клипа (шаги 1–4 и 6). Возвращает сведения; клип меняется на месте.
 * Высота корня (шаг 5) — measureGround + applyGround: нужна поза модели.
 */
export function prepareClip(clip: THREE.AnimationClip, names: Set<string>, opts: PrepOptions): ClipPrepInfo {
  const fps = opts.fps ?? FPS;
  const loop = opts.isLoop(clip.name);
  const info: ClipPrepInfo = {
    name: clip.name, retargeted: 0, dropped: 0, dur0: clip.duration, dur: clip.duration, trimStart: 0, trimEnd: 0, loop,
    seam0: 0, seam: 0, smooth: 0, noise: 0, p95: 0, timeScale: 1, groundDy: 0, footSpeed: 0, lieShift: 0,
  };
  if (done.has(clip)) return info;
  done.add(clip);
  Object.assign(info, retargetTracks(clip, names));
  if (!clip.tracks.length) return info;

  const dur = clip.duration;
  let S: Samp[] = clip.tracks.map((t) => ({ t, ...resample(t, dur, fps), body: t.getValueSize() === 4 && BODY_RX.test(nodeOf(t.name)) }));
  let n = S[0].n;
  const body = S.filter((s) => s.body);

  // шум: насколько кадр отходит от середины соседей относительно шага
  let res = 0, stp = 0;
  for (const s of body) for (let i = 1; i < n - 1; i++) {
    qc.fromArray(s.v, (i - 1) * 4).slerp(qb.fromArray(s.v, (i + 1) * 4), 0.5);
    res += qc.angleTo(qa.fromArray(s.v, i * 4));
    stp += angleAt(s.v, i, i - 1);
  }
  info.noise = stp > 1e-6 ? res / stp : 0;

  // 3. одноразовый: срезать неподвижное начало/конец (порог 0,05 рад от крайнего кадра), запас 0,1/0,15 с
  if (!loop && body.length) {
    const dev = (i: number, ref: number) => body.reduce((m, s) => Math.max(m, angleAt(s.v, i, ref)), 0);
    let a = 0;
    while (a < n - 1 && dev(a, 0) < 0.05) a++;
    let b = n - 1;
    while (b > a && dev(b, n - 1) < 0.05) b--;
    a = Math.max(0, a - Math.round(0.1 * fps));
    b = Math.min(n - 1, b + Math.round(0.15 * fps));
    if (b - a < Math.round(0.4 * fps)) [a, b] = [0, n - 1];
    if (a / fps < 0.12) a = 0; // мелочь не режем
    if ((n - 1 - b) / fps < 0.12) b = n - 1;
    if (a > 0 || b < n - 1) {
      info.trimStart = a / fps;
      info.trimEnd = (n - 1 - b) / fps;
      S = S.map((s) => ({ ...s, n: b - a + 1, v: s.v.slice(a * s.stride, (b + 1) * s.stride) }));
      n = b - a + 1;
    }
  }

  // 4. петля: шов — максимум по костям тела между первым и последним кадром
  const seam = () => body.length ? S.filter((s) => s.body).reduce((m, s) => Math.max(m, angleAt(s.v, 0, s.n - 1)), 0) : 0;
  info.seam0 = loop ? seam() : 0;
  if (loop && info.seam0 > 0.03 && n > 8) {
    // классическое закрытие: период D−W, в [0, W] кадр смешивается с кадром из хвоста (t + D − W) → шов непрерывен
    const W = Math.max(2, Math.min(Math.round(0.4 * fps), Math.round((n - 1) * 0.15)));
    const m = n - W;
    S = S.map((s) => {
      const out = new Float32Array(m * s.stride);
      for (let i = 0; i < m; i++) {
        if (i < W) mixFrame(s.v, s.stride, i + n - W, i, smooth01(i / W), out, i);
        else for (let c = 0; c < s.stride; c++) out[i * s.stride + c] = s.v[i * s.stride + c];
      }
      return { ...s, n: m, v: out };
    });
    n = m;
    // последний кадр = первый (для LoopRepeat и сглаживания по кругу)
    S = S.map((s) => {
      const out = new Float32Array((n + 1) * s.stride);
      out.set(s.v);
      for (let c = 0; c < s.stride; c++) out[n * s.stride + c] = s.v[c];
      if (s.stride === 4) alignQuat(out, (n - 1) * 4, out, n * 4);
      return { ...s, n: n + 1, v: out };
    });
    n = n + 1;
  }

  // 2b. сглаживание: σ по шуму (T2M дрожит сильнее на быстрых клипах)
  const sigma = info.noise > 0.26 ? 1.6 : info.noise > 0.18 ? 1.1 : 0.75;
  info.smooth = sigma;
  S = S.map((s) => ({ ...s, v: gaussSmooth(s.v, s.n, s.stride, s.stride === 4 || /Hips$/.test(nodeOf(s.t.name)) ? sigma : 0, loop) }));

  // Hips: горизонталь фиксирована (место кота держит сцена), вертикаль — своя
  for (const s of S) {
    if (s.stride !== 3) continue;
    for (let i = 0; i < s.n; i++) {
      s.v[i * 3] = s.v[0];
      s.v[i * 3 + 2] = s.v[2];
    }
  }

  // пересобрать треки
  const times = new Float32Array(n);
  for (let i = 0; i < n; i++) times[i] = i / fps;
  clip.tracks = S.map((s) => {
    const T = s.stride === 4 ? THREE.QuaternionKeyframeTrack : THREE.VectorKeyframeTrack;
    return new T(s.t.name, times, s.v);
  });
  clip.duration = (n - 1) / fps;
  info.dur = clip.duration;
  info.seam = loop ? seam() : 0;

  // 6. скорость: p95 угловой скорости костей тела
  const sp: number[] = [];
  const bodyS = S.filter((s) => s.body);
  for (let i = 1; i < n; i++) sp.push(bodyS.reduce((m, s) => Math.max(m, angleAt(s.v, i, i - 1) * fps), 0));
  sp.sort((x, y) => x - y);
  info.p95 = sp.length ? sp[Math.floor(sp.length * 0.95)] : 0;
  if (!opts.keepSpeed?.(clip.name) && info.p95 > 8) info.timeScale = Math.max(0.8, 8 / info.p95);
  return info;
}

/**
 * Опоры (лапы, колени, кисти) → «радиус» под суставом (доли роста); у ступней — высота в bind-позе.
 * Корпус и голову не берём: T2M-клипы лёжа/сидя уже стоят на полу, а радиусы туловища мультяшного кота неточны.
 */
const GROUND_BONES: [RegExp, number][] = [
  [/(Left|Right)Foot$/, -1],
  [/(Left|Right)Leg$/, 0.05],
  [/(Left|Right)Hand$/, 0.03],
];

export interface GroundProbe {
  model: THREE.Object3D;
  /** система координат «кот» (рост 1, ноги в 0) — родитель модели */
  space: THREE.Object3D;
  hips: THREE.Bone;
  head: THREE.Object3D | null;
  bones: { b: THREE.Object3D; r: number; foot: boolean }[];
}

export function groundProbe(model: THREE.Object3D, space: THREE.Object3D): GroundProbe | null {
  let hips: THREE.Bone | null = null;
  let head: THREE.Object3D | null = null;
  const bones: GroundProbe['bones'] = [];
  model.updateMatrixWorld(true);
  const p = new THREE.Vector3();
  model.traverse((o) => {
    if (!(o as THREE.Bone).isBone) return;
    if (/Hips$/.test(o.name) && !hips) hips = o as THREE.Bone;
    if (/Head$/.test(o.name) && !head) head = o;
    for (const [rx, r] of GROUND_BONES) {
      if (!rx.test(o.name)) continue;
      const foot = r < 0;
      bones.push({ b: o, r: foot ? space.worldToLocal(o.getWorldPosition(p)).y : r, foot });
      break;
    }
  });
  return hips && bones.length ? { model, space, hips, head, bones } : null;
}

/**
 * 5. Самая низкая точка тела за клип (сэмплы 15 к/с временным миксером) → сдвиг корня по высоте,
 * чтобы опора стояла на карте. Плюс скорость опорной лапы (для подгонки темпа ходьбы).
 * Позу костей после замера возвращаем как было.
 */
export function measureGround(pr: GroundProbe, clip: THREE.AnimationClip): { dy: number; footSpeed: number; lieShift: THREE.Vector3 | null } {
  const saved: [THREE.Object3D, THREE.Quaternion, THREE.Vector3][] = [];
  pr.model.traverse((o) => saved.push([o, o.quaternion.clone(), o.position.clone()]));
  const mx = new THREE.AnimationMixer(pr.model);
  const act = mx.clipAction(clip);
  act.play();
  const p = new THREE.Vector3();
  let low = Infinity;
  const fs: number[] = [];
  let prev: { i: number; z: number; x: number } | null = null;
  const step = 1 / 15;
  const heads: number[] = [];
  const mid = new THREE.Vector3();
  let nMid = 0;
  for (let t = 0; t <= clip.duration + 1e-4; t += step) {
    mx.setTime(Math.min(t, clip.duration - 1e-4));
    pr.hips.updateMatrixWorld(true);
    if (pr.head) {
      // лёжа: середина «голова—таз» по горизонтали (кот должен лежать на карте, а не свисать к зрителю)
      const h = pr.space.worldToLocal(pr.head.getWorldPosition(p));
      heads.push(h.y);
      mid.x += h.x / 2;
      mid.z += h.z / 2;
      const hp = pr.space.worldToLocal(pr.hips.getWorldPosition(p));
      mid.x += hp.x / 2;
      mid.z += hp.z / 2;
      nMid++;
    }
    let fl = Infinity, fi = -1, fz = 0, fx = 0;
    for (let i = 0; i < pr.bones.length; i++) {
      const g = pr.bones[i];
      pr.space.worldToLocal(g.b.getWorldPosition(p));
      const y = p.y - g.r;
      if (y < low) low = y;
      if (g.foot && y < fl) [fl, fi, fz, fx] = [y, i, p.z, p.x];
    }
    if (prev && prev.i === fi && fl < 0.05) fs.push(Math.hypot(fz - prev.z, fx - prev.x) / step);
    prev = { i: fi, z: fz, x: fx };
  }
  act.stop();
  mx.uncacheRoot(pr.model);
  for (const [o, q, ps] of saved) {
    o.quaternion.copy(q);
    o.position.copy(ps);
  }
  pr.model.updateMatrixWorld(true);
  fs.sort((a, b) => a - b);
  heads.sort((a, b) => a - b);
  const lying = heads.length > 0 && heads[Math.floor(heads.length / 2)] < 0.25;
  const lieShift = lying && nMid ? new THREE.Vector3(-mid.x / nMid, 0, -mid.z / nMid) : null;
  return { dy: Number.isFinite(low) ? -low : 0, footSpeed: fs.length ? fs[Math.floor(fs.length / 2)] : 0, lieShift };
}

/** сдвиг корня (доли роста; число — только вверх) в треке Hips.position (трек в системе родителя Hips) */
export function applyGround(pr: GroundProbe, clip: THREE.AnimationClip, shift: number | THREE.Vector3) {
  const sv = typeof shift === 'number' ? new THREE.Vector3(0, shift, 0) : shift;
  const parent = pr.hips.parent;
  if (!parent) return;
  // вектор (0, dy, 0) пространства «кот» → в систему родителя Hips
  pr.model.updateMatrixWorld(true);
  const a = pr.space.localToWorld(new THREE.Vector3(0, 0, 0));
  const b = pr.space.localToWorld(sv.clone());
  const d = parent.worldToLocal(b).sub(parent.worldToLocal(a));
  const name = `${THREE.PropertyBinding.sanitizeNodeName(pr.hips.name)}.position`;
  let tr = clip.tracks.find((t) => t.name === name);
  if (!tr) {
    const p0 = pr.hips.position;
    tr = new THREE.VectorKeyframeTrack(name, [0, clip.duration], [p0.x, p0.y, p0.z, p0.x, p0.y, p0.z]);
    clip.tracks.push(tr);
  }
  const v = tr.values;
  for (let i = 0; i < v.length; i += 3) {
    v[i] += d.x;
    v[i + 1] += d.y;
    v[i + 2] += d.z;
  }
}

/**
 * Полная подготовка библиотеки: шаги 1–6. Дубликаты имён (один клип в двух выгрузках) остаются —
 * порядок решает glbCharacter.addClip.
 */
export function prepareClips(model: THREE.Object3D, space: THREE.Object3D, clips: THREE.AnimationClip[], opts: PrepOptions) {
  const names = nodeNames(model);
  const pr = groundProbe(model, space);
  const info = new Map<THREE.AnimationClip, ClipPrepInfo>();
  for (const c of clips) prepareOne(c, names, pr, opts, info);
  return info;
}

/**
 * То же, что prepareClips, но с паузами для браузера каждые ~12 мс: подготовка ~90 клипов на слабом телефоне —
 * секунда-две счёта, а идёт она, пока ребёнок листает онбординг (без пауз экран замирал). Результат тот же.
 */
export async function prepareClipsAsync(model: THREE.Object3D, space: THREE.Object3D, clips: THREE.AnimationClip[], opts: PrepOptions) {
  const names = nodeNames(model);
  const pr = groundProbe(model, space);
  const info = new Map<THREE.AnimationClip, ClipPrepInfo>();
  let t = performance.now();
  for (const c of clips) {
    prepareOne(c, names, pr, opts, info);
    if (performance.now() - t > 12) {
      await yieldToBrowser();
      t = performance.now();
    }
  }
  return info;
}

/** уступить главный поток (не setTimeout: в фоне он тормозится до 1 с) */
function yieldToBrowser(): Promise<void> {
  const sch = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (sch?.yield) return sch.yield();
  if (typeof MessageChannel === 'undefined') return Promise.resolve();
  return new Promise((r) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => r();
    ch.port2.postMessage(0);
  });
}

function prepareOne(c: THREE.AnimationClip, names: Set<string>, pr: ReturnType<typeof groundProbe>, opts: PrepOptions, info: Map<THREE.AnimationClip, ClipPrepInfo>) {
  {
    const already = done.has(c);
    const i = prepareClip(c, names, opts);
    if (pr && !already && c.tracks.length) {
      const g = measureGround(pr, c);
      // лапы ниже карты (провал) — поднимаем; парит весь клип (самая низкая опора выше 2 % роста) — опускаем
      const low = -g.dy;
      i.groundDy = low < -0.008 ? Math.min(0.08, -low) : low > 0.02 ? -Math.min(0.08, low) : 0;
      if (i.groundDy) applyGround(pr, c, i.groundDy);
      // только петли (сон): у одноразовых «лёг—встал» сдвиг поехал бы лапами по карте
      if (i.loop && g.lieShift && g.lieShift.length() > 0.03) {
        applyGround(pr, c, g.lieShift);
        i.lieShift = +g.lieShift.length().toFixed(3);
      }
      i.footSpeed = g.footSpeed;
    }
    info.set(c, i);
  }
}

/**
 * Монтаж клипа по окнам (content/animations.json, поле cut): из исходного клипа берутся куски keep [[от, до], …] (секунды
 * исходника), склеиваются подряд, на каждом стыке разрыв позы снимается за blendS по smootherstep (как инерциальный
 * переход: стык непрерывен, движение второго куска сохраняется). Так тычок T2M (≈ 5 с: удар 0,6 с, стоит 3 с, возврат)
 * становится «удар + возврат» за 1,5 с, а скрещённые лапы 17 с — жестом на 2,5 с. Исходный клип не меняется — новый
 * клип под именем id (псевдонимы того же пресета не задеты). Чистая функция.
 */
export function spliceClip(src: THREE.AnimationClip, keep: [number, number][], name: string, opts: { fps?: number; blendS?: number } = {}): THREE.AnimationClip {
  const fps = opts.fps ?? FPS;
  const W = Math.max(1, Math.round((opts.blendS ?? 0.25) * fps));
  const dur = src.duration;
  const segs = keep
    .map(([a, b]) => [Math.max(0, Math.min(dur, a)), Math.max(0, Math.min(dur, b))] as [number, number])
    .filter(([a, b]) => b - a > 1 / fps);
  if (!segs.length) return src.clone();
  const frames: number[] = []; // время исходника для каждого кадра результата
  const joins: number[] = []; // индексы первых кадров кусков (кроме первого)
  for (let s = 0; s < segs.length; s++) {
    const [a, b] = segs[s];
    if (s > 0) joins.push(frames.length);
    const n = Math.max(1, Math.round((b - a) * fps));
    for (let i = s > 0 ? 1 : 0; i <= n; i++) frames.push(a + ((b - a) * i) / n);
  }
  const n = frames.length;
  const times = new Float32Array(n);
  for (let i = 0; i < n; i++) times[i] = i / fps;
  const tracks = src.tracks.map((t) => {
    const stride = t.getValueSize();
    const it = (t as unknown as { createInterpolant(): THREE.Interpolant }).createInterpolant();
    const v = new Float32Array(n * stride);
    for (let i = 0; i < n; i++) v.set(it.evaluate(frames[i]).slice(0, stride), i * stride);
    if (stride === 4) for (let i = 1; i < n; i++) alignQuat(v, (i - 1) * 4, v, i * 4);
    // стыки: смещение «конец прошлого куска − начало следующего» затухает за W кадров
    for (const j of joins) {
      const pv = v.slice((j - 1) * stride, j * stride);
      if (stride === 4) {
        qa.fromArray(pv, 0);
        qb.fromArray(v, j * 4);
        if (qa.dot(qb) < 0) qa.set(-qa.x, -qa.y, -qa.z, -qa.w);
        const off = qa.multiply(qb.clone().invert()); // off·B = A
        const I = new THREE.Quaternion();
        for (let k = 0; k < W && j + k < n; k++) {
          const w = 1 - smooth01((k + 1) / (W + 1));
          qc.copy(I).slerp(off, w);
          qb.fromArray(v, (j + k) * 4).premultiply(qc).toArray(v, (j + k) * 4);
        }
        for (let i = j; i < Math.min(n, j + W + 1); i++) alignQuat(v, (i - 1) * 4, v, i * 4);
      } else {
        const d = Array.from({ length: stride }, (_, c) => pv[c] - v[j * stride + c]);
        for (let k = 0; k < W && j + k < n; k++) {
          const w = 1 - smooth01((k + 1) / (W + 1));
          for (let c = 0; c < stride; c++) v[(j + k) * stride + c] += d[c] * w;
        }
      }
    }
    const T = stride === 4 ? THREE.QuaternionKeyframeTrack : THREE.VectorKeyframeTrack;
    return new T(t.name, times, v);
  });
  return new THREE.AnimationClip(name, (n - 1) / fps, tracks);
}

/**
 * Неподвижный «хвост» одноразового клипа (Meshy генерирует не меньше 2 с: короткая реакция, дальше «стоит», но чуть
 * плывёт — порог prepareClip по отклонению от последнего кадра его не ловит). Здесь — по скорости: с последнего кадра,
 * где кости тела двигались быстрее speed рад/с, + pad с; клип не короче minS. Возвращает срезанные секунды (0 — нет).
 */
export function trimStill(clip: THREE.AnimationClip, opts: { speed?: number; pad?: number; minS?: number; fps?: number } = {}): number {
  const fps = opts.fps ?? FPS, thr = opts.speed ?? 0.4, pad = opts.pad ?? 0.2, minS = opts.minS ?? 0.6;
  const dur = clip.duration;
  const body = clip.tracks.filter((t) => t.getValueSize() === 4 && BODY_RX.test(nodeOf(t.name).replace(/^mixamorig:?/, '')));
  if (!body.length || dur <= minS + 0.25) return 0;
  const n = Math.max(2, Math.round(dur * fps) + 1);
  const S = body.map((t) => resample(t, dur, fps).v);
  let last = 0;
  for (let i = 1; i < n; i++) {
    let m = 0;
    for (const v of S) m = Math.max(m, angleAt(v, i, i - 1) * fps);
    if (m > thr) last = i;
  }
  const end = Math.min(dur, Math.max(minS, last / fps + pad));
  if (dur - end < 0.25) return 0;
  for (const t of clip.tracks) t.trim(0, end);
  clip.duration = end;
  return dur - end;
}
