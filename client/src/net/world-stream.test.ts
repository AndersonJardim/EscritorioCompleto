// O stream da cena Mundo no navegador (world-stream.ts): o SSE de mentira (o Node não tem EventSource), os lotes de
// comandos a cada 200 ms com só o último move, a espera do 429, a reconexão; e a cidade falsa do modo demonstração,
// determinística (o mesmo relógio dá a mesma cidade), com todo mundo em lugar caminhável.
import { describe, expect, it } from 'vitest';
import type { WorldSceneCommand } from '../../../shared/world/api';
import { blockAt, chunkId, chunkOf, chunksAround, isWalkable } from '../../../shared/world/city';
import { SceneState } from '../../../shared/world/scene';
import type { EventSourceLike } from './store';
import {
  CMD_BATCH_MS,
  createWorldStream,
  enqueueCommands,
  fakeCityBuildings,
  FakeWorldStream,
  HttpWorldStream,
  loopPosition,
  type WorldStreamEvent,
} from './world-stream';

class FakeES implements EventSourceLike {
  readyState = 0;
  closed = false;
  private readonly handlers = new Map<string, Array<(ev: Event) => void>>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (ev: Event) => void): void {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type)!.push(listener);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  fire(type: string, data?: unknown): void {
    const ev = { data: data === undefined ? undefined : JSON.stringify(data) } as unknown as Event;
    for (const h of this.handlers.get(type) ?? []) h(ev);
  }
}

/** Relógio e timers à mão. */
function clock() {
  let t = 1_000;
  let seq = 0;
  const timers = new Map<number, { at: number; cb: () => void }>();
  return {
    now: () => t,
    setTimeout: (cb: () => void, ms: number) => {
      const id = ++seq;
      timers.set(id, { at: t + ms, cb });
      return id;
    },
    clearTimeout: (id: unknown) => void timers.delete(id as number),
    async advance(ms: number) {
      const until = t + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > until) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].cb();
        await new Promise((ok) => setTimeout(ok, 0));
      }
      t = until;
      await new Promise((ok) => setTimeout(ok, 0));
    },
    pending: () => timers.size,
  };
}

function httpSetup(replies: Array<{ status: number; body?: unknown }> = []) {
  const c = clock();
  const sources: FakeES[] = [];
  const posts: Array<{ url: string; body: any }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    posts.push({ url, body: JSON.parse(String(init?.body)) });
    const r = replies.shift() ?? { status: 202, body: { sent: 1 } };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  }) as unknown as typeof fetch;
  const ws = new HttpWorldStream({
    eventSource: (url) => {
      const es = new FakeES(url);
      sources.push(es);
      return es;
    },
    fetch: fetchImpl,
    setTimeout: c.setTimeout,
    clearTimeout: c.clearTimeout,
    now: c.now,
  });
  const events: WorldStreamEvent[] = [];
  ws.on((e) => events.push(e));
  const snap = (stream = 'st1') => ({ stream, connected: true, viewing: true, afk: false, chunks: [], players: [], minimap: null });
  return { c, ws, sources, posts, events, snap };
}

const move = (x: number): WorldSceneCommand => ({ t: 'move', x, y: 15, dir: 'e', moving: true });

describe('enqueueCommands', () => {
  it('o último move substitui os outros; o resto fica até o teto, saindo os mais velhos', () => {
    expect(enqueueCommands([move(1), { t: 'like', buildingId: 'b' }], [move(2)])).toEqual([{ t: 'like', buildingId: 'b' }, move(2)]);
    const many = Array.from({ length: 30 }, (_, i) => ({ t: 'profile' as const, playerId: `p${i}` }));
    const q = enqueueCommands([], [...many, move(3)]);
    expect(q).toHaveLength(20);
    expect(q[0]).toEqual({ t: 'profile', playerId: 'p11' });
    expect(q.at(-1)).toEqual(move(3));
  });
});

