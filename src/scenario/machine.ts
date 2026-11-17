/**
 * Автомат сессии (чистая функция: состояние + событие → новое состояние + команды).
 * Побочные эффекты (речь, звук, эффекты, таймеры, микрофон) выполняет director по списку команд.
 * Многоходовые диалоги (знакомство, «пока?», «к брату?», загадка, повторялка, поддержка) описаны
 * в content/dialogs.json и исполняются движком scenario/dialogs.ts.
 */
import type { PersonaId } from '../persona/types';
import { PERSONA_IDS, isPersonaId } from '../persona/types';
import { answerDialog, isGameMode, resolveTrigger, startDialog, type DialogCmd, type DialogStep, type DialogsFile, type DialogState, type GameItem, type ListenMode } from './dialogs';
import type { ContextEvent } from './session';

export type Phase =
  | 'start'      // экран «Разбудить кота»
  | 'scanning'   // ждём карту
  | 'appear'     // чавк → хлопок → кот выскакивает
  | 'ask_name'   // знакомство: «Как тебя зовут?»
  | 'choose'     // три стикера-характера
  | 'play'       // свободное взаимодействие до outro
  | 'free'       // после outro / приглашения в СберKids — играем дальше
  | 'switching'  // экран заклеен стикерами, ждём встряску
  | 'gone';      // попрощались, кот нырнул в карту

/** tap_cat, tap_cat_head…, tap_screen, double_tap, swipe, longpress, shake, spam, sticker_peel, … (id событий из events.json) */
export type InteractionKind = string;

/** Что услышали: id интента из intents.ru.json (или name / unknown) */
export interface Heard {
  type: string;
  text?: string;
  /** для type=name */
  name?: string;
  /** имя есть в словаре names.ru.txt */
  known?: boolean;
  /** нажата кнопка (панель действий / каталог): явная команда — завершает мини-игру и выполняется */
  button?: boolean;
}

export interface ScenarioState {
  phase: Phase;
  persona: PersonaId | null;
  name: string | null;
  visits: number;
  /** первое знакомство уже было (память): дальше — короткое «с возвращением» */
  met: boolean;
  outroShown: boolean;
  playStarted: boolean;
  boredCount: number;
  unknownStreak: number;
  cardVisible: boolean;
  appeared: boolean;
  switchTo: PersonaId | null;
  resumePhase: Phase | null;
  dialog: DialogState | null;
  /** номер окна ответа: таймаут старого окна игнорируется */
  listenToken: number;
  /** поддержка (грустно/страшно): игра на паузе */
  paused: boolean;
  riddleSeq: number;
  /** мини-игра с выбором (угадай эмоцию, камень-ножницы-бумага, повтори движение): что загадал кот, какой раунд */
  game: GameState | null;
  context: ContextEvent | null;
}

export interface GameState {
  id: string;
  /** что загадал / выбрал кот (id варианта из dialogs.json → games) */
  pick: string | null;
  round: number;
  last: string | null;
}

export type ScenarioEvent =
  | { type: 'wake' }
  | { type: 'card_found' }
  | { type: 'card_lost' }
  | { type: 'timer'; id: string }
  | { type: 'listen_timeout'; token: number }
  | { type: 'name'; name: string; known?: boolean }
  | { type: 'skip_name' }
  | { type: 'choice_shown' }
  | { type: 'choose'; persona: PersonaId }
  | { type: 'interaction'; kind: InteractionKind }
  | { type: 'intent'; intent: Heard }
  | { type: 'answer'; result: 'right' | 'wrong' | 'giveup'; text?: string }
  /** ответ в мини-игре: id варианта (dialogs.json → games), '$giveup' — «не знаю», null — не разобрали */
  | { type: 'game_answer'; value: string | null; text?: string }
  /** тишина: кот сам заговаривает (лестница тишины режиссёра — scenario/initiative.ts) */
  | { type: 'silence'; byCat?: boolean }
  /** кот сам предлагает занятие (по кругу): riddle | echo | dance */
  | { type: 'offer'; what: string }
  | { type: 'switch_request' }
  | { type: 'covered' }
  | { type: 'shake' }
  | { type: 'outro_request' };

