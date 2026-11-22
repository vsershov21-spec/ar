// Библиотека движений (public/models/anims_v1.glb) → два пакета для сайта: «стартовый» (покой, пробуждение, знакомство,
// базовые реакции — с ним кот садится на карту) и «остальное» (догружается в фоне после посадки, GlbCharacter.loadDeferred).
// Исходник не меняется (его собирает scripts/models/build_anim_lib.sh); пакеты — при сборке (scripts/build/vite-model-opt.mjs).
//
// Что делает с клипами (без визуальных потерь — docs/qa/ui/quick/SPEED.md, сверка листов и ошибки по суставам):
//  - треки: только повороты костей и вертикаль корня (Hips.translation); масштаб и перенос остальных костей — прочь
//    (рантайм их не играет: GlbCharacter.addClip/animPrep берут повороты и высоту таза);
//  - прореживание ключей с допуском, как в упаковке клипов Meshy (scripts/meshy/motion.mjs reduceKeys/LEAN_TOL):
//    поворот — 0,5° на сустав, корень — 1 мм на кота ростом 1 м; ключ выбрасывается, только если интерполяция
//    между оставленными соседями отличается от него не больше допуска;
//  - подсказки animPrep по исходным кривым — в extras клипа: шум (prepNoise, от него сила сглаживания σ) и границы
//    обрезки неподвижного начала/конца (prepTrim): после прореживания кривые глаже, σ и обрезка могли бы сдвинуться; порядок клипа в библиотеке — extras.libIndex
//    (от порядка зависит, какой пресет Tripo займёт id каталога; GlbCharacter собирает пакеты в исходном порядке);
//  - общие ключи времени — один accessor (dedup), повороты — EXT_meshopt_compression с фильтром QUATERNION 16 бит
//    (как было), корень — EXPONENTIAL; поверх Caddy жмёт gzip/zstd (scripts/deploy/caddy-encode.sh).
//
// Вручную: node scripts/build/anim-pack.mjs [public/models/anims_v1.glb] [--out DIR] [--check] — пакеты и сверка ошибок
// (--check: для каждого клипа макс. отклонение поворота сустава и положения суставов в мире, мм на кота ростом 1 м).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reduceKeys, LEAN_TOL } from '../meshy/motion.mjs';

/** меняется при любой правке алгоритма — сбрасывает кэш сборки */
export const ANIM_PIPELINE = 'a2-lean0.5deg1mm-hints-dedup-meshopt';
export const ANIM_TOL = { rotDeg: Number(process.env.AR_ANIM_TOL_DEG) || LEAN_TOL.rotDeg, posM: LEAN_TOL.posM };

const here = fileURLToPath(import.meta.url);
const BODY_RX = /(Hips|Spine|Neck|Head|Shoulder|Arm|ForeArm|Hand|UpLeg|Leg|Foot)$/;

async function gltf() {
  const { NodeIO, PropertyType } = await import('@gltf-transform/core');
  const { ALL_EXTENSIONS, EXTMeshoptCompression } = await import('@gltf-transform/extensions');
  const { MeshoptDecoder, MeshoptEncoder } = await import('meshoptimizer');
  const F = await import('@gltf-transform/functions');
  await MeshoptDecoder.ready;
  await MeshoptEncoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
  return { io, EXTMeshoptCompression, F, PropertyType };
}

/** значения accessor-а; кватернионы (VEC4) — нормированные: int16 после квантования чуть не единичные, и угол
 *  2·acos(|a·b|) на них «шумит» до 0,5° — без нормировки прореживание и сверка врут */
const elems = (acc) => {
  const n = acc.getCount(), out = new Array(n), q = acc.getType() === 'VEC4';
  for (let i = 0; i < n; i++) {
    const v = acc.getElement(i, []);
    if (q) {
      const l = Math.hypot(...v) || 1;
      for (let c = 0; c < 4; c++) v[c] /= l;
    }
    out[i] = v;
  }
  return out;
};

function qslerp(a, b, u) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = d < 0 ? -1 : 1;
  d = Math.abs(d);
  let k0 = 1 - u, k1 = u * s;
  if (d < 0.9995) {
    const th = Math.acos(Math.min(1, d)), sn = Math.sin(th);
    k0 = Math.sin((1 - u) * th) / sn;
    k1 = (Math.sin(u * th) / sn) * s;
  }
  const o = [a[0] * k0 + b[0] * k1, a[1] * k0 + b[1] * k1, a[2] * k0 + b[2] * k1, a[3] * k0 + b[3] * k1];
  const l = Math.hypot(...o) || 1;
  return o.map((x) => x / l);
}

