// O estado da cena Mundo (scene.ts): rev por chunk, resync no salto, mescla e substituição dos prédios, jogadores por
// id, a minha posição (pos, players com o meu id, move), os chunks fora dos 3×3 e os comandos refeitos campo a campo.
import { describe, expect, it } from 'vitest';
import type { WorldBuildingPublic } from './protocol';
import { parseSceneCommand, reduceSceneBatch, RESYNC_GAP_MS, SceneState } from './scene';

const ME = 'acc_me';
const WELCOME = {
  t: 'welcome',
  me: { id: ME, name: 'Ana Pixel', look: 'f', parts: { skin: '#e8b48c' }, traits: ['games', 'cafeina'], intro: 'coffee', visibility: { mode: 'live' }, updatedAt: 'x' },
  building: { id: ME },
  city: { districts: ['centro'], lotSize: { w: 14, h: 12 }, blockSize: { w: 3, h: 2 } },
};

function building(id: string, extra: Partial<WorldBuildingPublic> = {}): WorldBuildingPublic {
  return {
    id,
    lot: { district: 'centro', x: 3, y: 0 },
    owner: { id, name: `Dono ${id}` },
    state: 'online',
    theme: 'none',
    floors: 2,
    agents: { total: 3, working: 2, waiting: 1, idle: 0 },
    tokens: { day: 2, week: 3 },
    rev: 1,
    likes: 0,
    sinceMonth: '2026-10',
    ...extra,
  };
}

function player(id: string, x = 21, y = 15) {
  return { id, name: `P ${id}`, look: 'm', parts: {}, traits: ['games', 'cafeina'], likesReceived: 0, pos: { x, y, dir: 's', moving: false }, where: 'street' };
}

function fresh(now = { t: 0 }) {
  const s = new SceneState(() => now.t);
  s.welcome(WELCOME);
  return { s, now };
}

