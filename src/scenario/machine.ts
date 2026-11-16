/**
 * Автомат первой встречи (чистая функция: состояние + событие → новое состояние + команды).
 * Побочные эффекты (звук, речь, эффекты, таймеры) выполняет director по списку команд.
 */
import type { Intent } from '../voice/intents';
import type { PersonaId } from '../persona/types';

export type Phase =
  | 'start'      // экран «Разбудить кота»
  | 'scanning'   // ждём карту
  | 'appear'     // чавк → хлопок → кот выскакивает
  | 'ask_name'   // «Как тебя зовут?»
  | 'choose'     // два стикера-характера
  | 'play'       // свободное взаимодействие, считаем 3 действия
  | 'free'       // после приглашения в СберKids — играем дальше
  | 'switching'; // экран заклеен стикерами, ждём встряску

export type InteractionKind = 'tap_cat' | 'tap_screen' | 'longpress' | 'swipe' | 'shake' | 'spam' | 'sticker_peel' | 'voice';

export interface ScenarioState {
  phase: Phase;
  interactions: number;
  persona: PersonaId | null;
  name: string | null;
  visits: number;
  outroShown: boolean;
  boredCount: number;
  cardVisible: boolean;
  appeared: boolean;
  switchTo: PersonaId | null;
  resumePhase: Phase | null;
}

export type ScenarioEvent =
  | { type: 'wake' }
  | { type: 'card_found' }
  | { type: 'card_lost' }
  | { type: 'timer'; id: string }
  | { type: 'name'; name: string }
  | { type: 'skip_name' }
  | { type: 'choice_shown' }
  | { type: 'choose'; persona: PersonaId }
  | { type: 'interaction'; kind: InteractionKind }
  | { type: 'intent'; intent: Intent }
  | { type: 'silence' }
  | { type: 'switch_request' }
  | { type: 'covered' }
  | { type: 'shake' };

export type Action =
  | { type: 'say'; key: string; vars?: Record<string, string> }
  | { type: 'react'; event: string }
  | { type: 'intent_reply'; intent: Intent['type'] }
  | { type: 'ui'; ui: 'scan_hint' | 'name_prompt' | 'chips' | 'sberkids' | 'shake_button'; show: boolean }
  | { type: 'timer'; id: string; ms: number }
  | { type: 'cancel_timer'; id: string }
  | { type: 'appear' }
  | { type: 'offer_choice' }
  | { type: 'hide_choice' }
  | { type: 'set_persona'; persona: PersonaId }
  | { type: 'signature' }
  | { type: 'remember'; patch: { name?: string; persona?: PersonaId } }
  | { type: 'cover_stickers'; persona: PersonaId }
  | { type: 'blow_stickers' }
  | { type: 'hold_pose' }
  | { type: 'resume_pose' };

export interface ScenarioConfig {
  personas: PersonaId[];
  defaultPersona: PersonaId;
  appearMs: number;
  nameTimeoutMs: number;
  chooseTimeoutMs: number;
  interactionsToOutro: number;
  outroDelayMs: number;
}

export const defaultScenarioConfig: ScenarioConfig = {
  personas: ['hooligan', 'glitter'],
  defaultPersona: 'hooligan',
  appearMs: 2600,
  nameTimeoutMs: 12000,
  chooseTimeoutMs: 5000,
  interactionsToOutro: 3,
  outroDelayMs: 2200,
};

export function initialState(memory: { name?: string | null; persona?: PersonaId | null; visits?: number } = {}): ScenarioState {
  return {
    phase: 'start',
    interactions: 0,
    persona: memory.persona ?? null,
    name: memory.name ?? null,
    visits: memory.visits ?? 0,
    outroShown: false,
    boredCount: 0,
    cardVisible: false,
    appeared: false,
    switchTo: null,
    resumePhase: null,
  };
}

export interface StepResult { state: ScenarioState; actions: Action[] }

const otherPersona = (cfg: ScenarioConfig, cur: PersonaId | null): PersonaId => {
  const i = cur ? cfg.personas.indexOf(cur) : -1;
  return cfg.personas[(i + 1) % cfg.personas.length];
};

