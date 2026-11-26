/**
 * Рот кота — накладка MouthD (scripts/models/face_detail.py: сетка на морде от подбородка до носа, повторяет
 * поверхность и ключи челюсти тела). Форму рисует шейдер по весам лица, в 2D-рамке рта (x — поперёк, y — вверх,
 * единица — ширина рта, начало — середина линии рта), в координатах ПОСЛЕ ключей — поэтому нижняя губа идёт
 * вместе с опущенной челюстью, а шов атласа и рваные края геометрии не видны:
 *   • покой — линия «ω» (две дуги от уголков к середине) и тонкий фильтрум к носу;
 *   • открытый рот (mouth_A/E/O/U, смех) — полость с тенью сверху, язык снизу, два клычка, тёмная кромка губ;
 *   • smile/smirk — уголки вверх (smirk — один), frown — уголки вниз и «∩» (надулся), щёки надуты — рот уже;
 *   • mouth_O/U — округлый «о», tongue_out — язык поверх нижней губы.
 * Прозрачная (blend) — одна маленькая сетка ~1000 вершин; вне формы — discard.
 */
import * as THREE from 'three';

export interface MouthExtras {
  o: number[];
  ex: number[];
  ey: number[];
  W: number;
  nose: number;
  jaw: Record<string, number>;
  persona?: string;
  /**
   * своя модель (persona_tune.py, Блёстка p4): лицо в покое вместо базового характера (glbCharacter PERSONA_FACE_*),
   * зубки [форма 0 — клычок, 1 — резец со скруглённым краем; размер; место — доля полуширины рта; ширина рта],
   * язык (как setTongue)
   */
  rest?: Record<string, number>;
  teeth?: [number, number, number, number];
  tongue?: { size?: number; deeper?: number; tone?: number };
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** веса лица → параметры шейдера (чистая функция, для тестов) */
export function mouthParams(W: Record<string, number>, jaw: Record<string, number>) {
  const g = (k: string) => W[k] ?? 0;
  const A = Math.max(0, g('mouth_A')), E = Math.max(0, g('mouth_E')), O = Math.max(0, g('mouth_O')), U = Math.max(0, g('mouth_U'));
  // насколько опустилась челюсть (в долях ширины рта) — как у тела
  const drop = A * (jaw.mouth_A ?? 0.4) + E * (jaw.mouth_E ?? 0.2) + O * (jaw.mouth_O ?? 0.32) + U * (jaw.mouth_U ?? 0.15) + g('tongue_out') * (jaw.tongue_out ?? 0.1);
  const sum = A + E + O + U + 1e-3;
  return {
    drop,
    round: clamp((O + 1.2 * U) / sum, 0, 1) * clamp(sum * 3, 0, 1),
    wide: clamp(E / sum, 0, 1) * clamp(sum * 3, 0, 1),
    press: clamp(g('mouth_M'), 0, 1),
    smile: clamp(g('smile'), 0, 1.2),
    smirk: clamp(g('smirk'), 0, 1),
    frown: clamp(g('frown'), 0, 1),
    tongue: clamp(g('tongue_out'), 0, 1),
    gum: clamp(g('cheeks_gum'), 0, 1),
  };
}

const FRAG_HEAD = `
uniform vec4 uMA; // drop, round, wide, press
uniform vec4 uMB; // smile, smirk, frown, tongue
uniform vec4 uMC; // gum, nose y, style, -
uniform vec4 uMD; // язык: размер, глубже на долю раскрытия, яркость; -
uniform vec4 uME; // зубки: форма (0 — клычок, 1 — резец), размер, место (доля полуширины), ширина рта
varying vec2 vMp;
float mwl(float x, float hw) {
  // линия «ω»: две дуги вниз от середины к уголкам, уголки вверх при улыбке, вниз при обиде
  float a = clamp(abs(x) / hw, 0.0, 1.0);
  float sm = uMB.x, fr = uMB.z;
  float dip = 0.07 * (1.0 - 0.75 * fr) * (1.0 - 0.4 * uMC.x);
  float y = -dip * sin(3.14159 * a);
  y += (0.2 * sm - 0.13 * fr) * a * a;
  y += 0.045 * fr * (1.0 - a * a) * (1.0 - a * a); // мягкая «∩» (надулась, грусть)
  y += uMB.y * 0.22 * pow(max(0.0, -x / hw), 2.0);
  return y;
}
`;

const FRAG_BODY = `
  {
    vec2 p = vMp;
    float ax = abs(p.x);
    float aa = max(fwidth(p.y), fwidth(p.x)) * 1.2 + 1e-4;
    float D = uMA.x * 0.95, r = uMA.y, e = uMA.z, pr = uMA.w;
    float sm = uMB.x, fr = uMB.z, tg = uMB.w, gum = uMC.x;
    float hw = 0.5 * uME.w * (1.0 + 0.14 * sm + 0.12 * e - 0.38 * fr - 0.3 * gum);
    float wl = mwl(p.x, hw);
    // открытый рот
    float hwo = hw * (0.92 - 0.3 * r) * (1.0 - 0.15 * fr);
    float ao = ax / hwo;
    float q = max(1.0 - ao * ao, 0.0);
    float prof = pow(q, 0.45 + 0.35 * r);
    float Up = wl + r * D * 0.34 * sqrt(q) + 0.012 * step(0.0, D - 0.02);
    float Lo = wl - D * prof;
    float fo = min(min(Up - p.y, p.y - Lo), (hwo - ax) * 0.6);
    float cav = smoothstep(-aa, aa, fo) * smoothstep(0.012, 0.04, D);
    // язык: овал снизу полости; высунутый — поверх нижней губы
    float ty = mwl(0.0, hw) - D * (0.82 + uMD.y) + 0.04 - 0.1 * tg;
    float tr = hwo * 0.62 * mix(1.0, uMD.x, 1.0 - tg);
    float tyr = (max(0.05, D * 0.42) + 0.08 * tg) * mix(1.0, uMD.x, 1.0 - tg);
    float tE = length(vec2(p.x / tr, (p.y - ty) / tyr));
    float tongueIn = (1.0 - smoothstep(1.0 - aa / tyr, 1.0 + aa / tyr, tE)) * cav;
    float tongueOut = tg > 0.01 ? (1.0 - smoothstep(1.0 - aa / tyr, 1.0 + aa / tyr, tE)) * step(p.y, Lo + 0.02) * smoothstep(0.0, 0.3, tg) : 0.0;
    float tongue = max(tongueIn, tongueOut);
    // клычки сверху (или резцы — uME.x)
    float fang = 0.0;
    float fl = min(0.11, D * 0.5) * uME.y;
    for (int i = 0; i < 2; i++) {
      float fx = (i == 0 ? -1.0 : 1.0) * hwo * uME.z;
      float top = mwl(fx, hw) + r * D * 0.34 * sqrt(max(1.0 - pow(fx / hwo, 2.0), 0.0)) + 0.012;
      float tt = clamp((top - p.y) / max(fl, 1e-3), 0.0, 1.0);
      float half_ = mix(0.032 * (1.0 - tt), 0.034 * sqrt(max(1.0 - pow(tt, 4.0), 0.0)), uME.x) * uME.y;
      float inF = (1.0 - smoothstep(half_ - aa, half_ + aa, abs(p.x - fx))) * step(p.y, top) * step(top - fl, p.y);
      fang = max(fang, inF);
    }
    fang *= cav * smoothstep(0.05, 0.12, D) * (1.0 - r * 0.7);
    // кромка губ (тёмная), линия «ω» в покое, фильтрум
    float rim = cav * (1.0 - smoothstep(0.0, 0.022, fo));
    float th = (0.016 + 0.012 * pr) * (1.0 - 0.45 * pow(clamp(ax / hw, 0.0, 1.0), 4.0)) + aa * 0.3;
    float lineA = (1.0 - smoothstep(th - aa, th + aa, abs(p.y - wl))) * (1.0 - smoothstep(hw * 0.96, hw * 1.04, ax));
    float phY = uMC.y;
    float phil = (1.0 - smoothstep(0.008 - aa, 0.008 + aa, ax)) * step(0.0, p.y) * (1.0 - smoothstep(phY * 0.6, phY * 0.95, p.y)) * 0.55;
    // цвет полости: тёмная сверху (тень губы), теплее к языку
    float dep = clamp((Up - p.y) / max(D, 1e-3), 0.0, 1.0);
    vec3 cavC = mix(vec3(0.07, 0.012, 0.02), vec3(0.3, 0.06, 0.08), smoothstep(0.1, 0.9, dep));
    vec3 tonC = mix(vec3(0.85, 0.32, 0.38), vec3(0.95, 0.5, 0.55), smoothstep(-0.6, 0.6, (p.y - ty) / tyr));
    tonC *= uMD.z;
    tonC *= 1.0 - 0.08 * (1.0 - smoothstep(0.0, 0.012, ax)) * smoothstep(ty + tyr * 0.6, ty - tyr * 0.2, p.y);
    vec3 lineC = vec3(0.14, 0.06, 0.09);
    vec3 col = cavC;
    col = mix(col, tonC, tongue);
    col = mix(col, vec3(0.92, 0.9, 0.87), fang);
    col = mix(col, lineC, rim * 0.85 * (1.0 - fang));
    float alpha = max(max(cav, tongueOut), max(lineA * 0.92, phil));
    vec3 outC = mix(lineC, col, max(cav, tongueOut));
    if (alpha < 0.01) discard;
    diffuseColor = vec4(outC, alpha);
  }
`;

export class MouthRig {
  readonly uniforms = {
    uMA: { value: new THREE.Vector4() },
    uMB: { value: new THREE.Vector4() },
    uMC: { value: new THREE.Vector4() },
    uMD: { value: new THREE.Vector4(1, 0, 1, 0) },
    uME: { value: new THREE.Vector4(0, 1, 0.5, 1) },
    uMO: { value: new THREE.Vector3() },
    uMX: { value: new THREE.Vector3() },
    uMY: { value: new THREE.Vector3() },
    uMW: { value: 1 },
  };
  constructor(readonly mesh: THREE.Mesh, readonly ex: MouthExtras) {}

