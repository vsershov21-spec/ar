#!/usr/bin/env node
// Meshy Multi-Image to 3D: персонаж по видам разворота (Блёстка p3, scripts/models/glitter_p3.py). Сервер swe, root.
// Запуск — через motion-run.sh (ar-auto, задача kind meshy): если все id из --only лежат в models3d файла промптов,
// motion-run.sh берёт этот скрипт вместо motion.mjs. Ключ — /etc/ar-meshy.env, в лог не пишется.
//
//   node image3d.mjs --prompts prompts.json --env /etc/ar-meshy.env --state <dir> --raw <база raw.githubusercontent/sha> --only id[,id]
//        без --go — план (оценка, баланс; ничего не тратит); --go — генерация; --redo id — заново; --max-credits N
//
// Результат: /srv/ar-extra/models/props/<id>.glb (если ≤ 28 МБ) и всегда <id>_geo.glb (сетка без картинок) +
// <id>_img<k>.png (картинки GLB как есть: базовый цвет, нормали, …; внутри может быть JPEG) + <id>.png (превью) +
// <id>_task.json (параметры и ответ задачи без ссылок). В server-out — задачей script scripts/deploy/mirror-props.sh <id>…
// Повторный запуск продолжает с места: задача с id в состоянии не переотправляется (оплачено), только дожидается.
import fs from 'node:fs';
import path from 'node:path';

const API = process.env.MESHY_API_BASE || 'https://api.meshy.ai/openapi/v1';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const has = (k) => argv.includes(k);
const list = (s) => (s ? String(s).split(',').map((x) => x.trim()).filter(Boolean) : []);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Stop extends Error {}

/** параметры, которые можно передать в Meshy из models3d (всё прочее — отказ) */
export const ALLOWED = new Set(['ai_model', 'geometry_resolution', 'should_texture', 'texture_model', 'enable_pbr', 'texture_resolution',
  'texture_prompt', 'should_remesh', 'topology', 'target_polycount', 'symmetry_mode', 'pose_mode', 'image_enhancement', 'remove_lighting',
  'target_formats', 'save_pre_remeshed_model', 'multi_view_thumbnails', 'alpha_thumbnail']);
const GLB_MAX = 28 * 1024 * 1024;

/** выбор моделей: { id, images[], params, estimate } — проверка состава */
export function pickModels(d, only) {
  const m = d.models3d ?? {};
  return only.map((id) => {
    const e = m[id];
    if (!e) throw new Error(`нет ${id} в models3d`);
    const images = e.images ?? [];
    if (!images.length || images.length > 4) throw new Error(`${id}: нужно 1–4 картинки`);
    for (const f of images) if (!/^[A-Za-z0-9_./-]+\.(png|jpe?g|webp)$/.test(f) || f.includes('..')) throw new Error(`${id}: плохой путь ${f}`);
    for (const k of Object.keys(e.params ?? {})) if (!ALLOWED.has(k)) throw new Error(`${id}: параметр ${k} не разрешён`);
    if ((e.params?.texture_prompt ?? '').length > 800) throw new Error(`${id}: texture_prompt > 800`);
    return { id, images, params: e.params ?? {}, estimate: Number(e.estimate ?? 35) };
  });
}

function readKey(file) {
  if (process.env.MESHY_API_KEY) return process.env.MESHY_API_KEY.trim();
  try {
    const m = /^\s*(?:export\s+)?MESHY_API_KEY\s*=\s*["']?([^"'\s]+)/m.exec(fs.readFileSync(file, 'utf8'));
    return m ? m[1] : '';
  } catch {
    return '';
  }
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
  /** POST создаёт задачу (тратит кредиты): повтор только на 429; сеть/5xx — «не знаю», не переотправлять */
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
      if (r.status === 402) throw new Stop(`402: кредиты кончились (${await errText(r)})`);
      if (r.status === 401) throw new Stop(`401: ключ не принят (${await errText(r)})`);
      if (r.status >= 500) return { uncertain: `${r.status} ${await errText(r)}` };
      return { error: `${r.status} ${await errText(r)}` };
    }
  }
  return { get, post };
}

async function fetchBuf(url) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(String(r.status));
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (i === 3) throw e;
      await sleep(3000 * (i + 1));
    }
  }
}

