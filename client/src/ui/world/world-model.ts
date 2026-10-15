// Habblaud World na interface, parte pura (sem DOM): quando a seção de Configurações e o cartão de convite aparecem, a
// máquina de estados da seção, as regras de senha, nome de jogador e traços e o texto de cada erro. São conferências
// de antemão, para responder na hora: quem decide é o servidor (o nome, por exemplo, ainda passa pela lista de
// palavras bloqueadas, que só ele tem). Também o cartão "Seu prédio" (Fase 2): estado, contagens, motivo de uma
// remessa recusada, o chip da barra do topo e quando o tema vai para o mundo. A interface fica em settings-world.ts,
// building.ts, world-chip.ts e invite-card.ts.
import { PART_KEYS, type AppearanceParts } from '../../../../shared/appearance';
import type { Appearance } from '../../art/api';
import { appearanceFromSeed } from '../../art/character/appearance';
import { PLAYER_TRAITS } from '../../../../shared/world/protocol';
import { parsePlayerTraits, traitsClash, type TraitId } from '../../../../shared/world/traits';
import type { WorldBuildingStatus, WorldBuildingStop, WorldErrorCode, WorldLastUplink, WorldMeta, WorldServerState, WorldVisibility } from '../../net/world';
import { UPLINK_ACK_ERRORS, type WorldUplink } from '../../../../shared/world/protocol';
import { formatInt, relativeTime } from '../format';
import { isWorldKnownErrorCode } from '../../../../shared/world/api';
import { isIntroId } from '../../../../shared/world/intro';
import { parsePlayerName, type PlayerNameProblem } from '../../../../shared/world/names-rules';
import { tr } from '../../../../shared/i18n';

// ------------------------------------------------------------------ quando aparece

/**
 * - hidden: nada do World (sem `meta.world`, `enabled: false`, sem servidor do World configurado, que é o padrão:
 *   o recurso fica desligado e nada aparece; ou a página do celular pela porta remota);
 * - local_only: aberto por outro endereço ou sem a trava do terminal: as rotas da conta respondem 403;
 * - active: dá para criar conta, entrar, editar o personagem...
 */
export type WorldSectionMode = 'hidden' | 'local_only' | 'active';

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
  if (!meta?.enabled || !meta.configured || meta.state === 'off' || gate.remote) return 'hidden';
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
  /** Entrou (código confirmado ou login): o aviso da tela de entrada não vale mais. */
  | { type: 'signed_in' }
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
    case 'signed_in':
      return { ...s, flash: null };
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

// Regras e chave de unicidade: shared/world/names-rules.ts (as mesmas do servidor do mundo, menos a lista de palavras
// bloqueadas, que só ele tem). Aqui fica só o texto de cada motivo.

export function nameProblemText(p: PlayerNameProblem): string {
  switch (p) {
    case 'type':
    case 'length':
      return tr('O nome precisa ter de 3 a 20 caracteres.');
    case 'invisible':
      return tr('Tire do nome os caracteres invisíveis e os espaços especiais.');
    case 'chars':
      return tr('Use só letras, números, espaço, _ - e . no nome.');
    case 'scripts':
      return tr('Use letras de um só alfabeto no nome.');
    case 'no_letter':
      return tr('O nome precisa ter pelo menos uma letra.');
    case 'reserved':
      return tr('Este nome é reservado. Escolha outro.');
  }
}

// ------------------------------------------------------------------ traços

// Ids, rótulos, pares que não combinam e a validação da escolha: shared/world/traits.ts (os mesmos do servidor).

/**
 * Dá para marcar o traço `t` com os já escolhidos? Os escolhidos sempre dá (para desmarcar); os outros não quando já
 * há 3 ou quando não combinam com um deles (`with` diz qual).
 */
export function traitBlock(selected: readonly TraitId[], t: TraitId): { reason: 'full' } | { reason: 'clash'; with: TraitId } | null {
  if (selected.includes(t)) return null;
  const clash = selected.find((s) => traitsClash(s, t));
  if (clash) return { reason: 'clash', with: clash };
  if (selected.length >= PLAYER_TRAITS.max) return { reason: 'full' };
  return null;
}