  /** модель со стадией «лицо» v3 → рот-накладка; null — старая модель */
  static find(model: THREE.Object3D): MouthRig | null {
    let mesh: THREE.Mesh | null = null;
    model.traverse((o) => {
      if (!mesh && (o as THREE.Mesh).isMesh && /^MouthD/.test(o.name)) mesh = o as THREE.Mesh;
    });
    if (!mesh) return null;
    const m = mesh as THREE.Mesh;
    let ex: MouthExtras | undefined;
    for (let o: THREE.Object3D | null = m; o && !ex; o = o.parent) ex = o.userData?.mouth as MouthExtras | undefined;
    if (!ex) return null;
    const rig = new MouthRig(m, ex);
    rig.uniforms.uMO.value.fromArray(ex.o);
    rig.uniforms.uMX.value.fromArray(ex.ex);
    rig.uniforms.uMY.value.fromArray(ex.ey);
    rig.uniforms.uMW.value = ex.W;
    rig.uniforms.uMC.value.y = ex.nose;
    if (ex.teeth?.length === 4) rig.uniforms.uME.value.fromArray(ex.teeth);
    rig.patch(m.material as THREE.MeshStandardMaterial);
    m.renderOrder = 2;
    return rig;
  }

  private patch(m: THREE.MeshStandardMaterial) {
    const U = this.uniforms;
    m.transparent = true;
    m.depthWrite = false;
    m.opacity = 1;
    m.polygonOffset = true;
    m.polygonOffsetFactor = -2;
    m.polygonOffsetUnits = -4;
    m.metalness = 0;
    m.roughness = 0.45;
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      sh.vertexShader =
        'uniform vec3 uMO; uniform vec3 uMX; uniform vec3 uMY; uniform float uMW;\nvarying vec2 vMp;\n' +
        sh.vertexShader.replace(
          '#include <morphtarget_vertex>',
          `#include <morphtarget_vertex>
  { vec3 dd = transformed - uMO; vMp = vec2(dot(dd, uMX) / dot(uMX, uMX), dot(dd, uMY) / dot(uMY, uMY)) / uMW;
    // чуть к камере (≈ 0.08 ширины рта): растянутые челюстью треугольники морды не протыкают накладку,
    // а настоящие заслоны (лапа у рта) — ближе и всё равно закрывают рот
    vec3 camL = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
    transformed += normalize(camL - transformed) * uMW * length(uMX) * 0.08; }`,
        );
      sh.fragmentShader = FRAG_HEAD + sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_BODY);
    };
    m.customProgramCacheKey = () => 'cat-mouth-v1';
    m.needsUpdate = true;
  }

  /**
   * язык по характеру (рантайм v2, Блёстка): size — размер овала (1 — как было), deeper — центр ниже на долю
   * раскрытия, tone — яркость. Без аргумента — как у всех (v1). Высунутый язык (tongue_out) — без изменений.
   */
  setTongue(t?: { size?: number; deeper?: number; tone?: number }) {
    t = this.ex.tongue ?? t;
    this.uniforms.uMD.value.set(t?.size ?? 1, t?.deeper ?? 0, t?.tone ?? 1, 0);
  }

  update(W: Record<string, number>) {
    const p = mouthParams(W, this.ex.jaw ?? {});
    this.uniforms.uMA.value.set(p.drop, p.round, p.wide, p.press);
    this.uniforms.uMB.value.set(p.smile, p.smirk, p.frown, p.tongue);
    this.uniforms.uMC.value.x = p.gum;
  }
}
