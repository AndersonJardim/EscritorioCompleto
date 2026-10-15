// Estado da cidade no navegador (puro): prédios por chunk e por lote, jogadores visíveis com as amostras de posição,
// minimapa e eu. Consome as mensagens do servidor do mundo como vieram (evento `world` do stream) e o
// `world.snapshot`; devolve os efeitos que a cena precisa tratar (correção de posição, ausente, perfil, aviso).
import type { WorldBuildingPublic, WorldPlayerPublic, WorldPosition } from '../../../../shared/world/protocol';
import { lotKey } from './layout';
import { pushSample, type Sample } from './players';
import { isBuilding, isPlayer, readCitySnapshot, type CitySelf, type CitySnapshot } from './stream';

export interface RemotePlayer {
  info: WorldPlayerPublic;
  samples: Sample[];
}

export type CityEffect =
  | { type: 'pos'; x: number; y: number }
  | { type: 'afk' }
  | { type: 'profile'; player: WorldPlayerPublic }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function readPosition(v: unknown): WorldPosition | null {
  if (!isObject(v) || !finite(v.x) || !finite(v.y)) return null;
  const dir = v.dir === 'n' || v.dir === 's' || v.dir === 'e' || v.dir === 'w' ? v.dir : 's';
  return { x: v.x, y: v.y, dir, moving: v.moving === true };
}

export class CityState {
  me: CitySelf | null = null;
  /** Posição que veio no snapshot (consumida uma vez pela cena). */
  startPos: { x: number; y: number } | null = null;
  myBuildingId: string | null = null;
  readonly buildings = new Map<string, WorldBuildingPublic>();
  private readonly lots = new Map<string, string>();
  private readonly chunkIds = new Map<string, Set<string>>();
  readonly chunkRev = new Map<string, number>();
  readonly players = new Map<string, RemotePlayer>();
  minimap: Array<{ x: number; y: number; lit: number }> = [];
  /** Sobe quando algum prédio muda (caches de quem desenha). */
  version = 0;
  minimapVersion = 0;

  /** O prédio do lote, se houver. */
  buildingAt(lot: { x: number; y: number }): WorldBuildingPublic | undefined {
    const id = this.lots.get(lotKey(lot));
    return id ? this.buildings.get(id) : undefined;
  }

  myBuilding(): WorldBuildingPublic | undefined {
    return this.myBuildingId ? this.buildings.get(this.myBuildingId) : undefined;
  }

  /** O `world.snapshot`: troca o estado inteiro (prédios, jogadores, minimapa) pelo do servidor local. */
  applySnapshot(raw: unknown, now: number): CitySnapshot {
    const snap: CitySnapshot = readCitySnapshot(raw);
    this.buildings.clear();
    this.lots.clear();
    this.chunkIds.clear();
    this.chunkRev.clear();
    this.players.clear();
    if (snap.me) this.me = snap.me;
    if (snap.pos) this.startPos = { x: snap.pos.x, y: snap.pos.y };
    if (snap.me?.buildingId) this.myBuildingId = snap.me.buildingId;
    if (snap.building) {
      this.myBuildingId = snap.building.id;
      this.putBuilding(snap.building, '');
    }
    for (const a of snap.areas) this.applyArea(a.chunk, a.rev, a.buildings);
    for (const p of snap.players) this.join(p, now);
    if (snap.minimap) this.setMinimap(snap.minimap);
    this.version++;
    return snap;
  }

