/** Источник времени (мс). В тестах подменяется. */
export type Now = () => number;
export const realNow: Now = () => performance.now();
