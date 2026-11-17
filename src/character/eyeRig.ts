/**
 * Настоящие 3D-глаза кота (модель — scripts/models/face_detail.py):
 *   Eye_L/Eye_R (дочерние к кости Head, +Z — вперёд) → EyeS_* (масштаб эллипсоида A, B, C) → EyeBall_*, LidUp_*, LidLo_*.
 * Яблоко вращается к цели взгляда (камера, палец) с микросаккадами и редкими взглядами в сторону; веки — поворот
 * оболочек вокруг оси X (моргание, прищур, смех «дугой», сонный взгляд) и вокруг оси Z (злость — внутренний уголок
 * вниз, грусть — вверх). Размер зрачка, спирали «головокружения» и два блика — в шейдере яблока (блики считаются
 * в пространстве камеры, поэтому всегда сверху-слева и «живые» при повороте глаза).
 * Без аллокаций в кадре; случайность — через rnd (тесты).
 */
import * as THREE from 'three';

export interface EyeExtras {
  side: 'L' | 'R';
  A: number;
  B: number;
  C: number;
  /** угол (рад) полного закрытия верхнего / нижнего века */
  closeUp: number;
  closeLo: number;
  /** радиусы радужки в uv (0.5 = вся сфера) */
  irisUV: [number, number];
  /** радиус зрачка в долях радужки (как нарисован) */
  pupil: number;
  /** верхнее веко в покое (доля закрытия) */
  restUp?: number;
}

export interface LidPose {
  /** закрытие верхнего века: 0 — покой, 1 — до встречи с нижним, < 0 — шире (удивление) */
  up: number;
  /** подъём нижнего века 0..1 */
  lo: number;
  /** наклон: > 0 — внутренний уголок вниз (злость), < 0 — вверх (грусть) */
  tilt: number;
  /** «дуга» 0..1 (смех, подмигивание): глаз закрывает нижнее веко, видна линия верхнего — «^», как на референсе */
  arc: number;
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** веса лица → положение век одного глаза (чистая функция) */
export function lidPose(w: Record<string, number>, side: 'L' | 'R', rest = 0.05): LidPose {
  const g = (k: string) => w[k] ?? 0;
  const blink = Math.max(g(`blink_${side}`), g(`wink_${side}`));
  const laugh = g('eyes_laugh');
  const squint = g('eyes_squint');
  const smug = g('eyes_smug');
  const sleepy = g('eyes_sleepy');
  const wide = g('eyes_wide');
  const sad = g('brow_sad');
  const angry = g('brow_down');
  let up = rest * (1 - wide) + 0.22 * squint + 0.34 * smug + 0.55 * sleepy + 0.12 * sad + 0.2 * angry - 0.5 * wide;
  let lo = 0.42 * squint + 0.42 * smug + 0.18 * g('smile') + 0.25 * g('cheek_up') + 0.12 * sleepy;
  const shut = Math.max(blink, laugh);
  up += (1 - up) * shut;
  lo += (1 - lo) * Math.max(blink, laugh * 0.85);
  const arc = clamp(Math.max(laugh, g(`wink_${side}`)), 0, 1);
  return { up: clamp(up, -0.5, 1), lo: clamp(lo, 0, 1), tilt: clamp(0.3 * angry - 0.42 * sad, -0.45, 0.45), arc };
}

interface Eye {
  side: 'L' | 'R';
  pivot: THREE.Object3D;
  ball: THREE.Object3D;
  up: THREE.Object3D;
  lo: THREE.Object3D;
  ex: EyeExtras;
  /** слёзка (грусть), может отсутствовать */
  tear: THREE.Object3D | null;
  yaw: number;
  pitch: number;
}

export interface EyeInput {
  /** итоговые веса лица (пресет + эмоция + живость + моргание) */
  weights: Record<string, number>;
  /** зрачки 0.6 … 1.4 */
  pupils: number;
  /** куда смотреть (мир); null — прямо */
  target: THREE.Vector3 | null;
  /** кот в покое (можно смотреть в сторону) */
  idle: boolean;
  /** сдвиг взгляда от пресета (рад): x > 0 — влево для кота, y > 0 — вверх (смущение — в сторону и вниз) */
  bias?: [number, number] | null;
}

export class EyeRig {
  readonly eyes: Eye[] = [];
  readonly uniforms = {
    uPupil: { value: 1 },
    uSpiral: { value: 0 },
    uTime: { value: 0 },
    uIris: { value: new THREE.Vector2(0.2, 0.2) },
    uPr0: { value: 0.5 },
    uHi: { value: 1 },
  };
  private t = 0;
  private sacT = 0.6;
  private sac = { x: 0, y: 0 };
  private awayT = 6;
  private awayLeft = 0;
  private away = { x: 0, y: 0 };
  private glanceLeft = 0;
  private glance = { x: 0, y: 0 };
  private pupil = 1;
  private tearS = 0;
  private biasS = { x: 0, y: 0 };
  private v = new THREE.Vector3();
  private qa = new THREE.Quaternion();
  private qb = new THREE.Quaternion();
  private e = new THREE.Euler(0, 0, 0, 'YXZ');
  private static AX = new THREE.Vector3(1, 0, 0);
  private static AZ = new THREE.Vector3(0, 0, 1);

