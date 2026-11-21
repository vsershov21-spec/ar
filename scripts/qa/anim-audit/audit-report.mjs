#!/usr/bin/env node
// Сводка аудита анимаций: bench-out/anim-audit/raw/<tag>.json → bench-out/anim-audit/summary_<tag>.json + строки в stdout.
// node scripts/qa/anim-audit/audit-report.mjs <tag>      (ANIM_AUDIT_DIR — другая папка стенда)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from './audit.mjs';

const BASE = process.env.ANIM_AUDIT_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../bench-out/anim-audit');

const [TAG = 'audit', PERF = ''] = process.argv.slice(2);
const load = (t) => JSON.parse(fs.readFileSync(`${BASE}/raw/${t}.json`, 'utf8'));
const run = load(TAG);
const q = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : null);
const INTENDED = /dive|appear|goodbye|run_home|sink|sleep|bed|lie_|fall_off/;
const HEAD = /head|headphones|cap|ear|bow|hair|neck/i, SCARF = /scarf/i, SKIRT = /skirt|tulle/i, TORSO = /torso|chest|belly|spine/i;
const group = (pair) => {
  const [part, proxy = ''] = pair.split(':');
  const leg = /Leg|Knee|Foot|Thigh|UpLeg/.test(part);
  const g = SKIRT.test(proxy) ? 'юбка' : SCARF.test(proxy) ? 'шарф' : HEAD.test(proxy) ? 'голова/убор' : TORSO.test(proxy) ? 'торс' : /Leg|thigh|shin/i.test(proxy) ? 'нога' : proxy;
  return `${leg ? 'нога' : 'рука'}↔${g}`;
};

