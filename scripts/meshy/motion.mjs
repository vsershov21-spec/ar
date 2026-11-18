#!/usr/bin/env node
// Клипы СберКота через Meshy Text-to-Motion → Animation на риге Хулигана (docs/animations/MESHY.md).
// Без зависимостей: node 22 (fetch). Запуск — scripts/meshy/motion-run.sh на сервере swe под root.
//
//   node motion.mjs --prompts t2m_prompts_v2.json                 — план: клипы, кредиты, баланс (ничего не тратит)
//   node motion.mjs --prompts … --go                              — генерация (возобновляемо)
//   --set p0|p1|p0,p1|all   --only id,id   --redo id,id   --jobs 3
//   --model-url https://ar.vershov.com/models/hooligan_v1.glb  --height 1.0
//   --out /srv/ar-extra/models/anims/meshy   --state /var/lib/vershov-commander/ar/meshy
//   --env /etc/ar-meshy.env  (MESHY_API_KEY=…; ключ читается здесь и никуда не выводится)
//   node motion.mjs --slim in.glb out.glb                         — облегчить GLB (без сети, для проверки)
//
// Правила трат: план по умолчанию; одна задача = одна отправка. Состояние (task id) пишется до и после POST;
// задачу, которая могла быть списана (ответ потерян, 5xx), сама не переотправляет — только --redo.
// 402 (нет кредитов) — стоп всего. 429 — пауза и повтор (запрос не принят). FAILED у Meshy — 0 кредитов,
// но и его повторяет только --redo.
import fs from 'node:fs';
import path from 'node:path';

const API = process.env.MESHY_API_BASE || 'https://api.meshy.ai/openapi/v1'; // переопределение — только для проверки на заглушке
const COST = { rig: 5, t2m: { prime: 10, swift: 3 }, anim: 3 };

// ───────────── аргументы ─────────────
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const has = (k) => argv.includes(k);
const list = (s) => (s ? String(s).split(',').map((x) => x.trim()).filter(Boolean) : []);

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────── GLB: облегчение (кости + анимация, без мешей и текстур) ─────────────
export function readGlb(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('не GLB');
  let off = 12, json = null, bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
    else if (type === 0x004e4942) bin = data;
    off += 8 + len;
  }
  if (!json) throw new Error('GLB без JSON');
  return { json, bin };
}

export function writeGlb(json, bin) {
  const pad = (b, c) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4), c)]) : b);
  const j = pad(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
  const chunks = [Buffer.alloc(8), j];
  chunks[0].writeUInt32LE(j.length, 0);
  chunks[0].writeUInt32LE(0x4e4f534a, 4);
  if (bin && bin.length) {
    const b = pad(bin, 0);
    const h = Buffer.alloc(8);
    h.writeUInt32LE(b.length, 0);
    h.writeUInt32LE(0x004e4942, 4);
    chunks.push(h, b);
  }
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([head, body]);
}

const mat4mul = (a, b) => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
function mat4inv(m) {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  const d = 1 / det;
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * d, (a02 * b10 - a01 * b11 - a03 * b09) * d, (a31 * b05 - a32 * b04 + a33 * b03) * d, (a22 * b04 - a21 * b05 - a23 * b03) * d,
    (a12 * b08 - a10 * b11 - a13 * b07) * d, (a00 * b11 - a02 * b08 + a03 * b07) * d, (a32 * b02 - a30 * b05 - a33 * b01) * d, (a20 * b05 - a22 * b02 + a23 * b01) * d,
    (a10 * b10 - a11 * b08 + a13 * b06) * d, (a01 * b08 - a00 * b10 - a03 * b06) * d, (a30 * b04 - a31 * b02 + a33 * b00) * d, (a21 * b02 - a20 * b04 - a23 * b00) * d,
    (a11 * b07 - a10 * b09 - a12 * b06) * d, (a00 * b09 - a01 * b07 + a02 * b06) * d, (a31 * b01 - a30 * b03 - a32 * b00) * d, (a20 * b03 - a21 * b01 + a22 * b00) * d,
  ];
}

const COMP = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/** float-значения accessor (для inverseBindMatrices) */
function readFloats(json, bin, ai) {
  const a = json.accessors[ai];
  const bv = json.bufferViews[a.bufferView];
  const n = NCOMP[a.type], cnt = a.count;
  const stride = bv.byteStride || n * 4;
  const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const out = [];
  for (let i = 0; i < cnt; i++) {
    const row = [];
    for (let k = 0; k < n; k++) row.push(bin.readFloatLE(base + i * stride + k * 4));
    out.push(row);
  }
  return out;
}