// ── шум кривых — ровно как animPrep.prepareClip (three: интерполянт трека, Float32, angleTo без нормировки) ──
/**
 * Подсказки animPrep по исходным кривым (как ClipPrepInfo): noise — шум (от него σ сглаживания), trim — кадры [a, b]
 * обрезки неподвижного начала/конца до запасов (порог 0,05 рад от крайнего кадра). После прореживания кривые чуть
 * другие (≤ 0,5°), и на медленном старте движения граница обрезки уехала бы на 0,3 с — берём исходную.
 * tracks: { node, rot, step, times, raw }
 */
export async function prepHints(tracks, dur, fps = 30) {
  const THREE = await import('three');
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), qc = new THREE.Quaternion();
  const n = Math.max(2, Math.round(dur * fps) + 1);
  const body = [];
  for (const tr of tracks) {
    if (!tr.rot || !BODY_RX.test(tr.node)) continue;
    const track = new THREE.QuaternionKeyframeTrack('n.quaternion', new Float32Array(tr.times), tr.raw);
    if (tr.step) track.setInterpolation(THREE.InterpolateDiscrete); // как GLTFLoader для STEP
    const it = track.createInterpolant();
    const v = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) v.set(it.evaluate(Math.min(dur, i / fps)).slice(0, 4), i * 4);
    for (let i = 1; i < n; i++) {
      const d = v[i * 4 - 4] * v[i * 4] + v[i * 4 - 3] * v[i * 4 + 1] + v[i * 4 - 2] * v[i * 4 + 2] + v[i * 4 - 1] * v[i * 4 + 3];
      if (d < 0) for (let k = 0; k < 4; k++) v[i * 4 + k] = -v[i * 4 + k];
    }
    body.push(v);
  }
  let res = 0, stp = 0;
  for (const v of body) for (let i = 1; i < n - 1; i++) {
    qc.fromArray(v, (i - 1) * 4).slerp(qb.fromArray(v, (i + 1) * 4), 0.5);
    res += qc.angleTo(qa.fromArray(v, i * 4));
    stp += qa.fromArray(v, i * 4).angleTo(qb.fromArray(v, (i - 1) * 4));
  }
  const dev = (i, ref) => body.reduce((m, v) => Math.max(m, qa.fromArray(v, i * 4).angleTo(qb.fromArray(v, ref * 4))), 0);
  let a = 0;
  while (a < n - 1 && dev(a, 0) < 0.05) a++;
  let b = n - 1;
  while (b > a && dev(b, n - 1) < 0.05) b--;
  return { noise: stp > 1e-6 ? res / stp : 0, trim: body.length ? [a, b, n] : null };
}

/** значения как их отдаёт GLTFLoader (нормированные int16 → Float32, без нормировки кватерниона) */
const rawFloats = (acc) => {
  const n = acc.getCount(), k = acc.getElementSize(), out = new Float32Array(n * k), e = [];
  for (let i = 0; i < n; i++) out.set(acc.getElement(i, e), i * k);
  return out;
};

/** имя узла, как его видит три (GLTFLoader: «mixamorig:Hips» → «mixamorigHips») — для BODY_RX хватает исходного */
const nodeKey = (name) => String(name ?? '').replace(/^.*[:|]/, '');

/**
 * Облегчить документ на месте: треки, ключи, шум в extras. Возвращает статистику.
 * scale — во сколько раз рост кота в единицах GLB меньше 1 м (допуск корня = posM × рост).
 */
export async function leanDocument(doc, { tol = ANIM_TOL, height = 1 } = {}) {
  const st = { clips: 0, keysBefore: 0, keysAfter: 0, dropped: 0 };
  const rootDoc = doc.getRoot();
  const rotTol = (tol.rotDeg * Math.PI) / 180, posTol = tol.posM * height;
  for (const [libIndex, anim] of rootDoc.listAnimations().entries()) {
    st.clips++;
    const tracks = [];
    let dur = 0;
    for (const ch of anim.listChannels()) {
      const node = ch.getTargetNode(), pathK = ch.getTargetPath(), smp = ch.getSampler();
      const isHips = /hips$/i.test(node?.getName() ?? '');
      if (!node || !smp || pathK === 'scale' || pathK === 'weights' || (pathK === 'translation' && !isHips)) {
        ch.dispose();
        st.dropped++;
        continue;
      }
      const times = Array.from(smp.getInput().getArray());
      dur = Math.max(dur, times[times.length - 1] ?? 0);
      const vals = elems(smp.getOutput());
      tracks.push({ ch, smp, node: nodeKey(node.getName()), rot: pathK === 'rotation', times, vals, raw: rawFloats(smp.getOutput()), step: smp.getInterpolation() === 'STEP' });
    }
    const hint = await prepHints(tracks, dur);
    anim.setExtras({ ...(anim.getExtras() ?? {}), libIndex, prepNoise: hint.noise, ...(hint.trim ? { prepTrim: hint.trim } : {}) });
    for (const tr of tracks) {
      const { smp } = tr;
      st.keysBefore += tr.times.length;
      if ((smp.getInterpolation() ?? 'LINEAR') !== 'LINEAR' || tr.times.length <= 2) {
        st.keysAfter += tr.times.length;
        continue;
      }
      const n = tr.rot ? 4 : 3;
      const r = reduceKeys(tr.times, tr.vals.flat(), n, tr.rot ? rotTol : posTol, tr.rot);
      st.keysAfter += r.times.length;
      const inp = doc.createAccessor().setType('SCALAR').setArray(new Float32Array(r.times)).setBuffer(rootDoc.listBuffers()[0]);
      const out = doc.createAccessor().setType(tr.rot ? 'VEC4' : 'VEC3').setArray(new Float32Array(r.vals)).setBuffer(rootDoc.listBuffers()[0]);
      smp.setInput(inp).setOutput(out);
    }
  }
  return st;
}

