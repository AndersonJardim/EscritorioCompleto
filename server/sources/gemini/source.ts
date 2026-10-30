// Fonte de agentes do Gemini (AgentSource 'gemini', ver sources/source.ts):
// CLI `gemini` e Antigravity, que gravam em GEMINI_HOME (~/.gemini).
import type { Activity, AgentStatus, SourceInfo } from '../../../shared/types';
import type { DetectedAccount } from '../../accounts/detect';
import type { AccountEntry, AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { Office, TranscriptSummary } from '../../model/office';
import type { AgentSource } from '../source';
import { FileTail } from '../tail';
import type { TerminalParser } from '../terminal';
import { detectGeminiAccounts } from './accounts';
import { findGeminiSessions, type GeminiSessionFile } from './files';
import { createGeminiState, parseGeminiLine, type GeminiState } from './session';
import { createGeminiTerminalParser } from './terminal';
import { tr } from '../../../shared/i18n';

/** Sessão considerada recente se modificada nos últimos 30 minutos. */
export const GEMINI_RECENT_MS = 30 * 60_000;
const POLL_INTERVAL_MS = 1_500;
const MAIN_ROLE = tr('Agente principal (Gemini)');

export interface GeminiSourceOptions {
  accounts: AccountsService;
  office: Office;
  dirs: string[];
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: () => number;
  pollMs?: number;
  tailBytes?: number;
}

interface GeminiAccount {
  id: string;
  dir: string;
  configDir: string;
}

interface SessionTracker {
  key: string;
  acc: GeminiAccount;
  file: GeminiSessionFile;
  tail: FileTail;
  state: GeminiState;
  inOffice: boolean;
  status: AgentStatus;
  lastMtime: number;
}

export class GeminiSource implements AgentSource {
  readonly provider = 'gemini' as const;
  private accs: GeminiAccount[] = [];
  private entries: readonly AccountEntry[] = [];
  private detected: DetectedAccount[] = [];
  private sessions = new Map<string, SessionTracker>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly tailBytes: number;

  constructor(private readonly opts: GeminiSourceOptions) {
    this.now = opts.now ?? Date.now;
    this.pollMs = opts.pollMs ?? POLL_INTERVAL_MS;
    this.tailBytes = opts.tailBytes ?? 1024 * 1024;
  }

  start(): void {
    const env = this.opts.env ?? process.env;
    const home = this.opts.home;
    this.detected = detectGeminiAccounts(this.opts.dirs, { env, home });

    this.entries = this.opts.accounts.setProviderAccounts(
      'gemini',
      this.detected.map((d) => ({ dir: d.configDir, detected: d })),
    );

    this.accs = this.opts.dirs.map((dir, i) => ({
      id: this.entries[i]?.id ?? this.detected[i]?.id ?? `.gemini~${i + 1}`,
      dir,
      configDir: this.detected[i]?.configDir ?? dir,
    }));

    // Boot inicial
    this.opts.office.beginBoot();
    try {
      this.poll(true);
    } catch (err) {
      log.warn(tr('Fonte Gemini: erro no boot inicial ({0}).', [errMsg(err)]));
    } finally {
      this.opts.office.endBoot();
    }

    this.timer = setInterval(() => this.poll(false), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.sessions.clear();
  }

  sources(): SourceInfo[] {
    return this.accs.map((a) => {
      let openCount = 0;
      for (const s of this.sessions.values()) {
        if (s.acc.id === a.id && s.inOffice && s.status !== 'offline') openCount++;
      }
      return {
        provider: 'gemini',
        label: a.id,
        path: a.configDir,
        sessions: openCount,
        ok: true,
      };
    });
  }

  transcriptPathOf(agentId: string): string | undefined {
    const s = this.sessions.get(agentId);
    return s?.file.path;
  }

  terminalParser(_agentId: string): TerminalParser | undefined {
    return createGeminiTerminalParser();
  }

  private poll(isBoot: boolean): void {
    const now = this.now();
    const activeKeys = new Set<string>();

    for (const acc of this.accs) {
      const files = findGeminiSessions(acc.dir);
      for (const file of files) {
        const isRecent = now - file.mtimeMs < GEMINI_RECENT_MS;
        const key = `gemini:${acc.id}:${file.id}`;

        let tracker = this.sessions.get(key);
        if (!tracker) {
          if (!isRecent && !isBoot) continue;

          const state = createGeminiState(file.id, file.projectPath);
          const tail = new FileTail(file.path);
          if (isBoot) {
            tail.seekTail(this.tailBytes);
          }
          tracker = {
            key,
            acc,
            file,
            tail,
            state,
            inOffice: false,
            status: 'idle',
            lastMtime: file.mtimeMs,
          };
          this.sessions.set(key, tracker);
        }

        activeKeys.add(key);
        this.readTracker(tracker, now, isBoot);
      }
    }

    // Fecha sessões que não existem mais
    for (const [key, tracker] of this.sessions.entries()) {
      if (!activeKeys.has(key)) {
        if (tracker.inOffice && tracker.status !== 'offline') {
          tracker.status = 'offline';
          this.opts.office.setStatus(tracker.key, 'offline');
        }
        this.sessions.delete(key);
      }
    }
  }

  private readTracker(t: SessionTracker, now: number, isBoot: boolean): void {
    for (let i = 0; i < 64; i++) {
      const r = t.tail.read();
      for (const line of r.lines) {
        const res = parseGeminiLine(line, t.state, now);
        for (const act of res.activities) {
          if (t.inOffice) {
            this.opts.office.addActivity(t.key, act, true, { feed: !isBoot });
          }
        }
      }
      if (!r.more) break;
    }

    if (!t.inOffice) {
      const cwd = t.file.projectPath;
      if (cwd) {
        t.inOffice = true;
        t.status = t.state.status;
        this.opts.office.addMain({
          id: t.key,
          provider: 'gemini',
          account: t.acc.id,
          sessionId: t.file.id,
          cwd,
          role: MAIN_ROLE,
          startedAt: t.state.lastAt ?? t.file.mtimeMs,
          status: t.status,
        });
      }
    } else {
      if (t.state.status !== t.status) {
        t.status = t.state.status;
        this.opts.office.setStatus(t.key, t.status);
      }
    }

    if (t.inOffice) {
      const summary: TranscriptSummary = {
        title: t.state.title,
        tasks: [],
        stats: { ...t.state.stats },
        model: 'Gemini',
      };
      this.opts.office.applyTranscript(t.key, summary);
    }
  }
}
