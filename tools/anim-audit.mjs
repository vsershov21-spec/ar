import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
const buf = fs.readFileSync(process.argv[2]);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const l = new GLTFLoader(); l.setMeshoptDecoder(MeshoptDecoder);
const g = await l.parseAsync(ab, '');
globalThis.G = g;
const out = [];
for (const c of g.animations) {
  const hp = c.tracks.find(t => /Hips\.position$/.test(t.name));
  const rot = c.tracks.filter(t => t.name.endsWith('.quaternion'));
  const r = { name: c.name, dur: +c.duration.toFixed(2), n: rot[0]?.times.length, tracks: c.tracks.length };
  if (hp) { const v = hp.values; let ymin=1e9,ymax=-1e9,xs=[],zs=[]; for (let i=0;i<v.length;i+=3){ymin=Math.min(ymin,v[i+1]);ymax=Math.max(ymax,v[i+1]);xs.push(v[i]);zs.push(v[i+2]);}
    r.y0 = +v[1].toFixed(3); r.yEnd=+v[v.length-2].toFixed(3); r.ymin=+ymin.toFixed(3); r.ymax=+ymax.toFixed(3);
    r.xr = +(Math.max(...xs)-Math.min(...xs)).toFixed(3); r.zr=+(Math.max(...zs)-Math.min(...zs)).toFixed(3); r.xEnd=+(xs.at(-1)-xs[0]).toFixed(3); r.zEnd=+(zs.at(-1)-zs[0]).toFixed(3);}
  // angular speed & jitter
  let maxW=0, jit=0, cnt=0, loopGap=0; const q0=new THREE.Quaternion(), q1=new THREE.Quaternion(), q2=new THREE.Quaternion();
  for (const t of rot) { const v=t.values, T=t.times; const n=T.length;
    for (let i=1;i<n;i++){ q0.fromArray(v,(i-1)*4); q1.fromArray(v,i*4); const a=q0.angleTo(q1)/(T[i]-T[i-1]); if(a>maxW && !/Tail|Ear/.test(t.name)) {maxW=a; r.maxWBone=t.name.split('.')[0];} }
    for (let i=1;i<n-1;i++){ q0.fromArray(v,(i-1)*4); q1.fromArray(v,i*4); q2.fromArray(v,(i+1)*4); const mid=q0.clone().slerp(q2,0.5); jit+=mid.angleTo(q1); cnt++; }
    q0.fromArray(v,0); q1.fromArray(v,(n-1)*4); loopGap=Math.max(loopGap,q0.angleTo(q1));
  }
  r.maxW=+maxW.toFixed(1); r.jit=+(jit/cnt*1000).toFixed(2); r.loopGap=+loopGap.toFixed(2);
  out.push(r);
}
console.table(out);
