// Jogadores: interpolação dos outros (150 ms atrás), movimento local com colisão pelo isWalkable, velocidade
// nunca acima da de corrida (nem na diagonal), caminho do clique e o envio de `move` até 10 por segundo.
import { describe, expect, it } from 'vitest';
import { isWalkable, lotOrigin, spawnPoint } from '../../../../shared/world/city';
import { DIR_TO_PROTO, LocalPlayer, MOVE_INTERVAL_MS, MoveSender, PROTO_TO_DIR, RUN_TPS, WALK_TPS, dirOf, pathPoints, pushSample, sampleAt, stepMove, type Sample } from './players';

const s = (t: number, x: number, y: number, moving = true): Sample => ({ t, x, y, dir: 'e', moving });

describe('interpolação dos outros jogadores', () => {
  it('fica entre as duas amostras que cercam o instante', () => {
    const list = [s(0, 0, 0), s(200, 2, 0), s(400, 4, 1)];
    expect(sampleAt(list, 100)).toMatchObject({ x: 1, y: 0, moving: true });
    expect(sampleAt(list, 300)).toMatchObject({ x: 3, y: 0.5 });
    expect(sampleAt(list, 300)!.speed).toBeCloseTo((Math.hypot(2, 1) * 1000) / 200);
  });

  it('antes da primeira, a primeira; depois da última, a última (e para quando a amostra fica velha)', () => {
    const list = [s(100, 1, 1), s(300, 2, 1)];
    expect(sampleAt(list, 0)).toMatchObject({ x: 1, y: 1 });
    expect(sampleAt(list, 350)).toMatchObject({ x: 2, y: 1, moving: true });
    expect(sampleAt(list, 900)).toMatchObject({ x: 2, y: 1, moving: false });
    expect(sampleAt([], 0)).toBeNull();
  });

  it('as amostras ficam em ordem de tempo e com limite', () => {
    const list: Sample[] = [];
    for (let i = 0; i < 30; i++) pushSample(list, s(i * 10, i, 0));
    expect(list.length).toBe(10);
    pushSample(list, s(5, 99, 0));
    expect(list[list.length - 1]!.t).toBe(290);
  });
});

describe('movimento local', () => {
  it('não entra num lote e desliza pela borda', () => {
    const o = lotOrigin({ x: 3, y: 0 });
    // na calçada norte, logo acima do lote, andando para baixo e para a direita: só o x muda
    const r = stepMove(o.x + 3.5, o.y - 0.2, 0.5, 0.5);
    expect(r.blocked).toBe(true);
    expect(r.x).toBeCloseTo(o.x + 4);
    expect(r.y).toBeLessThan(o.y);
    expect(isWalkable(r.x, r.y, () => true)).toBe(true);
  });

  it('passos grandes não atravessam o lote', () => {
    const o = lotOrigin({ x: 3, y: 0 });
    const r = stepMove(o.x + 3.5, o.y - 0.5, 0, 30);
    expect(r.y).toBeLessThan(o.y);
  });

  it('andando e correndo na diagonal, nunca acima da velocidade de corrida (o servidor aceita até 7,2 tiles/s)', () => {
    const p = new LocalPlayer(spawnPoint().x + 0.5, spawnPoint().y + 0.5);
    const x0 = p.x;
    const y0 = p.y;
    for (let i = 0; i < 10; i++) p.update(0.05, { dx: 1, dy: 1, run: true });
    const d = Math.hypot(p.x - x0, p.y - y0);
    expect(d).toBeLessThanOrEqual(RUN_TPS * 0.5 + 1e-6);
    expect(d).toBeGreaterThan(RUN_TPS * 0.5 * 0.9);
    expect(p.running).toBe(true);
    const q = new LocalPlayer(spawnPoint().x + 0.5, spawnPoint().y + 0.5);
    q.update(1, { dx: -1, dy: 0, run: false });
    // dt é limitado a 0,1 s por quadro
    expect(spawnPoint().x + 0.5 - q.x).toBeCloseTo(WALK_TPS * 0.1);
    expect(q.dir).toBe('left');
  });

  it('segue o caminho do clique até o fim e senta no banco se pedido', () => {
    const p = new LocalPlayer(21.5, 15.5);
    p.follow([22.5, 15.5, 23.5, 15.5, 23.5, 16.5], false, { x: 23.5, y: 16.5, dir: 'down' });
    for (let i = 0; i < 30 && p.hasPath; i++) p.update(0.1, { dx: 0, dy: 0, run: false });
    expect(p.x).toBeCloseTo(23.5);
    expect(p.y).toBeCloseTo(16.5);
    expect(p.moving).toBe(false);
    expect(p.seat).toEqual({ x: 23.5, y: 16.5, dir: 'down' });
    // uma tecla levanta e cancela
    p.update(0.05, { dx: 0, dy: -1, run: false });
    expect(p.seat).toBeNull();
  });

  it('a correção do servidor (`pos`) vale na hora', () => {
    const p = new LocalPlayer(21.5, 15.5);
    p.follow([30.5, 15.5], true);
    p.correct(10, 10);
    expect([p.x, p.y, p.hasPath]).toEqual([10, 10, false]);
  });

  it('pathPoints: centros dos tiles com o ponto exato do clique no fim', () => {
    expect(pathPoints([1, 0, 1, 1], 10, 20, { x: 11.2, y: 21.8 })).toEqual([11.5, 20.5, 11.2, 21.8]);
    expect(pathPoints([], 0, 0, { x: 1.2, y: 1.3 })).toEqual([1.2, 1.3]);
  });
});

describe('envio de move', () => {
  it('no máximo um a cada 100 ms, só quando muda, e o "parei" sempre sai', () => {
    const sent: { x: number; moving: boolean; dir: string }[] = [];
    const m = new MoveSender((msg) => sent.push(msg));
    expect(m.tick(0, { x: 1, y: 1, dir: 'right', moving: true })).toBe(true);
    expect(m.tick(50, { x: 1.2, y: 1, dir: 'right', moving: true })).toBe(false);
    expect(m.tick(MOVE_INTERVAL_MS, { x: 1.3, y: 1, dir: 'right', moving: true })).toBe(true);
    expect(m.tick(MOVE_INTERVAL_MS * 2, { x: 1.3, y: 1, dir: 'right', moving: true })).toBe(false);
    expect(m.tick(MOVE_INTERVAL_MS * 3, { x: 1.3, y: 1, dir: 'right', moving: false })).toBe(true);
    expect(sent.map((x) => x.moving)).toEqual([true, true, false]);
    expect(sent[0]!.dir).toBe('e');
    // em 1 s andando sem parar, no máximo 10
    const many: unknown[] = [];
    const m2 = new MoveSender((msg) => many.push(msg));
    for (let t = 0; t < 1000; t += 16) m2.tick(t, { x: t / 100, y: 0, dir: 'down', moving: true });
    expect(many.length).toBeLessThanOrEqual(10);
  });

  it('posição em centésimos de tile e direções do protocolo', () => {
    const sent: { x: number; y: number }[] = [];
    new MoveSender((msg) => sent.push(msg)).tick(0, { x: 1.23456, y: -7.891, dir: 'up', moving: false });
    expect(sent[0]).toMatchObject({ x: 1.23, y: -7.89 });
    for (const d of ['up', 'down', 'left', 'right'] as const) expect(PROTO_TO_DIR[DIR_TO_PROTO[d]]).toBe(d);
    expect(dirOf(0, 0, 'left')).toBe('left');
    expect(dirOf(-1, 0.5, 'down')).toBe('left');
    expect(dirOf(0.2, 1, 'down')).toBe('down');
  });
});
