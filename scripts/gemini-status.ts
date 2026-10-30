// Script de status do Gemini no Habblaud.
// Roda no terminal do host: npm run gemini:status
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { discoverGeminiDirs, detectGeminiAccounts } from '../server/sources/gemini/accounts';
import { findGeminiCliSessions, findAntigravitySessions } from '../server/sources/gemini/files';

async function main() {
  const home = process.env.HOME || homedir();
  const dirs = discoverGeminiDirs(process.env, home);

  console.log('=== Integração Gemini no Habblaud ===\n');

  if (dirs.length === 0) {
    console.log('Nenhuma pasta do Gemini encontrada em ~/.gemini nem em GEMINI_HOME.');
    console.log('Dica: instale o Gemini CLI (@google/gemini-cli) ou utilize o Antigravity.');
    return;
  }

  const accounts = detectGeminiAccounts(dirs, { home, env: process.env });
  console.log(`Pastas e contas do Gemini detectadas (${accounts.length}):`);

  for (const acc of accounts) {
    const cliSessions = findGeminiCliSessions(acc.configDir);
    const agSessions = findAntigravitySessions(acc.configDir);
    const total = cliSessions.length + agSessions.length;

    console.log(`  • [${acc.short}] ${acc.name} · ${acc.email || 'sem e-mail'} (${acc.configDir})`);
    console.log(`    Sessões encontradas: ${total} (${cliSessions.length} CLI, ${agSessions.length} Antigravity)`);

    const all = [...cliSessions, ...agSessions].sort((a, b) => b.mtimeMs - a.mtimeMs);
    const top = all.slice(0, 3);
    for (const s of top) {
      const ageMin = Math.round((Date.now() - s.mtimeMs) / 60000);
      console.log(`      - ${s.id} (${s.projectPath || 'sem pasta'}) · há ${ageMin} min`);
    }
    if (all.length > 3) {
      console.log(`      ... e mais ${all.length - 3} sessões`);
    }
  }

  console.log();
  const port = process.env.PORT || '4747';
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/snapshot`);
    if (res.ok) {
      const data = (await res.json()) as { agents?: Array<{ provider?: string }> };
      const geminiAgents = data.agents?.filter((a) => a.provider === 'gemini') ?? [];
      if (geminiAgents.length > 0) {
        console.log(`Habblaud em http://127.0.0.1:${port}: conectado ao Gemini com ${geminiAgents.length} sessões ativas.`);
      } else {
        console.log(`Habblaud em http://127.0.0.1:${port}: conectado, aguardando sessões do Gemini.`);
      }
    } else {
      console.log(`Habblaud em http://127.0.0.1:${port}: erro HTTP ${res.status}`);
    }
  } catch {
    console.log(`Habblaud em http://127.0.0.1:${port}: fora do ar (rode npm run dev para iniciar o escritório).`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
