// Estado da cidade: snapshot tolerante, área por chunk (substitui), patch (mescla e remove), jogadores (entra,
// anda, sai; nunca eu), efeitos (pos, afk, profile, notice), likes e minimapa.
import { describe, expect, it } from 'vitest';
import type { WorldBuildingPublic, WorldPlayerPublic } from '../../../../shared/world/protocol';
import { CityState } from './state';
import { fromSceneStream, readCitySnapshot } from './stream';

function building(id: string, x: number, y: number, extra: Partial<WorldBuildingPublic> = {}): WorldBuildingPublic {
  return { id, lot: { district: 'centro', x, y }, owner: { id: `o_${id}`, name: `Dono ${id}`, country: 'BR' }, state: 'online', theme: 'none', floors: 3, agents: { total: 3, working: 1, waiting: 1, idle: 1 }, rev: 1, likes: 2, sinceMonth: '2026-10', ...extra };
}

function player(id: string, x: number, y: number): WorldPlayerPublic {
  return { id, name: `Jogador ${id}`, look: 'f', parts: {}, traits: ['games', 'piadas'], likesReceived: 1, pos: { x, y, dir: 's', moving: false }, where: 'street' };
}

const ME = { id: 'p_me', name: 'Eu', look: 'm', parts: {}, traits: ['cafeina'] };

describe('readCitySnapshot', () => {
  it('aceita chunks em lista ou mapa, prédios soltos, jogadores em mapa e minimapa em {blocks}', () => {
    const a = readCitySnapshot({ me: ME, pos: { x: 3, y: 4, dir: 'n' }, chunks: [{ chunk: 'centro:0,0', rev: 2, buildings: [building('a', 3, 0), { lixo: true }] }], players: [player('x', 1, 1)], minimap: { blocks: [{ x: 1, y: 0, lit: 2 }] } });
    expect(a.me?.id).toBe('p_me');
    expect(a.pos).toEqual({ x: 3, y: 4, dir: 'n' });
    expect(a.areas).toEqual([{ chunk: 'centro:0,0', rev: 2, buildings: [building('a', 3, 0)] }]);
    expect(a.players.map((p) => p.id)).toEqual(['x']);
    expect(a.minimap).toEqual([{ x: 1, y: 0, lit: 2 }]);
    const b = readCitySnapshot({ welcome: { me: ME, building: building('m', 4, 1) }, areas: { 'centro:0,0': { rev: 1, buildings: [building('a', 3, 0)] } }, buildings: [building('s', 5, 0)], players: { x: player('x', 1, 1) }, minimap: [{ x: 0, y: 0, lit: 0 }] });
    expect(b.me?.name).toBe('Eu');
    expect(b.building?.id).toBe('m');
    expect(b.areas.map((x) => x.chunk)).toEqual(['centro:0,0', '']);
    expect(b.players).toHaveLength(1);
  });

  it('corpo torto vira um snapshot vazio, sem exceção', () => {
    expect(readCitySnapshot(null)).toEqual({ areas: [], players: [] });
    expect(readCitySnapshot({ chunks: 'x', players: 3 })).toEqual({ areas: [], players: [] });
  });
});

