/**
 * Хвост Блёстки с искрой (только ?models=v2 — модель с фатином, см. tulleFx.ts): по рефу (design/sheets/glitter_turnaround.jpg,
 * кадр КотоТом 17-11) хвост лавандовый, к кончику — золотые и сиреневые блёстки. Без текстур и без правки GLB:
 * доля хвоста по весам скина (кости Tail1…Tail4, к кончику больше) → атрибут tailT при загрузке, в шейдере — точки-блёстки
 * в координатах покоя (рисунок не плывёт в анимации), гуще к кончику, лёгкое свечение. Тело, оболочки и карточки меха.
 */
import * as THREE from 'three';

/** доля «кончика хвоста» 0..1 по весам скина: Σ w·(k/n) по костям хвоста (k — номер кости в цепочке, n — их число) */
export function tailFactor(idx: ArrayLike<number>, w: ArrayLike<number>, rank: Map<number, number>, n: number): number {
  let t = 0;
  for (let i = 0; i < 4; i++) {
    const r = rank.get(idx[i]);
    if (r !== undefined) t += w[i] * (r / n);
  }
  return Math.min(1, t);
}

/** оболочки меха делят атрибуты скина с телом — tailT один на всех */
const CACHE = new WeakMap<object, THREE.BufferAttribute>();

/** подключить к сеткам со скином, где есть хвост; вернуть число сеток */
export function attachTailSparkle(model: THREE.Object3D): number {
  let n = 0;
  model.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh || !m.skeleton || /^Skirt|^BD_Metal|^Blush|^Brows|^Lid|^Eye|^Mouth/.test(m.name)) return;
    const g = m.geometry;
    const si = g.getAttribute('skinIndex'), sw = g.getAttribute('skinWeight');
    if (!si || !sw) return;
    const rank = new Map<number, number>();
    m.skeleton.bones.forEach((b, i) => {
      const k = b.name.match(/Tail(\d)/);
      if (k) rank.set(i, +k[1]);
    });
    if (!rank.size) return;
    const nb = Math.max(...rank.values());
    let attr = (g.getAttribute('tailT') as THREE.BufferAttribute | undefined) ?? CACHE.get(si);
    if (attr) g.setAttribute('tailT', attr);
    else {
      const a = new Float32Array(si.count);
      let any = false;
      const ix = [0, 0, 0, 0], wx = [0, 0, 0, 0];
      for (let v = 0; v < si.count; v++) {
        for (let c = 0; c < 4; c++) { ix[c] = si.getComponent(v, c); wx[c] = sw.getComponent(v, c); }
        a[v] = tailFactor(ix, wx, rank, nb);
        if (a[v] > 0) any = true;
      }
      if (!any) return;
      attr = new THREE.BufferAttribute(a, 1);
      CACHE.set(si, attr);
      g.setAttribute('tailT', attr);
    }
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) patch(mat as THREE.MeshStandardMaterial);
    n++;
  });
  return n;
}

const DONE = new WeakSet<THREE.Material>();

function patch(m: THREE.MeshStandardMaterial) {
  if (!m || DONE.has(m) || !m.isMeshStandardMaterial) return;
  DONE.add(m);
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    prev?.call(m, sh, r);
    sh.vertexShader =
      'attribute float tailT;\nvarying float vTsT;\nvarying vec3 vTsP;\n' +
      sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vTsT = tailT; vTsP = position;');
    sh.fragmentShader =
      'varying float vTsT;\nvarying vec3 vTsP;\nfloat tsHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }\nfloat tsSpark = 0.0;\nvec3 tsCol = vec3(0.0);\n' +
      sh.fragmentShader
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
  if (vTsT > 0.02) {
    // к кончику: блёстки гуще, мех чуть сиреневее
    float t = smoothstep(0.15, 0.95, vTsT);
    vec3 q = vTsP * 260.0;
    vec3 cell = floor(q);
    float h = tsHash(cell);
    float d = length(fract(q) - 0.5);
    float sp = step(1.0 - 0.32 * t, h) * (1.0 - smoothstep(0.16, 0.36, d));
    tsCol = mix(vec3(0.86, 0.64, 0.3), vec3(0.74, 0.6, 0.92), step(0.5, fract(h * 7.31)));
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.04, 0.97, 1.08), t * 0.5);
    diffuseColor.rgb = mix(diffuseColor.rgb, tsCol, sp);
    tsSpark = sp;
  }`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
  totalEmissiveRadiance += tsCol * tsSpark * 0.3;`,
        );
  };
  const prevKey = m.customProgramCacheKey?.bind(m);
  m.customProgramCacheKey = () => (prevKey ? prevKey() : '') + '|tail-spark-v1';
  m.needsUpdate = true;
}