describe('HttpWorldStream', () => {
  it('abre /api/world/stream; snapshot e mensagens da cena viram eventos; o que não é da cena fica', () => {
    const { sources, events, snap } = httpSetup();
    expect(sources[0]?.url).toBe('/api/world/stream');
    sources[0]!.fire('world.snapshot', snap());
    sources[0]!.fire('world', { t: 'pos', x: 21, y: 15 });
    sources[0]!.fire('world', { t: 'uplink.ack', at: 1 });
    sources[0]!.fire('world', 'torto');
    expect(events).toEqual([
      { type: 'status', status: 'open' },
      { type: 'snapshot', snapshot: snap() },
      { type: 'message', msg: { t: 'pos', x: 21, y: 15 } },
    ]);
  });

  it('comandos em lotes: um a cada 200 ms, com o id do stream, só o último move; nada antes do snapshot', async () => {
    const { c, ws, sources, posts, snap } = httpSetup();
    ws.send([move(1)]);
    await c.advance(1_000);
    expect(posts).toEqual([]);
    sources[0]!.fire('world.snapshot', snap('abc'));
    await c.advance(0);
    expect(posts).toEqual([{ url: '/api/world/cmd', body: { stream: 'abc', cmds: [move(1)] } }]);
    ws.send([move(2)]);
    ws.send([{ t: 'profile', playerId: 'p1' }, move(3)]);
    await c.advance(CMD_BATCH_MS - 1);
    expect(posts).toHaveLength(1);
    await c.advance(1);
    expect(posts[1]?.body).toEqual({ stream: 'abc', cmds: [{ t: 'profile', playerId: 'p1' }, move(3)] });
  });

  it('429: o lote volta para a fila e espera o Retry-After; outros erros viram evento', async () => {
    const { c, ws, sources, posts, events, snap } = httpSetup([
      { status: 429, body: { error: { code: 'rate_limited', retryAfter: 1 } } },
      { status: 202 },
      { status: 409, body: { error: { code: 'not_connected' } } },
    ]);
    sources[0]!.fire('world.snapshot', snap());
    ws.send([move(1)]);
    await c.advance(0);
    expect(posts).toHaveLength(1);
    ws.send([{ t: 'like', buildingId: 'b1' }]);
    await c.advance(999);
    expect(posts).toHaveLength(1);
    await c.advance(1);
    expect(posts[1]?.body.cmds).toEqual([move(1), { t: 'like', buildingId: 'b1' }]);
    ws.send([move(5)]);
    await c.advance(CMD_BATCH_MS);
    expect(events.at(-1)).toEqual({ type: 'error', code: 'not_connected' });
  });

  it('o navegador desistiu do stream (fechado): reabre com espera crescente; o snapshot novo traz outro id', async () => {
    const { c, ws, sources, posts, events, snap } = httpSetup();
    sources[0]!.fire('world.snapshot', snap('s1'));
    sources[0]!.readyState = 2;
    sources[0]!.fire('error');
    expect(events.at(-1)).toEqual({ type: 'status', status: 'retrying' });
    ws.send([move(1)]);
    await c.advance(1_999);
    expect(sources).toHaveLength(1);
    await c.advance(1);
    expect(sources).toHaveLength(2);
    expect(posts).toEqual([]);
    sources[1]!.fire('world.snapshot', snap('s2'));
    await c.advance(0);
    expect(posts[0]?.body.stream).toBe('s2');
    // Ainda conectando (o próprio navegador tenta): só o status muda.
    sources[1]!.fire('error');
    expect(events.at(-1)).toEqual({ type: 'status', status: 'connecting' });
    ws.close();
    expect(sources[1]!.closed).toBe(true);
    expect(c.pending()).toBe(0);
  });
});