/** рост кота в единицах библиотеки: таз в позе покоя ≈ 0,49 роста (модели v1/v2: таз 0,24 при росте ≈ 0,5) */
function heightOf(doc) {
  const hips = doc.getRoot().listNodes().find((n) => /hips$/i.test(n.getName()));
  const y = hips ? Math.abs(hips.getTranslation()[1]) : 0;
  return y > 1e-4 ? y / 0.49 : 1;
}

/**
 * Пакеты из буфера библиотеки. start — имена клипов стартового пакета (null — один пакет «всё»).
 * → { start, rest, order, stats } (буферы GLB; rest — null, если стартовый пакет уже всё)
 */
export async function packAnims(input, { start = null, tol = ANIM_TOL } = {}) {
  const { io, EXTMeshoptCompression, F, PropertyType } = await gltf();
  const doc = await io.readBinary(new Uint8Array(input));
  const order = doc.getRoot().listAnimations().map((a) => a.getName());
  const stats = await leanDocument(doc, { tol, height: heightOf(doc) });
  const write = async (keep) => {
    const d = F.cloneDocument(doc);
    for (const a of d.getRoot().listAnimations()) {
      if (keep(a.getName())) continue;
      // каналы и сэмплеры — явно: иначе их accessor-ы (сироты) prune не видит и они едут в пакет
      for (const c of a.listChannels()) c.dispose();
      for (const sm of a.listSamplers()) sm.dispose();
      a.dispose();
    }
    await d.transform(F.dedup({ propertyTypes: [PropertyType.ACCESSOR] }), F.prune({ keepLeaves: true, keepAttributes: true }));
    d.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
    const out = await io.writeBinary(d);
    return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
  };
  const S = start ? new Set(start) : null;
  const startBuf = await write((n) => !S || S.has(n));
  const restBuf = S && order.some((n) => !S.has(n)) ? await write((n) => !S.has(n)) : null;
  return { start: startBuf, rest: restBuf, order, stats: { ...stats, startClips: S ? order.filter((n) => S.has(n)).length : order.length } };
}

// ── сверка: исходник vs пакет — FK по иерархии узлов, 30 к/с ──
async function readClips(buf) {
  const { io } = await gltf();
  const doc = await io.readBinary(new Uint8Array(buf));
  const clips = new Map();
  for (const a of doc.getRoot().listAnimations()) {
    // по имени узла (в одном клипе имена уникальны; в библиотеке три копии скелета с теми же именами)
    const tr = new Map();
    let dur = 0, any = null;
    for (const ch of a.listChannels()) {
      const smp = ch.getSampler(), nd = ch.getTargetNode();
      const times = Array.from(smp.getInput().getArray());
      dur = Math.max(dur, times[times.length - 1]);
      const e = tr.get(nd.getName()) ?? { node: nd };
      e[ch.getTargetPath()] = { path: ch.getTargetPath(), times, vals: elems(smp.getOutput()), step: smp.getInterpolation() === 'STEP' };
      tr.set(nd.getName(), e);
      any = nd;
    }
    clips.set(a.getName(), { tr, dur, any });
  }
  return { doc, clips };
}