export type UiPart = 'scan_hint' | 'name_prompt' | 'chips' | 'sberkids' | 'shake_button' | 'mic';

export type Action =
  /** реплика сценария/диалога (приоритет не ниже 2); node — «диалог.узел» */
  | { type: 'say'; key: string; force?: boolean; node?: string }
  | { type: 'say_riddle'; part: 'q' | 'hint'; node?: string }
  /** реакция на действие ребёнка; quiet — без слов (знакомство, мини-игра: только клип/эмоция) */
  | { type: 'react'; event: string; quiet?: boolean }
  | { type: 'ui'; ui: UiPart; show: boolean }
  | { type: 'timer'; id: string; ms: number }
  | { type: 'cancel_timer'; id: string }
  | { type: 'listen'; mode: ListenMode; ms: number; token: number }
  | { type: 'stop_listen' }
  | { type: 'echo'; text: string }
  | { type: 'appear' }
  | { type: 'offer_choice' }
  | { type: 'hide_choice' }
  | { type: 'set_persona'; persona: PersonaId }
  | { type: 'signature'; silent?: boolean }
  | { type: 'remember'; patch: { name?: string | null; persona?: PersonaId; met?: boolean } }
  /** первое знакомство: палец «погладь меня» и подсвеченная панель действий */
  | { type: 'coach' }
  | { type: 'cover_stickers'; persona: PersonaId }
  | { type: 'blow_stickers' }
  | { type: 'hold_pose' }
  | { type: 'resume_pose' }
  | { type: 'open_sberkids' }
  | { type: 'adult_hint' }
  | { type: 'goodbye' }
  | { type: 'pause'; on: boolean }
  /** мини-игра: кот показывает вариант (эмоцию лицом и клипом, движение — клипом реакции события) — когда договорит */
  | { type: 'game_show'; face?: string; clip?: string; event?: string }
  /** «мне скучно»: кот предлагает следующее занятие по кругу (у какого есть озвученный вопрос — знает режиссёр) */
  | { type: 'offer_next' };

export interface ScenarioConfig {
  dialogs: DialogsFile;
  defaultPersona: PersonaId;
  appearMs: number;
  /** outro через 4–6 минут игры */
  outroMinMs: number;
  outroMaxMs: number;
  /** если в момент outro идёт диалог — отложить */
  outroRetryMs: number;
  random: () => number;
}

export function makeScenarioConfig(dialogs: DialogsFile, o: Partial<Omit<ScenarioConfig, 'dialogs'>> = {}): ScenarioConfig {
  return { dialogs, defaultPersona: 'hooligan', appearMs: 1500, outroMinMs: 4 * 60_000, outroMaxMs: 6 * 60_000, outroRetryMs: 20_000, random: Math.random, ...o };
}

export function initialState(memory: { name?: string | null; persona?: PersonaId | null; visits?: number; met?: boolean } = {}, context: ContextEvent | null = null): ScenarioState {
  return {
    phase: 'start',
    persona: memory.persona ?? null,
    name: memory.name ?? null,
    visits: memory.visits ?? 0,
    met: !!memory.met,
    outroShown: false,
    playStarted: false,
    boredCount: 0,
    unknownStreak: 0,
    cardVisible: false,
    appeared: false,
    switchTo: null,
    resumePhase: null,
    dialog: null,
    listenToken: 0,
    paused: false,
    riddleSeq: 0,
    game: null,
    context,
  };
}

export interface StepResult { state: ScenarioState; actions: Action[] }

export const nextPersona = (cur: PersonaId | null): PersonaId => PERSONA_IDS[(cur ? PERSONA_IDS.indexOf(cur) + 1 : 0) % PERSONA_IDS.length];

