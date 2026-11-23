/** Лицо не залипает (iPhone 23.11): пресет без срока уходит к нейтральному, моргание не замирает, сброс по отмене. */
import { describe, it, expect } from 'vitest';
import { FaceMixer, FACE_HOLD_MAX_S } from '../src/character/face';

const run = (f: FaceMixer, s: number, onFrame?: (b: number) => void) => {
  for (let t = 0; t < s; t += 1 / 30) {
    const b = f.update(1 / 30).blink;
    onFrame?.(b);
  }
};

describe('лицо: срок пресета и сброс', () => {
  it('хмурое лицо реплики без срока держится не дольше FACE_HOLD_MAX_S, потом нейтральное', () => {
    const f = new FaceMixer(() => 0.5);
    f.set('annoyed');
    run(f, FACE_HOLD_MAX_S - 0.5);
    expect(f.preset).toBe('annoyed');
    run(f, 1);
    expect(f.preset).toBe('neutral');
    expect(f.cur.weights.frown ?? 0).toBeLessThan(0.01);
  });
  it('повторный set продлевает срок (реплика держит своё лицо)', () => {
    const f = new FaceMixer(() => 0.5);
    f.set('smug');
    run(f, FACE_HOLD_MAX_S - 1);
    f.set('smug');
    run(f, FACE_HOLD_MAX_S - 1);
    expect(f.preset).toBe('smug');
  });
  it('сон — база без срока; нейтральное — тоже', () => {
    const f = new FaceMixer(() => 0.5);
    f.set('sleep');
    run(f, 30);
    expect(f.preset).toBe('sleep');
    f.set('dizzy', 1000);
    run(f, 1.5);
    expect(f.preset).toBe('sleep');
  });
  it('после спиралей (noBlink) моргание возвращается в пределах 5 с; reset — сразу нейтральное', () => {
    const f = new FaceMixer(() => 0.5);
    f.set('dizzy');
    let blinked = false;
    run(f, 4, (b) => (blinked ||= b > 0.5));
    expect(blinked).toBe(false);
    f.reset();
    expect(f.preset).toBe('neutral');
    run(f, 2, (b) => (blinked ||= b > 0.5));
    expect(blinked).toBe(true);
  });
});
