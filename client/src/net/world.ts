// Habblaud World no navegador: o cliente das rotas locais /api/world/* (o servidor local do Habblaud fala com o
// servidor do mundo; o token do dispositivo nunca chega ao navegador) e um FakeWorldApi para o modo demonstração
// (?mock=1&world=...) e para os testes. Erros chegam como `{error: {code}}`; a interface traduz o código
// (ui/world/world-model.ts) e nunca mostra o `message` do servidor.
//
// Fase 2 (prédio no mundo): `building` em meta.world e no status, GET /api/world/last-uplink (a última remessa, para
// "Ver o que foi enviado"), POST /api/world/pause, /resume e /leave e PUT /api/world/theme. Os tipos do prédio vêm
// de shared/world/api.ts (os mesmos do servidor local).
import type { AppearanceParts } from '../../../shared/appearance';
import type { Locale } from '../../../shared/i18n';
import type { OfficeSnapshot } from '../../../shared/types';
import {
  isWorldThemeChoice,
  WORLD_KNOWN_ERROR_CODES,
  WORLD_THEME_CHOICES,
  type WorldBuildingMeta,
  type WorldBuildingStatus,
  type WorldBuildingStop,
  type WorldKnownErrorCode,
  type WorldLastUplink,
  type WorldThemeChoice,
  type WorldUplinkAck,
} from '../../../shared/world/api';
import type { TraitId } from '../../../shared/world/traits';
import type { IntroId } from '../../../shared/world/intro';
import { parsePlayerName, playerNameKey } from '../../../shared/world/names-rules';
import { GOODBYE_REASONS, UPLINK_ACK_ERRORS, type UplinkAckError, type WorldUplink } from '../../../shared/world/protocol';
import { seasonalThemeFor } from '../world/api';
import { emailLooksValid, passwordProblem, traitsValid, DEFAULT_VISIBILITY } from '../ui/world/world-model';

export type WorldServerState = 'off' | 'logged_out' | 'waiting' | 'approved';
export type WorldAccess = 'waiting' | 'approved';

// Os tipos do prédio são os do servidor local (shared/world/api.ts); a interface os importa daqui.
export { WORLD_THEME_CHOICES };
export type { WorldBuildingMeta, WorldBuildingStatus, WorldBuildingStop, WorldLastUplink, WorldThemeChoice, WorldUplinkAck } from '../../../shared/world/api';

/** OfficeSnapshot.meta.world: o que a interface precisa para decidir se o World aparece (e o prédio, na Fase 2). */
export type WorldMeta = NonNullable<OfficeSnapshot['meta']['world']>;

export interface WorldVisibility {
  mode: 'live' | 'discreet';
  closed: boolean;
  hideCountry: boolean;
  tokensVisible: boolean;
  leaderboard: boolean;
  compactions: boolean;
}

export interface WorldPlayer {
  name: string;
  look: 'f' | 'm';
  parts: AppearanceParts;
  traits: TraitId[];
  intro: IntroId;
  /** ISO-2 visto pelo servidor na última conexão; ausente se escondido ou desconhecido. */
  country?: string;
  visibility: WorldVisibility;
  updatedAt?: number | string;
  /** A moderação trocou o nome à força (o nome vem "???"): falta escolher um novo, que entra sem esperar 30 dias. */
  mustRename?: true;
}

export interface WorldDevice {
  id: string;
  /** "Dispositivo N" (o servidor nunca usa o nome do computador). */
  label: string;
  createdAt?: number | string;
  lastSeenAt?: number | string;
  current: boolean;
}

/** GET /api/world/status. */
export interface WorldStatus {
  available: boolean;
  configured: boolean;
  state: WorldServerState;
  account?: { emailMasked: string; access: WorldAccess };
  player?: WorldPlayer;
  devices?: WorldDevice[];
  /** Último erro da conexão com o mundo (código), se houver. */
  lastError?: string;
  /** O prédio (conta aprovada): conexão, pausa, contagens, a resposta à última remessa e por que parou. */
  building?: WorldBuildingStatus;
  /** Tema guardado para o prédio (PUT /api/world/theme); ausente = 'auto'. */
  theme?: WorldThemeChoice;
}

export interface WorldCharacterInput {
  name: string;
  look: 'f' | 'm';
  parts: AppearanceParts;
  traits: TraitId[];
  intro: IntroId;
}

/**
 * Códigos que a interface traduz: os do servidor do mundo e os do servidor local (shared/world/), mais dois só dela:
 * `offline` (o Habblaud local não respondeu) e `forbidden` (403 sem código: a guarda de origem recusou a página).
 */
export const WORLD_UI_ERROR_CODES = [...WORLD_KNOWN_ERROR_CODES, 'offline', 'forbidden'] as const;
export type WorldErrorCode = WorldKnownErrorCode | 'offline' | 'forbidden';

export type WorldResult<T = null> = { ok: true; data: T } | { ok: false; code: WorldErrorCode; status: number };

