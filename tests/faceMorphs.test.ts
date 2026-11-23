/** Мимика морфами (риг p2): кроссфейд визем, амплитудный фолбэк, пресеты лица → ключи, сроки и сбросы лица. */
import { describe, it, expect } from 'vitest';
import { FaceMorphs, FACE_MORPHS, LIP_FADE_S, ampVisemes, mapFace } from '../src/character/faceMorphs';
import { FaceMixer, FACE_HOLD_MAX_S, facePreset } from '../src/character/face';
import type * as THREE from 'three';

const DT = 1 / 120;
/** меш-заглушка с ключами рига (как FaceSkin p2) */
function fakeMesh(keys: readonly string[] = FACE_MORPHS) {
  const dict: Record<string, number> = {};
  keys.forEach((k, i) => (dict[k] = i));
  return { morphTargetDictionary: dict, morphTargetInfluences: new Array(keys.length).fill(0) } as unknown as THREE.Mesh;
}
const step = (fm: FaceMorphs, s: number, W: Record<string, number> = {}) => {
  for (let t = 0; t < s - 1e-9; t += DT) fm.update(DT, W);
};

describe('липсинк Rhubarb → виземы с кроссфейдом', () => {
  it('кроссфейд 60–90 мс: смена формы рта не мгновенная и не дольше 90 мс', () => {
    expect(LIP_FADE_S).toBeGreaterThanOrEqual(0.06);
    expect(LIP_FADE_S).toBeLessThanOrEqual(0.09);
    const fm = new FaceMorphs([fakeMesh()]);
    fm.setLip('D');
    step(fm, 0.03);
    expect(fm.vis.D).toBeGreaterThan(0.2);
    expect(fm.vis.D).toBeLessThan(0.8);
    step(fm, 0.06);
    expect(fm.vis.D).toBeCloseTo(1, 5);
    expect(fm.vis.X).toBeCloseTo(0, 5);
  });
  it('D → E: сумма весов во время перехода ≈ 1 (рот не «проваливается» в покой между слогами)', () => {
    const fm = new FaceMorphs([fakeMesh()]);
    fm.setLip('D');
    step(fm, 0.1);
    fm.setLip('E');
    for (let k = 0; k < 8; k++) {
      step(fm, 0.01);
      const sum = Object.values(fm.vis).reduce((a, b) => a + b, 0);
      expect(sum).toBeGreaterThan(0.95);
      expect(sum).toBeLessThan(1.05);
    }
    step(fm, 0.1);
    expect(fm.vis.E).toBeCloseTo(1, 5);
    expect(fm.vis.D).toBeCloseTo(0, 5);
  });
  it('каждая визема A–H пишется в свой ключ vis_*, X — покой (все vis_* = 0)', () => {
    const m = fakeMesh();
    const fm = new FaceMorphs([m]);
    const inf = m.morphTargetInfluences!;
    const d = m.morphTargetDictionary!;
    for (const v of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const) {
      fm.setLip(v);
      step(fm, 0.2);
      expect(inf[d[`vis_${v}`]]).toBeCloseTo(1, 5);
      for (const o of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']) if (o !== v) expect(inf[d[`vis_${o}`]]).toBeCloseTo(0, 5);
    }
    // X — пауза: рот закрывается, даже если сглаженное раскрытие липсинка ещё не ноль
    fm.setLip('X', 0.5);
    step(fm, 0.2);
    for (const o of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']) expect(inf[d[`vis_${o}`]]).toBeCloseTo(0, 5);
  });
  it('амплитудный фолбэк: без виземы — по раскрытию рта (0 → покой, 0.45 → C, 0.9 → D)', () => {
    expect(ampVisemes(0).X).toBe(1);
    expect(ampVisemes(0.45).C).toBeCloseTo(1, 5);
    expect(ampVisemes(0.9).D).toBeCloseTo(1, 5);
    const mid = ampVisemes(0.3);
    expect((mid.B ?? 0) + (mid.C ?? 0)).toBeCloseTo(1, 5);
    const fm = new FaceMorphs([fakeMesh()]);
    fm.setLip(null, 0.9);
    step(fm, 0.2);
    expect(fm.vis.D).toBeCloseTo(1, 5);
    expect(fm.talk).toBeCloseTo(1, 5);
  });
});

describe('лицо → ключи рига', () => {
  const W = (id: string) => facePreset(id)!.weights;
  it('пресеты: улыбка с открытым ртом — smile_open, удивление — surprise, «а» без улыбки — vis_D', () => {
    expect(mapFace(W('laugh')).smile_open).toBeGreaterThan(0.9);
    expect(mapFace(W('happy')).smile_open).toBeGreaterThan(0.5);
    expect(mapFace(W('surprised')).surprise).toBe(1);
    expect(mapFace({ mouth_A: 0.6 }).vis_D).toBeGreaterThan(0.6);
    expect(mapFace({ mouth_U: 1 }).vis_F).toBe(1);
  });
  it('совместимость с пресетами sleepy / smug / annoyed / dizzy', () => {
    const sleepy = mapFace(W('sleepy'));
    expect(sleepy.squint).toBeGreaterThan(0.4); // тяжёлые веки — кожа век прищурена (веки — eyeRig)
    expect(sleepy.brow_sad).toBeCloseTo(0.25, 5);
    const smug = mapFace(W('smug'));
    expect(smug.smirk).toBe(1);
    expect(smug.squint).toBeGreaterThan(0.5);
    const annoyed = mapFace(W('annoyed'));
    expect(annoyed.brow_angry).toBeGreaterThan(0.4);
    expect(annoyed.vis_A).toBeCloseTo(0.3, 5); // губы сжаты
    expect(annoyed.frown).toBeCloseTo(0.4, 5);
    expect(annoyed.nose_wrinkle).toBeCloseTo(0.4, 5);
    const dizzy = mapFace(W('dizzy'));
    expect(dizzy.tongue_out).toBeCloseTo(0.2, 5);
    expect(dizzy.smile_open + dizzy.vis_D).toBeGreaterThan(0.2);
  });
  it('моргание и подмигивание — кожа век blink_L/R', () => {
    expect(mapFace({ blink_L: 1, blink_R: 1 }).blink_R).toBe(1);
    const w = mapFace({ wink_R: 1 });
    expect(w.blink_R).toBe(1);
    expect(w.blink_L).toBe(0);
  });
  it('во время речи открытые формы эмоций уступают виземам, улыбка и брови остаются', () => {
    const quiet = mapFace(W('laugh'), 0);
    const talk = mapFace(W('laugh'), 1);
    expect(talk.smile_open).toBeLessThan(quiet.smile_open * 0.3);
    expect(talk.brow_up).toBeCloseTo(quiet.brow_up, 5);
  });
  it('эмоция поверх речи: визема и улыбка складываются в кадре', () => {
    const m = fakeMesh();
    const fm = new FaceMorphs([m]);
    fm.setLip('C');
    step(fm, 0.2, { smile: 0.8 });
    expect(fm.out.vis_C).toBeCloseTo(1, 5);
    expect(fm.out.smile).toBeGreaterThan(0.5);
  });
});

describe('сроки и сбросы лица (1790c3e / 5af2562) с ригом p2', () => {
  const frame = (f: FaceMixer, fm: FaceMorphs, s: number) => {
    for (let t = 0; t < s; t += 1 / 30) fm.update(1 / 30, f.update(1 / 30).weights);
  };
  it('хмурое лицо без срока — не дольше FACE_HOLD_MAX_S, потом ключи рига гаснут', () => {
    const f = new FaceMixer(() => 0.5);
    const fm = new FaceMorphs([fakeMesh()]);
    f.set('annoyed');
    frame(f, fm, 1);
    expect(fm.out.brow_angry).toBeGreaterThan(0.3);
    frame(f, fm, FACE_HOLD_MAX_S);
    expect(f.preset).toBe('neutral');
    for (const k of ['brow_angry', 'frown', 'vis_A', 'squint', 'nose_wrinkle']) expect(fm.out[k]).toBeLessThan(0.01);
  });
  it('сброс (cancelAct → resetFace → FaceMixer.reset) — лицо к нейтральному за 0,2 с', () => {
    const f = new FaceMixer(() => 0.5);
    const fm = new FaceMorphs([fakeMesh()]);
    f.set('laugh', 5000);
    frame(f, fm, 0.5);
    expect(fm.out.smile_open).toBeGreaterThan(0.8);
    f.reset();
    frame(f, fm, 0.25);
    expect(fm.out.smile_open).toBeLessThan(0.01);
    expect(fm.out.squint).toBeLessThan(0.01);
  });
});

describe('поиск мешей рига', () => {
  it('модель без vis_* (p1, рот шейдером) — драйвера нет', () => {
    expect(FaceMorphs.find([fakeMesh(['mouth_A', 'smile', 'brow_up'])])).toBeNull();
  });
  it('p2: FaceSkin, оболочки меха, брови-накладка (только brow_angry) — все ведёт драйвер; румянец — нет', () => {
    const skin = fakeMesh();
    const brows = fakeMesh(['brow_up', 'brow_down', 'brow_angry', 'brow_sad']);
    const blush = fakeMesh(['blush', 'cheek_up']);
    const fm = FaceMorphs.find([skin, brows, blush])!;
    expect(fm).not.toBeNull();
    expect(fm.meshCount).toBe(2);
    fm.update(0.1, { brow_down: 1, frown: 1 });
    expect(brows.morphTargetInfluences![2]).toBeGreaterThan(0.5);
    expect(blush.morphTargetInfluences![0]).toBe(0);
  });
});
