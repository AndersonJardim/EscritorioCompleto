// Cidade de mentira para o modo demonstração (`?mock=1&world=approved&scene=city`) e para as capturas: tudo
// fictício e gerado aqui (nenhum dado do escritório de verdade). Mesma forma do stream de verdade
// (createWorldStream): `world.snapshot` ao abrir e as mensagens do servidor do mundo depois (`players` a 5/s,
// `area.patch` de vez em quando, `minimap` por minuto, `profile` quando pedido, `pos` se o `move` cair num lote).
//
// `?perf=N` enche N lotes (medição de desempenho com centenas de prédios na tela).
import type { AppearanceParts } from '../../../../shared/appearance';
import { mulberry32 } from '../../../../shared/hash';
import { BLOCK_TILES, FOUNTAIN, PLAZA, SIDEWALK, blockOf, blockOrigin, chunkId, chunkOf, isWalkable, lotDoor, lotSpiral, type CityPoint } from '../../../../shared/world/city';
import type { Direction, GreetingId, IntroId, TraitId, WorldBuildingPublic, WorldPlayerPublic, WorldTheme } from '../../../../shared/world/protocol';
import type { CityCommand, CitySelf, WorldStream, WorldStreamEvent } from './stream';

const DISTRICT = 'centro';

/** O personagem da conta de exemplo do FakeWorldApi (net/world.ts), o mesmo das Configurações no modo demonstração. */
export const FAKE_ME: CitySelf = {
  id: 'p_voce',
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
};

/** Donos fictícios (nomes de jogador inventados). */
const OWNERS: [string, string | undefined][] = [
  ['Ana Pixel', 'BR'], ['Bruno Byte', 'PT'], ['Camille Code', 'FR'], ['Diego Deploy', 'MX'], ['Emma Stack', 'US'],
  ['Felipe Fork', 'AR'], ['Gabi Git', 'BR'], ['Hiro Hash', 'JP'], ['Inês Infra', 'ES'], ['Jonas Json', 'DE'],
  ['Kai Kernel', 'CA'], ['Lia Lambda', 'IT'], ['Marco Merge', 'CL'], ['Nina Node', 'CO'], ['Oscar Ops', 'GB'],
  ['Priya Patch', 'IN'], ['Quim Query', undefined], ['Rosa Regex', 'BR'], ['Sami Shell', 'KR'], ['Téo Test', 'PT'],
];

function parts(rng: () => number): AppearanceParts {
  const pick = <T,>(a: readonly T[]) => a[Math.floor(rng() * a.length)]!;
  return {
    skin: pick(['#ffe2cc', '#eab894', '#d69f78', '#bd8560', '#9a6444', '#7a4a31']),
    hair: pick(['#2b2530', '#3f2c22', '#87593a', '#d6ae68', '#b0703c', '#8e3b2b']),
    hairStyle: pick(['short', 'curly', 'bob', 'long', 'ponytail', 'bun', 'afro', 'spiky', 'wavy', 'side_part'] as const),
    eyes: pick(['#2f5f9e', '#3b2a20', '#3f6f3a']),
    top: pick(['#e2604f', '#3f7fd8', '#4cae6a', '#8d66cf', '#f2c14e', '#36b0b0', '#e47aa8']),
    topAccent: '#f4f4f0',
    topStyle: pick(['tshirt', 'hoodie', 'sweater', 'jacket', 'polo', 'blouse'] as const),
    bottom: pick(['#2c2c35', '#3a4a6a', '#5a4a3a', '#4b5563']),
    bottomStyle: pick(['pants', 'pants', 'shorts', 'skirt'] as const),
    shoes: pick(['#ececec', '#3a2a20', '#1f1f24']),
    accessory: pick(['none', 'none', 'glasses', 'headphones', 'cap', 'beanie', 'earrings'] as const),
    accessoryColor: '#2b2b33',
    facialHair: 'none',
  };
}

interface Walker {
  info: WorldPlayerPublic;
  /** Volta pela calçada de um quarteirão (retângulo em tiles) ou parado num banco. */
  loop: { x0: number; y0: number; x1: number; y1: number } | null;
  speed: number;
  phase: number;
}

