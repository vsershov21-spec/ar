/// <reference lib="webworker" />
/** Воркер повтора: тяжёлая обработка (вокодер) не тормозит кадр AR. Запись приходит и уходит transferable-буфером. */
import { processEcho } from './echoDsp';

self.onmessage = (e: MessageEvent<{ id: number; pcm: Float32Array; sr: number; st: number; rate: number }>) => {
  const { id, pcm, sr, st, rate } = e.data;
  const out = processEcho(pcm, sr, st, rate);
  pcm.fill(0); // запись не храним
  (self as unknown as Worker).postMessage({ id, out }, [out.buffer]);
};
