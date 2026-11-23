/**
 * Director — «режиссёр»: принимает события (ввод, трекер, голос), прогоняет через автомат сценария
 * и исполняет команды: реплики, звуки, эффекты, клипы, интерфейс, таймеры, окна ответа микрофона.
 * Кто сейчас кот — знает только PersonaContext: реплики, голос, idle, трюк, наклейки берутся оттуда.
 */
import { feature } from './config/edition';
import * as THREE from 'three';
import { Emitter } from './core/emitter';
import { initialState, makeScenarioConfig, step, type Action, type Heard, type ScenarioConfig, type ScenarioEvent, type ScenarioState, type InteractionKind } from './scenario/machine';
import { clearMemory, loadMemory, saveMemory } from './scenario/memory';
import { contextEvent } from './scenario/session';
import { answerMatches } from './scenario/intentMatch';
import { matchIntent, normalize } from './voice/intents';
import { turn } from './voice/turn';
import { IdleLadder, OFFERS, type IdleStep } from './scenario/initiative';
import { isGameMode, resolveTrigger, type GameItem, type ListenMode } from './scenario/dialogs';
import { gameItemByIntent } from './scenario/machine';
import type { ContentBundle } from './persona/content';
import { PersonaContext } from './persona/context';
import { LineQueue } from './persona/lineQueue';
import type { PickedLine } from './persona/picker';
import type { ContentLine, FxName, PersonaId, Riddle } from './persona/types';
import { isPersonaId, PERSONA_IDS } from './persona/types';
import { runtimeClip, runtimeFx, runtimeSound } from './persona/runtimeMap';
import { CLIPS, type Character, type Emote } from './character/types';
import { meshyChain, meshyUpgrade, resolveClip } from './character/clips';
import type { Stage } from './stage';
import type { FxLayer } from './fx/fxLayer';
import type { Audio } from './audio/audio';
import type { VoicePlayer, SpeakRequest } from './voice/voicePlayer';
import type { UI } from './ui/ui';
import type { Tracker } from './tracker/types';
import { ASSETS } from './config';
import { rand } from './core/util';
import { emotionFor } from './character/emotions';
import { ACTION_ROUTE, SLEEP_WAKE_MS, isActionId, type ActionId } from './scenario/actions';
import { track } from './analytics';
import { LineDedupe, Orchestrator } from './scenario/orchestrator';
import { RIDE_FROM, RIDE_TO } from './character/skateTiming';

export type DirectorEvents = {
  log: string; phase: string; persona: PersonaId; game: { id: string; start: boolean }; named: boolean;
  /** реплика пошла (звук слышен) — пузырь показан в этот момент */
  line_start: { id: string; at: number };
  /** смена кота кончилась: changed — кот другой (false — отменили «нет» / сменили на того же) */
  switch_done: { changed: boolean };
};

export interface DirectorDeps {
  tracker: Tracker;
  stage: Stage;
  fx: FxLayer;
  audio: Audio;
  voice: VoicePlayer;
  ui: UI;
  content: ContentBundle;
  glCanvas: HTMLCanvasElement;
  size: () => { w: number; h: number };
  /** открыть микрофон на ms (окно ответа после вопроса кота) */
  /** mode — какой ответ ждём ('echo' — режим повтора: VoiceEngine пишет звук без распознавания) */
  listen?: (ms: number, mode?: string) => void;
  stopListen?: () => void;
  /** узел диалога ждёт ответа (до того, как кот договорил): VoiceEngine.expect — «да»/«сдаюсь» не шум */
  expect?: (ms: number, mode?: string) => void;
  /** голосовой вход: asr — модель есть или грузится, ready — уже в памяти, mic — доступ не запрещён (VoiceEngine) */
  voiceIn?: () => { asr: boolean; ready: boolean; mic: boolean };
  /** дождаться готовности распознавания не дольше ms (false — модели нет / не успела) */
  whenAsrReady?: (ms: number) => Promise<boolean>;
  /** заполняется сам: для старых вкладок debug, читающих d.personas */
  personas?: ContentBundle['personas'];
  /**
   * Сцена пробуждения кота из карты (src/awake): свечение карты, столб света, кот выпрыгивает, салют и фанфары.
   * play → через сколько мс сценарий идёт дальше. Нет — старое появление (хлопок, конфетти).
   */
  awake?: { play(persona: PersonaId, kind: 'first' | 'short'): number };
}

/** эмоции новых событий (знакомство, угощение), которых ещё нет в character/emotions.ts */
const EXTRA_EMOTION: Record<string, [string, number, number]> = {
  meet_card: ['surprised', 1, 1500], meet_congrats: ['happy', 1, 1800], meet_self: ['happy', 0.9, 1500], meet_skills: ['happy', 0.8, 1500],
  treat: ['happy', 1, 2200], welcome_back: ['happy', 1, 1600], help: ['happy', 0.7, 1200],
  // каталог «Что умеет кот»: удивить (хлоп), подразнить, засмущать
  clap: ['surprised', 1, 1300], compliment: ['shy', 1, 2600], surprise: ['surprised', 1, 1500], tease: ['pout', 1, 1800],
  // частые вопросы ребёнка и мини-игры (emo_ask / emo_wrong / simon_ask — без эмоции: лицо показывает загаданное)
  friend: ['shy', 1, 2600], friends: ['happy', 0.9, 1600], likes: ['happy', 1, 1600], where_live: ['happy', 0.8, 1400], how_are_you: ['happy', 1, 1500], tale: ['happy', 0.7, 2500],
  emo_right: ['laugh', 0.9, 1500], simon_right: ['happy', 1, 1200], simon_done: ['laugh', 1, 1800], rps_win: ['pout', 0.8, 1500], rps_lose: ['smug', 1, 1500], rps_draw: ['surprised', 1, 1200], game_bye: ['happy', 0.8, 1200],
};

/**
 * Эффекты, которые закрывают экран (туман, снежный шар, жвачка на стекле, наклейки, конфетти…): только сразу после
 * действия ребёнка и не чаще раза в COVER_GAP_MS. Сами по себе (мысли вслух, приветствие, тишина) — нет.
 */
/** взрывы блёсток/конфетти по кнопке — у лап кота, а не у морды */
const BURST_FX = new Set(['glitter_burst', 'confetti', 'skate_sparks']);
const COVER_FX = new Set(['snow_globe', 'steam', 'steam_draw', 'steam_heart', 'kiss_print', 'glass_cat', 'gum_splat', 'glitch', 'confetti', 'tag_spray', 'stickers_cover', 'holo_shine']);
const COVER_GAP_MS = 10_000;
const USER_ACT_MS = 2500;
const CARD_LOST_SAY_MS = 1500;
/** карта в кадре и проверяется — «где карта?» не раньше этого (мс после пропажи) */
const CARD_LOST_WAIT_MS = 8000;
/**
 * Хаотичные тапы (docs/qa/CHAOS.md, docs/qa/BUGS.md № 19–20): тап пальцем по коту / мимо, пока кот ещё произносит
 * реплику на прошлый тап (< TAP_LINE_HOLD_MS), — без новой реплики (эмоция и звук — да): иначе 10–15 тапов в секунду
 * давали стаккато «Ха- Ой- Хв-» по 70 мс. Клип реакции меняется не чаще раза в TAP_CLIP_HOLD_MS (кот не дёргается).
 * spam, poke_combo, поглаживание и кнопки — без задержки.
 */
const TAP_RE = /^(tap_cat|tap_screen)/;
const TAP_LINE_HOLD_MS = 900;
const TAP_CLIP_HOLD_MS = 350;
/** петли, которые держатся законно: сон, ходьба, покой, мурчание (его снимает stroke_end); остальные петли реакций — до конца реплики */
const LOOP_KEEP = /^(idle|sleep_loop|walk|run|purr_stroke)/;
const LOOP_MAX_MS = 3000;
/** «Погладить»/«Обнять» кнопкой: столько мурчит, потом покой */
const BUTTON_PURR_MS = 3200;
/**
 * Фирменное действие кнопкой (скейт, какао, зеркальце) — у событий skate / cocoa / mirror реплик нет («без слов»,
 * content/events.json), и кот выполнял их молча (E2E 22.11: выглядит мёртво). Говорит уже записанную реплику близкого
 * события — новых записей нет: нет записи на сервере — молчит, как раньше (perform: «нет записи — пропуск»).
 * at — доля длины действия: какао — после глотка (рот не занят кружкой), скейт и зеркальце — в начале.
 */
export const ACT_VOICE: Record<string, { ids: readonly string[]; at: number }> = {
  skate: { ids: ['hooligan.filler.06', 'hooligan.how_are_you.02'], at: 0 },
  cocoa: { ids: ['kind.home_cocoa.01', 'kind.home_cocoa.02'], at: 0.8 },
  mirror: { ids: ['glitter.silence.02'], at: 0 },
};
/**
 * Запись реплики ещё не декодирована: реакция и пузырь ждут её не дольше (дальше — реакция сразу, пузырь всё равно
 * по старту звука). Прогрев (app.ts warmVoice) держит записи ближайших действий готовыми — обычно ожидания нет.
 */
export const VOICE_WARM_WAIT_MS = 300;
const DANCE_MAX_MS = 8000;
/** реплика зовёт ребёнка говорить — без микрофона не звучит (speakEvent); события тишины и подсказок */
const SAY_INVITE = /(^|[\s«"(])(скажи|скажешь|говори|повторяй за мной|спроси)(?=[\s,.!?»"]|$)/i;
/** зовёт в повторялку (в пилоте её нет, feature games.echo) */
const ECHO_INVITE = /повторя(й|лк|ть)|повторю/i;
const INVITE_EVENTS = new Set(['silence', 'bored', 'filler', 'help']);

/** панель действий и каталог «Что умеет кот»: кнопка → событие режиссёра (таблица — scenario/actions.ts) */
export { ACTIONS, type ActionId } from './scenario/actions';

/** пресет лица (face.json) → простая эмоция текущих персонажей */
const FACE_EMOTE: Record<string, Emote> = { happy: 'happy', excited: 'happy', proud: 'smirk', smirk: 'smirk', wink: 'wink', annoyed: 'angry', offended: 'angry' };

export class Director extends Emitter<DirectorEvents> {
  state: ScenarioState;
  character!: Character;
  readonly personas: PersonaContext;
  readonly queue: LineQueue;
  readonly cfg: ScenarioConfig;
  private timers = new Map<string, number>();
  private listenTimer = 0;
  /**
   * Поворот к зрителю на месте (stage.turnErr > 25°): клип Meshy turn_step (переступает), пока не довернулся; без клипа —
   * как было (сцена поворачивает кота в idle).
   */
  private turnStep(playing: boolean) {
    const ch = this.character;
    if (!ch) return;
    const e = (this.d.stage as { turnErr?: number }).turnErr ?? 0;
    if (ch.currentClip === 'turn_step') {
      if (e < 0.1 || this.d.stage.walking || !playing) ch.play('idle');
      return;
    }
    if (!playing || this.dozing || e < 0.44 || ch.currentClip !== 'idle' || this.d.stage.walking) return;
    const clip = meshyUpgrade('code:stage.turn', undefined, this.persona.id, (id) => this.isMeshy(id));
    if (clip) ch.play(clip, { loop: true });
  }

