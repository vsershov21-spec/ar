#!/usr/bin/env node
// Таблица аудита анимаций «действие × кот» (ok / терпимо / плохо) из summary_<tag>.json (audit-report.mjs) и raw/<tag>.json.
//   node scripts/qa/anim-audit/table.mjs <tag> [<tagДо>] [<perfTag>]
// С <tagДо> в ячейке — «было → стало»; с <perfTag> (прогон --cpu 4) — таблица idle-клипов с дрожью покоя.
// Пишет table_<tag>.md (и idle_<tag>.md) рядом со сводками. Пороги: плохо — ω > 30 рад/с в любом кадре, лапы > 15 мм,
// проникновение > 5 мм (или > 3 мм в > 2 % кадров), предмета в кота > 2 мм, тело ниже опоры > 5 мм (лёжа > 10 мм); терпимо — ω 15–30 / щелчок на
// стыке > 10,5, лапы > 6, проникн. > 1, пол > 2.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.ANIM_AUDIT_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../bench-out/anim-audit');
const [TAG = 'after', PREV = '', PERF = ''] = process.argv.slice(2);
const LBL = { awake: 'Пробуждение', rest: 'Покой (6 с)', zone_head: 'Тап: голова', zone_cheek: 'Тап: щёчка', zone_belly: 'Тап: живот', zone_paw: 'Тап: лапа', zone_tail: 'Тап: хвост', stroke: 'Поглаживание', tap_spam: 'Частые тапы', act_pet: 'Погладить', act_scratch: 'Почесать', act_tickle: 'Щекотка', act_treat: 'Угостить', act_paw: 'Дай лапу', act_hug: 'Обнять', act_dance: 'Танец', act_flip: 'Сальто', sig_skate: 'Скейт', sig_glass: 'К стеклу', sig_cocoa: 'Какао', sig_bubbles: 'Пузыри/блёстки', sig_mirror: 'Зеркальце', glass_scratch: 'Стекло: царапины', glass_fog: 'Стекло: запотело', doze_wake: 'Дрёма → тап', card_lost_found: 'Карта пропала/нашлась', chaos: 'Хаос', riddle: 'Загадка', echo: 'Повторялка', paint: 'Раскраска', home_enter: 'Дом: вход', home_kitchen: 'Дом: кухня', home_bedroom: 'Дом: спальня', home_bed: 'Кровать: лечь+укрыться', home_bed_wake: 'Кровать: проснуться', home_exit: 'Дом → карта', st_flip5: 'Сальто ×5 за 0,6 с', st_skate_dance: 'Фирменное → Танец', st_mix_fast: '8 кнопок за 1,8 с', st_prop_cancel: 'Фирменное → Погладить', st_treat_cancel: 'Угостить → Обнять', st_sleep_btn: 'Сон → кнопка', st_paint_btn: 'Раскраска → кнопка', st_bed_btn: 'Кровать → кнопка', st_switch_mid: 'Смена кота посреди действия', switch: 'Смена кота' };
const LIE = /sleep|bed|lie_/;
const CATS = ['hooligan', 'kind', 'glitter'];

