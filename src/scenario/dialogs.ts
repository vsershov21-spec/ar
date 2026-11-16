/**
 * Многоходовые диалоги по content/dialogs.json. Чистые функции: состояние + вход → новое состояние + команды.
 *
 * Узел диалога:
 *   do      — действия до реплики (offer_choice, riddle_next, adult_hint, pause_play:10000, …)
 *   say     — событие(я) реплики активного характера; «$riddle.q» / «$riddle.hint» — текст загадки
 *   sayIf   — говорить не каждый раз: { counter, first, every } (повторялка: после 1-го и каждого 4-го)
 *   listen  — окно ответа: микрофон открывается сам после реплики на ms (по умолчанию answerWindowMs)
 *   on      — куда идти по ответу: интент / name / right / wrong / giveup / timeout / «*» (всё остальное)
 *   next    — сразу перейти дальше
 * Цель перехода — id узла или «@действие[:аргумент]» (диалог заканчивается и выполняется действие).
 */
export type ListenMode = 'intent' | 'name' | 'riddle' | 'echo';

export interface DialogNode {
  do?: string[];
  say?: string | string[];
  sayIf?: { counter: string; first?: boolean; every?: number };
  count?: string;
  listen?: { mode: ListenMode; ms?: number };
  on?: Record<string, string>;
  next?: string;
}

export interface DialogDef {
  title: string;
  trigger: string;
  start: string;
  nodes: Record<string, DialogNode>;
}

export interface DialogsFile {
  version: number;
  answerWindowMs: number;
  /** текст-подсказка «позови взрослого» (показывается на экране при sad/scared) */
  adultHint?: string;
  /** интент → «диалог[:узел]» */
  triggers: Record<string, string>;
  /** интенты, которые прерывают любой диалог (безопасность) */
  interrupts: string[];
  dialogs: Record<string, DialogDef>;
  riddles?: Record<string, unknown>;
}

export interface DialogState {
  id: string;
  node: string;
  /** ждём ответ (узел с listen) */
  listening: ListenMode | null;
  counters: Record<string, number>;
}

export type DialogCmd =
  | { type: 'say'; event: string }
  | { type: 'do'; action: string; arg?: string }
  | { type: 'listen'; mode: ListenMode; ms: number }
  | { type: 'end'; action?: string; arg?: string };

export interface DialogStep { state: DialogState | null; cmds: DialogCmd[] }

const splitAction = (s: string) => {
  const [action, ...rest] = s.replace(/^@/, '').split(':');
  return { action, arg: rest.length ? rest.join(':') : undefined };
};

/** «riddle» или «brother:kids» */
export function resolveTrigger(f: DialogsFile, intent: string): { id: string; node?: string } | null {
  const t = f.triggers[intent];
  if (!t) return null;
  const [id, node] = t.split(':');
  return f.dialogs[id] ? { id, node } : null;
}

export function startDialog(f: DialogsFile, id: string, node?: string, counters: Record<string, number> = {}): DialogStep {
  const d = f.dialogs[id];
  if (!d) return { state: null, cmds: [] };
  return enterNode(f, { id, node: node ?? d.start, listening: null, counters: { ...counters } }, node ?? d.start, 0);
}

function enterNode(f: DialogsFile, st: DialogState, target: string, depth: number): DialogStep {
  const cmds: DialogCmd[] = [];
  if (depth > 12) return { state: null, cmds: [{ type: 'end' }] }; // защита от циклов в контенте
  if (target.startsWith('@')) {
    const { action, arg } = splitAction(target);
    cmds.push({ type: 'end', ...(action === 'end' ? {} : { action, arg }) });
    return { state: null, cmds };
  }
  const n = f.dialogs[st.id]?.nodes[target];
  if (!n) return { state: null, cmds: [{ type: 'end' }] };
  const counters = { ...st.counters };
  if (n.count) counters[n.count] = (counters[n.count] ?? 0) + 1;
  for (const a of n.do ?? []) cmds.push({ type: 'do', ...splitAction(a) });
  let speak = true;
  if (n.sayIf) {
    const c = counters[n.sayIf.counter] ?? 0;
    speak = (!!n.sayIf.first && c === 1) || (!!n.sayIf.every && c > 0 && c % n.sayIf.every === 0);
  }
  if (speak) for (const s of Array.isArray(n.say) ? n.say : n.say ? [n.say] : []) cmds.push({ type: 'say', event: s });
  const state: DialogState = { ...st, node: target, counters, listening: null };
  if (n.listen) {
    cmds.push({ type: 'listen', mode: n.listen.mode, ms: n.listen.ms ?? f.answerWindowMs });
    return { state: { ...state, listening: n.listen.mode }, cmds };
  }
  if (n.next) {
    const r = enterNode(f, state, n.next, depth + 1);
    return { state: r.state, cmds: [...cmds, ...r.cmds] };
  }
  cmds.push({ type: 'end' });
  return { state: null, cmds };
}

/** Ответ ребёнка (интент, name, right/wrong/giveup) или 'timeout'. null — узел ответа не ждёт. */
export function answerDialog(f: DialogsFile, st: DialogState, heard: string): DialogStep | null {
  const n = f.dialogs[st.id]?.nodes[st.node];
  if (!n?.listen) return null;
  const on = n.on ?? {};
  const target = heard === 'timeout' ? on.timeout ?? '@end' : on[heard] ?? on['*'] ?? '@end';
  return enterNode(f, st, target, 0);
}

/** Проверка ссылок dialogs.json (используется в тестах; build.py проверяет то же самое). */
export function validateDialogs(f: DialogsFile, knownEvents: Set<string>): string[] {
  const errs: string[] = [];
  for (const [intent, t] of Object.entries(f.triggers)) {
    const [id, node] = t.split(':');
    if (!f.dialogs[id]) errs.push(`trigger ${intent}: нет диалога ${id}`);
    else if (node && !f.dialogs[id].nodes[node]) errs.push(`trigger ${intent}: нет узла ${id}:${node}`);
  }
  for (const [id, d] of Object.entries(f.dialogs)) {
    if (!d.nodes[d.start]) errs.push(`${id}: нет стартового узла ${d.start}`);
    for (const [nid, n] of Object.entries(d.nodes)) {
      for (const s of Array.isArray(n.say) ? n.say : n.say ? [n.say] : [])
        if (!s.startsWith('$') && !knownEvents.has(s)) errs.push(`${id}.${nid}: событие ${s} нет в events.json`);
      for (const t of [...Object.values(n.on ?? {}), ...(n.next ? [n.next] : [])])
        if (!t.startsWith('@') && !d.nodes[t]) errs.push(`${id}.${nid}: переход в несуществующий узел ${t}`);
      if (n.on && !n.listen) errs.push(`${id}.${nid}: есть on, но нет listen`);
    }
  }
  return errs;
}