/** GLB → { json, bin } */
function readGlb(b) {
  const jl = b.readUInt32LE(12);
  const json = JSON.parse(b.subarray(20, 20 + jl).toString('utf8'));
  const o = 20 + jl;
  const bl = b.readUInt32LE(o);
  return { json, bin: b.subarray(o + 8, o + 8 + bl) };
}
function writeGlb(json, bin) {
  let js = Buffer.from(JSON.stringify(json));
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const pad = Buffer.alloc((4 - (bin.length % 4)) % 4);
  const b2 = Buffer.concat([bin, pad]);
  const h = Buffer.alloc(12);
  h.writeUInt32LE(0x46546c67, 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(12 + 8 + js.length + 8 + b2.length, 8);
  const c1 = Buffer.alloc(8); c1.writeUInt32LE(js.length, 0); c1.write('JSON', 4);
  const c2 = Buffer.alloc(8); c2.writeUInt32LE(b2.length, 0); c2.write('BIN\0', 4);
  return Buffer.concat([h, c1, js, c2, b2]);
}

/** сетка без картинок (картинки — отдельными файлами): буферы картинок вырезаются, остальное перепаковывается */
export function splitGlb(buf) {
  const { json, bin } = readGlb(buf);
  const imgViews = new Set((json.images ?? []).map((im) => im.bufferView).filter((v) => v !== undefined));
  const images = (json.images ?? []).map((im) => {
    const v = json.bufferViews[im.bufferView];
    return { name: im.name ?? '', mime: im.mimeType ?? '', data: bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength) };
  });
  const parts = []; let off = 0;
  json.bufferViews.forEach((v, i) => {
    if (imgViews.has(i)) return;
    const d = bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
    const pad = (4 - (off % 4)) % 4;
    if (pad) { parts.push(Buffer.alloc(pad)); off += pad; }
    parts.push(d);
    v.byteOffset = off; off += d.length;
  });
  const keep = json.bufferViews.map((v, i) => (imgViews.has(i) ? null : v));
  const idx = new Map(); let k = 0;
  keep.forEach((v, i) => { if (v) idx.set(i, k++); });
  json.bufferViews = keep.filter(Boolean);
  for (const a of json.accessors ?? []) if (a.bufferView !== undefined) a.bufferView = idx.get(a.bufferView);
  // картинки → ссылки на внешние файлы (не грузятся, но индексы текстур и материалов целы)
  json.images = (json.images ?? []).map((im, i) => ({ name: im.name, uri: `img${i}`, mimeType: im.mimeType }));
  json.buffers = [{ byteLength: off }];
  return { glb: writeGlb(json, Buffer.concat(parts)), images };
}

