// Habblaud World na interface, parte pura (sem DOM): quando a seção de Configurações e o cartão de convite aparecem, a
// máquina de estados da seção, as regras de senha, nome de jogador e traços e o texto de cada erro. São conferências
// de antemão, para responder na hora: quem decide é o servidor (o nome, por exemplo, ainda passa pela lista de
// palavras bloqueadas, que só ele tem). A interface fica em settings-world.ts e invite-card.ts.
import { PART_KEYS, type AppearanceParts } from '../../../../shared/appearance';
import type { Appearance } from '../../art/api';
import { appearanceFromSeed } from '../../art/character/appearance';
// Na junção com o servidor, TraitId, TRAIT_IDS e os pares vêm de shared/world/traits.ts.
import { CLASHES, TRAIT_IDS, type TraitId } from '../../world/social/persona';
import type { WorldErrorCode, WorldMeta, WorldServerState, WorldVisibility } from '../../net/world';
import { isIntroId } from './intro-labels';
import { tr } from '../../../../shared/i18n';

// ------------------------------------------------------------------ quando aparece

/**
 * - hidden: nada do World (sem `meta.world`, `enabled: false` ou a página do celular pela porta remota);
 * - off: a seção mostra "desligado" (sem servidor do World configurado);
 * - local_only: aberto por outro endereço ou sem a trava do terminal: as rotas da conta respondem 403;
 * - active: dá para criar conta, entrar, editar o personagem...
 */
export type WorldSectionMode = 'hidden' | 'off' | 'local_only' | 'active';

export interface WorldGate {
  /** Página do celular (porta remota com login). */
  remote: boolean;
  /** Página aberta pelo próprio computador (Host local). */
  local: boolean;
  /** meta.terminal: o Habblaud só é acessível pelo próprio computador (a trava das ações da conta). */
  terminal: boolean;
  /** Modo demonstração com o FakeWorldApi: sem servidor, nenhuma trava vale. */
  fake: boolean;
}

export function worldSectionMode(meta: WorldMeta | undefined, gate: WorldGate): WorldSectionMode {
  if (!meta?.enabled || gate.remote) return 'hidden';
  if (!meta.configured || meta.state === 'off') return 'off';
  if (!gate.fake && (!gate.local || !gate.terminal)) return 'local_only';
  return 'active';
}

/** Chave do cartão "Conheça o Habblaud World" no localStorage: gravada quando o cartão aparece (ele sai uma vez só). */
export const INVITE_SEEN_KEY = 'habblaud:world-invite-seen';

/** O cartão de convite aparece? Só para quem ainda não tem conta, pelo próprio computador, e uma vez por navegador. */
export function shouldShowInvite(meta: WorldMeta | undefined, gate: WorldGate & { replaying: boolean }, seen: string | null): boolean {
  return worldSectionMode(meta, gate) === 'active' && meta?.state === 'logged_out' && !gate.replaying && seen === null;
}

// ------------------------------------------------------------------ máquina de estados da seção

export type WorldScreen =
  // sem conta (state 'logged_out')
  | 'welcome'
  | 'register'
  | 'login'
  | 'verify'
  | 'forgot'
  | 'reset'
  // com conta ('waiting' ou 'approved')
  | 'home'
  | 'character'
  | 'visibility'
  | 'devices';

/** Aviso curto no topo da seção depois de uma ação (some na próxima navegação). */
export type WorldFlash = 'code_sent' | 'code_resent' | 'password_changed' | 'signed_out' | 'character_saved' | 'device_revoked';

export interface WorldUi {
  /** Estado da conta segundo o último GET /api/world/status (antes dele, o do snapshot). */
  server: WorldServerState | null;
  screen: WorldScreen;
  /** E-mail digitado: passa do cadastro para o código, do "esqueci a senha" para a senha nova e para o login. */
  email: string;
  flash: WorldFlash | null;
}

export type WorldUiEvent =
  | { type: 'server'; state: WorldServerState }
  | { type: 'go'; screen: WorldScreen }
  /** Cadastro aceito ou login de e-mail ainda não confirmado: o código foi para o e-mail. */
  | { type: 'code_sent'; email: string }
  /** "Esqueci a senha": o código da senha nova foi para o e-mail. */
  | { type: 'reset_code_sent'; email: string }
  | { type: 'password_changed' }
  | { type: 'flash'; flash: WorldFlash };

const SIGNED_OUT: readonly WorldScreen[] = ['welcome', 'register', 'login', 'verify', 'forgot', 'reset'];
const SIGNED_IN: readonly WorldScreen[] = ['home', 'character', 'visibility', 'devices'];

