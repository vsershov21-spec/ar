/**
 * Обработка записи для повтора: понизить частоту до 24 кГц, сдвинуть тон (+echoPitchSemitones) и темп
 * (echoRate) фазовым вокодером — без «бурундука» по скорости, — обрезать тишину, −16 LUFS.
 * Используется в воркере (echoWorker.ts) и как запасной путь в главном потоке.
 */
import { fadeEdges, normalizeLoudness, pitchShift, resample, trimSilence } from '../audio/dsp';

export const ECHO_SR = 24000;

export function processEcho(pcm: Float32Array, sampleRate: number, semitones: number, rate: number): Float32Array {
  let x = sampleRate === ECHO_SR ? pcm : resample(pcm, ECHO_SR / sampleRate);
  x = trimSilence(x, ECHO_SR, -40, 0.04);
  x = pitchShift(x, ECHO_SR, semitones, rate);
  x = normalizeLoudness(x, ECHO_SR, -16, -1.5);
  return fadeEdges(x, ECHO_SR, 10);
}
