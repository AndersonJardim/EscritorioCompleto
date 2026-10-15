// A cena Mundo no navegador (Fase 3): o stream da cidade (GET /api/world/stream, SSE) e os comandos do jogador
// (POST /api/world/cmd), mais um FakeWorldStream para o modo demonstração (?mock=1&world=approved&scene=city) e os
// testes. A cena usa só `createWorldStream({mock})`:
//
//   const ws = createWorldStream({ mock: store.mock });
//   const off = ws.on((ev) => { ... });   // 'snapshot' (troca o estado inteiro), 'message' (aplica na ordem), 'status'
//   ws.send([{ t: 'move', x, y, dir, moving }]);  // fila: um lote a cada 200 ms, só o último move de cada lote
//   ws.close();                                    // fecha o SSE (o servidor local manda `view.off` se era o último)
//
// O servidor local já conferiu o `rev` dos patches e descartou o que não é da cena: o navegador aplica cada `message`
// na ordem em que chega (dá para usar o mesmo `SceneState` de shared/world/scene.ts, a partir do snapshot). O
// servidor do mundo nunca é chamado daqui, e o token nunca chega à página.
import type { WorldSceneCommand, WorldSceneMessage, WorldSceneSnapshot } from '../../../shared/world/api';
import { WORLD_SCENE_LIMITS, WORLD_SCENE_MESSAGES } from '../../../shared/world/api';
import { flattenAppearance } from '../../../shared/world/appearance-flat';
import {
  BLOCK_TILES,
  blockAt,
  blockOf,
  blockOrigin,
  chunkId,
  chunkOf,
  isWalkable,
  lotSpiral,
  spawnPoint,
  type CityPoint,
} from '../../../shared/world/city';
import type { Direction, GreetingId, TraitId, WorldBuildingPublic, WorldPlayerPublic, WorldPosition, WorldTheme } from '../../../shared/world/protocol';
import { reduceSceneBatch } from '../../../shared/world/scene';
import { reconnectDelay, type EventSourceLike } from './store';

export type { WorldSceneCommand, WorldSceneMessage, WorldSceneSnapshot } from '../../../shared/world/api';

/** connecting: abrindo (ou o navegador tentando de novo); open: snapshot recebido; retrying: esperando para reabrir. */
export type WorldStreamStatus = 'connecting' | 'open' | 'retrying' | 'closed';

export type WorldStreamEvent =
  | { type: 'snapshot'; snapshot: WorldSceneSnapshot }
  | { type: 'message'; msg: WorldSceneMessage }
  | { type: 'status'; status: WorldStreamStatus }
  /** Um lote de comandos recusado pelo servidor local (`no_stream`, `not_connected`, `invalid`...). */
  | { type: 'error'; code: string };

export interface WorldStream {
  on(listener: (ev: WorldStreamEvent) => void): () => void;
  send(cmds: WorldSceneCommand[]): void;
  close(): void;
}

/** Um lote a cada 200 ms (o servidor local aceita 5 por segundo por stream). */
export const CMD_BATCH_MS = 200;
/** Comandos guardados na fila enquanto o stream não abre (fora o último move). */
const QUEUE_MAX = WORLD_SCENE_LIMITS.cmdsPerBatch - 1;
/** EventSource.CLOSED (o EventSource não existe no Node dos testes). */
const ES_CLOSED = 2;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Junta comandos novos à fila: o último move substitui os anteriores; o resto, até o teto (os mais velhos saem). */
export function enqueueCommands(queue: readonly WorldSceneCommand[], cmds: readonly WorldSceneCommand[]): WorldSceneCommand[] {
  const all = reduceSceneBatch([...queue, ...cmds]);
  const others: WorldSceneCommand[] = all.filter((c) => c.t !== 'move');
  const kept = new Set<WorldSceneCommand>(others.slice(Math.max(0, others.length - QUEUE_MAX)));
  return all.filter((c) => c.t === 'move' || kept.has(c));
}