  /** Uma mensagem do servidor do mundo; devolve o efeito para a cena, se houver. */
  apply(msg: unknown, now: number): CityEffect | null {
    if (!isObject(msg) || typeof msg.t !== 'string') return null;
    switch (msg.t) {
      case 'welcome': {
        const snap = readCitySnapshot({ me: msg.me, building: msg.building });
        if (snap.me) this.me = snap.me;
        if (snap.building) {
          this.myBuildingId = snap.building.id;
          this.putBuilding(snap.building, '');
          this.version++;
        }
        return null;
      }
      case 'area':
        if (typeof msg.chunk === 'string' && Array.isArray(msg.buildings)) {
          this.applyArea(msg.chunk, finite(msg.rev) ? msg.rev : 0, msg.buildings.filter(isBuilding));
          this.version++;
        }
        return null;
      case 'area.patch':
        if (typeof msg.chunk === 'string') this.applyPatch(msg.chunk, msg);
        return null;
      case 'players':
        if (Array.isArray(msg.players)) {
          for (const p of msg.players) {
            if (!isObject(p) || typeof p.id !== 'string' || p.id === this.me?.id) continue;
            const rp = this.players.get(p.id);
            const pos = readPosition(p.pos);
            if (!rp || !pos) continue;
            rp.info.pos = pos;
            if (isObject(p.greeting)) rp.info.greeting = p.greeting as WorldPlayerPublic['greeting'];
            pushSample(rp.samples, { t: now, ...pos });
          }
        }
        return null;
      case 'player.join':
        if (isPlayer(msg.player)) this.join(msg.player, now);
        return null;
      case 'player.leave':
        if (typeof msg.id === 'string') this.players.delete(msg.id);
        return null;
      case 'profile':
        if (isPlayer(msg.player)) {
          const rp = this.players.get(msg.player.id);
          if (rp) rp.info = { ...rp.info, ...msg.player, pos: rp.info.pos };
          return { type: 'profile', player: msg.player };
        }
        return null;
      case 'minimap':
        if (Array.isArray(msg.blocks)) this.setMinimap(msg.blocks.filter((b): b is { x: number; y: number; lit: number } => isObject(b) && finite(b.x) && finite(b.y) && finite(b.lit)));
        return null;
      case 'like.update': {
        const b = typeof msg.buildingId === 'string' ? this.buildings.get(msg.buildingId) : undefined;
        if (b && finite(msg.likes)) {
          b.likes = msg.likes;
          b.likedByMe = msg.likedByMe === true;
          this.version++;
        }
        return null;
      }
      case 'pos':
        if (finite(msg.x) && finite(msg.y)) return { type: 'pos', x: msg.x, y: msg.y };
        return null;
      case 'afk':
        return { type: 'afk' };
      case 'notice':
        if (typeof msg.text === 'string') return { type: 'notice', level: msg.level === 'warn' || msg.level === 'error' ? msg.level : 'info', text: msg.text };
        return null;
      default:
        return null;
    }
  }

  private join(p: WorldPlayerPublic, now: number): void {
    if (p.id === this.me?.id) return;
    const prev = this.players.get(p.id);
    const samples = prev?.samples ?? [];
    pushSample(samples, { t: now, ...p.pos });
    this.players.set(p.id, { info: { ...p }, samples });
  }

  private setMinimap(blocks: Array<{ x: number; y: number; lit: number }>): void {
    this.minimap = blocks.map((b) => ({ x: Math.floor(b.x), y: Math.floor(b.y), lit: Math.max(0, Math.floor(b.lit)) }));
    this.minimapVersion++;
  }

  private putBuilding(b: WorldBuildingPublic, chunk: string): void {
    const prev = this.buildings.get(b.id);
    if (prev && lotKey(prev.lot) !== lotKey(b.lot) && this.lots.get(lotKey(prev.lot)) === b.id) this.lots.delete(lotKey(prev.lot));
    this.buildings.set(b.id, b);
    this.lots.set(lotKey(b.lot), b.id);
    if (chunk) {
      let set = this.chunkIds.get(chunk);
      if (!set) this.chunkIds.set(chunk, (set = new Set()));
      set.add(b.id);
    }
  }

  private removeBuilding(id: string): void {
    const b = this.buildings.get(id);
    if (!b) return;
    if (this.lots.get(lotKey(b.lot)) === id) this.lots.delete(lotKey(b.lot));
    this.buildings.delete(id);
    for (const set of this.chunkIds.values()) set.delete(id);
  }

  /** `area`: o conteúdo inteiro do chunk (quem saiu da lista sai da cidade, exceto o meu prédio). */
  private applyArea(chunk: string, rev: number, list: WorldBuildingPublic[]): void {
    const keep = new Set(list.map((b) => b.id));
    if (chunk) {
      for (const id of this.chunkIds.get(chunk) ?? []) if (!keep.has(id) && id !== this.myBuildingId) this.removeBuilding(id);
      this.chunkIds.set(chunk, new Set());
      this.chunkRev.set(chunk, rev);
    }
    for (const b of list) this.putBuilding({ ...b }, chunk);
  }

  /** `area.patch`: só os campos que mudaram; `removed` (lista de ids) tira prédios. */
  private applyPatch(chunk: string, msg: Record<string, unknown>): void {
    if (finite(msg.rev)) this.chunkRev.set(chunk, msg.rev);
    for (const c of Array.isArray(msg.changes) ? msg.changes : []) {
      if (!isObject(c) || typeof c.id !== 'string') continue;
      const cur = this.buildings.get(c.id);
      if (cur) this.putBuilding({ ...cur, ...(c as Partial<WorldBuildingPublic>) } as WorldBuildingPublic, chunk);
      else if (isBuilding(c)) this.putBuilding({ ...c }, chunk);
    }
    if (Array.isArray(msg.removed)) for (const id of msg.removed) if (typeof id === 'string') this.removeBuilding(id);
    this.version++;
  }
}