describe('SceneState: prédios por chunk', () => {
  it('area substitui o chunk e o rev (mesmo menor); patch só com rev + 1', () => {
    const { s } = fresh();
    expect(s.apply({ t: 'area', chunk: 'centro:0,0', rev: 7, buildings: [building('b1')] })).toEqual({ forward: true });
    expect(s.chunkRev('centro:0,0')).toBe(7);
    expect(s.apply({ t: 'area.patch', chunk: 'centro:0,0', rev: 8, changes: [{ id: 'b1', likes: 5 }] })).toEqual({ forward: true });
    expect(s.building('b1')).toMatchObject({ likes: 5, floors: 2, agents: { total: 3 } });
    // Repetido ou velho: ignorado, sem resync.
    expect(s.apply({ t: 'area.patch', chunk: 'centro:0,0', rev: 8, changes: [{ id: 'b1', likes: 99 }] })).toEqual({ forward: false });
    expect(s.building('b1')?.likes).toBe(5);
    // O servidor reiniciou: a área volta com rev menor e vale.
    expect(s.apply({ t: 'area', chunk: 'centro:0,0', rev: 1, buildings: [] })).toEqual({ forward: true });
    expect(s.chunkRev('centro:0,0')).toBe(1);
    expect(s.building('b1')).toBeUndefined();
  });

  it('salto de rev: pede resync uma vez (a cada 5 s), não repassa, e a area seguinte resolve', () => {
    const { s, now } = fresh();
    s.apply({ t: 'area', chunk: 'centro:0,0', rev: 3, buildings: [building('b1')] });
    expect(s.apply({ t: 'area.patch', chunk: 'centro:0,0', rev: 5, changes: [{ id: 'b1', likes: 1 }] })).toEqual({ forward: false, resync: 'centro:0,0' });
    expect(s.apply({ t: 'area.patch', chunk: 'centro:0,0', rev: 6, changes: [] })).toEqual({ forward: false });
    expect(s.building('b1')?.likes).toBe(0);
    now.t += RESYNC_GAP_MS;
    expect(s.apply({ t: 'area.patch', chunk: 'centro:0,0', rev: 7, changes: [] })).toEqual({ forward: false, resync: 'centro:0,0' });
    expect(s.apply({ t: 'area', chunk: 'centro:0,0', rev: 7, buildings: [building('b1', { likes: 4 })] }).forward).toBe(true);
    expect(s.apply({ t: 'area.patch', chunk: 'centro:0,0', rev: 8, changes: [{ id: 'b1', likes: 5 }] })).toEqual({ forward: true });
    // Depois da area, um salto novo pede de novo na hora.
    expect(s.apply({ t: 'area.patch', chunk: 'centro:0,0', rev: 10, changes: [] }).resync).toBe('centro:0,0');
  });

  it('patch de chunk que não está aqui ou item parcial de prédio desconhecido: resync', () => {
    const { s } = fresh();
    expect(s.apply({ t: 'area.patch', chunk: 'centro:1,0', rev: 2, changes: [] })).toEqual({ forward: false, resync: 'centro:1,0' });
    s.apply({ t: 'area', chunk: 'centro:0,0', rev: 1, buildings: [] });
    expect(s.apply({ t: 'area.patch', chunk: 'centro:0,0', rev: 2, changes: [{ id: 'bX', likes: 1 }] })).toEqual({ forward: false, resync: 'centro:0,0' });
    expect(s.chunkRev('centro:0,0')).toBe(1);
  });

  it('item com lot substitui o prédio inteiro (o modo discreto apaga agents e tokens); sem lot mescla; removed tira', () => {
    const { s } = fresh();
    s.apply({ t: 'area', chunk: 'centro:0,0', rev: 1, buildings: [building('b1'), building('b2')] });
    const discreet = building('b1', { floors: 4 });
    delete discreet.agents;
    delete discreet.tokens;
    expect(s.apply({ t: 'area.patch', chunk: 'centro:0,0', rev: 2, changes: [discreet, { id: 'b2', state: 'away' }], removed: [] }).forward).toBe(true);
    expect(s.building('b1')).not.toHaveProperty('agents');
    expect(s.building('b1')).not.toHaveProperty('tokens');
    expect(s.building('b1')?.floors).toBe(4);
    expect(s.building('b2')).toMatchObject({ state: 'away', agents: { total: 3 } });
    expect(s.apply({ t: 'area.patch', chunk: 'centro:0,0', rev: 3, changes: [building('b3')], removed: ['b2'] }).forward).toBe(true);
    expect(s.building('b2')).toBeUndefined();
    expect(s.building('b3')).toBeDefined();
    // Bloqueio do lado do servidor: rev sobe com changes vazio, sem salto.
    expect(s.apply({ t: 'area.patch', chunk: 'centro:0,0', rev: 4, changes: [] })).toEqual({ forward: true });
  });

  it('like.update mexe no prédio de qualquer chunk guardado', () => {
    const { s } = fresh();
    s.apply({ t: 'area', chunk: 'centro:0,0', rev: 1, buildings: [building('b1')] });
    expect(s.apply({ t: 'like.update', buildingId: 'b1', likes: 3, likedByMe: true }).forward).toBe(true);
    expect(s.building('b1')).toMatchObject({ likes: 3, likedByMe: true });
  });
});

describe('SceneState: chunks fora da vista e a minha posição', () => {
  it('ficam só os 3×3 chunks em volta da posição (pos, players com o meu id e o meu move)', () => {
    const { s } = fresh();
    for (const c of ['centro:0,0', 'centro:1,0', 'centro:2,0', 'centro:-1,-1', 'centro:3,3']) s.apply({ t: 'area', chunk: c, rev: 1, buildings: [] });
    // Nascimento na praça: chunk (0,0); ficam os vizinhos.
    expect(s.apply({ t: 'pos', x: 21, y: 15 })).toEqual({ forward: true });
    expect(s.pos).toEqual({ x: 21, y: 15, dir: 's', moving: false });
    expect(s.chunkIds).toEqual(['centro:-1,-1', 'centro:0,0', 'centro:1,0']);
    // Andando para leste (o quarteirão 4 já é do chunk 2): o chunk -1,-1 sai.
    s.apply({ t: 'area', chunk: 'centro:2,0', rev: 1, buildings: [] });
    s.noteCommand({ t: 'move', x: 4 * 51 + 1, y: 15, dir: 'e', moving: true });
    expect(s.chunkIds).toEqual(['centro:1,0', 'centro:2,0']);
    // O servidor manda o meu próprio id num players: é a posição validada.
    s.apply({ t: 'players', chunk: 'centro:0,0', players: [{ id: ME, pos: { x: 30, y: 10, dir: 'w', moving: false } }] });
    expect(s.pos).toEqual({ x: 30, y: 10, dir: 'w', moving: false });
    expect(s.chunkIds).toEqual(['centro:1,0']);
  });

  it('afk vale até andar ou virar, view ou profile (o move parado igual não conta)', () => {
    const { s } = fresh();
    s.apply({ t: 'pos', x: 21, y: 15 });
    expect(s.apply({ t: 'afk' }).forward).toBe(true);
    expect(s.afk).toBe(true);
    s.noteCommand({ t: 'move', x: 21, y: 15, dir: 's', moving: false });
    expect(s.afk).toBe(true);
    s.noteCommand({ t: 'move', x: 21, y: 15, dir: 'n', moving: false });
    expect(s.afk).toBe(false);
    s.apply({ t: 'afk' });
    s.noteCommand({ t: 'profile', playerId: 'p1' });
    expect(s.afk).toBe(false);
  });
});

