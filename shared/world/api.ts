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
// WORLD_ERROR_CODES do protocolo) ou com os códigos locais abaixo. A interface traduz pelo `code`; `message` é só
// para quem lê o log ou usa o curl.
import type { DeviceInfo, Player, WorldAccess } from './protocol';

/** Estado da conta neste computador. */
export type WorldState = 'off' | 'logged_out' | 'waiting' | 'approved';

/**
 * OfficeSnapshot.meta.world: só o necessário para a interface decidir se mostra a seção (o snapshot também vai ao
 * celular e à linha do tempo: nada da conta aqui).
 */
export interface WorldMeta {
  /** HABBLAUD_WORLD não é 0: a seção existe. */
  enabled: boolean;
  /** HABBLAUD_WORLD_URL válida. Sem ela a seção não aparece (recurso desligado). */
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
  /** Código do último problema (WORLD_LOCAL_ERROR_CODES ou do servidor do mundo), quando os dados podem estar velhos. */
  lastError?: string;
}

export interface WorldErrorResponse {
  error: { code: string; message?: string; retryAfter?: number };
}

/** Códigos dados pelo próprio servidor local (os do servidor do mundo estão em WORLD_ERROR_CODES). */
export const WORLD_LOCAL_ERROR_CODES = [
  'not_configured', // 409: sem HABBLAUD_WORLD_URL
  'local_only', // 403: pela porta do celular ou com Host que não é local
  'terminal_off', // 403: trava do terminal desligada (porta exposta na rede ou HABBLAUD_TERMINAL=0)
  'not_logged_in', // 401: ação da conta sem ter entrado
  'session_expired', // em lastError: o servidor do mundo recusou o token (revogado ou vencido) e a sessão foi apagada
  'invalid', // 400/422: corpo fora do formato (o mesmo código do servidor do mundo)
  'invalid_email', // 400
  'invalid_json', // 400
  'too_large', // 413
  'unsupported_media_type', // 415
  'method_not_allowed', // 405
  'not_found', // 404
  'altcha_failed', // 502: o desafio anti-robô do servidor do mundo não teve solução
  'world_unreachable', // 502: sem conexão com o servidor do mundo
  'world_timeout', // 504
  'world_bad_response', // 502: resposta fora do formato
  'world_error', // erro do servidor do mundo sem código legível (mesmo status)
  'storage_failed', // em lastError: não deu para gravar world.json (a sessão vale só até reiniciar)
  'internal', // 500
] as const;
export type WorldLocalErrorCode = (typeof WORLD_LOCAL_ERROR_CODES)[number];