class Listeners {
  private readonly set = new Set<(ev: WorldStreamEvent) => void>();
  add(cb: (ev: WorldStreamEvent) => void): () => void {
    this.set.add(cb);
    return () => void this.set.delete(cb);
  }
  emit(ev: WorldStreamEvent): void {
    for (const cb of [...this.set]) {
      try {
        cb(ev);
      } catch (err) {
        console.error('[world-stream]', err);
      }
    }
  }
  clear(): void {
    this.set.clear();
  }
}

// ------------------------------------------------------------------------------------------------ o de verdade

export interface HttpWorldStreamOptions {
  eventSource?: (url: string) => EventSourceLike;
  fetch?: typeof fetch;
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void;
  now?: () => number;
  base?: string;
}

export class HttpWorldStream implements WorldStream {
  private readonly listeners = new Listeners();
  private readonly open: (url: string) => EventSourceLike;
  private readonly fetchImpl: typeof fetch;
  private readonly setT: (cb: () => void, ms: number) => unknown;
  private readonly clearT: (t: unknown) => void;
  private readonly now: () => number;
  private readonly base: string;
  private es: EventSourceLike | null = null;
  private stream: string | null = null;
  private queue: WorldSceneCommand[] = [];
  private flushTimer: unknown = null;
  private retryTimer: unknown = null;
  private inflight = false;
  private lastPostAt = -Infinity;
  /** Espera pedida pelo servidor local (429). */
  private holdUntil = 0;
  private attempts = 0;
  private closed = false;
  private status: WorldStreamStatus = 'connecting';

  constructor(o: HttpWorldStreamOptions = {}) {
    this.open = o.eventSource ?? ((url) => new EventSource(url));
    this.fetchImpl = o.fetch ?? ((input, init) => fetch(input, init));
    this.setT = o.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearT = o.clearTimeout ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    this.now = o.now ?? Date.now;
    this.base = o.base ?? '/api/world';
    this.connect();
  }

  on(listener: (ev: WorldStreamEvent) => void): () => void {
    return this.listeners.add(listener);
  }

  send(cmds: WorldSceneCommand[]): void {
    if (this.closed || !cmds.length) return;
    this.queue = enqueueCommands(this.queue, cmds);
    this.schedule();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.es?.close();
    this.es = null;
    if (this.flushTimer) this.clearT(this.flushTimer);
    if (this.retryTimer) this.clearT(this.retryTimer);
    this.flushTimer = this.retryTimer = null;
    this.queue = [];
    this.setStatus('closed');
    this.listeners.clear();
  }

  private setStatus(s: WorldStreamStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.listeners.emit({ type: 'status', status: s });
  }

  private connect(): void {
    if (this.closed) return;
    this.stream = null;
    let es: EventSourceLike;
    try {
      es = this.open(`${this.base}/stream`);
    } catch {
      return this.retry();
    }
    this.es = es;
    const current = () => this.es === es && !this.closed;
    es.addEventListener('world.snapshot', (ev) => {
      if (!current()) return;
      const snap = parse(ev);
      if (!isObj(snap) || typeof snap.stream !== 'string' || !Array.isArray(snap.chunks) || !Array.isArray(snap.players)) return;
      this.stream = snap.stream;
      this.attempts = 0;
      this.setStatus('open');
      this.listeners.emit({ type: 'snapshot', snapshot: snap as unknown as WorldSceneSnapshot });
      this.schedule();
    });
    es.addEventListener('world', (ev) => {
      if (!current()) return;
      const msg = parse(ev);
      if (!isObj(msg) || !(WORLD_SCENE_MESSAGES as readonly unknown[]).includes(msg.t)) return;
      this.listeners.emit({ type: 'message', msg: msg as unknown as WorldSceneMessage });
    });
    es.addEventListener('error', () => {
      if (!current()) return;
      // CONNECTING: o navegador tenta de novo sozinho (e o servidor manda um snapshot novo, com outro id de stream).
      // CLOSED: desistiu (429, 403, 409...): a reconexão fica por conta daqui, com espera crescente.
      this.stream = null;
      if (es.readyState === ES_CLOSED) {
        es.close();
        this.es = null;
        this.retry();
      } else {
        this.setStatus('connecting');
      }
    });
  }

