// Профиль движения клипа по времени (для выбора окна обрезки в content/animations.json, поле cut):
// node tools/anim-profile.mjs public/models/anims_v1.glb poke_head,offended [шаг_с=0.2]
// По шагам: средняя угловая скорость костей тела (рад/с) и отклонение позы от первого кадра (рад, макс. по костям) —
// видно, где «активная» часть клипа, где он стоит на месте, и насколько поза конца далека от начала (стык с покоем).
import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const [file, names, stepArg] = process.argv.slice(2);
const step = Number(stepArg ?? 0.2);
const buf = fs.readFileSync(file);
const l = new GLTFLoader();
l.setMeshoptDecoder(MeshoptDecoder);
const g = await l.parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
const BODY = /(Hips|Spine\d?|Neck|Head|Shoulder|Arm|ForeArm|Hand|UpLeg|Leg|Foot)(_\d+)?\.quaternion$/;
const want = names ? names.split(',') : null;
const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
for (const c of g.animations) {
  const key = c.name.toLowerCase().replace(/^.*\|/, '');
  if (want && !want.includes(key)) continue;
  const rot = c.tracks.filter((t) => BODY.test(t.name));
  const ints = rot.map((t) => t.createInterpolant());
  const at = (t) => ints.map((it) => qa.clone().fromArray(it.evaluate(Math.min(c.duration, t))));
  const p0 = at(0);
  const rows = [];
  for (let t = 0; t < c.duration - 1e-3; t += step) {
    const a = at(t), b = at(Math.min(c.duration, t + step));
    let w = 0, dev = 0;
    a.forEach((q, i) => {
      w += q.angleTo(b[i]) / step;
      dev = Math.max(dev, q.angleTo(p0[i]));
    });
    rows.push(`${t.toFixed(1)}:${(w / a.length).toFixed(2)}/${dev.toFixed(2)}`);
  }
  console.log(`${key} (${c.duration.toFixed(2)} с)  t:ω̄/откл.от.начала`);
  console.log('  ' + rows.join('  '));
}