describe('FakeWorldStream (modo demonstração)', () => {
  const district = 'centro';
  const around = new Set(chunksAround(chunkOf(blockAt(21, 15))).map((ch) => chunkId(district, ch)));

  it('20 prédios espalhados pela espiral, todos nos 3×3 chunks em volta do nascimento, sem repetir lote', () => {
    const b = fakeCityBuildings();
    expect(b).toHaveLength(20);
    expect(new Set(b.map((x) => `${x.lot.x},${x.lot.y}`)).size).toBe(20);
    const s = new FakeWorldStream({ autoplay: false, now: () => 0 }).snapshot();
    expect(s.chunks.reduce((n, c) => n + c.buildings.length, 0)).toBe(20);
    for (const c of s.chunks) expect(around.has(c.chunk), c.chunk).toBe(true);
    expect(s.me?.id).toBeTruthy();
    expect(s.pos).toEqual({ x: 21, y: 15, dir: 's', moving: false });
    expect(s.players).toHaveLength(5);
    expect(s.minimap?.reduce((n, m) => n + m.lit, 0)).toBe(b.filter((x) => x.state === 'online').length);
    // Os nomes do modo demonstração são apelidos de mentira, nunca o de quem usa.
    expect(b.every((x) => / /.test(x.owner.name))).toBe(true);
  });

  it('determinístico: o mesmo relógio dá a mesma cidade e os mesmos passos', () => {
    const run = () => {
      let t = 0;
      const f = new FakeWorldStream({ autoplay: false, now: () => t });
      const out: unknown[] = [];
      f.on((e) => e.type === 'message' && out.push(e.msg));
      for (let i = 0; i < 40; i++) {
        t += 200;
        f.tick();
      }
      return { snap: f.snapshot(), out };
    };
    expect(run()).toEqual(run());
  });

  it('os 5 andam em volta dos quarteirões, sempre em lugar caminhável e nos chunks da vista; o estado acompanha sem resync', async () => {
    let t = 0;
    const f = new FakeWorldStream({ autoplay: false, now: () => t });
    let state: SceneState | undefined;
    let resyncs = 0;
    f.on((e) => {
      if (e.type === 'snapshot') state = SceneState.fromSnapshot(e.snapshot);
      if (e.type === 'message' && state && state.apply(e.msg as unknown as Record<string, unknown>).resync) resyncs++;
    });
    await Promise.resolve();
    expect(state).toBeDefined();
    const seen = new Map<string, number>();
    for (let i = 0; i < 400; i++) {
      t += 200;
      f.tick();
      for (const p of f.snapshot().players) {
        expect(isWalkable(p.pos.x, p.pos.y, () => true), `${p.id} em ${p.pos.x},${p.pos.y}`).toBe(true);
        expect(around.has(chunkId(district, chunkOf(blockAt(p.pos.x, p.pos.y))))).toBe(true);
        seen.set(p.id, (seen.get(p.id) ?? 0) + 1);
      }
    }
    expect(resyncs).toBe(0);
    expect(state!.player('p_1')?.pos).toEqual(f.snapshot().players[0]?.pos);
    // A cada 3 s um prédio muda (area.patch com rev + 1), e o estado aplicado bate com o do falso.
    const fromFake = f.snapshot().chunks.map((c) => [c.chunk, c.rev]);
    expect(fromFake.map(([c]) => [c, state!.chunkRev(c as string)])).toEqual(fromFake);
    // Dá a volta: depois de 80 s ninguém está onde começou.
    for (const [i, p] of f.snapshot().players.entries()) expect(p.pos).not.toEqual(new FakeWorldStream({ autoplay: false, now: () => 0 }).snapshot().players[i]?.pos);
  });

  it('loopPosition: a volta inteira fecha no mesmo ponto, nos dois sentidos', () => {
    const b = { x: 1, y: 0 };
    const len = 2 * (44 + 26);
    expect(loopPosition(b, 0, true)).toMatchObject({ x: 50, y: -1, dir: 'e' });
    expect(loopPosition(b, len, true)).toMatchObject({ x: 50, y: -1 });
    expect(loopPosition(b, 1, false)).toMatchObject({ x: 50, y: 0, dir: 's' });
  });

  it('comandos: move para lote ou longe demais volta como pos; profile, like e resync respondem no passo seguinte', async () => {
    let t = 0;
    const f = new FakeWorldStream({ autoplay: false, now: () => t });
    const msgs: any[] = [];
    f.on((e) => e.type === 'message' && msgs.push(e.msg));
    await Promise.resolve();
    f.send([{ t: 'move', x: 22, y: 15, dir: 'e', moving: true }]);
    f.send([{ t: 'move', x: 60, y: 5, dir: 'e', moving: true }]); // dentro de um lote
    f.send([{ t: 'profile', playerId: 'p_2' }, { t: 'profile', playerId: 'ninguem' }, { t: 'like', buildingId: 'b_01' }, { t: 'resync', chunk: 'centro:0,0' }]);
    expect(msgs).toEqual([]);
    t += 200;
    f.tick();
    const types = msgs.map((m) => m.t);
    expect(types.slice(0, 5)).toEqual(['pos', 'profile', 'notice', 'like.update', 'area']);
    expect(msgs[0]).toEqual({ t: 'pos', x: 22, y: 15 });
    expect(msgs[1].player.id).toBe('p_2');
    expect(msgs[2]).toEqual({ t: 'notice', level: 'info', text: 'not_found' });
    expect(msgs[3]).toMatchObject({ buildingId: 'b_01', likedByMe: true });
    expect(msgs[4].chunk).toBe('centro:0,0');
  });

  it('createWorldStream: mock dá a cidade falsa; close para tudo', async () => {
    const ws = createWorldStream({ mock: true, autoplay: false });
    expect(ws).toBeInstanceOf(FakeWorldStream);
    const evs: WorldStreamEvent[] = [];
    ws.on((e) => evs.push(e));
    ws.close();
    await Promise.resolve();
    expect(evs).toEqual([{ type: 'status', status: 'closed' }]);
  });
});