const isPlay = (p: Phase) => p === 'play' || p === 'free';

/** ответ на n-ю непонятую фразу подряд: unknown (переспросить) или help («я пока умею…») */
export const unknownReply = (n: number): 'unknown' | 'help' => (n % 2 === 0 ? 'help' : 'unknown');

/* ───────── переходы ───────── */

function enterPlay(s: ScenarioState, cfg: ScenarioConfig, a: Action[]): ScenarioState {
  a.push({ type: 'ui', ui: 'chips', show: true });
  if (!s.playStarted && !s.outroShown) a.push({ type: 'timer', id: 'outro', ms: Math.round(cfg.outroMinMs + cfg.random() * (cfg.outroMaxMs - cfg.outroMinMs)) });
  return { ...s, phase: s.outroShown ? 'free' : 'play', playStarted: true };
}

function stopDialog(s: ScenarioState, a: Action[]): ScenarioState {
  if (!s.dialog) return s;
  a.push({ type: 'stop_listen' });
  return { ...s, dialog: null, game: null };
}

/* ───────── мини-игры с выбором (dialogs.json → games) ───────── */

const gameDef = (cfg: ScenarioConfig, id: string | undefined) => (id ? cfg.dialogs.games?.[id] : undefined);
const gameItem = (cfg: ScenarioConfig, game: string | undefined, item: string | null | undefined): GameItem | undefined =>
  item ? gameDef(cfg, game)?.items.find((i) => i.id === item) : undefined;
/** вариант игры по интенту ребёнка (повтори движение: «прыгни» или кнопка «Прыгни» → jump) */
export const gameItemByIntent = (cfg: ScenarioConfig, game: string | undefined, intent: string): GameItem | undefined =>
  gameDef(cfg, game)?.items.find((i) => i.id === intent || i.intents?.includes(intent));

/** ключ ответа узла игры: right/wrong/done (эмоция, движение), win/lose/draw (камень-ножницы-бумага — для ребёнка), giveup */
export function gameKey(cfg: ScenarioConfig, g: GameState, value: string | null): string {
  if (value === '$giveup') return 'giveup';
  const def = gameDef(cfg, g.id);
  if (!def || !value || !gameItem(cfg, g.id, value)) return 'wrong';
  if (g.id === 'rps') {
    if (value === g.pick) return 'draw';
    return gameItem(cfg, g.id, value)!.beats === g.pick ? 'win' : 'lose';
  }
  if (value !== g.pick) return 'wrong';
  return def.rounds && g.round >= def.rounds ? 'done' : 'right';
}

function gameAnswer(s: ScenarioState, value: string | null, text: string, cfg: ScenarioConfig, a: Action[]): ScenarioState {
  const dlg = s.dialog;
  if (!dlg?.listening || !isGameMode(dlg.listening) || !s.game) return s;
  let key = gameKey(cfg, s.game, value);
  // узел не ждёт «done» (повторный показ) — это просто «верно»
  if (key === 'done' && !expects(cfg, dlg, 'done')) key = 'right';
  const r = answerDialog(cfg.dialogs, dlg, key);
  return r ? runDialog({ ...s, unknownStreak: 0 }, r, cfg, a, text) : s;
}

function startSwitch(s: ScenarioState, a: Action[], to: PersonaId = nextPersona(s.persona)): ScenarioState {
  s = stopDialog(s, a);
  a.push({ type: 'say', key: 'switch_start', force: true }, { type: 'cover_stickers', persona: to }, { type: 'ui', ui: 'chips', show: false });
  return { ...s, phase: 'switching', switchTo: to, resumePhase: isPlay(s.phase) ? s.phase : 'play', boredCount: 0 };
}

