// A visita a um prédio do mundo no `Sim` de verdade: o snapshot de shared/world/office-from-world.ts tem tudo o que a
// simulação exige (semente, vaga, contas, tempos, listas vazias) e cada agente aparece na sala do andar dele, no
// comportamento do status. Também o modo discreto, o prédio apagado e os patches (status, andar que some, andar novo).
import { describe, expect, it } from 'vitest';
import { applyBuildingPatch, officeFromBuilding } from '../../../../shared/world/office-from-world';
import type { WorldBuildingDetail } from '../../../../shared/world/protocol';
import { sampleBuildingDetail } from '../../../../shared/world/visit-sample';
import type { OfficeSnapshot } from '../../../../shared/types';
import type { Appearance, ArtModule, RoomTheme } from '../../art/api';
import { DEFAULT_WORLD_OPTIONS } from '../api';
import { MISSING_DEBOUNCE_MS } from '../constants';
import { inRect } from '../layout/geometry';
import type { Character } from './character';
import { Sim } from './sim';

const theme: RoomTheme = {
  carpet: '#4f6d8f',
  carpet2: '#486685',
  wall: { base: '#e6e2da', trim: '#9a8f80', pattern: 'plain' },
  accent: '#3f7fd8',
  deskVariant: 'wood',
  chairVariant: 'black',
};

const appearance: Appearance = {
  skin: '#f0c8a0',
  hair: '#3a2a20',
  hairStyle: 'short',
  eyes: '#222',
  top: '#3f7fd8',
  topAccent: '#fff',
  topStyle: 'tshirt',
  bottom: '#333',
  shoes: '#111',
  accessory: 'none',
  accessoryColor: '#000',
  lanyard: null,
  look: 'm',
};

const art = { appearanceFromSeed: () => appearance, roomTheme: () => theme } as unknown as ArtModule;

const T0 = 1_790_000_000_000;
const OPTS = { version: 't' };

/** Avança a simulação em passos de 1/30 s. */
function run(sim: Sim, clock: { now: number }, seconds: number, until?: () => boolean): void {
  const steps = Math.round(seconds * 30);
  for (let i = 0; i < steps; i++) {
    clock.now += 1000 / 30;
    sim.update(1 / 30, clock.now);
    if (until?.()) return;
  }
}

/** Carteiras só em memória, como o timelapse. */
const newSim = () => new Sim(art, () => ({ ...DEFAULT_WORLD_OPTIONS, liveliness: 'calm' }), null);

function enter(detail: WorldBuildingDetail): { sim: Sim; clock: { now: number }; snap: OfficeSnapshot } {
  const sim = newSim();
  const clock = { now: T0 };
  const snap = officeFromBuilding(detail, clock.now, OPTS);
  sim.applySnapshot(snap, clock.now);
  return { sim, clock, snap };
}

const charByName = (sim: Sim, name: string): Character => [...sim.chars.values()].find((c) => c.info.name === name)!;

/** O tile em que o personagem está fica dentro do retângulo da sala dele. */
function insideOwnRoom(sim: Sim, ch: Character): boolean {
  const room = sim.rooms.get(ch.roomId);
  return !!room && inRect(room.layout.rect, ch.tx, ch.ty);
}

