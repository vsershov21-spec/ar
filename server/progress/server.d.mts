import type { Server, IncomingMessage, ServerResponse } from 'node:http';

export interface ProgressServerOptions {
  dataDir?: string;
  store?: 'auto' | 'sqlite' | 'file';
  ttlDays?: number;
  origins?: string[];
  adminToken?: string;
  now?: () => number;
  rate?: { ip?: number; writes?: number; admin?: number };
}
export interface ProgressServer {
  server: Server;
  store: { kind: 'sqlite' | 'file'; list(): string[]; get(device: string): any };
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  purge(): number;
  close(): Promise<void>;
}
export const LIMITS: { dataBytes: number; bodyBytes: number; keys: number; sessions: number; eventsPerSession: number; eventLen: number };
export class RateLimiter {
  constructor(max: number, windowMs: number, now?: () => number);
  hit(key: string): boolean;
}
export function createProgressServer(opts?: ProgressServerOptions): Promise<ProgressServer>;