function choosePersona(s: ScenarioState, p: PersonaId, cfg: ScenarioConfig, a: Action[]): ScenarioState {
  s = stopDialog(s, a);
  a.push(
    { type: 'hide_choice' },
    { type: 'ui', ui: 'name_prompt', show: false },
    { type: 'set_persona', persona: p },
    { type: 'remember', patch: { persona: p } },
    { type: 'say', key: `choose_${p}`, force: true },
    { type: 'signature' },
    { type: 'say', key: 'invite', force: true },
  );
  return enterPlay({ ...s, persona: p }, cfg, a);
}

function doAction(s: ScenarioState, action: string, arg: string | undefined, heardText: string, cfg: ScenarioConfig, a: Action[]): ScenarioState {
  switch (action) {
    case 'name_prompt':
      a.push({ type: 'ui', ui: 'name_prompt', show: true });
      return s;
    case 'hide_name':
      a.push({ type: 'ui', ui: 'name_prompt', show: false });
      return s;
    case 'coach':
      a.push({ type: 'coach' });
      return s;
    case 'met': {
      // знакомство закончилось: запоминаем (один раз), дальше — обычная жизнь
      const p = s.persona ?? cfg.defaultPersona;
      a.push({ type: 'ui', ui: 'name_prompt', show: false }, { type: 'remember', patch: { met: true, persona: p } });
      return enterPlay({ ...s, met: true, persona: p }, cfg, a);
    }
    case 'offer_choice':
      a.push({ type: 'ui', ui: 'name_prompt', show: false }, { type: 'offer_choice' });
      return { ...s, phase: 'choose' };
    case 'riddle_next':
      return { ...s, riddleSeq: s.riddleSeq + 1 };
    case 'game':
      // начало мини-игры: «game:rps»
      return gameDef(cfg, arg) ? { ...s, game: { id: arg!, pick: null, round: 0, last: null } } : s;
    case 'game_next': {
      // кот загадывает следующий вариант — не тот же, что в прошлый раз
      const def = gameDef(cfg, s.game?.id);
      if (!def || !s.game) return s;
      const pool = def.items.length > 1 ? def.items.filter((i) => i.id !== s.game!.pick) : def.items;
      const it = pool[Math.min(pool.length - 1, Math.floor(cfg.random() * pool.length))];
      return { ...s, game: { ...s.game, pick: it.id, last: s.game.pick, round: s.game.round + 1 } };
    }
    case 'game_show': {
      const it = gameItem(cfg, s.game?.id, s.game?.pick);
      if (it) a.push({ type: 'game_show', ...(it.face ? { face: it.face } : {}), ...(it.clip ? { clip: it.clip } : {}), ...(it.event ? { event: it.event } : {}) });
      return s;
    }
    case 'pause_play': {
      a.push({ type: 'pause', on: true }, { type: 'timer', id: 'pause_end', ms: Number(arg) || 10_000 });
      return { ...s, paused: true };
    }
    case 'adult_hint':
      a.push({ type: 'adult_hint' });
      return s;
    case 'echo':
      if (heardText) a.push({ type: 'echo', text: heardText });
      return s;
    case 'choose':
      return choosePersona(s, isPersonaId(arg) ? arg : s.persona ?? cfg.defaultPersona, cfg, a);
    case 'goodbye':
      a.push({ type: 'goodbye' }, { type: 'ui', ui: 'chips', show: false }, { type: 'cancel_timer', id: 'outro' });
      return { ...s, phase: 'gone', appeared: false };
    case 'open_sberkids':
      a.push({ type: 'ui', ui: 'sberkids', show: true }, { type: 'open_sberkids' });
      return s;
    case 'show_kids':
      a.push({ type: 'ui', ui: 'sberkids', show: true });
      return s;
    case 'dialog': {
      // «@dialog:riddle:ask» — кот предложил занятие, ребёнок согласился: запускаем мини-игру
      const [id, node] = (arg ?? '').split(':');
      if (!cfg.dialogs.dialogs[id]) return s;
      return runDialog({ ...s, dialog: null }, startDialog(cfg.dialogs, id, node), cfg, a, heardText);
    }
    case 'react':
      if (arg) a.push({ type: 'react', event: arg });
      return s;
  }
  return s;
}

