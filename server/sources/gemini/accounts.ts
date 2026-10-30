// Contas do Gemini: uma pasta GEMINI_HOME por conta (~/.gemini, ~/.gemini-dev...). Node puro e sem dependências
// do servidor: também pode ser importado por scripts.
//
// Descoberta: HABBLAUD_GEMINI_DIRS (lista separada por vírgula) substitui tudo; senão GEMINI_HOME e `$HOME/.gemini*`
// que tenham cara de pasta do Gemini (isGeminiHome). Letra da conta: o alias de shell `alias g='GEMINI_HOME=... gemini'`
// (sem GEMINI_HOME = a pasta padrão); sem alias, 'G' ou uma letra derivada. Cor: da paleta das contas. Nome: "Gemini".
// E-mail lido de google_accounts.json (campo active), quando existir.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  ACCOUNT_COLORS,
  accountIds,
  expandHome,
  isGeminiHome,
  parseAccountOverrides,
  readShellAliases,
  shortcutsByDir,
  type AccountOverride,
  type DetectedAccount,
} from '../../accounts/detect';

function splitList(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Pasta padrão do Gemini: GEMINI_HOME ou $HOME/.gemini. */
export function defaultGeminiHome(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string {
  const raw = env.GEMINI_HOME?.trim();
  return raw ? expandHome(raw, home) : join(home, '.gemini');
}

/**
 * Pastas do Gemini observadas. HABBLAUD_GEMINI_DIRS (lista separada por vírgula) substitui a detecção.
 * Senão: GEMINI_HOME e `$HOME/.gemini*` que passem em isGeminiHome.
 */
export function discoverGeminiDirs(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string[] {
  const override = splitList(env.HABBLAUD_GEMINI_DIRS);
  if (override.length) return [...new Set(override.map((p) => expandHome(p, home)))].filter(isDir);
  const found: string[] = [];
  const main = defaultGeminiHome(env, home);
  if (isGeminiHome(main)) found.push(main);
  try {
    for (const ent of readdirSync(home, { withFileTypes: true })) {
      if (!ent.name.startsWith('.gemini')) continue;
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      const p = join(home, ent.name);
      if (isGeminiHome(p)) found.push(p);
    }
  } catch {
    // $HOME ilegível
  }
  const dirs = [...new Set(found.map((p) => expandHome(p, home)))];
  dirs.sort((a, b) => (a === main ? 0 : 1) - (b === main ? 0 : 1) || a.localeCompare(b));
  return dirs;
}

/** Overrides das contas do Gemini em HABBLAUD_ACCOUNTS. */
export function geminiOverrides(raw: string | undefined): AccountOverride[] {
  return parseAccountOverrides(raw).filter((o) => o.provider === 'gemini');
}

function matchOverride(overrides: AccountOverride[], id: string, dir: string, home: string): AccountOverride | undefined {
  const norm = (p: unknown) => (typeof p === 'string' && p.trim() ? expandHome(p, home) : undefined);
  return overrides.find((o) => norm(o.mountDir) === dir) ?? overrides.find((o) => norm(o.configDir) === dir) ?? overrides.find((o) => o.id === id);
}

/** Letras candidatas de uma conta sem alias: a inicial do sufixo (".gemini-dev" → D), G, E, M, I... e o alfabeto. */
function letterCandidates(dir: string): string[] {
  const suffix = /^\.?gemini[-_.]+([A-Za-z])/i.exec(basename(dir))?.[1]?.toUpperCase();
  const out = suffix ? [suffix] : [];
  out.push('G', 'E', 'M', 'I', 'N', 'A', 'B');
  for (let i = 0; i < 26; i++) out.push(String.fromCharCode(65 + i));
  return out;
}

/** Lê o e-mail ativo da conta Google em google_accounts.json, se existir. */
export function readGoogleAccountEmail(dir: string): string | undefined {
  try {
    const file = join(dir, 'google_accounts.json');
    if (!existsSync(file)) return undefined;
    const data = JSON.parse(readFileSync(file, 'utf8')) as { active?: unknown };
    return typeof data.active === 'string' && data.active.includes('@') ? data.active.trim() : undefined;
  } catch {
    return undefined;
  }
}

export interface GeminiDetectOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Letras e cores já usadas por outras contas (não se repetem). */
  taken?: { shorts?: Iterable<string>; colors?: Iterable<string> };
}

/**
 * Uma conta por pasta do Gemini, na mesma ordem de `dirs`.
 */
export function detectGeminiAccounts(dirs: string[], opts: GeminiDetectOptions = {}): DetectedAccount[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? (env.HOME || homedir());
  const overrides = geminiOverrides(env.HABBLAUD_ACCOUNTS);
  const shortcuts = shortcutsByDir(readShellAliases(home, 'gemini'), home, defaultGeminiHome(env, home));
  const ids = accountIds(dirs);
  const usedShorts = new Set([...(opts.taken?.shorts ?? [])].map((s) => s.toUpperCase()));
  const usedColors = new Set(opts.taken?.colors ?? []);

  const partial = dirs.map((dir, i) => {
    const ov = matchOverride(overrides, ids[i], resolve(dir), home);
    const short = str(ov?.short)?.slice(0, 3) ?? shortcuts.get(resolve(dir));
    return { dir, id: str(ov?.id) ?? ids[i], ov, short: short && !usedShorts.has(short.toUpperCase()) ? short : undefined };
  });
  for (const p of partial) if (p.short) usedShorts.add(p.short.toUpperCase());

  return partial.map((p) => {
    const short = p.short ?? letterCandidates(p.dir).find((l) => !usedShorts.has(l)) ?? 'G';
    usedShorts.add(short.toUpperCase());
    let color = str(p.ov?.color);
    if (!color) {
      color = ACCOUNT_COLORS.find((c) => !usedColors.has(c)) ?? ACCOUNT_COLORS[1]; // default blue
      usedColors.add(color);
    }
    const email = str(p.ov?.email) ?? readGoogleAccountEmail(p.dir);
    const name = str(p.ov?.name) ?? (dirs.length > 1 ? `Gemini ${short}` : 'Gemini');
    const plan = str(p.ov?.plan) ?? 'Gemini';

    return {
      id: p.id,
      provider: 'gemini',
      configDir: str(p.ov?.configDir) ?? p.dir,
      short,
      name,
      email,
      plan,
      color,
    };
  });
}

