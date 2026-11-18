/**
 * `npm run card:blur -- <вход.mp4> [выход.mp4]` — размыть номер карты на записи перед выкладкой на сервер.
 * Карта ведётся тем же конвейером, что в приложении (CardPipeline: поиск → ведение по ключевому кадру), на кадре
 * детектора 320 px; в каждом кадре исходного разрешения пикселизуются нижние 60 % карты (src/tracker/card/blurNumbers.ts).
 * Карта на кадре не найдена — зона прошлого кадра (до 1 с, с запасом). `--strict` — кадры, где карты не видно дольше
 * 1 с, огрубляются целиком (номер не утечёт, но посадку по ним не оценить). Итог проверить глазами: `--preview` пишет лист кадров.
 * Сырые записи с номерами в git и на сервер не кладём (docs/qa/CARD_MATRIX.md).
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { CardPipeline } from '../../../src/tracker/card/pipeline';
import { focalFromFov } from '../../../src/tracker/card/detector';
import { labelCard, type Quad } from '../../../src/tracker/card/geometry';
import { numberZone, pixelatePolygon } from '../../../src/tracker/card/blurNumbers';
import { downsample } from '../../helpers/cardBench';

export async function main(argv: string[]): Promise<number> {
  const args = argv.filter((a) => !a.startsWith('--'));
  const [inp, outArg] = args;
  if (!inp || !existsSync(inp)) {
    console.error('использование: npm run card:blur -- <вход.mp4> [выход.mp4]');
    return 2;
  }
  const out = outArg ?? join(dirname(inp), basename(inp, extname(inp)) + '.blur.mp4');
  const pr = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,avg_frame_rate', '-of', 'csv=p=0', inp], { encoding: 'utf8' });
  const [vw, vh, fr] = pr.stdout.trim().split(',');
  let W = Number(vw), H = Number(vh);
  W -= W % 2;
  H -= H % 2;
  const [fa, fb] = fr.split('/').map(Number);
  const fps = fb ? fa / fb : 30;
  // кадр детектора: длинная сторона 320 (целое уменьшение k)
  const k = Math.max(1, Math.round(Math.max(W, H) / 320));
  const w = Math.floor(W / k), h = Math.floor(H / k);
  const dec = spawn('ffmpeg', ['-v', 'error', '-i', inp, '-vf', `crop=${W}:${H}:0:0`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const enc = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(fps), '-i', '-', '-i', inp, '-map', '0:v', '-map', '1:a?', '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'copy', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const strict = argv.includes('--strict');
  const pipe = new CardPipeline();
  const K = { f: focalFromFov(w, h), cx: w / 2, cy: h / 2 };
  const size = W * H * 4;
  let buf: Buffer = Buffer.alloc(0) as Buffer;
  let last: Quad | null = null, lastAt = -1e9, seen = 0, i = 0, blurred = 0, coarse = 0;
  const handle = async (frame: Buffer) => {
    const rgba = new Uint8ClampedArray(frame.buffer, frame.byteOffset, size);
    const lo = downsample(rgba, W, H, k);
    const r = pipe.process({ rgba: lo, w, h, focal: K.f, lock: seen >= 3, verify: false });
    if (r?.quad && r.score >= 0.5) {
      last = labelCard(r.quad, K, last);
      lastAt = i;
      seen++;
    } else if (!r?.quad) seen = Math.max(0, seen - 1);
    const age = i - lastAt;
    if (last && age <= fps) {
      const q = last.map((p) => ({ x: (p.x + 0.5) * k, y: (p.y + 0.5) * k })) as Quad;
      const zone = numberZone(q, 0.6, age ? 0.1 + 0.2 * Math.min(1, age / fps) : 0.04);
      if (zone) {
        pixelatePolygon(rgba, W, H, zone);
        blurred++;
      }
    } else if (strict && i - lastAt > fps) {
      // --strict: карты нет — огрубляем кадр целиком (клетка 1/40 длинной стороны): номер не утечёт, но такие кадры
      // для оценки посадки бесполезны
      pixelatePolygon(rgba, W, H, [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }], Math.max(W, H) / 40);
      coarse++;
    }
    i++;
    if (!enc.stdin!.write(Buffer.from(rgba.buffer, rgba.byteOffset, size))) await new Promise((res) => enc.stdin!.once('drain', res));
  };
  for await (const chunk of dec.stdout!) {
    buf = (buf.length ? Buffer.concat([buf, chunk as Buffer]) : chunk) as Buffer;
    while (buf.length >= size) {
      const f = Buffer.from(buf.subarray(0, size));
      buf = buf.subarray(size) as Buffer;
      await handle(f);
    }
  }
  enc.stdin!.end();
  await new Promise((res) => enc.on('close', res));
  // сайдкар записи (?rec) — рядом с размытым файлом под тем же именем
  const side = join(dirname(inp), basename(inp, extname(inp)) + '.json');
  const sideOut = join(dirname(out), basename(out, extname(out)) + '.json');
  if (existsSync(side) && side !== sideOut) copyFileSync(side, sideOut);
  console.log(`${out}: кадров ${i}, номер размыт в ${blurred}, кадр огрублён целиком (карты не видно) в ${coarse}`);
  if (argv.includes('--preview')) {
    const sheet = join(dirname(out), basename(out, extname(out)) + '.sheet.jpg');
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', out, '-vf', `fps=1,scale=240:-2,tile=6x4`, '-frames:v', '1', sheet]);
    console.log('лист кадров для проверки глазами: ' + sheet);
  }
  return 0;
}
