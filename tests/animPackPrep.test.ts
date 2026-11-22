// Пакеты движений (scripts/build/anim-pack.mjs) против исходной библиотеки anims_v1.glb — после той же подготовки,
// что в рантайме (animPrep.prepareClip, монтаж GlbCharacter.cutClips): сглаживание σ, обрезка, длительность, темп —
// те же, позы по кадрам 30 к/с — в пределах допуска прореживания (0,5° на сустав).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { prepareClip } from '../src/character/animPrep';
import { GlbCharacter } from '../src/character/glbCharacter';
import { clipDef } from '../src/character/clips';
import { startClipNames } from '../src/character/animPacks';
// @ts-expect-error — JS-модуль сборки без типов
import { packAnims } from '../scripts/build/anim-pack.mjs';

const SRC = readFileSync('public/models/anims_v1.glb');
const DEFS = JSON.parse(readFileSync('content/animations.json', 'utf8')).clips;

async function parse(buf: Uint8Array): Promise<THREE.AnimationClip[]> {
  await MeshoptDecoder.ready;
  const l = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return (await l.parseAsync(ab, '')).animations;
}
const libIndex = (c: THREE.AnimationClip) => Number((c.userData as { libIndex?: number }).libIndex ?? 0);
const libOrder = (cs: THREE.AnimationClip[]) => [...cs].sort((a, b) => libIndex(a) - libIndex(b));

// имена костей «модели»: первый скелет библиотеки без суффиксов _N (как у кота v2 — один скелет)
const NAMES = new Set(['Armature', ...'Hips Spine Spine1 Spine2 Neck Head LeftShoulder LeftArm LeftForeArm LeftHand RightShoulder RightArm RightForeArm RightHand LeftUpLeg LeftLeg LeftFoot LeftToeBase RightUpLeg RightLeg RightFoot RightToeBase'.split(' ').map((n) => 'mixamorig' + n)]);
const opts = {
  isLoop: (n: string) => GlbCharacter.aliasIds(n).some((id) => clipDef(id)?.loop),
  keepSpeed: (n: string) => /dance|run|jump|flip|dive|fall|tumble|celebrate|cheer/.test(n),
};

function prep(clips: THREE.AnimationClip[]) {
  const cuts = GlbCharacter.cutClips(clips);
  const out = new Map<string, { info: ReturnType<typeof prepareClip>; clip: THREE.AnimationClip }>();
  // одноимённые клипы: ключ — имя + номер вхождения
  const seen = new Map<string, number>();
  for (const c of [...clips, ...cuts.map((x) => x.clip)]) {
    const k = c.name + '#' + (seen.get(c.name) ?? 0);
    seen.set(c.name, (seen.get(c.name) ?? 0) + 1);
    out.set(k, { info: prepareClip(c, NAMES, opts), clip: c });
  }
  return out;
}

/** макс. угол сустава между подготовленными клипами по времени исходника (обрезка начала могла сдвинуться на кадр-два) */
function maxDeg(a: THREE.AnimationClip, b: THREE.AnimationClip, shift: number) {
  let m = 0;
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
  for (const ta of a.tracks) {
    if (ta.getValueSize() !== 4) continue;
    const tb = b.tracks.find((t) => t.name === ta.name);
    if (!tb) return Infinity;
    const ib = (tb as unknown as { createInterpolant(): THREE.Interpolant }).createInterpolant();
    for (let i = 0; i < ta.times.length; i++) {
      const t = ta.times[i] + shift; // время в клипе b
      if (t < 0 || t > b.duration) continue;
      qa.fromArray(ta.values, i * 4).normalize();
      qb.fromArray(ib.evaluate(t) as unknown as number[], 0).normalize();
      m = Math.max(m, (qa.angleTo(qb) * 180) / Math.PI);
    }
  }
  return m;
}

describe('пакеты движений = исходная библиотека после animPrep', () => {
  it('σ, обрезка, длительность, темп — те же; позы — в пределах допуска', async () => {
    const names = (await parse(SRC)).map((c) => c.name);
    const start = startClipNames(names, DEFS);
    const packs = await packAnims(SRC, { start });
    const a = prep(await parse(SRC));
    const b = prep(libOrder([...(await parse(packs.start)), ...(await parse(packs.rest))]));
    expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
    const bad: string[] = [];
    let worst = 0, trims = 0;
    for (const [k, x] of a) {
      const y = b.get(k)!;
      const ia = x.info, ib = y.info;
      if (ia.smooth !== ib.smooth) bad.push(`${k}: σ ${ia.smooth} → ${ib.smooth}`);
      // обрезка неподвижного начала/конца: порог animPrep — 0,05 рад от крайнего кадра; после прореживания граница
      // может сдвинуться на пару кадров — там кот почти неподвижен (≤ 3° от крайней позы), это не видно
      const dTrim = Math.max(Math.abs(ia.trimStart - ib.trimStart), Math.abs(ia.trimEnd - ib.trimEnd));
      if (dTrim > 0.25) bad.push(`${k}: обрезка ${ia.trimStart.toFixed(2)}/${ia.trimEnd.toFixed(2)} → ${ib.trimStart.toFixed(2)}/${ib.trimEnd.toFixed(2)} с`);
      trims = Math.max(trims, dTrim);
      if (Math.abs(ia.timeScale - ib.timeScale) > 0.02) bad.push(`${k}: темп ${ia.timeScale.toFixed(3)} → ${ib.timeScale.toFixed(3)}`);
      const d = maxDeg(x.clip, y.clip, ia.trimStart - ib.trimStart);
      worst = Math.max(worst, d);
      if (d > 1.5) bad.push(`${k}: поза ${d.toFixed(2)}°`);
    }
    console.info(`пакеты движений: ${a.size} клипов (с монтажом), худшее отклонение сустава после animPrep ${worst.toFixed(2)}°, сдвиг обрезки до ${trims.toFixed(2)} с`);
    expect(bad).toEqual([]);
  }, 120_000);
});
