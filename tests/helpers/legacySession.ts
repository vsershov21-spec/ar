/**
 * СТАРАЯ логика главного потока трекера карты (до переработки, коммит 2286279) — без DOM, для стенда «до/после»
 * (tests/card/bench.test.ts). Повторяет CardTracker.onResult + TrackerBase.update того времени:
 * посадка LOCK_FRAMES подряд «стабильных» кадров (сброс −2 на плохом), «проверяем» ≤ 2,5 с, потеря после 8 промахов,
 * удержание по гироскопу (замороженная матрица × поворот), OneEuro по позиции и slerp поворота в системе камеры,
 * переверификация «под котом не карта» → пересадка. Без компенсации задержки воркера.
 */
import * as THREE from 'three';
import { CARD_ASPECT, labelCard, poseFromQuad, quadDiag, type Intrinsics, type Pose, type Quad } from '../../src/tracker/card/geometry';
import type { PipelineOut } from '../../src/tracker/card/pipeline';
import { OneEuroVec, rotationAlpha } from '../../src/tracker/smoothing';
import type { BenchSession, SessionRequest } from './cardBench';

const LOCK_FRAMES = 10;
const CHECK_PATIENCE_MS = 2500;

export class LegacySession implements BenchSession {
  readonly name = 'до';
  state = 'search';
  tracking = false;
  events: { t: number; ev: string }[] = [];
  private locked = false;
  private stable = 0;
  private checkingSince = 0;
  private misses = 0;
  private prevQuad: Quad | null = null;
  private orientRef: Quad | null = null;
  private orientAt = -1e9;
  private verState = 'unknown';
  private holding = false;
  private target: THREE.Matrix4 | null = null;
  private anchor = new THREE.Matrix4();
  private hasPose = false;
  private pos = new OneEuroVec(3, 1.2, 0.015);
  private cp = new THREE.Vector3();
  private cq = new THREE.Quaternion();
  private cs = new THREE.Vector3(1, 1, 1);
  private frozen = new THREE.Matrix4();
  private qLoss: THREE.Quaternion | null = null;
  private resetNext = false;
  private K: Intrinsics = { f: 300, cx: 160, cy: 120 };

  constructor(private verify: boolean) {}

  request(): SessionRequest {
    const r: SessionRequest = { lock: this.locked, hint: this.locked && !this.tracking ? this.heldQuad() : null, legacy: true };
    if (this.resetNext) {
      r.reset = true;
      this.resetNext = false;
    }
    return r;
  }

  private heldQuad() {
    const m = this.anchor.elements;
    const hw = 0.5, hh = 0.5 / CARD_ASPECT;
    const out: { x: number; y: number }[] = [];
    for (const [X, Y] of [[-hw, hh], [hw, hh], [hw, -hh], [-hw, -hh]]) {
      const x = m[0] * X + m[4] * Y + m[12], y = m[1] * X + m[5] * Y + m[13], z = m[2] * X + m[6] * Y + m[14];
      if (z > -1e-3) return null;
      out.push({ x: this.K.cx + (this.K.f * x) / -z, y: this.K.cy - (this.K.f * y) / -z });
    }
    return out;
  }