export interface WorldClient {
  status(): Promise<WorldResult<WorldStatus>>;
  register(body: { email: string; password: string; locale: Locale }): Promise<WorldResult>;
  verify(body: { email: string; code: string }): Promise<WorldResult>;
  login(body: { email: string; password: string }): Promise<WorldResult>;
  logout(): Promise<WorldResult>;
  resend(body: { email: string }): Promise<WorldResult>;
  forgotPassword(body: { email: string }): Promise<WorldResult>;
  resetPassword(body: { email: string; code: string; password: string }): Promise<WorldResult>;
  saveCharacter(body: WorldCharacterInput): Promise<WorldResult>;
  saveVisibility(body: WorldVisibility): Promise<WorldResult>;
  devices(): Promise<WorldResult<WorldDevice[]>>;
  revokeDevice(id: string): Promise<WorldResult>;
  /** A última remessa; `null` = nada saiu deste computador ainda. */
  lastUplink(): Promise<WorldResult<WorldLastUplink | null>>;
  /** Para o envio na hora (o servidor local fecha a conexão antes de responder): o prédio apaga. */
  pause(): Promise<WorldResult<{ paused: boolean }>>;
  /** Volta a enviar: o prédio acende de novo (depois de sair do mundo, um prédio novo, em outro lote). */
  resume(): Promise<WorldResult<{ paused: boolean }>>;
  /** "Sair do mundo": o servidor local fecha a conexão e o servidor do mundo retira o prédio antes da resposta. */
  leave(): Promise<WorldResult>;
  /** O tema escolhido em Aparência também vale para o prédio. */
  setTheme(theme: WorldThemeChoice): Promise<WorldResult>;
}

// ------------------------------------------------------------------ leitura defensiva

const STATES: readonly WorldServerState[] = ['off', 'logged_out', 'waiting', 'approved'];