  constructor(private rnd: () => number = Math.random) {}

  /** найти глаза в модели; null — модель без 3D-глаз (старая) */
  static find(root: THREE.Object3D, rnd?: () => number): EyeRig | null {
    const rig = new EyeRig(rnd);
    for (const side of ['L', 'R'] as const) {
      const pivot = root.getObjectByName(`Eye_${side}`);
      const ball = root.getObjectByName(`EyeBall_${side}`);
      const up = root.getObjectByName(`LidUp_${side}`);
      const lo = root.getObjectByName(`LidLo_${side}`);
      if (!pivot || !ball || !up || !lo) return null;
      const ex = pivot.userData as EyeExtras;
      const tear = root.getObjectByName(`Tear_${side}`) ?? null;
      if (tear) tear.visible = false;
      rig.eyes.push({ side, pivot, ball, up, lo, ex: { ...ex, side }, tear, yaw: 0, pitch: 0 });
    }
    const ex = rig.eyes[0].ex;
    rig.uniforms.uIris.value.set(ex.irisUV?.[0] ?? 0.2, ex.irisUV?.[1] ?? 0.2);
    rig.uniforms.uPr0.value = ex.pupil ?? 0.5;
    const done = new Set<THREE.Material>();
    for (const e of rig.eyes) {
      e.ball.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (m && !done.has(m)) {
          done.add(m);
          rig.patch(m);
        }
      });
    }
    return rig;
  }

  /** шейдер яблока: зрачок шире/уже, спирали, блики в пространстве камеры */
  private patch(m: THREE.MeshStandardMaterial) {
    const U = this.uniforms;
    m.roughness = 0.12;
    m.metalness = 0;
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      sh.fragmentShader =
        'uniform float uPupil;\nuniform float uSpiral;\nuniform float uTime;\nuniform vec2 uIris;\nuniform float uPr0;\nuniform float uHi;\n' +
        sh.fragmentShader
          .replace(
            '#include <map_fragment>',
            `#ifdef USE_MAP
  vec2 eyD = (vMapUv - 0.5) / uIris;
  float eyR = length(eyD);
  float eyPr = uPr0 * uPupil;
  float eyRR = eyR < eyPr ? eyR * uPr0 / eyPr : (eyR < 1.0 ? uPr0 + (eyR - eyPr) * (1.0 - uPr0) / (1.0 - eyPr) : eyR);
  vec2 eyUv = 0.5 + eyD * (eyR > 1e-5 ? eyRR / eyR : 1.0) * uIris;
  vec4 sampledDiffuseColor = texture2D(map, eyUv);
  diffuseColor *= sampledDiffuseColor;
  if (uSpiral > 0.001) {
    float eyA = atan(eyD.y, eyD.x);
    float sp = sin(eyR * 16.0 + eyA - uTime * 7.0);
    vec3 spc = mix(vec3(0.95), vec3(0.05), smoothstep(-0.3, 0.3, sp));
    diffuseColor.rgb = mix(diffuseColor.rgb, spc, uSpiral * (1.0 - smoothstep(1.0, 1.25, eyR)));
  }
#endif`,
          )
          .replace(
            '#include <emissivemap_fragment>',
            `#include <emissivemap_fragment>
  {
    vec3 eyH1 = normalize(vec3(-0.42, 0.5, 0.76));
    vec3 eyH2 = normalize(vec3(0.32, -0.3, 0.9));
    float eyS1 = smoothstep(0.968, 0.978, dot(normal, eyH1));
    float eyS2 = smoothstep(0.9925, 0.9965, dot(normal, eyH2));
    totalEmissiveRadiance += vec3(1.0) * (eyS1 * 1.2 + eyS2 * 0.9) * uHi * (1.0 - 0.6 * uSpiral);
  }`,
          );
    };
    m.customProgramCacheKey = () => 'cat-eyeball-v1';
    m.needsUpdate = true;
  }

  /** короткий взгляд в сторону точки (доли роста кота на экране: dx > 0 — правее, dy > 0 — ниже) */
  glanceAt(dx: number, dy: number, s = 1.3) {
    this.glance.x = clamp(-dx * 0.9, -0.45, 0.45); // правее на экране = левее для кота (он смотрит на зрителя)
    this.glance.y = clamp(-dy * 0.7, -0.3, 0.3);
    this.glanceLeft = s;
  }

  update(dt: number, i: EyeInput) {
    this.t += dt;
    const U = this.uniforms;
    U.uTime.value = this.t;
    const spiral = clamp(i.weights.eyes_spiral ?? 0, 0, 1);
    U.uSpiral.value = spiral;
    this.pupil += (clamp(i.pupils, 0.55, 1.5) - this.pupil) * (1 - Math.exp(-dt / 0.12));
    U.uPupil.value = this.pupil;
    const closed = Math.max(i.weights.eyes_laugh ?? 0, Math.min(i.weights.blink_L ?? 0, i.weights.blink_R ?? 0));
    // микросаккады: каждые 0.4–2 с маленький скачок
    if ((this.sacT -= dt) <= 0) {
      this.sacT = 0.4 + this.rnd() * 1.6;
      this.sac.x = (this.rnd() - 0.5) * 0.09;
      this.sac.y = (this.rnd() - 0.5) * 0.06;
    }
    // иногда в покое — взгляд в сторону
    if (this.awayLeft > 0) this.awayLeft -= dt;
    else if (i.idle && (this.awayT -= dt) <= 0) {
      this.awayT = 5 + this.rnd() * 7;
      this.awayLeft = 0.7 + this.rnd() * 1.0;
      this.away.x = (this.rnd() < 0.5 ? -1 : 1) * (0.22 + this.rnd() * 0.18);
      this.away.y = (this.rnd() - 0.6) * 0.18;
    }
    if (this.glanceLeft > 0) this.glanceLeft -= dt;
    const bx = i.bias?.[0] ?? 0, by = i.bias?.[1] ?? 0;
    this.biasS.x += (bx - this.biasS.x) * (1 - Math.exp(-dt / 0.15));
    this.biasS.y += (by - this.biasS.y) * (1 - Math.exp(-dt / 0.15));
    let ox = this.sac.x + this.biasS.x, oy = this.sac.y + this.biasS.y;
    if (this.glanceLeft > 0) {
      ox += this.glance.x;
      oy += this.glance.y;
    } else if (this.awayLeft > 0) {
      ox += this.away.x;
      oy += this.away.y;
    }
    // слёзка: набухает за ~0.4 с, чуть стекает вниз и покачивается
    const tw = clamp(i.weights.tear ?? 0, 0, 1);
    this.tearS += (tw - this.tearS) * (1 - Math.exp(-dt / 0.25));
    for (const e of this.eyes) {
      const ex = e.ex;
      if (e.tear) {
        const k = this.tearS;
        e.tear.visible = k > 0.03;
        if (e.tear.userData.y0 === undefined) e.tear.userData.y0 = e.tear.position.y;
        e.tear.scale.setScalar(Math.max(0.001, k * (1 + 0.04 * Math.sin(this.t * 3))));
        e.tear.position.y = e.tear.userData.y0 - ex.B * 0.12 * k;
      }
      // цель в пространстве глаза → направление в «единичном» пространстве эллипсоида
      let yaw = 0, pitch = 0;
      if (i.target && spiral < 0.5) {
        e.pivot.updateWorldMatrix(true, false);
        const p = e.pivot.worldToLocal(this.v.copy(i.target));
        const x = p.x / ex.A, y = p.y / ex.B, z = Math.max(1e-3, p.z / ex.C);
        yaw = Math.atan2(x, z);
        pitch = Math.atan2(y, Math.hypot(x, z));
      }
      yaw = clamp(yaw + ox, -0.65, 0.65);
      pitch = clamp(pitch + oy, -0.35, 0.75); // сверху (кот на столе) смотрим выше
      if (spiral > 0.5) {
        yaw = 0.06 * Math.sin(this.t * 5 + (e.side === 'L' ? 0 : 2));
        pitch = 0.05 * Math.cos(this.t * 5);
      }
      // скачок глаза быстрый (саккада ~40 мс)
      const k = 1 - Math.exp(-dt / 0.04);
      e.yaw += (yaw - e.yaw) * k;
      e.pitch += (pitch - e.pitch) * k;
      this.e.set(-e.pitch, e.yaw, 0, 'YXZ');
      e.ball.quaternion.setFromEuler(this.e);
      // веки: закрытие + слежение за взглядом по вертикали + наклон
      const lp = lidPose(i.weights, e.side, ex.restUp ?? 0.05);
      const follow = 1 - closed;
      let upA = lp.up * ex.closeUp - e.pitch * (e.pitch > 0 ? 1.0 : 0.55) * follow;
      let loA = lp.lo * ex.closeLo + e.pitch * 0.3 * follow;
      if (lp.arc > 0) {
        // «^»: верхнее веко опускается на 40 %, нижнее поднимается до него — линия смыкания выгнута вверх
        const k = lp.arc * lp.arc * (3 - 2 * lp.arc);
        upA += (0.4 * ex.closeUp - upA) * k;
        loA += (ex.closeUp * 0.6 + ex.closeLo + 0.4 - loA) * k; // с запасом: нижнее веко уходит под верхнее (оно снаружи)
      }
      const sgn = e.side === 'L' ? 1 : -1;
      e.up.quaternion.setFromAxisAngle(EyeRig.AZ, lp.tilt * sgn).multiply(this.qa.setFromAxisAngle(EyeRig.AX, upA));
      e.lo.quaternion.setFromAxisAngle(EyeRig.AZ, lp.tilt * sgn * 0.35).multiply(this.qb.setFromAxisAngle(EyeRig.AX, -loA));
    }
  }
}