async function main() {
  const d = JSON.parse(fs.readFileSync(opt('--prompts', 'scripts/models/t2m_prompts_v2.json'), 'utf8'));
  const redo = new Set(list(opt('--redo', '')));
  const models = pickModels(d, [...new Set([...list(opt('--only', '')), ...redo])]);
  const STATE = opt('--state', '/var/lib/vershov-commander/ar/meshy');
  const OUT = opt('--out3d', '/srv/ar-extra/models/props');
  const RAW = opt('--raw', process.env.MESHY_RAW || 'https://raw.githubusercontent.com/vsershov21-spec/ar/main');
  const stateFile = path.join(STATE, 'image3d_state.json');
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
  const save = () => { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(state, null, 1)); };
  const key = readKey(opt('--env', '/etc/ar-meshy.env'));
  const api = key ? makeApi(key) : null;
  let bal = null;
  if (api) {
    try {
      bal = (await api.get('/balance'))?.balance ?? null;
      log(`баланс: ${bal} кредитов`);
    } catch (e) {
      log(`баланс: не узнал (${e.message})`);
    }
  } else log('ключа нет — только план');
  const done = (m) => !redo.has(m.id) && fs.existsSync(path.join(OUT, `${m.id}_geo.glb`));
  const todo = models.filter((m) => !done(m));
  const paid = (m) => !redo.has(m.id) && state[m.id]?.task_id; // уже отправлено — дождаться, кредиты не нужны
  const est = todo.filter((m) => !paid(m)).reduce((s, m) => s + m.estimate, 0);
  for (const m of models) log(`• ${m.id}: ${done(m) ? 'готово' : paid(m) ? `ждём задачу ${state[m.id].task_id}` : `~${m.estimate} кр.`} — ${m.images.length} вида, ${m.params.ai_model ?? 'latest'}`);
  log(`к генерации: ${todo.length} из ${models.length}; оценка ≈ ${est} кредитов${bal != null ? `; баланс ${bal}${bal < est ? ' — НЕ ХВАТИТ' : ''}` : ''}`);
  if (!has('--go')) return;
  if (!api) throw new Stop('нет ключа');
  const maxCr = opt('--max-credits', '');
  if (maxCr !== '' && !(est <= Number(maxCr))) throw new Stop(`оценка ${est} кредитов > --max-credits ${maxCr} — не запускаю`);
  fs.mkdirSync(OUT, { recursive: true });
  for (const m of todo) {
    try {
      if (redo.has(m.id)) delete state[m.id];
      if (!state[m.id]?.task_id) {
        const urls = [];
        for (const f of m.images) {
          const b = await fetchBuf(`${RAW}/${f}`);
          const mime = f.endsWith('.png') ? 'image/png' : f.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
          urls.push(`data:${mime};base64,${b.toString('base64')}`);
        }
        const body = { ...m.params, image_urls: urls };
        log(`▶ ${m.id}: отправляю (${m.images.join(', ')})`);
        const r = await api.post('/multi-image-to-3d', body);
        if (r.error) { log(`✗ ${m.id}: не принято — ${r.error}`); continue; }
        if (r.uncertain) { log(`✗ ${m.id}: ответ неясен (${r.uncertain}) — не переотправляю, проверить в кабинете Meshy`); state[m.id] = { uncertain: r.uncertain, at: new Date().toISOString() }; save(); continue; }
        state[m.id] = { task_id: r.id, at: new Date().toISOString(), params: m.params, images: m.images };
        save();
      }
      const id = state[m.id].task_id;
      const t0 = Date.now(); let last = -1; let t;
      for (;;) {
        t = await api.get(`/multi-image-to-3d/${id}`);
        if (['SUCCEEDED', 'FAILED', 'CANCELED'].includes(t.status)) break;
        if (t.progress !== last && (t.progress ?? 0) % 20 === 0) log(`  … ${m.id}: ${t.status} ${t.progress ?? 0}%`);
        last = t.progress;
        if (Date.now() - t0 > 40 * 60000) { t = { status: 'TIMEOUT' }; break; }
        await sleep(8000);
      }
      if (t.status !== 'SUCCEEDED') {
        log(`✗ ${m.id}: ${t.status} ${JSON.stringify(t.task_error ?? '')}`);
        if (t.status === 'FAILED' || t.status === 'CANCELED') { delete state[m.id].task_id; state[m.id].failed = t.status; save(); }
        continue;
      }
      const glbUrl = t.model_urls?.glb;
      if (!glbUrl) { log(`✗ ${m.id}: нет glb в ответе`); continue; }
      const buf = await fetchBuf(glbUrl);
      const { glb, images } = splitGlb(buf);
      fs.writeFileSync(path.join(OUT, `${m.id}_geo.glb`), glb);
      images.forEach((im, k) => fs.writeFileSync(path.join(OUT, `${m.id}_img${k}.png`), im.data));
      if (buf.length <= GLB_MAX) fs.writeFileSync(path.join(OUT, `${m.id}.glb`), buf);
      if (t.thumbnail_url) {
        try { fs.writeFileSync(path.join(OUT, `${m.id}.png`), await fetchBuf(t.thumbnail_url)); } catch { /* превью не важно */ }
      }
      for (const [v, u] of Object.entries(t.thumbnail_urls ?? {})) {
        try { fs.writeFileSync(path.join(OUT, `${m.id}_thumb_${v}.png`), await fetchBuf(u)); } catch { /* не важно */ }
      }
      const info = { id: t.id, model: m.params.ai_model ?? 'latest', consumed_credits: t.consumed_credits, params: m.params, images: m.images,
        glbBytes: buf.length, imgs: images.map((im, k) => ({ k, name: im.name, mime: im.mime, bytes: im.data.length })) };
      fs.writeFileSync(path.join(OUT, `${m.id}_task.json`), JSON.stringify(info, null, 1));
      state[m.id].done = new Date().toISOString(); state[m.id].credits = t.consumed_credits; save();
      log(`✓ ${m.id}: GLB ${(buf.length / 1e6).toFixed(1)} МБ, картинок ${images.length} (${images.map((i) => `${i.mime} ${(i.data.length / 1e6).toFixed(1)}М`).join(', ')}), кредитов ${t.consumed_credits}`);
    } catch (e) {
      if (e instanceof Stop) { log(`■ стоп: ${e.message}`); process.exitCode = 2; break; }
      log(`✗ ${m.id}: ${e.message}`);
    }
  }
  try {
    log(`баланс после: ${(await api.get('/balance'))?.balance}`);
  } catch { /* не важно */ }
  log('готово: файлы в ' + OUT + ' — в server-out задачей script scripts/deploy/mirror-props.sh');
}

const isMain = (() => {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  // вывод идёт в /srv/ar-extra и на сайт: 0644/0755 даже при umask 077 у ar-auto (иначе сборка ar-update — EACCES)
  process.umask(0o022);
  main().catch((e) => {
    log(`✗ ${e instanceof Stop ? 'стоп' : 'ошибка'}: ${e.message}`);
    process.exit(e instanceof Stop ? 2 : 1);
  });
}