function runDialog(s: ScenarioState, r: DialogStep, cfg: ScenarioConfig, a: Action[], heardText = ''): ScenarioState {
  let st: ScenarioState = { ...s, dialog: r.state };
  for (const c of r.cmds as DialogCmd[]) {
    if (c.type === 'say') {
      if (c.event === '$riddle.q') a.push({ type: 'say_riddle', part: 'q', node: c.node });
      else if (c.event === '$riddle.hint') a.push({ type: 'say_riddle', part: 'hint', node: c.node });
      // «Это была радость!», «У меня камень!» — реплика про загаданный котом вариант
      else if (c.event === '$game.reveal') {
        if (st.game?.pick) a.push({ type: 'say', key: `${st.game.id}_is_${st.game.pick}`, force: true, node: c.node });
      }
      else a.push({ type: 'say', key: c.event, force: true, node: c.node });
    } else if (c.type === 'listen') {
      const token = st.listenToken + 1;
      a.push({ type: 'listen', mode: c.mode, ms: c.ms, token });
      st = { ...st, listenToken: token };
    } else if (c.type === 'do') {
      st = doAction(st, c.action, c.arg, heardText, cfg, a);
    } else if (c.type === 'end') {
      a.push({ type: 'stop_listen' });
      if (c.action) st = doAction({ ...st, dialog: null }, c.action, c.arg, heardText, cfg, a);
    }
  }
  return st;
}

function triggerDialog(s: ScenarioState, intent: string, cfg: ScenarioConfig, a: Action[]): ScenarioState | null {
  const t = resolveTrigger(cfg.dialogs, intent);
  if (!t) return null;
  s = stopDialog(s, a);
  return runDialog(s, startDialog(cfg.dialogs, t.id, t.node), cfg, a);
}

/** ключ ответа для узла: name / right / … / интент */
function answerKey(h: Heard, mode: ListenMode): string {
  if (h.type === 'name' && mode === 'name') return 'name';
  if (mode === 'riddle' && ['giveup', 'no', 'skip'].includes(h.type)) return 'giveup';
  if (mode === 'echo') return h.type === 'echo_stop' ? 'echo_stop' : '*';
  if (isGameMode(mode) && ['giveup', 'no', 'skip'].includes(h.type)) return 'giveup';
  return h.type;
}

/** узел явно ждёт этот ответ */
function expects(cfg: ScenarioConfig, d: DialogState, key: string) {
  return !!cfg.dialogs.dialogs[d.id]?.nodes[d.node]?.on?.[key];
}