/**
 * GLB Meshy (меш + скин + анимация, мегабайты) → только узлы и анимации (десятки КБ). Поза привязки каждого сустава
 * (обратная inverseBindMatrix — в пространстве сцены) — в extras.bindWorld: GLTFLoader кладёт её в userData,
 * перенос (src/character/meshyClips.ts) берёт её как позу привязки. null — если облегчить нельзя (сжатые буферы).
 */
export function slimGlb(buf) {
  const { json, bin } = readGlb(buf);
  const req = json.extensionsRequired ?? [];
  if (req.some((e) => /meshopt|draco/i.test(e)) || !bin) return null;
  // поза привязки суставов
  for (const skin of json.skins ?? []) {
    if (skin.inverseBindMatrices === undefined) continue;
    const ibm = readFloats(json, bin, skin.inverseBindMatrices);
    skin.joints.forEach((ni, i) => {
      const inv = ibm[i] && mat4inv(ibm[i]);
      const node = json.nodes[ni];
      if (inv && node && !node.extras?.bindWorld) node.extras = { ...(node.extras ?? {}), bindWorld: inv.map((x) => +x.toFixed(7)) };
    });
  }
  // нужные accessor-ы: входы/выходы сэмплеров анимаций
  const used = new Set();
  for (const an of json.animations ?? []) for (const s of an.samplers ?? []) used.add(s.input), used.add(s.output);
  const accMap = new Map(), bvMap = new Map();
  const accessors = [], bufferViews = [], parts = [];
  let size = 0;
  for (const ai of [...used].sort((a, b) => a - b)) {
    const a = { ...json.accessors[ai] };
    if (a.sparse) return null;
    const ob = a.bufferView;
    if (!bvMap.has(ob)) {
      const bv = json.bufferViews[ob];
      const data = bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
      const padN = (4 - (size % 4)) % 4;
      if (padN) parts.push(Buffer.alloc(padN)), (size += padN);
      const nb = { buffer: 0, byteOffset: size, byteLength: bv.byteLength };
      if (bv.byteStride) nb.byteStride = bv.byteStride;
      bvMap.set(ob, bufferViews.length);
      bufferViews.push(nb);
      parts.push(data);
      size += data.length;
    }
    a.bufferView = bvMap.get(ob);
    accMap.set(ai, accessors.length);
    accessors.push(a);
  }
  const nodes = (json.nodes ?? []).map((n) => {
    const { mesh, skin, camera, weights, ...rest } = n;
    void mesh, skin, camera, weights;
    return rest;
  });
  const animations = (json.animations ?? []).map((an) => ({
    ...an,
    samplers: an.samplers.map((s) => ({ ...s, input: accMap.get(s.input), output: accMap.get(s.output) })),
  }));
  const out = {
    asset: { ...(json.asset ?? { version: '2.0' }), generator: 'sbercat meshy slim' },
    scene: json.scene ?? 0,
    scenes: json.scenes,
    nodes,
    animations,
    accessors,
    bufferViews,
    buffers: [{ byteLength: size }],
  };
  const used2 = (json.extensionsUsed ?? []).filter((e) => e === 'KHR_mesh_quantization');
  if (used2.length) out.extensionsUsed = used2;
  return writeGlb(out, Buffer.concat(parts));
}

/** длительность анимации GLB (макс. время входов) */
export function glbAnimInfo(buf) {
  const { json } = readGlb(buf);
  let dur = 0, tracks = 0;
  for (const an of json.animations ?? []) {
    tracks += an.channels?.length ?? 0;
    for (const s of an.samplers ?? []) dur = Math.max(dur, json.accessors[s.input]?.max?.[0] ?? 0);
  }
  return { anims: json.animations?.length ?? 0, tracks, dur: +dur.toFixed(3), joints: json.skins?.[0]?.joints?.length ?? 0 };
}

// ───────────── Meshy API ─────────────
class Stop extends Error {}

