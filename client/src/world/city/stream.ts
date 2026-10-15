// O que a cena da cidade recebe e manda. O stream de verdade (client/src/net/world-stream.ts, SSE de
// GET /api/world/stream + POST /api/world/cmd) e o falso do modo demonstração (fake-stream.ts) têm a mesma forma:
// `createWorldStream({mock}): {on(ev, fn), send(cmds), close()}`, com os eventos `world.snapshot` (tudo o que o
// servidor local já tem, ao conectar) e `world` (cada mensagem do servidor do mundo como veio).
//
// O formato do `world.snapshot` é lido por `readCitySnapshot`, tolerante: aceita os campos com nomes e formas
// próximas (lista ou mapa), para a junção com o servidor local não depender de um detalhe de formato.
import type { AppearanceParts } from '../../../../shared/appearance';
import type { Direction, IntroId, TraitId, WorldBuildingPublic, WorldPlayerPublic } from '../../../../shared/world/protocol';

export type WorldStreamEvent = 'world.snapshot' | 'world';

export interface WorldStream {
  on(ev: WorldStreamEvent, fn: (data: unknown) => void): unknown;
  /** Comandos para o servidor do mundo (`move`, `profile`...): o servidor local junta em lotes de até 5/s. */
  send(cmds: readonly CityCommand[]): unknown;
  close(): void;
}

/** Comandos que a cena manda (os mesmos `t` de ClientMessage em shared/world/protocol.ts). */
export type CityCommand =
  | { t: 'move'; x: number; y: number; dir: Direction; moving: boolean }
  | { t: 'profile'; playerId: string };

/** Quem sou eu no mundo (o `me` do `welcome`). */
export interface CitySelf {
  id: string;
  name: string;
  look: 'f' | 'm';
  parts: AppearanceParts;
  traits: TraitId[];
  intro?: IntroId;
  country?: string;
  /** O meu prédio (o id do prédio é o id do dono), se tenho um. */
  buildingId?: string;
}

export interface CityArea {
  chunk: string;
  rev: number;
  buildings: WorldBuildingPublic[];
}

