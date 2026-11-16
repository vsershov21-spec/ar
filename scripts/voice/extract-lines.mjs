#!/usr/bin/env node
// Собирает список реплик для озвучки из public/personas/*.json → voice/lines/<persona>.json
// (id, text, emotion, event). Уже назначенные id/эмоции сохраняются; новые тексты получают новые id.
// Запуск: npm run voice:lines
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EMO = {
  tap_cat: 'playful', tap_screen: 'cheeky', swipe: 'cheeky', longpress: 'tender', shake: 'surprised', spam: 'annoyed',
  silence: 'bored', sticker_peel: 'playful', card_lost: 'worried', card_found: 'happy', money: 'confident', flip: 'excited',
  dance: 'excited', riddle: 'playful', hello: 'happy', joke: 'playful', unknown: 'confused', signature: 'proud', filler: 'calm',
  intro: 'curious', nice_name: 'happy', no_name: 'playful', choose: 'curious', invite: 'cheeky', outro: 'warm', welcome_back: 'happy',
  switch_start: 'secretive', shake_prompt: 'excited', hello_new: 'proud', yes: 'happy', no: 'calm', skip: 'calm',
};
for (const f of fs.readdirSync(path.join(root, 'public/personas')).filter((f) => f.endsWith('.json'))) {
  const p = JSON.parse(fs.readFileSync(path.join(root, 'public/personas', f), 'utf8'));
  const outFile = path.join(root, 'voice/lines', `${p.id}.json`);
  const prev = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : [];
  const byText = new Map(prev.map((l) => [l.text, l]));
  const used = new Set(prev.map((l) => l.id));
  const lines = [];
  const add = (event, arr) =>
    (arr ?? []).forEach((l, i) => {
      const text = typeof l === 'string' ? l : l.text;
      const old = byText.get(text);
      let id = old?.id ?? `${event}_${i + 1}`;
      while (!old && used.has(id) && !lines.some((x) => x.id === id && x.text === text)) id = `${id}b`;
      used.add(id);
      lines.push({ id, text, emotion: old?.emotion ?? EMO[event] ?? 'neutral', event });
    });
  for (const [k, v] of Object.entries(p.lines)) add(k, v);
  for (const [k, r] of Object.entries(p.reactions)) add(k, r.lines);
  add('signature', p.signature.lines);
  fs.writeFileSync(outFile, JSON.stringify(lines, null, 1) + '\n');
  console.log(`${p.id}: ${lines.length} реплик → ${path.relative(root, outFile)}`);
}
