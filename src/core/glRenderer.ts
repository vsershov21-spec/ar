/** Общий WebGLRenderer приложения (без импорта three: модуль лёгкий, его можно брать из основного бандла). */
import type { WebGLRenderer } from 'three';

let current: WebGLRenderer | null = null;

export function setGlRenderer(r: WebGLRenderer) {
  current = r;
}

export function glRenderer(): WebGLRenderer | null {
  return current;
}
