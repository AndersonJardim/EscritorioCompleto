// A cidade de mentira do modo demonstração: 20 prédios na espiral, meu prédio com porta na calçada, jogadores
// sempre em tile caminhável, snapshot que a cena lê e `pos` quando o `move` cai num lote.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isWalkable, lotDoor, lotSpiral } from '../../../../shared/world/city';
import { FAKE_ME, FakeWorldStream } from './fake-stream';
import { CityState } from './state';
import { readCitySnapshot } from './stream';
import { MoveSender } from './players';

afterEach(() => {
  vi.useRealTimers();
});

function take<T>(gen: Iterable<T>, n: number): T[] {
  const out: T[] = [];
  for (const v of gen) {
    if (out.length >= n) break;
    out.push(v);
  }
  return out;
}

describe('FakeWorldStream', () => {
  it('20 prédios nos 20 primeiros lotes da espiral, com temas, estados e o meu', () => {
    const f = new FakeWorldStream();
    try {
      expect(f.buildings).toHaveLength(20);
      expect(f.buildings.map((b) => ({ x: b.lot.x, y: b.lot.y }))).toEqual(take(lotSpiral(), 20));
      expect(new Set(f.buildings.map((b) => b.theme))).toEqual(new Set(['none', 'halloween', 'christmas']));
      expect(f.buildings.some((b) => b.state === 'away')).toBe(true);
      expect(f.buildings.some((b) => !b.agents)).toBe(true);
      expect(f.buildings.some((b) => b.floors > 12)).toBe(true);
      expect(f.myBuilding.owner.id).toBe(FAKE_ME.id);
      expect(isWalkable(lotDoor(f.myBuilding.lot).front.x, lotDoor(f.myBuilding.lot).front.y, () => true)).toBe(true);
    } finally {
      f.close();
    }
  });

  it('o snapshot é lido pela cena: eu, meu prédio, 20 prédios, 6 jogadores em tiles caminháveis', () => {
    const f = new FakeWorldStream();
    try {
      const snap = readCitySnapshot(f.snapshot());
      expect(snap.me?.name).toBe('Pixel Dev');
      expect(snap.building?.id).toBe(f.myBuilding.id);
      expect(snap.areas.reduce((n, a) => n + a.buildings.length, 0)).toBe(20);
      expect(snap.players).toHaveLength(6);
      for (const p of snap.players) expect(isWalkable(p.pos.x, p.pos.y, () => true)).toBe(true);
      expect(isWalkable(snap.pos!.x, snap.pos!.y, () => true)).toBe(true);
      const st = new CityState();
      st.applySnapshot(f.snapshot(), 0);
      expect(st.buildings.size).toBe(20);
    } finally {
      f.close();
    }
  });

  it('jogadores andando só por calçada, a 5 por segundo, e `pos` de volta quando o move cai num lote', () => {
    vi.useFakeTimers();
    let now = 1_000_000;
    const f = new FakeWorldStream({ now: () => now });
    const msgs: { t: string; players?: { pos: { x: number; y: number } }[] }[] = [];
    f.on('world', (m) => msgs.push(m as never));
    try {
      for (let i = 0; i < 50; i++) {
        now += 200;
        vi.advanceTimersByTime(200);
      }
      const ticks = msgs.filter((m) => m.t === 'players');
      expect(ticks.length).toBeGreaterThanOrEqual(45);
      for (const m of ticks) for (const p of m.players!) expect(isWalkable(p.pos.x, p.pos.y, () => true)).toBe(true);
      // rente à borda oeste do lote (x = 51 − 0,004), truncado para o fio: continua na calçada, sem `pos`
      const sent: { t: 'move'; x: number; y: number; dir: 's'; moving: boolean }[] = [];
      new MoveSender((m) => sent.push(m as never)).tick(0, { x: 50.996, y: 5, dir: 'down', moving: false });
      f.send(sent);
      vi.advanceTimersByTime(100);
      expect(msgs.some((m) => m.t === 'pos')).toBe(false);
      expect(isWalkable(55, 5, () => true)).toBe(false);
      f.send([{ t: 'move', x: 55, y: 5, dir: 's', moving: false }]);
      vi.advanceTimersByTime(100);
      expect(msgs.some((m) => m.t === 'pos')).toBe(true);
    } finally {
      f.close();
    }
  });
});
