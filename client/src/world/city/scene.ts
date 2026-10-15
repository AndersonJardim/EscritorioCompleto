// Desenho da cidade por quadro: chão das células visíveis (uma imagem por quarteirão) -> jardins dos lotes vazios
// -> prédios, decoração e personagens ordenados pela profundidade -> noite (multiplica a cena pelo tom do céu e
// redesenha o que brilha: janelas acesas, letreiros, postes) -> passada em espaço de tela (placas com o nome do
// dono, a bandeira e os likes; nomes sobre as cabeças; destaques).
//
// Custo: só o que cruza a vista (quarteirões pela conta da grade, nunca a lista inteira de prédios); sprites em
// cache (célula, jardins, fachadas por chave, árvores e postes do escritório); sem alocação por quadro no caminho
// quente (entidades reaproveitadas). Abaixo de zoom 0,6 os detalhes pequenos somem; abaixo de 1,1, as placas.
import { TILE, type Appearance, type ArtModule, type CharacterFrameRequest, type Dir, type Pose, type Sprite } from '../../art/api';
import { hash32 } from '../../../../shared/hash';
import { partsKey } from '../../../../shared/appearance';
import { blockAt, isPlaza, lotDoor, lotOrigin, type CityPoint } from '../../../../shared/world/city';
import type { WorldBuildingPublic, WorldPlayerPublic } from '../../../../shared/world/protocol';
import type { WorldOptions } from '../api';
import type { Camera } from '../camera';
import { ambientAt, ambientDistance, approachAmbient, daylightModeOf, effectiveHour, isNeutral, parseHourParam, rgbCss, type Ambient } from '../render/daylight';
import { glowSprite, propSprite, shadowSprite } from '../render/props';
import { flagEmoji } from './cards';
import { FACADE, facadeModel, facadeSprites, signRect, windowRect, type FacadeModel, type FacadeSprites } from './facade';
import { cellCanvas, fountainCanvas, gardenCanvas, planterCanvas, plazaCanvas } from './ground';
import { blockDecor, blockRange, cellPx, gardenKind, isNorthRow, lotDecor, lotKey, lotSeed, lotsOfBlock, type Decor } from './layout';
import { PROTO_TO_DIR, sampleAt, type LocalPlayer } from './players';
import type { CityState, RemotePlayer } from './state';
import type { CitySelf } from './stream';

const UI_FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';
const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
/** Abaixo deste zoom, a decoração pequena (arbustos, flores, cercas) some. */
const SMALL_DECOR_ZOOM = 0.6;
/** Placas com o nome do dono só a partir deste zoom (antes viram ilegíveis). */
const SIGN_ZOOM = 1.05;
/** Nomes sobre as cabeças a partir deste zoom. */
const NAME_ZOOM = 0.85;
const FADE_MS = 1_200;
/** Pixels de tela por pixel do mapa de luz da noite (meia resolução: as bordas suaves viram brilho). */
const LIGHT_MAP_SCALE = 2;

let halo: HTMLCanvasElement | null = null;
/** Poça de luz de poste no mapa de luz: quente no meio, some na borda. */
function haloSprite(): HTMLCanvasElement {
  if (halo) return halo;
  halo = document.createElement('canvas');
  halo.width = 64;
  halo.height = 64;
  const ctx = halo.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,226,170,1)');
  g.addColorStop(0.4, 'rgba(255,214,150,0.75)');
  g.addColorStop(1, 'rgba(255,214,150,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return halo;
}

const enum K {
  Decor,
  Building,
  Char,
}

interface Ent {
  k: K;
  y: number;
  ref: Decor | BuildingVis | CharVis | null;
}

/** Prédio visível neste quadro. */
export interface BuildingVis {
  b: WorldBuildingPublic;
  m: FacadeModel;
  s: FacadeSprites;
  /** Canto superior esquerdo do sprite (px de mundo). */
  x: number;
  y: number;
  depth: number;
}

/** Personagem visível neste quadro (eu ou outro). */
export interface CharVis {
  id: string;
  name: string;
  me: boolean;
  x: number;
  y: number;
  dir: Dir;
  pose: Pose;
  animT: number;
  appearance: Appearance;
  /** Retângulo do sprite para o clique (px de mundo). */
  bx: number;
  by: number;
  bw: number;
  bh: number;
  headY: number;
  visible: boolean;
}

