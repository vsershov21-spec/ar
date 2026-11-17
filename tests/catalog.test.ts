import { describe, it, expect, vi } from 'vitest';
import { FX_IDS, resolveFx, setFxCatalogLogger } from '../src/fx/catalog';
import { CLIP_IDS, resolveClip, IdlePicker, knownClip } from '../src/character/clips';
import { ClipState } from '../src/character/clipState';
import { FaceMixer, facePreset, FACE_IDS } from '../src/character/face';
import { RIG_CLIPS } from '../src/character/rigClips';
import { PERSONA_META, nextPersona } from '../src/character/personaMeta';

describe('каталоги content/', () => {
  it('эффекты: fxTuning характера поверх fx.json, неизвестный id — заглушка с предупреждением', () => {
    expect(FX_IDS.length).toBeGreaterThanOrEqual(31);
    const k = resolveFx('knock', PERSONA_META.hooligan.fxTuning);
    expect(k.params).toMatchObject({ rings: 3, shakePx: 5, ringMaxPx: 90 });
    const warn = vi.fn();
    setFxCatalogLogger(warn);
    const s = resolveFx('нет_такого');
    expect(s.stub).toBe(true);
    resolveFx('нет_такого');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('для каждого клипа каталога есть процедурная заглушка рига', () => {
    expect(CLIP_IDS.length).toBe(71);
    const missing = CLIP_IDS.filter((id) => !RIG_CLIPS[id]);
    expect(missing).toEqual([]);
    for (const id of CLIP_IDS) {
      const p = RIG_CLIPS[id](0.5, 1);
      for (const v of Object.values(p.b)) expect(v.every(Number.isFinite)).toBe(true);
    }
  });

  it('старые имена и dance по характеру', () => {
    expect(resolveClip('appear')?.id).toBe('appear_jump_in');
    expect(resolveClip('dance', 'kind')?.id).toBe('dance_kind');
    expect(knownClip('talk')).toBe(true);
    expect(resolveClip('абракадабра')).toBeNull();
  });

  it('idle по весам: не повторяет подряд, держит петлю 4–9 с', () => {
    const p = new IdlePicker(PERSONA_META.kind.idles);
    let prev = '';
    for (let i = 0; i < 50; i++) {
      const n = p.next(prev);
      expect(n).not.toBe(prev);
      prev = n;
    }
    for (let i = 0; i < 20; i++) {
      const h = p.holdS();
      expect(h).toBeGreaterThanOrEqual(4);
      expect(h).toBeLessThanOrEqual(9);
    }
  });

  it('ClipState: переход blendInMs, возврат в idle, additive поверх', () => {
    const cs = new ClipState(PERSONA_META.hooligan.idles, () => 0.1);
    cs.play('poke_head');
    expect(cs.cur.id).toBe('poke_head');
    expect(cs.blend).toBe(0);
    cs.update(0.03);
    expect(cs.blend).toBeCloseTo(0.5, 1); // blendInMs 60
    cs.play('tail_wag');
    expect(cs.cur.id).toBe('poke_head');
    expect(cs.additive.map((a) => a.id)).toContain('tail_wag');
    cs.update(1.0);
    expect(cs.idleMode).toBe(true);
    expect(cs.cur.id.startsWith('idle')).toBe(true);
    expect(cs.requested).toBe('idle');
  });

  it('лицо: переход 120–200 мс, моргание, кроме noBlink', () => {
    expect(FACE_IDS).toContain('purr');
    const f = new FaceMixer(() => 0);
    f.set('happy');
    f.update(0.08);
    expect(f.cur.weights.smile).toBeGreaterThan(0.1);
    const target = facePreset('happy')!.weights.smile;
    expect(f.cur.weights.smile).toBeLessThan(target);
    f.update(0.1);
    expect(f.cur.weights.smile).toBeCloseTo(target, 2);
    let blinked = false;
    for (let i = 0; i < 400; i++) blinked ||= f.update(0.016).blink > 0.5;
    expect(blinked).toBe(true);
    f.set('purr');
    let any = false;
    for (let i = 0; i < 400; i++) any ||= f.update(0.016).blink > 0;
    expect(any).toBe(false);
  });

  it('смена характера по кругу hooligan → kind → glitter', () => {
    expect([nextPersona('hooligan'), nextPersona('kind'), nextPersona('glitter')]).toEqual(['kind', 'glitter', 'hooligan']);
  });
});
