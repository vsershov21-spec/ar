import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Блёстка v5: модель продакта Tripo «как есть» (scripts/models/build_glitter_v5.sh) — вид 1:1, скелет как у Хулигана, веки и морфы */
const read = (f: string) => {
  const b = fs.readFileSync(f);
  return JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString());
};
type J = {
  skins: { joints: number[] }[];
  nodes: { name: string; mesh?: number }[];
  meshes: { name: string; extras?: { targetNames?: string[] } }[];
  materials: { name: string }[];
  asset: { extras?: Record<string, unknown> };
};

describe('glitter v5: флаг ?models=v5', () => {
  it('modelsVariant/variantGlb/collidersUrl: v5 только явным параметром, лицо своё при любом faceMode', async () => {
    const { modelsVariant, variantGlb, collidersUrl } = await import('../src/character/modelVariant');
    expect(modelsVariant('?models=v5', false)).toBe('v5');
    expect(modelsVariant('', false)).toBe('v2');
    expect(variantGlb('/models/glitter_v1.glb', 'v5', 'shader')).toBe('/models/v2/glitter_v5.glb');
    expect(variantGlb('/models/glitter_v1.glb', 'v5', 'morph')).toBe('/models/v2/glitter_v5.glb');
    expect(variantGlb('/models/hooligan_v1.glb', 'v5', 'shader')).toBe('/models/v2/hooligan_p1.glb');
    expect(variantGlb('/models/kind_v1.glb', 'v5', 'morph')).toBe('/models/v2/kind_p2.glb');
    expect(variantGlb('/models/glitter_v1.glb', 'v2', 'shader')).toBe('/models/v2/glitter_p1.glb');
    expect(collidersUrl('/models/v2/glitter_v5.glb')).toBe('/models/v2/glitter_v5_colliders.json');
  });

  it('редакции: ?models=v5 — lab, в MVP и пилоте — только со страницы /test', async () => {
    const { filterSearch, PARAMS } = await import('../src/config/edition');
    expect(filterSearch('?models=v5', 'lab').search).toBe('models=v5');
    expect(filterSearch('?models=v5', 'pilot').search).toBe('');
    expect(filterSearch('?models=v5', 'mvp').search).toBe('');
    expect(filterSearch('?from=test&models=v5', 'pilot').search).toBe('from=test&models=v5');
    expect(PARAMS.models.keep).not.toContain('v5');
  });

  it('GLB: 71 кость как у Хулигана, одна сетка Tripo + веки, ключи рта/бровей, мех как у Хулигана, без накладок лица', () => {
    const v5: J = read('public/models/v2/glitter_v5.glb'), h: J = read('public/models/v2/hooligan_p1.glb');
    const bones = (j: J) => j.skins[0].joints.map((k) => j.nodes[k].name).sort();
    expect(bones(v5)).toEqual(bones(h));
    const names = v5.nodes.map((n) => n.name);
    expect(names).toContain('Body_Glitter_V5');
    expect(names).toContain('Lids_V5');
    expect(names).not.toContain('node_0');
    // лицо Tripo как есть: ни наших глаз, ни шейдерного рта, ни меток лица (FurTone/складки их ищут)
    for (const n of ['Eye_L', 'MouthD', 'Brows', 'Blush']) expect(names).not.toContain(n);
    // мех — те же стадии, что у Хулигана: оболочки (кончики — цвет текстуры, подсветка контура слабее) и пряди силуэта
    expect(names).toContain('BD_FurShell');
    expect(names).toContain('BD_FurCards');
    const fur = (v5.nodes.find((n) => n.name === 'BD_FurShell') as { extras?: { fur?: { tip: number[]; rim: number; density: number } } }).extras!.fur!;
    expect(fur.tip).toEqual([1, 1, 1]);
    expect(fur.rim).toBeLessThan(0.35);
    expect(v5.asset.extras?.glitterV5).toBeTruthy();
    const body = v5.meshes.find((m) => m.name === 'Body_Glitter_V5')!;
    expect(body.extras!.targetNames).toEqual(expect.arrayContaining(['mouth_A', 'mouth_E', 'mouth_O', 'mouth_U', 'mouth_M', 'smile', 'frown', 'brow_up', 'brow_sad']));
    const lids = v5.meshes.find((m) => m.name === 'Lids_V5')!;
    expect(lids.extras!.targetNames).toEqual(['lidL_1', 'lidL_2', 'lidL_3', 'lidL_4', 'lidR_1', 'lidR_2', 'lidR_3', 'lidR_4']);
    const col = JSON.parse(fs.readFileSync('public/models/v2/glitter_v5_colliders.json', 'utf8'));
    expect(col.volumes.map((v: { name: string }) => v.name)).toEqual(expect.arrayContaining(['head', 'torso', 'skirt', 'bow']));
  });

  it('веки: покой — 0, моргание — весь путь, прищур — часть, подмигнуть — одно веко', async () => {
    const { v5LidWeights } = await import('../src/character/v5Face');
    const sum = (w: Record<string, number>, s: string) => [1, 2, 3, 4].reduce((a, k) => a + w[`lid${s}_${k}`], 0);
    expect(sum(v5LidWeights({}), 'L')).toBe(0);
    expect(sum(v5LidWeights({}), 'R')).toBe(0);
    const b = v5LidWeights({ blink_L: 1, blink_R: 1 });
    expect(sum(b, 'L')).toBe(4);
    expect(sum(b, 'R')).toBe(4);
    const half = v5LidWeights({ blink_L: 0.5 });
    expect(half.lidL_1).toBe(1);
    expect(half.lidL_2).toBe(1);
    expect(half.lidL_3).toBe(0);
    const sq = v5LidWeights({ eyes_squint: 1 });
    expect(sum(sq, 'L')).toBeGreaterThan(0.5);
    expect(sum(sq, 'L')).toBeLessThan(4);
    const wk = v5LidWeights({ wink_R: 1 });
    expect(sum(wk, 'R')).toBe(4);
    expect(sum(wk, 'L')).toBe(0);
    // ключ не больше 1 (сумма моргания и прищура не уводит веко за кромку)
    for (const v of Object.values(v5LidWeights({ blink_L: 1, eyes_squint: 1, eyes_laugh: 1 }))) expect(v).toBeLessThanOrEqual(1);
  });

  it('мех: длина по маске — 0 у глаз, носа, рта; щёки длиннее морды; бюджет прядей и вершин оболочек ≈ Хулиган/Добряк', () => {
    const b = fs.readFileSync('public/models/v2/glitter_v5.glb');
    const jl = b.readUInt32LE(12);
    const j = JSON.parse(b.subarray(20, 20 + jl).toString());
    const bin = b.subarray(20 + jl + 8);
    const acc = (i: number) => {
      const a = j.accessors[i], v = j.bufferViews[a.bufferView];
      const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type as 'SCALAR'] * a.count;
      const off = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
      return new Float32Array(bin.buffer.slice(bin.byteOffset + off, bin.byteOffset + off + n * 4));
    };
    const shell = j.meshes.find((m: { name: string }) => m.name === 'BD_FurShell').primitives[0];
    const L = acc(shell.attributes._FURLEN), P = acc(shell.attributes.POSITION);
    const mk = j.asset.extras.glitterV5.marks;
    const near = (c: number[], r: number) => {
      let mx = 0;
      for (let i = 0; i < L.length; i++) {
        const d = Math.hypot(P[3 * i] - c[0], P[3 * i + 1] - c[1], P[3 * i + 2] - c[2]);
        if (d < r) mx = Math.max(mx, L[i]);
      }
      return mx;
    };
    const eyeL = mk.eyeOuterL.map((v: number, k: number) => (v + mk.eyeInnerL[k]) / 2);
    expect(near(eyeL, 0.02)).toBe(0);
    expect(near(mk.nose, 0.015)).toBe(0);
    expect(near(mk.mouth, 0.02)).toBe(0);
    // длина как у Хулигана (голова ≈ 11 мм, щёки до 16), не короткий плюш p4 (2,3 мм)
    let mx = 0;
    for (const v of L) mx = Math.max(mx, v);
    expect(mx).toBeGreaterThan(0.012);
    expect(mx).toBeLessThan(0.02);
    const cards = j.meshes.find((m: { name: string }) => m.name === 'BD_FurCards').primitives[0];
    expect(j.accessors[cards.indices].count / 3).toBeLessThan(5500);
  });

  it('эмоции v5: брови сильнее, хмурый рот закрывает улыбку Tripo, грусть — веки ниже, обида — румянец', async () => {
    const { v5Emote, V5_EMO } = await import('../src/character/v5Face');
    const sad = v5Emote({ brow_sad: 1, frown: 0.65 });
    expect(sad.brow_sad).toBeCloseTo(V5_EMO.browSad);
    expect(sad.mouth_M).toBeGreaterThan(0.5);
    expect(sad.frown).toBeGreaterThan(0.65);
    expect(sad.eyes_sleepy).toBeGreaterThan(0.3);
    // открытый рот (удивление) хмурый рот не закрывает
    expect(v5Emote({ frown: 1, mouth_O: 1 }).mouth_M).toBe(0);
    expect(v5Emote({ frown: 0.9, cheeks_gum: 0.6, brow_down: 0.75 }).blush).toBeGreaterThan(0.3);
    // нейтральное — без изменений
    expect(v5Emote({})).toEqual({});
  });

  it('румянец: центры щёк под глазами, симметрично', async () => {
    const { v5CheekCenters } = await import('../src/character/v5Face');
    const mk = (read('public/models/v2/glitter_v5.glb').asset.extras!.glitterV5 as { marks: Parameters<typeof v5CheekCenters>[0] }).marks;
    const [l, r] = v5CheekCenters(mk);
    expect(l[0]).toBeGreaterThan(0.05);
    expect(r[0]).toBeLessThan(-0.05);
    expect(Math.abs(l[0] + r[0])).toBeLessThan(0.01);
    expect(l[1]).toBeLessThan(mk.eyeBottomL[1]);
  });

  it('живое лицо V5Life: моргания 1,8–6 с с двойными, саккады головой малые, улыбка дышит в покое, брови живут в речи', async () => {
    const { V5Life } = await import('../src/character/v5Face');
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const life = new V5Life(rnd);
    const dt = 1 / 60;
    let maxYaw = 0, smileMin = 1, smileMax = 0, closed = 0;
    for (let i = 0; i < 60 * 120; i++) {
      const o = life.update(dt, 0, 0, 0, true, false);
      maxYaw = Math.max(maxYaw, Math.abs(life.head.yaw));
      smileMin = Math.min(smileMin, o.smile); smileMax = Math.max(smileMax, o.smile);
      if (life.blink > 0.95) closed++;
    }
    // за 2 минуты: 20–60 морганий, часть — двойные
    expect(life.blinks).toBeGreaterThan(20);
    expect(life.blinks).toBeLessThan(60);
    expect(life.doubles).toBeGreaterThan(0);
    expect(life.doubles).toBeLessThan(life.blinks / 3);
    expect(closed).toBeGreaterThan(0);
    expect(maxYaw).toBeGreaterThan(0.01);
    expect(maxYaw).toBeLessThan(0.07);
    expect(smileMax - smileMin).toBeGreaterThan(0.1);
    // речь: брови и щёки двигаются от огибающей рта
    let browMin = 1, browMax = 0;
    for (let i = 0; i < 60 * 6; i++) {
      const open = 0.5 + 0.5 * Math.sin(i * dt * 14);
      const o = life.update(dt, open, 0.4, 1, false, false);
      browMin = Math.min(browMin, o.brow_up ?? 0); browMax = Math.max(browMax, o.brow_up ?? 0);
      expect(o.cheek_up).toBeGreaterThan(0.05);
    }
    expect(browMax - browMin).toBeGreaterThan(0.2);
    // выключено (листы) и noBlink — без моргания и движений
    life.off = true;
    life.update(dt, 0, 0, 0, true, false);
    expect(life.blink).toBe(0);
    expect(life.head.yaw).toBe(0);
  });
});
