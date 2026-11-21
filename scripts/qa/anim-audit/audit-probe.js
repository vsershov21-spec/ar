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
  const hook = () => {
    const c = app.character;
    if (!c) return;
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