/** `meta.world` do snapshot, conferido (servidor antigo ou corpo torto: undefined = nada do World). */
export function readWorldMeta(snap: OfficeSnapshot | null | undefined): WorldMeta | undefined {
  const w = snap?.meta.world as Partial<WorldMeta> | undefined;
  if (!w || typeof w !== 'object' || typeof w.enabled !== 'boolean') return undefined;
  const state = STATES.includes(w.state as WorldServerState) ? (w.state as WorldServerState) : 'off';
  const out: WorldMeta = { enabled: w.enabled, configured: w.configured === true, state };
  const building = parseBuildingMeta(w.building);
  if (building) out.building = building;
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

function epochMs(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Motivo de recusa conhecido; um código de uma versão mais nova do servidor vira `internal` (como no servidor local). */
function ackError(v: unknown): UplinkAckError {
  return typeof v === 'string' && (UPLINK_ACK_ERRORS as readonly string[]).includes(v) ? (v as UplinkAckError) : 'internal';
}

/** `{ok, error?}` do `lastAck` do status. */
function parseAckState(v: unknown): { ok: boolean; error?: UplinkAckError } | undefined {
  if (!isObject(v) || typeof v.ok !== 'boolean') return undefined;
  return v.ok ? { ok: true } : { ok: false, error: ackError(v.error) };
}

/** O `ack` da última remessa: aceita (com os bytes que o mundo contou) ou recusada; sem horário, fora do formato. */
function parseUplinkAck(v: unknown): WorldUplinkAck | undefined {
  const state = parseAckState(v);
  const at = isObject(v) ? epochMs(v.at) : undefined;
  if (!state || !at) return undefined;
  const ack: WorldUplinkAck = { ...state, at };
  if (state.ok && isObject(v) && typeof v.bytes === 'number' && Number.isFinite(v.bytes) && v.bytes >= 0) ack.bytes = Math.floor(v.bytes);
  return ack;
}

/** Motivos com que o prédio para (o `deploy` só reconecta e nunca chega aqui). */
const STOPS = GOODBYE_REASONS.filter((r): r is WorldBuildingStop => r !== 'deploy');

/** `building` de meta.world, conferido (corpo torto: sem prédio). A parada vem só como sim/não. */
export function parseBuildingMeta(v: unknown): WorldBuildingMeta | undefined {
  if (!isObject(v)) return undefined;
  const b: WorldBuildingMeta = { connected: v.connected === true, paused: v.paused === true, floors: count(v.floors), agents: count(v.agents) };
  const at = epochMs(v.lastUplinkAt);
  if (at) b.lastUplinkAt = at;
  if (v.left === true) b.left = true;
  if (v.stopped === true) b.stopped = true;
  return b;
}

/** `building` do status, conferido (corpo torto: sem prédio): com a resposta à última remessa e o motivo da parada. */
export function parseBuilding(v: unknown): WorldBuildingStatus | undefined {
  const meta = parseBuildingMeta(v);
  if (!meta || !isObject(v)) return undefined;
  const { stopped: _stopped, ...b } = meta;
  const st: WorldBuildingStatus = b;
  const ack = parseAckState(v.lastAck);
  if (ack) st.lastAck = ack;
  if ((STOPS as readonly unknown[]).includes(v.stopped)) st.stopped = v.stopped as WorldBuildingStop;
  return st;
}

/** O prédio do snapshot como o cartão usa antes do primeiro status (o motivo de uma parada só vem no status). */
export function buildingFromMeta(m: WorldBuildingMeta | undefined): WorldBuildingStatus | undefined {
  if (!m) return undefined;
  const { stopped: _stopped, ...b } = m;
  return b;
}

/**
 * Corpo do GET /api/world/last-uplink: `{}` (nada saiu ainda) vira null; fora do formato, undefined. O `uplink` passa
 * como veio: a tela mostra exatamente o que o servidor local guardou.
 */
export function parseLastUplink(v: unknown): WorldLastUplink | null | undefined {
  if (!isObject(v)) return undefined;
  if (v.at === undefined && v.uplink === undefined) return null;
  const at = epochMs(v.at);
  if (!at || typeof v.bytes !== 'number' || !Number.isFinite(v.bytes) || !isObject(v.uplink)) return undefined;
  const out: WorldLastUplink = { at, bytes: Math.max(0, Math.floor(v.bytes)), uplink: v.uplink as unknown as WorldUplink };
  const ack = parseUplinkAck(v.ack);
  if (ack) out.ack = ack;
  return out;
}

function parseDevices(v: unknown): WorldDevice[] | null {
  const list = Array.isArray(v) ? v : isObject(v) && Array.isArray(v.devices) ? v.devices : null;
  if (!list) return null;
  return list.filter((d): d is WorldDevice => isObject(d) && typeof d.id === 'string' && typeof d.label === 'string').map((d) => ({ ...d, current: d.current === true }));
}

/** Corpo do GET /api/world/status conferido; null se não for o formato do contrato. */
export function parseWorldStatus(v: unknown): WorldStatus | null {
  if (!isObject(v) || !STATES.includes(v.state as WorldServerState)) return null;
  const out: WorldStatus = { available: v.available !== false, configured: v.configured === true, state: v.state as WorldServerState };
  const acc = v.account;
  if (isObject(acc) && typeof acc.emailMasked === 'string') out.account = { emailMasked: acc.emailMasked, access: acc.access === 'approved' ? 'approved' : 'waiting' };
  const p = v.player;
  if (isObject(p) && typeof p.name === 'string' && isObject(p.parts) && Array.isArray(p.traits)) {
    out.player = {
      ...(p as unknown as WorldPlayer),
      look: p.look === 'm' ? 'm' : 'f',
      visibility: { ...DEFAULT_VISIBILITY, ...(isObject(p.visibility) ? (p.visibility as Partial<WorldVisibility>) : {}) },
    };
    if (p.mustRename !== true) delete out.player.mustRename;
  }
  const devices = v.devices === undefined ? null : parseDevices(v.devices);
  if (devices) out.devices = devices;
  if (typeof v.lastError === 'string' && v.lastError) out.lastError = v.lastError;
  const building = parseBuilding(v.building);
  if (building) out.building = building;
  if (isWorldThemeChoice(v.theme)) out.theme = v.theme;
  return out;
}

/** Código do erro: `{error: {code}}` do contrato; senão pelo status HTTP (guarda, rota desligada...). */
export function worldErrorCode(status: number, body: unknown): WorldErrorCode {
  const err = isObject(body) ? body.error : undefined;
  const code = isObject(err) ? err.code : undefined;
  if (typeof code === 'string' && (WORLD_UI_ERROR_CODES as readonly string[]).includes(code)) return code as WorldErrorCode;
  if (status === 404) return 'not_configured';
  if (status === 429) return 'rate_limited';
  if (status === 403) return 'forbidden';
  return 'unknown';
}

// ------------------------------------------------------------------ cliente HTTP

/** Prazo de cada pedido: o cadastro resolve o desafio anti-robô e calcula o hash da senha antes de responder. */
export const WORLD_TIMEOUT_MS = 45_000;

export class HttpWorldApi implements WorldClient {
  constructor(
    // Arrow: o fetch do navegador recusa ser chamado como método de outro objeto ("Illegal invocation").
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    private readonly base = '/api/world',
  ) {}

  private async call<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: object): Promise<WorldResult<T>> {
    const init: RequestInit = { method, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(WORLD_TIMEOUT_MS) };
    // A guarda do servidor só aceita POST/PUT com corpo JSON (mesmo vazio).
    if (method !== 'GET') Object.assign(init, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, init);
    } catch {
      return { ok: false, code: 'offline', status: 0 };
    }
    let data: unknown = null;
    try {
      const text = await res.text();
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (res.ok) return { ok: true, data: data as T };
    return { ok: false, code: worldErrorCode(res.status, data), status: res.status };
  }

  private async done(p: Promise<WorldResult<unknown>>): Promise<WorldResult> {
    const r = await p;
    return r.ok ? { ok: true, data: null } : r;
  }

  async status(): Promise<WorldResult<WorldStatus>> {
    const r = await this.call<unknown>('GET', '/status');
    if (!r.ok) return r;
    const s = parseWorldStatus(r.data);
    return s ? { ok: true, data: s } : { ok: false, code: 'unknown', status: 200 };
  }

  register(body: { email: string; password: string; locale: Locale }) {
    return this.done(this.call('POST', '/register', body));
  }
  verify(body: { email: string; code: string }) {
    return this.done(this.call('POST', '/verify', body));
  }
  login(body: { email: string; password: string }) {
    return this.done(this.call('POST', '/login', body));
  }
  logout() {
    return this.done(this.call('POST', '/logout'));
  }
  resend(body: { email: string }) {
    return this.done(this.call('POST', '/resend', body));
  }
  forgotPassword(body: { email: string }) {
    return this.done(this.call('POST', '/password/forgot', body));
  }
  resetPassword(body: { email: string; code: string; password: string }) {
    return this.done(this.call('POST', '/password/reset', body));
  }
  saveCharacter(body: WorldCharacterInput) {
    return this.done(this.call('PUT', '/character', body));
  }
  saveVisibility(body: WorldVisibility) {
    return this.done(this.call('PUT', '/visibility', body));
  }
  async devices(): Promise<WorldResult<WorldDevice[]>> {
    const r = await this.call<unknown>('GET', '/devices');
    if (!r.ok) return r;
    const list = parseDevices(r.data);
    return list ? { ok: true, data: list } : { ok: false, code: 'unknown', status: 200 };
  }
  revokeDevice(id: string) {
    return this.done(this.call('POST', `/devices/${encodeURIComponent(id)}/revoke`));
  }
  async lastUplink(): Promise<WorldResult<WorldLastUplink | null>> {
    const r = await this.call<unknown>('GET', '/last-uplink');
    if (!r.ok) return r;
    const last = parseLastUplink(r.data);
    return last === undefined ? { ok: false, code: 'unknown', status: 200 } : { ok: true, data: last };
  }
  pause() {
    return this.paused('/pause', true);
  }
  resume() {
    return this.paused('/resume', false);
  }
  leave() {
    return this.done(this.call('POST', '/leave'));
  }
  setTheme(theme: WorldThemeChoice) {
    return this.done(this.call('PUT', '/theme', { theme }));
  }

  /** POST /pause e /resume → WorldStatus; vale o `building.paused` dele (sem o campo: o que foi pedido). */
  private async paused(path: string, expected: boolean): Promise<WorldResult<{ paused: boolean }>> {
    const r = await this.call<unknown>('POST', path);
    if (!r.ok) return r;
    const b = isObject(r.data) ? r.data.building : undefined;
    return { ok: true, data: { paused: isObject(b) && typeof b.paused === 'boolean' ? b.paused : expected } };
  }
}

// ------------------------------------------------------------------ servidor falso (demonstração e testes)

export interface FakeWorldOptions {
  /** Estado inicial: sem servidor ('off': nada do World aparece), sem conta, ou com uma conta de exemplo já entrando (na espera ou liberada). */
  state?: WorldServerState;
  /** Espera de cada resposta, em ms (padrão 450; 0 nos testes). */
  delayMs?: number;
  now?: () => number;
}

interface FakeBuilding {
  connected: boolean;
  paused: boolean;
  /** Saiu do mundo (fica pausado até retomar, que traz um prédio "novo"). */
  left?: true;
  /** O "mundo" parou o prédio (goodbye), até retomar. */
  stopped?: WorldBuildingStop;
  last: WorldLastUplink | null;
}

interface FakeAccount {
  email: string;
  password: string;
  verified: boolean;
  access: WorldAccess;
  player?: WorldPlayer;
  devices: WorldDevice[];
  /** O prédio: nasce com a conta aprovada e com personagem. */
  building?: FakeBuilding;
}

/**
 * O que o prédio do falso "manda": o exemplo da seção 3.3 do plano (docs/world/privacidade.md), com as peças
 * completas nos três agentes (o plano abrevia duas com "..."). O tema é trocado pelo tema em vigor a cada remessa.
 */
export const FAKE_UPLINK: Readonly<WorldUplink> = {
  v: 1,
  version: '1.0.0',
  theme: 'halloween',
  floors: [
    {
      id: 'f_8c1e5f7a2b',
      agents: [
        {
          id: 'a_3f9d2c7e', kind: 'main', provider: 'claude', status: 'working', look: 'f', name: 'Marina',
          parts: {
            skin: '#e8b48c', hair: '#2b1d14', hairStyle: 'bob', eyes: '#3b5a7a', top: '#4a6fa5', topStyle: 'hoodie',
            bottom: '#2f3542', bottomStyle: 'pants', shoes: '#ffffff', accessory: 'glasses', accessoryColor: '#222222', facialHair: 'none',
          },
        },
        {
          id: 'a_71c0b5a9', kind: 'sub', parentId: 'a_3f9d2c7e', provider: 'claude', status: 'working', look: 'm', name: 'Caio',
          parts: {
            skin: '#c68642', hair: '#1c1c1c', hairStyle: 'short', eyes: '#4a3728', top: '#3d8b5f', topStyle: 'tshirt',
            bottom: '#2c2c35', bottomStyle: 'pants', shoes: '#3a2a20', accessory: 'headphones', accessoryColor: '#1f1f24', facialHair: 'stubble',
          },
        },
      ],
    },
    {
      id: 'f_02aa91c4de',
      agents: [
        {
          id: 'a_b2e74d10', kind: 'main', provider: 'codex', status: 'idle', look: 'm', name: 'Rafael',
          parts: {
            skin: '#8d5524', hair: '#0f0f0f', hairStyle: 'buzz', eyes: '#2b1d14', top: '#a5463d', topStyle: 'polo',
            bottom: '#4b5563', bottomStyle: 'shorts', shoes: '#f2f2f2', accessory: 'none', accessoryColor: '#222222', facialHair: 'beard',
          },
        },
      ],
    },
  ],
};

/** Tamanho de um pacote como vai para o fio (JSON compacto em UTF-8). */
export function uplinkBytes(uplink: WorldUplink): number {
  return new TextEncoder().encode(JSON.stringify(uplink)).length;
}

/** E-mail da conta de exemplo dos estados 'waiting' e 'approved'. */
export const FAKE_EMAIL = 'voce@exemplo.com';
/** Senha da conta de exemplo. */
export const FAKE_PASSWORD = 'uma senha bem comprida';
/** O código que o "e-mail" do FakeWorldApi manda (a tela mostra no modo demonstração). */
export const FAKE_CODE = '123456';

/** Nomes que o falso diz que já estão em uso (para ver o erro na demonstração). */
const FAKE_TAKEN = ['marina', 'caio', 'rafael'];

function maskEmail(email: string): string {
  const [user, domain = ''] = email.split('@');
  return `${user.slice(0, 2)}***@${domain}`;
}

/**
 * Servidor do World de mentira, todo em memória: cadastro com o código FAKE_CODE, lista de espera, personagem,
 * visibilidade e dispositivos. `failNext` simula um erro na próxima chamada; `approve` libera a conta da vez.
 */
export class FakeWorldApi implements WorldClient {
  private readonly accounts = new Map<string, FakeAccount>();
  private session: { email: string; deviceId: string } | null = null;
  private configured: boolean;
  private readonly delayMs: number;
  private readonly now: () => number;
  private readonly failures: WorldErrorCode[] = [];
  private readonly listeners = new Set<() => void>();
  private resends: number[] = [];
  private deviceSeq = 0;
  /** Tema do prédio (world.json no servidor de verdade). */
  private theme: WorldThemeChoice = 'auto';
  /** Código com que o "mundo" recusa as remessas (null: aceita). */
  private rejectCode: UplinkAckError | null = null;

  constructor(opts: FakeWorldOptions = {}) {
    this.delayMs = opts.delayMs ?? 450;
    this.now = opts.now ?? Date.now;
    const state = opts.state ?? 'logged_out';
    this.configured = state !== 'off';
    if (state === 'waiting' || state === 'approved') {
      const now = this.now();
      const acc: FakeAccount = { email: FAKE_EMAIL, password: FAKE_PASSWORD, verified: true, access: state, devices: [] };
      if (state === 'approved') {
        acc.player = {
          name: 'Pixel Dev',
          look: 'f',
          parts: {
            skin: '#d69f78', hair: '#2b2530', hairStyle: 'bob', eyes: '#2f5f9e', top: '#4a86d8', topAccent: '#f4f4f0',
            topStyle: 'hoodie', bottom: '#2c2c35', bottomStyle: 'pants', shoes: '#ececec', accessory: 'glasses',
            accessoryColor: '#2b2b33', facialHair: 'none',
          },
          traits: ['cafeina', 'games'],
          intro: 'night_owl',
          country: 'BR',
          visibility: { ...DEFAULT_VISIBILITY },
          updatedAt: now,
        };
        this.ensureBuilding(acc);
      }
      this.accounts.set(FAKE_EMAIL, acc);
      const current = this.addDevice(acc);
      acc.devices.unshift({ id: 'fake-old', label: 'Dispositivo 2', createdAt: now - 21 * 86_400_000, lastSeenAt: now - 3 * 86_400_000, current: false });
      this.session = { email: FAKE_EMAIL, deviceId: current.id };
    }
  }

  /** O que o snapshot diria em `meta.world` (sem servidor, como o de verdade: desligado, nada aparece). */
  meta(): WorldMeta {
    const meta: WorldMeta = { enabled: this.configured, configured: this.configured, state: this.state() };
    const b = this.buildingOf(this.current());
    if (b) {
      const { lastAck: _ack, stopped, ...building } = b;
      meta.building = stopped ? { ...building, stopped: true } : building;
    }
    return meta;
  }

  /** Tema do prédio em vigor (o escolhido, antes de resolver o automático). */
  worldTheme(): WorldThemeChoice {
    return this.theme;
  }

  /** O "mundo" passa a recusar as remessas com este código (null: volta a aceitar); manda uma remessa na hora. */
  rejectUplinks(code: UplinkAckError | null): void {
    this.rejectCode = code;
    const acc = this.current();
    if (acc?.building?.connected) this.sendUplink(acc);
    this.changed();
  }

  /** O "mundo" para o prédio com um `goodbye` (atualize, outro computador...), até retomar. */
  stopBuilding(reason: WorldBuildingStop): void {
    const b = this.current()?.building;
    if (!b || b.paused) return;
    b.connected = false;
    b.stopped = reason;
    this.changed();
  }

  /** A conexão com o mundo cai (o servidor de verdade tenta de novo sozinho; aqui, até pausar e retomar). */
  dropConnection(): void {
    const b = this.current()?.building;
    if (!b || b.paused) return;
    b.connected = false;
    this.changed();
  }

  /** Avisa quando o estado muda (a interface redesenha, como faria com um snapshot novo). */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  /** A próxima chamada falha com este código (testes e demonstração). */
  failNext(code: WorldErrorCode): void {
    this.failures.push(code);
  }

  /** A moderação troca à força o nome do personagem da conta que está entrando (vira "???" até escolher outro). */
  forceRename(): void {
    const acc = this.current();
    if (!acc?.player) return;
    acc.player = { ...acc.player, name: '???', mustRename: true };
    this.changed();
  }

  /** Libera da lista de espera a conta que está entrando (o painel do servidor faria isso por lote). */
  approve(): void {
    const acc = this.current();
    if (!acc) return;
    acc.access = 'approved';
    this.ensureBuilding(acc);
    this.changed();
  }

  /** Acende o prédio da conta aprovada e com personagem, com a primeira remessa (o uplink de verdade faz isso). */
  private ensureBuilding(acc: FakeAccount): void {
    if (acc.building || acc.access !== 'approved' || !acc.player) return;
    acc.building = { connected: true, paused: false, last: null };
    this.sendUplink(acc);
  }

  /** Uma remessa: o exemplo da 3.3 com o tema resolvido pela data; a resposta do "mundo" vem na hora. */
  private sendUplink(acc: FakeAccount): void {
    const b = acc.building;
    if (!b || b.paused) return;
    const at = this.now();
    const uplink: WorldUplink = { ...structuredClone(FAKE_UPLINK as WorldUplink), theme: seasonalThemeFor(this.theme, new Date(at)) };
    const bytes = uplinkBytes(uplink);
    const ack: WorldUplinkAck = this.rejectCode ? { ok: false, error: this.rejectCode, at } : { ok: true, at, bytes };
    b.last = { at, bytes, uplink, ack };
  }

  private buildingOf(acc: FakeAccount | undefined): WorldBuildingStatus | undefined {
    const b = acc?.building;
    if (!b) return undefined;
    const floors = b.last?.uplink.floors ?? [];
    const out: WorldBuildingStatus = { connected: b.connected, paused: b.paused, floors: floors.length, agents: floors.reduce((n, f) => n + f.agents.length, 0) };
    if (b.last) {
      out.lastUplinkAt = b.last.at;
      if (b.last.ack) out.lastAck = b.last.ack.ok ? { ok: true } : { ok: false, error: b.last.ack.error };
    }
    if (b.left) out.left = true;
    if (b.stopped) out.stopped = b.stopped;
    return out;
  }

  private state(): WorldServerState {
    if (!this.configured) return 'off';
    const acc = this.current();
    return acc ? acc.access : 'logged_out';
  }

  private current(): FakeAccount | undefined {
    return this.session ? this.accounts.get(this.session.email) : undefined;
  }

  private changed(): void {
    this.listeners.forEach((cb) => cb());
  }

  private addDevice(acc: FakeAccount): WorldDevice {
    const now = this.now();
    acc.devices.forEach((d) => (d.current = false));
    const used = new Set(acc.devices.map((d) => d.label));
    let n = 1;
    while (used.has(`Dispositivo ${n}`)) n++;
    const device: WorldDevice = { id: `fake-${++this.deviceSeq}`, label: `Dispositivo ${n}`, createdAt: now, lastSeenAt: now, current: true };
    acc.devices.push(device);
    return device;
  }

  /**
   * Responde depois da espera; um `failNext` pendente vira o erro desta resposta. Só as escritas (`write`) avisam quem
   * escuta: uma leitura que avisasse faria a interface reler o status sem parar.
   */
  private async reply<T>(run: () => WorldResult<T>, write = true): Promise<WorldResult<T>> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    const fail = this.failures.shift();
    if (fail) return { ok: false, code: fail, status: fail === 'offline' ? 0 : 400 };
    if (!this.configured) return { ok: false, code: 'not_configured', status: 404 };
    const r = run();
    if (r.ok && write) this.changed();
    return r;
  }

  private static ok(): WorldResult {
    return { ok: true, data: null };
  }

  private static fail(code: WorldErrorCode, status = 400): WorldResult<never> {
    return { ok: false, code, status };
  }

  status(): Promise<WorldResult<WorldStatus>> {
    return this.reply(() => {
      const acc = this.current();
      const state = this.state();
      const status: WorldStatus = { available: true, configured: this.configured, state };
      if (acc) {
        status.account = { emailMasked: maskEmail(acc.email), access: acc.access };
        if (acc.player) status.player = structuredClone(acc.player);
        status.devices = structuredClone(acc.devices);
        const building = this.buildingOf(acc);
        if (building) status.building = building;
      }
      if (this.theme !== 'auto') status.theme = this.theme;
      return { ok: true, data: status };
    }, false);
  }

  register(body: { email: string; password: string; locale: Locale }): Promise<WorldResult> {
    return this.reply(() => {
      if (!emailLooksValid(body.email) || passwordProblem(body.password, body.email)) return FakeWorldApi.fail('invalid', 422);
      const email = body.email.trim().toLowerCase();
      // Como o servidor de verdade: e-mail já cadastrado responde igual (nunca revela quem tem conta).
      if (!this.accounts.has(email)) this.accounts.set(email, { email, password: body.password, verified: false, access: 'waiting', devices: [] });
      return FakeWorldApi.ok();
    });
  }

  verify(body: { email: string; code: string }): Promise<WorldResult> {
    return this.reply(() => {
      const acc = this.accounts.get(body.email.trim().toLowerCase());
      if (!acc || body.code !== FAKE_CODE) return FakeWorldApi.fail('invalid_code');
      acc.verified = true;
      this.session = { email: acc.email, deviceId: this.addDevice(acc).id };
      return FakeWorldApi.ok();
    });
  }

  login(body: { email: string; password: string }): Promise<WorldResult> {
    return this.reply(() => {
      const email = body.email.trim().toLowerCase();
      if (email.startsWith('banido@')) return FakeWorldApi.fail('banned', 403);
      const acc = this.accounts.get(email);
      if (!acc || acc.password !== body.password) return FakeWorldApi.fail('invalid_credentials', 401);
      if (!acc.verified) return FakeWorldApi.fail('email_not_verified', 403);
      this.session = { email, deviceId: this.addDevice(acc).id };
      return FakeWorldApi.ok();
    });
  }

  logout(): Promise<WorldResult> {
    return this.reply(() => {
      const acc = this.current();
      if (acc && this.session) {
        const id = this.session.deviceId;
        acc.devices = acc.devices.filter((d) => d.id !== id);
      }
      this.session = null;
      return FakeWorldApi.ok();
    });
  }

  resend(_body: { email: string }): Promise<WorldResult> {
    return this.reply(() => {
      const now = this.now();
      this.resends = this.resends.filter((t) => now - t < 3_600_000);
      if (this.resends.length >= 3) return FakeWorldApi.fail('rate_limited', 429);
      this.resends.push(now);
      return FakeWorldApi.ok();
    });
  }

  forgotPassword(_body: { email: string }): Promise<WorldResult> {
    return this.reply(() => FakeWorldApi.ok());
  }

  resetPassword(body: { email: string; code: string; password: string }): Promise<WorldResult> {
    return this.reply(() => {
      const acc = this.accounts.get(body.email.trim().toLowerCase());
      if (!acc || body.code !== FAKE_CODE) return FakeWorldApi.fail('invalid_code');
      if (passwordProblem(body.password, body.email)) return FakeWorldApi.fail('invalid', 422);
      acc.password = body.password;
      acc.verified = true;
      // Trocar a senha desconecta todos os dispositivos (este também).
      acc.devices = [];
      if (this.session?.email === acc.email) this.session = null;
      return FakeWorldApi.ok();
    });
  }

  saveCharacter(body: WorldCharacterInput): Promise<WorldResult> {
    return this.reply(() => {
      const acc = this.current();
      if (!acc) return FakeWorldApi.fail('unknown', 401);
      const name = parsePlayerName(body.name);
      if (!name.ok) return FakeWorldApi.fail(name.code, 422);
      const key = name.key;
      if (FAKE_TAKEN.includes(key) && playerNameKey(acc.player?.name ?? '') !== key) return FakeWorldApi.fail('name_taken', 409);
      if (!traitsValid(body.traits)) return FakeWorldApi.fail('invalid', 422);
      acc.player = {
        name: name.name,
        look: body.look,
        parts: { ...body.parts },
        traits: [...body.traits],
        intro: body.intro,
        country: 'BR',
        visibility: acc.player?.visibility ?? { ...DEFAULT_VISIBILITY },
        updatedAt: this.now(),
      };
      this.ensureBuilding(acc);
      return FakeWorldApi.ok();
    });
  }

  saveVisibility(body: WorldVisibility): Promise<WorldResult> {
    return this.reply(() => {
      const acc = this.current();
      if (!acc?.player) return FakeWorldApi.fail('invalid', 422);
      acc.player.visibility = { ...body };
      if (body.hideCountry) delete acc.player.country;
      else acc.player.country = 'BR';
      return FakeWorldApi.ok();
    });
  }

  devices(): Promise<WorldResult<WorldDevice[]>> {
    return this.reply(() => {
      const acc = this.current();
      if (!acc) return FakeWorldApi.fail('unknown', 401);
      return { ok: true, data: structuredClone(acc.devices) };
    }, false);
  }

  revokeDevice(id: string): Promise<WorldResult> {
    return this.reply(() => {
      const acc = this.current();
      if (!acc) return FakeWorldApi.fail('unknown', 401);
      if (!acc.devices.some((d) => d.id === id)) return FakeWorldApi.fail('invalid', 404);
      acc.devices = acc.devices.filter((d) => d.id !== id);
      if (this.session?.deviceId === id) this.session = null;
      return FakeWorldApi.ok();
    });
  }

  lastUplink(): Promise<WorldResult<WorldLastUplink | null>> {
    return this.reply(() => {
      const acc = this.current();
      if (!acc) return FakeWorldApi.fail('not_logged_in', 401);
      return { ok: true, data: acc.building?.last ? structuredClone(acc.building.last) : null };
    }, false);
  }

  pause(): Promise<WorldResult<{ paused: boolean }>> {
    return this.setPaused(true);
  }

  resume(): Promise<WorldResult<{ paused: boolean }>> {
    return this.setPaused(false);
  }

  private setPaused(paused: boolean): Promise<WorldResult<{ paused: boolean }>> {
    return this.reply(() => {
      const acc = this.current();
      if (!acc) return FakeWorldApi.fail('not_logged_in', 401);
      const b = acc.building;
      if (!b) return FakeWorldApi.fail('no_player', 409);
      b.paused = paused;
      // Como o de verdade: pausar fecha a conexão; retomar (também depois de sair do mundo ou de uma parada)
      // reconecta e manda o pacote inteiro.
      b.connected = !paused;
      if (!paused) {
        delete b.left;
        delete b.stopped;
      }
      this.sendUplink(acc);
      return { ok: true, data: { paused } };
    });
  }

  leave(): Promise<WorldResult> {
    return this.reply(() => {
      const acc = this.current();
      if (!acc) return FakeWorldApi.fail('not_logged_in', 401);
      const b = acc.building;
      if (!b) return FakeWorldApi.fail('no_player', 409);
      b.paused = true;
      b.connected = false;
      b.left = true;
      delete b.stopped;
      return FakeWorldApi.ok();
    });
  }

  setTheme(theme: WorldThemeChoice): Promise<WorldResult> {
    return this.reply(() => {
      if (!WORLD_THEME_CHOICES.includes(theme)) return FakeWorldApi.fail('invalid', 422);
      this.theme = theme;
      const acc = this.current();
      if (acc?.building?.connected) this.sendUplink(acc);
      return FakeWorldApi.ok();
    });
  }
}