/** Perímetro do retângulo percorrido no sentido horário: posição e direção na distância `d`. */
function onLoop(r: { x0: number; y0: number; x1: number; y1: number }, d: number): { x: number; y: number; dir: Direction } {
  const w = r.x1 - r.x0;
  const hh = r.y1 - r.y0;
  const per = 2 * (w + hh);
  let s = ((d % per) + per) % per;
  if (s < w) return { x: r.x0 + s, y: r.y0, dir: 'e' };
  s -= w;
  if (s < hh) return { x: r.x1, y: r.y0 + s, dir: 's' };
  s -= hh;
  if (s < w) return { x: r.x1 - s, y: r.y1, dir: 'w' };
  s -= w;
  return { x: r.x0, y: r.y1 - s, dir: 'n' };
}

/** A calçada (faixa de dentro) em volta do quarteirão, em tiles. */
function sidewalkLoop(b: CityPoint, inset = 0.5): { x0: number; y0: number; x1: number; y1: number } {
  const o = blockOrigin(b);
  return { x0: o.x - SIDEWALK + inset + 0.5, y0: o.y - SIDEWALK + inset + 0.5, x1: o.x + BLOCK_TILES.w + SIDEWALK - inset - 0.5, y1: o.y + BLOCK_TILES.h + SIDEWALK - inset - 0.5 };
}

export interface FakeCityOptions {
  /** Quantos prédios (padrão 20). */
  buildings?: number;
  now?: () => number;
}

export class FakeWorldStream implements WorldStream {
  private readonly listeners = new Map<WorldStreamEvent, Set<(data: unknown) => void>>();
  private readonly timers: ReturnType<typeof setInterval | typeof setTimeout>[] = [];
  readonly buildings: WorldBuildingPublic[] = [];
  private readonly walkers: Walker[] = [];
  private readonly t0: number;
  private readonly now: () => number;
  private lastMove = 0;
  private myPos: { x: number; y: number };
  private afkSent = false;
  private closed = false;
  /** `rev` de cada chunk (sobe de 1 em 1, como no servidor). */
  private readonly chunkRevs = new Map<string, number>();
  readonly myBuilding: WorldBuildingPublic;

