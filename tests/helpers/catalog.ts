/**
 * Каталог дизайнов карт Сбера (внутренний PDF, в репозиторий не кладём): извлечение картинок pdfimages во
 * временную папку и список номеров — только карты (без стикеров, браслетов, телефона, вырубных форм и скриншота).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { Tex } from './synthCard';

export const CATALOG_PDF = process.env.CATALOG_PDF ?? '/home/claude/cardsamples/sber_card_designs.pdf';

/** номера картинок PDF (pdfimages -list), которые — лицевые стороны карт; 40, 55, 75 — вертикальные */
export const CATALOG_IDS = [
  0, 2, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 28, 29, 31, 33, 35, 38, 39, 40, 41, 42, 43, 44, 48, 55, 56, 57, 65,
  66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 116, 117, 118, 119, 120, 121, 122, 123, 125, 127, 128, 130, 133, 135, 137, 139, 141, 143, 145,
  147, 149, 151, 153, 155, 157, 159, 161,
];
/** дизайны без знака Сбера на лицевой стороне */
export const NO_LOGO_IDS = [29, 41, 42, 43, 121, 123, 125];

let dir: string | null = null;
export function catalogAvailable() {
  return existsSync(CATALOG_PDF);
}

/** картинка дизайна как текстура карты (горизонтально; вертикальные — повёрнуты на 90° по часовой) */
export async function catalogDesign(id: number, width = 300): Promise<Tex> {
  if (!dir) {
    dir = mkdtempSync(join(tmpdir(), 'sbercat-'));
    execFileSync('pdfimages', ['-png', CATALOG_PDF, join(dir, 'img')]);
  }
  const f = readdirSync(dir).find((n) => n === `img-${String(id).padStart(3, '0')}.png`);
  if (!f) throw new Error('нет картинки ' + id);
  let s = sharp(join(dir, f)).removeAlpha();
  const meta = await s.metadata();
  if ((meta.height ?? 0) > (meta.width ?? 0)) s = sharp(await s.rotate(90).toBuffer());
  const { data, info } = await s.resize({ width, height: Math.round(width / 1.586), fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { rgba: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), w: info.width, h: info.height };
}

/** текстура из любого файла картинки (негативы) */
export async function loadTex(file: string, width = 300): Promise<Tex> {
  const { data, info } = await sharp(file).removeAlpha().resize({ width, height: Math.round(width / 1.586), fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { rgba: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), w: info.width, h: info.height };
}