// ------------------------------------------------------------------ de onde vêm os dados

export interface WorldSource {
  /** null = nada do World nesta página. */
  readonly client: WorldClient | null;
  /** Modo demonstração: o FakeWorldApi responde (sem servidor, sem as travas de acesso). */
  readonly fake: boolean;
  /** O `meta.world` em vigor. */
  meta(): WorldMeta | undefined;
  /** Avisa quando o estado muda fora dos snapshots (só o falso). */
  onChange?(cb: () => void): () => void;
}

/** `?world=` do modo demonstração: o estado inicial do FakeWorldApi (sem o parâmetro, o World não aparece). */
export function fakeWorldStateFrom(search: string): WorldServerState | null {
  const params = new URLSearchParams(search);
  if (!params.has('world')) return null;
  const v = params.get('world') ?? '';
  return (STATES as readonly string[]).includes(v) ? (v as WorldServerState) : 'logged_out';
}

/**
 * O World desta página: no ?mock=1, o FakeWorldApi só com `&world=` (as capturas do README em modo demonstração
 * continuam sem nada do World, que está desligado por padrão); fora dele, as rotas locais e o `meta.world` do
 * snapshot ao vivo.
 */
export function worldSource(store: { mock: boolean; readonly liveSnapshot: OfficeSnapshot | null }, search = typeof location === 'undefined' ? '' : location.search): WorldSource {
  if (store.mock) {
    const state = fakeWorldStateFrom(search);
    if (!state) return { client: null, fake: true, meta: () => undefined };
    const fake = new FakeWorldApi({ state });
    return { client: fake, fake: true, meta: () => fake.meta(), onChange: (cb) => fake.onChange(cb) };
  }
  return { client: new HttpWorldApi(), fake: false, meta: () => readWorldMeta(store.liveSnapshot) };
}
