#!/usr/bin/env node
// prebuild: озвучка ElevenLabs с сервера сборки → public/voice/el/ (имена с хэшем) + public/voice/el/manifest.json.
// Источник — первая читаемая из: $VOICE_EL_DIR, /srv/ar-extra/voice-el, /var/lib/vershov-commander/ar/voice-el
// (её наполняет `node scripts/voice/eleven.mjs --run` на swe; файлы там уже нормализованы −16 LUFS и с cues).
// Нет папки (ноутбук, CI) — тихо пропускаем. Сборку не роняет.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dst = path.join(root, 'public/voice/el');
const ok = (d) => {
  try {
    fs.accessSync(path.join(d, 'manifest.json'), fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
};
try {
  const src = [process.env.VOICE_EL_DIR, '/srv/ar-extra/voice-el', '/var/lib/vershov-commander/ar/voice-el'].filter(Boolean).find(ok);
  if (!src) process.exit(0);
  const man = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
  fs.rmSync(dst, { recursive: true, force: true });
  const out = { version: 1, source: 'elevenlabs', lipsync: man.lipsync, lines: {} };
  let n = 0, bytes = 0;
  for (const [id, e] of Object.entries(man.lines ?? {})) {
    const file = path.join(src, e.f);
    if (!fs.existsSync(file)) continue;
    const buf = fs.readFileSync(file);
    const h = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 8);
    const rel = `el/${e.persona ?? id.split('.')[0]}/${id}.${h}.mp3`;
    fs.mkdirSync(path.dirname(path.join(root, 'public/voice', rel)), { recursive: true });
    fs.writeFileSync(path.join(root, 'public/voice', rel), buf);
    out.lines[id] = { f: rel, d: e.d, o: e.o, c: e.c, t: e.t };
    n++;
    bytes += buf.length;
  }
  fs.writeFileSync(path.join(dst, 'manifest.json'), JSON.stringify(out));
  console.log(`pull-server-voice: ElevenLabs ${n} реплик, ${(bytes / 1048576).toFixed(2)} МБ из ${src}`);
} catch (e) {
  console.warn(`pull-server-voice: пропущено (${e.message})`);
}