describe('snapshot do servidor local (WorldSceneSnapshot)', () => {
  it('lê o formato do viewer: stream, conexão, eu com o id do prédio, posição, afk, chunks e minimapa nulo', () => {
    const raw = {
      stream: 's1', connected: true, viewing: true, district: 'centro', afk: true,
      me: { ...ME, buildingId: 'm' }, pos: { x: 58, y: 24.5, dir: 's', moving: false },
      chunks: [{ chunk: 'centro:0,0', rev: 4, buildings: [building('m', 4, 1)] }], players: [player('x', 1, 1)], minimap: null,
    };
    const snap = readCitySnapshot(raw);
    expect(snap).toMatchObject({ connected: true, afk: true, pos: { x: 58, y: 24.5, dir: 's' } });
    expect(snap.me?.buildingId).toBe('m');
    expect(snap.minimap).toBeUndefined();
    const s = new CityState();
    s.applySnapshot(raw, 0);
    expect(s.myBuilding()?.id).toBe('m');
    expect(readCitySnapshot({ ...raw, connected: false }).connected).toBe(false);
  });

  it('um snapshot novo troca o estado inteiro (reconexão): quem não veio sai', () => {
    const s = new CityState();
    s.applySnapshot({ me: ME, chunks: [{ chunk: 'c', rev: 1, buildings: [building('a', 3, 0)] }], players: [player('x', 1, 1)] }, 0);
    s.applySnapshot({ me: ME, chunks: [{ chunk: 'c', rev: 7, buildings: [building('b', 4, 0)] }], players: [] }, 10);
    expect([...s.buildings.keys()]).toEqual(['b']);
    expect(s.buildingAt({ x: 3, y: 0 })).toBeUndefined();
    expect(s.players.size).toBe(0);
    expect(s.chunkRev.get('c')).toBe(7);
  });

  it('o stream do servidor local (on(listener) com {type}) vira o da cena', () => {
    const listeners: ((ev: { type: string; snapshot?: unknown; msg?: unknown }) => void)[] = [];
    const emit = (ev: { type: string; snapshot?: unknown; msg?: unknown }) => listeners.forEach((l) => l(ev));
    const sent: unknown[] = [];
    let closed = false;
    const ws = fromSceneStream({ on: (l) => listeners.push(l), send: (c) => sent.push(...c), close: () => (closed = true) });
    const snaps: unknown[] = [];
    const msgs: unknown[] = [];
    ws.on('world.snapshot', (d) => snaps.push(d));
    ws.on('world', (d) => msgs.push(d));
    emit({ type: 'snapshot', snapshot: { stream: 's' } });
    emit({ type: 'message', msg: { t: 'afk' } });
    emit({ type: 'status' });
    expect(snaps).toEqual([{ stream: 's' }]);
    expect(msgs).toEqual([{ t: 'afk' }]);
    ws.send([{ t: 'profile', playerId: 'x' }]);
    expect(sent).toEqual([{ t: 'profile', playerId: 'x' }]);
    ws.close();
    expect(closed).toBe(true);
  });
});

