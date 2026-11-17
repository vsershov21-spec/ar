// QA-стенд (docs/qa/BUGS.md): «Без звука» — реплика возвращалась сразу, пузырь гас через 250 мс и его не успевали прочитать.
// Теперь при выключенном звуке реплика «идёт» молча столько, сколько звучала бы, и обрывается cancel / новой репликой.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { VoicePlayer } from '../src/voice/voicePlayer';
import type { Audio } from '../src/audio/audio';

const fakeAudio = () => ({ ctx: null, duck() {}, voiceOut: () => null }) as unknown as Audio;
const req = (text: string) => ({ persona: 'hooligan', template: text, text, pitch: 1, rate: 1, lineId: 'hooligan.test.01' });

describe('реплика при выключенном звуке', () => {
  afterEach(() => vi.useRealTimers());

  it('длится как живая речь: пузырь успевают прочитать', async () => {
    vi.useFakeTimers();
    const v = new VoicePlayer(fakeAudio());
    v.muted = true;
    const text = 'Эй, ты тут? Я жду, вообще-то.'; // 29 символов ≈ 0,45 + 2,1 с
    let done = false;
    void v.speak(req(text)).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(1500);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1500);
    expect(done).toBe(true);
    expect(v.last?.source).toBe('muted');
  });

  it('cancel и новая реплика обрывают ожидание', async () => {
    vi.useFakeTimers();
    const v = new VoicePlayer(fakeAudio());
    v.muted = true;
    let done = false;
    void v.speak(req('Длинная-длинная реплика, которую никто не дослушает до конца.')).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(500);
    v.cancel();
    await vi.advanceTimersByTimeAsync(200);
    expect(done).toBe(true);
  });

  it('короткая реплика — не меньше 1,2 с', async () => {
    const v = new VoicePlayer(fakeAudio());
    expect(v.lineSeconds(req('Ой!'))).toBeGreaterThanOrEqual(1.2);
  });
});

// QA-стенд (профиль CPU): hasRecordings пересчитывал Object.keys(1600+ записей) на каждый вызов — теперь раз на манифест
describe('hasRecordings', () => {
  it('пустой манифест — нет; загрузили новый — да (без пересчёта на каждый вызов)', () => {
    const v = new VoicePlayer(fakeAudio());
    expect(v.hasRecordings).toBe(false);
    (v as unknown as { el: Record<string, unknown> }).el = { 'hooligan.hello.01': { f: 'x.mp3', d: 1, t: 'Привет' } };
    expect(v.hasRecordings).toBe(true);
    const spy = vi.spyOn(Object, 'keys');
    for (let i = 0; i < 100; i++) void v.hasRecordings;
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
