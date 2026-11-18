// Реакции кота (аудит docs/qa/REACTIONS.md): приоритет и очередь клипов, спокойный возврат в покой, монтаж клипов (cut),
// удержание опорных лап, границы инерциального перехода.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ClipState, clipPriority, calmIdles, IDLE_SKIP } from '../src/character/clipState';
import { CUT_CLIPS, clipDef } from '../src/character/clips';
import { spliceClip } from '../src/character/animPrep';
import { blendSeconds } from '../src/character/animBlend';
import { FootPin } from '../src/character/footPin';
import { PERSONA_META } from '../src/character/personaMeta';
import { emotionFor } from '../src/character/emotions';
import { pilotActions } from '../src/config/pilot';
import { ACTION_ROUTE } from '../src/scenario/actions';

const idles = PERSONA_META.hooligan.idles;

describe('ClipState: приоритет и очередь', () => {
  it('приоритеты: номер > реакция > разговор > покой', () => {
    expect(clipPriority('flip')).toBe(3);
    expect(clipPriority('dance_kind')).toBe(3);
    expect(clipPriority('idle_kind_cocoa')).toBe(3); // фирменное кнопкой — номер, хоть и «idle_» в имени
    expect(clipPriority('poke_head')).toBe(2);
    expect(clipPriority('talk_casual')).toBe(1);
    expect(clipPriority('idle_breathe')).toBe(0);
  });

  it('тап во время сальто не обрывает его, а ждёт и играет после защищённого окна', () => {
    const cs = new ClipState(idles, () => 0.5);
    cs.realDuration.set('flip', 3);
    cs.play('flip');
    cs.update(0.5);
    cs.play('poke_head');
    expect(cs.cur.id).toBe('flip'); // сальто продолжается
    expect(cs.queued?.name).toBe('poke_head');
    // окно — 75% длины (2,25 с): после него тычок играет
    for (let i = 0; i < 60; i++) cs.update(1 / 30);
    expect(cs.cur.id).toBe('poke_head');
    expect(cs.queued).toBeNull();
  });

  it('номер того же уровня и force перебивают сразу; устаревший запрос пропадает', () => {
    const cs = new ClipState(idles, () => 0.5);
    cs.realDuration.set('flip', 3);
    cs.realDuration.set('dance_hooligan', 6);
    cs.play('flip');
    cs.update(0.2);
    cs.play('dance_hooligan');
    expect(cs.cur.id).toBe('dance_hooligan');
    cs.update(0.2);
    cs.play('poke_head', { force: true });
    expect(cs.cur.id).toBe('poke_head');
    // устаревание: петля танца держит окно 3 с, запрос живёт 2,5 с
    const c2 = new ClipState(idles, () => 0.5);
    c2.play('dance_hooligan');
    c2.update(0.1);
    c2.play('laugh');
    for (let i = 0; i < 90; i++) c2.update(1 / 30);
    expect(c2.cur.id).toBe('dance_hooligan');
    expect(c2.queued).toBeNull();
  });

  it('явный покой очищает очередь; реакция на реакцию — сразу (касания не ждут)', () => {
    const cs = new ClipState(idles, () => 0.5);
    cs.play('poke_head');
    cs.update(0.1);
    cs.play('poke_belly');
    expect(cs.cur.id).toBe('poke_belly');
    cs.realDuration.set('jump', 2);
    cs.play('jump');
    cs.play('laugh');
    expect(cs.queued).not.toBeNull();
    cs.play('idle');
    expect(cs.queued).toBeNull();
    expect(cs.idleMode).toBe(true);
  });

  it('после реакции — спокойное дыхание (не вариант покоя с большим движением)', () => {
    const cs = new ClipState(idles, () => 0.99); // весь вес — на последних вариантах
    cs.realDuration.set('poke_head', 1);
    cs.play('poke_head');
    cs.update(1.05);
    expect(cs.idleMode).toBe(true);
    expect(cs.cur.id).toBe('idle_breathe');
  });

  it('из покоя убраны дёрганые варианты (наушники, скейт, кружение…); дыхание — основное', () => {
    for (const p of Object.values(PERSONA_META)) {
      const c = calmIdles(p.idles);
      expect(c.some((i) => IDLE_SKIP.test(i.clip))).toBe(false);
      expect(c.find((i) => i.clip === 'idle_breathe')!.weight).toBeGreaterThanOrEqual(8);
    }
  });
});