  constructor(opts: FakeCityOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.t0 = this.now();
    this.lastMove = this.t0;
    const rng = mulberry32(0xc17c17);
    const n = Math.max(1, Math.min(2000, opts.buildings ?? 20));
    const themes: WorldTheme[] = ['none', 'halloween', 'none', 'christmas', 'none', 'halloween'];
    let i = 0;
    for (const lot of lotSpiral()) {
      if (i >= n) break;
      const [name, country] = OWNERS[i % OWNERS.length]!;
      const mine = i === 3;
      const floors = mine ? 4 : [2, 6, 13, 1, 9, 3, 16, 5, 0, 11, 4, 7, 2, 20, 8, 3, 12, 1, 6, 10][i % 20]!;
      const total = Math.max(1, Math.round(floors * (1 + rng() * 1.5)));
      const working = Math.round(total * rng());
      const waiting = Math.min(total - working, rng() < 0.4 ? 1 + Math.floor(rng() * 2) : 0);
      const away = !mine && (i % 7 === 5 || i % 11 === 9);
      const discreet = !mine && i % 9 === 4;
      const b: WorldBuildingPublic = {
        id: mine ? 'b_voce' : `b_${i.toString(36).padStart(3, '0')}`,
        lot: { district: DISTRICT, x: lot.x, y: lot.y },
        owner: mine ? { id: FAKE_ME.id, name: FAKE_ME.name, country: FAKE_ME.country } : { id: `p_${i}`, name: n > OWNERS.length ? `${name} ${Math.floor(i / OWNERS.length) + 1}` : name, ...(country ? { country } : {}) },
        state: away ? 'away' : 'online',
        theme: mine ? 'halloween' : themes[i % themes.length]!,
        floors,
        ...(discreet ? {} : { agents: { total, working, waiting, idle: total - working - waiting } }),
        ...(i % 8 === 6 ? { closed: true } : {}),
        rev: 1,
        likes: Math.floor(rng() * 240),
        sinceMonth: `2026-${String(8 + (i % 3)).padStart(2, '0')}`,
      };
      this.buildings.push(b);
      i++;
    }
    this.myBuilding = this.buildings[3] ?? this.buildings[0]!;
    const door = lotDoor(this.myBuilding.lot);
    this.myPos = { x: door.front.x, y: door.front.y + (door.side === 's' ? 0.6 : -0.4) };
    // jogadores: quatro andando em volta de quarteirões, um correndo e um sentado num banco da praça
    const loops: [CityPoint, number, number][] = [
      [{ x: 1, y: 0 }, 3.0, 0.1],
      [{ x: 1, y: 0 }, 3.2, 0.55],
      [{ x: 0, y: 0 }, 2.9, 0.3],
      [{ x: 1, y: 1 }, 3.1, 0.8],
      [{ x: 0, y: 1 }, 5.6, 0.2],
    ];
    const prng = mulberry32(0x9e1a);
    const intros: IntroId[] = ['coffee', 'tabs', 'pixel_art', 'cats', 'ship_fast', 'music'];
    const traitSets: TraitId[][] = [['games', 'piadas'], ['leitura', 'calma'], ['competicao', 'esporte', 'cafeina'], ['series', 'fofoca'], ['esporte', 'cafeina'], ['timidez', 'leitura']];
    const names: [string, 'f' | 'm', string | undefined][] = [
      ['Luna Loop', 'f', 'BR'], ['Max Merge', 'm', 'US'], ['Zoe Zip', 'f', 'FR'], ['Rafa Runtime', 'm', 'ES'], ['Yuki Yarn', 'f', 'JP'], ['Ravi Repo', 'm', 'IN'],
    ];
    names.forEach(([pname, look, country], k) => {
      const owner = this.buildings[k * 3 + 1];
      const info: WorldPlayerPublic = {
        id: `w_${k}`,
        name: pname,
        ...(country ? { country } : {}),
        look,
        parts: parts(prng),
        traits: traitSets[k]!,
        intro: intros[k % intros.length]!,
        ...(owner && k % 2 === 0 ? { buildingId: owner.id } : {}),
        likesReceived: Math.floor(prng() * 60),
        pos: { x: 0, y: 0, dir: 's', moving: false },
        where: 'street',
      };
      const l = loops[k];
      if (l) this.walkers.push({ info, loop: sidewalkLoop(l[0], k % 2 ? 1 : 0), speed: l[1], phase: l[2] });
      else {
        // sentado no banco ao sul da fonte (o servidor põe o ausente no banco mais perto)
        const o = blockOrigin(PLAZA);
        info.pos = { x: o.x + FOUNTAIN.x + FOUNTAIN.w / 2 + 5, y: o.y + FOUNTAIN.y + FOUNTAIN.h + 2 + 0.85, dir: 's', moving: false };
        this.walkers.push({ info, loop: null, speed: 0, phase: 0 });
      }
    });
    this.step(this.t0);
    // o snapshot sai no próximo giro (o chamador já registrou os ouvintes)
    this.timers.push(setTimeout(() => this.emit('world.snapshot', this.snapshot()), 0));
    this.timers.push(setInterval(() => this.tickPlayers(), 200));
    this.timers.push(setInterval(() => this.tickBuildings(), 6000));
    this.timers.push(setInterval(() => this.emit('world', { t: 'minimap', blocks: this.minimapBlocks() }), 60_000));
  }

  on(ev: WorldStreamEvent, fn: (data: unknown) => void): () => void {
    let set = this.listeners.get(ev);
    if (!set) this.listeners.set(ev, (set = new Set()));
    set.add(fn);
    return () => void set.delete(fn);
  }

  send(cmds: readonly CityCommand[]): void {
    if (this.closed) return;
    for (const c of cmds) {
      if (c.t === 'move') {
        this.lastMove = this.now();
        this.afkSent = false;
        if (!isWalkable(c.x, c.y, () => true)) {
          // como o servidor: posição fora da calçada volta para a última válida
          const back = { ...this.myPos };
          this.timers.push(setTimeout(() => this.emit('world', { t: 'pos', x: back.x, y: back.y }), 60));
        } else this.myPos = { x: c.x, y: c.y };
      } else if (c.t === 'profile') {
        const w = this.walkers.find((x) => x.info.id === c.playerId);
        if (w) this.timers.push(setTimeout(() => this.emit('world', { t: 'profile', player: { ...w.info } }), 180));
      }
    }
  }