describe('SceneState: jogadores', () => {
  it('join entra (e substitui o perfil), players só mexe em quem já está, leave tira; o meu id nunca vira jogador', () => {
    const { s } = fresh();
    expect(s.apply({ t: 'player.join', player: player('p1') }).forward).toBe(true);
    expect(s.apply({ t: 'player.join', player: player(ME) })).toEqual({ forward: false });
    expect(s.apply({ t: 'players', chunk: 'centro:0,0', players: [{ id: 'p1', pos: { x: 22, y: 15, dir: 'e', moving: true } }, { id: 'p9', pos: { x: 1, y: 1, dir: 's', moving: false } }] }).forward).toBe(true);
    expect(s.player('p1')?.pos).toEqual({ x: 22, y: 15, dir: 'e', moving: true });
    expect(s.player('p9')).toBeUndefined();
    expect(s.apply({ t: 'player.join', player: { ...player('p1', 23, 15), name: 'Novo nome' } }).forward).toBe(true);
    expect(s.player('p1')).toMatchObject({ name: 'Novo nome', pos: { x: 23 } });
    s.apply({ t: 'greeting', from: 'p1', to: ME, greetingId: 'wave', until: 99 });
    expect(s.player('p1')?.greeting).toEqual({ id: 'wave', until: 99 });
    expect(s.apply({ t: 'player.leave', id: 'p1' }).forward).toBe(true);
    expect(s.playerIds).toEqual([]);
  });

  it('o que não é da cena não passa; aviso, interior e perfil passam', () => {
    const { s } = fresh();
    for (const t of ['welcome', 'goodbye', 'uplink.ack', 'ping', 'pong', 'qualquer']) expect(s.apply({ t }).forward, t).toBe(false);
    expect(s.apply({ t: 'notice', level: 'warn', text: 'rate_limited' }).forward).toBe(true);
    expect(s.apply({ t: 'profile', player: player('p2') }).forward).toBe(true);
    expect(s.apply({ t: 'building', rev: 1, detail: {} }).forward).toBe(true);
    expect(s.apply({ t: 'minimap', blocks: [{ x: 1, y: 0, lit: 2 }, { x: 'a' }] }).forward).toBe(true);
    expect(s.minimap).toEqual([{ x: 1, y: 0, lit: 2 }]);
  });

  it('snapshot e fromSnapshot: cópia completa e independente', () => {
    const { s } = fresh();
    s.apply({ t: 'area', chunk: 'centro:0,0', rev: 2, buildings: [building('b1')] });
    s.apply({ t: 'player.join', player: player('p1') });
    s.apply({ t: 'pos', x: 21, y: 15 });
    const snap = { stream: 'x', connected: true, viewing: true, ...s.snapshot() };
    expect(snap).toMatchObject({ district: 'centro', me: { id: ME, name: 'Ana Pixel', buildingId: ME }, afk: false, minimap: null });
    expect(snap.me).not.toHaveProperty('visibility');
    const copy = SceneState.fromSnapshot(snap);
    expect(copy.apply({ t: 'area.patch', chunk: 'centro:0,0', rev: 3, changes: [{ id: 'b1', likes: 9 }] }).forward).toBe(true);
    expect(copy.building('b1')?.likes).toBe(9);
    expect(s.building('b1')?.likes).toBe(0);
    expect(snap.chunks[0]?.buildings[0]?.likes).toBe(0);
  });
});

