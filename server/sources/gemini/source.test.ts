// Testes do interpretador de sessão e ferramentas do Gemini.
import { describe, expect, it } from 'vitest';
import { cleanPromptTitle, createGeminiState, describeGeminiTool, parseGeminiLine } from './session';

describe('sessão do Gemini', () => {
  it('cleanPromptTitle: remove tags de sistema e sintetiza o título do prompt', () => {
    expect(cleanPromptTitle('<instruction>Faça um refactor</instruction>')).toBe('Faça um refactor');
    expect(cleanPromptTitle('/commit -m "feat: new feature"')).toBe('/commit -m "feat: new feature"');
    expect(cleanPromptTitle('Crie um teste unitário para o serviço')).toBe('Crie um teste unitário para o serviço');
  });

  it('describeGeminiTool: descreve ferramentas do ecossistema Gemini e Antigravity', () => {
    const cmd = describeGeminiTool('run_command', { CommandLine: 'npm run build' });
    expect(cmd.kind).toBe('run');
    expect(cmd.icon).toBe('🏗️');

    const testCmd = describeGeminiTool('run_command', { CommandLine: 'npm test' });
    expect(testCmd.kind).toBe('test');
    expect(testCmd.icon).toBe('🧪');

    const read = describeGeminiTool('read_file', { Path: '/src/index.ts' });
    expect(read.kind).toBe('read');
    expect(read.icon).toBe('📖');

    const edit = describeGeminiTool('edit_file', { Path: '/src/index.ts' });
    expect(edit.kind).toBe('edit');
    expect(edit.icon).toBe('✏️');

    const write = describeGeminiTool('write_file', { Path: '/src/index.ts' });
    expect(write.kind).toBe('write');
    expect(write.icon).toBe('📝');

    const search = describeGeminiTool('search_web', { query: 'Node.js documentation' });
    expect(search.kind).toBe('web');
    expect(search.icon).toBe('🌐');

    const ask = describeGeminiTool('ask_question', { questions: ['Sim ou Não?'] });
    expect(ask.kind).toBe('ask');
    expect(ask.icon).toBe('✋');
  });

  it('parseGeminiLine: interpreta eventos do Antigravity e atualiza status e tokens', () => {
    const state = createGeminiState('session-1', '/test/project');

    // 1. Prompt do usuário
    parseGeminiLine(
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        content: 'Refatore o código do servidor',
        created_at: new Date().toISOString(),
      }),
      state,
    );

    expect(state.title).toBe('Refatore o código do servidor');
    expect(state.status).toBe('working');

    // 2. Resposta do planejador com tokens e chamada de ferramenta
    const res = parseGeminiLine(
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        input_tokens: 1500,
        output_tokens: 350,
        thinking: 'Vou analisar o código antes de refatorar.',
        tool_calls: [
          {
            name: 'read_file',
            args: { Path: '/test/project/server.ts' },
          },
        ],
        created_at: new Date().toISOString(),
      }),
      state,
    );

    expect(state.stats.tokensIn).toBe(1500);
    expect(state.stats.tokensOut).toBe(350);
    expect(state.stats.toolCalls).toBe(1);
    expect(res.activities.length).toBe(2); // thinking + tool call
    expect(state.status).toBe('working');

    // 3. ask_question coloca o agente em 'waiting'
    parseGeminiLine(
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          {
            name: 'ask_question',
            args: { question: 'Deseja continuar com as mudanças?' },
          },
        ],
        created_at: new Date().toISOString(),
      }),
      state,
    );

    expect(state.status).toBe('waiting');
    expect(state.waitingForUser).toBe(true);
  });
});