function enterPlay(s: ScenarioState, a: Action[]): ScenarioState {
  a.push({ type: 'ui', ui: 'chips', show: true });
  return { ...s, phase: s.outroShown ? 'free' : 'play' };
}

function startSwitch(s: ScenarioState, cfg: ScenarioConfig, a: Action[]): ScenarioState {
  const to = otherPersona(cfg, s.persona);
  a.push({ type: 'say', key: 'switch_start' }, { type: 'cover_stickers', persona: to }, { type: 'ui', ui: 'chips', show: false });
  return { ...s, phase: 'switching', switchTo: to, resumePhase: s.phase, boredCount: 0 };
}

function choosePersona(s: ScenarioState, p: PersonaId, a: Action[]): ScenarioState {
  a.push(
    { type: 'cancel_timer', id: 'choose_timeout' },
    { type: 'hide_choice' },
    { type: 'set_persona', persona: p },
    { type: 'remember', patch: { persona: p } },
    { type: 'signature' },
    { type: 'say', key: 'invite' },
  );
  return enterPlay({ ...s, persona: p, interactions: 0 }, a);
}

function countInteraction(s: ScenarioState, cfg: ScenarioConfig, a: Action[]): ScenarioState {
  const n = s.interactions + 1;
  if (s.phase === 'play' && !s.outroShown && n >= cfg.interactionsToOutro) a.push({ type: 'timer', id: 'outro', ms: cfg.outroDelayMs });
  return { ...s, interactions: n, boredCount: 0 };
}

