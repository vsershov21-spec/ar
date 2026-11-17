/**
 * Тон меха (рантайм, без пересборки текстур): альбедо Tripo у всех трёх котов тёмное и насыщенно-синее
 * (медиана sRGB ≈ 107,120,165), а на референсах мех светлый серо-лавандовый (≈ 172,177,204), морда и подбородок ещё светлее.
 * В шейдере каждого «меховых» материала (тело, мех-оболочки, карточки щёк, веки, брови) цвет после карты и цвета
 * вершин переводится в sRGB, пиксели меха (по оттенку: синее красного, зелёный ≈ красный, не тёмные) сдвигаются к
 * целевому тону с ослабленным контрастом (рисунок шерсти остаётся), чуть обесцвечиваются. Одежда, золото, нос, уши,
 * глаза под маску не попадают (другой оттенок). Стоимость — несколько ALU на пиксель, без текстур и проходов.
 */
import * as THREE from 'three';

export interface FurToneParams {
  /** средний цвет меха в альбедо (sRGB 0..1) */
  src: [number, number, number];
  /** целевой средний цвет (sRGB 0..1) */
  dst: [number, number, number];
  /** сохранение контраста шерсти (0 — плоский цвет, 1 — как в текстуре) */
  contrast: number;
  /** обесцвечивание 0..1 */
  desat: number;
}

const S = (r: number, g: number, b: number): [number, number, number] => [r / 255, g / 255, b / 255];

/** по референсам design/sheets/*_turnaround.jpg (мех на лбу и спине) */
export const FUR_TONE: Record<string, FurToneParams> = {
  glitter: { src: S(110, 122, 166), dst: S(158, 162, 194), contrast: 0.62, desat: 0.2 },
  hooligan: { src: S(118, 131, 174), dst: S(152, 159, 188), contrast: 0.62, desat: 0.25 },
  kind: { src: S(120, 132, 172), dst: S(156, 161, 192), contrast: 0.62, desat: 0.22 },
};

export class FurTone {
  readonly uniforms = {
    uFtSrc: { value: new THREE.Vector3(...FUR_TONE.kind.src) },
    uFtDst: { value: new THREE.Vector3(...FUR_TONE.kind.dst) },
    uFtK: { value: new THREE.Vector2(FUR_TONE.kind.contrast, FUR_TONE.kind.desat) },
    uFtOn: { value: 1 },
  };
  private done = new WeakSet<THREE.Material>();

  setPersona(id: string) {
    const p = FUR_TONE[id] ?? FUR_TONE.kind;
    this.uniforms.uFtSrc.value.set(...p.src);
    this.uniforms.uFtDst.value.set(...p.dst);
    this.uniforms.uFtK.value.set(p.contrast, p.desat);
  }

  /** все меховые материалы модели (после buildFurShells — оболочки тоже) */
  attach(model: THREE.Object3D) {
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !FurTone.isFur(m.name)) return;
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) this.patch(mat as THREE.MeshStandardMaterial);
    });
  }

  /** чьи материалы тонировать: тело и всё «меховое»; не глаза, рот, нос-накладки, румянец, усы, подушечки */
  static isFur(name: string) {
    return !/^(EyeBall|Mouth|Blush|Whiskers|BD_Pads|BD_Metal|BD_Cloth|Emblem|Tear)/.test(name);
  }

  patch(m: THREE.MeshStandardMaterial) {
    if (!m || this.done.has(m) || !(m as THREE.MeshStandardMaterial).isMeshStandardMaterial) return;
    this.done.add(m);
    const U = this.uniforms;
    const prev = m.onBeforeCompile;
    m.onBeforeCompile = (sh, r) => {
      prev?.call(m, sh, r);
      Object.assign(sh.uniforms, U);
      sh.fragmentShader =
        'uniform vec3 uFtSrc; uniform vec3 uFtDst; uniform vec2 uFtK; uniform float uFtOn;\n' +
        sh.fragmentShader.replace(
          '#include <color_fragment>',
          `#include <color_fragment>
  if (uFtOn > 0.5) {
    vec3 ftS = pow(max(diffuseColor.rgb, vec3(0.0)), vec3(1.0 / 2.2));
    float ftL = dot(ftS, vec3(0.299, 0.587, 0.114));
    // мех: синее красного, зелёный близко к красному, не тёмная линия
    float ftM = smoothstep(0.045, 0.12, ftS.b - ftS.r) * exp(-pow((ftS.g - ftS.r - 0.05) / 0.075, 2.0)) * smoothstep(0.16, 0.3, ftL);
    vec3 ftC = uFtDst + (ftS - uFtSrc) * uFtK.x;
    ftC = mix(ftC, vec3(dot(ftC, vec3(0.299, 0.587, 0.114))), uFtK.y);
    // нос и внутренность ушей: тёмно-лиловые у Tripo → светло-розовые, как на референсе
    float ftN = smoothstep(0.08, 0.18, ftS.r - ftS.g) * smoothstep(0.0, 0.06, ftS.r - ftS.b) * smoothstep(-0.02, 0.04, ftS.b - ftS.g) * (1.0 - ftM);
    vec3 ftP = vec3(0.93, 0.6, 0.66) + (ftS - vec3(0.6, 0.38, 0.45)) * 0.5;
    ftC = mix(ftC, ftP, ftN);
    diffuseColor.rgb = mix(diffuseColor.rgb, pow(clamp(ftC, 0.0, 1.0), vec3(2.2)), max(ftM, ftN * 0.85));
  }`,
        );
    };
    const prevKey = m.customProgramCacheKey?.bind(m);
    m.customProgramCacheKey = () => (prevKey ? prevKey() : '') + '|fur-tone-v1';
    m.needsUpdate = true;
  }
}