interface BuildingCache {
  sig: string;
  m: FacadeModel;
}

interface BlockInfo {
  bx: number;
  by: number;
  /** Retângulo da célula (px). */
  cell: { x: number; y: number; w: number; h: number };
  lots: CityPoint[];
  keys: string[];
  decor: Decor[];
  plaza: boolean;
}

export interface CityHighlight {
  building: string | null;
  player: string | null;
  /** Porta perto de mim (mostra a dica do E ao lado da minha cabeça). */
  door: { x: number; y: number } | null;
  me?: { x: number; y: number } | null;
}

/** Quanto tempo cada personagem está na pose (para os quadros da animação). */
interface AnimState {
  pose: Pose;
  t: number;
}

export class CityRenderer {
  readonly ctx: CanvasRenderingContext2D;
  /** Prédios e personagens desenhados no último quadro (hit-test). */
  readonly buildingsDrawn: BuildingVis[] = [];
  readonly charsDrawn: CharVis[] = [];
  private nb = 0;
  private nc = 0;
  private readonly bPool: BuildingVis[] = [];
  private readonly cPool: CharVis[] = [];
  private readonly ents: Ent[] = [];
  private readonly ePool: Ent[] = [];
  private cell: HTMLCanvasElement | null = null;
  private plaza: HTMLCanvasElement | null = null;
  private readonly gardens = new Map<string, HTMLCanvasElement>();
  private readonly blocks = new Map<number, BlockInfo>();
  private readonly lotDecors = new Map<string, Decor[]>();
  private readonly facades = new Map<string, BuildingCache>();
  private readonly appearances = new Map<string, { key: string; a: Appearance }>();
  private readonly anims = new Map<string, AnimState>();
  private fountain: { canvas: HTMLCanvasElement; ax: number; ay: number } | null = null;
  private readonly planters = new Map<number, { canvas: HTMLCanvasElement; ax: number; ay: number }>();
  private readonly req = { appearance: null as unknown as Appearance, dir: 'down' as Dir, pose: 'stand' as Pose, frame: 0, held: 'none' as const, seated: false } as CharacterFrameRequest;
  private readonly lamps: number[] = [];
  private ambient: Ambient = ambientAt(12);
  private target: Ambient = this.ambient;
  private ambientAt = -1e9;
  private lastNow = 0;
  private mode = '';
  /** Hora forçada (?hora=21:30) ou null. */
  hourOverride: number | null = parseHourParam(typeof location === 'undefined' ? '' : location.search);
  /** Fator noturno do último quadro. */
  night = 0;
  private readonly widths = new Map<string, number>();
  /** Retângulos (px de tela) das placas desenhadas neste quadro: [x, y, w, h, ...]. */
  private readonly signBoxes: number[] = [];
  private readonly labelBoxes: number[] = [];
  /** Tempo do último quadro (ms) só do desenho, para a medição de desempenho. */
  lastFrameMs = 0;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly art: ArtModule,
    private readonly camera: Camera,
    private readonly state: CityState,
  ) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
  }

  // ------------------------------------------------------------------ caches

  private blockInfo(bx: number, by: number): BlockInfo {
    const key = (bx + 32768) * 65536 + (by + 32768);
    let info = this.blocks.get(key);
    if (!info) {
      if (this.blocks.size > 600) this.blocks.clear();
      const b = { x: bx, y: by };
      const lots = lotsOfBlock(b);
      info = { bx, by, cell: cellPx(b), lots, keys: lots.map(lotKey), decor: blockDecor(b), plaza: isPlaza(b) };
      this.blocks.set(key, info);
    }
    return info;
  }

  private lotDecor(lot: CityPoint, key: string, built: boolean): Decor[] {
    const k = built ? `${key}|p` : key;
    let d = this.lotDecors.get(k);
    if (!d) {
      if (this.lotDecors.size > 2000) this.lotDecors.clear();
      d = lotDecor(lot, built);
      this.lotDecors.set(k, d);
    }
    return d;
  }

  private garden(lot: CityPoint): HTMLCanvasElement {
    const kind = gardenKind(lot);
    const north = isNorthRow(lot);
    const key = `${kind}|${north ? 'n' : 's'}`;
    let c = this.gardens.get(key);
    if (!c) this.gardens.set(key, (c = gardenCanvas(this.art, kind, north, lotSeed(lot))));
    return c;
  }

  /** Modelo da fachada de um prédio (refeito só quando o que aparece nela muda). */
  facadeOf(b: WorldBuildingPublic): FacadeModel {
    const a = b.agents;
    const sig = `${b.floors}|${b.state}|${b.theme}|${a ? `${a.total},${a.working},${a.waiting}` : '-'}|${b.lot.x},${b.lot.y}`;
    let c = this.facades.get(b.id);
    if (!c || c.sig !== sig) {
      if (this.facades.size > 4000) this.facades.clear();
      c = { sig, m: facadeModel(b, isNorthRow(b.lot) ? 'back' : 'front', lotSeed(b.lot)) };
      this.facades.set(b.id, c);
    }
    return c.m;
  }

  appearanceOf(id: string, look: 'f' | 'm', parts: WorldPlayerPublic['parts']): Appearance {
    const key = `${look}|${partsKey(parts)}`;
    let e = this.appearances.get(id);
    if (!e || e.key !== key) {
      if (this.appearances.size > 500) this.appearances.clear();
      e = { key, a: this.art.appearanceFromSeed(hash32(id), { look, parts }) };
      this.appearances.set(id, e);
    }
    return e.a;
  }

  /** Pose e tempo nela (reinicia a animação ao trocar de pose). */
  private animOf(id: string, pose: Pose, dt: number): number {
    let a = this.anims.get(id);
    if (!a) this.anims.set(id, (a = { pose, t: 0 }));
    if (a.pose !== pose) {
      a.pose = pose;
      a.t = 0;
    } else a.t += dt * 1000;
    return a.t;
  }

  forget(id: string): void {
    this.anims.delete(id);
  }

  // ------------------------------------------------------------------ ambiente (dia e noite)

  private updateAmbient(now: number, opts: WorldOptions): void {
    const mode = daylightModeOf(opts);
    const key = `${mode}|${this.hourOverride ?? ''}`;
    if (key !== this.mode || now - this.ambientAt > 4000) {
      const first = this.mode === '';
      this.mode = key;
      this.ambientAt = now;
      this.target = ambientAt(effectiveHour(mode, this.hourOverride, new Date()));
      if (first) this.ambient = this.target;
    }
    const dt = Math.max(0, Math.min(250, now - this.lastNow));
    this.lastNow = now;
    if (this.ambient !== this.target) {
      this.ambient = approachAmbient(this.ambient, this.target, (dt / FADE_MS) * 3);
      if (ambientDistance(this.ambient, this.target) < 3) this.ambient = this.target;
    }
    this.night = this.ambient.night;
  }

  private map: HTMLCanvasElement | null = null;

  /** Mapa de luz da noite (meia resolução da tela). */
  private lightMap(W: number, H: number): HTMLCanvasElement | null {
    const w = Math.max(1, Math.ceil(W / LIGHT_MAP_SCALE));
    const h = Math.max(1, Math.ceil(H / LIGHT_MAP_SCALE));
    try {
      if (!this.map) this.map = document.createElement('canvas');
      if (this.map.width !== w || this.map.height !== h) {
        this.map.width = w;
        this.map.height = h;
      }
      return this.map;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ quadro

  frame(now: number, dt: number, opts: WorldOptions, me: { player: LocalPlayer; self: CitySelf } | null, hl: CityHighlight): void {
    const t0 = performance.now();
    const { ctx, camera } = this;
    if (!this.cell) this.cell = cellCanvas(this.art);
    if (!this.plaza) this.plaza = plazaCanvas(this.art);
    this.updateAmbient(now, opts);
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#5e7f52';
    ctx.fillRect(0, 0, W, H);
    const { scale, ox, oy } = camera.transform();
    ctx.setTransform(scale, 0, 0, scale, ox, oy);
    const vx0 = -ox / scale;
    const vy0 = -oy / scale;
    const vx1 = vx0 + W / scale;
    const vy1 = vy0 + H / scale;
    const visible = (x: number, y: number, w: number, h: number) => x < vx1 && x + w > vx0 && y < vy1 && y + h > vy0;
    const small = camera.zoom >= SMALL_DECOR_ZOOM;
    const range = blockRange({ x0: vx0, y0: vy0, x1: vx1, y1: vy1 });

    // ---- chão: uma imagem por célula e o jardim de cada lote vazio
    const ents = this.ents;
    ents.length = 0;
    let used = 0;
    const push = (k: K, y: number, ref: Ent['ref']) => {
      let e = this.ePool[used];
      if (!e) this.ePool[used] = e = { k, y, ref };
      else {
        e.k = k;
        e.y = y;
        e.ref = ref;
      }
      used++;
      ents.push(e);
    };
    this.nb = 0;
    this.lamps.length = 0;
    for (let by = range.by0; by <= range.by1; by++) {
      for (let bx = range.bx0; bx <= range.bx1; bx++) {
        const info = this.blockInfo(bx, by);
        const cp = info.cell;
        if (!visible(cp.x, cp.y, cp.w, cp.h + 2 * TILE)) continue;
        ctx.drawImage(info.plaza ? this.plaza : this.cell, cp.x, cp.y);
        for (const d of info.decor) {
          if (d.small && !small) continue;
          if (!visible(d.x - 24, d.y - 56, 48, 60)) continue;
          push(K.Decor, d.y, d);
          if (d.kind === 'lamp') this.lamps.push(d.x, d.y);
        }
        for (let i = 0; i < info.lots.length; i++) {
          const lot = info.lots[i]!;
          const o = lotOrigin(lot);
          const lx = o.x * TILE;
          const ly = o.y * TILE;
          if (!visible(lx, ly, 14 * TILE, 12 * TILE)) continue;
          const b = this.state.buildingAt(lot);
          if (!b) ctx.drawImage(this.garden(lot), lx, ly);
          for (const d of this.lotDecor(lot, info.keys[i]!, !!b)) {
            if (d.small && !small) continue;
            if (!visible(d.x - 24, d.y - 56, 48, 60)) continue;
            push(K.Decor, d.y, d);
          }
          if (b) {
            const m = this.facadeOf(b);
            const north = m.side === 'back';
            const s = facadeSprites(m);
            const x = lx + TILE;
            const y = north ? ly : ly + 12 * TILE - s.h;
            if (!visible(x, y, s.w, s.h)) continue;
            let v = this.bPool[this.nb];
            if (!v) this.bPool[this.nb] = v = { b, m, s, x, y, depth: 0 };
            v.b = b;
            v.m = m;
            v.s = s;
            v.x = x;
            v.y = y;
            v.depth = y + s.h;
            this.buildingsDrawn[this.nb] = v;
            this.nb++;
            push(K.Building, v.depth, v);
          }
        }
      }
    }
    this.buildingsDrawn.length = this.nb;

    // ---- personagens: eu e os outros (150 ms atrás, interpolados)
    this.nc = 0;
    const renderT = now - 150;
    for (const [id, rp] of this.state.players) {
      const v = this.charVis(id, rp, renderT, dt, visible);
      if (v) push(K.Char, v.y, v);
    }
    if (me) {
      const p = me.player;
      const pose: Pose = p.seat ? 'sit' : p.moving ? (p.running ? 'run' : 'walk') : 'stand';
      const v = this.takeChar(me.self.id, me.self.name, true, p.x * TILE, p.y * TILE, p.dir, pose, this.animOf(me.self.id, pose, dt), this.appearanceOf(me.self.id, me.self.look, me.self.parts));
      if (visible(v.x - 24, v.y - 48, 48, 56)) push(K.Char, v.y + 0.25, v);
      else v.visible = false;
    }
    this.charsDrawn.length = this.nc;
    ents.sort((a, b) => a.y - b.y || a.k - b.k);

    // ---- entidades
    for (const e of ents) {
      if (e.k === K.Decor) this.drawDecor(e.ref as Decor, now);
      else if (e.k === K.Building) this.drawBuilding(e.ref as BuildingVis, now, hl.building === (e.ref as BuildingVis).b.id);
      else this.drawChar(e.ref as CharVis, hl.player === (e.ref as CharVis).id);
    }

    // ---- noite: mapa de luz (o tom do céu, com as janelas acesas, letreiros e a luz dos postes clareando) multiplicado
    // sobre a cena; depois, só o brilho das lâmpadas por cima
    const amb = this.ambient;
    if (!isNeutral(amb)) {
      const map = this.lightMap(W, H);
      if (map) {
        const lctx = map.getContext('2d')!;
        const ms = LIGHT_MAP_SCALE;
        lctx.setTransform(1, 0, 0, 1, 0, 0);
        lctx.globalCompositeOperation = 'source-over';
        lctx.globalAlpha = 1;
        lctx.fillStyle = rgbCss(amb.outside);
        lctx.fillRect(0, 0, map.width, map.height);
        const n = amb.night;
        if (n > 0.02) {
          lctx.setTransform(scale / ms, 0, 0, scale / ms, ox / ms, oy / ms);
          lctx.globalCompositeOperation = 'lighten';
          lctx.globalAlpha = Math.min(1, n * 1.3);
          for (let i = 0; i < this.nb; i++) {
            const v = this.buildingsDrawn[i]!;
            lctx.drawImage(v.s.glow, v.x, v.y);
          }
          const pool = haloSprite();
          lctx.globalAlpha = Math.min(1, n * 1.1);
          for (let i = 0; i < this.lamps.length; i += 2) lctx.drawImage(pool, this.lamps[i]! - 52, this.lamps[i + 1]! - 46, 104, 70);
        }
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = 'multiply';
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(map, 0, 0, map.width, map.height, 0, 0, map.width * ms, map.height * ms);
        ctx.restore();
        if (n > 0.02) {
          // lâmpadas acesas (o brilho que vaza por cima)
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          const head = glowSprite('#fff1c8', 24);
          ctx.globalAlpha = n * 0.85;
          for (let i = 0; i < this.lamps.length; i += 2) ctx.drawImage(head, this.lamps[i]! - 12, this.lamps[i + 1]! - 42);
          ctx.restore();
        }
      }
    }
    // janelas de quem espera piscam por cima de tudo (também de dia)
    this.drawWaiting(now);

    // ---- espaço de tela: placas, nomes e dicas
    this.overlay(now, opts, hl);
    this.lastFrameMs = performance.now() - t0;
  }

  private takeChar(id: string, name: string, me: boolean, x: number, y: number, dir: Dir, pose: Pose, animT: number, appearance: Appearance): CharVis {
    let v = this.cPool[this.nc];
    if (!v) this.cPool[this.nc] = v = { id, name, me, x, y, dir, pose, animT, appearance, bx: 0, by: 0, bw: 0, bh: 0, headY: 0, visible: true };
    v.id = id;
    v.name = name;
    v.me = me;
    v.x = x;
    v.y = y;
    v.dir = dir;
    v.pose = pose;
    v.animT = animT;
    v.appearance = appearance;
    v.visible = true;
    this.charsDrawn[this.nc] = v;
    this.nc++;
    return v;
  }

  private charVis(id: string, rp: RemotePlayer, t: number, dt: number, visible: (x: number, y: number, w: number, h: number) => boolean): CharVis | null {
    const s = sampleAt(rp.samples, t);
    if (!s) return null;
    const x = s.x * TILE;
    const y = s.y * TILE;
    if (!visible(x - 24, y - 48, 48, 56)) return null;
    // parado em cima de um banco = sentado (o servidor põe quem está ausente no banco mais perto)
    const seated = !s.moving && this.onBench(s.x, s.y);
    const pose: Pose = seated ? 'sit' : s.moving ? (s.speed > 4.6 ? 'run' : 'walk') : 'stand';
    const dir = seated ? 'down' : PROTO_TO_DIR[s.dir] ?? 'down';
    return this.takeChar(id, rp.info.name, false, x, y, dir, pose, this.animOf(id, pose, dt), this.appearanceOf(id, rp.info.look, rp.info.parts));
  }

  /** Decorações com assento (bancos) nos quarteirões em volta de (x, y) tiles: calçadas, praça e jardins. */
  seatsNear(x: number, y: number, out: Decor[] = []): Decor[] {
    out.length = 0;
    const home = blockAt(x, y);
    for (let j = home.y - 1; j <= home.y + 1; j++) {
      for (let i = home.x - 1; i <= home.x + 1; i++) {
        const info = this.blockInfo(i, j);
        for (const d of info.decor) if (d.seat) out.push(d);
        for (let k = 0; k < info.lots.length; k++) {
          const lot = info.lots[k]!;
          if (this.state.buildingAt(lot)) continue;
          for (const d of this.lotDecor(lot, info.keys[k]!, false)) if (d.seat) out.push(d);
        }
      }
    }
    return out;
  }

  private readonly seatScratch: Decor[] = [];

  /** Há um assento de banco a menos de meio tile de (x, y) tiles? */
  onBench(x: number, y: number): boolean {
    for (const d of this.seatsNear(x, y, this.seatScratch)) if (d.seat && Math.abs(d.seat.x - x) < 0.5 && Math.abs(d.seat.y - y) < 0.5) return true;
    return false;
  }

  // ------------------------------------------------------------------ peças

  private drawDecor(d: Decor, now: number): void {
    const { ctx } = this;
    if (d.kind === 'fountain') {
      const f = (this.fountain ??= fountainCanvas());
      const x = Math.round(d.x - f.ax);
      const y = Math.round(d.y - f.ay);
      ctx.drawImage(f.canvas, x, y);
      this.drawFountainWater(d.x, d.y - f.ay + f.canvas.height - 3 - 24, now);
      return;
    }
    if (d.kind === 'planter') {
      let p = this.planters.get(d.seed % 5);
      if (!p) this.planters.set(d.seed % 5, (p = planterCanvas(d.seed % 5)));
      ctx.drawImage(p.canvas, Math.round(d.x - p.ax), Math.round(d.y - p.ay));
      return;
    }
    const s = propSprite({ kind: d.kind, x: d.x, y: d.y, seed: d.seed });
    ctx.drawImage(s.canvas, Math.round(d.x - s.ax), Math.round(d.y - s.ay));
  }

  /** Água da fonte: o jato que sobe da taça e cai em gotas, e brilhos na bacia. */
  private drawFountainWater(cx: number, cy: number, now: number): void {
    const { ctx } = this;
    const t = now / 1000;
    ctx.fillStyle = 'rgba(214,238,255,0.9)';
    const top = cy - 18;
    for (let i = 0; i < 9; i++) {
      const ph = (t * 1.6 + i / 9) % 1;
      const side = i % 2 ? 1 : -1;
      const x = cx + side * ph * 9;
      const y = top - Math.sin(ph * Math.PI) * 9 + ph * 4;
      ctx.fillRect(Math.round(x), Math.round(y), 1, 2);
    }
    ctx.fillRect(Math.round(cx), Math.round(top - 9), 1, 9);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    for (let i = 0; i < 6; i++) {
      const a = i * 1.05 + t * 0.7;
      const x = cx + Math.cos(a) * 20;
      const y = cy + 6 + Math.sin(a) * 9;
      if ((Math.floor(t * 4) + i) % 3 === 0) ctx.fillRect(Math.round(x), Math.round(y), 2, 1);
    }
  }

  private drawBuilding(v: BuildingVis, now: number, hovered: boolean): void {
    const { ctx } = this;
    ctx.drawImage(v.s.canvas, v.x, v.y);
    if (hovered) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.08 + Math.sin(now / 260) * 0.03;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(v.x, v.y, FACADE.w, v.s.h);
      ctx.restore();
    }
  }

  /** Janelas `waiting` piscando devagar em âmbar. */
  private drawWaiting(now: number): void {
    const { ctx } = this;
    const pulse = 0.5 + 0.5 * Math.sin(now / 420);
    if (pulse < 0.08) return;
    ctx.save();
    for (let i = 0; i < this.nb; i++) {
      const v = this.buildingsDrawn[i]!;
      if (!v.m.waiting.length) continue;
      for (const w of v.m.waiting) {
        const r = windowRect(v.m, w);
        ctx.globalAlpha = 0.35 + pulse * 0.6;
        ctx.fillStyle = '#ffb547';
        ctx.fillRect(v.x + r.x, v.y + r.y, r.w, r.h);
        ctx.globalAlpha = pulse * 0.9;
        ctx.fillStyle = '#fff2c4';
        ctx.fillRect(v.x + r.x + 1, v.y + r.y + 1, r.w - 2, 2);
      }
    }
    ctx.restore();
  }

  private drawChar(v: CharVis, hovered: boolean): void {
    const { ctx } = this;
    const x = Math.round(v.x);
    const y = Math.round(v.y);
    if (v.pose !== 'sit') {
      const sh = shadowSprite();
      ctx.drawImage(sh.canvas, x - sh.ax, y - sh.ay);
    }
    if (hovered || v.me) {
      ctx.save();
      ctx.strokeStyle = v.me ? 'rgba(124,200,255,0.85)' : 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(x, y, 8, 3, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    let sprite: Sprite | null = null;
    try {
      const req = this.req;
      req.appearance = v.appearance;
      req.dir = v.dir;
      req.pose = v.pose;
      req.seated = v.pose === 'sit';
      const count = Math.max(1, this.art.poseFrameCount(v.pose) || 1);
      const dur = Math.max(30, this.art.poseFrameDuration(v.pose) || 500);
      req.frame = Math.floor(v.animT / dur) % count;
      sprite = this.art.characterSprite(req);
    } catch {
      sprite = null;
    }
    if (sprite) {
      const sx = x - sprite.ax;
      const sy = y - sprite.ay;
      ctx.drawImage(sprite.canvas, sx, sy);
      v.bx = sx + 2;
      v.by = sy + 2;
      v.bw = sprite.canvas.width - 4;
      v.bh = sprite.canvas.height - 2;
      v.headY = sy + 2;
    } else {
      v.bx = x - 7;
      v.by = y - 26;
      v.bw = 14;
      v.bh = 26;
      v.headY = y - 26;
    }
  }

  // ------------------------------------------------------------------ espaço de tela

  private measure(font: string, text: string): number {
    const key = `${font}|${text}`;
    let w = this.widths.get(key);
    if (w === undefined) {
      if (this.widths.size > 3000) this.widths.clear();
      this.ctx.font = font;
      w = this.ctx.measureText(text).width;
      this.widths.set(key, w);
    }
    return w;
  }

  private fit(font: string, text: string, maxW: number): string {
    if (this.measure(font, text) <= maxW) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.measure(font, `${text.slice(0, mid).trimEnd()}…`) <= maxW) lo = mid;
      else hi = mid - 1;
    }
    return lo > 0 ? `${text.slice(0, lo).trimEnd()}…` : '';
  }

  private overlay(now: number, opts: WorldOptions, hl: CityHighlight): void {
    const { ctx, camera } = this;
    const dpr = camera.dpr;
    const t = camera.transform();
    const k = t.scale / dpr;
    const sx = (wx: number) => wx * k + t.ox / dpr;
    const sy = (wy: number) => wy * k + t.oy / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const zoom = camera.zoom;
    const night = this.night;

    // placas dos prédios: bandeira, nome do dono e ❤️ likes, no letreiro
    const signs = this.signBoxes;
    signs.length = 0;
    if (zoom >= SIGN_ZOOM) {
      for (let i = 0; i < this.nb; i++) {
        const v = this.buildingsDrawn[i]!;
        const r = signRect(v.m);
        const x0 = sx(v.x + r.x);
        const y0 = sy(v.y + r.y);
        const w = r.w * k;
        const h = r.h * k;
        if (h < 9) continue;
        signs.push(x0, y0, w, h);
        const size = Math.max(8, Math.min(13, h * 0.78));
        const font = `700 ${size.toFixed(1)}px ${UI_FONT}`;
        const flag = flagEmoji(v.b.owner.country);
        const likes = `❤️ ${v.b.likes}`;
        const likesW = this.measure(font, likes);
        const flagW = flag ? this.measure(`${size.toFixed(1)}px ${EMOJI_FONT}`, flag) + 4 : 0;
        const name = this.fit(font, v.b.owner.name, Math.max(0, w - likesW - flagW - 14));
        const on = v.b.state === 'online';
        ctx.globalAlpha = on ? 1 : 0.7;
        let x = x0 + 5;
        const cy = y0 + h / 2 + 0.5;
        if (flag) {
          ctx.font = `${size.toFixed(1)}px ${EMOJI_FONT}`;
          ctx.fillText(flag, x, cy);
          x += flagW;
        }
        ctx.font = font;
        ctx.fillStyle = 'rgba(10,14,24,0.55)';
        ctx.fillText(name, x + 0.5, cy + 1);
        ctx.fillStyle = on ? '#fff8e6' : '#c4c9d4';
        ctx.fillText(name, x, cy);
        ctx.fillStyle = on ? '#ffe2e6' : '#c4c9d4';
        ctx.fillText(likes, x0 + w - likesW - 5, cy);
        ctx.globalAlpha = 1;
      }
    }

    // nomes sobre as cabeças (o meu sempre; os outros com "mostrar nomes"); uma etiqueta não cobre a outra
    if (zoom >= NAME_ZOOM) {
      const font = `600 10.5px ${UI_FONT}`;
      ctx.font = font;
      const placed = this.labelBoxes;
      placed.length = 0;
      for (let i = 0; i < this.nc; i++) {
        const v = this.charsDrawn[i]!;
        if (!v.visible) continue;
        if (!v.me && !opts.showNames && hl.player !== v.id) continue;
        const name = this.fit(font, v.name, 140);
        const w = this.measure(font, name) + 10;
        const cx = sx(v.x);
        let top = sy(v.headY) - 17;
        // a etiqueta não cobre a placa de um prédio: sobe para cima dela
        for (let j = 0; j < signs.length; j += 4) {
          const bx = signs[j]!;
          const by = signs[j + 1]!;
          if (cx + w / 2 > bx && cx - w / 2 < bx + signs[j + 2]! && top + 14 > by && top < by + signs[j + 3]!) top = by - 16;
        }
        for (let tries = 0; tries < 4; tries++) {
          let hit = false;
          for (let j = 0; j < placed.length; j += 4) {
            if (cx + w / 2 > placed[j]! && cx - w / 2 < placed[j]! + placed[j + 2]! && top + 14 > placed[j + 1]! && top < placed[j + 1]! + placed[j + 3]!) {
              top = placed[j + 1]! - 16;
              hit = true;
            }
          }
          if (!hit) break;
        }
        placed.push(cx - w / 2, top, w, 14);
        ctx.globalAlpha = 0.92;
        ctx.fillStyle = v.me ? 'rgba(24,52,84,0.88)' : 'rgba(18,21,29,0.78)';
        ctx.beginPath();
        ctx.roundRect(Math.round(cx - w / 2), Math.round(top), Math.round(w), 14, 4);
        ctx.fill();
        if (v.me) {
          ctx.strokeStyle = 'rgba(124,200,255,0.9)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        ctx.fillStyle = v.me ? '#d6efff' : '#e8ecf5';
        ctx.textAlign = 'center';
        ctx.fillText(name, Math.round(cx), Math.round(top) + 7.5);
        ctx.textAlign = 'left';
      }
    }

    // dica da porta: "E" perto da porta de um prédio
    if (hl.door && hl.me && zoom >= 0.7) {
      // ao lado da cabeça do meu personagem
      const x = sx(hl.me.x * TILE) + 12 + 7 * Math.min(2, zoom);
      const y = sy(hl.me.y * TILE) - 20 * Math.min(2.2, Math.max(0.8, zoom));
      const bounce = Math.round(Math.sin(now / 240) * 2);
      ctx.fillStyle = 'rgba(18,21,29,0.86)';
      ctx.strokeStyle = 'rgba(255,214,140,0.9)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(Math.round(x - 10), Math.round(y - 10 + bounce), 20, 20, 5);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ffe3a0';
      ctx.font = `800 12px ${UI_FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText('E', Math.round(x), Math.round(y + 0.5 + bounce));
      ctx.textAlign = 'left';
    }
    void night;
  }

  /** Porta (ponto da calçada) de um lote, em tiles. */
  static doorFront(lot: CityPoint): CityPoint {
    return lotDoor(lot).front;
  }
}
