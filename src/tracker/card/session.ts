/**
 * Ядро трекера карты на главном потоке — без DOM (его же гоняет офлайн-стенд tests/card/bench.test.ts):
 *
 *   ответ воркера → поза карты на момент СЪЁМКИ кадра → в «мир гироскопа» (W = Q_съёмки · M) → фильтр в мире
 *   → на каждом кадре рендера: M_показ = Q_сейчасᵀ · W.
 *
 * Зачем так (Google «Instant Motion Tracking», MediaPipe; gyro-prediction в мобильном AR):
 *  - задержка воркера и камеры (60–100 мс) больше не видна: поворот телефона с момента съёмки досчитывает
 *    гироскоп — кот не «отлипает» от карты при движении телефона;
 *  - в мире карта неподвижна, поэтому фильтр может сглаживать сильно (нет дрожания в покое) и при этом не
 *    запаздывает на поворотах телефона (их несёт гироскоп, а не фильтр);
 *  - HOLD (карты не видно) — тот же путь без новых измерений: никаких «заморозок» и скачков на переходах.
 * Гироскоп сам себя проверяет: если его поворот не совпадает с видимым поворотом карты (не та ось, нет
 * разрешения, глючный датчик), компенсация выключается и фильтр работает в системе камеры, как раньше.
 *
 * Машина состояний (поиск → кандидат → посадка → удержание → поиск рядом → потеря) — ./fsm.ts.
 */
import * as THREE from 'three';
import { CARD_ASPECT, focalFromQuad, labelCard, poseFromQuad, quadDiag, type Intrinsics, type Pose, type Pt, type Quad } from './geometry';
import { CardFsm, type Kind, type TrackState } from './fsm';
import type { PipelineOut } from './pipeline';
import { OneEuroVec } from '../smoothing';
import { ACCEPT_OTHER_BANKS } from '../../config';

export interface Orientation {
  /** ориентация камеры в мире (как three DeviceOrientationControls) */
  q: THREE.Quaternion;
}

export interface SessionStep {
  /** события для приложения */
  found?: boolean;
  lost?: boolean;
  /** кандидат/карта в этом кадре (px кадра детектора, нумерация TL TR BR BL) и поза на момент съёмки */
  quad?: Quad | null;
  pose?: Pose | null;
  kind?: Kind;
  /** пересадка: воркер надо сбросить */
  reset?: boolean;
}

const S = new THREE.Matrix4().makeScale(1, -1, -1);
const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();

export class CardSession {
  readonly fsm: CardFsm;
  K: Intrinsics = { f: 300, cx: 160, cy: 90 };
  w = 320;
  h = 180;
  /** фильтр позы в мире */
  private wPos = new THREE.Vector3();
  private wQuat = new THREE.Quaternion();
  private hasW = false;
  private posF = new OneEuroVec(3, 0.6, 1.2);
  /** то, что показываем (догоняет фильтр за ~30 мс — без ступенек 15 Гц) */
  private shownPos = new THREE.Vector3();
  private shownQuat = new THREE.Quaternion();
  private shownOk = false;
  readonly anchor = new THREE.Matrix4();
  /** нумерация углов: держим ориентацию кота и после короткой потери */
  private prevQuad: Quad | null = null;
  private orientRef: Quad | null = null;
  private orientAt = -1e9;
  /** гироскоп: ориентация на момент съёмки прошлого кадра, его проверка */
  private lastCapQ: THREE.Quaternion | null = null;
  private lastMeasR: THREE.Quaternion | null = null;
  private lastMeasCapQ: THREE.Quaternion | null = null;
  gyroScore = 0;
  gyroSamples = 0;
  /** гироскоп признан годным для компенсации (по умолчанию — да, пока не доказано обратное) */
  get gyroOk() {
    return this.gyroSamples < 8 || this.gyroScore > -0.3;
  }
  /** самокалибровка фокуса */
  private fSamples: number[] = [];
  onFocal: ((f: number) => void) | null = null;
  /** скорость карты на экране (доли диагонали в секунду) и телефона (рад/с) */
  quadSpeed = 0;
  private lastQuadT = 0;
  /** причины переходов и прочее для ?debug */
  readonly log: string[] = [];

  constructor(readonly verify = true) {
    this.fsm = new CardFsm(verify);
  }

  get state(): TrackState {
    return this.fsm.state;
  }