  onResult(r: PipelineOut, _cap: { t: number; q: THREE.Quaternion | null }, K: Intrinsics, ctx: { angSpeed: number; now: number; q: THREE.Quaternion | null }) {
    this.K = K;
    const now = ctx.now;
    if (r.ver) {
      this.verState = r.ver.state;
      if (r.ver.postNotCard && this.locked) {
        this.events.push({ t: now, ev: 'reanchor' });
        this.locked = false;
        this.stable = 0;
        this.prevQuad = null;
        this.orientRef = null;
        if (this.tracking) this.setFound(false, ctx.q);
        this.resetNext = true;
        return;
      }
    } else if (!this.verify) this.verState = 'sber';
    let pose: Pose | null = null;
    let quad: Quad | null = null;
    if (r.quad && r.score >= 0.5) {
      quad = labelCard(r.quad, K, this.prevQuad ?? (now - this.orientAt < 8000 ? this.orientRef : null));
      pose = poseFromQuad(quad, K, CARD_ASPECT);
      if (pose && (pose.err > 4 || pose.t[2] > -0.5)) pose = null;
    }
    if (pose && quad) {
      const jitter = this.prevQuad ? Math.max(...quad.map((p, i) => Math.hypot(p.x - this.prevQuad![i].x, p.y - this.prevQuad![i].y))) / quadDiag(quad) : 1;
      this.prevQuad = quad;
      this.orientRef = quad;
      this.orientAt = now;
      this.misses = 0;
      if (!this.locked) {
        const still = !(ctx.angSpeed > 0.6);
        this.stable = pose.err < 2.5 && jitter < 0.04 && still ? this.stable + 1 : Math.max(0, this.stable - 2);
        const kind = this.kind();
        if (kind === 'checking' && this.stable >= LOCK_FRAMES) this.checkingSince ||= now;
        else if (kind !== 'checking' || this.stable < LOCK_FRAMES / 2) this.checkingSince = 0;
        const patient = kind === 'checking' && this.checkingSince > 0 && now - this.checkingSince > CHECK_PATIENCE_MS;
        const ok = kind === 'sber' || patient;
        this.state = 'candidate';
        if (this.stable < LOCK_FRAMES || !ok) return;
        this.locked = true;
        this.checkingSince = 0;
        this.events.push({ t: now, ev: 'lock' });
      }
      const R = pose.R, t = pose.t;
      this.target = new THREE.Matrix4().set(R[0], R[1], R[2], t[0], R[3], R[4], R[5], t[1], R[6], R[7], R[8], t[2], 0, 0, 0, 1);
      this.setFound(true, ctx.q);
      this.state = 'locked';
    } else {
      this.stable = 0;
      this.checkingSince = 0;
      this.misses++;
      if (this.misses >= 8) {
        this.prevQuad = null;
        if (this.tracking) this.setFound(false, ctx.q);
      }
      if (!this.locked) this.state = 'search';
    }
  }

  private setFound(v: boolean, q: THREE.Quaternion | null) {
    if (v === this.tracking) return;
    this.tracking = v;
    if (!v) {
      this.frozen.copy(this.anchor);
      this.qLoss = q ? q.clone() : null;
      this.holding = true;
      this.state = 'hold';
      this.events.push({ t: -1, ev: 'hold' });
    } else {
      const was = this.holding;
      this.holding = false;
      this.pos.reset();
      if (!was) this.hasPose = false;
    }
  }

  frame(t: number, dt: number, qNow: THREE.Quaternion | null) {
    if (this.holding) {
      this.anchor.copy(this.frozen);
      if (this.qLoss && qNow) this.anchor.premultiply(new THREE.Matrix4().makeRotationFromQuaternion(qNow.clone().invert().multiply(this.qLoss)));
      return;
    }
    if (!this.target || !this.tracking) return;
    const tp = new THREE.Vector3(), tq = new THREE.Quaternion(), ts = new THREE.Vector3();
    this.target.decompose(tp, tq, ts);
    if (!this.hasPose) {
      this.cp.copy(tp);
      this.cq.copy(tq);
      this.cs.copy(ts);
      this.hasPose = true;
    } else {
      const p = this.pos.filter([tp.x, tp.y, tp.z], t);
      this.cp.set(p[0], p[1], p[2]);
      this.cq.slerp(tq, rotationAlpha(this.cq.angleTo(tq), dt));
      this.cs.lerp(ts, 1 - Math.exp(-12 * dt));
    }
    this.anchor.compose(this.cp, this.cq, this.cs);
  }

  display(): THREE.Matrix4 | null {
    return this.tracking || this.holding ? this.anchor : null;
  }

  private kind() {
    const st = this.verState;
    if (!this.verify || st === 'sber') return 'sber';
    if (st === 'card' || st === 'back' || st === 'notcard') return st;
    return 'checking';
  }
}
