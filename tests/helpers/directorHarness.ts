/**
 * Режиссёр на фейковом времени (vitest fake timers): настоящий контент (content/personas, dialogs.json, events.json),
 * настоящий набор озвученного (voice-src/el_batch_all.jsonl — то, что лежит на сервере), настоящие автомат,
 * очередь реплик и лестница тишины. Подменены только «железо»: сцена, эффекты, звук, интерфейс и плеер
 * (запись «звучит» столько, сколько живая речь: 0,45 с + 1 с на 14 символов).
 *
 *   const h = await makeDirector({ memory: { met: true, name: 'Маша', persona: 'kind' } });
 *   await h.boot();              // разбудить → карта → кот вышел
 *   await h.tick(30_000);        // 30 с тишины
 *   h.spoken()                   // [{ t, id, event, text }] — что кот сказал
 */
import fs from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';
import { loadTestContent } from './content';
import type { ContentBundle } from '../../src/persona/content';
import { turn } from '../../src/voice/turn';

export interface Spoken { t: number; id: string; text: string; event: string; template?: string }

const root = path.resolve(__dirname, '../..');

/** озвученное на сервере: id → текст (реплики, куски со слотом, значения слотов) */
export function loadVoiced(file = 'voice-src/el_batch_all.jsonl'): Map<string, { t: string; kind: string }> {
  const m = new Map<string, { t: string; kind: string }>();
  for (const l of fs.readFileSync(path.join(root, file), 'utf8').trim().split('\n')) {
    const j = JSON.parse(l);
    m.set(j.id, { t: j.t ?? j.v ?? '', kind: j.kind ?? 'line' });
  }
  return m;
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9{}]+/g, ' ').trim();

/** «живой голос» по набору записей — те же правила, что VoicePlayer.elFor (id с проверкой текста, иначе по тексту; слот — кусками) */
export function makeVoicedCheck(voiced: Map<string, { t: string; kind: string }>) {
  const byText = new Map<string, string>();
  for (const [id, e] of voiced) if (e.kind === 'line') byText.set(`${id.split('.')[0]}:${norm(e.t)}`, id);
  return (persona: string, lineId: string | undefined, template: string, text = template): boolean => {
    const m = template.match(/\{(name|answer)\}/);
    if (!m) {
      if (lineId && voiced.get(lineId)?.kind === 'line' && norm(voiced.get(lineId)!.t) === norm(template)) return true;
      return byText.has(`${persona}:${norm(template)}`);
    }
    if (!lineId) return false;
    const i = template.indexOf(m[0]);
    const pre = template.slice(0, i), post = template.slice(i + m[0].length);
    const val = text.slice(pre.length, text.length - post.length).trim();
    const a = pre.trim() ? voiced.has(`${lineId}~a`) : true;
    const b = post.replace(/^[,.!?…\s]+/, '') ? voiced.has(`${lineId}~b`) : true;
    return a && b && voiced.has(`${persona}.slot.${m[1]}.${val}`);
  };
}

/** объект, у которого любой метод есть и ничего не делает (сцена, эффекты, звук) */
const anything = <T extends object>(base: T): T =>
  new Proxy(base, {
    get(t, k) {
      if (k in t) return (t as Record<string | symbol, unknown>)[k];
      if (k === 'then') return undefined;
      return () => undefined;
    },
  });

export interface HarnessOpts {
  memory?: Record<string, unknown> | null;
  /** набор озвученного (по умолчанию el_batch_all.jsonl) */
  voiced?: Map<string, { t: string; kind: string }>;
  seed?: number;
}