  /** что послать воркеру с кадром, снятым при ориентации capQ */
  request(now: number, capQ: THREE.Quaternion | null): { lock: boolean; hint: Pt[] | null; hintRadius: number; rot: number[] | null; lostMs: number } {
    const f = this.fsm;
    let rot: number[] | null = null;
    if (capQ && this.lastCapQ && this.gyroOk) {
      // точки старой камеры → новой: X' = Q_новᵀ · Q_стар · X; в осях изображения (y вниз, z вперёд): S·R·S
      tmpQ.copy(capQ).invert().multiply(this.lastCapQ);
      const m = tmpM.makeRotationFromQuaternion(tmpQ).premultiply(S).multiply(S).elements;
      rot = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
    }
    this.lastCapQ = capQ ? capQ.clone() : null;
    const anchoredLost = f.anchored && f.state !== 'locked';
    return { lock: f.anchored, hint: anchoredLost ? this.hintQuad(capQ) : null, hintRadius: f.hintRadius(now), rot, lostMs: anchoredLost ? Math.max(0, now - f.seenAt) : 0 };
  }

  /** где карта сейчас по удерживаемой позе (в px кадра детектора) — подсказка воркеру */
  private hintQuad(q: THREE.Quaternion | null): Pt[] | null {
    if (!this.hasW) return null;
    const m = this.cameraPose(q, new THREE.Matrix4()).elements;
    const hw = 0.5, hh = 0.5 / CARD_ASPECT;
    const out: Pt[] = [];
    for (const [X, Y] of [[-hw, hh], [hw, hh], [hw, -hh], [-hw, -hh]]) {
      const x = m[0] * X + m[4] * Y + m[12], y = m[1] * X + m[5] * Y + m[13], z = m[2] * X + m[6] * Y + m[14];
      if (z > -1e-3) return null;
      out.push({ x: this.K.cx + (this.K.f * x) / -z, y: this.K.cy - (this.K.f * y) / -z });
    }
    return out;
  }

  /** поза карты в системе камеры при ориентации q (по фильтру в мире) */
  private cameraPose(q: THREE.Quaternion | null, out: THREE.Matrix4): THREE.Matrix4 {
    out.compose(this.wPos, this.wQuat, new THREE.Vector3(1, 1, 1));
    if (q && this.gyroOk) out.premultiply(tmpM.makeRotationFromQuaternion(tmpQ.copy(q).invert()));
    return out;
  }

  /** «Пересадить кота» */
  reanchor(now: number, why = 'пересадка') {
    this.fsm.reset(now, why);
    this.prevQuad = null;
    this.orientRef = null;
    this.hasW = false;
    this.shownOk = false;
  }

  private kindOf(st: string | undefined): Kind {
    if (!this.verify || st === 'sber') return 'sber';
    if (st === 'card') return ACCEPT_OTHER_BANKS ? 'sber' : 'other';
    if (st === 'back') return ACCEPT_OTHER_BANKS ? 'sber' : 'back';
    if (st === 'notcard') return 'notcard';
    return 'checking';
  }

