#!/usr/bin/env node
// Пайплайн озвучки: voice/lines/<persona>.json + voice-src/<persona>/<id>.wav
//   → громкость −16 LUFS (ffmpeg loudnorm, 2 прохода)
//   → public/sounds/voice/<persona>/<id>.m4a (AAC) + .ogg (Opus)
//   → mouth cues Rhubarb (A–H, X) рядом: <id>.cues.json
//   → public/sounds/voice/manifest.json (длительности, пути, cues)
// Rhubarb: если есть нативный бинарник (RHUBARB_BIN или `rhubarb` в PATH) — используем его с
// языконезависимым распознавателем `-r phonetic` (рекомендуется для русского). Иначе — rhubarb-lip-sync-wasm
// (внутри PocketSphinx с английской моделью: для русского формы рта приблизительные).
// Запуск: npm run voice:build  [--force]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const force = process.argv.includes('--force');
const outRoot = path.join(root, 'public/sounds/voice');
fs.mkdirSync(outRoot, { recursive: true });

const ff = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
const ffStats = (input) => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-i', input, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = r.stderr.match(/\{[\s\S]*?\}/g);
  return m ? JSON.parse(m[m.length - 1]) : null;
};
const duration = (f) => Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout.trim());

function rhubarbBin() {
  const cand = process.env.RHUBARB_BIN || 'rhubarb';
  const r = spawnSync(cand, ['--version'], { encoding: 'utf8' });
  return r.status === 0 ? cand : null;
}
const native = rhubarbBin();
let wasm = null;
async function cues(wavPath, text) {
  if (native) {
    const r = spawnSync(native, ['-r', 'phonetic', '-f', 'json', '--extendedShapes', 'GHX', wavPath], { encoding: 'utf8' });
    if (r.status === 0) return { engine: 'rhubarb-native-phonetic', mouthCues: JSON.parse(r.stdout).mouthCues };
  }
  if (!wasm) wasm = (await import('rhubarb-lip-sync-wasm')).Rhubarb;
  const pcm = path.join(path.dirname(wavPath), '.tmp16k.raw');
  ff(['-i', wavPath, '-ac', '1', '-ar', '16000', '-f', 's16le', pcm]);
  const res = await wasm.getLipSync(fs.readFileSync(pcm));
  fs.rmSync(pcm);
  void text; // русский текст PocketSphinx (англ. словарь) не поможет — не передаём
  return { engine: 'rhubarb-wasm-pocketsphinx', mouthCues: res.mouthCues };
}

const manifestPath = path.join(outRoot, 'manifest.json');
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
let built = 0, skipped = 0, missing = 0;
for (const f of fs.readdirSync(path.join(root, 'voice/lines')).filter((f) => f.endsWith('.json'))) {
  const persona = f.replace(/\.json$/, '');
  const lines = JSON.parse(fs.readFileSync(path.join(root, 'voice/lines', f), 'utf8'));
  manifest[persona] ??= {};
  const od = path.join(outRoot, persona);
  fs.mkdirSync(od, { recursive: true });
  for (const l of lines) {
    const src = path.join(root, 'voice-src', persona, `${l.id}.wav`);
    if (!fs.existsSync(src)) {
      missing++;
      delete manifest[persona][l.id];
      continue;
    }
    const m4a = path.join(od, `${l.id}.m4a`), ogg = path.join(od, `${l.id}.ogg`), cj = path.join(od, `${l.id}.cues.json`);
    const fresh = fs.existsSync(cj) && fs.statSync(cj).mtimeMs > fs.statSync(src).mtimeMs;
    if (!force && fresh && manifest[persona][l.id]) {
      skipped++;
      continue;
    }
    // loudnorm: 1-й проход — измерение, 2-й — линейная нормализация к −16 LUFS
    const s = ffStats(src);
    const ln = s
      ? `loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${s.input_i}:measured_TP=${s.input_tp}:measured_LRA=${s.input_lra}:measured_thresh=${s.input_thresh}:offset=${s.target_offset}:linear=true`
      : 'loudnorm=I=-16:TP=-1.5:LRA=11';
    const norm = path.join(od, `.${l.id}.norm.wav`);
    ff(['-i', src, '-af', `${ln},aresample=48000`, '-ac', '1', norm]);
    ff(['-i', norm, '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', m4a]);
    ff(['-i', norm, '-c:a', 'libopus', '-b:a', '64k', ogg]);
    const c = await cues(norm, l.text);
    fs.writeFileSync(cj, JSON.stringify(c));
    manifest[persona][l.id] = {
      text: l.text, emotion: l.emotion, event: l.event, duration: +duration(norm).toFixed(3),
      src: [`sounds/voice/${persona}/${l.id}.m4a`, `sounds/voice/${persona}/${l.id}.ogg`],
      cues: `sounds/voice/${persona}/${l.id}.cues.json`, lipsync: c.engine,
    };
    fs.rmSync(norm);
    built++;
    console.log(`  ✓ ${persona}/${l.id}  ${manifest[persona][l.id].duration}s  cues=${c.mouthCues.length} (${c.engine})`);
  }
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
console.log(`Готово: собрано ${built}, без изменений ${skipped}, без записи ${missing} (будут озвучены speechSynthesis-фоллбэком).`);
if (!native) console.log('Подсказка: для русского точнее нативный Rhubarb с `-r phonetic` — см. docs/VOICE.md.');
