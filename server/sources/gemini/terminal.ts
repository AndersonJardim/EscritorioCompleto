// Terminal do Gemini: converte as linhas dos transcripts em TerminalEntry
// (prompts, respostas, raciocínio resumido, comandos, ferramentas e erros),
// com segredos mascarados e textos truncados.
import type { TerminalEntry } from '../../../shared/types';
import { marked, prepare, RESULT_MAX, TEXT_MAX, THINKING_MAX, toolView, type TerminalParser } from '../terminal';
import { cleanPromptTitle } from './session';

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

class GeminiTerminalParser implements TerminalParser {
  private out: TerminalEntry[] = [];
  private readonly seen = new Set<string>();
  private autoIdx = 0;

  push(line: string): TerminalEntry[] {
    this.out = [];
    const trimmed = line.trim();
    if (!trimmed) return this.out;

    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      return this.out;
    }

    const obj = rec(raw);
    if (!obj) return this.out;

    // 1. Antigravity transcript format
    if (typeof obj.type === 'string' && (typeof obj.step_index === 'number' || obj.type === 'USER_INPUT' || obj.type === 'PLANNER_RESPONSE' || obj.type === 'GENERIC' || obj.type === 'TOOL_RESULT')) {
      const at = typeof obj.created_at === 'string' ? Date.parse(obj.created_at) || Date.now() : Date.now();
      const idx = typeof obj.step_index === 'number' ? obj.step_index : ++this.autoIdx;

      if (obj.type === 'USER_INPUT') {
        const text = typeof obj.content === 'string' ? obj.content : '';
        const title = cleanPromptTitle(text);
        this.emit({
          kind: 'user',
          id: `step-${idx}-prompt`,
          text: marked(prepare(title || text, TEXT_MAX)),
          at,
        });
      } else if (obj.type === 'PLANNER_RESPONSE') {
        const thinking = str(obj.thinking);
        if (thinking) {
          this.emit({
            kind: 'thinking',
            id: `step-${idx}-think`,
            text: marked(prepare(thinking, THINKING_MAX)),
            at,
          });
        }

        if (Array.isArray(obj.tool_calls)) {
          for (let i = 0; i < obj.tool_calls.length; i++) {
            const tc = rec(obj.tool_calls[i]);
            const name = str(tc?.name) || str(tc?.tool_name) || 'tool';
            const callId = str(tc?.id) || `step-${idx}-call-${i}`;
            const args = rec(tc?.args) || rec(tc?.tool_input) || {};

            if (name === 'run_command' || name === 'Bash' || name === 'shell') {
              const cmd = str(args.CommandLine) || str(args.command) || str(args.cmd) || '';
              const view = toolView('Bash', { command: cmd });
              this.emit({
                kind: 'tool',
                id: callId,
                tool: 'Bash',
                title: view.title,
                input: view.input,
                inputKind: view.inputKind,
                at,
              });
            } else {
              const view = toolView(name, args);
              this.emit({
                kind: 'tool',
                id: callId,
                tool: name,
                title: view.title,
                input: view.input,
                inputKind: view.inputKind,
                at,
              });
            }
          }
        }

        const content = typeof obj.content === 'string' ? obj.content : '';
        if (content) {
          this.emit({
            kind: 'assistant',
            id: `step-${idx}-text`,
            text: marked(prepare(content, TEXT_MAX)),
            at,
          });
        }
      } else if (obj.type === 'GENERIC' || obj.type === 'TOOL_RESULT') {
        const content = typeof obj.content === 'string' ? obj.content : '';
        if (content) {
          const toolUseId = str(obj.tool_id) || `step-${Math.max(0, idx - 1)}-call-0`;
          this.emit({
            kind: 'result',
            id: `step-${idx}-result`,
            toolUseId,
            text: marked(prepare(content, RESULT_MAX)),
            error: obj.status === 'ERROR',
            at,
          });
        }
      }
      return this.out;
    }

    // 2. Gemini CLI chats format (either {$set: {messages: [...]}} or standalone message object)
    const setObj = rec(obj.$set);
    const messages: unknown[] =
      setObj && Array.isArray(setObj.messages)
        ? setObj.messages
        : obj.type || obj.kind || obj.message
          ? [obj]
          : [];

    for (const m of messages) {
      const msg = rec(m);
      if (!msg) continue;
      const at = typeof msg.timestamp === 'string' ? Date.parse(msg.timestamp) || Date.now() : typeof msg.timestamp === 'number' ? msg.timestamp : Date.now();
      const id = str(msg.id) || str(msg.uuid) || String(++this.autoIdx);

      const msgType = str(msg.type) || str(msg.kind) || (msg.message && rec(msg.message) ? str(rec(msg.message)?.role) : undefined);

      if (msgType === 'user') {
        let text = '';
        if (typeof msg.content === 'string') {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          for (const c of msg.content) {
            const co = rec(c);
            if (typeof co?.text === 'string') text += co.text;
          }
        } else if (rec(msg.message) && typeof rec(msg.message)?.content === 'string') {
          text = rec(msg.message)?.content as string;
        }
        const title = cleanPromptTitle(text);
        this.emit({
          kind: 'user',
          id: `cli-${id}-prompt`,
          text: marked(prepare(title || text, TEXT_MAX)),
          at,
        });
      } else if (msgType === 'thought') {
        const text = str(msg.text) || str(msg.content) || '';
        if (text) {
          this.emit({
            kind: 'thinking',
            id: `cli-${id}-thought`,
            text: marked(prepare(text, THINKING_MAX)),
            at,
          });
        }
      } else if (msgType === 'tool_use' || msgType === 'call') {
        const name = str(msg.name) || str(msg.tool) || 'tool';
        const callId = str(msg.tool_call_id) || str(msg.id) || `cli-${id}-call`;
        const args = rec(msg.input) || rec(msg.args) || {};
        const view = toolView(name, args);
        this.emit({
          kind: 'tool',
          id: callId,
          tool: name,
          title: view.title,
          input: view.input,
          inputKind: view.inputKind,
          at,
        });
      } else if (msgType === 'tool_result' || msgType === 'result') {
        const toolUseId = str(msg.tool_use_id) || str(msg.tool_call_id) || `cli-${id}-call`;
        const output = str(msg.output) || str(msg.content) || str(msg.result) || '';
        this.emit({
          kind: 'result',
          id: `cli-${id}-result`,
          toolUseId,
          text: marked(prepare(output, RESULT_MAX)),
          error: !!msg.is_error,
          at,
        });
      } else if (msgType === 'model' || msgType === 'assistant') {
        let text = '';
        if (typeof msg.content === 'string') {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          for (const c of msg.content) {
            const co = rec(c);
            if (typeof co?.text === 'string') text += co.text;
          }
        } else if (rec(msg.message) && typeof rec(msg.message)?.content === 'string') {
          text = rec(msg.message)?.content as string;
        }
        if (text) {
          this.emit({
            kind: 'assistant',
            id: `cli-${id}-text`,
            text: marked(prepare(text, TEXT_MAX)),
            at,
          });
        }
      }
    }

    return this.out;
  }

  private emit(e: TerminalEntry): void {
    if (this.seen.has(e.id)) return;
    this.seen.add(e.id);
    this.out.push(e);
  }
}

export function createGeminiTerminalParser(): TerminalParser {
  return new GeminiTerminalParser();
}