  /**
   * Ответ воркера. capQ — ориентация телефона в момент съёмки кадра (null — гироскопа нет),
   * angSpeed — угловая скорость телефона, рад/с (NaN — неизвестно).
   */
  onResult(r: PipelineOut, capQ: THREE.Quaternion | null, now: number, angSpeed: number): SessionStep {
    const f = this.fsm;
    const before = f.state;
    const wasEver = f.everLocked;
    const step: SessionStep = {};
    const kind = this.kindOf(r.ver?.state);
    let pose: Pose | null = null;
    let quad: Quad | null = null;
    if (r.quad && r.score >= 0.5) {
      quad = labelCard(r.quad, this.K, this.prevQuad ?? (now - this.orientAt < 8000 ? this.orientRef : null));
      pose = poseFromQuad(quad, this.K, CARD_ASPECT);
      // фокус по уже ведомой карте — и когда поза отброшена: при фокусе «по умолчанию», далёком от настоящего,
      // ошибка наклонной карты всегда > 2 px, и самокалибровка (раньше — только при err < 2) не начиналась никогда
      if (pose && f.anchored && pose.err < 8 && r.mode !== 'plane') this.calibrate(quad);
      if (pose && (pose.err > 4 || pose.t[2] > -0.5)) {
        this.note(now, `поза отброшена: err ${pose.err.toFixed(1)} z ${pose.t[2].toFixed(2)}`);
        pose = null;
      }
    }
    let jitter = 1;
    if (pose && quad) {
      const diag = quadDiag(quad);
      if (this.prevQuad) {
        const mv = Math.max(...quad.map((p, i) => Math.hypot(p.x - this.prevQuad![i].x, p.y - this.prevQuad![i].y))) / diag;
        jitter = mv;
        const dt = Math.max(0.02, (now - this.lastQuadT) / 1000);
        this.quadSpeed = mv / dt > this.quadSpeed ? mv / dt : this.quadSpeed * 0.7 + (0.3 * mv) / dt;
      }
      this.lastQuadT = now;
      this.prevQuad = quad;
      this.orientRef = quad;
      this.orientAt = now;
    } else {
      this.quadSpeed *= 0.7;
      // карта пропала надолго — нумерацию забываем (через 8 с — orientRef)
      // (одиночный отброшенный кадр нумерацию и «дрожание» не сбрасывает: иначе при чередовании «поиск / ведение
      // с плохой позой» дрожание всегда = 1 и кот не садился — стресс-набор, тёмный стол)
      if (f.state !== 'locked' && now - this.lastQuadT > 500) this.prevQuad = null;
    }
    // размер карты — от короткой стороны кадра (в портрете карта ограничена шириной)
    const L = Math.min(this.w, this.h);
    const size = quad ? Math.max(...[0, 1, 2, 3].map((i) => Math.hypot(quad![i].x - quad![(i + 1) % 4].x, quad![i].y - quad![(i + 1) % 4].y))) / L : 0;
    const inFrame = quad ? quad.filter((p) => p.x >= -1 && p.y >= -1 && p.x <= this.w && p.y <= this.h).length / 4 : 0;
    // до посадки ведение по поверхности тоже считается: детектор пускает его только после кадра с краями карты,
    // а «карта Сбера» проверяется только на кадрах полного поиска
    const found = !!pose;
    f.observe({
      t: now,
      found,
      mode: r.mode,
      err: pose?.err,
      jitter,
      size,
      inFrame,
      glare: r.glare,
      still: !(angSpeed > 0.6),
      kind,
      postNotCard: !!r.ver?.postNotCard,
      maybeSber: r.ver ? r.ver.maybeSber : undefined,
    });
    if (f.state === 'search' && before !== 'search' && f.log.at(-1)?.why.startsWith('переверификация')) {
      step.reset = true;
      this.reanchor(now, 'переверификация');
    }
    // поза в мир и фильтр
    if (found && pose && f.anchored) {
      // новая посадка — с нуля; карту нашли заново после долгой потери (RELOCALIZE: телефон сдвинули, карта в другом
      // месте кадра) — тоже сразу на карту, без «подлёта» фильтром через весь экран
      if (f.state === 'locked' && before !== 'locked' && (before === 'candidate' || before === 'relocalize' || !this.hasW)) this.hasW = false;
      this.measure(pose, capQ, now);
    }
    if (f.state === 'locked' && (before === 'candidate' || before === 'search' || before === 'lost')) {
      step.found = true;
      this.note(now, `посадка: ${f.log.at(-1)?.why ?? ''}`);
    }
    if (f.state === 'lost' && before !== 'lost' && wasEver) step.lost = true;
    if (before !== f.state) this.note(now, `${before} → ${f.state}: ${f.log.at(-1)?.why ?? ''}`);
    step.quad = quad;
    step.pose = pose;
    step.kind = kind;
    return step;
  }

  /** время без ответов воркера (переходы HOLD/RELOCALIZE/LOST идут и так) */
  tick(now: number): SessionStep {
    const before = this.fsm.state;
    this.fsm.tick(now);
    const step: SessionStep = {};
    if (this.fsm.state !== before) {
      this.note(now, `${before} → ${this.fsm.state}: ${this.fsm.log.at(-1)?.why ?? ''}`);
      if (this.fsm.state === 'lost') step.lost = true;
    }
    return step;
  }