/** Telas possíveis em cada estado da conta (a primeira é a de entrada). */
export function screensFor(state: WorldServerState): readonly WorldScreen[] {
  if (state === 'waiting' || state === 'approved') return SIGNED_IN;
  if (state === 'logged_out') return SIGNED_OUT;
  return [];
}

export function initialWorldUi(): WorldUi {
  return { server: null, screen: 'welcome', email: '', flash: null };
}

/** A tela continua valendo para o estado da conta? Senão, volta para a de entrada (ex.: saiu da conta → boas-vindas). */
function fit(s: WorldUi): WorldUi {
  if (!s.server) return s;
  const allowed = screensFor(s.server);
  if (!allowed.length || allowed.includes(s.screen)) return s;
  return { ...s, screen: allowed[0] };
}

export function worldReduce(s: WorldUi, e: WorldUiEvent): WorldUi {
  switch (e.type) {
    case 'server':
      return fit({ ...s, server: e.state });
    case 'go':
      return fit({ ...s, screen: e.screen, flash: null });
    case 'code_sent':
      return fit({ ...s, screen: 'verify', email: e.email, flash: 'code_sent' });
    case 'reset_code_sent':
      return fit({ ...s, screen: 'reset', email: e.email, flash: 'code_sent' });
    case 'password_changed':
      return fit({ ...s, screen: 'login', flash: 'password_changed' });
    case 'flash':
      return { ...s, flash: e.flash };
  }
}

// ------------------------------------------------------------------ e-mail, código e senha

export function normalizeEmail(raw: string): string {
  return raw.normalize('NFC').trim();
}

export function emailLooksValid(raw: string): boolean {
  const e = normalizeEmail(raw);
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

/** Código do e-mail: só os dígitos do que foi digitado ou colado ("123 456" vale). */
export function normalizeCode(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, 6);
}

export function codeLooksValid(raw: string): boolean {
  return /^\d{6}$/.test(normalizeCode(raw));
}

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

export type PasswordProblem = 'short' | 'long' | 'email' | 'repeated';

/**
 * Regras da senha que dá para conferir sem o servidor: de 12 a 128 caracteres (em NFC), diferente do e-mail e que não
 * seja só repetição ("aaaaaaaaaaaa", "abcabcabcabc"). A lista de senhas vazadas quem confere é o servidor.
 */
export function passwordProblem(password: string, email = ''): PasswordProblem | null {
  const p = password.normalize('NFC');
  const n = [...p].length;
  if (n < PASSWORD_MIN) return 'short';
  if (n > PASSWORD_MAX) return 'long';
  const mail = normalizeEmail(email).toLowerCase();
  const lower = p.toLowerCase();
  if (mail && (lower === mail || lower === mail.split('@')[0])) return 'email';
  if (/^(.+?)\1+$/su.test(p)) return 'repeated';
  return null;
}

export function passwordProblemText(p: PasswordProblem): string {
  switch (p) {
    case 'short':
      return tr('A senha precisa ter pelo menos 12 caracteres.');
    case 'long':
      return tr('A senha pode ter no máximo 128 caracteres.');
    case 'email':
      return tr('A senha não pode ser o seu e-mail.');
    case 'repeated':
      return tr('A senha não pode ser só uma repetição (como "aaaaaaaaaaaa").');
  }
}

// ------------------------------------------------------------------ nome de jogador

export const PLAYER_NAME_MIN = 3;
export const PLAYER_NAME_MAX = 20;

/** Nomes que ninguém pode usar (o servidor ainda confere a lista de palavras bloqueadas). */
export const RESERVED_NAMES: readonly string[] = [
  'habblaud', 'admin', 'staff', 'claude', 'anthropic', 'codex', 'openai', 'moderador', 'moderator', 'suporte', 'support',
  'system', 'world',
];

export type NameProblem = 'length' | 'chars' | 'scripts' | 'reserved';

// Controle, formatação (larguras zero, marcas de direção), separadores de linha e parágrafo.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const NAME_CHARS = /^[\p{L}\p{M}\p{Nd} _.-]+$/u;
const SCRIPTS: readonly [string, RegExp][] = [
  ['Latin', /\p{Script=Latin}/u],
  ['Greek', /\p{Script=Greek}/u],
  ['Cyrillic', /\p{Script=Cyrillic}/u],
  ['Armenian', /\p{Script=Armenian}/u],
  ['Georgian', /\p{Script=Georgian}/u],
  ['Hebrew', /\p{Script=Hebrew}/u],
  ['Arabic', /\p{Script=Arabic}/u],
  ['Devanagari', /\p{Script=Devanagari}/u],
  ['Bengali', /\p{Script=Bengali}/u],
  ['Tamil', /\p{Script=Tamil}/u],
  ['Thai', /\p{Script=Thai}/u],
  ['Hangul', /\p{Script=Hangul}/u],
  ['Hiragana', /\p{Script=Hiragana}/u],
  ['Katakana', /\p{Script=Katakana}/u],
  ['Han', /\p{Script=Han}/u],
];
/** Misturas que são uma escrita só: japonês (kanji + kana) e coreano (hangul + hanja). */
const MIXES: readonly (readonly string[])[] = [
  ['Han', 'Hiragana', 'Katakana'],
  ['Han', 'Hangul'],
];