  close(): void {
    this.closed = true;
    for (const t of this.timers) clearInterval(t as ReturnType<typeof setInterval>);
    this.timers.length = 0;
    this.listeners.clear();
  }

  private emit(ev: WorldStreamEvent, data: unknown): void {
    if (this.closed) return;
    for (const fn of this.listeners.get(ev) ?? []) fn(data);
  }

  snapshot(): unknown {
    const byChunk = new Map<string, WorldBuildingPublic[]>();
    for (const b of this.buildings) {
      const id = chunkId(DISTRICT, chunkOf(blockOf(b.lot)));
      const list = byChunk.get(id) ?? [];
      list.push(b);
      byChunk.set(id, list);
    }
    return {
      me: { ...FAKE_ME },
      pos: { x: this.myPos.x, y: this.myPos.y, dir: 's' },
      building: this.myBuilding,
      chunks: [...byChunk].map(([chunk, buildings]) => ({ chunk, rev: this.chunkRevs.get(chunk) ?? 1, buildings })),
      players: this.walkers.map((w) => ({ ...w.info })),
      minimap: { blocks: this.minimapBlocks() },
    };
  }

  minimapBlocks(): Array<{ x: number; y: number; lit: number }> {
    const m = new Map<string, { x: number; y: number; lit: number }>();
    for (const b of this.buildings) {
      const bl = blockOf(b.lot);
      const key = `${bl.x},${bl.y}`;
      const e = m.get(key) ?? { x: bl.x, y: bl.y, lit: 0 };
      if (b.state === 'online') e.lit++;
      m.set(key, e);
    }
    return [...m.values()];
  }

  private step(now: number): void {
    const t = (now - this.t0) / 1000;
    for (const w of this.walkers) {
      if (!w.loop) continue;
      const per = 2 * (w.loop.x1 - w.loop.x0 + w.loop.y1 - w.loop.y0);
      const p = onLoop(w.loop, w.phase * per + t * w.speed);
      w.info.pos = { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100, dir: p.dir, moving: true };
    }
  }

  private tickPlayers(): void {
    const now = this.now();
    this.step(now);
    const moving = this.walkers.filter((w) => w.loop);
    if (moving.length) {
      this.emit('world', {
        t: 'players',
        chunk: chunkId(DISTRICT, { x: 0, y: 0 }),
        players: moving.map((w) => ({ id: w.info.id, pos: { ...w.info.pos }, ...(w.info.greeting ? { greeting: w.info.greeting } : {}) })),
      });
    }
    if (!this.afkSent && now - this.lastMove > 60_000) {
      this.afkSent = true;
      this.emit('world', { t: 'afk' });
    }
  }

  /** De tempo em tempo um prédio muda: agentes começam ou param de trabalhar, alguém espera, chegam likes. */
  private tickBuildings(): void {
    const rng = mulberry32(Math.floor(this.now() / 1000));
    const b = this.buildings[Math.floor(rng() * this.buildings.length)];
    if (!b || !b.agents || b.state !== 'online') return;
    const total = b.agents.total;
    const working = Math.round(total * rng());
    const waiting = Math.min(total - working, rng() < 0.5 ? 1 : 0);
    b.agents = { total, working, waiting, idle: total - working - waiting };
    b.likes += rng() < 0.4 ? 1 : 0;
    b.rev++;
    const chunk = chunkId(DISTRICT, chunkOf(blockOf(b.lot)));
    const rev = (this.chunkRevs.get(chunk) ?? 1) + 1;
    this.chunkRevs.set(chunk, rev);
    this.emit('world', { t: 'area.patch', chunk, rev, changes: [{ id: b.id, agents: b.agents, likes: b.likes, rev: b.rev }] });
  }

  /** Para os testes: um cumprimento de mentira (Fase 5). */
  greet(id: string, greeting: GreetingId, until: number): void {
    const w = this.walkers.find((x) => x.info.id === id);
    if (w) w.info.greeting = { id: greeting, until };
  }
}

/** A mesma assinatura do stream de verdade (net/world-stream.ts): no modo demonstração, este. */
export function createFakeWorldStream(opts: FakeCityOptions = {}): FakeWorldStream {
  return new FakeWorldStream(opts);
}