describe('монтаж клипов (cut) и переход', () => {
  const track = (name: string, fn: (t: number) => number, dur = 5) => {
    const times: number[] = [], v: number[] = [];
    const q = new THREE.Quaternion(), ax = new THREE.Vector3(1, 0, 0);
    for (let t = 0; t <= dur + 1e-6; t += 1 / 30) {
      times.push(t);
      v.push(...q.setFromAxisAngle(ax, fn(t)).toArray());
    }
    return new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, times, v);
  };

  it('склейка кусков: длина = сумма кусков, стык без скачка (≤ скорости исходника)', () => {
    // поза: 0 → 1 рад за 1 с, держит, к 4 с возвращается: вырезаем «держит»
    const f = (t: number) => (t < 1 ? t : t < 3 ? 1 : t < 4 ? 1 - (t - 3) : 0);
    const src = new THREE.AnimationClip('poke', 5, [track('mixamorigHead', (t) => f(t) + 0.3 * Math.sin(t * 7))]);
    const out = spliceClip(src, [[0, 1.2], [3.2, 4.5]], 'poke_x');
    expect(out.name).toBe('poke_x');
    expect(out.duration).toBeCloseTo(1.2 + 1.3, 1);
    const v = out.tracks[0].values;
    const a = new THREE.Quaternion(), b = new THREE.Quaternion();
    let maxStep = 0;
    for (let i = 4; i < v.length; i += 4) maxStep = Math.max(maxStep, a.fromArray(v, i - 4).angleTo(b.fromArray(v, i)));
    // у исходника шаг до ~ (1 + 2,1) рад/с / 30 ≈ 0,1 рад за кадр; разрыв на стыке ≈ 0,6 рад снимается за 0,25 с —
    // шаг не больше ~0,2 рад (без смешивания был бы 0,6 за один кадр)
    expect(maxStep).toBeLessThan(0.22);
    expect(src.duration).toBe(5); // исходник не тронут
  });

  it('cut в каталоге: тычки и «обиделся» — не длиннее 3 с, куски внутри исходника', () => {
    expect(CUT_CLIPS.length).toBeGreaterThan(5);
    for (const d of CUT_CLIPS) {
      const len = d.cut!.keep.reduce((s, [a, b]) => s + (b - a), 0) / (d.cut!.speed ?? 1);
      for (const [a, b] of d.cut!.keep) expect(b).toBeGreaterThan(a);
      if (/^poke_|offended|celebrate/.test(d.id)) expect(len).toBeLessThanOrEqual(3.8);
    }
    expect(clipDef('offended')?.cut?.src).toBe('fold_arms');
  });

  it('границы инерциального перехода: 0,15…0,6 с, возврат в покой мягче реакции', () => {
    expect(blendSeconds(0, 'idle_breathe', 'poke_head')).toBe(0.15);
    expect(blendSeconds(5000, 'flip', 'dance_kind')).toBe(0.6);
    expect(blendSeconds(60, 'poke_head', 'idle_breathe')).toBeGreaterThanOrEqual(0.45);
    expect(blendSeconds(300, 'idle_breathe', 'idle_look_around')).toBe(0.6);
  });
});