  private retry(): void {
    if (this.closed || this.retryTimer) return;
    this.setStatus('retrying');
    const delay = reconnectDelay(this.attempts++);
    this.retryTimer = this.setT(() => {
      this.retryTimer = null;
      this.setStatus('connecting');
      this.connect();
    }, delay);
  }

  /** Um lote a cada CMD_BATCH_MS, um por vez, só com o stream aberto. */
  private schedule(): void {
    if (this.closed || this.flushTimer || this.inflight || !this.queue.length || !this.stream) return;
    const wait = Math.max(0, this.lastPostAt + CMD_BATCH_MS - this.now(), this.holdUntil - this.now());
    this.flushTimer = this.setT(() => {
      this.flushTimer = null;
      void this.flush();
    }, wait);
  }

  private async flush(): Promise<void> {
    const stream = this.stream;
    if (this.closed || !stream || !this.queue.length) return;
    const cmds = this.queue;
    this.queue = [];
    this.inflight = true;
    this.lastPostAt = this.now();
    let status = 0;
    let code = 'offline';
    let retryAfter = 1;
    try {
      const res = await this.fetchImpl(`${this.base}/cmd`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stream, cmds }),
      });
      status = res.status;
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { code?: unknown; retryAfter?: unknown } } | null;
        if (typeof body?.error?.code === 'string') code = body.error.code;
        if (typeof body?.error?.retryAfter === 'number') retryAfter = body.error.retryAfter;
      }
    } catch {
      status = 0;
    }
    this.inflight = false;
    if (this.closed) return;
    if (status === 429 && code === 'rate_limited') {
      // Volta para a fila (o move mais novo, se houver, vale mais) e espera o que o servidor pediu.
      this.queue = enqueueCommands(cmds, this.queue);
      this.holdUntil = this.now() + retryAfter * 1000;
    } else if (status < 200 || status >= 300) {
      this.listeners.emit({ type: 'error', code });
    }
    this.schedule();
  }
}

