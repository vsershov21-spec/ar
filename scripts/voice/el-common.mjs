// Общее для озвучки ElevenLabs: пометки интонации, текст для синтеза, задания, хэш.
// Используют scripts/voice/el-batch.mjs (собирает voice-src/el_batch_all.jsonl) и scripts/voice/eleven.mjs (синтез).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spoken } from './spoken.mjs';

// Интонация — английские пометки в квадратных скобках: eleven_v3/v4 их играют, а не читают.
// Русское слово в [] модель прочитала бы вслух, поэтому в тексте реплик квадратных скобок нет (build.py их вырезает).
export const TAGS = {
  happy: '[cheerfully]', excited: '[excited]', cheeky: '[mischievously]', caring: '[softly]', sad: '[sadly]', surprised: '[surprised]',
  shy: '[shyly]', proud: '[proudly]', annoyed: '[annoyed]', playful: '[playfully]', whisper: '[whispers]', sleepy: '[sleepily]',
  offended: '[sulking]', worried: '[worried]', curious: '[curious]', tender: '[softly]', bored: '[bored]', confused: '[confused]',
};
export const tagFor = (emotion) => TAGS[emotion] ?? '';
/** текст, который уходит в ElevenLabs: пометка + текст для синтеза */
export const elText = (l) => [tagFor(l.emotion), spoken(l.text)].filter(Boolean).join(' ');
/** тот же хэш, что писал первый прогон (150 реплик): текст с пометкой + голос + модель + версия */
export const elHash = (text, voiceId, model) => crypto.createHash('sha1').update([text, voiceId, model, 'el1'].join('\u0001')).digest('hex').slice(0, 8);
export const safeName = (id) => id.replace(/[^a-zA-Zа-яА-ЯёЁ0-9._~-]/g, '_');

export function parseCsv(s) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') (cur += '"'), i++;
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') row.push(cur), (cur = '');
    else if (c === '\n') row.push(cur), rows.push(row), (row = []), (cur = '');
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) row.push(cur), rows.push(row);
  const [h, ...rest] = rows;
  return rest.filter((r) => r.length === h.length).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i]])));
}

export function loadVoices(root) {
  const meta = {};
  for (const f of fs.readdirSync(path.join(root, 'content/src')).filter((f) => f.endsWith('.meta.json'))) {
    const m = JSON.parse(fs.readFileSync(path.join(root, 'content/src', f), 'utf8'));
    meta[m.id] = m.voice;
  }
  return meta;
}

const SLOT_RE = /\{(name|answer)\}/;

/**
 * Все задания озвучки: реплики, куски реплик со слотом ({name}/{answer} → префикс ~a и суффикс ~b),
 * вопросы и подсказки загадок, значения слотов (имена из names.ru.txt, ответы загадок) — для каждого характера.
 * Формат задания = строка voice-src/el_batch_all.jsonl.
 */
export function buildJobs(root, { model: modelOverride } = {}) {
  const voices = loadVoices(root);
  const lines = parseCsv(fs.readFileSync(path.join(root, 'gen/voice_lines.csv'), 'utf8'));
  const names = fs.readFileSync(path.join(root, 'content/names.ru.txt'), 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  const jobs = [];
  const push = (persona, j) => {
    const v = voices[persona];
    const model = modelOverride || v.elevenModel || 'eleven_v4';
    jobs.push({ ...j, persona, voice_id: v.elevenVoiceId, model_id: model, h: elHash(j.text, v.elevenVoiceId, model), out: `${persona}/${safeName(j.id)}.mp3`, chars: j.text.length });
  };
  const answers = {};
  /** реплики с {answer}: озвучиваются ещё и целиком для каждой загадки характера (<id>@<загадка>) — без склейки */
  const answerTpl = [];
  for (const l of lines) {
    if (!voices[l.persona]?.elevenVoiceId) continue;
    // строки загадок (<характер>.riddle.r01.q / .hint) — ниже, из dialogs.json (в CSV те же строки). Связки «Подсказка:»
    // (событие riddle_hint, id <характер>.riddle_hint.NN) — обычные реплики: раньше выпадали из озвучки вместе со строками загадок
    if (/\.riddle\.r\d+\.(q|hint)$/.test(l.id)) continue;
    const m = l.text.match(SLOT_RE);
    if (m?.[1] === 'answer') answerTpl.push(l);
    if (!m) {
      push(l.persona, { id: l.id, kind: 'line', event: l.event, emotion: l.emotion, t: l.text, plain: spoken(l.text), text: elText(l) });
      continue;
    }
    const i = l.text.indexOf(m[0]);
    const a = l.text.slice(0, i).trim();
    const rawB = l.text.slice(i + m[0].length);
    const lead = rawB.match(/^[,.!?…]*/)[0];
    const b = rawB.trim().replace(/^[,.!?…\s]+/, '');
    const parts = [a && 'a', b && 'b'].filter(Boolean);
    const common = { kind: 'part', line: l.id, slot: m[1], tpl: l.text, parts, event: l.event, emotion: l.emotion };
    if (a) push(l.persona, { ...common, id: `${l.id}~a`, part: 'a', t: a, plain: spoken(a), text: elText({ emotion: l.emotion, text: a }) });
    if (b) push(l.persona, { ...common, id: `${l.id}~b`, part: 'b', lead, t: b, plain: spoken(b), text: elText({ emotion: l.emotion, text: b }) });
  }
  let riddles = {};
  try {
    riddles = JSON.parse(fs.readFileSync(path.join(root, 'content/dialogs.json'), 'utf8')).riddles ?? {};
  } catch {
    /* нет диалогов */
  }
  for (const [p, list] of Object.entries(riddles)) {
    if (!voices[p]?.elevenVoiceId) continue;
    answers[p] = new Set();
    for (const r of list) {
      for (const part of ['q', 'hint']) if (r[part]) push(p, { id: `${p}.riddle.${r.id}.${part}`, kind: 'line', event: `riddle_${part}`, emotion: 'neutral', t: r[part], plain: spoken(r[part]), text: spoken(r[part]) });
      if (r.answer) answers[p].add(r.answer);
      for (const l of answerTpl.filter((x) => x.persona === p)) {
        const t = l.text.replace('{answer}', r.answer);
        push(p, { id: `${l.id}@${r.id}`, kind: 'line', event: l.event, emotion: l.emotion, tpl: l.text, t, plain: spoken(t), text: elText({ emotion: l.emotion, text: t }) });
      }
    }
  }
  for (const p of Object.keys(voices)) {
    if (!voices[p]?.elevenVoiceId) continue;
    for (const n of names) push(p, { id: `${p}.slot.name.${n}`, kind: 'slot', slot: 'name', v: n, t: n, plain: n, text: `${n}!` });
    for (const a of answers[p] ?? []) push(p, { id: `${p}.slot.answer.${a}`, kind: 'slot', slot: 'answer', v: a, t: a, plain: a, text: `${a}.` });
  }
  return jobs;
}
