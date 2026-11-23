/**
 * Голосовой вход на iPhone (жалоба продакта 23.11: «кот не слушает, будто микрофона нет»):
 *  - MicInput: открытие не виснет на ctx.resume() «interrupted»-контекста и на загрузке AudioWorklet; сторож входа
 *    («не слышу»: контекст спит / кадров нет / нули / дорожка заглушена / завершилась → открыть заново);
 *  - VoiceEngine: пока модель не в памяти, голос из комнаты не держит кота и не запускает загрузку 45 МБ, ребёнку —
 *    одна подсказка «кот ещё учится слушать» (не чаще 20 с); индикатор на кнопке (status).
 *  - имя без записи: кот говорит записанную реплику без имени, имя — только в пузыре.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { MicInput, MIC_RESUME_WAIT_MS } from '../src/voice/mic';
import { VoiceEngine } from '../src/voice/engine';
import { makeDirector } from './helpers/directorHarness';

beforeAll(() => {
  (globalThis as any).window ??= globalThis;
});
afterEach(() => vi.useRealTimers());

/** контекст как на iPhone после камеры: «interrupted», resume() не отвечает никогда */
function fakeCtx(state = 'interrupted') {
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } });
  return {
    state,
    sampleRate: 48000,
    destination: {},
    resume: vi.fn(() => new Promise(() => {})),
    createMediaStreamSource: vi.fn(() => node()),
    createGain: vi.fn(() => node()),
    createScriptProcessor: vi.fn(() => ({ ...node(), onaudioprocess: null })),
    audioWorklet: undefined,
  };
}
function fakeTrack() {
  return { readyState: 'live', muted: false, onended: null as null | (() => void), stop: vi.fn() };
}
function fakeStream(track = fakeTrack()) {
  return { getAudioTracks: () => [track], getTracks: () => [track], track } as unknown as MediaStream & { track: ReturnType<typeof fakeTrack> };
}
function micWith(ctx: ReturnType<typeof fakeCtx>) {
  (globalThis as any).navigator ??= {};
  const nav = globalThis.navigator as any;
  nav.mediaDevices = { getUserMedia: vi.fn(async () => fakeStream()) };
  const audio = { ctx, unlocked: true } as any;
  return new MicInput(audio);
}