describe('comandos da cena', () => {
  it('refeitos campo a campo; o que não é da cena (hello, uplink, ping) ou está torto vira null', () => {
    expect(parseSceneCommand({ t: 'move', x: 1.5, y: -2, dir: 'n', moving: true, token: 'segredo' })).toEqual({ t: 'move', x: 1.5, y: -2, dir: 'n', moving: true });
    expect(parseSceneCommand({ t: 'view', extra: 1 })).toEqual({ t: 'view' });
    expect(parseSceneCommand({ t: 'view.off' })).toEqual({ t: 'view.off' });
    expect(parseSceneCommand({ t: 'resync' })).toEqual({ t: 'resync' });
    expect(parseSceneCommand({ t: 'resync', chunk: 'centro:0,0' })).toEqual({ t: 'resync', chunk: 'centro:0,0' });
    expect(parseSceneCommand({ t: 'profile', playerId: 'p1' })).toEqual({ t: 'profile', playerId: 'p1' });
    expect(parseSceneCommand({ t: 'greet', playerId: 'p1', greetingId: 'wave' })).toEqual({ t: 'greet', playerId: 'p1', greetingId: 'wave' });
    expect(parseSceneCommand({ t: 'report', playerId: 'p1', reason: 'harassment', text: 'livre' })).toEqual({ t: 'report', playerId: 'p1', reason: 'harassment' });
    for (const t of ['like', 'unlike', 'enter'] as const) expect(parseSceneCommand({ t, buildingId: 'b1' })).toEqual({ t, buildingId: 'b1' });
    for (const t of ['block', 'unblock'] as const) expect(parseSceneCommand({ t, playerId: 'p1' })).toEqual({ t, playerId: 'p1' });
    expect(parseSceneCommand({ t: 'leave' })).toEqual({ t: 'leave' });
    const bad = [
      { t: 'hello', v: 1, token: 'x' },
      { t: 'uplink', uplink: {} },
      { t: 'ping' },
      { t: 'pong' },
      { t: 'move', x: Number.NaN, y: 0, dir: 'n', moving: true },
      { t: 'move', x: 2e6, y: 0, dir: 'n', moving: true },
      { t: 'move', x: 0, y: 0, dir: 'up', moving: true },
      { t: 'move', x: 0, y: 0, dir: 'n' },
      { t: 'greet', playerId: 'p1', greetingId: 'texto livre' },
      { t: 'report', playerId: 'p1', reason: 'raiva' },
      { t: 'profile', playerId: '' },
      { t: 'profile', playerId: 'com espaço' },
      { t: 'resync', chunk: 'x'.repeat(65) },
      null,
      [],
      'move',
    ];
    for (const b of bad) expect(parseSceneCommand(b), JSON.stringify(b)).toBeNull();
  });

  it('de um lote, só o último move vai, no lugar dele', () => {
    const m = (x: number) => ({ t: 'move' as const, x, y: 0, dir: 'e' as const, moving: true });
    expect(reduceSceneBatch([m(1), { t: 'like', buildingId: 'b' }, m(2), { t: 'profile', playerId: 'p' }, m(3)])).toEqual([
      { t: 'like', buildingId: 'b' },
      { t: 'profile', playerId: 'p' },
      m(3),
    ]);
    expect(reduceSceneBatch([m(1), { t: 'view' }])).toEqual([m(1), { t: 'view' }]);
  });
});

