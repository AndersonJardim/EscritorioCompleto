// Terminal do Gemini: linhas de transcript (CLI e Antigravity) viram entradas do terminal.
import { describe, expect, it } from 'vitest';
import type { TerminalEntry } from '../../../shared/types';
import { createGeminiTerminalParser } from './terminal';

function entries(lines: string[]): TerminalEntry[] {
  const p = createGeminiTerminalParser();
  return lines.flatMap((l) => p.push(l));
}

describe('terminal do Gemini', () => {
  it('converte linhas CLI: prompt do usuário, raciocínio, chamada de ferramenta, resultado e resposta', () => {
    const out = entries([
      JSON.stringify({ type: 'user', message: { content: 'Execute os testes do projeto' }, timestamp: Date.now() }),
      JSON.stringify({ type: 'thought', text: 'Vou rodar npm test para verificar os testes.', timestamp: Date.now() }),
      JSON.stringify({
        type: 'tool_use',
        name: 'run_command',
        tool_call_id: 'call_1',
        input: { CommandLine: 'npm test' },
        timestamp: Date.now(),
      }),
      JSON.stringify({
        type: 'tool_result',
        tool_use_id: 'call_1',
        output: 'PASS src/index.test.ts\n5 passed',
        timestamp: Date.now(),
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: 'Todos os testes passaram com sucesso!' },
        timestamp: Date.now(),
      }),
    ]);

    expect(out.map((e) => e.kind)).toEqual(['user', 'thinking', 'tool', 'result', 'assistant']);
    expect(out[0]).toMatchObject({ kind: 'user', text: 'Execute os testes do projeto' });
    expect(out[1]).toMatchObject({ kind: 'thinking', text: 'Vou rodar npm test para verificar os testes.' });
    expect(out[2]).toMatchObject({ kind: 'tool', id: 'call_1', tool: 'run_command' });
    expect(out[3]).toMatchObject({ kind: 'result', toolUseId: 'call_1', text: 'PASS src/index.test.ts\n5 passed' });
    expect(out[4]).toMatchObject({ kind: 'assistant', text: 'Todos os testes passaram com sucesso!' });
  });

  it('converte linhas Antigravity: USER_INPUT, PLANNER_RESPONSE e TOOL_RESULT', () => {
    const out = entries([
      JSON.stringify({
        type: 'USER_INPUT',
        content: 'Leia o arquivo README.md',
        created_at: new Date().toISOString(),
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        thinking: 'Lendo o arquivo de documentação.',
        tool_calls: [
          {
            tool_name: 'read_file',
            id: 'call_rf_1',
            tool_input: { Path: '/proj/README.md' },
          },
        ],
        content: 'Vou ler o README.',
        created_at: new Date().toISOString(),
      }),
      JSON.stringify({
        type: 'TOOL_RESULT',
        tool_id: 'call_rf_1',
        content: '# Documentação do Projeto',
        created_at: new Date().toISOString(),
      }),
    ]);

    expect(out.map((e) => e.kind)).toEqual(['user', 'thinking', 'tool', 'assistant', 'result']);
    expect(out[0]).toMatchObject({ kind: 'user', text: 'Leia o arquivo README.md' });
    expect(out[1]).toMatchObject({ kind: 'thinking', text: 'Lendo o arquivo de documentação.' });
    expect(out[2]).toMatchObject({ kind: 'tool', id: 'call_rf_1', tool: 'read_file' });
    expect(out[3]).toMatchObject({ kind: 'assistant', text: 'Vou ler o README.' });
    expect(out[4]).toMatchObject({ kind: 'result', toolUseId: 'call_rf_1', text: '# Documentação do Projeto' });
  });

  it('ignora linhas inválidas ou sem conteúdo exibível', () => {
    const out = entries([
      '',
      '{ not valid json',
      JSON.stringify({ type: 'unknown_event' }),
    ]);
    expect(out).toEqual([]);
  });
});