export async function checkPacks(srcBuf, packBufs, { fps = 30 } = {}) {
  const THREE = await import('three');
  const src = await readClips(srcBuf);
  const packed = new Map();
  for (const b of packBufs) for (const [k, v] of (await readClips(b)).clips) packed.set(k, v);
  const height = heightOf(src.doc);
  const rows = [];
  const sample = (t, tk) => {
    const { times, vals, path: p, step } = tk;
    const n = times.length;
    if (t <= times[0] || n === 1) return vals[0];
    if (t >= times[n - 1]) return vals[n - 1];
    let i = 1;
    while (times[i] < t) i++;
    if (step) return vals[i - 1];
    const u = (t - times[i - 1]) / (times[i] - times[i - 1] || 1);
    if (p === 'rotation') return qslerp(vals[i - 1], vals[i], u);
    return vals[i - 1].map((x, c) => x + (vals[i][c] - x) * u);
  };
  const pa = new THREE.Vector3(), pb = new THREE.Vector3(), qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), sv = new THREE.Vector3();
  for (const [name, a] of src.clips) {
    const b = packed.get(name);
    if (!b) {
      rows.push({ name, missing: true });
      continue;
    }
    // скелет клипа (исходника): цели треков и их предки
    const nodes = [];
    const seen = new Set();
    for (const e of a.tr.values()) for (let p = e.node; p && !seen.has(p); p = p.getParentNode?.() ?? null) seen.add(p), nodes.push(p);
    const pose = (t, c) => {
      const world = new Map();
      const rec = (nd) => {
        if (world.has(nd)) return world.get(nd);
        const e = c.tr.get(nd.getName());
        const T = nd.getTranslation();
        let tt = e?.translation ? sample(t, e.translation) : T;
        const rr = e?.rotation ? sample(t, e.rotation) : nd.getRotation();
        const ss = e?.scale ? sample(t, e.scale) : nd.getScale();
        // рантайм: у Hips горизонталь фиксирована (место кота держит сцена) — сравниваем, как играет
        if (/hips$/i.test(nd.getName())) tt = [T[0], tt[1], T[2]];
        const m = new THREE.Matrix4().compose(new THREE.Vector3(...tt), new THREE.Quaternion(...rr), new THREE.Vector3(...ss));
        const par = nd.getParentNode?.();
        const w = par && seen.has(par) ? rec(par).clone().multiply(m) : m;
        world.set(nd, w);
        return w;
      };
      for (const nd of nodes) rec(nd);
      return world;
    };
    let maxMm = 0, maxDeg = 0, worst = '';
    const n = Math.max(2, Math.round(a.dur * fps) + 1);
    for (let i = 0; i < n; i++) {
      const t = Math.min(a.dur, i / fps);
      const wa = pose(t, a), wb = pose(t, b);
      for (const nd of nodes) {
        wa.get(nd).decompose(pa, qa, sv);
        wb.get(nd).decompose(pb, qb, sv);
        const mm = (pa.distanceTo(pb) / height) * 1000;
        const deg = (qa.angleTo(qb) * 180) / Math.PI;
        if (mm > maxMm) [maxMm, worst] = [mm, nd.getName().replace(/^.*:/, '')];
        if (deg > maxDeg) maxDeg = deg;
      }
    }
    rows.push({ name, dur: +a.dur.toFixed(2), maxMm: +maxMm.toFixed(2), maxDeg: +maxDeg.toFixed(2), worst });
  }
  return rows;
}

if (process.argv[1] && path.resolve(process.argv[1]) === here) {
  const args = process.argv.slice(2);
  const oi = args.indexOf('--out');
  const outDir = oi >= 0 ? args.splice(oi, 2)[1] : null;
  const check = args.includes('--check');
  const startArg = args.indexOf('--start');
  const start = startArg >= 0 ? args.splice(startArg, 2)[1].split(',') : null;
  const inp = args.find((a) => !a.startsWith('--')) ?? 'public/models/anims_v1.glb';
  const buf = fs.readFileSync(inp);
  const t0 = Date.now();
  const r = await packAnims(buf, { start });
  console.log(`anim-pack: ${inp} ${(buf.length / 1024) | 0} КБ → старт ${(r.start.length / 1024) | 0} КБ (${r.stats.startClips} клипов)${r.rest ? ` + остальное ${(r.rest.length / 1024) | 0} КБ` : ''}; ключей ${r.stats.keysBefore} → ${r.stats.keysAfter}, треков выброшено ${r.stats.dropped}; ${Date.now() - t0} мс`);
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'anims_start.glb'), r.start);
    if (r.rest) fs.writeFileSync(path.join(outDir, 'anims_rest.glb'), r.rest);
  }
  if (check) {
    const rows = await checkPacks(buf, [r.start, r.rest].filter(Boolean));
    rows.sort((x, y) => (y.maxMm ?? 0) - (x.maxMm ?? 0));
    for (const x of rows) console.log(x.missing ? `${x.name}: НЕТ В ПАКЕТЕ` : `${x.name.padEnd(28)} ${String(x.dur).padStart(6)} с  макс ${String(x.maxMm).padStart(6)} мм  ${String(x.maxDeg).padStart(5)}°  (${x.worst})`);
    if (outDir) fs.writeFileSync(path.join(outDir, 'anim-check.json'), JSON.stringify(rows, null, 1));
  }
}