  /** лестница тишины: что кот делает сам, пока ребёнок ничего не делает (scenario/initiative.ts, docs/scenario/LOGIC.md) */
  readonly ladder = new IdleLadder(performance.now());
  /** кот дремлет (сам после долгой тишины или кнопкой «Усыпи»): молчит, первое касание будит */
  dozing = false;
  /** какое занятие кот предложит следующим (по кругу OFFERS) */
  private offerIdx = 0;
  /** когда кот договорил последнюю реплику */
  private lastCatEnd = -1e9;
  private dialogStartedAt = 0;
  /** карта пропала: «где карта?» — только если её нет дольше CARD_LOST_SAY_MS; «вот она» — только после «где карта?» */
  private cardLostTimer = 0;
  private cardLostSaid = false;
  private idleT = 0;
  private blinkT = 0;
  private lostTimer = 0;
  private lastSwipe: { x: number; y: number } | null = null;
  private busyUntil = 0;
  private paused = false;
  private ctx: { x?: number; y?: number; from?: { x: number; y: number }; path?: { x: number; y: number }[] } = {};
  /** последнее касание экрана (жвачка липнет к стеклу только сразу после тапа по стеклу) */
  private lastTouch: { kind: string; at: number } | null = null;
  /** последнее действие ребёнка (касание, голос, кнопка) и последний «закрывающий экран» эффект */
  private lastUserAct = -1e9;
  private lastCoverAt = -1e9;
  private coachTimer = 0;
  /** обучалка ждёт реплику meet_skills (палец и панель — вместе с «погладь меня…», а не раньше) */
  private coachPending = false;
  /** ?synth — разрешить синтез браузера для неозвученных реплик (по умолчанию: есть озвучка — без синтеза, только пузырь) */
  private allowSynth = typeof location !== 'undefined' && new URLSearchParams(location.search).has('synth');
  /** идёт обработка тапа пальцем (не кнопки): реакции действует удержание TAP_*_HOLD_MS */
  private fingerTap = false;
  private fromButton = false;
  /** кнопка, которая сейчас обрабатывается (Director.action): клип Meshy «action:<id>» (Почесать → scratch_enjoy) */
  private curAction: string | null = null;
  private chainTimer = 0;
  /**
   * Оркестратор действий (scenario/orchestrator.ts): одно активное действие, очередь на одно место, блок повторных
   * нажатий; реплики помечаются токеном действия — у вытесненного снимаются.
   */
  readonly orch = new Orchestrator(() => performance.now());
  /** одинаковый пузырь не чаще раза в 8 с («Чуть позже!…» по кругу — запись 20.11) */
  readonly dedupe = new LineDedupe(() => performance.now());
  /** токен действия, которое сейчас обрабатывается (реплики enqueue получают owner) */
  private owner = 0;
  /** тело занято действием с предметом / скейтом (character.runAct) до этого момента */
  private actUntil = 0;
  private actTimers: number[] = [];
  /** смена кота отложена (идёт сцена/номер): повторить, когда освободится */
  private deferred: { e: ScenarioEvent; at: number } | null = null;
  /**
   * модель кота для персонажа уже на сцене (app.ts: новая модель грузится после set_persona) — реплика нового кота ждёт
   * (запись 20.11: «Вот и я…» Добряка над моделью Хулигана)
   */
  charReady: ((persona: string) => boolean) | null = null;
  /** смену кота сейчас можно начать (пилот: раз в 3 мин); false — «Чуть позже!» без вопроса «Хочешь, я стану другим?» */
  switchReady: (() => boolean) | null = null;
  /** текст «Чуть позже» без записи (config/pilot.ts); функция — с оставшимся временем («Другой кот — через 2 мин») */
  laterText: string | (() => string) = 'Чуть позже! Давай ещё немного поиграем со мной.';
  /** событие озвученного «Чуть позже» (pilot_switch_later): запись есть — пузырь её текстом и с голосом, нет — laterText */
  laterEvent: string | null = null;
  /** пузырь «Чуть позже» на экране до этого момента (повторное нажатие его не дублирует, но и не молчит после) */
  private laterUntil = -1e9;

  /** у кота есть настоящий клип Meshy с этим id (GlbCharacter.clipSource) */
  private isMeshy(id: string): boolean {
    const ch = this.character as (Character & { clipSource?: (id: string) => string | null }) | undefined;
    return ch?.clipSource?.(id) === 'meshy';
  }

  /**
   * Клип + цепочка Meshy (content/animations.json meshy.then): sit_down → sit_idle (петля holdS с) → stand_up,
   * fall_asleep → sleep_loop. Цепочка — только если оба клипа настоящие; иначе один клип, как раньше.
   */
  private playChained(clip: string) {
    clearTimeout(this.chainTimer);
    const real = (id: string) => this.isMeshy(id) || (this.character as Character & { clipSource?: (id: string) => string | null })?.clipSource?.(id) === 'own';
    const ch = meshyChain(clip, real);
    if (!ch || !this.isMeshy(clip)) return this.character.play(clip);
    const next = () => {
      if (this.character?.currentClip !== clip) return; // перебили — цепочка обрывается
      this.playChained(ch.then);
    };
    const def = resolveClip(clip, this.persona.id);
    if (def?.meshy?.loop) {
      this.character.play(clip, { loop: true });
      this.chainTimer = window.setTimeout(next, (ch.holdS ?? 4) * 1000);
    } else this.character.play(clip, { onEnd: () => this.playChained(ch.then) });
  }
  private lastTapLineAt = -1e9;
  private lastTapClipAt = -1e9;
  private loopTimer = 0;