describe('social leve (Fase 5)', () => {
  it('comandos novos refeitos campo a campo: carimbo da lista, código só no formato, bater na porta, resumo visto', () => {
    expect(parseSceneCommand({ t: 'stamp', buildingId: 'b1', stampId: 'rocket', x: 1 })).toEqual({ t: 'stamp', buildingId: 'b1', stampId: 'rocket' });
    expect(parseSceneCommand({ t: 'teleport' })).toEqual({ t: 'teleport' });
    expect(parseSceneCommand({ t: 'teleport', code: 'hb-4f2k' })).toEqual({ t: 'teleport', code: 'hb-4f2k' });
    expect(parseSceneCommand({ t: 'knock', buildingId: 'b1' })).toEqual({ t: 'knock', buildingId: 'b1' });
    expect(parseSceneCommand({ t: 'summary.seen', since: 'x' })).toEqual({ t: 'summary.seen' });
    for (const b of [
      { t: 'stamp', buildingId: 'b1', stampId: 'texto livre' },
      { t: 'stamp', stampId: 'star' },
      { t: 'teleport', code: 'HB-4F2K-MUITO-LONGO-DEMAIS' },
      { t: 'teleport', code: '<script>' },
      { t: 'teleport', code: 7 },
      { t: 'knock', buildingId: '' },
    ]) expect(parseSceneCommand(b), JSON.stringify(b)).toBeNull();
  });

  it('city fica guardado e vai no snapshot (campo a campo); fogos passam; o que está torto não', () => {
    const { s } = fresh();
    const city = { t: 'city', lit: 42, goal: { id: '2026-10-12:agent_hours_10k', label: 'agent_hours_10k', target: 10000, progress: 8000, until: 1 }, tokensBand: 4, extra: 'x' };
    expect(s.apply(city)).toEqual({ forward: true });
    expect(s.snapshot().city).toEqual({ lit: 42, goal: { id: '2026-10-12:agent_hours_10k', label: 'agent_hours_10k', target: 10000, progress: 8000, until: 1 }, tokensBand: 4 });
    // meta de id desconhecido ou faixa fora de 0..5: só o que vale fica
    expect(s.apply({ t: 'city', lit: 3, goal: { id: 'x', label: 'agent_hours_1', target: 1, progress: 0, until: 0 }, tokensBand: 9 })).toEqual({ forward: true });
    expect(s.city).toEqual({ lit: 3 });
    expect(s.apply({ t: 'city', lit: -1 }).forward).toBe(false);
    expect(s.apply({ t: 'city.fireworks', goalId: '2026-10-12:agent_hours_10k' }).forward).toBe(true);
    expect(s.apply({ t: 'city.fireworks' }).forward).toBe(false);
    // ao desligar a cidade (clear), o city some: o servidor manda outro ao abrir de novo
    s.clear();
    expect(s.snapshot().city).toBeUndefined();
  });

  it('likes do dia e resumo: guardados até a próxima conexão; summary.seen tira o resumo; knock passa', () => {
    const { s } = fresh();
    expect(s.apply({ t: 'likes.today', count: 3 })).toEqual({ forward: true });
    expect(s.apply({ t: 'likes.today', count: -2 }).forward).toBe(false);
    const sum = { t: 'away.summary', since: '2026-10-14', visits: 5, likes: 12, stamps: [{ stampId: 'star', count: 2 }, { stampId: 'xx', count: 1 }, { stampId: 'star', count: 9 }] };
    expect(s.apply(sum)).toEqual({ forward: true });
    expect(s.snapshot()).toMatchObject({ likesToday: 3, summary: { since: '2026-10-14', visits: 5, likes: 12, stamps: [{ stampId: 'star', count: 2 }] } });
    expect(s.apply({ t: 'away.summary', since: 'ontem', visits: 1, likes: 0, stamps: [] }).forward).toBe(false);
    expect(s.apply({ t: 'knock' })).toEqual({ forward: true });
    s.clear();
    expect(s.likesToday).toBe(3);
    s.noteCommand({ t: 'summary.seen' });
    expect(s.summary).toBeUndefined();
    s.apply({ t: 'away.summary', since: '2026-10-14', visits: 1, likes: 0, stamps: [] });
    s.welcome(WELCOME);
    expect(s.likesToday).toBeUndefined();
    expect(s.summary).toBeUndefined();
  });

  it('curtir, cumprimentar, carimbar, bater e ir até um prédio tiram o afk', () => {
    const { s } = fresh();
    for (const cmd of [{ t: 'like', buildingId: 'b' }, { t: 'greet', playerId: 'p', greetingId: 'wave' }, { t: 'stamp', buildingId: 'b', stampId: 'star' }, { t: 'knock', buildingId: 'b' }, { t: 'teleport' }] as const) {
      s.apply({ t: 'afk' });
      s.noteCommand(cmd);
      expect(s.afk, cmd.t).toBe(false);
    }
  });
});
