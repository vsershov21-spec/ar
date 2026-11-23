/**
 * Записи с iPhone 23.11 (пилот /mvp) — регрессии проверки «карта Сбера» и позы (docs/qa/CARD_MATRIX.md, «23.11»):
 *  1) золотая карта другого банка (знак-«мишень» в углу) проходила проверку знака — кот садился;
 *  2) старый «СБЕРБАНК» с маленьким знаком принимался не сразу (на мелкой карте кадры без знака разбавляли окно);
 *  4) ведение потоком/по поверхности поворачивало нормаль карты на 28° за ответ воркера — Блёстка «падала» набок.
 * Сами записи в репозиторий не кладём; здесь — синтетика тех же ситуаций и отпечатки (int8, не изображения).
 */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { readdirSync } from 'node:fs';
import * as THREE from 'three';
import { CardEvidence, classifyCard, SMALL_PX, type CardVerdict } from '../../src/tracker/card/verify';
import { foreignDb } from '../../src/tracker/card/fingerprint';
import { FOREIGN_DB_INFO } from '../../src/tracker/card/foreignDb';
import { CardSession } from '../../src/tracker/card/session';
import { renderCardScene, rng, type Tex } from '../helpers/synthCard';
import { design, SBER_DESIGNS } from '../helpers/cardDesigns';

const FIX = new URL('../fixtures/cards/designs/', import.meta.url).pathname;

const v = (o: { logo?: number; chip?: number; px?: number; foreign?: number; designHit?: boolean }): CardVerdict => ({
  card: 1,
  sber: o.logo ?? 0,
  side: 'front',
  ms: 0,
  f: { chip: o.chip ?? 0.8, back: 0, logo: o.logo ?? 0, green: 0, design: 0, designHit: !!o.designHit, designId: o.designHit ? 7 : -1, foreign: o.foreign ?? -1, ps: 0, corners: 0.5, tex: 1, flat: 0, sharp: 1, px: o.px ?? 160 },
});

describe('карта другого банка не проходит за Сбер (запись 23.11, 13:58:42)', () => {
  it('знак ровно 0,81 в каждом кадре (кольцо-«мишень» на 7 px) — не Сбер: нужен хотя бы один уверенный кадр', () => {
    const ev = new CardEvidence();
    for (let i = 0; i < 12; i++) ev.push(v({ logo: 0.81, chip: 0.9 }));
    expect(ev.state).not.toBe('sber');
    // знак Сбера в резком кадре — 1,0: тогда хватает двух кадров, как раньше
    const ev2 = new CardEvidence();
    ev2.push(v({ logo: 0.81 }));
    expect(ev2.push(v({ logo: 1 }))).toBe('sber');
  });

  it('известная чужая карта по отпечатку: «знак» в этих кадрах не считается, через 2 кадра — «другой банк»', () => {
    const ev = new CardEvidence();
    ev.push(v({ logo: 1, foreign: 1001 }));
    expect(ev.push(v({ logo: 1, foreign: 1001 }))).toBe('card');
  });

  it('база чужих карт есть и не узнаёт карты Сбера (каталог на столе, процедурные дизайны)', async () => {
    expect(foreignDb().length).toBe(FOREIGN_DB_INFO.n);
    expect(foreignDb().length).toBeGreaterThanOrEqual(1);
    const texs: Tex[] = [];
    for (const f of readdirSync(FIX).sort()) {
      const { data, info } = await sharp(FIX + f).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      texs.push({ rgba: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), w: info.width, h: info.height });
    }
    for (const k of [...SBER_DESIGNS, 'sber-old'] as const) texs.push(design(k, 1));
    let n = 0, bad = 0;
    texs.forEach((tex, i) => {
      const R = rng(100 + i);
      for (let s = 0; s < 3; s++) {
        const f = renderCardScene({ w: 480, h: 360, tilt: 10 + R() * 40, yaw: (R() - 0.5) * 50, dist: 2 + R() * 0.6, tex, noise: 3, seed: i * 7 + s, noiseSeed: s + 1, ss: 2, bg: (['wood', 'white', 'dark'] as const)[s] });
        const r = classifyCard(f, f.corners, { f: f.focal, cx: f.w / 2, cy: f.h / 2 })!;
        n++;
        if ((r.f.foreign ?? -1) >= 0) bad++;
      }
    });
    expect(n).toBeGreaterThan(50);
    expect(bad).toBe(0);
  }, 120_000);

  it('синтетическая «мишень» на золотой карте знаком Сбера не становится', () => {
    const R = rng(3);
    const ev = new CardEvidence();
    for (let s = 0; s < 12; s++) {
      const f = renderCardScene({ w: 480, h: 360, tilt: 10 + R() * 40, yaw: (R() - 0.5) * 40, dist: 1.8 + R() * 0.6, tex: design('other-target', 1), noise: 3, seed: s + 1, noiseSeed: s + 1, ss: 2, bg: 'white' });
      ev.push(classifyCard(f, f.corners, { f: f.focal, cx: f.w / 2, cy: f.h / 2 })!);
    }
    expect(ev.state).not.toBe('sber');
  });
});