describe('CityState', () => {
  it('snapshot: prédios por lote, meu prédio, jogadores (menos eu) e minimapa', () => {
    const s = new CityState();
    s.applySnapshot({ me: ME, building: building('m', 4, 1), chunks: [{ chunk: 'centro:0,0', rev: 3, buildings: [building('a', 3, 0), building('m', 4, 1)] }], players: [player('x', 1, 1), player('p_me', 2, 2)], minimap: [{ x: 1, y: 0, lit: 4 }] }, 0);
    expect(s.buildingAt({ x: 3, y: 0 })?.id).toBe('a');
    expect(s.myBuilding()?.id).toBe('m');
    expect([...s.players.keys()]).toEqual(['x']);
    expect(s.chunkRev.get('centro:0,0')).toBe(3);
    expect(s.minimap).toEqual([{ x: 1, y: 0, lit: 4 }]);
  });

  it('area substitui o chunk inteiro (quem saiu da lista sai da cidade)', () => {
    const s = new CityState();
    s.apply({ t: 'area', chunk: 'c:0,0', rev: 1, buildings: [building('a', 3, 0), building('b', 4, 0)] }, 0);
    const v = s.version;
    s.apply({ t: 'area', chunk: 'c:0,0', rev: 2, buildings: [building('b', 4, 0, { likes: 9 })] }, 0);
    expect(s.buildings.has('a')).toBe(false);
    expect(s.buildingAt({ x: 3, y: 0 })).toBeUndefined();
    expect(s.buildingAt({ x: 4, y: 0 })?.likes).toBe(9);
    expect(s.version).toBeGreaterThan(v);
  });

  it('area.patch mescla só os campos mudados, aceita prédio novo inteiro e remove os de `removed`', () => {
    const s = new CityState();
    s.apply({ t: 'area', chunk: 'c:0,0', rev: 1, buildings: [building('a', 3, 0), building('b', 4, 0)] }, 0);
    s.apply({ t: 'area.patch', chunk: 'c:0,0', rev: 2, changes: [{ id: 'a', state: 'away' }, building('n', 5, 0), { id: 'desconhecido', likes: 3 }], removed: ['b'] }, 0);
    expect(s.buildings.get('a')?.state).toBe('away');
    expect(s.buildings.get('a')?.owner.name).toBe('Dono a');
    expect(s.buildingAt({ x: 5, y: 0 })?.id).toBe('n');
    expect(s.buildings.has('b')).toBe(false);
    expect(s.buildings.has('desconhecido')).toBe(false);
    expect(s.chunkRev.get('c:0,0')).toBe(2);
  });

  it('um prédio que muda de lote libera o lote antigo', () => {
    const s = new CityState();
    s.apply({ t: 'area', chunk: 'c:0,0', rev: 1, buildings: [building('a', 3, 0)] }, 0);
    s.apply({ t: 'area.patch', chunk: 'c:0,0', rev: 2, changes: [{ id: 'a', lot: { district: 'centro', x: 4, y: 0 } }] }, 0);
    expect(s.buildingAt({ x: 3, y: 0 })).toBeUndefined();
    expect(s.buildingAt({ x: 4, y: 0 })?.id).toBe('a');
  });

  it('jogadores: entram, andam (amostras em ordem), saem; o próprio id e desconhecidos são ignorados', () => {
    const s = new CityState();
    s.applySnapshot({ me: ME }, 0);
    s.apply({ t: 'player.join', player: player('x', 1, 1) }, 100);
    s.apply({ t: 'players', chunk: 'c', players: [{ id: 'x', pos: { x: 2, y: 1, dir: 'e', moving: true } }, { id: 'p_me', pos: { x: 9, y: 9, dir: 'e', moving: true } }, { id: 'y', pos: { x: 0, y: 0, dir: 'e', moving: true } }] }, 300);
    const x = s.players.get('x')!;
    expect(x.samples.map((v) => [v.t, v.x])).toEqual([[100, 1], [300, 2]]);
    expect(x.info.pos.x).toBe(2);
    expect(s.players.has('p_me')).toBe(false);
    expect(s.players.has('y')).toBe(false);
    s.apply({ t: 'player.join', player: player('p_me', 1, 1) }, 400);
    expect(s.players.has('p_me')).toBe(false);
    s.apply({ t: 'player.leave', id: 'x' }, 500);
    expect(s.players.size).toBe(0);
  });

  it('efeitos para a cena: pos, afk, profile e notice', () => {
    const s = new CityState();
    s.apply({ t: 'player.join', player: player('x', 1, 1) }, 0);
    expect(s.apply({ t: 'pos', x: 3, y: 4 }, 0)).toEqual({ type: 'pos', x: 3, y: 4 });
    expect(s.apply({ t: 'afk' }, 0)).toEqual({ type: 'afk' });
    const prof = s.apply({ t: 'profile', player: { ...player('x', 7, 7), intro: 'coffee', likesReceived: 9 } }, 0);
    expect(prof?.type).toBe('profile');
    // o perfil atualiza os dados, mas a posição continua a das amostras
    expect(s.players.get('x')!.info.likesReceived).toBe(9);
    expect(s.players.get('x')!.info.pos.x).toBe(1);
    expect(s.apply({ t: 'notice', level: 'warn', text: 'rate_limited' }, 0)).toEqual({ type: 'notice', level: 'warn', text: 'rate_limited' });
    expect(s.apply({ t: 'pos', x: 'a' }, 0)).toBeNull();
    expect(s.apply({ t: 'desconhecida' }, 0)).toBeNull();
    expect(s.apply('lixo', 0)).toBeNull();
  });

  it('like.update e minimap', () => {
    const s = new CityState();
    s.apply({ t: 'area', chunk: 'c:0,0', rev: 1, buildings: [building('a', 3, 0)] }, 0);
    s.apply({ t: 'like.update', buildingId: 'a', likes: 40, likedByMe: true }, 0);
    expect(s.buildings.get('a')).toMatchObject({ likes: 40, likedByMe: true });
    const v = s.minimapVersion;
    s.apply({ t: 'minimap', blocks: [{ x: 1.7, y: -1, lit: 3 }, { x: 'x' }] }, 0);
    expect(s.minimap).toEqual([{ x: 1, y: -1, lit: 3 }]);
    expect(s.minimapVersion).toBe(v + 1);
  });
});
