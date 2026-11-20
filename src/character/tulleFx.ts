/**
 * Фатин юбки Блёстки по рефу design/cut/glitter: полупрозрачная мятная пачка с мелкой сеткой, золотыми блёстками
 * и золотой полосой по подолу. Только у фатина с разметкой (scripts/models/persona_tune.py: узел Skirt_Glitter,
 * extras.tulleUV — UV0 = (угол/2π, t), t = 0 у пояса … 1 у подола; модели ?models=v2). Без текстур: процедурно
 * в шейдере, десяток ALU; блики блёсток мерцают от взгляда (без времени — без перерисовки).
 */
import * as THREE from 'three';

export interface TulleLook {
  /** доля высоты от подола под золотую полосу */
  band: number;
  /** плотность блёсток 0..1 */
  sparkle: number;
  /** цвет золота (линейный) */
  gold: [number, number, number];
}

export const TULLE_GLITTER: TulleLook = { band: 0.1, sparkle: 0.12, gold: [0.86, 0.55, 0.16] };

/** подключить к фатину модели (если есть разметка); вернуть число мешей */
export function attachTulle(model: THREE.Object3D, look: TulleLook = TULLE_GLITTER): number {
  let n = 0;
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.userData?.tulleUV) return;
    const uv = m.geometry.getAttribute('uv');
    if (!uv) return;
    m.geometry.setAttribute('tulleT', uv);
    const mat = m.material as THREE.MeshStandardMaterial;
    patch(mat, look);
    n++;
  });
  return n;
}

function patch(m: THREE.MeshStandardMaterial, look: TulleLook) {
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    prev?.call(m, sh, r);
    sh.uniforms.uTuGold = { value: new THREE.Vector3(...look.gold) };
    sh.uniforms.uTuK = { value: new THREE.Vector2(look.band, look.sparkle) };
    sh.vertexShader = 'attribute vec2 tulleT;\nvarying vec2 vTu;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vTu = tulleT;');
    sh.fragmentShader =
      'varying vec2 vTu;\nuniform vec3 uTuGold;\nuniform vec2 uTuK;\nfloat tuHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }\n' +
      sh.fragmentShader
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
  {
    float t = vTu.y;
    // мелкая сетка фатина: чуть плотнее по нитям
    vec2 g = vec2(vTu.x * 900.0, t * 140.0);
    float mesh = 0.5 + 0.5 * max(sin(g.x * 3.1416) * sin(g.y * 3.1416), 0.0);
    diffuseColor.a *= 0.82 + 0.25 * mesh;
    // золотая полоса по подолу (мягкий край) и блёстки, гуще к подолу
    float band = smoothstep(1.0 - uTuK.x - 0.03, 1.0 - uTuK.x + 0.02, t);
    vec2 cell = floor(vec2(vTu.x * 420.0, t * 64.0));
    float h = tuHash(cell);
    vec2 f = fract(vec2(vTu.x * 420.0, t * 64.0)) - 0.5;
    float dens = uTuK.y * (0.35 + 0.65 * t);
    float sp = step(1.0 - dens, h) * (1.0 - smoothstep(0.18, 0.42, length(f)));
    vec3 gold = uTuGold;
    diffuseColor.rgb = mix(diffuseColor.rgb, gold, max(band * 0.85, sp));
    diffuseColor.a = max(diffuseColor.a, max(band * 0.92, sp));
    tuSpark = sp + band * 0.25;
  }`,
        )
        .replace('void main() {', 'float tuSpark = 0.0;\nvoid main() {')
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
  totalEmissiveRadiance += uTuGold * tuSpark * 0.35;`,
        );
  };
  const prevKey = m.customProgramCacheKey?.bind(m);
  m.customProgramCacheKey = () => (prevKey ? prevKey() : '') + '|tulle-fx-v1';
  m.needsUpdate = true;
}