export function step(s: ScenarioState, e: ScenarioEvent, cfg: ScenarioConfig = defaultScenarioConfig): StepResult {
  const a: Action[] = [];
  const done = (state: ScenarioState): StepResult => ({ state, actions: a });

  // карта: общая обработка для всех фаз после пробуждения
  if (e.type === 'card_lost') {
    if (!s.cardVisible) return done(s);
    if (s.appeared) a.push({ type: 'hold_pose' }, { type: 'react', event: 'card_lost' });
    return done({ ...s, cardVisible: false });
  }
  if (e.type === 'card_found' && s.phase !== 'scanning') {
    if (s.cardVisible) return done(s);
    if (s.appeared) a.push({ type: 'resume_pose' }, { type: 'react', event: 'card_found' });
    return done({ ...s, cardVisible: true });
  }

  // деньги — из любой фазы после появления: «это к брату!» + кнопка СберKids
  if (e.type === 'intent' && e.intent.type === 'money' && s.appeared && s.phase !== 'switching') {
    a.push({ type: 'cancel_timer', id: 'outro' }, { type: 'react', event: 'money' }, { type: 'ui', ui: 'sberkids', show: true });
    const st = { ...s, outroShown: true };
    if (s.phase === 'play') st.phase = 'free';
    return done(st);
  }

  switch (s.phase) {
    case 'start':
      if (e.type === 'wake') {
        a.push({ type: 'ui', ui: 'scan_hint', show: true });
        return done({ ...s, phase: 'scanning', visits: s.visits + 1 });
      }
      return done(s);

    case 'scanning':
      if (e.type === 'card_found') {
        a.push({ type: 'ui', ui: 'scan_hint', show: false }, { type: 'appear' }, { type: 'timer', id: 'appear_done', ms: cfg.appearMs });
        return done({ ...s, phase: 'appear', cardVisible: true });
      }
      return done(s);

    case 'appear':
      if (e.type === 'timer' && e.id === 'appear_done') {
        const st = { ...s, appeared: true };
        if (s.name && s.persona && s.visits > 1) {
          // повторный визит: узнаём, без анкеты
          a.push({ type: 'set_persona', persona: s.persona }, { type: 'say', key: 'welcome_back', vars: { name: s.name } }, { type: 'signature' });
          return done(enterPlay({ ...st, interactions: 0 }, a));
        }
        a.push({ type: 'say', key: 'intro' }, { type: 'ui', ui: 'name_prompt', show: true }, { type: 'timer', id: 'name_timeout', ms: cfg.nameTimeoutMs });
        return done({ ...st, phase: 'ask_name' });
      }
      return done(s);

    case 'ask_name': {
      let name: string | null = null;
      let skipped = false;
      if (e.type === 'name') name = e.name;
      else if (e.type === 'intent' && e.intent.type === 'name') name = e.intent.name;
      else if (e.type === 'skip_name' || (e.type === 'timer' && e.id === 'name_timeout') || (e.type === 'intent' && (e.intent.type === 'skip' || e.intent.type === 'no'))) skipped = true;
      if (!name && !skipped) return done(s);
      a.push({ type: 'cancel_timer', id: 'name_timeout' }, { type: 'ui', ui: 'name_prompt', show: false });
      if (name) a.push({ type: 'remember', patch: { name } }, { type: 'say', key: 'nice_name', vars: { name } });
      else a.push({ type: 'say', key: 'no_name' });
      a.push({ type: 'say', key: 'choose' }, { type: 'offer_choice' });
      return done({ ...s, phase: 'choose', name: name ?? s.name });
    }

    case 'choose':
      if (e.type === 'choice_shown') {
        a.push({ type: 'timer', id: 'choose_timeout', ms: cfg.chooseTimeoutMs });
        return done(s);
      }
      if (e.type === 'choose') return done(choosePersona(s, e.persona, a));
      if (e.type === 'timer' && e.id === 'choose_timeout') return done(choosePersona(s, cfg.defaultPersona, a));
      if (e.type === 'intent' && e.intent.type === 'switch') return done(choosePersona(s, otherPersona(cfg, cfg.defaultPersona), a));
      return done(s);

    case 'play':
    case 'free':
      if (e.type === 'interaction') {
        a.push({ type: 'react', event: e.kind });
        return done(countInteraction(s, cfg, a));
      }
      if (e.type === 'shake') {
        a.push({ type: 'react', event: 'shake' });
        return done(countInteraction(s, cfg, a));
      }
      if (e.type === 'intent') {
        if (e.intent.type === 'switch') return done(startSwitch(s, cfg, a));
        if (e.intent.type === 'name') {
          a.push({ type: 'remember', patch: { name: e.intent.name } }, { type: 'say', key: 'nice_name', vars: { name: e.intent.name } });
          return done({ ...s, name: e.intent.name });
        }
        a.push({ type: 'intent_reply', intent: e.intent.type });
        return done(countInteraction(s, cfg, a));
      }
      if (e.type === 'switch_request') return done(startSwitch(s, cfg, a));
      if (e.type === 'silence') {
        if (s.boredCount >= 1) return done(startSwitch(s, cfg, a));
        a.push({ type: 'react', event: 'silence' });
        return done({ ...s, boredCount: s.boredCount + 1 });
      }
      if (e.type === 'timer' && e.id === 'outro' && !s.outroShown) {
        a.push({ type: 'say', key: 'outro' }, { type: 'ui', ui: 'sberkids', show: true });
        return done({ ...s, outroShown: true, phase: 'free' });
      }
      return done(s);

    case 'switching':
      if (e.type === 'covered') {
        a.push({ type: 'say', key: 'shake_prompt' }, { type: 'ui', ui: 'shake_button', show: true });
        return done(s);
      }
      if (e.type === 'shake' || (e.type === 'interaction' && e.kind === 'shake')) {
        const p = s.switchTo ?? otherPersona(cfg, s.persona);
        a.push(
          { type: 'ui', ui: 'shake_button', show: false },
          { type: 'blow_stickers' },
          { type: 'set_persona', persona: p },
          { type: 'remember', patch: { persona: p } },
          { type: 'signature' },
          { type: 'say', key: 'hello_new' },
        );
        const back = s.resumePhase === 'play' || s.resumePhase === 'free' ? s.resumePhase : 'play';
        return done(enterPlay({ ...s, persona: p, switchTo: null, resumePhase: null, phase: back }, a));
      }
      return done(s);
  }
  return done(s);
}