  private measure(pose: Pose, capQ: THREE.Quaternion | null, now: number) {
    const R = pose.R, t = pose.t;
    const M = new THREE.Matrix4().set(R[0], R[1], R[2], t[0], R[3], R[4], R[5], t[1], R[6], R[7], R[8], t[2], 0, 0, 0, 1);
    const mq = new THREE.Quaternion().setFromRotationMatrix(M);
    // проверка гироскопа: видимый поворот карты между кадрами против предсказанного гироскопом
    if (capQ && this.lastMeasR && this.lastMeasCapQ) {
      const still = this.lastMeasR.angleTo(mq);
      if (still > 0.02) {
        const rel = capQ.clone().invert().multiply(this.lastMeasCapQ);
        const pred = rel.multiply(this.lastMeasR);
        const g = pred.angleTo(mq);
        this.gyroScore = this.gyroScore * 0.85 + (g < 0.6 * still ? 0.15 : -0.15);
        this.gyroSamples++;
        if (this.gyroSamples === 8 || (this.gyroSamples > 8 && this.gyroSamples % 50 === 0)) this.note(now, `гироскоп: ${this.gyroOk ? 'совпадает' : 'НЕ совпадает — компенсация выключена'} (${this.gyroScore.toFixed(2)})`);
      }
    }
    this.lastMeasR = mq;
    this.lastMeasCapQ = capQ ? capQ.clone() : null;
    // в мир гироскопа
    if (capQ && this.gyroOk) M.premultiply(tmpM.makeRotationFromQuaternion(capQ));
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    M.decompose(p, q, s);
    const ts = now / 1000;
    if (!this.hasW) {
      this.posF.reset();
      this.posF.filter([p.x, p.y, p.z], ts);
      this.wPos.copy(p);
      this.wQuat.copy(q);
      this.hasW = true;
      this.shownOk = false;
      return;
    }
    const fp = this.posF.filter([p.x, p.y, p.z], ts);
    this.wPos.set(fp[0], fp[1], fp[2]);
    // поворот: в мире карта неподвижна — сглаживаем сильно; большой поворот (сменилась нумерация, пересадка) — быстро
    const ang = this.wQuat.angleTo(q);
    const k = ang > 0.35 ? 1 : 0.25 + 0.75 * Math.min(1, ang / 0.12);
    this.wQuat.slerp(q, k);
  }

  /** кадр рендера: поза якоря в системе камеры на «сейчас» (null — кота нет) */
  frame(dt: number, qNow: THREE.Quaternion | null): THREE.Matrix4 | null {
    if (!this.fsm.anchored || !this.hasW) {
      this.shownOk = false;
      return null;
    }
    // сглаживаем ступеньки между ответами воркера В МИРЕ (догоняем фильтр за ~25 мс): поворот телефона
    // накладывается после — он без задержки
    if (!this.shownOk) {
      this.shownPos.copy(this.wPos);
      this.shownQuat.copy(this.wQuat);
      this.shownOk = true;
    } else {
      const a = 1 - Math.exp(-dt / 0.025);
      this.shownPos.lerp(this.wPos, a);
      this.shownQuat.slerp(this.wQuat, a);
    }
    this.anchor.compose(this.shownPos, this.shownQuat, new THREE.Vector3(1, 1, 1));
    if (qNow && this.gyroOk) this.anchor.premultiply(tmpM.makeRotationFromQuaternion(tmpQ.copy(qNow).invert()));
    return this.anchor;
  }

  /** самокалибровка фокуса по карте: медиана оценок с наклонённых устойчивых кадров */
  private calibrate(quad: Quad) {
    if (this.fSamples.length >= 60) return;
    const f = focalFromQuad(quad, this.K.cx, this.K.cy, CARD_ASPECT);
    if (!f) return;
    const L = Math.max(this.w, this.h);
    const fMin = L / 2 / Math.tan((85 * Math.PI) / 360), fMax = L / 2 / Math.tan((45 * Math.PI) / 360);
    if (f < fMin || f > fMax) return;
    this.fSamples.push(f);
    if (this.fSamples.length % 10 !== 0) return;
    const sorted = [...this.fSamples].sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    if (Math.abs(med - this.K.f) / this.K.f < 0.02) return;
    this.K = { ...this.K, f: med };
    this.onFocal?.(med);
  }

  resetFocalSamples() {
    this.fSamples = [];
  }

  private note(now: number, s: string) {
    this.log.push(`${(now / 1000).toFixed(1)}с ${s}`);
    if (this.log.length > 40) this.log.shift();
  }
}

/** история ориентации телефона: ориентация на момент съёмки кадра (кадр камеры старше момента, когда мы его берём) */
export class OrientationHistory {
  private buf: { t: number; q: THREE.Quaternion }[] = [];
  push(t: number, q: THREE.Quaternion) {
    const last = this.buf[this.buf.length - 1];
    if (last && t <= last.t) return;
    this.buf.push({ t, q: q.clone() });
    if (this.buf.length > 90) this.buf.shift();
  }
  /** ориентация в момент t (линейно между отсчётами); null — нет данных */
  at(t: number): THREE.Quaternion | null {
    const b = this.buf;
    if (!b.length) return null;
    if (t >= b[b.length - 1].t) return b[b.length - 1].q.clone();
    for (let i = b.length - 1; i > 0; i--) {
      if (b[i - 1].t <= t) {
        const k = (t - b[i - 1].t) / Math.max(1e-6, b[i].t - b[i - 1].t);
        return b[i - 1].q.clone().slerp(b[i].q, k);
      }
    }
    return b[0].q.clone();
  }
}