/** Marca ou desmarca (sem efeito se o traço estiver bloqueado). */
export function toggleTrait(selected: readonly TraitId[], t: TraitId): TraitId[] {
  if (selected.includes(t)) return selected.filter((s) => s !== t);
  return traitBlock(selected, t) ? [...selected] : [...selected, t];
}

/** 2 ou 3 traços conhecidos, sem repetição e sem pares que não combinam (parsePlayerTraits, a regra do servidor). */
export function traitsValid(traits: readonly unknown[]): traits is TraitId[] {
  return parsePlayerTraits(traits) !== null;
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

export type CharacterProblem = { field: 'name'; problem: PlayerNameProblem } | { field: 'traits' } | { field: 'intro' };

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
  | 'revoke'
  | 'pause'
  | 'resume'
  | 'leave'
  | 'sent'
  | 'theme';

/**
 * Texto de um erro (o `message` do servidor, em inglês, nunca aparece). O switch cobre todo WorldErrorCode (o
 * compilador cobra um texto para cada código novo); um código que esta versão não conhece leva o texto genérico.
 */
export function worldErrorText(raw: WorldErrorCode | string, action: WorldAction): string {
  const code: WorldErrorCode = isWorldKnownErrorCode(raw) || raw === 'offline' || raw === 'forbidden' ? raw : 'unknown';
  switch (code) {
    case 'invalid_code':
      return tr('Código errado ou vencido. Confira o e-mail ou peça outro código.');
    case 'invalid_credentials':
      return tr('E-mail ou senha não conferem.');
    case 'email_not_verified':
      return tr('Falta confirmar o e-mail: mandamos um código novo.');
    case 'banned':
      return tr('Esta conta foi banida do Habblaud World. Para recorrer, responda ao e-mail do banimento.');
    case 'suspended':
      return tr('Esta conta está suspensa no Habblaud World por enquanto.');
    case 'unauthorized':
    case 'not_logged_in':
    case 'session_expired':
      return tr('A sessão do Habblaud World neste computador terminou. Entre de novo.');
    case 'name_taken':
      return tr('Este nome já está em uso no mundo. Escolha outro.');
    case 'name_invalid':
      return tr('Nome inválido: de 3 a 20 caracteres, com letras de um só alfabeto, números, espaço, _ - e .');
    case 'name_blocked':
      return tr('Este nome não é permitido. Escolha outro.');
    case 'name_cooldown':
      return tr('O nome só pode ser trocado uma vez a cada 30 dias.');
    case 'password_invalid':
      return tr('A senha precisa ter de 12 a 128 caracteres.');
    case 'password_weak':
      return tr('Senha fraca: não use o e-mail, o nome de jogador nem só repetição.');
    case 'password_pwned':
      return tr('Esta senha aparece em vazamentos de dados conhecidos. Escolha outra.');
    case 'invalid_email':
      return tr('E-mail inválido. Confira o endereço.');
    case 'altcha_required':
    case 'altcha_invalid':
    case 'altcha_failed':
      return tr('A verificação anti-robô não passou. Tente de novo em instantes.');
    case 'device_limit':
      return tr('Esta conta já tem 3 computadores; revogue um em Dispositivos.');
    case 'no_player':
      return tr('Crie o personagem primeiro.');
    case 'unavailable':
      return tr('O Habblaud World está em manutenção. Tente de novo mais tarde.');
    case 'not_found':
      return action === 'revoke' ? tr('Este dispositivo não está mais na conta.') : tr('O servidor do Habblaud World não encontrou o que foi pedido.');
    case 'invalid_json':
    case 'too_large':
    case 'unsupported_media_type':
    case 'method_not_allowed':
      return tr('O pedido saiu num formato que o servidor não aceita. Atualize o Habblaud e tente de novo.');
    case 'not_configured':
      return tr('O Habblaud World não está ligado neste Habblaud (falta HABBLAUD_WORLD_URL).');
    case 'rate_limited':
      return tr('Muitas tentativas seguidas. Espere alguns minutos e tente de novo.');
    case 'network':
    case 'world_unreachable':
    case 'world_timeout':
      return tr('O servidor do Habblaud World não respondeu. Tente de novo em instantes.');
    case 'world_bad_response':
      return tr('O servidor do Habblaud World respondeu algo inesperado. Tente de novo em instantes.');
    case 'storage_failed':
      return tr('Não deu para gravar a sessão neste computador: ela vale só até o Habblaud reiniciar.');
    case 'offline':
      return tr('Sem conexão com o Habblaud.');
    case 'forbidden':
    case 'local_only':
      return tr('A conta do World só pode ser mexida pelo próprio computador, com o Habblaud aberto em localhost.');
    case 'terminal_off':
      return tr('A conta do World só pode ser mexida com o Habblaud acessível apenas pelo próprio computador (acesso local, bind 127.0.0.1).');
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
    case 'internal':
      return tr('O servidor do mundo teve um erro; tente de novo.');
    case 'world_error':
    case 'unknown':
      return tr('Algo deu errado. Tente de novo em instantes.');
  }
}

// ------------------------------------------------------------------ prédio no mundo (Fase 2)

/**
 * Estado do cartão "Seu prédio" (conta aprovada). Sem personagem o prédio não entra no mundo; fora do mundo ("Sair do
 * mundo") e pausado valem mais do que a conexão (os dois fecham o socket); depois, uma parada pedida pelo servidor do
 * mundo (`stopped`, com o motivo); sem conexão aberta, o Habblaud está conectando ou tentando de novo.
 */
export type BuildingState = 'connected' | 'reconnecting' | 'paused' | 'stopped' | 'left' | 'no_player';

export function buildingState(b: WorldBuildingStatus | undefined, hasPlayer: boolean): BuildingState {
  if (!hasPlayer) return 'no_player';
  if (b?.left) return 'left';
  if (b?.paused) return 'paused';
  if (b?.stopped) return 'stopped';
  return b?.connected ? 'connected' : 'reconnecting';
}

/** O que o cartão diz quando o servidor do mundo parou o prédio (`goodbye`), por motivo. */
export function buildingStopView(reason: WorldBuildingStop): { label: string; desc: string; toggle: BuildingView['toggle'] } {
  switch (reason) {
    case 'update':
      return { label: tr('Atualize o Habblaud'), desc: tr('Esta versão do Habblaud não entra mais no mundo. Atualize para o prédio voltar a acender.'), toggle: null };
    case 'other-device':
      return {
        label: tr('Conectado em outro computador'),
        desc: tr('A sua conta conectou o prédio em outro computador, e este parou de enviar.'),
        toggle: { action: 'resume', text: tr('Trazer para este computador'), hint: tr('O prédio volta a subir daqui, e o outro computador para de enviar.') },
      };
    case 'banned':
      return { label: tr('Conta banida'), desc: tr('O Habblaud World baniu esta conta: o prédio saiu do mundo e nada mais sai deste computador.'), toggle: null };
    case 'suspended':
      return {
        label: tr('Conta suspensa'),
        desc: tr('Esta conta está suspensa no Habblaud World: o prédio fica apagado e nada sai deste computador.'),
        toggle: { action: 'resume', text: tr('Tentar de novo'), hint: tr('Se a suspensão já acabou, o prédio volta a acender.') },
      };
    case 'waiting':
      return { label: tr('Na lista de espera'), desc: tr('A conta voltou para a lista de espera: o prédio sai do mundo até o acesso ser liberado de novo.'), toggle: null };
    case 'no_player':
      return { label: tr('Sem personagem'), desc: tr('O mundo não encontrou o seu personagem: crie de novo para o prédio voltar.'), toggle: null };
    case 'unauthorized':
      return { label: tr('Entre de novo'), desc: tr('O servidor do mundo não reconheceu este computador: entre de novo na conta.'), toggle: null };
  }
}

/**
 * Motivos com que o servidor do mundo recusa uma remessa (`uplink.ack {error}`, UPLINK_ACK_ERRORS do protocolo); um
 * código que esta versão não conhece chega como `internal` (net/world.ts) e um fora da lista vira o genérico.
 */
export const UPLINK_REJECT_CODES = UPLINK_ACK_ERRORS;

/** Por que o mundo recusou a remessa, em uma frase. */
export function uplinkRejectText(code: string | undefined): string {
  switch (code) {
    case 'schema':
      return tr('O pacote saiu fora do formato do protocolo. Atualize o Habblaud.');
    case 'limits':
      return tr('O escritório passou dos limites do mundo (64 andares, 64 agentes por andar, 256 agentes ou 64 KB).');
    case 'name_pool':
      return tr('Um nome de personagem não está na lista de nomes do mundo.');
    case 'parts':
      return tr('Uma peça de aparência está fora das paletas do editor.');
    case 'ids':
      return tr('Um código de andar ou de agente está fora do formato.');
    case 'rate':
      return tr('Remessas demais em pouco tempo (o limite é 12 por minuto). A próxima vai normalmente.');
    case 'internal':
      return tr('Um erro no servidor do mundo. A próxima remessa tenta de novo.');
    default:
      return tr('Um motivo que esta versão do Habblaud não conhece.');
  }
}

export interface BuildingView {
  state: BuildingState;
  /** Selo do estado ("Conectado", "Pausado"...). */
  label: string;
  /** O que o estado quer dizer, em uma ou duas frases. */
  desc: string;
  /** "2 andares", "3 agentes", "Última remessa: há 12 s" (vazio sem personagem). */
  stats: string[];
  /** Motivo da recusa da última remessa (null: aceita ou sem resposta ainda). */
  rejected: string | null;
  /** Texto do botão de pausa e a explicação dele (null: sem botão). */
  toggle: { action: 'pause' | 'resume'; text: string; hint: string } | null;
  /** Mostra "Sair do mundo" (há um prédio no mundo para retirar). */
  leave: boolean;
}

/** "1 byte", "1.174 bytes". */
export function bytesText(n: number): string {
  return n === 1 ? tr('1 byte') : tr('{0} bytes', [formatInt(n)]);
}

/** "1 andar", "3 andares". */
export function floorsText(n: number): string {
  return n === 1 ? tr('1 andar') : tr('{0} andares', [formatInt(n)]);
}

/** "1 agente", "3 agentes". */
export function agentsText(n: number): string {
  return n === 1 ? tr('1 agente') : tr('{0} agentes', [formatInt(n)]);
}

/** Tudo o que o cartão "Seu prédio" mostra, sem DOM. */
export function buildingView(b: WorldBuildingStatus | undefined, hasPlayer: boolean, now: number): BuildingView {
  const state = buildingState(b, hasPlayer);
  const floors = b?.floors ?? 0;
  const agents = b?.agents ?? 0;
  const stats =
    state === 'no_player' || state === 'left'
      ? []
      : [
          floorsText(floors),
          agentsText(agents),
          b?.lastUplinkAt ? tr('Última remessa: {0}', [relativeTime(b.lastUplinkAt, now)]) : tr('Nenhuma remessa ainda'),
        ];
  const live = state === 'connected' || state === 'reconnecting' || state === 'paused';
  const rejected = live && b?.lastAck?.ok === false ? uplinkRejectText(b.lastAck.error) : null;
  const later = tr('Pausado por 30 dias, o prédio some do mapa e, 30 dias depois, é retirado; retomar antes disso traz de volta, no mesmo lote.');
  switch (state) {
    case 'no_player':
      return { state, label: tr('Sem personagem'), desc: tr('Crie o seu personagem: o prédio entra no mundo junto com ele.'), stats, rejected, toggle: null, leave: false };
    case 'left':
      return {
        state,
        label: tr('Fora do mundo'),
        desc: tr('Você saiu do mundo: o prédio foi retirado e o lote, liberado. Nada sai deste computador.'),
        stats,
        rejected: null,
        toggle: { action: 'resume', text: tr('Voltar ao mundo'), hint: tr('Voltar cria um prédio novo, em outro lote; a conta e o personagem são os mesmos.') },
        leave: false,
      };
    case 'stopped': {
      const reason = b!.stopped!;
      const v = buildingStopView(reason);
      return { state, ...v, stats, rejected, leave: reason === 'update' || reason === 'other-device' || reason === 'suspended' };
    }
    case 'paused':
      return {
        state,
        label: tr('Pausado'),
        desc: tr('Nada sai deste computador e o prédio está apagado no mundo.'),
        stats,
        rejected,
        toggle: { action: 'resume', text: tr('Retomar'), hint: `${tr('Retomar volta a enviar e acende o prédio.')} ${later}` },
        leave: true,
      };
    case 'connected':
    case 'reconnecting': {
      const connected = state === 'connected';
      const first = !b?.lastUplinkAt;
      return {
        state,
        label: connected ? tr('Conectado') : first ? tr('Conectando…') : tr('Reconectando…'),
        desc: connected
          ? tr('Aceso no mundo: um andar por sala aberta e cada personagem no status de agora. Os tokens, se você deixar, aparecem só em faixas, no medidor da fachada.')
          : first
            ? tr('O prédio acende com a primeira remessa.')
            : tr('Sem conexão com o mundo agora: o Habblaud tenta de novo sozinho. Com 2 minutos sem notícias, o prédio apaga.'),
        stats,
        rejected,
        toggle: { action: 'pause', text: tr('Pausar'), hint: `${tr('Pausar interrompe o envio na hora e apaga o prédio no mundo.')} ${later}` },
        leave: true,
      };
    }
  }
}

/** A diferença entre pausar e sair do mundo (PLANO.md, seção 2.6), ao lado do botão "Sair do mundo". */
export function leaveHint(): string {
  return tr(
    'Pausar apaga o prédio e guarda o lote: retomar traz de volta, no mesmo lugar. Sair do mundo retira o prédio na hora e libera o lote; a conta e o personagem continuam, e voltar depois cria um prédio novo, em outro lote.',
  );
}

export type AckKind = 'accepted' | 'rejected' | 'pending';

/**
 * A resposta do mundo a uma remessa, para a janela "Ver o que foi enviado". Aceita, com os bytes que o mundo contou
 * (iguais aos enviados, `sentBytes`, quando o pacote chegou inteiro).
 */
export function ackView(ack: WorldLastUplink['ack'], sentBytes?: number): { kind: AckKind; label: string; reason: string | null } {
  if (!ack) return { kind: 'pending', label: tr('Sem resposta do mundo ainda.'), reason: null };
  if (ack.ok) {
    const reason =
      ack.bytes === undefined ? null : ack.bytes === sentBytes ? tr('O mundo recebeu os mesmos {0}.', [bytesText(ack.bytes)]) : tr('O mundo contou {0}.', [bytesText(ack.bytes)]);
    return { kind: 'accepted', label: tr('Aceita pelo mundo.'), reason };
  }
  return { kind: 'rejected', label: tr('Recusada pelo mundo.'), reason: uplinkRejectText(ack.error) };
}

/** O pacote como a janela mostra: o mesmo objeto que foi para o fio, só com recuo (2 espaços). */
export function prettyUplink(uplink: WorldUplink): string {
  return JSON.stringify(uplink, null, 2);
}

/**
 * A escolha de Aparência › Tema do escritório também vai para o prédio (PUT /api/world/theme)? Só com o World ligado,
 * a conta aprovada e a página onde dá para mexer na conta (a rota é só local).
 */
export function themeGoesToWorld(meta: WorldMeta | undefined, gate: WorldGate): boolean {
  return worldSectionMode(meta, gate) === 'active' && meta?.state === 'approved';
}

export type WorldChipState = 'live' | 'paused' | 'reconnecting' | 'stopped';

/**
 * Chip da barra do topo ("🏙️ no mundo" / "⏸ pausado" / "⚠️ parado"): só com `meta.world.building` (conta aprovada) e
 * nunca pela porta do celular. Fora do mundo, nada. Parado pelo servidor do mundo, "parado" (o motivo fica no cartão).
 * Sem conexão, só aparece se o prédio já mandou alguma remessa (antes disso não está no mundo).
 */
export function worldChipState(meta: WorldMeta | undefined, gate: WorldGate): WorldChipState | null {
  const b = meta?.building;
  if (!b || b.left || meta.state !== 'approved' || worldSectionMode(meta, gate) === 'hidden') return null;
  if (b.paused) return 'paused';
  if (b.stopped) return 'stopped';
  if (b.connected) return 'live';
  return b.lastUplinkAt ? 'reconnecting' : null;
}
