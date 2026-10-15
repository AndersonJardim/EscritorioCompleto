// Rotas locais do Habblaud World (/api/world/*, server/world/http.ts): o que a página do Habblaud pede ao servidor
// local, que fala com o servidor do mundo por ela. Só na porta local, com Host local (nunca pela porta do celular), e
// tudo o que age pela conta só com a trava do terminal (bind local). O token do dispositivo nunca chega aqui.
//
//   GET  /api/world/status[?refresh=1]       → WorldStatus
//   POST /api/world/register                 {email, password, locale?, invite?} → 202 {}
//   POST /api/world/verify                   {email, code} → 200 WorldStatus (entra: grava o token neste computador)
//   POST /api/world/login                    {email, password} → 200 WorldStatus
//   POST /api/world/logout                   {} → 200 WorldStatus (apaga o token daqui e revoga no servidor)
//   POST /api/world/resend                   {email} → 202 {}
//   POST /api/world/password/forgot          {email} → 202 {}
//   POST /api/world/password/reset           {email, code, password} → 204
//   PUT  /api/world/character                PlayerInput → 200 Player
//   PUT  /api/world/visibility               Visibility → 200 Visibility
//   GET  /api/world/devices                  → {devices: DeviceInfo[]}
//   POST /api/world/devices/:id/revoke       {} → 204 (o próprio dispositivo: sai daqui também)
//
// Erros: {error: {code, message?, retryAfter?}} com o status do servidor do mundo quando vêm de lá (códigos em
// WORLD_ERROR_CODES do protocolo; um código novo passa como veio) ou com os códigos locais abaixo. A interface traduz
// pelo `code`; `message` é só para quem lê o log ou usa o curl.
import { WORLD_ERROR_CODES, type DeviceInfo, type Player, type WorldAccess, type WorldErrorCode } from './protocol';

/** Estado da conta neste computador. */
export type WorldState = 'off' | 'logged_out' | 'waiting' | 'approved';

/**
 * OfficeSnapshot.meta.world: só o necessário para a interface decidir se mostra a seção (o snapshot também vai ao
 * celular e à linha do tempo: nada da conta aqui).
 */
export interface WorldMeta {
  /**
   * A seção aparece: HABBLAUD_WORLD não é 0 e há HABBLAUD_WORLD_URL válida. Sem a URL o recurso está desligado (o
   * padrão até a versão que ligar o World) e nada do World aparece na interface.
   */
  enabled: boolean;
  /** HABBLAUD_WORLD_URL válida. */
  configured: boolean;
  state: WorldState;
}

/** GET /api/world/status (e a resposta de verify, login e logout). */
export interface WorldStatus {
  /** Dá para agir pela conta neste Habblaud (trava do terminal ligada: acesso só pelo próprio computador). */
  available: boolean;
  configured: boolean;
  state: WorldState;
  account?: { emailMasked: string; access: WorldAccess };
  player?: Player;
  devices?: DeviceInfo[];
  /** Código do último problema (worldLastError: só códigos conhecidos), quando os dados podem estar velhos. */
  lastError?: WorldKnownErrorCode;
}

export interface WorldErrorResponse {
  error: { code: string; message?: string; retryAfter?: number };
}

/**
 * Códigos dados pelo próprio servidor local. Ele também usa, com o mesmo sentido, alguns de WORLD_ERROR_CODES (os do
 * servidor do mundo): invalid, invalid_code, password_invalid, name_invalid, name_blocked, invalid_json, too_large,
 * unsupported_media_type, method_not_allowed, not_found e internal (500: erro do próprio servidor local).
 */
export const WORLD_LOCAL_ERROR_CODES = [
  'not_configured', // 409: sem HABBLAUD_WORLD_URL
  'local_only', // 403: pela porta do celular ou com Host que não é local
  'terminal_off', // 403: trava do terminal desligada (porta exposta na rede ou HABBLAUD_TERMINAL=0)
  'not_logged_in', // 401: ação da conta sem ter entrado
  'session_expired', // em lastError: o servidor do mundo recusou o token (revogado ou vencido) e a sessão foi apagada
  'invalid_email', // 400
  'altcha_failed', // 502: o desafio anti-robô do servidor do mundo não teve solução
  'world_unreachable', // 502: sem conexão com o servidor do mundo
  'world_timeout', // 504
  'world_bad_response', // 502: resposta fora do formato
  'world_error', // erro do servidor do mundo sem código legível (mesmo status)
  'storage_failed', // em lastError: não deu para gravar world.json (a sessão vale só até reiniciar)
  'network', // em lastError: sem conexão com o servidor do mundo ou sem resposta no prazo
  'unknown', // em lastError: outro problema (resposta fora do formato, código que esta versão não conhece)
] as const;
export type WorldLocalErrorCode = (typeof WORLD_LOCAL_ERROR_CODES)[number];

/** Todo código de erro conhecido: os do servidor do mundo e os do servidor local, sem repetir. */
export const WORLD_KNOWN_ERROR_CODES: readonly (WorldErrorCode | WorldLocalErrorCode)[] = [...new Set([...WORLD_ERROR_CODES, ...WORLD_LOCAL_ERROR_CODES])];
export type WorldKnownErrorCode = WorldErrorCode | WorldLocalErrorCode;

export function isWorldKnownErrorCode(v: unknown): v is WorldKnownErrorCode {
  return typeof v === 'string' && (WORLD_KNOWN_ERROR_CODES as readonly string[]).includes(v);
}

/**
 * O código que vai em WorldStatus.lastError: só os da lista; falta de conexão ou de resposta no prazo vira `network`, e
 * o resto (resposta fora do formato, erro sem código, código que esta versão não conhece) vira `unknown`.
 */
export function worldLastError(code: string): WorldKnownErrorCode {
  if (code === 'world_unreachable' || code === 'world_timeout') return 'network';
  if (code === 'world_bad_response' || code === 'world_error') return 'unknown';
  return isWorldKnownErrorCode(code) ? code : 'unknown';
}