describe('MicInput: открытие не виснет на iOS', () => {
  it('ctx.resume() не отвечает (interrupted) — микрофон всё равно открывается за ≈ MIC_RESUME_WAIT_MS', async () => {
    vi.useFakeTimers();
    const ctx = fakeCtx('interrupted');
    const mic = micWith(ctx);
    mic.adopt(fakeStream());
    const p = mic.acquire();
    await vi.advanceTimersByTimeAsync(MIC_RESUME_WAIT_MS + 50);
    expect(await p).toBe(true);
    expect(mic.isOpen).toBe(true);
    expect(ctx.resume).toHaveBeenCalled();
    // поток из общего запроса камеры подхвачен — второго getUserMedia нет
    expect((navigator as any).mediaDevices.getUserMedia).not.toHaveBeenCalled();
    mic.close();
  });

  it('сторож: контекст спит и кадров нет — «ctx» (будим), кадр пришёл — «ok»; дорожка заглушена — «muted»', async () => {
    vi.useFakeTimers();
    const ctx = fakeCtx('running');
    const mic = micWith(ctx);
    const s = fakeStream();
    mic.adopt(s);
    await mic.acquire();
    const seen: string[] = [];
    mic.onHealth = (h) => seen.push(h);
    const t0 = performance.now();
    ctx.state = 'interrupted';
    mic.check(t0 + 2000);
    expect(mic.health).toBe('ctx');
    expect(ctx.resume).toHaveBeenCalled();
    ctx.state = 'running';
    (mic as any).process({ pcm: new Float32Array(1), asr: new Float32Array(1), frames: new Float32Array([0.01, 0.02, 0.1]) });
    expect(mic.health).toBe('ok');
    s.track.muted = true;
    mic.check(performance.now() + 10);
    expect(mic.health).toBe('muted');
    expect(seen).toEqual(['ctx', 'ok', 'muted']);
    mic.close();
  });

  it('одни цифровые нули дольше 4 с — «silent» (не слышу); дорожка завершилась — открываем заново', async () => {
    vi.useFakeTimers();
    const ctx = fakeCtx('running');
    const mic = micWith(ctx);
    const s = fakeStream();
    mic.adopt(s);
    await mic.acquire();
    const zero = { pcm: new Float32Array(1), asr: new Float32Array(1), frames: new Float32Array([0, 0, 0]) };
    (mic as any).process(zero);
    const t = performance.now();
    vi.setSystemTime(Date.now() + 4500);
    (mic as any).process(zero);
    mic.check(t + 4500);
    expect(mic.health).toBe('silent');
    s.track.readyState = 'ended';
    mic.check(performance.now());
    expect(mic.health).toBe('ended');
    expect(mic.isOpen).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    expect((navigator as any).mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(mic.isOpen).toBe(true);
    mic.close();
  });
});

/** движок с микрофоном-заглушкой: кадры 10 мс подаём сами */
function engineWith(ready: boolean) {
  const audio = { ctx: null, unlocked: true, duck: vi.fn(), sfxBusy: () => false } as any;
  const voice = { hold: vi.fn(), release: vi.fn(), fadeOut: vi.fn(), mode: 'file', last: null, onSpeaking: null } as any;
  const e = new VoiceEngine(audio, voice, { mode: 'ptt' });
  const asr = e.asr as any;
  asr.model = ready ? { KaldiRecognizer: class {} } : null;
  asr.health = ready ? 'ok' : 'loading';
  (e as any).mode = 'auto';
  (e.mic as any).floor.calibrated = true;
  (e.mic as any).floor.floorDb = -65;
  const start = vi.spyOn(asr, 'start').mockImplementation(() => undefined);
  const preload = vi.spyOn(asr, 'preload');
  const events: string[] = [];
  e.on('event', ({ id }) => events.push(id));
  const frames = (db: number, n: number) => {
    const rms = Math.pow(10, db / 20);
    const list = Array.from({ length: n }, () => ({ rms, peak: rms * 1.4, zcr: 0.1 }));
    (e as any).onAudio({ list, asr: new Float32Array(160 * n), pcm: new Float32Array(1), frames: new Float32Array() });
  };
  return { e, voice, start, preload, events, frames };
}

describe('VoiceEngine: модель ещё не готова', () => {
  it('голос из комнаты не держит кота и не запускает загрузку; подсказка — один раз за 20 с', () => {
    const { e, voice, start, preload, events, frames } = engineWith(false);
    frames(-30, 30); // фраза 300 мс
    frames(-70, 60);
    frames(-30, 30); // ещё одна сразу
    frames(-70, 60);
    expect(voice.hold).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(preload).not.toHaveBeenCalled();
    expect(events.filter((x) => x === 'asr_wait')).toHaveLength(1);
    expect(e.status()).toBe('loading');
  });

  it('модель в памяти: фраза держит кота и распознаётся; индикатор «слышу» → «думаю»', () => {
    const { e, voice, start, frames } = engineWith(true);
    (e.mic as any).node = {};
    (e.mic as any).health = 'ok';
    expect(e.status()).toBe('idle');
    frames(-30, 20);
    expect(voice.hold).toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
    expect(e.status()).toBe('hearing');
    frames(-70, 50); // 400 мс тишины — конец фразы
    expect(e.status()).toBe('thinking');
  });

  it('фон 6 с без пауз (телевизор) — порог шума поднимается к нему: кот не держится каждые 6 с', () => {
    const { e, voice, frames } = engineWith(true);
    frames(-40, 620); // 6,2 с ровного шума — VAD закончил по максимуму
    const n0 = voice.hold.mock.calls.length;
    expect(n0).toBe(1);
    frames(-40, 600); // тот же фон дальше — новой «фразы» нет
    expect(voice.hold.mock.calls.length).toBe(n0);
    frames(-30, 30); // ребёнок громче фона — слышим
    expect(voice.hold.mock.calls.length).toBe(n0 + 1);
    expect((e.mic as any).floor.floorDb).toBeGreaterThan(-55);
  });

  it('микрофон открыт, а звук не идёт — «не слышу»; голоса нет (запрет) — off', () => {
    const { e } = engineWith(true);
    (e.mic as any).node = {};
    (e.mic as any).health = 'ctx';
    expect(e.status()).toBe('deaf');
    (e.mic as any).node = null;
    e.mic.error = 'not-allowed';
    expect(e.status()).toBe('off');
  });
});

describe('имя без записи', () => {
  it('редкое имя полем ввода: кот говорит записанную реплику без имени, имя — только в пузыре', async () => {
    const h = await makeDirector();
    try {
      await h.boot();
      await h.until(h.listening);
      h.d.dispatch({ type: 'name', name: 'Златослава', known: false });
      await h.until(() => h.spoken.some((s) => s.event === 'nice_name'));
      const s = h.spoken.find((x) => x.event === 'nice_name')!;
      expect(s.text).not.toMatch(/Златослава/); // голосом имя не звучит
      expect(h.isVoiced('hooligan', s.id, s.template ?? s.text, s.text) || h.voiced.has(s.id)).toBe(true);
      await h.until(() => h.bubble.some((b) => b.on && /^Златослава! /.test(b.text)));
      expect(h.bubble.find((b) => b.on && /Златослава/.test(b.text))!.text).toBe(`Златослава! ${s.text}`);
      // не запоминается (нет в словаре)
      expect(h.d.state.name ?? null).toBe(null);
    } finally {
      h.done();
    }
  });

  it('имя из словаря с записью — в реплике голосом, без дубля в пузыре', async () => {
    const h = await makeDirector();
    try {
      await h.boot();
      await h.until(h.listening);
      h.d.text('Маша');
      await h.until(() => h.spoken.some((s) => s.event === 'nice_name'));
      const s = h.spoken.find((x) => x.event === 'nice_name')!;
      await h.until(() => h.bubble.some((b) => b.on));
      const b = h.bubble.filter((x) => x.on).at(-1)!;
      expect(b.text.match(/Маша/g)?.length ?? 0).toBeLessThanOrEqual(1);
      if (s.text.includes('Маша')) expect(b.text).toBe(s.text);
    } finally {
      h.done();
    }
  });
});