function onHeard(s: ScenarioState, h: Heard, cfg: ScenarioConfig, a: Action[]): ScenarioState {
  // безопасность — всегда первой, прерывает любой диалог
  if (cfg.dialogs.interrupts.includes(h.type)) return triggerDialog({ ...s, unknownStreak: 0 }, h.type, cfg, a) ?? s;
  // «Повтори движение»: кнопка движения («Прыгни», «Сальто»…) — это ответ, а не конец игры
  if (s.dialog?.listening === 'simon' && s.game && gameItemByIntent(cfg, 'simon', h.type)) return gameAnswer(s, gameItemByIntent(cfg, 'simon', h.type)!.id, h.text ?? '', cfg, a);
  // кнопка — явная команда: мини-игра (загадка, повторялка, предложение кота) заканчивается, команда выполняется.
  // Не «неверный ответ» загадке и не фраза для повторялки. Знакомство кнопками не прерывается.
  if (h.button && s.dialog && s.dialog.id !== 'intro') s = stopDialog(s, a);
  if (h.button && s.dialog?.id === 'intro') return s;
  if (s.dialog?.listening) {
    const dlg = s.dialog;
    const mode = dlg.listening!;
    const key = answerKey(h, mode);
    // другой диалог перебивает текущий, если текущий этого ответа явно не ждёт («пока» посреди загадки)
    if (mode !== 'echo' && !expects(cfg, dlg, key) && resolveTrigger(cfg.dialogs, h.type) && dlg.id !== 'intro') {
      return triggerDialog(s, h.type, cfg, a) ?? s;
    }
    // вопрос «да/нет» («Хочешь загадку?», «Ещё одну?»), а ребёнок сказал другое («танцуй») — вопрос снимается,
    // фраза выполняется как обычно (а не теряется в «*» → конец диалога)
    const star = cfg.dialogs.dialogs[dlg.id]?.nodes[dlg.node]?.on?.['*'];
    if (mode === 'intent' && !expects(cfg, dlg, key) && (!star || star === '@end') && h.type !== 'unknown') {
      s = stopDialog(s, a);
      return onHeard(s, h, cfg, a);
    }
    // мини-игра с выбором: ответ голосом director присылает событием game_answer; интент здесь — «не знаю» или «не то»
    if (isGameMode(mode)) {
      const it = s.game ? gameItemByIntent(cfg, s.game.id, h.type) : undefined;
      return gameAnswer(s, key === 'giveup' ? '$giveup' : it?.id ?? null, h.text ?? '', cfg, a);
    }
    if (h.type === 'name' && h.known) {
      a.push({ type: 'remember', patch: { name: h.name } });
      s = { ...s, name: h.name! };
    }
    // ответ на загадку director присылает событием answer; интент здесь — значит «не то»
    const r = answerDialog(cfg.dialogs, dlg, mode === 'riddle' && key !== 'giveup' ? 'wrong' : key);
    if (r) return runDialog({ ...s, unknownStreak: 0 }, r, cfg, a, h.text ?? '');
  }
  if (s.phase === 'ask_name' || s.phase === 'choose') return s;
  if (!isPlay(s.phase)) return s;
  if (s.paused) return s; // во время поддержки — без игры
  const d = triggerDialog(s, h.type, cfg, a);
  if (d) return { ...d, unknownStreak: 0 };
  const t = h.type;
  if (t === 'change_persona') return startSwitch(s, a);
  if (t.startsWith('choose_')) {
    const p = t.slice(7);
    if (!isPersonaId(p)) return s;
    a.push({ type: 'say', key: t });
    if (p === s.persona) return s;
    return startSwitch(s, a, p);
  }
  if (t === 'name' && h.name) {
    if (h.known) a.push({ type: 'remember', patch: { name: h.name } });
    a.push({ type: 'say', key: 'nice_name' });
    return { ...s, name: h.known ? h.name : s.name };
  }
  if (t === 'unknown') {
    // не понял: 1-й раз — переспросить, 2-й — «я пока умею…» с 2–3 командами и кнопками-подсказками,
    // дальше по очереди (варианты реплик не повторяются — picker), чтобы не звучало одно и то же
    const n = s.unknownStreak + 1;
    a.push({ type: 'react', event: unknownReply(n) });
    if (n >= 2) a.push({ type: 'ui', ui: 'chips', show: true });
    return { ...s, unknownStreak: n };
  }
  // «мне скучно» — кот не только подсказывает, а сразу предлагает занятие (по кругу, как в лестнице тишины)
  if (t === 'bored') {
    a.push({ type: 'offer_next' });
    return { ...s, unknownStreak: 0 };
  }
  // «да»/«нет» на реплику-вопрос вне диалога («Может, постучать тебе в экран?» — «давай») — короткий ответ
  if (t === 'yes' || t === 'no' || t === 'giveup') {
    a.push({ type: 'react', event: t === 'yes' ? 'yes' : 'no' });
    return { ...s, unknownStreak: 0 };
  }
  a.push({ type: 'react', event: t });
  return { ...s, unknownStreak: 0, boredCount: 0 };
}