export async function makeDirector(o: HarnessOpts = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = globalThis;
  const store = new Map<string, string>();
  if (o.memory) store.set('sber-ar-cat:v1', JSON.stringify({ lastVisitAt: Date.now() - 3600_000, ...o.memory }));
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k), clear: () => store.clear() };
  turn.reset();
  // детерминированный выбор вариантов
  let x = o.seed ?? 7;
  vi.spyOn(Math, 'random').mockImplementation(() => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648));

  const content: ContentBundle = loadTestContent();
  const voiced = o.voiced ?? loadVoiced();
  const isVoiced = makeVoicedCheck(voiced);
  const t0 = performance.now();
  const T = () => +((performance.now() - t0) / 1000).toFixed(2);
  const spoken: (Spoken & { end?: number; interrupted?: boolean })[] = [];
  const bubble: { t: number; on: boolean; text: string }[] = [];
  const listens: { t: number; mode?: string }[] = [];

  let gen = 0;
  let endCur: (() => void) | null = null;
  const voice = {
    hasRecordings: true,
    speaking: false,
    lip: { dominant: 'X', weights: { X: 1 } as Record<string, number>, shape: undefined },
    update() {},
    elRecorded: (p: string, id: string | undefined, tpl: string, text?: string) => isVoiced(p, id, tpl, text),
    recorded: (p: string, id: string | undefined, tpl: string, text?: string) => isVoiced(p, id, tpl, text),
    usePersona: async () => null,
    preloadEvents() {},
    cancel() {
      gen++;
      voice.speaking = false;
      const s = spoken[spoken.length - 1];
      if (s && s.end === undefined) (s.end = T()), (s.interrupted = true);
      endCur?.();
      endCur = null;
    },
    fadeOut() {
      voice.cancel();
    },
    async speak(req: { lineId?: string; text: string; template: string }) {
      voice.cancel();
      const my = ++gen;
      const id = req.lineId ?? req.template;
      spoken.push({ t: T(), id, text: req.text, template: req.template, event: id.split('.').slice(1, -1).join('.') || id });
      voice.speaking = true;
      const dur = 450 + (req.text.length / 14) * 1000;
      await new Promise<void>((r) => {
        endCur = r;
        setTimeout(r, dur);
      });
      if (my === gen) {
        voice.speaking = false;
        const s = spoken[spoken.length - 1];
        if (s.end === undefined) s.end = T();
        endCur = null;
      }
    },
  };
  let bubbleText = '';
  const ui = anything({
    say(text: string) {
      bubbleText = text;
      bubble.push({ t: T(), on: true, text });
    },
    hideBubble(text?: string) {
      if (text !== undefined && text !== bubbleText) return;
      bubble.push({ t: T(), on: false, text: bubbleText });
    },
  });
  let clip = 'idle';
  const clips: { t: number; clip: string }[] = [];
  const character = anything({
    get currentClip() {
      return clip;
    },
    play(c: string) {
      clip = c === 'talk' ? 'talk' : c;
      if (c !== 'talk' && c !== 'idle') clips.push({ t: T(), clip: c });
      // клипы реакций короткие: через 1,2 с снова idle
      if (c !== 'talk' && c !== 'idle' && !/loop|sleep/.test(c)) setTimeout(() => clip === c && (clip = 'idle'), 1200);
    },
    posterImage: () => null,
  });
  const tracker = anything({
    capabilities: { imageTarget: true, worldTracking: false, orientationFallback: false },
    isTracking: true,
    aspect: 1.586,
    found: [] as (() => void)[],
    lost: [] as (() => void)[],
    onFound(f: () => void) {
      this.found.push(f);
    },
    onLost(f: () => void) {
      this.lost.push(f);
    },
  });
  const stage = anything({ walking: false, atGlass: false, cfg: { lostHoldMs: 2500, worldWalkRadius: 1 }, headScreen: () => ({ x: 200, y: 300 }) });
  /** эффекты: что запущено и что остановлено (петли вроде «Zzz» сами не кончаются) */
  const fxLog: { t: number; op: 'play' | 'stop'; id: string }[] = [];
  const fx = anything({
    stickers: [] as unknown[], palette: {}, fogActive: false, cover: () => new Promise<void>((r) => setTimeout(r, 3400)),
    play: (id: string) => void fxLog.push({ t: T(), op: 'play', id }),
    stop: (id: string) => void fxLog.push({ t: T(), op: 'stop', id }),
  });
  const audio = anything({ has: () => true });

  const { Director } = await import('../../src/director');
  const d = new Director({
    tracker: tracker as never, stage: stage as never, fx: fx as never, audio: audio as never, voice: voice as never, ui: ui as never,
    content, glCanvas: { classList: { toggle() {} } } as never, size: () => ({ w: 390, h: 844 }),
    listen: (_ms: number, mode?: string) => void listens.push({ t: T(), mode }),
    stopListen: () => undefined,
  });
  d.setCharacter(character as never);
  const log: { t: number; s: string }[] = [];
  d.on('log', (s) => log.push({ t: T(), s }));

  /** продвинуть время шагами по 100 мс (кадры режиссёра + таймеры + промисы) */
  const tick = async (ms: number) => {
    for (let left = ms; left > 0; left -= 100) {
      await vi.advanceTimersByTimeAsync(Math.min(100, left));
      d.update(Math.min(100, left) / 1000);
    }
  };
  /** дождаться условия (не дольше ms) */
  const until = async (f: () => boolean, ms = 30_000) => {
    for (let i = 0; i < ms / 100 && !f(); i++) await tick(100);
    return f();
  };
  const listening = () => !!d.state.dialog?.listening && !d.queue.busy;
  return {
    d, voice, spoken, bubble, listens, clips, log, fxLog, T, tick, until, voiced, isVoiced,
    /** кот договорил и ждёт ответ (микрофон открыт) */
    listening,
    async boot() {
      d.dispatch({ type: 'wake' });
      d.dispatch({ type: 'card_found' });
      await until(() => d.state.phase !== 'appear', 5000);
    },
    lost: () => tracker.lost.forEach((f) => f()),
    found: () => tracker.found.forEach((f) => f()),
    events: (from = 0) => spoken.filter((s) => s.t >= from).map((s) => s.event),
    done() {
      vi.useRealTimers();
      vi.restoreAllMocks();
    },
  };
}