function grade(tag) {
  const S = JSON.parse(fs.readFileSync(`${BASE}/summary_${tag}.json`, 'utf8'));
  const raw = JSON.parse(fs.readFileSync(`${BASE}/raw/${tag}.json`, 'utf8'));
  const res = (cat, id) => raw.cats.find((c) => c.cat === cat)?.results.find((x) => x.id === id);
  const rows = {};
  for (const o of S) {
    const r = res(o.cat, o.id);
    const fr = r ? r.frames.filter((f) => !f.mark) : [];
    const W = Math.max(0, ...fr.map((f) => f.w));
    const lie = fr.filter((f) => f.vis && LIE.test(f.clip));
    const ss = lie.length ? Math.min(...lie.map((f) => f.gbody ?? 0)) : null;
    const pen = o.penMM, pp = o.penPct;
    let v = 0;
    const why = [];
    const bad = (s) => ((v = 2), why.push(s)), tol = (s) => ((v = Math.max(v, 1)), why.push(s));
    if (W > 30) bad(`ω${W.toFixed(0)}`); else if (o.pop > 15 || W > 20) tol(`ω${Math.max(W, o.pop).toFixed(0)}`); else if (o.pop > 10.5) tol(`щ${o.pop}`);
    if (o.slide > 15) bad(`лапы ${o.slide}`); else if (o.slide > 6) tol(`лапы ${o.slide}`);
    if (pen > 5 || (pen > 3 && pp > 2)) bad(`пр ${pen}/${pp}%`); else if (pen > 1) tol(`пр ${pen}`);
    if ((o.floor.gbody ?? 0) < -5) bad(`пол ${o.floor.gbody}`); else if ((o.floor.gbody ?? 0) < -2) tol(`пол ${o.floor.gbody}`);
    if (ss !== null && ss < -10) bad(`лёжа в опоре ${ss}`); else if (ss !== null && ss < -2) tol(`лёжа ${ss}`);
    if (o.notes.some((n) => /не вернулся в покой/.test(n)) && !/^(st_|switch|paint|riddle|echo|rest|idleclip_|look_)/.test(o.id)) tol(`висит ${o.endClip}`);
    // предмет в лапах (26.11): проникновение предмета в кисть/пальцы/тело — норма ≤ 2 мм
    const pp = o.props?.penProp ?? 0;
    if (pp > 2) bad(`пр.предмета ${pp}`); else if (pp > 1) tol(`пр.предмета ${pp}`);
    if (o.bind > 0.5) bad('T-поза');
    (rows[o.id] ||= {})[o.cat] = { v, why, W, o };
  }
  return rows;
}

const V = ['ok', 'терпимо', '**плохо**'];
const cur = grade(TAG);
const prev = PREV ? grade(PREV) : null;
const L = [`| действие | Хулиган | Добряк | Блёстка |`, '|---|---|---|---|'];
const cnt = [0, 0, 0], cntP = [0, 0, 0];
for (const id of Object.keys(LBL)) {
  if (!cur[id]) continue;
  const cells = CATS.map((c) => {
    const x = cur[id][c];
    if (!x) return '—';
    cnt[x.v]++;
    const p = prev?.[id]?.[c];
    if (p) cntP[p.v]++;
    const now = `${V[x.v]}${x.why.length ? ' · ' + x.why.join(', ') : ''}`;
    return p ? `${V[p.v].replace(/\*/g, '')}${p.why.length ? ' (' + p.why.join(', ') + ')' : ''} → ${now}` : now;
  });
  L.push(`| ${LBL[id]} | ${cells.join(' | ')} |`);
}
L.push('', `Итого ячеек: ok ${cnt[0]}, терпимо ${cnt[1]}, плохо ${cnt[2]}${prev ? ` (было: ok ${cntP[0]}, терпимо ${cntP[1]}, плохо ${cntP[2]})` : ''}.`);
fs.writeFileSync(`${BASE}/table_${TAG}.md`, L.join('\n') + '\n');
console.log(L.join('\n'));

// idle-клипы: скольжение, пик ω, проникновение, дрожь покоя (из прогона --cpu 4, если дан, иначе из этого же)
const q = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : null);
const P = JSON.parse(fs.readFileSync(`${BASE}/raw/${PERF || TAG}.json`, 'utf8'));
const S = JSON.parse(fs.readFileSync(`${BASE}/summary_${TAG}.json`, 'utf8'));
const I = ['| idle-клип | кот | лапы мм | ω пик | пр мм | дрожь p50/p95 ° |', '|---|---|---|---|---|---|'];
for (const o of S.filter((x) => /^idleclip_|^rest$/.test(x.id))) {
  const pr = P.cats.find((c) => c.cat === o.cat)?.results.find((r) => r.id === o.id);
  const fr = pr ? pr.frames.filter((f) => !f.mark && f.t > 800 && !f.sw) : [];
  const ji = fr.map((f) => f.jit).filter((x) => x !== undefined);
  const W = cur[o.id]?.[o.cat]?.W ?? 0;
  I.push(`| ${o.id.replace('idleclip_', '')} | ${o.cat} | ${o.slide} | ${W.toFixed(0)} | ${o.penMM}${o.penMM > 1 ? ' ' + o.penPair : ''} | ${ji.length ? q(ji, 0.5) + ' / ' + q(ji, 0.95) : '—'} |`);
}
fs.writeFileSync(`${BASE}/idle_${TAG}.md`, I.join('\n') + '\n');
console.log(I.join('\n'));