export function step(s: ScenarioState, e: ScenarioEvent, cfg: ScenarioConfig): StepResult {
  const a: Action[] = [];
  const done = (state: ScenarioState): StepResult => ({ state, actions: a });

  // карта: общая обработка для всех фаз после пробуждения
  if (e.type === 'card_lost') {
    if (!s.cardVisible) return done(s);
    if (s.appeared) a.push({ type: 'hold_pose' }, { type: 'react', event: 'card_lost' });
    return done({ ...s, cardVisible: false });
  }
  if (e.type === 'card_found' && s.phase !== 'scanning' && s.phase !== 'gone') {
    if (s.cardVisible) return done(s);
    if (s.appeared) a.push({ type: 'resume_pose' }, { type: 'react', event: 'card_found' });
    return done({ ...s, cardVisible: true });
  }

  // окно ответа закончилось
  if (e.type === 'listen_timeout') {
    if (!s.dialog?.listening || e.token !== s.listenToken) return done(s);
    const r = answerDialog(cfg.dialogs, s.dialog, 'timeout');
    return done(r ? runDialog(s, r, cfg, a) : s);
  }
  if (e.type === 'answer') {
    if (s.dialog?.listening !== 'riddle') return done(s);
    const r = answerDialog(cfg.dialogs, s.dialog, e.result);
    return done(r ? runDialog(s, r, cfg, a, e.text ?? '') : s);
  }
  if (e.type === 'game_answer') return done(gameAnswer(s, e.value, e.text ?? '', cfg, a));
  if (e.type === 'timer' && e.id === 'pause_end') {
    a.push({ type: 'pause', on: false });
    return done({ ...s, paused: false });
  }

  // голос из любой фазы после появления
  if (e.type === 'intent' && s.appeared && s.phase !== 'switching') return done(onHeard(s, e.intent, cfg, a));

  switch (s.phase) {
    case 'start':
      if (e.type === 'wake') {
        a.push({ type: 'ui', ui: 'scan_hint', show: true }, { type: 'remember', patch: {} });
        return done({ ...s, phase: 'scanning', visits: s.visits + 1 });
      }
      return done(s);

    case 'scanning':
      if (e.type === 'card_found') {
        a.push({ type: 'ui', ui: 'scan_hint', show: false }, { type: 'appear' }, { type: 'timer', id: 'appear_done', ms: cfg.appearMs });
        return done({ ...s, phase: 'appear', cardVisible: true });
      }
      return done(s);

    case 'gone':
      if (e.type === 'card_found' || e.type === 'interaction' || e.type === 'wake') {
        a.push({ type: 'appear' }, { type: 'timer', id: 'appear_done', ms: cfg.appearMs });
        return done({ ...s, phase: 'appear', cardVisible: true, visits: Math.max(s.visits, 2) });
      }
      return done(s);

    case 'appear':
      if (e.type === 'timer' && e.id === 'appear_done') {
        const st = { ...s, appeared: true };
        if (s.met) {
          // уже знакомы: короткое «с возвращением, <имя>!» и трюк без слов — сразу играть.
          // Из контекста — только «давно не виделись» (утро/вечер — лишняя реплика перед игрой)
          if (s.persona) a.push({ type: 'set_persona', persona: s.persona });
          // одна тёплая реплика: «давно не виделись» вместо «с возвращением», а не обе подряд
          a.push({ type: 'say', key: s.context === 'long_absence' ? 'long_absence' : 'welcome_back', force: true }, { type: 'signature', silent: true });
          return done(enterPlay(st, cfg, a));
        }
        // первое знакомство (один раз): карта → поздравление и привет → имя → «я — …» → как играть (dialogs.json → intro)
        return done(runDialog({ ...st, phase: 'ask_name' }, startDialog(cfg.dialogs, 'intro'), cfg, a));
      }
      return done(s);

    case 'ask_name':
    case 'choose': {
      if (e.type === 'choose') return done(choosePersona(s, e.persona, cfg, a));
      if (e.type === 'name') return done(onHeard(s, { type: 'name', name: e.name, known: e.known ?? false, text: e.name }, cfg, a));
      if (e.type === 'skip_name') return done(onHeard(s, { type: 'skip' }, cfg, a));
      if (e.type === 'interaction') {
        // знакомство идёт по шагам: касание — клип и эмоция, без слов (иначе реакция перебьёт и потеряет шаг)
        a.push({ type: 'react', event: e.kind, quiet: true });
        return done(s);
      }
      return done(s);
    }

    case 'play':
    case 'free':
      if (e.type === 'interaction' || e.type === 'shake') {
        const kind = e.type === 'shake' ? 'shake' : e.kind;
        if (s.paused) return done(s);
        // мини-игра (загадка, повторялка, вопрос кота): касание не перебивает её словами — только клип и эмоция
        if (s.dialog) a.push({ type: 'react', event: kind === 'double_tap' ? 'double_tap' : kind, quiet: true });
        else if (kind === 'double_tap') a.push({ type: 'signature' });
        else a.push({ type: 'react', event: kind });
        return done({ ...s, boredCount: 0 });
      }
      if (e.type === 'switch_request') return done(startSwitch(s, a));
      // выбор характера листом (debug, старый поток) уже в игре — сразу, без заклеивания экрана
      if (e.type === 'choose') return done(e.persona === s.persona ? s : choosePersona(s, e.persona, cfg, a));
      if (e.type === 'silence') {
        // тишина: кот зовёт поиграть и подсказывает, что можно делать. Экран наклейками сам не заклеивает —
        // смена образа только по просьбе ребёнка (кнопка «Другой кот», «давай другого», встряска наклеек)
        if (s.paused || s.dialog) return done(s);
        a.push({ type: 'react', event: s.boredCount >= 1 ? 'bored' : 'silence' }, { type: 'ui', ui: 'chips', show: true });
        return done({ ...s, boredCount: s.boredCount + 1 });
      }
      if (e.type === 'offer') {
        // кот сам предлагает занятие: «Хочешь загадку?» → да — мини-игра, нет/тишина — дальше свободная игра
        if (s.paused || s.dialog || !cfg.dialogs.dialogs.offer?.nodes[e.what]) return done(s);
        a.push({ type: 'ui', ui: 'chips', show: true });
        return done(runDialog(s, startDialog(cfg.dialogs, 'offer', e.what), cfg, a));
      }
      if ((e.type === 'timer' && e.id === 'outro') || e.type === 'outro_request') {
        if (s.outroShown && e.type === 'timer') return done(s);
        if (s.dialog && e.type === 'timer') {
          a.push({ type: 'timer', id: 'outro', ms: cfg.outroRetryMs });
          return done(s);
        }
        const st = stopDialog(s, a);
        a.push({ type: 'cancel_timer', id: 'outro' }, { type: 'say', key: 'outro', force: true }, { type: 'ui', ui: 'sberkids', show: true });
        return done({ ...st, outroShown: true, phase: 'free' });
      }
      return done(s);

    case 'switching':
      if (e.type === 'covered') {
        a.push({ type: 'say', key: 'shake_prompt', force: true }, { type: 'ui', ui: 'shake_button', show: true });
        return done(s);
      }
      if (e.type === 'shake' || (e.type === 'interaction' && e.kind === 'shake')) {
        const p = s.switchTo ?? nextPersona(s.persona);
        a.push(
          { type: 'ui', ui: 'shake_button', show: false },
          { type: 'blow_stickers' },
          { type: 'set_persona', persona: p },
          { type: 'remember', patch: { persona: p } },
          // трюк без слов: новый образ здоровается одной репликой, а не двумя подряд
          { type: 'signature', silent: true },
          { type: 'say', key: 'hello_new', force: true },
        );
        const back = s.resumePhase && isPlay(s.resumePhase) ? s.resumePhase : 'play';
        return done(enterPlay({ ...s, persona: p, switchTo: null, resumePhase: null, phase: back }, cfg, a));
      }
      return done(s);
  }
  return done(s);
}