function parse(ev: Event): unknown {
  try {
    return JSON.parse(String((ev as MessageEvent).data));
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------------------------------------ o de mentira

/** Cidade falsa (modo demonstração e testes): os mesmos eventos, sem servidor. Tudo sai do relógio dado. */
export interface FakeWorldStreamOptions {
  now?: () => number;
  /** Anda sozinho (um passo a cada 200 ms) e entrega o snapshot no próximo microtask. Padrão: true. */
  autoplay?: boolean;
}

const DISTRICT = 'centro';
const ME_ID = 'p_voce';
/** Nomes de mentira (apelidos), um por prédio. */
const OWNERS = [
  'Bit Coruja', 'Lua Pixel', 'Tato Loop', 'Nina Byte', 'Zeca Stack', 'Bia Cache', 'Rafa Tab', 'Duda Vim', 'Gabi Commit', 'Leo Queue',
  'Mia Patch', 'Teo Lint', 'Ivy Merge', 'Otto Shell', 'Maya Hook', 'Rui Diff', 'Sol Script', 'Noa Build', 'Kai Debug', 'Lis Deploy',
] as const;
const COUNTRIES = ['BR', 'PT', 'AR', 'ES', 'FR', 'MX', 'CL', 'US'] as const;
const THEMES: readonly WorldTheme[] = ['none', 'none', 'halloween', 'none', 'christmas', 'none', 'none'];
const TRAITS: readonly (readonly [TraitId, TraitId])[] = [['games', 'cafeina'], ['leitura', 'calma'], ['piadas', 'esporte'], ['series', 'sonecas'], ['fofoca', 'vaidade']];

/** Os 5 que andam: o quarteirão em volta do qual dão a volta, o sentido, a velocidade (tiles/s) e onde começam. */
const WALKERS: ReadonlyArray<{ name: string; look: 'f' | 'm'; block: CityPoint; cw: boolean; speed: number; phase: number }> = [
  { name: 'Pipoca Dev', look: 'f', block: { x: 0, y: 0 }, cw: true, speed: 2.4, phase: 10 },
  { name: 'Turbo Rex', look: 'm', block: { x: 1, y: 0 }, cw: false, speed: 3.1, phase: 40 },
  { name: 'Mel Kernel', look: 'f', block: { x: 0, y: 1 }, cw: true, speed: 2.0, phase: 75 },
  { name: 'Juca Null', look: 'm', block: { x: -1, y: 0 }, cw: false, speed: 2.7, phase: 5 },
  { name: 'Flor Async', look: 'f', block: { x: 1, y: 1 }, cw: true, speed: 4.5, phase: 120 },
];

/** O retângulo do meio da calçada em volta de um quarteirão (2 tiles de largura: o meio é a junta dos dois). */
function sidewalkLoop(block: CityPoint): { x0: number; y0: number; x1: number; y1: number; length: number } {
  const o = blockOrigin(block);
  const x0 = o.x - 1;
  const y0 = o.y - 1;
  const x1 = o.x + BLOCK_TILES.w + 1;
  const y1 = o.y + BLOCK_TILES.h + 1;
  return { x0, y0, x1, y1, length: 2 * (x1 - x0 + (y1 - y0)) };
}

/** Onde está quem anda `dist` tiles pela volta (sentido horário: leste, sul, oeste, norte). */
export function loopPosition(block: CityPoint, dist: number, cw: boolean): WorldPosition {
  const l = sidewalkLoop(block);
  const w = l.x1 - l.x0;
  const h = l.y1 - l.y0;
  let d = ((cw ? dist : -dist) % l.length + l.length) % l.length;
  const round = (v: number) => Math.round(v * 100) / 100;
  const at = (x: number, y: number, dirCw: Direction, dirCcw: Direction): WorldPosition => ({ x: round(x), y: round(y), dir: cw ? dirCw : dirCcw, moving: true });
  if (d < w) return at(l.x0 + d, l.y0, 'e', 'w');
  d -= w;
  if (d < h) return at(l.x1, l.y0 + d, 's', 'n');
  d -= h;
  if (d < w) return at(l.x1 - d, l.y1, 'w', 'e');
  d -= w;
  return at(l.x0, l.y1 - d, 'n', 's');
}

const chunkOfPos = (x: number, y: number) => chunkId(DISTRICT, chunkOf(blockAt(x, y)));

/** Os 20 prédios da cidade falsa: um a cada 7 lotes da espiral (nos quarteirões em volta da praça). */
export function fakeCityBuildings(): WorldBuildingPublic[] {
  const lots: CityPoint[] = [];
  for (const lot of lotSpiral()) {
    if (lots.length >= 140) break;
    lots.push(lot);
  }
  return OWNERS.map((name, i) => {
    const lot = lots[i * 7]!;
    const floors = 1 + ((i * 5) % 12);
    const total = floors + (i % 4);
    const working = Math.min(total, 1 + (i % 3));
    const waiting = Math.min(total - working, i % 2);
    const b: WorldBuildingPublic = {
      id: `b_${String(i + 1).padStart(2, '0')}`,
      lot: { district: DISTRICT, x: lot.x, y: lot.y },
      owner: { id: `b_${String(i + 1).padStart(2, '0')}`, name, ...(i % 5 === 2 ? {} : { country: COUNTRIES[i % COUNTRIES.length] }) },
      state: i % 5 === 3 ? 'away' : 'online',
      theme: THEMES[i % THEMES.length]!,
      floors,
      rev: 1,
      likes: (i * 13) % 40,
      sinceMonth: '2026-10',
    };
    if (i % 6 !== 4) b.agents = { total, working, waiting, idle: total - working - waiting };
    if (i % 4 !== 1) b.tokens = { day: (i % 5) as 0 | 1 | 2 | 3 | 4, week: Math.min(5, (i % 5) + 1) as 1 | 2 | 3 | 4 | 5 };
    if (i % 9 === 4) b.closed = true;
    return b;
  });
}

export class FakeWorldStream implements WorldStream {
  private readonly listeners = new Listeners();
  private readonly now: () => number;
  private readonly start: number;
  private readonly buildings = fakeCityBuildings();
  private readonly revs = new Map<string, number>();
  private readonly walkers: WorldPlayerPublic[];
  private me: WorldPosition = { ...spawnPoint(), dir: 's', moving: false };
  private viewing = true;
  private closed = false;
  private ticks = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Respostas aos comandos: saem no próximo passo, como uma ida e volta. */
  private pending: WorldSceneMessage[] = [];

  constructor(o: FakeWorldStreamOptions = {}) {
    this.now = o.now ?? Date.now;
    this.start = this.now();
    for (const b of this.buildings) this.revs.set(this.chunkOfBuilding(b), 1);
    this.walkers = WALKERS.map((w, i) => ({
      id: `p_${i + 1}`,
      name: w.name,
      ...(i === 2 ? {} : { country: COUNTRIES[(i * 3) % COUNTRIES.length] }),
      look: w.look,
      parts: flattenAppearance(1_000 + i * 97, undefined, w.look),
      traits: [...TRAITS[i % TRAITS.length]!],
      intro: 'hello',
      likesReceived: i * 3,
      pos: loopPosition(w.block, w.phase, w.cw),
      where: 'street',
    }));
    if (o.autoplay !== false) {
      this.timer = setInterval(() => this.tick(), CMD_BATCH_MS);
    }
  }

  on(listener: (ev: WorldStreamEvent) => void): () => void {
    const off = this.listeners.add(listener);
    // Como o de verdade: o snapshot chega depois de abrir (nunca dentro do `on`).
    void Promise.resolve().then(() => {
      if (this.closed) return;
      listener({ type: 'status', status: 'open' });
      listener({ type: 'snapshot', snapshot: this.snapshot() });
    });
    return off;
  }

  /** O estado inteiro, como o `world.snapshot` do servidor local. */
  snapshot(): WorldSceneSnapshot {
    const byChunk = new Map<string, WorldBuildingPublic[]>();
    for (const b of this.buildings) {
      const c = this.chunkOfBuilding(b);
      if (!byChunk.has(c)) byChunk.set(c, []);
      byChunk.get(c)!.push(b);
    }
    return structuredClone({
      stream: 'fake',
      connected: true,
      viewing: this.viewing,
      district: DISTRICT,
      me: { id: ME_ID, name: 'Pixel Dev', look: 'f', parts: flattenAppearance(7, undefined, 'f'), traits: ['cafeina', 'games'], intro: 'coffee', country: 'BR' },
      pos: this.me,
      afk: false,
      chunks: this.viewing ? [...byChunk.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([chunk, buildings]) => ({ chunk, rev: this.revs.get(chunk) ?? 1, buildings })) : [],
      players: this.viewing ? this.walkers : [],
      minimap: this.viewing ? this.minimap() : null,
    });
  }

  send(cmds: WorldSceneCommand[]): void {
    if (this.closed) return;
    for (const c of reduceSceneBatch(cmds)) this.command(c);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.listeners.emit({ type: 'status', status: 'closed' });
    this.listeners.clear();
  }

  /** Um passo (200 ms): as respostas pendentes, os 5 andando e, a cada 3 s, um prédio que muda. */
  tick(): void {
    if (this.closed) return;
    this.ticks++;
    const out = this.pending;
    this.pending = [];
    for (const m of out) this.emit(m);
    if (!this.viewing) return;
    const t = (this.now() - this.start) / 1000;
    const byChunk = new Map<string, Array<{ id: string; pos: WorldPosition }>>();
    this.walkers.forEach((p, i) => {
      const w = WALKERS[i]!;
      p.pos = loopPosition(w.block, w.phase + w.speed * t, w.cw);
      const c = chunkOfPos(p.pos.x, p.pos.y);
      if (!byChunk.has(c)) byChunk.set(c, []);
      byChunk.get(c)!.push({ id: p.id, pos: { ...p.pos } });
    });
    for (const [chunk, players] of byChunk) this.emit({ t: 'players', chunk, players });
    if (this.ticks % 15 === 0) {
      const b = this.buildings[(this.ticks / 15) % this.buildings.length]!;
      if (b.agents) {
        const working = (b.agents.working + 1) % (b.agents.total + 1);
        b.agents = { ...b.agents, working, waiting: Math.min(b.agents.waiting, b.agents.total - working), idle: 0 };
        b.agents.idle = b.agents.total - b.agents.working - b.agents.waiting;
        b.rev++;
        const chunk = this.chunkOfBuilding(b);
        const rev = (this.revs.get(chunk) ?? 1) + 1;
        this.revs.set(chunk, rev);
        this.emit({ t: 'area.patch', chunk, rev, changes: [{ id: b.id, agents: { ...b.agents }, rev: b.rev }] });
      }
    }
    if (this.ticks % 300 === 0) this.emit({ t: 'minimap', blocks: this.minimap() });
  }

  private command(c: WorldSceneCommand): void {
    switch (c.t) {
      case 'move': {
        // Como o servidor: destino caminhável e perto do último (um passo de 200 ms correndo é ~1,2 tile).
        const far = Math.hypot(c.x - this.me.x, c.y - this.me.y) > 6;
        if (!isWalkable(c.x, c.y, () => true) || far) {
          this.pending.push({ t: 'pos', x: this.me.x, y: this.me.y });
          return;
        }
        this.me = { x: c.x, y: c.y, dir: c.dir, moving: c.moving };
        return;
      }
      case 'profile': {
        const p = this.walkers.find((w) => w.id === c.playerId);
        this.pending.push(p ? { t: 'profile', player: structuredClone(p) } : { t: 'notice', level: 'info', text: 'not_found' });
        return;
      }
      case 'like':
      case 'unlike': {
        const b = this.buildings.find((x) => x.id === c.buildingId);
        if (!b) return;
        const liked = c.t === 'like';
        if (!!b.likedByMe !== liked) b.likes += liked ? 1 : -1;
        b.likedByMe = liked;
        this.pending.push({ t: 'like.update', buildingId: b.id, likes: b.likes, likedByMe: liked });
        return;
      }
      case 'greet':
        this.pending.push({ t: 'greeting', from: ME_ID, to: c.playerId, greetingId: c.greetingId as GreetingId, until: this.now() + 5_000 });
        return;
      case 'resync':
        for (const ch of this.snapshot().chunks) {
          if (c.chunk === undefined || ch.chunk === c.chunk) this.pending.push({ t: 'area', chunk: ch.chunk, rev: ch.rev, buildings: ch.buildings });
        }
        return;
      case 'view':
        this.viewing = true;
        void Promise.resolve().then(() => !this.closed && this.listeners.emit({ type: 'snapshot', snapshot: this.snapshot() }));
        return;
      case 'view.off':
        this.viewing = false;
        return;
      default:
        // enter, leave, block, unblock, report: as próximas fases.
        return;
    }
  }

  private emit(msg: WorldSceneMessage): void {
    this.listeners.emit({ type: 'message', msg: structuredClone(msg) });
  }

  private chunkOfBuilding(b: WorldBuildingPublic): string {
    return chunkId(DISTRICT, chunkOf(blockOf(b.lot)));
  }

  private minimap(): Array<{ x: number; y: number; lit: number }> {
    const blocks = new Map<string, { x: number; y: number; lit: number }>();
    for (const b of this.buildings) {
      const bl = blockOf(b.lot);
      const key = `${bl.x},${bl.y}`;
      if (!blocks.has(key)) blocks.set(key, { x: bl.x, y: bl.y, lit: 0 });
      if (b.state === 'online') blocks.get(key)!.lit++;
    }
    return [...blocks.values()].sort((a, b) => a.y - b.y || a.x - b.x);
  }
}

// ------------------------------------------------------------------------------------------------ fábrica

/** O stream da cena: no modo demonstração, a cidade falsa; fora dele, o servidor local. */
export function createWorldStream(opts: { mock: boolean } & HttpWorldStreamOptions & FakeWorldStreamOptions): WorldStream {
  return opts.mock ? new FakeWorldStream(opts) : new HttpWorldStream(opts);
}