  constructor(private d: DirectorDeps) {
    super();
    // ?fresh — для проверки продактом: знакомство с нуля (имя, характер, «уже знакомы» стираются)
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('fresh')) clearMemory();
    const mem = loadMemory();
    // ?cat=hooligan|kind|glitter (или ?char=<характер>) — страница тестовых флоу /test: какой кот выйдет
    const qcat = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
    const cat = qcat?.get('cat') ?? qcat?.get('char');
    if (isPersonaId(cat)) {
      mem.persona = cat;
      saveMemory({ persona: cat });
    }
    const ctxEv = contextEvent(new Date(), mem.lastVisitAt);
    this.state = initialState(mem, ctxEv);
    this.personas = new PersonaContext(d.content, mem.persona);
    this.cfg = makeScenarioConfig(d.content.dialogs);
    d.personas = d.content.personas;
    this.queue = new LineQueue({ stop: (soft) => this.stopVoice(soft) });
    d.fx.palette = this.persona.palette;
    d.fx.onGlitch = (on) => d.glCanvas.classList.toggle('glitch', on);
    d.fx.onSlap = () => d.audio.play('sticker_slap', 0.7);
    this.orch.onLog = (m) => this.log(m);
    this.orch.onCancel = (a) => {
      if (this.queue.drop((it) => it.owner === a.token && it.priority < 3)) this.log(`сняты реплики вытесненного «${a.id}»`);
      if (this.actBusy()) this.stopAct();
      // вытесненное действие уносит своё лицо (сонное, хмурое, спирали) — новое ставит своё следом
      else this.resetFace();
    };
    d.tracker.onFound(() => this.dispatch({ type: 'card_found' }));
    d.tracker.onLost(() => this.dispatch({ type: 'card_lost' }));
  }

  get persona() {
    return this.personas.persona;
  }
  /** совместимость: debug-панель и др. читают d.personas как Map */
  get personaMap() {
    return this.d.content.personas;
  }

  setCharacter(ch: Character) {
    this.character = ch;
    ch.setPersona(this.persona);
    this.d.stage.setCharacter(ch);
  }

  log(s: string) {
    this.emit('log', s);
  }

  // ───────────── вход событий ─────────────
  dispatch(e: ScenarioEvent) {
    // «ты тут?» говорит только лестница тишины (byCat); таймер тишины Input — без слов, у лестницы свой отсчёт
    if (e.type === 'silence' && !e.byCat) return;
    // смена обстановки (дом ↔ карта): лицо прошлой сцены не едет в новую — нейтральное, моргает
    if (e.type === 'context_change') this.resetFace();
    const now = performance.now();
    // имя, которое ребёнок только что назвал (голосом или полем): для пузыря «приятно» без записи имени (bubbleText)
    const heard = e.type === 'name' ? e.name : e.type === 'intent' && e.intent.type === 'name' ? e.intent.name : null;
    if (heard) this.heardName = { name: heard, at: now };
    // конец сессии (4–6 мин) — тоже инициатива кота: не поверх реплики, действия ребёнка, мини-игры или дрёмы
    if (e.type === 'timer' && e.id === 'outro' && (this.queue.busy || now - this.lastUserAct < 8000 || this.state.dialog || this.dozing || !this.state.cardVisible)) {
      this.exec({ type: 'timer', id: 'outro', ms: 10_000 });
      return;
    }
    // срез редакции (config/pilot.ts, ставит app.ts): команда вырезанного действия или смена кота раньше срока — съедена
    if (e.type === 'intent' && this.intentGate?.(e.intent, this.state)) return;
    const prev = this.state;
    // ребёнок ответил на вопрос узла (или раньше, чем кот договорил вопрос): недоговорённый вопрос не звучит
    const dl = prev.dialog;
    if (dl?.listening && (e.type === 'intent' || e.type === 'answer' || e.type === 'game_answer' || e.type === 'name' || e.type === 'skip_name' || e.type === 'choose')) {
      const tag = `${dl.id}.${dl.node}`;
      if (this.queue.drop((it) => it.tag === tag)) this.log(`снят недоговорённый вопрос ${tag}`);
    }
    const r = step(this.state, e, this.cfg);
    // смена кота (экран заклеивается): не чаще, чем разрешает switchGate (пилот — раз в 3 мин)
    if (r.state.phase === 'switching' && prev.phase !== 'switching') {
      // идёт сцена (раскраска, дом, пробуждение) или номер — наклейки и «Встряхни телефон» не поверх: подождём
      const b = this.orch.blocking();
      if (b && b !== 'other' && b !== 'switch') {
        this.deferred = { e, at: now };
        this.log(`смена кота подождёт конца «${b}»`);
        return;
      }
      if (this.switchGate && !this.switchGate()) {
        this.log(`смена кота отложена (${e.type})`);
        return;
      }
      if (this.actBusy()) this.stopAct();
      const t = this.orch.request('switch');
      this.switchTok = t.token;
    }
    if (prev.phase === 'switching' && r.state.phase !== 'switching' && this.switchTok) {
      this.orch.done(this.switchTok);
      this.switchTok = 0;
      this.emit('switch_done', { changed: r.state.persona !== prev.persona });
    }
    if (r.state.phase !== this.state.phase) this.emit('phase', r.state.phase);
    if (!prev.dialog && r.state.dialog) this.emit('game', { id: r.state.dialog.id, start: true });
    else if (prev.dialog && prev.dialog.id !== r.state.dialog?.id) {
      this.emit('game', { id: prev.dialog.id, start: false });
      if (r.state.dialog) this.emit('game', { id: r.state.dialog.id, start: true });
    }
    this.state = r.state;
    const playing = (p: string) => p === 'play' || p === 'free';
    if (!prev.dialog && r.state.dialog) this.dialogStartedAt = now;
    // вход в игру; конец мини-игры, в которой ребёнок участвовал, — тишина считается отсюда.
    // Предложение кота, оставшееся без ответа, лестницу не сбрасывает (иначе «ты тут?» по кругу)
    if ((playing(r.state.phase) && !playing(prev.phase)) || (prev.dialog && !r.state.dialog && this.lastUserAct >= this.dialogStartedAt)) this.ladder.reset(now);
    // игру бросили ради другой (кнопка «Камень, ножницы…» посреди «Угадай эмоцию», «мне грустно», другой диалог):
    // её недосказанные реплики («не угадал», «это был весёлый я») не звучат перед новой (docs/qa/BUGS.md № 24)
    // Новая игра началась, а прошлая ещё договаривает «ладно, поиграем потом» в очереди — тоже не звучит.
    const pd = prev.dialog, nd = r.state.dialog;
    // кнопка той же игры посреди игры («Повтори движение» ещё раз) — игра началась заново
    const restart = !!pd && pd.id === nd?.id && e.type === 'intent' && !!e.intent.button && resolveTrigger(this.cfg.dialogs, e.intent.type)?.id === pd.id;
    if (pd && (pd.id !== nd?.id || restart) && (nd || (e.type === 'intent' && e.intent.button))) {
      const pre = `${pd.id}.`;
      if (this.queue.drop((it) => !!it.tag?.startsWith(pre))) this.log(`сняты реплики брошенной игры ${pd.id}`);
    } else if (!pd && nd) {
      const cur = this.queue.current;
      if (this.queue.drop((it) => it !== cur && !!it.tag)) this.log(`сняты хвосты прошлой игры перед ${nd.id}`);
    }
    if (e.type !== 'timer' || e.id !== 'pause_end')
      this.log(`${e.type}${'kind' in e ? ':' + e.kind : ''}${'intent' in e ? ':' + e.intent.type : ''}${'result' in e ? ':' + e.result : ''} → ${r.state.phase}${r.state.dialog ? ` [${r.state.dialog.id}.${r.state.dialog.node}]` : ''}`);
    for (const a of r.actions) this.exec(a);
  }

  /** ввод голосом/чипом/текстом. Разбор — src/voice/intents.ts по content/intents.ru.json */
  text(t: string) {
    this.childAct();
    this.coachDone();
    const st = this.state;
    const listening: ListenMode | null = st.dialog?.listening ?? null;
    const expectName = listening === 'name' || (st.phase === 'ask_name' && !listening);
    const expect = st.dialog ? Object.keys(this.cfg.dialogs.dialogs[st.dialog.id]?.nodes[st.dialog.node]?.on ?? {}) : [];
    // экран заклеен для смены образа — «нет» / «не надо» понимаем как ответ (отмена смены), хотя вопроса не было
    const m = matchIntent(t, { question: !!listening || st.phase === 'switching', expectName, expect });
    const type = m.intent === 'switch' ? 'change_persona' : m.intent;
    const h: Heard = m.intent === 'name' ? { type: 'name', name: m.name, known: !!m.known, text: t } : { type, text: t };
    this.log(`«${t}» → ${h.type}${h.name ? ` ${h.name}${h.known ? '' : ' (нет в словаре)'}` : ''} ${m.confidence.toFixed(2)}${listening ? ` (ждём: ${listening})` : ''}`);
    // нет микрофона — повторялку не запускаем ни чипом, ни текстом (повторять нечего)
    if (h.type === 'echo_start' && !this.voiceOk('echo')) {
      this.d.ui.toast('Повторялке нужен микрофон — разреши доступ в настройках браузера', 4000);
      return this.log('повторялка: нет микрофона');
    }
    // «Угадай эмоцию»: «ты грустный» — ответ про кота, а не «мне грустно» (про себя — «мне», «я» — поддержка, как всегда)
    if (listening === 'emo' && !/(^| )(мне|я|меня)( |$)/.test(normalize(t))) {
      const it = this.gameItems('emo').find((i) => !!i.keywords?.length && answerMatches(t, i.keywords));
      if (it) return this.dispatch({ type: 'game_answer', value: it.id, text: t });
    }
    if (this.cfg.dialogs.interrupts.includes(h.type)) return this.dispatch({ type: 'intent', intent: h });
    if (listening === 'riddle') {
      const r = this.currentRiddle();
      if (r && answerMatches(t, r.keywords)) return this.dispatch({ type: 'answer', result: 'right', text: t });
      if (['giveup', 'no', 'skip'].includes(h.type)) return this.dispatch({ type: 'answer', result: 'giveup', text: t });
      if (h.type !== 'riddle' && h.type !== 'unknown' && resolveTrigger(this.cfg.dialogs, h.type)) return this.dispatch({ type: 'intent', intent: h });
      return this.dispatch({ type: 'answer', result: 'wrong', text: t });
    }
    if (isGameMode(listening)) {
      // мини-игра: «весёлый», «камень», «прыжок» — ответ по словам варианта или по интенту (повтори движение: «прыгни»)
      const g = st.game?.id;
      const it = this.gameItems(g).find((i) => !!i.keywords?.length && answerMatches(t, i.keywords)) ?? (g ? gameItemByIntent(this.cfg, g, h.type) : undefined);
      if (it) return this.dispatch({ type: 'game_answer', value: it.id, text: t });
      if (['giveup', 'no', 'skip'].includes(h.type)) return this.dispatch({ type: 'game_answer', value: '$giveup', text: t });
      if (h.type !== 'unknown' && resolveTrigger(this.cfg.dialogs, h.type) && h.type !== g && h.type !== 'emo_game') return this.dispatch({ type: 'intent', intent: h });
      return this.dispatch({ type: 'game_answer', value: null, text: t });
    }
    this.dispatch({ type: 'intent', intent: h });
  }

  private gameItems(id: string | undefined): GameItem[] {
    return (id && this.cfg.dialogs.games?.[id]?.items) || [];
  }

  /**
   * Чипы-подсказки для идущей мини-игры (агент UI): какие ответы сейчас можно нажать. Нажатие — director.text(label)
   * (как будто ребёнок сказал). Повтори движение — кнопки движений панели действий (id совпадают с ACTION_ROUTE).
   */
  gameChoices(): { game: string; mode: string; options: { id: string; label: string }[] } | null {
    const st = this.state;
    const mode = st.dialog?.listening;
    if (!st.game || !isGameMode(mode)) return null;
    return { game: st.game.id, mode, options: this.gameItems(st.game.id).map((i) => ({ id: i.id, label: i.label })) };
  }

  /**
   * Касание до режиссёра: true — съедено снаружи (кот спит в кровати «Мира кота»: тап — бормочет и ворочается,
   * не будит; src/home/bedFlow.ts). Ставит app.ts.
   */
  touchGate: ((kind: string, ctx: { x?: number; y?: number }) => boolean) | null = null;
  /**
   * Срез редакции (пилот, config/pilot.ts; ставит app.ts): true — интент съеден снаружи (команда вырезанного действия →
   * «Давай лучше …», смена кота раньше срока → «Чуть позже!»).
   */
  intentGate: ((h: Heard, st: ScenarioState) => boolean) | null = null;
  /** тело кота занято (раскраска карты: присел и рисует) — реплики и реакции не меняют клип тела, только лицо и звук */
  bodyBusy: (() => boolean) | null = null;
  /** можно ли сейчас начать смену кота (false — смену не начинаем); ставит app.ts в пилоте */
  switchGate: (() => boolean) | null = null;
  /** эффект разрешён у этого кота (пилот: белый список, config/pilot.ts fxAllowed); null — все */
  fxGate: ((persona: PersonaId, fx: string) => boolean) | null = null;
  /** до этого момента эффекты реакций не играют (app.ts: свайп ребёнка по стеклу — свои царапины, без эффекта кота) */
  private muteFxUntil = 0;
  muteFx(ms: number) {
    this.muteFxUntil = performance.now() + ms;
  }

  interaction(kind: InteractionKind, ctx: { x?: number; y?: number; from?: { x: number; y: number }; path?: { x: number; y: number }[] } = {}) {
    if (this.touchGate?.(kind, ctx)) return;
    if (kind === 'swipe' && ctx.from) this.lastSwipe = ctx.from;
    this.ctx = ctx;
    this.lastTouch = { kind, at: Date.now() };
    if (!/^(card_|low_light|loud|whisper|clap|stickers_all_gone|wake_up)/.test(kind)) {
      // кот дремлет: касание будит — «А? Я не спал!» вместо обычной реакции
      if (this.dozing && this.state.appeared && kind !== 'sleep') {
        this.lastUserAct = performance.now();
        this.ladder.reset(this.lastUserAct);
        return this.dispatch({ type: 'interaction', kind: 'wake_up' });
      }
      this.childAct();
      this.releaseHold();
      if (/^(stroke|tap_cat|poke|double_tap|treat)/.test(kind)) this.coachDone();
    }
    // тап по поверхности карты (не по коту) → кот идёт в эту точку (локомоция)
    if (kind === 'tap_screen' && ctx.x !== undefined && this.state.appeared && !this.d.stage.atGlass && this.canWalk()) {
      const { w, h } = this.d.size();
      const p = this.d.stage.screenToCard(ctx.x, ctx.y!, w, h);
      if (p && this.isOnSurface(p)) {
        if (this.d.stage.walkTo(p, () => this.character.play('idle'))) {
          this.character.play('walk', { loop: true });
          this.d.audio.play('bleep', 0.3);
          this.log(`walk → (${p.x.toFixed(2)}, ${p.y.toFixed(2)})`);
          if (!this.paused) this.speakEvent('walk_to');
          return;
        }
      }
    }
    this.fingerTap = !this.fromButton && TAP_RE.test(kind);
    try {
      this.dispatch(kind === 'shake' ? { type: 'shake' } : { type: 'interaction', kind });
    } finally {
      this.fingerTap = false;
    }
  }

  private canWalk() {
    if (this.actBusy()) return false; // на скейте / с предметом в лапе — тап по карте не уводит
    return this.state.phase === 'play' || this.state.phase === 'free' || this.state.phase === 'ask_name';
  }
  private isOnSurface(p: THREE.Vector2) {
    if (this.d.tracker.capabilities.worldTracking) return p.length() <= this.d.stage.cfg.worldWalkRadius;
    return Math.abs(p.x) <= 0.5 && Math.abs(p.y) <= 0.5 / this.d.tracker.aspect;
  }

  /**
   * Кнопка панели действий или каталога «Что умеет кот» (scenario/actions.ts). Касательные действия (погладить,
   * пощекотать, угостить, фокус, усыпить…) — как жест по коту, остальные — как сказанная команда (танец, сальто, загадка…).
   */
  action(id: ActionId | string) {
    if (!isActionId(id)) return this.log(`нет действия «${id}»`);
    // нет доступа к микрофону — повторялку не запускаем (кот повторял бы тишину)
    if (id === 'echo' && !this.voiceOk('echo')) {
      this.d.ui.toast('Повторялке нужен микрофон — разреши доступ в настройках браузера', 4000);
      return this.log('повторялка: нет микрофона');
    }
    track('action', { id }); // воронка (src/analytics): id кнопки, без текста
    this.childAct();
    this.releaseHold();
    this.coachDone();
    this.activity();
    // «Другой кот» раньше срока — сразу «Чуть позже!» (один раз), без вопроса «Хочешь, я стану другим котом?»
    if (id === 'other' && this.switchReady && !this.switchReady()) return this.sayLater(true);
    const ord = this.orch.request(id);
    if (ord.verdict !== 'start') return;
    // реплики прошлых действий, ещё ждущие в очереди, — не звучат поверх нового
    const tok = ord.token;
    if (this.queue.drop((it) => it.owner !== undefined && it.owner !== tok && it.priority < 3)) this.log('сняты реплики прошлого действия');
    if (this.actBusy()) this.stopAct();
    this.owner = tok;
    try {
      this.runAction(id);
    } finally {
      this.owner = 0;
    }
  }

  /** предмет в лапу / скейт по кнопке: id действия → шаблон персонажа (у Хулигана «Пузыри» — жвачка) */
  private actTemplate(id: string): string | null {
    if (id === 'skate' || id === 'cocoa' || id === 'mirror' || id === 'treat') return id;
    if (id === 'bubbles' && this.persona.id === 'hooligan') return 'gum';
    return null;
  }

  private runAction(id: ActionId) {
    clearTimeout(this.sleepTimer);
    const tpl = this.actTemplate(id);
    if (tpl) this.propAct(tpl);
    const r = ACTION_ROUTE[id];
    // кнопка — явная команда: мини-игру заканчивает, а не считается «ответом» на загадку
    if ('say' in r) return this.dispatch({ type: 'intent', intent: { type: r.say, text: r.text, button: true } });
    if (r.touch === 'swipe') {
      // «Порисуй на стекле»: палец как будто провёл по экрану рядом с котом
      const { w, h } = this.d.size();
      const path = Array.from({ length: 9 }, (_, i) => ({ x: w * (0.22 + i * 0.07), y: h * (0.5 - Math.sin((i / 8) * Math.PI) * 0.08) }));
      return this.interaction('swipe', { from: path[0], path, x: path[8].x, y: path[8].y });
    }
    this.fromButton = true;
    this.curAction = id;
    try {
      this.interaction(r.touch as InteractionKind);
    } finally {
      this.fromButton = false;
      this.curAction = null;
    }
    if (r.touch === 'stroke' || r.touch === 'stroke_long') {
      // «Погладить» / «Обнять» кнопкой: пальца нет — stroke_end не придёт, а мурчание (purr_stroke) держится петлёй;
      // кот мурчит BUTTON_PURR_MS и сам возвращается в покой (аудит реакций: «не вернулся в покой»)
      clearTimeout(this.purrTimer);
      this.purrTimer = window.setTimeout(() => {
        if (this.character && /purr_stroke|hug_screen/.test(this.character.currentClip) && !this.d.stage.walking) {
          this.character.play('idle');
          (this.character as Character & { clearEmotion?: () => void }).clearEmotion?.();
        }
      }, BUTTON_PURR_MS);
    }
    if (r.touch === 'sleep') {
      // «Усыпи»: подремлет и проснётся сам, если ребёнок ничего не нажал
      const at = this.lastUserAct;
      this.sleepTimer = window.setTimeout(() => {
        if (this.lastUserAct === at) this.interaction('wake_up' as InteractionKind);
      }, SLEEP_WAKE_MS);
    }
  }
  private sleepTimer = 0;
  private purrTimer = 0;
  private switchTok = 0;

  /**
   * Касание или кнопка — ребёнок не говорит с котом: реплики не ждут «hold» VoiceEngine (VAD принял стук пальца /
   * шум за начало фразы — ответ на кнопку ждал до 5 с разбора «фразы», пузырь висел без голоса).
   */
  private releaseHold() {
    const v = this.d.voice as VoicePlayer & { held?: boolean; release?: () => void };
    if (v.held && v.release) {
      v.release();
      this.log('касание — реплики не ждут разбора фразы (hold снят)');
    }
  }

  /**
   * «Чуть позже!» — пузырём. Кнопка (byButton): пузырь показывается каждый раз, когда его нет на экране (раньше дедуп
   * 8 с глотал второе нажатие — «выбор кота не открывается» и тишина); голос/повторы — не чаще раза в 8 с.
   */
  sayLater(byButton = false) {
    const ev = this.laterEvent;
    const voiced = ev ? this.recordedText(ev) : null;
    const text = voiced ?? (typeof this.laterText === 'function' ? this.laterText() : this.laterText);
    const now = performance.now();
    if (byButton) {
      if (now < this.laterUntil) return this.log('«Чуть позже» уже на экране');
      this.dedupe.forget(text);
    }
    if (ev && voiced ? this.voicedBubble(ev, text) : this.bubble(text, 3500)) this.laterUntil = now + 3500;
  }

  /**
   * Пузырь с записью (пилот: pilot_cut «Это я пока не умею…», pilot_switch_later «Чуть позже!»): запись ElevenLabs
   * события с тем же текстом есть — speakEvent (пузырь вместе с голосом по onStart; запись не готова — ждём её
   * ≤ VOICE_WARM_WAIT_MS). Записи нет (mp3 ещё не на сервере) или текст другой — немой пузырь сразу, как раньше.
   * Одинаковый — не чаще раза в 8 с в обоих случаях (perform и bubble сверяют тот же dedupe).
   */
  voicedBubble(event: string, text: string, ms = 3500): boolean {
    const rec = this.recordedText(event);
    if (rec !== null && normalize(rec) === normalize(text)) return this.speakEvent(event, { force: true });
    return this.bubble(text, ms);
  }

  /** текст реплики события, у которой есть запись ElevenLabs (у текущего кота); null — записи нет */
  private recordedText(event: string): string | null {
    const vp = this.d.voice as VoicePlayer & { elRecorded?: (p: string, id: string | undefined, t: string, x?: string) => boolean; hasRecordings?: boolean };
    if (!vp.elRecorded || !vp.hasRecordings) return null;
    const p = this.persona;
    const l = this.picker.candidates(p, event, this.state.name).find((c) => !c.text.includes('{') && vp.elRecorded!(p.id, c.id, c.text, c.text));
    return l ? l.text : null;
  }
  /** пузырь без озвучки (срез редакции, «Чуть позже») — одинаковый не чаще раза в 8 с */
  bubble(text: string, ms = 3500): boolean {
    if (!this.dedupe.allow(text)) {
      this.log(`пузырь «${text.slice(0, 30)}…» — повтор, не показываю`);
      return false;
    }
    const p = this.persona;
    this.d.ui.say(text, p.name, p.id, ms);
    return true;
  }

  /** тело занято действием с предметом или скейтом */
  actBusy(): boolean {
    return performance.now() < this.actUntil;
  }
  private stopAct() {
    this.actUntil = 0;
    this.actTimers.forEach((t) => clearTimeout(t));
    this.actTimers = [];
    (this.character as Character & { cancelAct?: () => void })?.cancelAct?.();
    this.resetFace();
    if (this.d.stage.walking) this.d.stage.cancelWalk();
  }

  /**
   * Действие с предметом (holdAction.ts: какао, зеркальце, рыбка, жвачка) или скейт (skateRig.ts): тело ведёт персонаж,
   * режиссёр — реплика, эффект и (скейт) проезд дугой по карте. false — персонаж не умеет (спрайт, нет модели).
   */
  private propAct(act: string): boolean {
    const ch = this.character as Character & { runAct?: (id: string) => number };
    if (!ch?.runAct || this.d.stage.atGlass) return false;
    this.stopAct();
    const dur = ch.runAct(act);
    if (!dur) return false;
    this.actUntil = performance.now() + dur * 1000;
    this.log(`🎬 ${act}: ${dur.toFixed(1)} с (шаблон тела)`);
    const av = ACT_VOICE[act];
    if (av && !this.hasVoiced(act)) this.actTimers.push(window.setTimeout(() => this.actVoice(act), Math.max(300, av.at * dur * 1000)));
    if (act === 'skate') {
      // сторона проезда (нос доски) — до того, как доску поставят: меньше упора в край карты
      this.skateDir = this.skateArc(1).clip <= this.skateArc(-1).clip ? 1 : -1;
      (ch as { setSkateDir?: (d: 1 | -1) => void }).setSkateDir?.(this.skateDir);
      this.actTimers.push(window.setTimeout(() => this.rideArc(), RIDE_FROM * 1000));
    }
    return true;
  }

  /** реплика к фирменному действию (ACT_VOICE): только своего кота, без клипа и эффекта реплики — тело ведёт runAct */
  private actVoice(act: string) {
    const ids = (ACT_VOICE[act]?.ids ?? []).filter((id) => id.startsWith(this.persona.id + '.'));
    if (!ids.length) return;
    const pk = this.picker.byId(this.d.content.personas, ids[Math.floor(Math.random() * ids.length)], { name: this.state.name });
    if (pk) this.enqueue({ ...pk, priority: 1, interruptible: true }, false);
  }

  /**
   * Сторона проезда на скейте: кот едет боком (нос доски — ±X кота), лицом к зрителю; дуга загибается к зрителю.
   * Сторона — та, где дуга меньше упирается в край карты. Точки — в координатах карты.
   */
  private skateArc(bdir: 1 | -1): { pts: THREE.Vector2[]; clip: number } {
    const st = this.d.stage;
    const p0 = st.pos.clone();
    const yaw = st.heading;
    // stage.walkTo side: yaw кота = ход − side·π/2 → ход = yaw + side·π/2; вперёд при yaw — (sin, −cos)
    const ty = yaw + (bdir * Math.PI) / 2;
    const d = new THREE.Vector2(Math.sin(ty), -Math.cos(ty));
    const n = new THREE.Vector2(Math.sin(yaw), -Math.cos(yaw));
    // пологая дуга (~60°): кот к концу проезда всё ещё почти лицом к зрителю
    const R = 0.3;
    const pts: THREE.Vector2[] = [];
    let clip = 0;
    for (let i = 1; i <= 4; i++) {
      const th = (i / 4) * 1.05;
      const raw = p0.clone().addScaledVector(d, R * Math.sin(th)).addScaledVector(n, R * 0.5 * (1 - Math.cos(th)));
      const c = this.keepOnScreen(p0, st.clampTarget(raw.clone()));
      clip += c.distanceTo(raw);
      pts.push(c);
    }
    return { pts, clip };
  }

  /**
   * Точка проезда — так, чтобы кот остался на экране (E2E 22.11: после скейта Хулиган уезжал за правый край и стоял
   * там — карта у края кадра): ноги не ближе SCREEN_MARGIN ширины экрана к его краю, иначе точка подтягивается к p0.
   */
  private keepOnScreen(p0: THREE.Vector2, c: THREE.Vector2): THREE.Vector2 {
    const st = this.d.stage, { w, h } = this.d.size();
    if (!w || !h) return c;
    const a = st.anchor;
    a.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    const off = (p: THREE.Vector2) => {
      v.set(p.x, p.y, st.cfg.footZ ?? 0).applyMatrix4(a.matrixWorld).project(st.camera);
      const x = ((v.x + 1) / 2) * w, y = ((1 - v.y) / 2) * h, m = w * 0.22;
      return x < m || x > w - m || y < h * 0.15 || y > h * 0.85;
    };
    if (!off(c) || off(p0)) return c;
    let lo = 0, hi = 1;
    for (let k = 0; k < 10; k++) {
      const t = (lo + hi) / 2;
      if (off(p0.clone().lerp(c, t))) hi = t;
      else lo = t;
    }
    return p0.clone().lerp(c, lo);
  }
  private skateDir: 1 | -1 = 1;

  /** проезд на скейте: дуга боком к ходу (skateArc), скорость — чтобы уложиться во время проезда */
  private rideArc() {
    const st = this.d.stage;
    if (!this.actBusy()) return;
    const p0 = st.pos.clone();
    const { pts } = this.skateArc(this.skateDir);
    let len = 0, prev = p0;
    for (const p of pts) {
      len += p.distanceTo(prev);
      prev = p;
    }
    const speed = Math.max(0.05, len / Math.max(0.5, RIDE_TO - RIDE_FROM));
    let i = 0;
    const side = this.skateDir;
    const next = () => {
      if (!this.actBusy() || i >= pts.length) return;
      const p = pts[i++];
      if (!st.walkTo(p, next, { speed, side })) next();
    };
    next();
  }

  /**
   * Ребёнок что-то сделал со стеклом (запотело, царапины): кот сразу смотрит туда и удивляется/радуется — лицо и взгляд
   * в тот же кадр (аудит реакций: на запотевшее стекло кот не реагировал вовсе). Клип — у реакции свайпа (react).
   */
  glassMoment(kind: 'fog' | 'claws', p: { x: number; y: number }) {
    if (!this.character || this.dozing) return;
    const { w, h } = this.d.size();
    const head = this.d.stage.anchorScreen('head', w, h);
    this.character.reach?.({ dx: (p.x - head.x) / head.s, dy: (p.y - head.y) / head.s });
    const ch = this.character as Character & { setEmotion?: (n: string, w?: number, ms?: number) => void };
    ch.setEmotion?.(kind === 'fog' ? (this.persona.id === 'hooligan' ? 'cheeky' : 'excited') : 'surprised', 1, 1600);
  }

  /** петля «Zzz» над спящим котом — только пока спит */
  private stopSleepFx() {
    (this.d.fx as FxLayer & { stop?: (id: string) => void }).stop?.('zzz');
  }

  /**
   * Действие ребёнка: лестница тишины — с начала; кот дремал — просыпается молча (команда кнопкой/голосом
   * выполняется сразу; касание будит отдельной реакцией — см. interaction).
   */
  private childAct() {
    const now = performance.now();
    this.lastUserAct = now;
    this.ladder.reset(now);
    if (this.dozing) {
      this.dozing = false;
      this.stopSleepFx();
      if (this.character && !this.d.stage.walking) this.character.play('idle');
      // лицо «сплю» (эмоция без срока) не остаётся на проснувшемся коте, если у команды нет своей эмоции
      (this.character as Character & { clearEmotion?: () => void })?.clearEmotion?.();
      this.log('проснулся (действие ребёнка)');
    }
  }

  private startCoach() {
    if (!this.coachPending) return;
    this.coachPending = false;
    this.d.ui.show('chips', true);
    this.d.ui.show('mic', true);
    this.d.ui.coach?.(true);
    clearTimeout(this.coachTimer);
    this.coachTimer = window.setTimeout(() => this.coachDone(), 9000);
  }

  /** подсказка «погладь меня» показана — убрать по первому действию ребёнка или через 9 с */
  private coachDone() {
    if (this.coachPending) this.startCoach();
    if (!this.coachTimer) return;
    clearTimeout(this.coachTimer);
    this.coachTimer = 0;
    this.d.ui.coach?.(false);
  }

  chooseSticker(x: number, y: number) {
    const s = this.d.fx.stickerAt(x, y);
    if (s?.choice && isPersonaId(s.choice)) this.dispatch({ type: 'choose', persona: s.choice });
  }

  // ───────────── исполнение команд ─────────────
  private exec(a: Action) {
    const d = this.d;
    switch (a.type) {
      case 'say':
        // повторялка, ветка «*»: повторять было нечего (записи нет, синтез выключен) — без «мой голос круче»
        if (a.key === 'echo_done' && this.echoSkipped) {
          this.echoSkipped = false;
          this.log('повтор: нечего повторять — без echo_done');
          break;
        }
        this.speakEvent(a.key, { force: a.force, node: a.node, scenario: true });
        break;
      case 'say_riddle':
        this.sayRiddle(a.part, a.node);
        break;
      case 'react':
        if (a.event === 'card_lost') {
          // карта мигнула (рука, блик) — кот молчит; пропала надолго — спрашивает, где она
          clearTimeout(this.cardLostTimer);
          const since = performance.now();
          const say = () => {
            if (this.state.cardVisible) return;
            // карта в кадре и проверяется (после «Мой дом» → «На карту», «Пересадить»): «Ой, карта пропала!» при карте
            // в руке — не по сценарию (запись 23.11, 13:59:15). Ждём, пока проверка не кончится, но не дольше CARD_LOST_WAIT_MS
            if (d.tracker.cardInView?.() && performance.now() - since < CARD_LOST_WAIT_MS) {
              this.cardLostTimer = window.setTimeout(say, 500);
              return;
            }
            this.cardLostSaid = true;
            this.react('card_lost');
          };
          this.cardLostTimer = window.setTimeout(say, CARD_LOST_SAY_MS);
          break;
        }
        if (a.event === 'card_found') {
          clearTimeout(this.cardLostTimer);
          this.ladder.reset(performance.now()); // карту вернули — ребёнок снова здесь
          if (!this.cardLostSaid) break;
          this.cardLostSaid = false;
        }
        this.react(a.event, a.quiet);
        break;
      case 'ui':
        if (a.ui === 'chips' && a.show && this.coachPending) break; // панель покажет обучалка
        if (a.ui === 'name_prompt' && a.show && this.state.dialog?.id === 'intro') {
          // голоса нет (модель не готова / нет микрофона) — поле ввода сразу, ждать нечего
          const v = d.voiceIn?.();
          if (v && (!v.mic || !v.ready)) {
            d.ui.show('name_prompt', true);
            d.ui.show('mic', true);
            break;
          }
          // лист «Как тебя зовут?» — когда кот договорил вопрос, а не поверх поздравления
          void this.queue.whenIdle().then(() => {
            if (this.state.phase === 'ask_name' && this.state.dialog?.listening === 'name') {
              d.ui.show('name_prompt', true);
              d.ui.show('mic', true);
            }
          });
          break;
        }
        d.ui.show(a.ui, a.show);
        // микрофон сценарий не прячет: три нижние кнопки видны всегда (ui.show('mic') — только «показать»)
        if (a.ui === 'name_prompt' && a.show) d.ui.show('mic', true);
        break;
      case 'timer': {
        clearTimeout(this.timers.get(a.id));
        // конец появления — когда кончится сцена пробуждения (первая встреча ~5 с), а не через appearMs автомата
        const ms = a.id === 'appear_done' && this.appearMs > 0 ? this.appearMs : a.ms;
        if (a.id === 'appear_done') this.appearMs = 0;
        this.timers.set(a.id, window.setTimeout(() => this.dispatch({ type: 'timer', id: a.id }), ms));
        break;
      }
      case 'cancel_timer':
        clearTimeout(this.timers.get(a.id));
        break;
      case 'listen':
        void this.openListen(a.mode, a.ms, a.token);
        break;
      case 'stop_listen':
        clearTimeout(this.listenTimer);
        d.stopListen?.();
        break;
      case 'echo':
        this.echo(a.text);
        break;
      case 'appear':
        void this.appear();
        break;
      case 'offer_choice':
        void this.offerChoice();
        break;
      case 'hide_choice':
        d.ui.hideChoice();
        d.fx.stickers.filter((s) => s.choice).forEach((s) => {
          s.flying = true;
          s.vx = rand(-500, 500);
          s.vy = -700;
          s.vr = rand(-5, 5);
        });
        break;
      case 'set_persona':
        this.setPersona(a.persona);
        break;
      case 'signature':
        void this.signature(a.silent);
        break;
      case 'coach':
        // первое знакомство: палец «погладь меня» у кота и подсвеченная панель действий — когда кот начнёт meet_skills
        this.coachPending = true;
        clearTimeout(this.coachTimer);
        this.coachTimer = window.setTimeout(() => this.startCoach(), 15_000); // запасной: реплику отбросили
        break;
      case 'remember':
        saveMemory({ ...a.patch, visits: this.state.visits, lastVisitAt: Date.now() });
        // аналитика (src/analytics): только факт «назвал имя», само имя — никогда
        if ('name' in a.patch && a.patch.name) this.emit('named', true);
        break;
      case 'cover_stickers': {
        const p = this.personas.get(a.persona)!;
        d.audio.play('sticker_slap');
        void d.fx.cover(p.stickers, p.palette, 3400).then(() => this.dispatch({ type: 'covered' }));
        break;
      }
      case 'blow_stickers':
        d.fx.blowStickers();
        d.audio.play('fly_away');
        this.character.play('jump');
        break;
      case 'hold_pose':
        // поза уже заморожена трекером (экранные координаты / 3DoF). Через lostHoldMs — к стеклу.
        clearTimeout(this.lostTimer);
        if (!d.tracker.capabilities.worldTracking)
          this.lostTimer = window.setTimeout(() => {
            if (!d.tracker.isTracking) d.stage.setMode('glass');
          }, d.stage.cfg.lostHoldMs);
        break;
      case 'resume_pose':
        clearTimeout(this.lostTimer);
        d.stage.setMode('card');
        break;
      case 'open_sberkids':
        // из голоса окно браузер может заблокировать, а уводить ребёнка из AR без взрослого не нужно:
        // лист «Брат живёт в СберKids» с кнопкой (ссылка — из config)
        if (d.ui.showKids) d.ui.showKids(true, ASSETS.sberKidsUrl);
        else d.ui.toast('Нажми кнопку «В СберKids» внизу', 4000);
        break;
      case 'adult_hint':
        d.ui.toast(this.cfg.dialogs.adultHint ?? 'Позови взрослого.', 10_000);
        break;
      case 'goodbye':
        // клип Meshy «ныряет в карту» (code:goodbye) — вместо бега
        this.character.play(meshyUpgrade('code:goodbye', 'run_home', this.persona.id, (id) => this.isMeshy(id)) ?? 'run_home');
        window.setTimeout(() => {
          if (this.state.phase === 'gone') d.stage.show(false);
        }, 1500);
        break;
      case 'pause':
        this.paused = a.on;
        if (a.on) this.queue.clear();
        break;
      case 'game_show':
        void this.gameShow(a);
        break;
      case 'offer_next':
        this.offerNext();
        break;
    }
  }

  /** мини-игра: кот показывает загаданное (эмоцию лицом и клипом, движение — клипом реакции) после своей реплики */
  private async gameShow(a: { face?: string; clip?: string; event?: string }) {
    const tok = this.state.listenToken;
    await wait(0); // реплика узла встаёт в очередь в том же шаге — показываем после неё
    await this.queue.whenIdle();
    if (!this.state.game || this.state.listenToken !== tok) return;
    const ch = this.character as Character & { setEmotion?: (n: string, w?: number, ms?: number) => void };
    if (a.event) {
      const def = this.persona.reactions[a.event];
      this.playVisual({ clip: def?.clip ?? a.clip, fx: def?.fx ? [def.fx] : [], sound: def?.sound, ev: a.event });
    } else this.playVisual({ clip: a.clip });
    if (a.face && ch?.setEmotion) ch.setEmotion(a.face, 1, 7000);
    this.log(`🎲 показ ${a.event ?? a.face ?? a.clip}`);
  }

  /** окно ответа: ждём, пока кот договорит, затем микрофон слушает ms */
  private async openListen(mode: ListenMode, ms: number, token: number) {
    // ответ ждём с входа в узел: «да» в паузе между репликами кота — ответ (окно микрофона — после реплики)
    this.d.expect?.(ms, mode);
    await this.queue.whenIdle();
    if (this.state.listenToken !== token || this.state.dialog?.listening !== mode) return;
    // имя: голосом — только если распознавание готово (ждём до 4 с), иначе — поле ввода и время напечатать
    let voice = true;
    if (mode === 'name' && this.d.whenAsrReady) {
      const v = this.d.voiceIn?.();
      voice = !!v?.mic && (await this.d.whenAsrReady(v.ready ? 0 : 4000));
      if (this.state.listenToken !== token || this.state.dialog?.listening !== mode) return;
      if (!voice) {
        this.d.ui.show('name_prompt', true);
        ms = Math.max(ms, 20_000);
        this.log('🎤 имя: голос не готов — поле ввода');
      }
    }
    this.d.ui.show('mic', true);
    if (voice) this.d.listen?.(ms, mode);
    this.log(`🎤 слушаю ${ms / 1000} с (${mode})`);
    clearTimeout(this.listenTimer);
    this.listenTimer = window.setTimeout(() => {
      this.d.stopListen?.();
      this.dispatch({ type: 'listen_timeout', token });
    }, ms);
  }

  /** длительность сцены пробуждения для таймера appear_done (0 — как в автомате) */
  private appearMs = 0;

  private async appear() {
    const d = this.d;
    // хлопок → кот выскакивает из карты; первая встреча — под фанфары и конфетти
    const first = !this.state.met;
    // сцена пробуждения (src/awake): свой «видеоряд» у каждого образа — первая встреча полная, повтор короткий
    if (d.awake && typeof d.awake.play === 'function') {
      this.appearMs = d.awake.play(this.persona.id, first ? 'first' : 'short');
      if (first) this.lastCoverAt = performance.now();
      return;
    }
    d.stage.resetPosition();
    d.audio.play('gum_chew');
    await wait(300);
    d.audio.play('gum_pop');
    const { w, h } = d.size();
    d.stage.show(true);
    this.character.play('appear');
    d.audio.play('pop_appear');
    if (first) (d.audio as Audio & { fanfare?: () => void }).fanfare?.();
    await wait(80);
    const p = d.stage.headScreen(w, h, 0.2); // у лап: блёстки не закрывают морду
    d.fx.burst(p.x, p.y, this.persona.palette.fx, first ? 26 : 18);
    if (first) {
      this.lastCoverAt = performance.now();
      (d.fx as FxLayer & { play?: (id: string, o?: Record<string, unknown>) => unknown }).play?.('confetti', { palette: this.persona.palette });
    }
  }

  private async offerChoice() {
    const d = this.d;
    // ждём, пока договорит «Выбирай, каким мне быть»
    for (let i = 0; i < 80 && this.queue.busy; i++) await wait(100);
    if (this.state.phase !== 'choose') return; // выбор уже сделан (голосом/таймером) — наклейки не нужны
    this.character.play('sticker');
    // выбор — лист внизу экрана (превью и цвет каждого характера), кот остаётся открытым
    const opts = PERSONA_IDS.map((id) => {
      const p = this.personas.get(id)!;
      return { id: p.id, title: p.title, palette: p.palette };
    });
    d.ui.showChoice(opts, (id) => {
      if (this.state.phase === 'choose' && isPersonaId(id)) this.dispatch({ type: 'choose', persona: id });
    });
    this.dispatch({ type: 'choice_shown' });
  }

  setPersona(id: string) {
    if (!isPersonaId(id)) return;
    const changed = this.personas.set(id);
    if (changed) this.queue.switchPersona(id);
    const p = this.persona;
    this.d.fx.palette = p.palette;
    this.character?.setPersona(p);
    const vp = this.d.voice as VoicePlayer & { usePersona?: (p: string) => Promise<unknown>; preloadEvents?: (p: string, ev: string[], max?: number) => void };
    void vp.usePersona?.(id);
    vp.preloadEvents?.(id, ['hello_new', 'invite', 'tap_cat', 'tap_screen', 'swipe', 'double_tap'], 1);
    if (changed) {
      this.emit('persona', id);
      this.log(`persona → ${id} (голос ${p.voice.piperVoice}, +${p.voice.pitchSemitones} пт)`);
    }
  }

  private async signature(silent = false) {
    await wait(250);
    const sig = this.personas.signature;
    // сам по себе (приветствие) — без пятен на стекле: жвачку на экран ребёнок «заслуживает» двойным тапом
    this.playVisual({ clip: sig.clip, fx: sig.fx.filter((f) => f !== 'gum_splat'), sound: sig.sound });
    if (!silent) this.speakEvent(sig.event, { visuals: false });
  }

  /** реакция на ввод: эффект/звук/клип сразу, реплика — через очередь */
  private react(event: string, quiet = false) {
    if (this.paused && this.picker.event(event).priority < 3) return;
    // «Zzz» над спящим котом — петля (fx.json: loop): сама не кончается. Без остановки буквы летали над проснувшимся
    // котом до конца сессии, а живой эффект держал энергобюджет в «boost» (60 к/с) — QA-стенд, docs/qa/BUGS.md
    if (event === 'sleep') {
      this.stopSleepFx();
      this.dozing = true;
    }
    if (event === 'wake_up') {
      this.dozing = false;
      this.stopSleepFx();
    }
    this.emotion(event);
    const tap = this.fingerTap;
    if (quiet) {
      // знакомство / мини-игра: касание видно (клип, эффект, эмоция), но слова не перебивают шаг
      const def = this.persona.reactions[event];
      if (def) this.playVisual({ clip: def.clip, fx: def.fx ? [def.fx] : [], sound: def.sound, tap, ev: event });
      return;
    }
    // тап, пока кот ещё говорит ответ на прошлый тап: без новой реплики (и без перебивания её на полуслове)
    const cur = this.queue.current;
    if (tap && cur?.priority === 1 && performance.now() - this.lastTapLineAt < TAP_LINE_HOLD_MS) {
      const def = this.persona.reactions[event];
      if (def) this.playVisual({ clip: def.clip, sound: def.sound, tap, ev: event });
      return;
    }
    const o = { name: this.state.name, prefer: this.prefer, strict: this.strictVoice, avoid: this.avoidInvite() };
    let pk = this.personas.line(event, { ...o, force: event === 'sleep' || event === 'wake_up' });
    // не понял: «переспроси» и «я пока умею…» подменяют друг друга, если одно ещё остывает, — ребёнок всегда слышит ответ
    // «что ты умеешь» — отвечаем всегда (без cooldown; варианты всё равно не повторяются подряд)
    if (!pk && event === 'unknown') pk = this.personas.line('help', o) ?? this.personas.line('unknown', { ...o, force: true });
    else if (!pk && event === 'help') pk = this.personas.line('help', { ...o, force: true });
    if (!pk) {
      if (this.picker.coolingDown(event)) return;
      const def = this.persona.reactions[event];
      if (def) this.playVisual({ clip: def.clip, fx: def.fx ? [def.fx] : [], sound: def.sound, tap, ev: event });
      else this.log(`нет реакции «${event}» у ${this.persona.id}`);
      return;
    }
    this.playVisual({ clip: pk.clip, fx: pk.fx ? [pk.fx] : [], sound: pk.sound, face: pk.face, tap, ev: event });
    if (this.enqueue(pk, false) && tap) this.lastTapLineAt = performance.now();
  }

  private get picker() {
    return this.personas.picker;
  }

  /** реплика сценария/диалога: визуал вместе с речью */
  speakEvent(event: string, o: { force?: boolean; visuals?: boolean; node?: string; scenario?: boolean; background?: boolean } = {}): boolean {
    this.emotion(event);
    const r = this.currentRiddle();
    const pk = this.personas.line(event, { name: this.state.name, vars: r ? { answer: r.answer } : {}, force: o.force, prefer: this.prefer, strict: this.strictVoice, avoid: this.avoidInvite() });
    if (!pk) {
      this.log(`реплика «${event}» не выбрана (${this.picker.coolingDown(event) ? 'cooldown' : 'нет озвученных'})`);
      return false;
    }
    // реплика сценария/диалога встаёт в очередь (не ниже 2), даже если событие само по себе — реакция («нет» в «Хочешь загадку?»)
    // фон (подсказка кота по своей инициативе) — любое действие ребёнка её перебивает
    const priority = (o.background ? 0 : o.scenario ? Math.max(pk.priority, 2) : pk.priority) as PickedLine['priority'];
    return this.enqueue({ ...pk, priority }, o.visuals !== false, o.node, r?.id);
  }

  /**
   * Подсказка «что делать» (чипы кота, app.ts): озвученной репликой help («Погладь меня пальцем или нажми кнопку внизу»),
   * если кот молчит и ни о чём не спрашивает. false — не сказал (нет записи, остывает, кот занят): UI покажет пальцем.
   */
  sayHint(): boolean {
    if (this.queue.busy || this.d.voice.speaking || this.state.dialog || this.paused || this.state.paused || this.dozing) return false;
    if (!this.hasVoiced('help')) return false;
    return this.speakEvent('help', { background: true });
  }

  /**
   * Реплика без записи ElevenLabs — только пузырём, без голоса и синтеза (новые события до прогона озвучки:
   * кровать «Мира кота»). Озвученная — обычным путём (speakEvent). false — у события нет реплик.
   */
  showLine(event: string): boolean {
    if (this.hasVoiced(event)) return this.speakEvent(event);
    const pk = this.personas.line(event, { name: this.state.name, strict: false });
    if (!pk) return false;
    const p = this.persona;
    this.d.ui.say(pk.text, p.name, p.id);
    this.emotion(event);
    return true;
  }

  /** есть ли у события хоть одна реплика, которая прозвучит живым голосом */
  hasVoiced(event: string): boolean {
    const p = this.persona;
    const ls = this.picker.candidates(p, event, this.state.name);
    if (!this.strictVoice) return ls.length > 0;
    return ls.some((l) => this.prefer(l, l.text.replace('{name}', this.picker.nameAllowed(this.state.name) ?? '')));
  }

  /**
   * Варианты реплики, которых избегаем (E2E 22.11): голоса нет (микрофон запрещён или распознавание недоступно) — те, что
   * зовут говорить («Скажи „да“»); повторялки нет в редакции (games.echo) — те, что зовут в неё («Скажи „повторяй за мной“»).
   * Мягко: picker убирает их, только если у события есть другие варианты.
   */
  private avoidInvite(): ((l: ContentLine, text: string) => boolean) | undefined {
    const v = this.d.voiceIn?.();
    const noVoice = !!v && !(v.mic && v.asr);
    const noEcho = !feature('games.echo');
    if (!noVoice && !noEcho) return undefined;
    return (_l, text) => (noVoice && SAY_INVITE.test(text)) || (noEcho && ECHO_INVITE.test(text));
  }

  /** вариант реплики прозвучит записью (а не синтезом) — такие picker выбирает в первую очередь */
  private prefer = (l: ContentLine, text: string): boolean => {
    const v = this.d.voice as VoicePlayer & { elRecorded?: (p: string, id: string | undefined, t: string, x?: string) => boolean; hasRecordings?: boolean };
    if (!v.elRecorded || !v.hasRecordings) return true;
    const p = this.persona.id;
    const r = this.currentRiddle();
    if (r && l.text.includes('{answer}') && v.elRecorded(p, `${l.id}@${r.id}`, text, text)) return true;
    return v.elRecorded(p, l.id, l.text, text);
  };

  /** на сайте есть живая озвучка — реплики без неё не произносим и не показываем (решение продакта) */
  private get strictVoice(): boolean {
    const v = this.d.voice as VoicePlayer & { hasRecordings?: boolean };
    return !!v.hasRecordings && !this.allowSynth;
  }

  private currentRiddle(): Riddle | null {
    const rs = this.persona.riddles;
    if (!rs?.length || this.state.riddleSeq <= 0) return null;
    return rs[(this.state.riddleSeq - 1) % rs.length];
  }

  private sayRiddle(part: 'q' | 'hint', node?: string) {
    const r = this.currentRiddle();
    if (!r) return;
    const p = this.persona;
    const text = part === 'q' ? r.q : r.hint;
    const vp = this.d.voice as VoicePlayer & { elRecorded?: (p: string, id: string | undefined, t: string, x?: string) => boolean };
    if (this.strictVoice && vp.elRecorded && !vp.elRecorded(p.id, `${p.id}.riddle.${r.id}.${part}`, text, text)) {
      this.log(`загадка ${p.id}.riddle.${r.id}.${part} не озвучена — пропуск`);
      return;
    }
    const pk: PickedLine = {
      persona: p.id, event: `riddle_${part}`, text, face: part === 'q' ? 'think' : 'caring',
      line: { id: `${p.id}.riddle.${r.id}.${part}`, text, emotion: 'neutral', face: 'neutral' },
      clip: 'think', priority: 2, interruptible: true,
    };
    this.enqueue(pk, true, node, r.id);
  }

  private enqueue(pk: PickedLine, visuals: boolean, tag?: string, riddleId?: string): boolean {
    // нет микрофона — кот не зовёт говорить («Скажи „повторяй за мной“»): реплики тишины, подсказок и реакций с таким
    // призывом молчат (реплики сценария — нет: голосовые занятия без микрофона и так не начинаются)
    if ((INVITE_EVENTS.has(pk.event) || pk.priority < 2) && SAY_INVITE.test(pk.text) && this.d.voiceIn && !this.d.voiceIn().mic) {
      this.log(`реплика «${pk.line.id}» зовёт говорить — без микрофона молчим`);
      return false;
    }
    const ok = this.queue.say({
      persona: pk.persona, event: pk.event, priority: pk.priority, interruptible: pk.interruptible, tag, owner: this.owner || undefined,
      run: () => this.perform(pk, visuals, riddleId, !tag),
    });
    if (!ok) this.log(`реплика «${pk.line.id}» отброшена очередью`);
    return ok;
  }

  private async perform(pk: PickedLine, visuals: boolean, riddleId?: string, free = true) {
    const p = this.personas.get(pk.persona)!;
    // новый кот говорит, когда его модель уже на сцене (не над прежним котом)
    if (this.charReady && !this.charReady(pk.persona)) {
      for (let i = 0; i < 50 && !this.charReady(pk.persona); i++) await wait(100);
      if (this.persona.id !== pk.persona) return;
    }
    // одинаковая реплика (реакция, не шаг игры) — не чаще раза в 8 с
    if (free && pk.priority < 3 && !this.dedupe.allow(pk.text)) {
      this.log(`🔁 «${pk.text.slice(0, 32)}» — повтор, пропуск`);
      return;
    }
    const vp = this.d.voice as VoicePlayer & { recorded?: (p: string, id: string | undefined, t: string, x?: string) => boolean; elRecorded?: (p: string, id: string | undefined, t: string, x?: string) => boolean; hasRecordings?: boolean; usePersona?: (p: string) => Promise<unknown> };
    // ответ загадки целиком одной записью («Ответ — огурец.»), а не склейкой «Ответ —» + «огурец»; загадка — та, что была при выборе
    let lineId = pk.line.id, template = pk.line.text;
    if (riddleId && pk.line.text.includes('{answer}') && vp.elRecorded?.(p.id, `${pk.line.id}@${riddleId}`, pk.text, pk.text)) {
      lineId = `${pk.line.id}@${riddleId}`;
      template = pk.text;
    }
    // записи нет, а озвучка на сайте есть — реплика не звучит и не показывается (ни робот-голоса, ни немого пузыря)
    if (vp.elRecorded && vp.hasRecordings && !this.allowSynth && !vp.elRecorded(p.id, lineId, template, pk.text)) {
      this.log(`🔇 нет записи ${lineId} — пропуск`);
      return;
    }
    const v = p.voice;
    const req: SpeakRequest & { lineId: string; piperVoice: string; pitchSemitones: number; emotion: string } = {
      persona: p.id, template, text: pk.text, pitch: semis(v.pitchSemitones), rate: v.rate,
      lineId, piperVoice: v.piperVoice, pitchSemitones: v.pitchSemitones, emotion: pk.line.emotion,
    };
    // пузырь = голос (iPhone 20.11: «озвучка запаздывает» — пузырь и реакция шли до сети и декодирования mp3).
    // Запись ещё не декодирована — ждём её не дольше VOICE_WARM_WAIT_MS (реакция и звук вместе), пузырь и «говорящий»
    // клип — в момент слышимого старта звука (VoicePlayer.speak onStart). Плеер без onStart (стенды) — как раньше, сразу.
    const sv = this.d.voice as VoicePlayer & { startHook?: boolean; isWarm?: (r: SpeakRequest) => boolean; warmLine?: (r: SpeakRequest) => Promise<void> };
    const hooked = !!sv.startHook;
    if (hooked && sv.isWarm && sv.warmLine && !sv.isWarm(req)) {
      const mine = this.queue.current;
      const t0 = performance.now();
      await Promise.race([sv.warmLine(req).catch(() => undefined), wait(VOICE_WARM_WAIT_MS)]);
      if (this.queue.current !== mine) return; // пока грузилась — перебили: не звучим поверх новой
      this.log(`⏱ ${lineId}: запись готовилась ${Math.round(performance.now() - t0)} мс`);
    }
    if (visuals) this.playVisual({ clip: pk.clip, fx: pk.fx ? [pk.fx] : [], sound: pk.sound, face: pk.face, ev: pk.event });
    else this.face(pk.face);
    // пузырь живёт ровно столько, сколько звучит реплика (скрывается в конце, а не по таймеру длины текста)
    const shown = this.bubbleText(pk);
    this.emit('log', `🗨 ${lineId}: ${pk.text}`);
    if (pk.event === 'meet_skills') this.startCoach();
    let talk = false;
    let on = false;
    const show = () => {
      if (on) return;
      on = true;
      this.d.ui.say(shown, p.name, p.id, 60_000);
      this.emit('line_start', { id: lineId, at: performance.now() });
      // покой — и вариант покоя (idle_look_around…): кот начинает «говорить» телом
      talk = /^idle/.test(this.character.currentClip) && !this.d.stage.walking && !this.bodyBusy?.() && !this.actBusy();
      if (talk) this.character.play('talk', { loop: true });
    };
    if (!hooked) show();
    try {
      await (this.d.voice.speak as (r: SpeakRequest, h?: { onStart?: () => void }) => Promise<void>)(req, { onStart: show });
    } finally {
      this.lastCatEnd = performance.now();
      if (on) this.d.ui.hideBubble?.(shown);
      if (talk && this.character.currentClip === 'talk') this.character.play('idle');
      // лицо реплики — на время реплики: сон и мурчание держат своё (их снимает пробуждение / конец глажки)
      if (pk.face && this.lineFace === pk.face && !this.dozing && !/purr|sleep/.test(pk.face)) {
        this.lineFace = null;
        const ch = this.character as Character & { setFace?: (p: string) => void };
        ch.setFace?.('neutral');
      }
    }
  }

  /**
   * Текст пузыря. Вступление к подсказке загадки («Подумай ещё. Подсказка:») — отдельная запись, а сама подсказка
   * звучит следующей репликой (или пропускается, если не озвучена): в пузыре вступление с пустым хвостом «Подсказка:»
   * висело 1,5–2 с (запись продакта 18.11). Показываем его сразу с текстом подсказки.
   */
  private bubbleText(pk: PickedLine): string {
    const t = pk.text;
    const nm = this.bubbleName(pk);
    if (nm) return `${nm}! ${t}`;
    if (pk.event !== 'riddle_hint' || !/[:—–-]\s*$/.test(t)) return t;
    const hint = this.currentRiddle()?.hint?.trim();
    return hint ? `${t} ${hint}` : t.replace(/\s*[:—–-]\s*$/, '.');
  }

  /**
   * Имя без записи (нет в словаре names.ru.txt или у этого кота нет слота с этим именем): кот говорит записанный
   * вариант без {name} (picker), а имя показываем только в пузыре — «Ксюша! Красивое имя…». Голосом имя не звучит
   * (ни синтеза, ни Piper), имя никуда не уходит и не запоминается, если его нет в словаре (как и раньше).
   */
  private heardName: { name: string; at: number } | null = null;
  bubbleName(pk: Pick<PickedLine, 'event' | 'text' | 'line'>): string | null {
    if (pk.line.text.includes('{name}')) return null; // имя уже в реплике (и в записи)
    let name: string | null = null;
    if (pk.event === 'nice_name' && this.heardName && performance.now() - this.heardName.at < 60_000) name = this.heardName.name;
    else if (pk.event === 'welcome_back') name = this.state.name ?? null;
    name = name?.trim().replace(/[<>{}]/g, '').slice(0, 24) ?? null;
    if (!name || pk.text.toLowerCase().includes(name.toLowerCase())) return null;
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  /** повторялка, ветка «*» без записи: echo_done следом не говорим */
  private echoSkipped = false;

  /** повторялка: фраза ребёнка голосом характера (выше тоном) */
  private echo(text: string) {
    const p = this.persona;
    const v = p.voice;
    const t = text.trim().slice(0, 120);
    const vp = this.d.voice as VoicePlayer & { echoReady?: () => boolean; synthAllowed?: boolean };
    // записи нет, а синтез выключен (пилот) — повторять нечего: ни пузыря, ни «мой голос круче»
    this.echoSkipped = !!vp.echoReady && !vp.echoReady() && (vp.synthAllowed === false || t === '…');
    if (!t || this.echoSkipped) return;
    // ребёнок тараторит: повторяем последнюю фразу, а не копим очередь из повторов (docs/qa/BUGS.md № 25)
    const cur = this.queue.current;
    this.queue.drop((it) => it !== cur && (it.event === 'echo' || it.tag === 'echo.repeat'));
    this.queue.say({
      persona: p.id, event: 'echo', priority: 2, interruptible: true, tag: 'echo.say',
      run: async () => {
        this.d.ui.say(t, p.name, p.id, 60_000);
        const voice = this.d.voice as VoicePlayer & { echo?: (t: string, o: { persona: string; pitchSemitones: number; rate: number }) => Promise<void> };
        try {
          if (voice.echo) await voice.echo(t, { persona: p.id, pitchSemitones: v.echoPitchSemitones, rate: v.echoRate });
          else await this.d.voice.speak({ persona: p.id, template: `echo:${t}`, text: t, pitch: semis(v.echoPitchSemitones), rate: v.echoRate });
        } finally {
          this.lastCatEnd = performance.now();
          this.d.ui.hideBubble?.(t);
        }
      },
    });
  }

  /** мягкая остановка: дождаться закрытого рта (граница слога), максимум 300 мс */
  private stopVoice(soft: boolean): Promise<void> | void {
    const v = this.d.voice as VoicePlayer & { fadeOut?: (ms?: number) => void };
    const stop = (ms: number) => (v.fadeOut ? v.fadeOut(ms) : v.cancel());
    if (!soft || !v.speaking) return stop(120);
    return new Promise<void>((resolve) => {
      const t0 = performance.now();
      const tick = () => {
        const dom = v.lip.dominant;
        if (!v.speaking || dom === 'X' || dom === 'A' || performance.now() - t0 > 300) {
          stop(60);
          setTimeout(resolve, 70);
        } else setTimeout(tick, 25);
      };
      tick();
    });
  }

  /** эмоция события поверх лица реплики (src/character/emotions.ts): радость при тапе, удивление при находке карты… */
  private emotion(event: string) {
    const cue = emotionFor(event, this.persona.id) ?? EXTRA_EMOTION[event] ?? null;
    const ch = this.character as Character & { setEmotion?: (n: string, w?: number, ms?: number) => void };
    if (cue && ch?.setEmotion) ch.setEmotion(cue[0], cue[1], cue[2]);
  }

  /**
   * Лицо к нейтральному (отмена/вытеснение действия, смена обстановки): пресет реплики и задержавшаяся эмоция снимаются,
   * глаза моргают (GlbCharacter.resetFace). Дрёма держит сон — её снимает пробуждение.
   */
  private resetFace() {
    if (this.dozing) return;
    this.lineFace = null;
    (this.character as Character & { resetFace?: () => void })?.resetFace?.();
  }

  /** последний пресет лица реплики: по концу реплики лицо возвращается к нейтральному (а не держит «annoyed» до следующей) */
  private lineFace: string | null = null;
  private face(preset: string | undefined) {
    if (!preset || !this.character) return;
    this.lineFace = preset;
    const ch = this.character as Character & { setFace?: (p: string) => void };
    if (ch.setFace) ch.setFace(preset);
    else if (FACE_EMOTE[preset]) ch.emote(FACE_EMOTE[preset], 1400);
  }

  private playVisual(v: { clip?: string; fx?: string[]; sound?: string; face?: string; tap?: boolean; ev?: string }) {
    const d = this.d;
    const snd = runtimeSound(v.sound, (s) => d.audio.has(s));
    if (snd) d.audio.play(snd);
    // клип Meshy на этом событии / кнопке (content/animations.json meshy.on), если он пришёл; иначе — как было
    const where = [v.ev, this.curAction ? `action:${this.curAction}` : undefined].filter((x): x is string => !!x);
    const up = where.length ? meshyUpgrade(where, v.clip, this.persona.id, (id) => this.isMeshy(id)) : v.clip;
    if (up !== v.clip) this.log(`🎞 Meshy: ${v.clip ?? '—'} → ${up} (${where.join(', ')})`);
    const clip = runtimeClip(up);
    const now = performance.now();
    // тапы чаще TAP_CLIP_HOLD_MS — клип прошлого тапа доигрывает (а не 5 смен позы за 0,3 с)
    const held = v.tap && now - this.lastTapClipAt < TAP_CLIP_HOLD_MS;
    if (clip && !d.stage.walking && !held && !this.bodyBusy?.() && !this.actBusy()) {
      this.playChained(clip);
      if (v.tap) this.lastTapClipAt = now;
      this.guardLoop(clip);
    }
    for (const f of v.fx ?? []) void this.runFx(f);
    this.face(v.face);
  }

  /**
   * Петля реакции (talk_excited, listen, press_glass, peek_from_edge, танец…) сама не кончается: раньше кот после
   * «help» / «invite» / долгого нажатия так и стоял в «говорящей» позе (docs/qa/BUGS.md № 21). Возврат в покой —
   * когда реплика кончилась и прошло LOOP_MAX_MS (танец — DANCE_MAX_MS).
   */
  private guardLoop(clip: string) {
    const def = resolveClip(clip, this.persona.id);
    if (def?.layer === 'additive') return; // уши/хвост поверх тела — петлю тела не трогают
    clearTimeout(this.loopTimer);
    this.loopTimer = 0;
    if (!def?.loop || LOOP_KEEP.test(def.id)) return;
    if (meshyChain(def.id, (id) => this.isMeshy(id))?.holdS) return; // петля цепочки Meshy (sit_idle) уходит сама — playChained
    const t0 = performance.now();
    const check = () => {
      this.loopTimer = 0;
      if (!this.character || this.character.currentClip !== clip || this.d.stage.walking) return;
      if ((this.d.voice.speaking || this.queue.busy) && performance.now() - t0 < 30_000) {
        this.loopTimer = window.setTimeout(check, 400);
        return;
      }
      this.character.play('idle');
    };
    this.loopTimer = window.setTimeout(check, /^dance/.test(def.id) ? DANCE_MAX_MS : LOOP_MAX_MS);
  }

  /**
   * Точка для наклейки вне морды кота: сбоку от головы (с той стороны, где больше места), иначе над макушкой или у лап.
   * Морда — как в QA-стенде: центр головы ± 0,7 полуширины, от макушки до подбородка (ui.catRect).
   */
  private besideFace(p: { x: number; y: number }, w: number, h: number): { x: number; y: number } {
    const r = this.d.ui.catRect?.();
    if (!r) return p;
    const size = Math.min(w, h) * 0.3; // наклейка ≈ 0,22–0,3 × короткая сторона × масштаб до 1,2 (stickerSheet)
    const half = size / 2 + 10;
    const face = { l: r.cx - r.half * 0.7, r: r.cx + r.half * 0.7, t: r.top, b: r.headY + (r.bottom - r.headY) * 0.15 };
    const clear = (x: number, y: number) => x + half <= face.l || x - half >= face.r || y + half <= face.t || y - half >= face.b;
    if (clear(p.x, p.y)) return p;
    const y = Math.max(half + 70, Math.min(h * 0.62, r.headY + rand(-0.15, 0.25) * size));
    const left = face.l - half, right = face.r + half;
    const sides = (r.cx > w / 2 ? [left, right] : [right, left]).filter((x) => x - size * 0.4 >= 0 && x + size * 0.4 <= w);
    if (sides.length) return { x: sides[0], y };
    // кот на весь экран: над макушкой, иначе у лап — с краю
    if (face.t - size >= 70) return { x: r.cx + rand(-0.3, 0.3) * size, y: face.t - half };
    return { x: r.cx > w / 2 ? half : w - half, y: Math.min(h - half - 160, Math.max(face.b + half, r.bottom - half)) };
  }

  /** контентный эффект: сначала родной API FxLayer (если научится), иначе запасной из runtimeMap */
  async runFx(id: string) {
    const d = this.d;
    // заклеивание экрана при смене образа делает команда cover_stickers — второй раз из реплики не нужен
    if (id === 'stickers_cover') return;
    if (this.fxGate && !this.fxGate(this.persona.id, id)) return this.log(`[fx] ${id} — не в наборе редакции`);
    if (performance.now() < this.muteFxUntil && id !== 'zzz') return;
    if (id === 'sticker' || id === 'tag_spray') {
      // наклейки не копятся: на стекле не больше трёх, старая улетает
      const own = d.fx.stickers.filter((x) => !x.flying && !x.choice && !x.cover);
      for (const x of own.slice(0, Math.max(0, own.length - 2))) {
        x.flying = true;
        x.vx = rand(-500, 500);
        x.vy = -700;
        x.vr = rand(-5, 5);
      }
    }
    if (COVER_FX.has(id)) {
      // закрывающий экран эффект — только по действию ребёнка и не чаще раза в 10 с (смена образа — по просьбе ребёнка)
      const now = performance.now();
      const byUser = now - this.lastUserAct < USER_ACT_MS || this.state.phase === 'switching';
      if (!byUser || now - this.lastCoverAt < COVER_GAP_MS) {
        this.log(`[fx] ${id} пропущен (${byUser ? 'слишком часто' : 'не по действию ребёнка'})`);
        return;
      }
      this.lastCoverAt = now;
    }
    const { w, h } = d.size();
    const pal = this.persona.palette;
    const tune = this.personas.fxTuning(id);
    let at = this.ctx.x !== undefined ? { x: this.ctx.x, y: this.ctx.y! } : d.stage.headScreen(w, h, BURST_FX.has(id) ? 0.22 : 0.6);
    // наклейка — на стекло сбоку от головы, не на морду (QA, docs/qa/BUGS.md № 11): закрывала кота и перехватывала тап по нему
    if (id === 'sticker' || id === 'tag_spray') at = this.besideFace(at, w, h);
    const generic = (d.fx as FxLayer & { play?: (id: string, o: Record<string, unknown>) => boolean | void }).play;
    if (generic && generic.call(d.fx, id, { at, palette: pal, tuning: tune, from: this.ctx.from ?? this.lastSwipe, path: this.ctx.path }) !== false) return;
    const f: FxName | null = runtimeFx(id);
    switch (f) {
      case 'glitter_burst':
        d.fx.burst(at.x, at.y, pal.fx, tune.count ?? 36);
        break;
      case 'glitter_trail':
        d.fx.trail(this.ctx.path ?? [at], pal.fx);
        break;
      case 'snow_globe':
        d.fx.snowGlobe(pal.fx);
        break;
      case 'knock':
        d.fx.knock(at.x, at.y);
        break;
      case 'claws':
        d.fx.claws(this.ctx.from ?? this.lastSwipe ?? { x: w * 0.2, y: h * 0.4 }, at);
        break;
      case 'glitch':
        d.fx.glitch(550);
        break;
      case 'gum_bubble': {
        if (Date.now() < this.busyUntil) return;
        this.busyUntil = Date.now() + 2500;
        const m = d.stage.headScreen(w, h, 0.62);
        const lt = this.lastTouch;
        const byTouch = !!lt && /tap|spam|longpress/.test(lt.kind) && Date.now() - lt.at < 1500;
        await d.fx.gumBubble(m.x, m.y, pal.accent, byTouch);
        d.audio.play('gum_pop');
        if (byTouch) d.audio.play('gum_splat', 0.8);
        break;
      }
      case 'steam_heart':
        if (d.fx.fogActive) return;
        await d.fx.steamHeart();
        d.audio.play('chime');
        break;
      case 'glass_cat': {
        const poster = this.character.posterImage();
        if (poster) {
          d.fx.glassCatShow(poster, 2600);
          d.stage.hideFor(2600);
        } else {
          d.stage.setMode('glass');
          await wait(2600);
          if (d.tracker.isTracking || d.tracker.capabilities.worldTracking) d.stage.setMode('card');
        }
        break;
      }
      case 'sticker': {
        const s = this.persona.stickers;
        d.fx.addSticker(s[Math.floor(Math.random() * s.length)], at.x, at.y);
        break;
      }
    }
  }

  // ───────────── debug / API ─────────────
  /** проиграть реплику по id («kind.intro.02») — характер переключается на владельца реплики */
  sayLine(id: string): boolean {
    const pk = this.picker.byId(this.d.content.personas, id, { name: this.state.name });
    if (!pk) return false;
    if (pk.persona !== this.personas.id) this.setPersona(pk.persona);
    this.queue.clear();
    return this.enqueue({ ...pk, priority: 2, interruptible: true }, true);
  }

  /** проиграть событие активным характером (без cooldown) */
  playEvent(event: string): boolean {
    this.queue.clear();
    return this.speakEvent(event, { force: true });
  }

  /** совместимость со старой debug-панелью: произнести текст голосом характера */
  speakText(personaId: string, text: string) {
    const p = this.personas.get(personaId as PersonaId) ?? this.persona;
    this.d.ui.say(text, p.name, p.id);
    this.queue.clear();
    this.queue.say({ persona: p.id, event: 'debug', priority: 2, interruptible: true, run: () => this.d.voice.speak({ persona: p.id, template: text, text, pitch: semis(p.voice.pitchSemitones), rate: p.voice.rate }) });
  }

  /** каждый кадр */
  update(dt: number) {
    const v = this.d.voice;
    v.update(dt);
    const lip = v.lip;
    this.character?.setMouth(lip.dominant, lip.weights[lip.dominant], lip.shape);
    // моргание чаще во время речи
    if (v.speaking && (this.blinkT += dt) > 2.2 + Math.random() * 2) {
      this.blinkT = 0;
      this.character?.emote('blink', 150);
    }
    const playing = this.state.phase === 'play' || this.state.phase === 'free';
    this.turnStep(playing && !this.actBusy());
    this.orchTick();
    // idle-набор характера с весами (в дрёме — нет)
    if (playing && !this.dozing && !v.speaking && this.character?.currentClip === 'idle' && !this.d.stage.walking) {
      if ((this.idleT += dt) > 8 + Math.random() * 4) {
        this.idleT = 0;
        const clip = runtimeClip(this.personas.pickIdle());
        // вариант покоя — один проход: петля (idle_breathe, наушники) иначе играла до конца сессии, currentClip
        // переставал быть 'idle' — больше ни вариантов, ни «говорящего» тела на репликах (docs/qa/BUGS.md № 22)
        if (clip && clip !== 'idle') this.character.play(clip, CLIPS[clip].loop ? { loop: false } : {});
      }
    } else this.idleT = 0;
    this.idleTick(playing);
  }

  /** оркестратор: конец текущего действия (тело в покое, своих реплик нет) → ждавшее действие; отложенная смена кота */
  private orchTick() {
    const ch = this.character;
    const tok = this.orch.token;
    const own = tok ? this.queue.current?.owner === tok || this.queue.pending.some((it) => it.owner === tok) : false;
    // смена кота держит оркестратор, пока экран заклеен (ждём встряску до 15 с): раньше «switch» кончался через
    // 1,2 с «тело в покое», и кнопки запускались поверх наклеек
    const switching = !!this.switchTok && this.state.phase === 'switching';
    const busy = switching || this.actBusy() || own || (!!ch && !/^(idle|talk)$/.test(ch.currentClip)) || this.d.stage.walking;
    const next = this.orch.tick(busy);
    if (next) this.action(next);
    const df = this.deferred;
    if (df && !this.orch.blocking()) {
      this.deferred = null;
      if (performance.now() - df.at < 12_000) this.dispatch(df.e);
    }
  }

  /** лестница тишины: «ты тут?» → предложить занятие → мысль вслух → другое занятие → дрёма (docs/scenario/LOGIC.md) */
  private idleTick(playing: boolean) {
    const now = performance.now();
    const t = turn.get();
    const quiet = playing && this.state.cardVisible && !this.dozing && !this.paused && !this.state.paused && !this.state.dialog && !this.queue.busy && !this.d.voice.speaking && !this.d.stage.walking && !t.userSpeaking;
    const step = this.ladder.due(now, { quiet, lastCatEnd: this.lastCatEnd });
    if (!step) return;
    this.log(`тишина ${(this.ladder.quietFor(now) / 1000).toFixed(0)} с → ${step}`);
    this.ladder.fired(now);
    this.idleStep(step);
  }

  private idleStep(step: IdleStep) {
    switch (step) {
      case 'silence':
        return this.dispatch({ type: 'silence', byCat: true });
      case 'offer':
        return this.offerNext();
      case 'filler':
        this.speakEvent('filler');
        return;
      case 'doze':
        this.react('sleep');
        return;
    }
  }

  /** следующее по кругу занятие, у которого есть озвученный вопрос; нет ни одного — подсказка «скажи…» (bored) */
  private offerNext() {
    for (let i = 0; i < OFFERS.length; i++) {
      const what = OFFERS[(this.offerIdx + i) % OFFERS.length];
      if (!this.voiceOk(what)) continue; // голоса нет — не предлагаем занятия, где отвечают голосом
      if (this.hasVoiced(`offer_${what}`)) {
        this.offerIdx = (this.offerIdx + i + 1) % OFFERS.length;
        return this.dispatch({ type: 'offer', what });
      }
    }
    return this.react('bored');
  }

  /**
   * Занятие возможно без голоса? Загадка и угадайки (emo, rps) — ответ голосом: нужны микрофон и модель; повторялка —
   * только микрофон (повтор без распознавания). Остальное — кнопками.
   */
  voiceOk(what: string): boolean {
    if (what === 'echo' && !feature('games.echo')) return false;
    const v = this.d.voiceIn?.();
    if (!v) return true;
    if (what === 'echo') return v.mic;
    if (what === 'riddle' || what === 'emo' || what === 'rps') return v.mic && v.asr;
    return true;
  }

  /** любая активность пользователя (касание, голос) откладывает инициативу кота */
  activity() {
    turn.userActivity();
  }

  /**
   * Тестовые флоу (?flow=…, src/debug/flows.ts, страница /test): прыжок в состояние после посадки кота.
   * Мини-игры — как кнопка каталога, «дрёма» — как после 110 с тишины, «смена» и «грустно» — как сказал ребёнок.
   */
  flow(name: string): boolean {
    switch (name) {
      case 'riddle':
      case 'echo':
      case 'emo':
      case 'rps':
      case 'simon':
        this.action(name);
        return true;
      case 'doze':
        this.ladder.fired(performance.now());
        this.react('sleep');
        return true;
      case 'switch':
        this.text('давай другого');
        return true;
      case 'sad':
        this.text('мне грустно');
        return true;
      case 'outro':
        this.dispatch({ type: 'outro_request' });
        return true;
    }
    this.log(`нет флоу «${name}»`);
    return false;
  }

  static readonly kidsUrl = ASSETS.sberKidsUrl;
}

/** полутоны → pitch speechSynthesis (0.5…2) */
const semis = (st: number) => Math.max(0.5, Math.min(2, Math.pow(2, st / 12)));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