export interface CitySnapshot {
  /** O servidor local está ligado ao servidor do mundo (sem isso, nada desce; ausente = sim). */
  connected?: boolean;
  /** O servidor já mandou `afk` e ninguém mexeu desde então. */
  afk?: boolean;
  me?: CitySelf;
  /** Minha posição validada (tiles). */
  pos?: { x: number; y: number; dir?: Direction };
  /** Meu prédio (para nascer na porta). */
  building?: WorldBuildingPublic;
  areas: CityArea[];
  players: WorldPlayerPublic[];
  minimap?: Array<{ x: number; y: number; lit: number }>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Lista a partir de uma lista ou de um mapa `{id: valor}`. */
function listOf(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (isObject(v)) return Object.values(v);
  return [];
}

export function isBuilding(v: unknown): v is WorldBuildingPublic {
  return isObject(v) && typeof v.id === 'string' && isObject(v.lot) && finite(v.lot.x) && finite(v.lot.y) && isObject(v.owner) && typeof v.owner.name === 'string';
}

export function isPlayer(v: unknown): v is WorldPlayerPublic {
  return isObject(v) && typeof v.id === 'string' && typeof v.name === 'string' && isObject(v.pos) && finite(v.pos.x) && finite(v.pos.y);
}

function readSelf(v: unknown): CitySelf | undefined {
  if (!isObject(v) || typeof v.id !== 'string' || typeof v.name !== 'string') return undefined;
  return {
    id: v.id,
    name: v.name,
    look: v.look === 'm' ? 'm' : 'f',
    parts: isObject(v.parts) ? (v.parts as AppearanceParts) : {},
    traits: Array.isArray(v.traits) ? (v.traits.filter((t) => typeof t === 'string') as TraitId[]) : [],
    ...(typeof v.intro === 'string' ? { intro: v.intro as IntroId } : {}),
    ...(typeof v.country === 'string' ? { country: v.country } : {}),
    ...(typeof v.buildingId === 'string' ? { buildingId: v.buildingId } : {}),
  };
}

function readPos(v: unknown): CitySnapshot['pos'] {
  if (!isObject(v) || !finite(v.x) || !finite(v.y)) return undefined;
  const dir = v.dir === 'n' || v.dir === 's' || v.dir === 'e' || v.dir === 'w' ? v.dir : undefined;
  return dir ? { x: v.x, y: v.y, dir } : { x: v.x, y: v.y };
}

/** `world.snapshot` lido com tolerância. Formas aceitas: ver o comentário do arquivo. */
export function readCitySnapshot(raw: unknown): CitySnapshot {
  const out: CitySnapshot = { areas: [], players: [] };
  if (!isObject(raw)) return out;
  if (typeof raw.connected === 'boolean') out.connected = raw.connected;
  if (raw.afk === true) out.afk = true;
  const welcome = isObject(raw.welcome) ? raw.welcome : undefined;
  const me = readSelf(raw.me ?? welcome?.me);
  if (me) out.me = me;
  const pos = readPos(raw.pos ?? raw.position ?? (isObject(raw.me) ? raw.me.pos : undefined));
  if (pos) out.pos = pos;
  const building = raw.building ?? welcome?.building;
  if (isBuilding(building)) out.building = building;
  // áreas: `chunks`/`areas` como lista de {chunk, rev, buildings} ou mapa chunk → {rev, buildings}
  const areasRaw = raw.chunks ?? raw.areas;
  if (Array.isArray(areasRaw)) {
    for (const a of areasRaw) {
      if (!isObject(a) || typeof a.chunk !== 'string') continue;
      out.areas.push({ chunk: a.chunk, rev: finite(a.rev) ? a.rev : 0, buildings: listOf(a.buildings).filter(isBuilding) });
    }
  } else if (isObject(areasRaw)) {
    for (const [chunk, a] of Object.entries(areasRaw)) {
      if (!isObject(a)) continue;
      out.areas.push({ chunk, rev: finite(a.rev) ? a.rev : 0, buildings: listOf(a.buildings).filter(isBuilding) });
    }
  }
  // prédios soltos (sem chunk): uma área sem nome
  const loose = listOf(raw.buildings).filter(isBuilding);
  if (loose.length) out.areas.push({ chunk: '', rev: 0, buildings: loose });
  out.players = listOf(raw.players).filter(isPlayer);
  const mm = isObject(raw.minimap) ? raw.minimap.blocks : raw.minimap;
  if (Array.isArray(mm)) out.minimap = mm.filter((b): b is { x: number; y: number; lit: number } => isObject(b) && finite(b.x) && finite(b.y) && finite(b.lit));
  return out;
}

/** Stream que não recebe nada (sem o servidor local da cena; a cidade fica em "Entrando na cidade…"). */
export function emptyWorldStream(): WorldStream {
  return { on: () => undefined, send: () => undefined, close: () => undefined };
}

/**
 * O stream do servidor local na forma de net/world-stream.ts (`on(listener)` com eventos `{type: 'snapshot' |
 * 'message' | 'status' | 'error'}`) visto como o da cena (`on('world.snapshot' | 'world', fn)`).
 */
export interface SceneStreamLike {
  on(listener: (ev: { type: string; snapshot?: unknown; msg?: unknown }) => void): unknown;
  send(cmds: never[]): unknown;
  close(): void;
}

export function fromSceneStream(s: SceneStreamLike): WorldStream {
  return {
    on(ev, fn) {
      return s.on((e) => {
        if (ev === 'world.snapshot' && e.type === 'snapshot') fn(e.snapshot);
        else if (ev === 'world' && e.type === 'message') fn(e.msg);
      });
    },
    send: (cmds) => s.send(cmds as never[]),
    close: () => s.close(),
  };
}