function readKey(file) {
  if (process.env.MESHY_API_KEY) return process.env.MESHY_API_KEY.trim();
  let txt = '';
  try {
    txt = fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  const m = /^\s*(?:export\s+)?MESHY_API_KEY\s*=\s*["']?([^"'\s]+)/m.exec(txt);
  return m ? m[1] : '';
}

function makeApi(key) {
  const H = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const errText = async (r) => {
    try {
      const j = await r.json();
      return String(j?.message ?? JSON.stringify(j)).slice(0, 300);
    } catch {
      return r.statusText;
    }
  };
  /** GET — безопасно повторять (сеть, 429, 5xx) */
  async function get(p) {
    for (let i = 0; ; i++) {
      let r;
      try {
        r = await fetch(API + p, { headers: H });
      } catch (e) {
        if (i >= 5) throw e;
        await sleep(3000 * (i + 1));
        continue;
      }
      if (r.ok) return r.json();
      if ((r.status === 429 || r.status >= 500) && i < 6) {
        await sleep(Math.min(60000, 4000 * 2 ** i));
        continue;
      }
      if (r.status === 401 || r.status === 403) throw new Stop(`GET ${p}: ${r.status} ключ не принят (${await errText(r)})`);
      throw new Error(`GET ${p}: ${r.status} ${await errText(r)}`);
    }
  }
  /**
   * POST — создаёт задачу (тратит кредиты). Повтор только на 429 (не принят). Сеть/5xx → { uncertain } —
   * задача могла создаться: не переотправлять сами.
   */
  async function post(p, body) {
    for (let i = 0; ; i++) {
      let r;
      try {
        r = await fetch(API + p, { method: 'POST', headers: H, body: JSON.stringify(body) });
      } catch (e) {
        return { uncertain: `сеть: ${e.message}` };
      }
      if (r.ok) return { id: (await r.json())?.result };
      if (r.status === 429 && i < 8) {
        await sleep(Math.min(90000, 5000 * 2 ** i));
        continue;
      }
      if (r.status === 402) throw new Stop(`402: кредиты кончились или нужен платный план (${await errText(r)})`);
      if (r.status === 401 || r.status === 403) throw new Stop(`${r.status}: ключ не принят (${await errText(r)})`);
      if (r.status >= 500) return { uncertain: `${r.status} ${await errText(r)}` };
      return { error: `${r.status} ${await errText(r)}` }; // 400 и т. п.: не принят, кредиты не списаны
    }
  }
  /** ждать задачу до финала */
  async function wait(kind, id, label, maxMin = 30) {
    const t0 = Date.now();
    let last = -1;
    for (;;) {
      const t = await get(`/${kind}/${id}`);
      if (['SUCCEEDED', 'FAILED', 'CANCELED'].includes(t.status)) return t;
      if (t.progress !== last && t.progress % 25 === 0) log(`  … ${label}: ${t.status} ${t.progress ?? 0}%${t.preceding_tasks ? `, в очереди ${t.preceding_tasks}` : ''}`);
      last = t.progress;
      if (Date.now() - t0 > maxMin * 60000) return { status: 'TIMEOUT', id };
      await sleep(5000);
    }
  }
  return { get, post, wait };
}

async function download(url, file) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${r.status}`);
      const b = Buffer.from(await r.arrayBuffer());
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.part', b);
      fs.renameSync(file + '.part', file);
      return b;
    } catch (e) {
      if (i === 3) throw new Error(`скачивание ${path.basename(file)}: ${e.message}`);
      await sleep(3000 * (i + 1));
    }
  }
}

// ───────────── выбор клипов ─────────────
export const metaDuration = (s) => Math.min(10, Math.max(2, Math.ceil((Number(s) || 2) * 2) / 2));

export function pickClips(d, { set = 'p0', only = [] } = {}) {
  const specs = d.specs ?? {};
  const sets = list(set.toLowerCase());
  const want = (sp) => sets.includes('all') || sets.includes(String(sp.priority ?? '').toLowerCase());
  const ids = only.length ? only : Object.keys(specs).filter((k) => want(specs[k]));
  return ids.map((id) => {
    const sp = specs[id];
    if (!sp) throw new Error(`нет клипа ${id} в specs`);
    const m = sp.meshy ?? {};
    let prompt = m.prompt ?? d.prompts?.[id] ?? '';
    if (!prompt) throw new Error(`нет промпта для ${id}`);
    prompt = prompt.replace(/\s+/g, ' ').trim().slice(0, 400);
    return { id, prompt, duration: metaDuration(m.duration ?? sp.durationS), mode: m.mode === 'swift' ? 'swift' : 'prime', loop: !!sp.loop, priority: sp.priority, tz: !!sp.meshy };
  });
}

// ───────────── состояние и манифест ─────────────
function loadJson(f, d) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
}
function saveJson(f, v) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 1) + '\n');
  fs.renameSync(f + '.tmp', f);
}

// ───────────── главный ход ─────────────
async function main() {
  if (has('--slim')) {
    const [i, o] = [argv[argv.indexOf('--slim') + 1], argv[argv.indexOf('--slim') + 2]];
    const raw = fs.readFileSync(i);
    const s = slimGlb(raw);
    if (!s) throw new Error('облегчить нельзя (сжатые буферы) — файл как есть');
    fs.writeFileSync(o, s);
    console.log(`${i} ${raw.length} → ${o} ${s.length} байт`, glbAnimInfo(s));
    return;
  }
  const GO = has('--go');
  const promptsFile = opt('--prompts', 'scripts/models/t2m_prompts_v2.json');
  const OUT = opt('--out', '/srv/ar-extra/models/anims/meshy');
  const STATE_DIR = opt('--state', '/var/lib/vershov-commander/ar/meshy');
  const modelUrl = opt('--model-url', 'https://ar.vershov.com/models/hooligan_v1.glb');
  const height = Number(opt('--height', '1.0'));
  const jobs = Math.max(1, Math.min(5, Number(opt('--jobs', '3'))));
  const redo = new Set(list(opt('--redo', '')));
  const d = JSON.parse(fs.readFileSync(promptsFile, 'utf8'));
  const clips = pickClips(d, { set: opt('--set', 'p0'), only: [...list(opt('--only', '')), ...redo] });
  const stateFile = path.join(STATE_DIR, 'state.json');
  const manFile = path.join(OUT, 'manifest.json');
  const state = loadJson(stateFile, { rig: null, clips: {} });
  state.clips ??= {};
  const man = loadJson(manFile, { version: 1, skeleton: 'mixamo', clips: [] });
  const save = () => saveJson(stateFile, state);
  const doneIds = new Set(man.clips.filter((c) => fs.existsSync(path.join(OUT, c.file))).map((c) => c.id));
  for (const id of redo) doneIds.delete(id);

  const key = readKey(opt('--env', '/etc/ar-meshy.env'));
  const api = key ? makeApi(key) : null;
  log(`=== meshy motion ${GO ? 'GO' : 'ПЛАН'} · клипов ${clips.length} · модель ${modelUrl} ===`);
  let bal = null;
  if (api) {
    try {
      bal = (await api.get('/balance'))?.balance ?? null;
      log(`баланс: ${bal} кредитов`);
    } catch (e) {
      log(`баланс: не узнал (${e.message})`);
      if (e instanceof Stop) process.exitCode = 2;
    }
  } else log(`ключа нет (${opt('--env', '/etc/ar-meshy.env')} / MESHY_API_KEY) — только план`);

  const rigDone = state.rig?.status === 'SUCCEEDED' && state.rig?.model_url === modelUrl;
  const todo = clips.filter((c) => !doneIds.has(c.id));
  let est = rigDone || state.rig?.task_id ? 0 : COST.rig;
  for (const c of clips) {
    const st = state.clips[c.id] ?? {};
    const mark = doneIds.has(c.id) ? '✓ есть' : st.anim?.task_id ? '… анимация в работе' : st.t2m?.task_id ? '… движение в работе' : '•';
    let cost = 0;
    if (!doneIds.has(c.id)) {
      if (!st.t2m?.task_id || redo.has(c.id)) cost += COST.t2m[c.mode];
      if (!st.anim?.task_id || redo.has(c.id)) cost += COST.anim;
    }
    est += cost;
    console.log(`${mark} ${c.id.padEnd(26)} ${String(c.duration).padStart(4)} с ${c.loop ? 'петля' : '     '} ${c.mode}${c.tz ? '' : ' (промпт Tripo)'}${cost ? ` · ${cost} кр.` : ''}`);
  }
  log(`к генерации: ${todo.length} из ${clips.length}; оценка ≈ ${est} кредитов (риг ${rigDone || state.rig?.task_id ? 0 : COST.rig} + движение ${COST.t2m.prime}/клип + анимация ${COST.anim}/клип)${bal != null ? `; баланс ${bal}${bal < est ? ' — НЕ ХВАТИТ' : ''}` : ''}`);
  if (!GO) {
    log('план; запуск: … --go');
    return;
  }
  if (!api) throw new Stop('нет ключа MESHY_API_KEY');
  if (!todo.length) return log('всё уже есть');
  if (bal != null && bal < COST.t2m.prime + COST.anim) throw new Stop(`мало кредитов: ${bal}`);

  // 1. риг — один раз на все клипы (у трёх котов один скелет)
  if (!rigDone) {
    if (state.rig?.model_url && state.rig.model_url !== modelUrl && !has('--new-rig')) throw new Stop(`в state риг другой модели (${state.rig.model_url}); новый — с --new-rig`);
    if (has('--new-rig') && state.rig?.model_url !== modelUrl) state.rig = null;
    if (state.rig?.uncertain && !state.rig.task_id && !has('--new-rig')) throw new Stop(`отправка рига не подтвердилась (${state.rig.uncertain}) — проверь в кабинете Meshy; заново: --new-rig`);
    if (!state.rig?.task_id || (has('--new-rig') && state.rig.status !== 'SUCCEEDED')) {
      state.rig = { model_url: modelUrl, submitting: new Date().toISOString() };
      save();
      log(`риг: отправляю ${modelUrl} (mixamo, рост ${height} м)`);
      const r = await api.post('/rigging', { model_url: modelUrl, height_meters: height, skeleton_template: 'mixamo' });
      if (r.uncertain) {
        state.rig.uncertain = r.uncertain;
        save();
        throw new Stop(`риг: ответ потерян (${r.uncertain}) — не переотправляю`);
      }
      if (r.error) {
        state.rig = null;
        save();
        throw new Stop(`риг не принят: ${r.error}`);
      }
      Object.assign(state.rig, { task_id: r.id, created: new Date().toISOString() });
      save();
    }
    if (state.rig.status === 'FAILED') throw new Stop(`риг FAILED (${state.rig.error ?? ''}) — повтор: --new-rig`);
    const t = await api.wait('rigging', state.rig.task_id, 'риг', 20);
    state.rig.status = t.status;
    state.rig.credits = t.consumed_credits;
    if (t.status !== 'SUCCEEDED') {
      state.rig.error = JSON.stringify(t.task_error ?? t.status).slice(0, 300);
      save();
      throw new Stop(`риг: ${t.status} ${state.rig.error}`);
    }
    save();
    const u = t.result?.rigged_character_glb_url;
    if (u) {
      try {
        const b = await download(u, path.join(STATE_DIR, 'rig', 'hooligan_meshy_rig.glb'));
        log(`риг готов: ${state.rig.task_id}, ${(b.length / 1048576).toFixed(1)} МБ, ${JSON.stringify(glbAnimInfo(b))}`);
      } catch (e) {
        log(`риг готов, GLB не скачал: ${e.message}`);
      }
    }
  } else log(`риг: ${state.rig.task_id} (готов)`);
  const rigId = state.rig.task_id;

  // 2. клипы: движение → анимация на риге → GLB
  let stopped = null;
  const one = async (c) => {
    if (stopped) return;
    const st = (state.clips[c.id] ??= {});
    if (redo.has(c.id)) {
      log(`${c.id}: --redo — старые задачи забыты`);
      st.t2m = null;
      st.anim = null;
    }
    st.prompt = c.prompt;
    st.duration = c.duration;
    // движение
    if (st.t2m?.uncertain && !st.t2m.task_id) return log(`✗ ${c.id}: отправка движения не подтвердилась (${st.t2m.uncertain}) — проверь в Meshy; заново: --redo ${c.id}`);
    if (!st.t2m?.task_id) {
      st.t2m = { submitting: new Date().toISOString(), mode: c.mode };
      save();
      const r = await api.post('/text-to-motion', { prompt: c.prompt, mode: c.mode, duration: c.duration });
      if (r.uncertain) return (st.t2m.uncertain = r.uncertain), save(), log(`✗ ${c.id}: движение — ответ потерян (${r.uncertain}); не переотправляю`);
      if (r.error) return (st.t2m = null), save(), log(`✗ ${c.id}: движение не принято: ${r.error}`);
      Object.assign(st.t2m, { task_id: r.id, created: new Date().toISOString() });
      save();
      log(`▶ ${c.id}: движение ${r.id} (${c.duration} с)`);
    }
    if (st.t2m.status !== 'SUCCEEDED') {
      if (st.t2m.status === 'FAILED') return log(`✗ ${c.id}: движение FAILED раньше — повтор: --redo ${c.id}`);
      const t = await api.wait('text-to-motion', st.t2m.task_id, `${c.id} движение`);
      st.t2m.status = t.status;
      st.t2m.credits = t.consumed_credits;
      st.t2m.duration_ms = t.result?.duration_ms;
      if (t.status !== 'SUCCEEDED') {
        st.t2m.error = JSON.stringify(t.task_error ?? t.status).slice(0, 300);
        save();
        return log(`✗ ${c.id}: движение ${t.status} ${st.t2m.error}${t.status === 'TIMEOUT' ? ' — следующий запуск дождётся' : ''}`);
      }
      save();
    }
    // анимация на риге
    if (st.anim?.uncertain && !st.anim.task_id) return log(`✗ ${c.id}: отправка анимации не подтвердилась (${st.anim.uncertain}); заново: --redo ${c.id}`);
    if (!st.anim?.task_id) {
      st.anim = { submitting: new Date().toISOString() };
      save();
      const r = await api.post('/animations', { rig_task_id: rigId, motion_task_id: st.t2m.task_id });
      if (r.uncertain) return (st.anim.uncertain = r.uncertain), save(), log(`✗ ${c.id}: анимация — ответ потерян (${r.uncertain}); не переотправляю`);
      if (r.error) return (st.anim = null), save(), log(`✗ ${c.id}: анимация не принята: ${r.error}`);
      Object.assign(st.anim, { task_id: r.id, created: new Date().toISOString() });
      save();
    }
    if (st.anim.status === 'FAILED') return log(`✗ ${c.id}: анимация FAILED раньше — повтор: --redo ${c.id}`);
    const t = await api.wait('animations', st.anim.task_id, `${c.id} анимация`);
    st.anim.status = t.status;
    st.anim.credits = t.consumed_credits;
    if (t.status !== 'SUCCEEDED') {
      st.anim.error = JSON.stringify(t.task_error ?? t.status).slice(0, 300);
      save();
      return log(`✗ ${c.id}: анимация ${t.status} ${st.anim.error}`);
    }
    const url = t.result?.animation_glb_url;
    if (!url) return save(), log(`✗ ${c.id}: в ответе нет animation_glb_url (${Object.keys(t.result ?? {}).join(', ')})`);
    const raw = await download(url, path.join(STATE_DIR, 'raw', `${c.id}.glb`));
    const slim = slimGlb(raw);
    const outB = slim ?? raw;
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, `${c.id}.glb`), outB);
    const info = glbAnimInfo(outB);
    st.file = `${c.id}.glb`;
    save();
    const rec = {
      id: c.id, file: `${c.id}.glb`, loop: c.loop, duration: c.duration, durationGlb: info.dur, priority: c.priority, mode: c.mode,
      prompt: c.prompt, rig_task_id: rigId, motion_task_id: st.t2m.task_id, animation_task_id: st.anim.task_id,
      credits: { motion: st.t2m.credits ?? null, animation: st.anim.credits ?? null }, bytes: outB.length, created: new Date().toISOString(),
    };
    man.clips = [...man.clips.filter((x) => x.id !== c.id), rec].sort((a, b) => a.id.localeCompare(b.id));
    man.rig_task_id = rigId;
    man.updated = rec.created;
    saveJson(manFile, man);
    log(`✓ ${c.id}.glb ${(outB.length / 1024).toFixed(0)} КБ${slim ? '' : ' (не облегчён)'} · ${info.dur} с · треков ${info.tracks} · кредиты ${rec.credits.motion}+${rec.credits.animation}`);
  };
  const queue = [...todo];
  const worker = async () => {
    while (queue.length && !stopped) {
      const c = queue.shift();
      try {
        await one(c);
      } catch (e) {
        if (e instanceof Stop) {
          stopped = e.message;
          log(`■ стоп: ${e.message}`);
        } else log(`✗ ${c.id}: ${e.message}`);
        save();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, todo.length) }, worker));
  try {
    const b = await api.get('/balance');
    log(`баланс после: ${b?.balance}`);
  } catch {
    /* не важно */
  }
  if (stopped) process.exitCode = 2;
  log(`готово: в манифесте ${man.clips.length}; на сайт — со следующей сборкой (push в main или перезапуск ar-update)`);
}

// /var/lib/vershov-commander на swe — симлинк (systemd DynamicUser → /var/lib/private/…): сравниваем реальные пути,
// иначе main() молча не запускался (план и --go завершались с кодом 0 без вывода)
const isMain = (() => {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  main().catch((e) => {
    log(`✗ ${e instanceof Stop ? 'стоп' : 'ошибка'}: ${e.message}`);
    process.exit(e instanceof Stop ? 2 : 1);
  });
}