const out = [];
for (const c of run.cats) {
  for (const r of c.results) {
    const a = analyze(r, c.durs, run.cuts);
    const fr = r.frames.filter((f) => !f.mark);
    const m0 = r.frames.find((f) => f.mark)?.t ?? 0;
    const vis = fr.filter((f) => f.vis && !INTENDED.test(f.clip));
    // пол
    const gb = vis.map((f) => f.gbody ?? 0), gm = vis.filter((f) => f.gpart).map((f) => f.gmin);
    const floor = { gbody: gb.length ? Math.min(...gb) : null, gbodyPct: gb.length ? +((gb.filter((v) => v < -1).length / gb.length) * 100).toFixed(1) : 0, gmin: gm.length ? Math.min(...gm) : null, gminPct: gm.length ? +((gm.filter((v) => v < -1).length / gm.length) * 100).toFixed(1) : 0, gpart: vis.reduce((w, f) => ((f.gmin ?? 0) < (w.v ?? 0) ? { v: f.gmin, p: f.gpart, clip: f.clip, t: f.t } : w), {}) };
    // проникновения по группам
    const pen = {};
    let penFrames = 0;
    for (const f of fr) {
      if ((f.penMM ?? 0) > 1) penFrames++;
      if ((f.penMM ?? 0) > 0.5 && f.penPair) {
        const g = group(f.penPair);
        const p = (pen[g] ||= { max: 0, n: 0, pair: '', clip: '', t: 0 });
        p.n++;
        if (f.penMM > p.max) Object.assign(p, { max: f.penMM, pair: f.penPair, clip: f.clip, t: f.t });
      }
    }
    for (const g in pen) pen[g].pct = +((pen[g].n / fr.length) * 100).toFixed(1);
    // предметы
    const use = fr.filter((f) => f.propMM >= 0 && /:(raise|use|lower)$/.test(f.act ?? ''));
    const pv = fr.filter((f) => f.propVis);
    const props = pv.length
      ? {
          names: [...new Set(pv.map((f) => f.propName))],
          grip: q(use.map((f) => f.propMM), 0.5), gripMax: use.length ? Math.max(...use.map((f) => f.propMM)) : null,
          handMax: Math.max(...pv.map((f) => f.propHand ?? -1)), detach: pv.filter((f) => (f.propHand ?? 0) > 15).length,
          scale: [Math.min(...pv.map((f) => f.propScale ?? 1)), Math.max(...pv.map((f) => f.propScale ?? 1))],
          stuck: fr.filter((f) => f.stuck).length, stuckAtEnd: !!fr[fr.length - 1]?.stuck, visFrames: pv.length,
        }
      : null;
    // покой: дрожь (угловая скорость в кадрах покоя без смены клипа, p95) и скольжение
    const idleF = fr.filter((f) => f.idle && !f.sw && f.t > m0 + 500);
    const jitter = idleF.length > 20 ? { w95: q(idleF.map((f) => f.w), 0.95), hipV95: q(idleF.map((f) => f.hipV), 0.95) } : null;
    // рывки вне стыков: кадры с w > 15 рад/с
    const spikes = fr.filter((f) => f.w > 15);
    // реплики: голос дважды одним текстом за 4 с, два голоса за 1,2 с, реплика чужого кота
    const voice = (r.speech ?? []).filter((s) => s.k === 'voice');
    const dup = [];
    voice.forEach((s, i) => {
      const n = voice[i + 1];
      if (n && n.t - s.t < 1200) dup.push(`${s.text} | ${n.text} (${n.t - s.t} мс)`);
      if (voice.some((x, k) => k > i && x.text === s.text && x.t - s.t < 4000)) dup.push(`повтор: ${s.text}`);
    });
    const alien = voice.filter((s) => {
      const f = fr.find((x) => x.t >= s.t);
      return f && s.persona && f.persona && s.persona !== f.persona;
    }).map((s) => `${s.persona} над ${fr.find((x) => x.t >= s.t).persona}: ${s.text}`);
    // производительность (реальное время update кота за кадр)
    const tu = fr.map((f) => f.tUpd ?? 0), tc = fr.map((f) => f.tCol ?? 0);
    const perf = { upd50: q(tu, 0.5), upd95: q(tu, 0.95), updMax: Math.max(...tu), col50: q(tc, 0.5), col95: q(tc, 0.95), nMix: Math.max(...fr.map((f) => f.nMix ?? 0)), nAct: Math.max(...fr.map((f) => f.nAct ?? 0)) };
    out.push({
      cat: c.cat, id: r.id, verdict: a.verdict, notes: a.notes, lat: a.lat, pop: a.pop, popAt: a.popAt, w99: a.w99, slide: a.slide, slideWalk: a.slideWalk, sink: a.sink, float: a.float,
      penMM: a.penMM, penPair: a.penPair, penPct: +((penFrames / fr.length) * 100).toFixed(1), pen, floor, props, jitter, spikes: spikes.length, spikeTop: spikes.sort((x, y) => y.w - x.w).slice(0, 3).map((f) => `${f.w}@${f.wb}/${f.clip}/${f.t}`),
      bind: a.bind, clips: a.clips, plays: r.plays.map((p) => `${p.name}@${p.t}`), stub: a.stub, cut: a.cut, fight: a.fight, idleAt: a.idleAt, speech: voice.map((s) => `${s.t}:${s.persona}:${s.text}`), dup, alien, perf, errors: r.errors?.length ?? 0,
      endClip: fr[fr.length - 1]?.clip, endPersona: fr[fr.length - 1]?.persona,
    });
  }
}
fs.writeFileSync(`${BASE}/summary_${TAG}.json`, JSON.stringify(out, null, 1));
for (const o of out)
  console.log(
    [o.cat, o.id, o.verdict, `pop ${o.pop}(${o.popAt})`, `w99 ${o.w99}`, `sl ${o.slide}/${o.slideWalk}`, `sink ${o.sink}`, `pen ${o.penMM} ${o.penPct}% ${o.penPair}`, `floor ${o.floor.gbody}/${o.floor.gbodyPct}% gmin ${o.floor.gmin}/${o.floor.gminPct}%`,
      o.props ? `prop ${o.props.names} grip ${o.props.grip}/${o.props.gripMax} hand ${o.props.handMax} det ${o.props.detach} sc ${o.props.scale} stuck ${o.props.stuck}${o.props.stuckAtEnd ? '!END' : ''}` : '',
      o.jitter ? `jit ${o.jitter.w95}` : '', o.spikes ? `spk ${o.spikes} ${o.spikeTop[0]}` : '', o.dup.length ? `DUP ${o.dup.join(' / ')}` : '', o.alien.length ? `ALIEN ${o.alien.join(' / ')}` : '', o.bind > 0.3 ? `BIND ${o.bind}` : '', `end ${o.endClip}`, `upd ${o.perf.upd50}/${o.perf.upd95}/${o.perf.updMax} col ${o.perf.col50}/${o.perf.col95} mix ${o.perf.nMix}/${o.perf.nAct}`, o.errors ? `ERR ${o.errors}` : ''].filter(Boolean).join(' | '),
  );
