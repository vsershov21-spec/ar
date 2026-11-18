/** новая логика (src/tracker/card/session.ts) на стенде — как её зовёт CardTracker */
import * as THREE from 'three';
import { CardSession, OrientationHistory } from '../../src/tracker/card/session';
import type { Intrinsics } from '../../src/tracker/card/geometry';
import type { PipelineOut } from '../../src/tracker/card/pipeline';
import type { BenchSession, SessionRequest } from './cardBench';

/** задержка камеры, которую предполагает трекер (CardTracker.camLatMs) */
export const CAM_LAT_MS = 33;

export class BenchCardSession implements BenchSession {
  readonly name = 'после';
  events: { t: number; ev: string }[] = [];
  readonly s: CardSession;
  private hist = new OrientationHistory();
  private capQ: THREE.Quaternion | null = null;
  private m: THREE.Matrix4 | null = null;
  constructor(verify: boolean) {
    this.s = new CardSession(verify);
  }
  get state() {
    return this.s.state;
  }
  set state(_v: string) {}
  get verified() {
    return this.s.fsm.verified;
  }
  get tracking() {
    return this.s.state === 'locked';
  }
  set tracking(_v: boolean) {}
  request(t: number, q: THREE.Quaternion | null): SessionRequest {
    if (q) this.hist.push(t * 1000, q);
    this.capQ = q ? this.hist.at(t * 1000 - CAM_LAT_MS) : null;
    const r = this.s.request(t * 1000, this.capQ);
    const reset = this.pendingReset;
    this.pendingReset = false;
    return { lock: r.lock, hint: r.hint, hintRadius: r.hintRadius, rot: r.rot, lostMs: r.lostMs, reset };
  }
  onResult(r: PipelineOut, _cap: { t: number }, K: Intrinsics, ctx: { angSpeed: number; now: number }) {
    this.s.K = K;
    this.s.w = K.cx * 2;
    this.s.h = K.cy * 2;
    const st = this.s.onResult(r, this.capQ, ctx.now, ctx.angSpeed);
    if (st.found) this.events.push({ t: ctx.now, ev: 'lock' });
    if (st.reset) this.events.push({ t: ctx.now, ev: 'reanchor' });
    if (st.lost) this.events.push({ t: ctx.now, ev: 'lost' });
    this.pendingReset ||= !!st.reset;
  }
  pendingReset = false;
  frame(t: number, dt: number, qNow: THREE.Quaternion | null) {
    if (qNow) this.hist.push(t * 1000, qNow);
    this.s.tick(t * 1000);
    this.m = this.s.frame(dt, qNow);
  }
  display() {
    return this.m;
  }
}
