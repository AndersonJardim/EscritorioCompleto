// Histórico do terminal do Gemini (HistoryProvider 'gemini').
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RecentSession } from '../../../shared/types';
import { HISTORY_LIMIT, HISTORY_MAX_AGE_MS } from '../history';
import type { HistoryProvider, HistoryResolveResult } from '../source';
import { encodeCwd } from '../watcher';
import { findGeminiSessions } from './files';
import { createGeminiTerminalParser } from './terminal';
import { tr } from '../../../shared/i18n';

export interface GeminiHistoryAccount {
  id: string;
  dir: string;
}

export interface GeminiHistoryOptions {
  accounts: () => readonly GeminiHistoryAccount[];
  openAgentOf: (account: string, sessionId: string) => string | undefined;
  now?: () => number;
  maxAgeMs?: number;
  limit?: number;
}

export class GeminiHistory implements HistoryProvider {
  readonly provider = 'gemini' as const;
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly limit: number;

  constructor(private readonly opts: GeminiHistoryOptions) {
    this.now = opts.now ?? Date.now;
    this.maxAgeMs = opts.maxAgeMs ?? HISTORY_MAX_AGE_MS;
    this.limit = opts.limit ?? HISTORY_LIMIT;
  }

  hasAccount(account: string): boolean {
    return this.opts.accounts().some((a) => a.id === account);
  }

  async list(): Promise<RecentSession[]> {
    const now = this.now();
    const minMtime = now - this.maxAgeMs;
    const out: RecentSession[] = [];

    for (const acc of this.opts.accounts()) {
      const files = findGeminiSessions(acc.dir);
      for (const f of files) {
        if (f.mtimeMs < minMtime) continue;
        const agentId = this.opts.openAgentOf(acc.id, f.id);
        const r: RecentSession = {
          account: acc.id,
          provider: 'gemini',
          sessionId: f.id,
          project: f.projectPath,
          projectDir: encodeCwd(f.projectPath),
          lastAt: f.mtimeMs,
          size: f.size,
          open: !!agentId,
        };
        if (agentId) r.agentId = agentId;
        out.push(r);
      }
    }

    out.sort((a, b) => b.lastAt - a.lastAt);
    return out.slice(0, this.limit);
  }

  resolve(account: string, sessionId: string): HistoryResolveResult {
    const acc = this.opts.accounts().find((a) => a.id === account);
    if (!acc) return { status: 404, error: tr('conta desconhecida') };

    const files = findGeminiSessions(acc.dir);
    const match = files.find((f) => f.id === sessionId);
    if (!match) return { status: 404, error: tr('sessão não encontrada') };

    try {
      const realAcc = realpathSync(acc.dir);
      const realFile = realpathSync(match.path);
      if (!realFile.startsWith(realAcc)) return { status: 404, error: tr('sessão fora da conta') };
      return {
        path: match.path,
        createParser: createGeminiTerminalParser,
      };
    } catch {
      return {
        path: match.path,
        createParser: createGeminiTerminalParser,
      };
    }
  }
}

