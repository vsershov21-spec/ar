// Доп. замеры аудита анимаций (scripts/qa/audit.mjs) поверх reactions-probe: время update/коллайдера/миксера по
// реальным часам (__vt.real.now), число миксеров и активных клипов, предмет (виден, масштаб, отрыв), реплики.
export function extraProbe() {
  const app = window.__app, rx = window.__rx;
  const real = window.__vt?.real?.now ?? (() => 0);
  const acc = { upd: 0, col: 0, mix: 0, pin: 0, mixers: new Set(), actions: 0 };
  rx.speech = [];
  const wrapProto = (obj, name, key) => {
    const P = Object.getPrototypeOf(obj);
    if (!P || P['__aa_' + name]) return;
    const f = P[name];
    if (typeof f !== 'function') return;
    P[name] = function (...a) {
      const t = real();
      try {
        return f.apply(this, a);
      } finally {
        acc[key] += real() - t;
        if (key === 'mix') {
          acc.mixers.add(this);
          acc.actions += this._nActiveActions ?? 0;
        }
      }
    };
    P['__aa_' + name] = true;
  };
  // ноги по стадиям кадра: после клипа (вход groundClamp), после опоры лап (вход applyAlive), до коррекции тела
  // (вход collider.apply) — углы коленей, ° (что именно гнёт колено: клип, pinFeet, живой слой, коллайдер)
  const legSnap = (c) => {
    const V = c.object.position.constructor;
    const loc = (n) => {
      const b = c.bones?.get(n);
      if (!b) return null;
      b.updateWorldMatrix(true, false);
      return c.object.worldToLocal(b.getWorldPosition(new V()));
    };
    c.object.updateMatrixWorld(true);
    const fe = [];
    const out = ['Left', 'Right'].map((s) => {
      const U = loc(s + 'UpLeg'), K = loc(s + 'Leg'), F = loc(s + 'Foot');
      if (!U || !K || !F) return 0;
      fe.push(F);
      return +((K.clone().sub(U).angleTo(F.clone().sub(K)) * 180) / Math.PI).toFixed(1);
    });
    // ширина стойки на этой стадии, мм
    if (fe.length === 2) out.push(+(Math.hypot(fe[0].x - fe[1].x, fe[0].z - fe[1].z) * (rx.__catMM ?? 77)).toFixed(1));
    return out;
  };
  rx.legStage = {};
  const wrapSnap = (obj, name, key) => {
    const P = Object.getPrototypeOf(obj);
    if (!P || P['__ls_' + name] || typeof P[name] !== 'function') return;
    const f = P[name];
    P[name] = function (...a) {
      try {
        const c = app.character;
        if (c) rx.legStage[key] = legSnap(c);
      } catch {}
      return f.apply(this, a);
    };
    P['__ls_' + name] = true;
  };
  const hook = () => {
    const c = app.character;
    if (!c) return;
    wrapSnap(c, 'groundClamp', 'clip');
    wrapSnap(c, 'applyAlive', 'pin');
    if (c.collider) wrapSnap(c.collider, 'apply', 'precol');
    wrapProto(c, 'update', 'upd');
    if (c.collider) wrapProto(c.collider, 'apply', 'col');
    if (c.mixer) wrapProto(c.mixer, 'update', 'mix');
    if (typeof c.pinFeet === 'function') wrapProto(c, 'pinFeet', 'pin');
  };
  hook();
  const d = app.director?.d;
  if (d?.voice && !d.voice.__aa) {
    const sp = d.voice.speak.bind(d.voice);
    d.voice.speak = (req, ...r) => (rx.speech.push({ t: rx.t(), k: 'voice', text: String(req?.text ?? req?.template ?? '').slice(0, 80), persona: req?.persona }), sp(req, ...r));
    d.voice.__aa = true;
  }
  if (d?.ui?.say && !d.ui.__aa) {
    const s = d.ui.say.bind(d.ui);
    d.ui.say = (text, ...r) => (rx.speech.push({ t: rx.t(), k: 'bubble', text: String(text ?? '').slice(0, 80), persona: r[1] }), s(text, ...r));
    d.ui.__aa = true;
  }
  const origBegin = rx.begin;
  rx.begin = (name) => {
    origBegin(name);
    rx.speech = [];
  };
  const origEnd = rx.end;
  rx.end = () => ({ ...origEnd(), speech: rx.speech });
  const origFrame = rx.frame;
  rx.frame = () => {
    hook();
    const r = origFrame();
    const c = app.character;
    const po = c.props?.object;
    const V = c.object.position.constructor;
    const cs = c.object.getWorldScale(new V()).y || 1;
    r.tUpd = +acc.upd.toFixed(3);
    r.tCol = +acc.col.toFixed(3);
    r.tMix = +acc.mix.toFixed(3);
    r.tPin = +acc.pin.toFixed(3);
    r.nMix = acc.mixers.size;
    r.nAct = acc.actions;
    acc.upd = acc.col = acc.mix = acc.pin = acc.actions = 0;
    acc.mixers.clear();
    r.propVis = po && po.visible ? 1 : 0;
    r.propName = po ? po.name || po.userData?.id || '' : '';
    if (po && po.visible) {
      const s = po.getWorldScale(new V());
      r.propScale = +(s.y / cs).toFixed(3);
      // ближайшая кисть до предмета (мм) — отрыв, если предмет виден, а кисти далеко
      let m = Infinity;
      for (const n of ['LeftHand', 'RightHand']) {
        const hb = c.bones?.get(n);
        if (hb) m = Math.min(m, po.getWorldPosition(new V()).distanceTo(hb.getWorldPosition(new V())) / cs);
      }
      r.propHand = Number.isFinite(m) ? +(m * (rx.__catMM ?? 77)).toFixed(1) : -1;
      // проникновение предмета в кота (26.11: «предметы проникают в руки»): точки сетки кота внутри предмета, мм —
      // character/propPen.ts; дорого (скиннинг всех точек) — каждый 2-й кадр с предметом
      if (typeof c.propPen === 'function' && (rx.__ppN = (rx.__ppN ?? 0) + 1) % 2 === 0 && r.propScale > 0.05) {
        const pp = c.propPen(2);
        if (pp) {
          r.ppen = +(pp.depth * (rx.__catMM ?? 77)).toFixed(2);
          r.ppenPart = pp.depth > 0 ? `${pp.part}:${pp.bone}` : '';
        }
      }
    }
    // все объекты-предметы, висящие в сцене видимыми без действия (застрявшие)
    r.stuck = po && po.visible && !c.actState && !/skate/.test(c.clips.cur.id) ? 1 : 0;
    r.persona = c.personaId;
    // дрожь: отклонение позы кадра t-1 от середины t-2..t (высокочастотная составляющая), макс. по костям тела, градусы
    let jit = 0, jb = '';
    const list = [];
    c.object.traverse((o) => o.isBone && /(Hips|Spine\d?|Neck|Head|Arm|ForeArm|Hand|UpLeg|Leg|Foot)$/.test(o.name) && list.push(o));
    if (!rx.__jq || rx.__jqCat !== c) { rx.__jq = list.map((b) => [b.quaternion.clone(), b.quaternion.clone()]); rx.__jqCat = c; }
    list.forEach((b, i) => {
      const [q2, q1] = rx.__jq[i];
      const mid = q2.clone().slerp(b.quaternion, 0.5);
      const d = 2 * Math.acos(Math.min(1, Math.abs(mid.dot(q1)))) * 57.3;
      if (d > jit) [jit, jb] = [d, b.name.replace(/^mixamorig:?/, '')];
      q2.copy(q1); q1.copy(b.quaternion);
    });
    r.jit = +jit.toFixed(2);
    // ноги (23.11, «ноги как желе»): в системе кота, мм на карте. st — расстояние между стопами по горизонтали, hw — между
    // тазобедренными суставами; kA — сгиб колена (°, 0 — прямая); kF — колено вперёд от линии бедро→стопа (мм, < 0 —
    // колено назад, «обратный» сгиб); kO — колено наружу (мм); fv — скорость стопы по горизонтали (мм/с); fj — дрожь
    // стопы (отклонение от середины соседних кадров, мм)
    {
      const mm = rx.__catMM ?? 77;
      const loc = (n) => {
        const b = c.bones?.get(n);
        return b ? c.object.worldToLocal(b.getWorldPosition(new V())) : null;
      };
      const S = ['Left', 'Right'].map((s) => ({ U: loc(s + 'UpLeg'), K: loc(s + 'Leg'), F: loc(s + 'Foot') }));
      if (S.every((s) => s.U && s.K && s.F)) {
        const midX = (S[0].U.x + S[1].U.x) / 2;
        r.st = +(Math.hypot(S[0].F.x - S[1].F.x, S[0].F.z - S[1].F.z) * mm).toFixed(1);
        r.hw = +(Math.hypot(S[0].U.x - S[1].U.x, S[0].U.z - S[1].U.z) * mm).toFixed(1);
        r.kA = [];
        r.kF = [];
        r.kO = [];
        r.fv = [];
        r.fj = [];
        rx.__legPrev ??= [];
        S.forEach((s, i) => {
          const a = s.K.clone().sub(s.U), b = s.F.clone().sub(s.K);
          r.kA.push(+((a.angleTo(b) * 180) / Math.PI).toFixed(1));
          const line = s.F.clone().sub(s.U);
          const u = Math.max(0, Math.min(1, s.K.clone().sub(s.U).dot(line) / Math.max(1e-9, line.lengthSq())));
          const off = s.K.clone().sub(s.U.clone().addScaledVector(line, u));
          r.kF.push(+(off.z * mm).toFixed(1));
          r.kO.push(+(off.x * Math.sign(s.U.x - midX || (i ? -1 : 1)) * mm).toFixed(1));
          const pv = rx.__legPrev[i];
          r.fv.push(pv && rx.__legCat === c ? +((Math.hypot(s.F.x - pv[1].x, s.F.z - pv[1].z) * 30) * mm).toFixed(1) : 0);
          r.fj.push(pv && rx.__legCat === c ? +(pv[1].distanceTo(pv[0].clone().add(s.F).multiplyScalar(0.5)) * mm).toFixed(2) : 0);
          rx.__legPrev[i] = [pv ? pv[1] : s.F.clone(), s.F.clone()];
        });
        rx.__legCat = c;
      }
      r.kS = rx.legStage;
      rx.legStage = {};
      // лицо (залипание): пресет микшера, эмоция и её сила, веки и спирали
      const W = c.W ?? {};
      r.fPre = c.faceMix?.preset ?? '';
      r.emoS = +(c.emoL?.s ?? 0).toFixed(2);
      r.lid = +Math.max(W.eyes_sleepy ?? 0, W.eyes_smug ?? 0, W.eyes_squint ?? 0).toFixed(2);
      r.spiral = +(W.eyes_spiral ?? 0).toFixed(2);
      r.frown = +Math.max(W.frown ?? 0, W.brow_down ?? 0).toFixed(2);
    }
    // --trace "выражение" (audit.mjs): своё значение в кадр (отладка правки)
    if (window.__rxTraceFn) {
      try {
        r.tr = window.__rxTraceFn(app);
      } catch (e) {
        r.tr = 'ERR ' + String(e).slice(0, 60);
      }
    }
    r.jitB = jb;
    return r;
  };
  const origCal = rx.calibrate;
  rx.calibrate = () => {
    const x = origCal();
    rx.__catMM = x?.catMM;
    return x;
  };
  rx.__catMM = rx.calibrate().catMM;
  return true;
}