describe('visita a um prédio do mundo no Sim', () => {
  it('todos os personagens existem, na sala do andar deles e no comportamento do status', () => {
    const detail = sampleBuildingDetail();
    const { sim, clock, snap } = enter(detail);
    run(sim, clock, 3);
    expect(sim.rooms.size).toBe(3);
    for (const r of sim.rooms.values()) {
      expect(r.phase).toBe('ready');
      expect(r.lightOn).toBe(true);
    }
    expect(sim.chars.size).toBe(6);
    for (const f of detail.floors) {
      for (const a of f.agents) {
        const ch = sim.chars.get(`world:${a.id}`)!;
        expect(ch, a.name).toBeDefined();
        expect(ch.roomId).toBe(f.id);
        expect(ch.info.status).toBe(a.status);
        expect(ch.gone || ch.leaving).toBe(false);
      }
    }
    const mode = (name: string) => charByName(sim, name).mode;
    expect([mode('Marina'), mode('Rafael'), mode('Beatriz'), mode('Thiago'), mode('Larissa'), mode('Gustavo')]).toEqual([
      'work',
      'work',
      'wait',
      'shell',
      'idle',
      'idle',
    ]);
    // quem trabalha ou espera está na própria mesa, dentro da sala do andar
    for (const name of ['Marina', 'Beatriz']) {
      const ch = charByName(sim, name);
      expect(ch.homeSpot).not.toBeNull();
      expect(ch.atSpot).toBe(ch.homeSpot);
      expect(insideOwnRoom(sim, ch)).toBe(true);
    }
    expect(charByName(sim, 'Marina').pose).toBe('type');
    expect(charByName(sim, 'Beatriz').pose).toBe('raise_hand');
    // o subagente acha o pai pelo id `world:`; o órfão segue sozinho
    const sub = charByName(sim, 'Rafael');
    expect(sim.chars.get(sub.info.parentId!)).toBe(charByName(sim, 'Marina'));
    expect(charByName(sim, 'Thiago').info.parentId).toBeUndefined();
    // contas fictícias nas etiquetas: a do Codex com o selo da ferramenta
    expect(sim.accounts.get('world:codex')).toEqual({ short: 'X', color: snap.accounts[1].color, name: 'Codex', provider: 'codex' });
    expect(sim.accounts.get('world:claude')).toMatchObject({ short: 'C', name: 'Claude Code' });
    // um tempo depois, ninguém foi embora nem trocou de sala
    run(sim, clock, 20);
    expect(sim.chars.size).toBe(6);
    for (const ch of sim.chars.values()) expect(ch.leaving).toBe(false);
  });

  it('modo discreto: as salas aparecem, com a luz acesa, sem ninguém', () => {
    const { sim, clock } = enter(sampleBuildingDetail('discreet'));
    run(sim, clock, 5);
    expect(sim.rooms.size).toBe(3);
    for (const r of sim.rooms.values()) {
      expect(r.phase).toBe('ready');
      expect(r.lightOn).toBe(true);
    }
    expect(sim.chars.size).toBe(0);
  });

  it('prédio apagado: as salas existem e ninguém aparece (a cena apaga as luzes)', () => {
    const { sim, clock } = enter(sampleBuildingDetail('away'));
    run(sim, clock, 5);
    expect([...sim.rooms.keys()]).toEqual(['f_0a1b2c3d4e', 'f_1b2c3d4e5f', 'f_2c3d4e5f60']);
    expect(sim.chars.size).toBe(0);
  });

  it('patch: agente que troca de status, andar que some (todos vão embora) e andar novo (construído, com quem chega)', () => {
    const { sim, clock, snap } = enter(sampleBuildingDetail());
    run(sim, clock, 3);
    const floors = sampleBuildingDetail().floors.filter((f) => f.label !== 'aurora');
    floors[1].agents[0].status = 'working'; // Beatriz: esperando -> trabalhando
    floors.push({
      id: 'f_3d4e5f6071',
      label: 'orion',
      agents: [{ id: 'a_0badf00d', kind: 'main', provider: 'claude', status: 'working', look: 'f', name: 'Camila', parts: {} }],
    });
    const { snapshot } = applyBuildingPatch(snap, { rev: 13, floors }, clock.now);
    sim.applySnapshot(snapshot, clock.now);
    const beatriz = charByName(sim, 'Beatriz');
    expect(beatriz.mode).toBe('work');
    const aurora = sim.rooms.get('f_2c3d4e5f60')!;
    expect(aurora.listed).toBe(false);
    const orion = sim.rooms.get('f_3d4e5f6071')!;
    expect(orion.phase).toBe('building');
    const camila = charByName(sim, 'Camila');
    expect(camila.roomId).toBe('f_3d4e5f6071');
    expect(camila.arriving).toBe(true);
    // quem estava no andar que sumiu vai embora depois do debounce
    run(sim, clock, MISSING_DEBOUNCE_MS / 1000 + 1);
    expect(charByName(sim, 'Larissa').leaving).toBe(true);
    expect(charByName(sim, 'Gustavo').leaving).toBe(true);
    run(sim, clock, 120, () => !sim.rooms.has('f_2c3d4e5f60') && camila.atSpot === camila.homeSpot && !!camila.homeSpot);
    expect(sim.rooms.has('f_2c3d4e5f60')).toBe(false);
    expect(charByName(sim, 'Larissa')).toBeUndefined();
    expect(orion.phase).toBe('ready');
    expect(orion.lightOn).toBe(true);
    expect(camila.atSpot).toBe(camila.homeSpot);
    expect(insideOwnRoom(sim, camila)).toBe(true);
    expect(insideOwnRoom(sim, beatriz)).toBe(true);
    expect(beatriz.pose).toBe('type');
    run(sim, clock, 120, () => !charByName(sim, 'Gustavo'));
    expect([...sim.chars.values()].map((c) => c.info.name).sort()).toEqual(['Beatriz', 'Camila', 'Marina', 'Rafael', 'Thiago']);
  });

  it('o prédio ficou discreto no meio da visita: todo mundo vai embora e as salas ficam', () => {
    const { sim, clock, snap } = enter(sampleBuildingDetail());
    run(sim, clock, 3);
    const { snapshot } = applyBuildingPatch(snap, { rev: 13, building: sampleBuildingDetail('discreet').building }, clock.now);
    sim.applySnapshot(snapshot, clock.now);
    run(sim, clock, 120, () => sim.chars.size === 0);
    expect(sim.chars.size).toBe(0);
    expect(sim.rooms.size).toBe(3);
  });
});
