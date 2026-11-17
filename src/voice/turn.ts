/**
 * Очередь слова между ребёнком и котом — общее состояние «ушей» (VoiceEngine пишет) и режиссёра (читает),
 * без прямой связи модулей (как intentContext в intents.ts).
 *   userSpeaking   — VAD слышит голос прямо сейчас (кот не начинает говорить поверх);
 *   lastUserAt     — когда ребёнок последний раз сказал понятую/непонятую фразу или коснулся экрана (performance.now());
 *   lastQuestionAt — когда кот закончил реплику-вопрос.
 */
export interface TurnState {
  userSpeaking: boolean;
  lastUserAt: number;
  lastQuestionAt: number;
  /** последнее касание/активность (тап по телефону микрофон слышит как «хлопок») */
  lastTouchAt: number;
}

const st: TurnState = { userSpeaking: false, lastUserAt: -1e9, lastQuestionAt: -1e9, lastTouchAt: -1e9 };
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
/** «говорит» дольше этого — значит, конец фразы потерялся (кот заговорил, микрофон закрылся): не блокируем кота навсегда */
const STALE_SPEAKING_MS = 8000;
let speakingSince = 0;

export const turn = {
  get(t = now()): Readonly<TurnState> {
    if (st.userSpeaking && t - speakingSince > STALE_SPEAKING_MS) st.userSpeaking = false;
    return st;
  },
  /** VAD: голос начался / кончился. lastUserAt не трогаем — шум тоже звучит; фразу ребёнка отмечает userActivity */
  userStart(t = now()) {
    st.userSpeaking = true;
    speakingSince = t;
  },
  userEnd() {
    st.userSpeaking = false;
  },
  userActivity(t = now()) {
    st.lastUserAt = t;
    st.lastTouchAt = t;
  },
  catQuestion(t = now()) {
    st.lastQuestionAt = t;
  },
  reset() {
    st.userSpeaking = false;
    st.lastUserAt = -1e9;
    st.lastQuestionAt = -1e9;
    st.lastTouchAt = -1e9;
  },
};
