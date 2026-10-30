// Localização de sessões do Gemini (Gemini CLI e Antigravity).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export interface GeminiSessionFile {
  id: string;
  path: string;
  projectPath: string;
  mtimeMs: number;
  size: number;
  kind: 'cli' | 'antigravity';
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Lê projects.json do Gemini, que mapeia caminho do projeto para slug. */
export function readProjectsMap(geminiDir: string): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const file = join(geminiDir, 'projects.json');
    if (!existsSync(file)) return map;
    const data = JSON.parse(readFileSync(file, 'utf8')) as { projects?: Record<string, string> };
    if (data?.projects && typeof data.projects === 'object') {
      for (const [projectPath, slug] of Object.entries(data.projects)) {
        map.set(slug.toLowerCase(), resolve(projectPath));
      }
    }
  } catch {
    // ignora
  }
  return map;
}

/** Extrai a pasta do projeto a partir do começo de um transcript (Antigravity ou Gemini CLI). */
export function extractProjectPathFromTranscript(filePath: string): string | undefined {
  try {
    // Lê os primeiros 8 KB para localizar a pasta de trabalho
    const fd = readFileSync(filePath, { encoding: 'utf8', flag: 'r' });
    const snippet = fd.slice(0, 16_384);

    const mWorkspace = /(?:Active Workspaces:\s*\r?\n-\s*([^\r\n]+)|Command Working Directory:\s*([^\r\n]+)|Workspace Directories:\*\*\s*\r?\n\s*-\s*([^\r\n]+))/i.exec(snippet);
    if (mWorkspace) {
      const match = mWorkspace[1] || mWorkspace[2] || mWorkspace[3];
      if (match && match.trim()) return resolve(match.trim());
    }

    // Procura caminhos no formato C:\... ou /Users/...
    const mPath = /["'](?:workspace|project|cwd)["']\s*:\s*["']([^"']+)["']/i.exec(snippet);
    if (mPath && mPath[1]) return resolve(mPath[1]);
  } catch {
    // ignora
  }
  return undefined;
}

/**
 * Procura sessões do Gemini CLI em <geminiDir>/tmp/<slug>/chats/session-*.jsonl
 */
export function findCliSessions(geminiDir: string): GeminiSessionFile[] {
  const tmpDir = join(geminiDir, 'tmp');
  if (!isDir(tmpDir)) return [];

  const projectsMap = readProjectsMap(geminiDir);
  const out: GeminiSessionFile[] = [];

  try {
    const projectDirs = readdirSync(tmpDir, { withFileTypes: true });
    for (const pEnt of projectDirs) {
      if (!pEnt.isDirectory() && !pEnt.isSymbolicLink()) continue;
      const slug = pEnt.name;
      const pDir = join(tmpDir, slug);

      // Descobre a pasta real do projeto:
      let projectPath: string | undefined;
      const rootFile = join(pDir, '.project_root');
      if (isFile(rootFile)) {
        try {
          const root = readFileSync(rootFile, 'utf8').trim();
          if (root) projectPath = resolve(root);
        } catch {
          // ignora
        }
      }
      if (!projectPath) {
        projectPath = projectsMap.get(slug.toLowerCase());
      }

      const chatsDir = join(pDir, 'chats');
      if (!isDir(chatsDir)) continue;

      try {
        const chatFiles = readdirSync(chatsDir, { withFileTypes: true });
        for (const cEnt of chatFiles) {
          if (!cEnt.isFile() || !cEnt.name.endsWith('.jsonl')) continue;
          const fullPath = join(chatsDir, cEnt.name);
          const st = statSync(fullPath);
          const id = cEnt.name.replace(/\.jsonl$/i, '');

          // Se ainda não temos projectPath, tenta extrair do transcript
          const proj = projectPath || extractProjectPathFromTranscript(fullPath) || pDir;

          out.push({
            id,
            path: fullPath,
            projectPath: proj,
            mtimeMs: st.mtimeMs,
            size: st.size,
            kind: 'cli',
          });
        }
      } catch {
        // ignora erro ao ler chats
      }
    }
  } catch {
    // ignora erro ao ler tmp
  }

  return out;
}

/**
 * Procura sessões do Antigravity em <geminiDir>/antigravity/brain/<id>/.system_generated/logs/transcript.jsonl
 */
export function findAntigravitySessions(geminiDir: string): GeminiSessionFile[] {
  const brainDir = join(geminiDir, 'antigravity', 'brain');
  if (!isDir(brainDir)) return [];

  const out: GeminiSessionFile[] = [];
  try {
    const brainEntries = readdirSync(brainDir, { withFileTypes: true });
    for (const bEnt of brainEntries) {
      if (!bEnt.isDirectory() && !bEnt.isSymbolicLink()) continue;
      const convId = bEnt.name;
      const transcriptPath = join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
      if (!isFile(transcriptPath)) continue;

      try {
        const st = statSync(transcriptPath);
        const projectPath = extractProjectPathFromTranscript(transcriptPath) || geminiDir;
        out.push({
          id: convId,
          path: transcriptPath,
          projectPath,
          mtimeMs: st.mtimeMs,
          size: st.size,
          kind: 'antigravity',
        });
      } catch {
        // ignora
      }
    }
  } catch {
    // ignora
  }

  return out;
}

/**
 * Lista todas as sessões recentes do Gemini (CLI + Antigravity), ordenadas pela mais recente.
 */
export { findCliSessions as findGeminiCliSessions };

export function findGeminiSessions(geminiDir: string): GeminiSessionFile[] {
  const all = [...findCliSessions(geminiDir), ...findAntigravitySessions(geminiDir)];
  all.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return all;
}
