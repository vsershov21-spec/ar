import { describe, expect, it } from 'vitest';
import { FaceLife } from '../src/character/faceLife';
import { VISEME_SHAPE } from '../src/lipsync/visemes';

describe('FaceLife', () => {
  it('рот: «а» широко открыт, «у» — трубочкой, тишина — пусто', () => {
    expect(FaceLife.mouthWeights('D', 1, VISEME_SHAPE.D).mouth_A).toBeGreaterThan(0.9);
    const u = FaceLife.mouthWeights('F', 1, VISEME_SHAPE.F);
    expect(u.mouth_U).toBeGreaterThan(0.7);
    expect(u.mouth_A).toBeLessThan(0.1);
    expect(FaceLife.mouthWeights('E', 1, VISEME_SHAPE.E).mouth_O).toBeGreaterThan(0.6);
    expect(FaceLife.mouthWeights('A', 1, VISEME_SHAPE.A).mouth_M).toBe(1);
    expect(FaceLife.mouthWeights('X', 1, VISEME_SHAPE.X)).toEqual({});
  });
  it('голова двигается во время речи и почти стоит в покое; микромимика появляется в покое', () => {
    let r = 0.3;
    const life = new FaceLife(() => (r = (r * 9301 + 49297) % 233280 / 233280));
    let maxIdle = 0, maxTalk = 0, micro = 0;
    for (let i = 0; i < 600; i++) {
      const w = life.update(1 / 60, { persona: 'kind', preset: 'neutral', open: 0, idle: true });
      maxIdle = Math.max(maxIdle, Math.abs(life.head.yaw));
      micro = Math.max(micro, ...Object.values(w));
    }
    for (let i = 0; i < 300; i++) {
      life.update(1 / 60, { persona: 'kind', preset: 'neutral', open: i % 12 < 6 ? 0.8 : 0.1, idle: true });
      maxTalk = Math.max(maxTalk, Math.abs(life.head.yaw) + Math.abs(life.head.pitch));
    }
    expect(maxIdle).toBeLessThan(0.05);
    expect(maxTalk).toBeGreaterThan(0.08);
    expect(micro).toBeGreaterThan(0.2);
  });
});
