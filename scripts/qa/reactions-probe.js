// Замеры в странице для аудита реакций (scripts/qa/reactions.mjs): page.evaluate(installProbe) после посадки кота.
// window.__rx: begin(name) — начало сценария (поза и лицо «до» запоминаются), frame() — замер кадра (зовёт стенд после
// каждого виртуального кадра), gestures — касания пальцем (настоящие pointer-события на слое касаний, тот же путь, что палец),
// end() — кадры сценария. Рендер выключен, кроме кадров для контактного листа (__rx.render = true) — так 30 к/с в headless.
// Функция сериализуется puppeteer'ом — всё внутри неё.
export function installProbe() {
  const app = window.__app;
  const rx = (window.__rx = window.__rx || {});
  rx.render = false;
  // рендер — только по требованию (кадры листа): замеры от него не зависят
  if (!app.renderer.__rxWrapped) {
    const orig = app.renderer.render.bind(app.renderer);
    app.renderer.render = (s, c) => (rx.render ? orig(s, c) : undefined);
    app.renderer.__rxWrapped = true;
  }
  const BODY = /(Hips|Spine\d?|Neck|Head|Shoulder|Arm|ForeArm|Hand|UpLeg|Leg|Foot)$/;
  const KEY = /(Hips|Spine2|Head|LeftArm|RightArm|LeftForeArm|RightForeArm|LeftUpLeg|RightUpLeg)$/;
  const MOUTH = ['mouth_A', 'mouth_E', 'mouth_O', 'mouth_U', 'mouth_M', 'tongue_out', 'cheeks_gum'];
  const FACE_KEYS = ['smile', 'smirk', 'wink_L', 'wink_R', 'brow_up', 'brow_down', 'brow_sad', 'eyes_squint', 'eyes_wide', 'eyes_spiral', 'blush', 'frown', ...MOUTH];
  let c = null, bones = [], feet = [], hips = null, bind = [], prevQ = [], prevHip = null, prevFeet = [], restH = null, catMM = 0;
  let V, Q;
  const setup = () => {
    c = app.character;
    V = c.object.position.constructor;
    Q = c.object.quaternion.constructor;
    bones = [];
    c.object.traverse((o) => o.isBone && BODY.test(o.name) && !/Tail|Ear|Eye|Jaw/.test(o.name) && bones.push(o));
    feet = bones.filter((b) => /(Left|Right)Foot$/.test(b.name));
    hips = bones.find((b) => /Hips$/.test(b.name)) ?? null;
    let skel = null;
    c.object.traverse((o) => o.isSkinnedMesh && !skel && (skel = o.skeleton));
    const cur = bones.map((b) => [b.quaternion.clone(), b.position.clone()]);
    skel?.pose();
    bind = bones.map((b) => b.quaternion.clone());
    bones.forEach((b, i) => (b.quaternion.copy(cur[i][0]), b.position.copy(cur[i][1])));
    prevQ = bones.map((b) => b.quaternion.clone());
    prevHip = null;
    prevFeet = [];
    restH = null;
    // play() и fx.play() — в журнал сценария
    if (!c.__rxPlay) {
      const p = c.play.bind(c);
      c.play = (name, o) => {
        rx.plays?.push({ t: rx.t(), name, stack: (new Error().stack || '').split('\n').slice(2, 4).map((s) => s.trim().replace(/^at /, '').replace(/\(.*\//, '(')).join(' < ') });
        return p(name, o);
      };
      c.__rxPlay = true;
    }
  };
  if (!app.fx.__rxPlay) {
    const fp = app.fx.play.bind(app.fx);
    app.fx.play = (...a) => (rx.fx?.push({ t: rx.t(), id: a[0] }), fp(...a));
    app.fx.__rxPlay = true;
  }
  rx.setup = setup;
  const d = app.director;
  if (!d.__rxWrap) {
    for (const m of ['interaction', 'action', 'dispatch']) {
      const f = d[m].bind(d);
      d[m] = (a, ...rest) => {
        rx.events?.push({ t: rx.t(), m, k: typeof a === 'string' ? a : a?.kind ?? a?.type + (a?.intent ? ':' + a.intent.type : '') });
        return f(a, ...rest);
      };
    }
    d.__rxWrap = true;
  }
  const stage = app.stage;
  const tv = () => new V();
  rx.t = () => Math.round(performance.now() - (rx.t0 ?? 0));
  const ang = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.dot(b))));
  /** точка в плоскости опоры: x, y — по плоскости, z — высота; единицы — рост кота */
  const onPlane = (b, out) => {
    b.getWorldPosition(out);
    stage.anchor.worldToLocal(out);
    const h = stage.cfg.height || 1;
    out.x /= h;
    out.y /= h;
    out.z = (out.z - (stage.cfg.footZ || 0)) / h;
    return out;
  };
  rx.calibrate = () => {
    if (!c || c !== app.character) setup();
    // рост кота на карте, мм: высота cfg.height в ширинах карты × 85,6 мм
    catMM = (app.director?.d?.stage?.cfg?.height ?? stage.cfg.height) * 85.6;
    app.scene.updateMatrixWorld(true);
    const p = tv();
    restH = Math.min(...feet.map((f) => onPlane(f, p).z));
    return { restH, catMM, bones: bones.length, feet: feet.length };
  };
  rx.screen = (bone) => {
    const b = c.object.getObjectByName(bone) ?? bones.find((x) => x.name.endsWith(bone));
    if (!b) return null;
    const p = b.getWorldPosition(tv()).project(stage.camera);
    return { x: ((p.x + 1) / 2) * innerWidth, y: ((1 - p.y) / 2) * innerHeight };
  };
  rx.catBox = () => {
    // габарит кота на экране (по костям) — кадрирование листа
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const p = tv();
    for (const b of bones) {
      b.getWorldPosition(p).project(stage.camera);
      const x = ((p.x + 1) / 2) * innerWidth, y = ((1 - p.y) / 2) * innerHeight;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    return { x0, y0, x1, y1 };
  };
  rx.begin = (name) => {
    if (!c || c !== app.character) setup();
    if (restH === null) rx.calibrate();
    rx.name = name;
    rx.t0 = performance.now();
    rx.frames = [];
    rx.penPairs = {};
    rx.plays = [];
    rx.fx = [];
    rx.events = [];
    rx.sched = [];
    rx.track0 = c.clips.cur;
    rx.pose0 = bones.map((b) => b.quaternion.clone());
    rx.face0 = Object.fromEntries(FACE_KEYS.map((k) => [k, c.W?.[k] ?? 0]));
    rx.lastTrack = c.clips.cur;
    rx.err0 = (window.__qaErr || []).length;
  };
  /** «событие ребёнка» в этот момент (стенд отмечает начало касания / кнопки) */
  rx.mark = (what) => {
    rx.frames?.push({ mark: what, t: rx.t() });
    rx.repose();
  };
  rx.repose = () => {
    rx.pose0 = bones.map((b) => b.quaternion.clone());
    rx.face0 = Object.fromEntries(FACE_KEYS.map((k) => [k, c.W?.[k] ?? 0]));
  };
  rx.frame = () => {
    if (c !== app.character) {
      // смена кота: новый скелет
      setup();
      rx.calibrate();
      rx.frames.push({ mark: 'new_cat', t: rx.t() });
    }
    const dt = 1 / 30;
    const cs = c.clips;
    app.scene.updateMatrixWorld(true);
    let w = 0, wb = '', D = 0, nb = 0, Dsw = 0;
    if (cs.cur !== rx.lastTrack) rx.poseSw = null;
    bones.forEach((b, i) => {
      const a = ang(b.quaternion, prevQ[i]) / dt;
      if (a > w) [w, wb] = [a, b.name.replace(/^mixamorig:?/, '')];
      if (KEY.test(b.name)) {
        D = Math.max(D, ang(b.quaternion, rx.pose0[i] ?? b.quaternion));
        if (rx.poseSw) Dsw = Math.max(Dsw, ang(b.quaternion, rx.poseSw[i]));
      }
      if (ang(b.quaternion, bind[i]) < 0.003) nb++;
      prevQ[i].copy(b.quaternion);
    });
    // поза в кадр смены клипа (до этого кадра — показанная поза прошлого): от неё меряем «тело пошло»
    if (!rx.poseSw) rx.poseSw = rx.__prevPose ?? bones.map((b) => b.quaternion.clone());
    rx.__prevPose = bones.map((b) => b.quaternion.clone());
    let wHip = 0, hipV = 0;
    const hp = tv();
    if (hips) {
      const i = bones.indexOf(hips);
      wHip = i >= 0 ? ang(hips.quaternion, rx.__hq ?? hips.quaternion) / dt : 0;
      rx.__hq = hips.quaternion.clone();
      onPlane(hips, hp);
      if (prevHip) hipV = (hp.distanceTo(prevHip) / dt) * catMM;
      prevHip = hp.clone();
    }
    // лапы: высота над опорой (мм), скольжение опорной лапы (мм за кадр)
    const fh = [];
    const fp = [];
    let slide = 0;
    feet.forEach((f, i) => {
      const p = onPlane(f, tv());
      const h = (p.z - restH) * catMM;
      fh.push(+h.toFixed(1));
      fp.push(+(p.x * catMM).toFixed(1), +(p.y * catMM).toFixed(1));
      const pr = prevFeet[i];
      if (pr && h < 4 && pr.h < 4 && Math.abs(h - pr.h) < 1.5) slide += Math.hypot(p.x - pr.p.x, p.y - pr.p.y) * catMM;
      prevFeet[i] = { p, h };
    });
    let F = 0, fk = '';
    for (const k of FACE_KEYS) {
      const d = Math.abs((c.W?.[k] ?? 0) - (rx.face0[k] ?? 0));
      if (d > F) [F, fk] = [d, k];
    }
    const mouth = Math.max(...MOUTH.map((k) => c.W?.[k] ?? 0));
    const switched = cs.cur !== rx.lastTrack;
    rx.lastTrack = cs.cur;
    const pen = c.collider?.measure ? c.collider.measure() : 0;
    // проникновение по парам «часть тела : прокси», мм (BodyCollider.measurePairs, после коррекции)
    let penMM = 0, penPair = '';
    const pairs = c.collider?.measurePairs ? c.collider.measurePairs() : null;
    if (pairs) for (const k in pairs) {
      const v = pairs[k] * catMM;
      if (v > penMM) [penMM, penPair] = [v, k];
      if (v > 0.5) rx.penPairs[k] = Math.max(rx.penPairs[k] ?? 0, +v.toFixed(1));
    }
    const r = {
      t: rx.t(),
      clip: cs.cur.id,
      req: cs.requested,
      idle: cs.idleMode,
      sw: switched ? 1 : 0,
      w: +w.toFixed(2),
      wb,
      wHip: +wHip.toFixed(2),
      hipV: +hipV.toFixed(1),
      D: +D.toFixed(3),
      F: +F.toFixed(2),
      fk,
      emo: c.emotion,
      preset: c.faceMix?.preset,
      mouth: +mouth.toFixed(2),
      smile: +(c.W?.smile ?? 0).toFixed(2),
      blink: +(((c.W?.blink_L ?? 0) + (c.W?.blink_R ?? 0)) / 2).toFixed(2),
      fh,
      fp,
      Dsw: +Dsw.toFixed(3),
      slide: +slide.toFixed(2),
      pen: +pen.toFixed(3),
      penMM: +penMM.toFixed(1),
      penPair,
      hits: c.collider?.hits ?? 0,
      bind: +(nb / bones.length).toFixed(2),
      proc: c.procedural?.has(cs.cur.id) || !c.actions?.has(cs.cur.id) ? 1 : 0,
      alias: c.aliased?.has?.(cs.cur.id) ? 1 : 0,
      walk: stage.walking ? 1 : 0,
      glass: stage.atGlass ? 1 : 0,
      lift: +(c.lift ?? 0).toFixed(3),
      // пол (ground clamp, 20.11): самая низкая точка тела до и после подъёма, мм на карте; ниже нуля — в опоре
      graw: +((c.groundDbg?.min ?? 0) * catMM).toFixed(1),
      // то же независимо от сборки (до/после): капсулы касаний GLB (голова, корпус, лапы без ног), низ − радиус, мм
      gbody: (() => {
        if (!c.capsules?.length) return 0;
        let m = Infinity;
        const a = new V(), b = new V();
        for (const k of c.capsules) {
          if (/Foot|Toe|Leg|Tail|Ear/.test(k.b.name)) continue;
          c.object.worldToLocal(k.b.getWorldPosition(a));
          let y = a.y;
          if (k.c) y = Math.min(y, c.object.worldToLocal(k.c.getWorldPosition(b)).y);
          m = Math.min(m, y - k.r * 0.75);
        }
        return Number.isFinite(m) ? +(m * catMM).toFixed(1) : 0;
      })(),
      gmin: +((c.groundDbg?.final ?? 0) * catMM).toFixed(1),
      gpart: c.groundDbg?.name ?? '',
      act: c.actState ? `${c.actState.id}:${c.actState.phase}` : '',
      // предмет в лапе: от точки хвата до кисти, мм (держит, а не висит рядом)
      propMM: (() => {
        const po = c.props?.object, st = c.actState;
        if (!po || !st || st.id === 'skate' || !po.visible) return -1;
        const hb = c.bones?.get(st.id === 'mirror' ? 'LeftHand' : 'RightHand');
        if (!hb) return -1;
        return +(po.getWorldPosition(new V()).distanceTo(hb.getWorldPosition(new V())) / (c.object.getWorldScale(new V()).y || 1) * catMM).toFixed(1);
      })(),
      phase: app.director.state.phase,
      speaking: app.voice?.speaking ? 1 : 0,
      vis: stage.root.visible ? 1 : 0,
    };
    rx.frames.push(r);
    return r;
  };
  rx.end = () => ({
    name: rx.name,
    penPairs: rx.penPairs,
    frames: rx.frames,
    plays: rx.plays,
    fx: rx.fx,
    events: rx.events,
    errors: (window.__qaErr || []).slice(rx.err0),
    log: (app.character.anim?.log ?? []).slice(-12),
    catMM,
  });
  // ───── касания пальцем: pointer-события по кадрам ─────
  const surface = app.fx.canvas;
  let pid = 5000;
  const fire = (type, x, y, id) => surface.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true, isPrimary: true, pointerType: 'touch', pressure: type === 'pointerup' ? 0 : 0.5 }));
  rx.pointer = { fire, next: () => ++pid };
  const at = (bone, dx = 0, dy = 0) => {
    const p = rx.screen(bone) ?? { x: innerWidth / 2, y: innerHeight / 2 };
    const h = Math.max(40, rx.catBox().y1 - rx.catBox().y0);
    return { x: p.x + dx * h, y: p.y + dy * h };
  };
  /**
   * Шаг сценария → атомарные события по времени (мс от начала): op = tap | stroke | long | swipe | spam | action | js.
   * Точки касаний считаются в момент события (кот мог сдвинуться).
   */
  rx.add = (s) => {
    const t = s.at ?? 0;
    const q = rx.sched;
    const mark = (what) => q.push({ t, f: () => rx.mark(what) });
    switch (s.op) {
      case 'tap': {
        const id = rx.pointer.next();
        let pt;
        mark(`tap ${s.bone}`);
        q.push({ t, f: () => ((pt = at(s.bone, s.dx, s.dy)), fire('pointerdown', pt.x, pt.y, id)) });
        q.push({ t: t + (s.hold ?? 70), f: () => fire('pointerup', pt.x, pt.y, id) });
        break;
      }
      case 'spam': {
        for (let i = 0; i < (s.n ?? 8); i++) rx.add({ op: 'tap', at: t + i * (s.every ?? 125), bone: s.bones?.[i % s.bones.length] ?? 'Spine1', hold: 50 });
        break;
      }
      case 'stroke': {
        // поглаживание по спине/голове: туда-обратно по ширине кота
        const id = rx.pointer.next();
        const dur = s.dur ?? 1500;
        let p0;
        mark(`stroke ${s.bone} ${dur}`);
        q.push({ t, f: () => ((p0 = at(s.bone ?? 'Spine2')), fire('pointerdown', p0.x - 30, p0.y, id)) });
        for (let k = 33; k < dur; k += 33) q.push({ t: t + k, f: () => fire('pointermove', p0.x - 30 + 60 * Math.abs(Math.sin((k / 600) * Math.PI)), p0.y + 4 * Math.sin(k / 90), id) });
        q.push({ t: t + dur, f: () => fire('pointerup', p0.x, p0.y, id) });
        break;
      }
      case 'long': {
        const id = rx.pointer.next();
        let pt;
        mark(`long ${s.bone ?? 'off'}`);
        q.push({ t, f: () => ((pt = s.bone ? at(s.bone) : { x: innerWidth * 0.18, y: innerHeight * 0.3 }), fire('pointerdown', pt.x, pt.y, id)) });
        q.push({ t: t + (s.dur ?? 900), f: () => fire('pointerup', pt.x, pt.y, id) });
        break;
      }
      case 'swipe': {
        const id = rx.pointer.next();
        const y = innerHeight * 0.32;
        mark('swipe');
        q.push({ t, f: () => fire('pointerdown', innerWidth * 0.12, y, id) });
        for (let k = 1; k <= 8; k++) q.push({ t: t + k * 33, f: () => fire('pointermove', innerWidth * (0.12 + k * 0.09), y + k * 6, id) });
        q.push({ t: t + 9 * 33, f: () => fire('pointerup', innerWidth * 0.84, y + 48, id) });
        break;
      }
      case 'action':
        mark(`action ${s.id}`);
        q.push({ t, f: () => app.director.action(s.id) });
        break;
      case 'js':
        mark(s.label ?? 'js');
        q.push({ t, f: () => new Function('app', s.code)(app) });
        break;
    }
    q.sort((a, b) => a.t - b.t);
  };
  /** кадры до untilMs (30 к/с) с событиями по расписанию; render — нарисовать последний кадр */
  rx.run = async (untilMs, render = false) => {
    while (rx.t() < untilMs - 1) {
      const last = rx.t() + 33.4 >= untilMs - 1;
      rx.render = render && last;
      await window.__vt.step(1, 1000 / 30);
      while (rx.sched.length && rx.sched[0].t <= rx.t()) {
        try {
          rx.sched.shift().f();
        } catch (e) {
          (window.__qaErr ||= []).push({ kind: 'sched', msg: String(e?.stack || e) });
        }
      }
      rx.frame();
    }
    rx.render = false;
    return rx.t();
  };
  rx.director = app.director;
  return rx.calibrate();
}