describe('старый «СБЕРБАНК» с маленьким знаком (запись 23.11, 14:00:33)', () => {
  it('мелкая карта без фрагмента: «знака не видно» не голосует и не отодвигает посадку', () => {
    const ev = new CardEvidence();
    ev.push(v({ logo: 1, px: 165 }));
    for (let i = 0; i < 6; i++) ev.push(v({ logo: 0, chip: 0.4, px: SMALL_PX - 30 }));
    expect(ev.win.length).toBe(1);
    expect(ev.push(v({ logo: 1, px: 165 }))).toBe('sber');
  });

  it('знак ≈ 0,034 ширины карты находится в большинстве кадров (крупная карта — уточнение по источнику)', () => {
    const R = rng(11);
    let hit = 0, n = 0;
    for (const [W, dist] of [[640, 1.6], [640, 1.9], [480, 2.2]] as const)
      for (let s = 0; s < 6; s++) {
        const f = renderCardScene({ w: W, h: W * 0.75, tilt: 10 + R() * 35, yaw: (R() - 0.5) * 40, dist, tex: design('sber-old', 1), noise: 3, seed: s + 1, noiseSeed: s + 1, ss: 2, bg: (['white', 'wood'] as const)[s & 1] });
        const r = classifyCard(f, f.corners, { f: f.focal, cx: f.w / 2, cy: f.h / 2 })!;
        n++;
        if (r.f.logo >= 0.9) hit++;
      }
    expect(hit / n).toBeGreaterThanOrEqual(0.7);
  }, 120_000);
});

describe('поза: неточное ведение не валит кота набок (запись 23.11, 13:58:52)', () => {
  /** поза карты: наклон к камере tilt и крен roll (рад), на расстоянии z ширин карты */
  const pose = (tilt: number, roll: number, z = 2) => {
    const m = new THREE.Matrix4().makeRotationX(-tilt).premultiply(new THREE.Matrix4().makeRotationZ(roll));
    const e = m.elements;
    return { R: [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]], t: [0, -0.3, -z], err: 1 };
  };
  type S = { measure: (p: unknown, q: null, now: number, mode: string) => void; fsm: { state: string }; frame: CardSession['frame'] };
  const normal = (s: S) => {
    const M = s.frame(0.03, null)!;
    return new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(M));
  };
  it('один кадр потока с креном 28° — кот стоит как стоял; три согласных — поворачивается', () => {
    const s = new CardSession(false) as unknown as S;
    s.fsm.state = 'locked';
    for (let i = 0; i < 5; i++) s.measure(pose(0.9, 0), null, 1000 + i * 50, 'key');
    const n0 = normal(s);
    s.measure(pose(0.9, 0.5), null, 1300, 'track');
    expect(normal(s).angleTo(n0)).toBeLessThan(0.05);
    s.measure(pose(0.9, 0.5), null, 1350, 'track');
    s.measure(pose(0.9, 0.5), null, 1400, 'track');
    expect(normal(s).angleTo(n0)).toBeGreaterThan(0.2);
  });
});