function scriptOf(ch: string): string {
  return SCRIPTS.find(([, re]) => re.test(ch))?.[0] ?? `?${ch}`;
}

/** Letras de um só sistema de escrita ("Mаria" com "а" cirílico, não). */
export function singleScript(name: string): boolean {
  const found = new Set<string>();
  for (const ch of name) if (/\p{L}/u.test(ch)) found.add(scriptOf(ch));
  if (found.size <= 1) return true;
  return MIXES.some((mix) => [...found].every((s) => mix.includes(s)));
}

/** Chave de unicidade: NFKC, minúsculas, sem diacríticos e com os espaços colapsados ("Júlia  B" = "julia b"). */
export function playerNameKey(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Nome de jogador: NFC e sem espaços nas pontas; de 3 a 20 caracteres; letras de uma escrita, dígitos, espaço, _ - . */
export function parsePlayerName(raw: string): { ok: true; name: string } | { ok: false; problem: NameProblem } {
  const name = raw.normalize('NFC').trim();
  if (INVISIBLE.test(name)) return { ok: false, problem: 'chars' };
  const n = [...name].length;
  if (n < PLAYER_NAME_MIN || n > PLAYER_NAME_MAX) return { ok: false, problem: 'length' };
  if (!NAME_CHARS.test(name)) return { ok: false, problem: 'chars' };
  if (!singleScript(name)) return { ok: false, problem: 'scripts' };
  if (RESERVED_NAMES.includes(playerNameKey(name))) return { ok: false, problem: 'reserved' };
  return { ok: true, name };
}

export function nameProblemText(p: NameProblem): string {
  switch (p) {
    case 'length':
      return tr('O nome precisa ter de 3 a 20 caracteres.');
    case 'chars':
      return tr('Use só letras, números, espaço, _ - e . no nome.');
    case 'scripts':
      return tr('Use letras de um só alfabeto no nome.');
    case 'reserved':
      return tr('Este nome é reservado. Escolha outro.');
  }
}

// ------------------------------------------------------------------ traços

export const TRAITS_MIN = 2;
export const TRAITS_MAX = 3;

export function isTraitId(v: unknown): v is TraitId {
  return typeof v === 'string' && (TRAIT_IDS as readonly string[]).includes(v);
}

export function traitsClash(a: TraitId, b: TraitId): boolean {
  return CLASHES.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

/**
 * Dá para marcar o traço `t` com os já escolhidos? Os escolhidos sempre dá (para desmarcar); os outros não quando já
 * há 3 ou quando não combinam com um deles (`with` diz qual).
 */
export function traitBlock(selected: readonly TraitId[], t: TraitId): { reason: 'full' } | { reason: 'clash'; with: TraitId } | null {
  if (selected.includes(t)) return null;
  const clash = selected.find((s) => traitsClash(s, t));
  if (clash) return { reason: 'clash', with: clash };
  if (selected.length >= TRAITS_MAX) return { reason: 'full' };
  return null;
}

/** Marca ou desmarca (sem efeito se o traço estiver bloqueado). */
export function toggleTrait(selected: readonly TraitId[], t: TraitId): TraitId[] {
  if (selected.includes(t)) return selected.filter((s) => s !== t);
  return traitBlock(selected, t) ? [...selected] : [...selected, t];
}

/** 2 ou 3 traços conhecidos, sem repetição e sem pares que não combinam. */
export function traitsValid(traits: readonly unknown[]): traits is TraitId[] {
  if (traits.length < TRAITS_MIN || traits.length > TRAITS_MAX) return false;
  if (!traits.every(isTraitId) || new Set(traits).size !== traits.length) return false;
  const list = traits as TraitId[];
  return list.every((a, i) => list.slice(i + 1).every((b) => !traitsClash(a, b)));
}

// ------------------------------------------------------------------ personagem

/** Semente fixa do rascunho: o jogador não tem semente (vale o `parts` completo), então ela só dá o ponto de partida. */
export const PLAYER_DRAFT_SEED = 0x5eed;

/**
 * Todas as peças da aparência (as 13 de PART_KEYS). O personagem do mundo vai sem semente: um `parts` parcial seria
 * completado de outro jeito em cada lugar que o desenha.
 */
export function fullParts(a: Appearance): AppearanceParts {
  const full: Record<string, string> = {};
  for (const k of PART_KEYS) {
    const v = k === 'facialHair' ? (a.facialHair ?? 'none') : k === 'bottomStyle' ? (a.bottomStyle ?? 'pants') : a[k];
    full[k] = v;
  }
  return full as AppearanceParts;
}

/** Aparência de partida do editor: a do personagem salvo (peças por cima da semente fixa) ou um sorteio. */
export function draftAppearance(look: 'f' | 'm', parts?: AppearanceParts, seed = PLAYER_DRAFT_SEED): Appearance {
  return appearanceFromSeed(seed, { look, parts });
}

export type CharacterProblem = { field: 'name'; problem: NameProblem } | { field: 'traits' } | { field: 'intro' };

/** O que falta para salvar o personagem (o primeiro problema), ou null. */
export function characterProblem(d: { name: string; traits: readonly TraitId[]; intro: string | null }): CharacterProblem | null {
  const name = parsePlayerName(d.name);
  if (!name.ok) return { field: 'name', problem: name.problem };
  if (!traitsValid(d.traits)) return { field: 'traits' };
  if (!d.intro || !isIntroId(d.intro)) return { field: 'intro' };
  return null;
}

// ------------------------------------------------------------------ visibilidade

export const DEFAULT_VISIBILITY: Readonly<WorldVisibility> = {
  mode: 'live',
  closed: false,
  hideCountry: false,
  tokensVisible: true,
  leaderboard: false,
  compactions: false,
};

export type VisibilitySwitch = Exclude<keyof WorldVisibility, 'mode'>;

/** Ordem dos interruptores na tela. */
export const VISIBILITY_SWITCHES: readonly VisibilitySwitch[] = ['closed', 'hideCountry', 'tokensVisible', 'leaderboard', 'compactions'];

// ------------------------------------------------------------------ erros

/** O que a interface estava fazendo: o mesmo código ("invalid") quer dizer coisas diferentes em cada ação. */
export type WorldAction =
  | 'status'
  | 'register'
  | 'verify'
  | 'login'
  | 'logout'
  | 'resend'
  | 'forgot'
  | 'reset'
  | 'character'
  | 'visibility'
  | 'devices'
  | 'revoke';

/** Texto de um erro (o `message` do servidor, em inglês, nunca aparece). Código desconhecido: texto genérico. */
export function worldErrorText(code: WorldErrorCode | string, action: WorldAction): string {
  switch (code) {
    case 'invalid_code':
      return tr('Código errado ou vencido. Confira o e-mail ou peça outro código.');
    case 'invalid_credentials':
      return tr('E-mail ou senha não conferem.');
    case 'email_not_verified':
      return tr('Falta confirmar o e-mail: mandamos um código novo.');
    case 'banned':
      return tr('Esta conta foi banida do Habblaud World. Para recorrer, responda ao e-mail do banimento.');
    case 'name_taken':
      return tr('Este nome já está em uso no mundo. Escolha outro.');
    case 'name_invalid':
      return tr('Nome inválido: de 3 a 20 caracteres, com letras de um só alfabeto, números, espaço, _ - e .');
    case 'name_blocked':
      return tr('Este nome não é permitido. Escolha outro.');
    case 'not_configured':
      return tr('O Habblaud World não está ligado neste Habblaud (falta HABBLAUD_WORLD_URL).');
    case 'rate_limited':
      return tr('Muitas tentativas seguidas. Espere alguns minutos e tente de novo.');
    case 'network':
      return tr('O servidor do Habblaud World não respondeu. Tente de novo em instantes.');
    case 'offline':
      return tr('Sem conexão com o Habblaud.');
    case 'forbidden':
      return tr('A conta do World só pode ser mexida pelo próprio computador, com o Habblaud aberto em localhost.');
    case 'invalid':
      switch (action) {
        case 'register':
        case 'reset':
          return tr('O servidor recusou o e-mail ou a senha. A senha precisa ter de 12 a 128 caracteres e não pode estar numa lista de senhas vazadas.');
        case 'character':
          return tr('O servidor recusou o personagem. Confira o nome, os traços (2 ou 3) e a frase de apresentação.');
        case 'visibility':
          return tr('O servidor recusou as opções de visibilidade.');
        default:
          return tr('O servidor recusou o pedido. Confira os dados e tente de novo.');
      }
    default:
      return tr('Algo deu errado. Tente de novo em instantes.');
  }
}