describe('FootPin: опорные лапы не едут', () => {
  it('стопа стоит, клип двигает её под тазом — тело сдвигается, видимая стопа на месте', () => {
    const pin = new FootPin();
    let worst = 0;
    for (let i = 0; i < 60; i++) {
      const dx = 0.002 * i; // клип тянет стопу на 0,12 роста за 2 с
      const off = pin.update(1 / 30, [[0.1 + dx, 0, 0], [-0.1 + dx, 0, 0]], true);
      worst = Math.max(worst, Math.abs(0.1 + dx + off.x - 0.1));
    }
    // видимая стопа уехала только на «ползучий» возврат (≤ 0,03 роста/с) и предел сдвига
    expect(worst).toBeLessThan(0.07);
  });

  it('без опоры (прыжок) и выключено (ходьба) — сдвиг уходит к нулю плавно', () => {
    const pin = new FootPin();
    for (let i = 0; i < 20; i++) pin.update(1 / 30, [[0.1 + 0.003 * i, 0, 0], [-0.1 + 0.003 * i, 0, 0]], true);
    const x0 = Math.abs(pin.x);
    expect(x0).toBeGreaterThan(0.02);
    let prev = x0, maxJump = 0;
    for (let i = 0; i < 30; i++) {
      pin.update(1 / 30, [[0.1, 0.2, 0], [-0.1, 0.2, 0]], true); // лапы в воздухе
      maxJump = Math.max(maxJump, prev - Math.abs(pin.x));
      prev = Math.abs(pin.x);
    }
    expect(Math.abs(pin.x)).toBeLessThan(x0 * 0.1);
    expect(maxJump).toBeLessThan(0.01); // без рывка
  });

  it('сдвиг ограничен', () => {
    const pin = new FootPin();
    for (let i = 0; i < 200; i++) pin.update(1 / 30, [[0.02 * i, 0, 0], [0.02 * i, 0, 0]], true);
    expect(Math.hypot(pin.x, pin.z)).toBeLessThanOrEqual(0.14 + 1e-9);
  });
});

describe('палец на коте', () => {
  it('interpreter: touch_down сразу при касании кота (до распознавания жеста), мимо кота — нет', async () => {
    const { TouchInterpreter } = await import('../src/input/interpreter');
    const ev: { type: string }[] = [];
    const it2 = new TouchInterpreter((e) => ev.push(e), (x: number) => (x > 100 ? 'head' : null));
    it2.down(150, 100, 0);
    expect(ev[0]).toMatchObject({ type: 'touch_down', zone: 'head' });
    it2.up(150, 100, 60);
    it2.down(20, 100, 1000);
    expect(ev.filter((e) => e.type === 'touch_down').length).toBe(1);
  });
});

describe('мимика реакций пилота', () => {
  it('у каждого касательного действия пилота есть эмоция лица (у каждого кота)', () => {
    for (const p of ['hooligan', 'kind', 'glitter'] as const)
      for (const a of pilotActions(p)) {
        const r = ACTION_ROUTE[a];
        const ev = 'touch' in r ? r.touch : null;
        if (!ev) continue;
        expect(emotionFor(ev, p), `${p}/${a} → ${ev}`).not.toBeNull();
      }
  });
});

describe('Stage: поза карты сглаживается в сцене', () => {
  it('дрожь и ступеньки трекера (15 Гц) гасятся, быстрый сдвиг догоняется, рывок — сразу', async () => {
    const { AnchorSmoother } = await import('../src/stage');
    const sm = new AnchorSmoother();
    const out = new THREE.Matrix4();
    const M = (x: number, y = 0) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, -0.5), new THREE.Quaternion(), new THREE.Vector3(0.1, 0.1, 0.1));
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    // неподвижная карта с шумом ±1 мм (0,0012 ширины × 0,1 м): новая поза раз в 4 кадра
    let target = M(0), maxDev = 0;
    for (let i = 0; i < 240; i++) {
      if (i % 4 === 0) target = M((i % 8 ? 1 : -1) * 0.0001);
      sm.update(target, 1 / 60, out).decompose(p, q, s);
      if (i > 60) maxDev = Math.max(maxDev, Math.abs(p.x));
    }
    expect(maxDev).toBeLessThan(0.00006); // дрожь меньше вдвое
    // ведут телефон: 0,15 м/с (1,5 ширины/с) — отставание меньше 3 мм
    let x = 0, lag = 0;
    for (let i = 0; i < 60; i++) {
      x += 0.15 / 60;
      sm.update(M(x), 1 / 60, out).decompose(p, q, s);
      if (i > 30) lag = Math.max(lag, x - p.x);
    }
    expect(lag).toBeLessThan(0.003);
    // пересадка на другую карту: сразу
    sm.update(M(1), 1 / 60, out).decompose(p, q, s);
    expect(p.x).toBeCloseTo(1, 5);
  });
});
