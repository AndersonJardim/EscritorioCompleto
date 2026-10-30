// Interpretação de sessões do Gemini (Gemini CLI e Antigravity).
import { describePrompt, describeTool, truncate, type ActivityDescription } from '../../../shared/activity';
import type { Activity, AgentStatus, AgentStats } from '../../../shared/types';
import { tr } from '../../../shared/i18n';

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export interface GeminiState {
  sessionId: string;
  title?: string;
  projectPath?: string;
  status: AgentStatus;
  lastAt?: number;
  stats: AgentStats;
  turnStartedAt?: number;
  waitingForUser?: boolean;
}

export function createGeminiState(sessionId: string, projectPath?: string): GeminiState {
  return {
    sessionId,
    projectPath,
    status: 'idle',
    stats: {
      toolCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
      subagents: 0,
    },
  };
}

export function describeGeminiTool(name: string, rawArgs: unknown): ActivityDescription {
  const args = rec(rawArgs) ?? {};
  const file = str(args.Path) || str(args.file_path) || str(args.path) || str(args.file);

  switch (name) {
    case 'run_command':
    case 'Bash':
    case 'shell':
    case 'exec': {
      const cmd = str(args.CommandLine) || str(args.command) || str(args.cmd);
      const desc = str(args.toolSummary) || str(args.description);
      return describeTool('Bash', { command: cmd, description: desc });
    }
    case 'read_file':
    case 'Read':
      return describeTool('Read', { file_path: file });
    case 'edit_file':
    case 'Edit':
      return describeTool('Edit', { file_path: file });
    case 'write_file':
    case 'Write':
      return describeTool('Write', { file_path: file });
    case 'search_web':
    case 'web_search': {
      const q = str(args.query);
      return { kind: 'web', icon: '🌐', text: q ? tr('Pesquisando “{0}”', [truncate(q, 26)]) : tr('Pesquisando na web'), detail: q };
    }
    case 'ask_question': {
      return { kind: 'ask', icon: '✋', text: tr('Precisa de você'), detail: tr('Aguardando resposta no Gemini') };
    }
    case 'manage_task':
      return { kind: 'plan', icon: '🗒️', text: tr('Organizando tarefas'), detail: str(args.Action) };
    case 'invoke_subagent':
      return { kind: 'delegate', icon: '👥', text: tr('Chamando subagente'), detail: str(args.Role) || str(args.TypeName) };
    case 'send_message':
      return { kind: 'communicate', icon: '💬', text: tr('Enviando mensagem') };
    default:
      return { kind: 'other', icon: '⚡', text: truncate(name, 30), detail: JSON.stringify(args) };
  }
}

export interface ParsedGeminiLine {
  activities: Activity[];
}

/** Limpa metadados do prompt inicial para o título do agente. */
export function cleanPromptTitle(text: string): string {
  let cleaned = text;
  cleaned = cleaned.replace(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i, '$1');
  cleaned = cleaned.replace(/<instruction>([\s\S]*?)<\/instruction>/i, '$1');
  cleaned = cleaned.replace(/<session_context>[\s\S]*?<\/session_context>/gi, '');
  cleaned = cleaned.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '');
  cleaned = cleaned.replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '');
  cleaned = cleaned.trim();
  const firstLine = cleaned.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  return truncate(firstLine, 50);
}

/**
 * Interpreta uma linha JSONL de um transcript do Gemini (Antigravity ou Gemini CLI).
 */
export function parseGeminiLine(line: string, state: GeminiState, now = Date.now()): ParsedGeminiLine {
  const trimmed = line.trim();
  if (!trimmed) return { activities: [] };

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return { activities: [] };
  }

  const obj = rec(raw);
  if (!obj) return { activities: [] };

  const activities: Activity[] = [];

  // 1. Antigravity transcript format: { step_index, source, type, status, created_at, content, tool_calls... }
  if (typeof obj.step_index === 'number' && typeof obj.type === 'string') {
    const at = typeof obj.created_at === 'string' ? Date.parse(obj.created_at) || now : now;
    state.lastAt = at;

    if (obj.type === 'USER_INPUT') {
      const content = typeof obj.content === 'string' ? obj.content : '';
      const title = cleanPromptTitle(content);
      if (!state.title && title) state.title = title;
      state.status = 'working';
      state.waitingForUser = false;
      const desc = describePrompt(title || content);
      activities.push({
        id: `gemini-${state.sessionId}-step-${obj.step_index}-prompt`,
        kind: 'prompt',
        icon: desc.icon,
        text: desc.text,
        detail: desc.detail,
        at,
      });
    } else if (obj.type === 'PLANNER_RESPONSE') {
      const inTokens = num(obj.input_tokens);
      const outTokens = num(obj.output_tokens);
      if (inTokens) state.stats.tokensIn = inTokens;
      if (outTokens) state.stats.tokensOut = (state.stats.tokensOut || 0) + outTokens;

      const thinking = str(obj.thinking);
      if (thinking) {
        activities.push({
          id: `gemini-${state.sessionId}-step-${obj.step_index}-think`,
          kind: 'think',
          icon: '💭',
          text: tr('Pensando…'),
          detail: truncate(thinking, 300),
          at,
        });
      }

      if (Array.isArray(obj.tool_calls)) {
        for (let i = 0; i < obj.tool_calls.length; i++) {
          const tc = rec(obj.tool_calls[i]);
          const name = str(tc?.name) ?? 'tool';
          const args = rec(tc?.args) ?? {};
          state.stats.toolCalls += 1;
          const desc = describeGeminiTool(name, args);
          if (name === 'ask_question') {
            state.status = 'waiting';
            state.waitingForUser = true;
          } else {
            state.status = 'working';
          }
          activities.push({
            id: `gemini-${state.sessionId}-step-${obj.step_index}-call-${i}`,
            kind: desc.kind,
            icon: desc.icon,
            text: desc.text,
            detail: desc.detail,
            tool: name,
            at,
          });
        }
      } else if (!state.waitingForUser) {
        state.status = 'idle';
      }
    } else if (obj.type === 'GENERIC' && obj.status === 'ERROR') {
      activities.push({
        id: `gemini-${state.sessionId}-step-${obj.step_index}-err`,
        kind: 'error',
        icon: '⚠️',
        text: tr('Algo deu errado'),
        detail: str(obj.content),
        at,
        error: true,
      });
    }

    return { activities };
  }

  // 2. Gemini CLI chats format: { $set: { messages: [...] } }
  const setObj = rec(obj.$set);
  if (setObj && Array.isArray(setObj.messages)) {
    for (const m of setObj.messages) {
      const msg = rec(m);
      if (!msg) continue;
      const at = typeof msg.timestamp === 'string' ? Date.parse(msg.timestamp) || now : now;
      state.lastAt = at;

      if (msg.type === 'user') {
        let text = '';
        if (Array.isArray(msg.content)) {
          for (const c of msg.content) {
            const co = rec(c);
            if (typeof co?.text === 'string') text += co.text;
          }
        }
        const title = cleanPromptTitle(text);
        if (!state.title && title) state.title = title;
        state.status = 'working';
        state.waitingForUser = false;
        activities.push({
          id: `gemini-${state.sessionId}-${msg.id || at}-prompt`,
          kind: 'prompt',
          icon: '📨',
          text: truncate(title || tr('Nova instrução'), 46),
          detail: truncate(text, 300),
          at,
        });
      } else if (msg.type === 'model' || msg.type === 'assistant') {
        state.status = 'idle';
      }
    }
    return { activities };
  }

  return { activities };
}
