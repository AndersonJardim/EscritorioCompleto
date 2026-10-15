// Cena da cidade do Habblaud World: liga o stream (o de verdade ou o falso do modo demonstração), o estado, o meu
// jogador, a câmera, o desenho, a entrada, os cartões e o minimapa. Montada por app.ts quando o botão Mundo abre a
// cena; o stream só existe com a cena na tela (abre ao mostrar, fecha ao esconder).
import * as artModule from '../../art';
import type { ArtModule } from '../../art/api';
import { TILE } from '../../art/api';
import { tr } from '../../../../shared/i18n';
import { lotDoor, spawnPoint } from '../../../../shared/world/city';
import type { WorldOptions } from '../api';
import { Camera } from '../camera';
import { PathFinder } from '../path/astar';
import { h } from '../../ui/dom';
import { CityCards } from './cards';
import { CityInput } from './input';
import { buildWalkGrid, nearestDoor, nearestSeat, nearestWalkableTile, walkRectFor, walkable } from './layout';
import { Minimap } from './minimap';
import { LocalPlayer, MoveSender, pathPoints } from './players';
import { CityRenderer } from './scene';
import { CityState, type CityEffect } from './state';
import type { WorldStream } from './stream';

export { emptyWorldStream } from './stream';

const art: ArtModule = artModule;

/** Zoom mínimo da cidade: ~200 lotes numa tela de 1400 × 900. */
export const CITY_MIN_ZOOM = 0.28;
/** Zooms extras abaixo de 1 (a câmera do escritório só tem os inteiros por pixel do aparelho). */
const LOW_LEVELS = [0.375, 0.5, 0.75];
/** A aba em segundo plano repete a posição a cada isto (ms). */
const KEEPALIVE_MS = 30_000;

class CityCamera extends Camera {
  override levels(): number[] {
    const set = new Set(super.levels());
    for (const z of LOW_LEVELS) if (z >= this.minZoom - 1e-6) set.add(z);
    set.add(this.minZoom);
    return [...set].sort((a, b) => a - b);
  }
}

export interface CitySceneOptions {
  canvas: HTMLCanvasElement;
  /** Onde entram o cartão, o minimapa, as dicas e os avisos (o #ui, com os estilos da interface). */
  uiRoot: HTMLElement;
  /** Abre o stream (o de verdade ou o falso). Chamado a cada vez que a cena aparece. */
  openStream: () => WorldStream;
  /** As opções do escritório (dia/noite, nomes). */
  options: () => WorldOptions;
  /** Margem coberta pela barra do topo (px CSS). */
  topInset: () => number;
}

export interface CityScene {
  readonly visible: boolean;
  show(): void;
  hide(): void;
  zoomBy(factor: number): void;
  /** Câmera de volta no jogador. */
  recenter(): void;
  /** Esc: fecha o cartão aberto (true) ou não havia nada para fechar (false). */
  escape(): boolean;
  destroy(): void;
  /** Medição (depuração e o script de desempenho). */
  perf(): { frames: number; drawAvgMs: number; drawP95Ms: number; fps: number; buildings: number; zoom: number };
  /** Zera a medição (para medir só o regime, sem o quadro que gera os sprites). */
  perfReset(): void;
  readonly camera: Camera;
  readonly state: CityState;
  /** Meu jogador (depuração e testes no navegador). */
  me(): { x: number; y: number; moving: boolean; seated: boolean } | null;
  /** Ponto da tela (px CSS do canvas) de uma posição em tiles. */
  toScreen(x: number, y: number): { x: number; y: number };
}

export function createCityScene(o: CitySceneOptions): CityScene {
  const camera = new CityCamera();
  camera.minZoom = CITY_MIN_ZOOM;
  camera.bounds = { x: -1e7, y: -1e7, w: 2e7, h: 2e7 };
  let state = new CityState();
  let renderer = new CityRenderer(o.canvas, art, camera, state);
  let stream: WorldStream | null = null;
  let me: LocalPlayer | null = null;
  let sender: MoveSender | null = null;
  let following = true;
  let visible = false;
  let raf = 0;
  let lastTs = 0;
  let mouse: { x: number; y: number } | null = null;
  let keepAlive: ReturnType<typeof setInterval> | null = null;
  const finder = new PathFinder(buildWalkGrid({ x: 0, y: 0, w: 4, h: 4 }).grid);
  const frameMs: number[] = [];
  const rafGaps: number[] = [];

  // ------------------------------------------------------------------ DOM: cartão, minimapa, dicas, avisos

  const cards = new CityCards({ showBuilding: (id) => focusBuilding(id), topInset: () => o.topInset() });
  const minimap = new Minimap((tile) => {
    following = false;
    const z = camera.zoom;
    const c = camera.centerFor(tile.x * TILE, tile.y * TILE, z);
    camera.animateTo(c.x, c.y, z, Date.now(), 380);
  });
  const toast = h('div', { class: 'ui-city-toast', role: 'status', attrs: { 'aria-live': 'polite' }, hidden: true });
  const loading = h('div', { class: 'ui-city-loading', text: tr('Entrando na cidade…') });
  const help = h(
    'div',
    { class: 'ui-city-help', attrs: { 'aria-hidden': 'true' } },
    h('span', {}, h('kbd', { text: 'WASD' }), ' ', tr('andar')),
    h('span', {}, h('kbd', { text: 'Shift' }), ' ', tr('correr')),
    h('span', {}, h('kbd', { text: tr('clique') }), ' ', tr('ir até lá')),
    h('span', {}, h('kbd', { text: 'E' }), ' ', tr('porta')),
    h('span', {}, h('kbd', { text: 'Esc' }), ' ', tr('escritório')),
  );
  const layer = h('div', { class: 'ui-city', hidden: true }, cards.el, minimap.el, help, toast, loading);
  o.uiRoot.append(layer);
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  const showToast = (text: string) => {
    toast.textContent = text;
    toast.hidden = false;
    toast.classList.remove('is-in');
    void toast.offsetWidth;
    toast.classList.add('is-in');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.hidden = true), 2600);
  };

  // ------------------------------------------------------------------ tamanho

  const resize = () => {
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const w = o.canvas.clientWidth || window.innerWidth;
    const hh = o.canvas.clientHeight || window.innerHeight;
    const pw = Math.floor(w * dpr);
    const ph = Math.floor(hh * dpr);
    if (o.canvas.width !== pw || o.canvas.height !== ph) {
      o.canvas.width = pw;
      o.canvas.height = ph;
    }
    camera.setView(w, hh, dpr);
    camera.insets = { top: o.topInset(), right: 0, bottom: 0, left: 0 };
  };

  // ------------------------------------------------------------------ meu jogador

  const placeMe = () => {
    const self = state.me;
    if (!self || me) return;
    let p = state.startPos;
    const mine = state.myBuilding();
    if (!p && mine) p = lotDoor(mine.lot).front;
    if (!p) p = spawnPoint();
    if (!walkable(p.x, p.y)) {
      const t = nearestWalkableTile(p.x, p.y) ?? spawnPoint();
      p = { x: t.x + 0.5, y: t.y + 0.5 };
    }
    me = new LocalPlayer(p.x, p.y);
    sender = new MoveSender((m) => stream?.send([m]));
    following = true;
    const z = camera.zoom;
    const c = camera.centerFor(me.x * TILE, me.y * TILE - 12, z);
    camera.stop();
    camera.x = c.x;
    camera.y = c.y;
    loading.hidden = true;
  };

  /** Caminho do A* da minha posição até (x, y) tiles; `seat` = sentar no fim. */
  const walkTo = (x: number, y: number, run: boolean, seat: { x: number; y: number; dir: 'down' | 'up' | 'left' | 'right' } | null = null): boolean => {
    if (!me) return false;
    let goal = { x, y };
    if (!walkable(x, y)) {
      const t = nearestWalkableTile(x, y, 6);
      if (!t) return false;
      goal = { x: t.x + 0.5, y: t.y + 0.5 };
    }
    const win = buildWalkGrid(walkRectFor(me, goal));
    finder.setGrid(win.grid);
    const sx = Math.floor(me.x) - win.ox;
    const sy = Math.floor(me.y) - win.oy;
    const gx = Math.floor(goal.x) - win.ox;
    const gy = Math.floor(goal.y) - win.oy;
    const cells: number[] = [];
    if (!finder.find(sx, sy, gx, gy, cells)) return false;
    me.follow(pathPoints(cells, win.ox, win.oy, goal), run, seat);
    following = true;
    return true;
  };

  const focusBuilding = (id: string) => {
    const b = state.buildings.get(id);
    if (!b) return;
    following = false;
    const d = lotDoor(b.lot);
    const z = Math.max(camera.zoom, 1.5);
    const c = camera.centerFor(d.front.x * TILE, d.front.y * TILE - 60, z);
    camera.animateTo(c.x, c.y, z, Date.now(), 420);
  };

  const onEffect = (eff: CityEffect) => {
    switch (eff.type) {
      case 'pos':
        if (me) {
          me.correct(eff.x, eff.y);
          sender?.reset();
        }
        break;
      case 'afk': {
        // ausente: senta no banco mais perto (ou fica parado)
        if (!me || me.moving || me.seat) break;
        const seat = nearestSeat(renderer.seatsNear(me.x, me.y), me.x, me.y, 10);
        if (seat) walkTo(seat.x, seat.y, false, seat);
        break;
      }
      case 'profile':
        if (cards.kind === 'player' && cards.id === eff.player.id) {
          const rp = state.players.get(eff.player.id);
          const info = rp ? rp.info : eff.player;
          cards.showPlayer(info, info.buildingId ? state.buildings.get(info.buildingId) : undefined, null);
        }
        break;
      case 'notice':
        showToast(noticeText(eff.text));
        break;
    }
  };

  // ------------------------------------------------------------------ stream

  const openStream = () => {
    state = new CityState();
    renderer = new CityRenderer(o.canvas, art, camera, state);
    me = null;
    sender = null;
    loading.hidden = false;
    cards.hide();
    const s = o.openStream();
    stream = s;
    s.on('world.snapshot', (snap) => {
      if (stream !== s) return;
      try {
        state.applySnapshot(snap, performance.now());
        placeMe();
      } catch (err) {
        console.error('[cidade] snapshot inválido ignorado', err);
      }
    });
    s.on('world', (msg) => {
      if (stream !== s) return;
      try {
        const eff = state.apply(msg, performance.now());
        if (!me) placeMe();
        if (eff) onEffect(eff);
      } catch (err) {
        console.error('[cidade] mensagem inválida ignorada', err);
      }
    });
  };

  const closeStream = () => {
    stream?.close();
    stream = null;
  };

  // ------------------------------------------------------------------ hit-test

  type Hit = { type: 'building'; id: string } | { type: 'player'; id: string } | null;

  const pick = (sx: number, sy: number): Hit => {
    const w = camera.screenToWorld(sx, sy);
    const slack = Math.max(1, 3 / camera.zoom);
    for (let i = renderer.charsDrawn.length - 1; i >= 0; i--) {
      const c = renderer.charsDrawn[i]!;
      if (!c.visible || c.me) continue;
      if (w.x >= c.bx - slack && w.x <= c.bx + c.bw + slack && w.y >= c.by - slack && w.y <= c.by + c.bh + slack) return { type: 'player', id: c.id };
    }
    let best: Hit = null;
    let bestDepth = -Infinity;
    for (const v of renderer.buildingsDrawn) {
      if (w.x < v.x || w.x > v.x + 192 || w.y < v.y || w.y > v.y + v.s.h) continue;
      if (v.depth > bestDepth) {
        bestDepth = v.depth;
        best = { type: 'building', id: v.b.id };
      }
    }
    return best;
  };

  let hovered: Hit = null;

  const onClick = (sx: number, sy: number, mods: { shift: boolean }) => {
    const hit = pick(sx, sy);
    const at = screenPoint(sx, sy);
    if (hit?.type === 'player') {
      const rp = state.players.get(hit.id);
      if (!rp) return;
      cards.showPlayer(rp.info, rp.info.buildingId ? state.buildings.get(rp.info.buildingId) : undefined, at);
      stream?.send([{ t: 'profile', playerId: hit.id }]);
      return;
    }
    if (hit?.type === 'building') {
      const b = state.buildings.get(hit.id);
      if (!b) return;
      cards.showBuilding(b, state.myBuildingId, at, true);
      const d = lotDoor(b.lot).front;
      walkTo(d.x, d.y + (lotDoor(b.lot).side === 's' ? 0.3 : -0.3), mods.shift);
      return;
    }
    cards.hide();
    const w = camera.screenToWorld(sx, sy);
    walkTo(w.x / TILE, w.y / TILE, mods.shift);
  };

  const screenPoint = (sx: number, sy: number) => {
    const r = o.canvas.getBoundingClientRect();
    return { x: r.left + sx, y: r.top + sy };
  };

  const updateHover = () => {
    if (!mouse) {
      if (hovered && cards.kind === 'building' && !cards.pinned) cards.hide();
      hovered = null;
      o.canvas.style.cursor = '';
      return;
    }
    const hit = pick(mouse.x, mouse.y);
    hovered = hit;
    o.canvas.style.cursor = hit ? 'pointer' : 'crosshair';
    if (hit?.type === 'building') {
      const b = state.buildings.get(hit.id);
      if (b && (!cards.pinned || cards.id === b.id)) cards.showBuilding(b, state.myBuildingId, screenPoint(mouse.x, mouse.y), false);
    } else if (cards.kind === 'building' && !cards.pinned) cards.hide();
  };

  const input = new CityInput(o.canvas, camera, {
    active: () => visible,
    hover: (sx, sy, inside) => {
      mouse = inside ? { x: sx, y: sy } : null;
    },
    click: onClick,
    interact: () => {
      following = false;
      camera.stop();
    },
    zoomStep: (steps, sx = camera.viewW / 2, sy = camera.viewH / 2) => camera.zoomAt(camera.stepZoom(steps), sx, sy, Date.now(), true),
    use: () => {
      if (!me) return;
      const d = nearestDoor(me.x, me.y, (lot) => !!state.buildingAt(lot), 1.8);
      if (!d) {
        showToast(tr('Chegue perto da porta de um prédio e aperte E.'));
        return;
      }
      const b = state.buildingAt(d.lot);
      showToast(b ? tr('Visitar o prédio de {0}: em breve.', [b.owner.name]) : tr('Visitar: em breve.'));
    },
    recenter: () => recenter(),
    moved: () => {
      following = true;
    },
  });

  const recenter = () => {
    following = true;
    if (!me) return;
    const c = camera.centerFor(me.x * TILE, me.y * TILE - 12, camera.zoom);
    camera.animateTo(c.x, c.y, camera.zoom, Date.now(), 360);
  };

  // ------------------------------------------------------------------ laço

  const loop = (ts: number) => {
    raf = requestAnimationFrame(loop);
    const gap = lastTs ? ts - lastTs : 16.7;
    const dt = lastTs ? Math.min(0.1, Math.max(0, gap / 1000)) : 1 / 60;
    lastTs = ts;
    rafGaps.push(gap);
    if (rafGaps.length > 240) rafGaps.shift();
    const now = performance.now();
    try {
      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      if (o.canvas.clientWidth !== camera.viewW || o.canvas.clientHeight !== camera.viewH || dpr !== camera.dpr) resize();
      const self = state.me;
      if (me && self) {
        me.update(dt, input.intent());
        sender?.tick(now, me);
      }
      const target = following && me ? camera.centerFor(me.x * TILE, me.y * TILE - 12, camera.zoom) : null;
      camera.update(Date.now(), target, dt);
      const door = me ? nearestDoor(me.x, me.y, (lot) => !!state.buildingAt(lot), 1.8) : null;
      renderer.frame(now, dt, o.options(), me && self ? { player: me, self } : null, {
        building: hovered?.type === 'building' ? hovered.id : cards.kind === 'building' ? cards.id : null,
        player: hovered?.type === 'player' ? hovered.id : cards.kind === 'player' ? cards.id : null,
        door: door ? door.front : null,
        me: me ? { x: me.x, y: me.y } : null,
      });
      frameMs.push(renderer.lastFrameMs);
      if (frameMs.length > 240) frameMs.shift();
      updateHover();
      // o cartão do prédio acompanha mudanças (likes, estado); some se o prédio sumiu
      if (cards.kind === 'building' && cards.id && !state.buildings.has(cards.id)) cards.hide();
      if (cards.kind === 'player' && cards.id && !state.players.has(cards.id)) cards.hide();
      if (me) {
        const tl = camera.screenToWorld(0, 0);
        const br = camera.screenToWorld(camera.viewW, camera.viewH);
        minimap.draw(state.minimap, state.minimapVersion, me, { x: tl.x / TILE, y: tl.y / TILE, w: (br.x - tl.x) / TILE, h: (br.y - tl.y) / TILE });
      }
    } catch (err) {
      console.error('[cidade] erro no frame', err);
    }
  };

  const onVisibility = () => {
    lastTs = 0;
    input.clearKeys();
  };

  // ------------------------------------------------------------------ API

  const scene: CityScene = {
    get visible() {
      return visible;
    },
    show() {
      if (visible) return;
      visible = true;
      o.canvas.hidden = false;
      layer.hidden = false;
      resize();
      if (!camera.animating) camera.zoom = camera.viewW < 600 ? 1.5 : 2;
      openStream();
      lastTs = 0;
      raf = requestAnimationFrame(loop);
      window.addEventListener('resize', resize);
      document.addEventListener('visibilitychange', onVisibility);
      keepAlive = setInterval(() => {
        if (document.hidden && me && sender) sender.keepAlive(Date.now(), me);
      }, KEEPALIVE_MS);
    },
    hide() {
      if (!visible) return;
      visible = false;
      cancelAnimationFrame(raf);
      o.canvas.hidden = true;
      layer.hidden = true;
      cards.hide();
      input.clearKeys();
      closeStream();
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibility);
      if (keepAlive) clearInterval(keepAlive);
      keepAlive = null;
    },
    zoomBy(factor) {
      if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return;
      camera.zoomAt(camera.stepZoom(factor > 1 ? 1 : -1), camera.viewW / 2, camera.viewH / 2, Date.now(), true);
    },
    recenter,
    escape() {
      if (cards.open) {
        cards.hide();
        return true;
      }
      return false;
    },
    destroy() {
      scene.hide();
      input.destroy();
      layer.remove();
    },
    perf() {
      const sorted = [...frameMs].sort((a, b) => a - b);
      const avg = frameMs.reduce((s, v) => s + v, 0) / Math.max(1, frameMs.length);
      const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
      const gapAvg = rafGaps.reduce((s, v) => s + v, 0) / Math.max(1, rafGaps.length);
      return { frames: frameMs.length, drawAvgMs: avg, drawP95Ms: p95, fps: gapAvg ? 1000 / gapAvg : 0, buildings: renderer.buildingsDrawn.length, zoom: camera.zoom };
    },
    camera,
    get state() {
      return state;
    },
    perfReset() {
      frameMs.length = 0;
      rafGaps.length = 0;
    },
    me: () => (me ? { x: me.x, y: me.y, moving: me.moving, seated: !!me.seat } : null),
    toScreen: (x, y) => camera.worldToScreen(x * TILE, y * TILE),
  };
  return scene;
}

/** Texto de um `notice` (ids traduzidos aqui; um id desconhecido vira um aviso genérico). */
export function noticeText(id: string): string {
  switch (id) {
    case 'rate_limited':
      return tr('Devagar: o mundo pediu um tempo entre as ações.');
    case 'maintenance':
      return tr('O Habblaud World vai entrar em manutenção em breve.');
    case 'position_corrected':
      return tr('O mundo corrigiu a sua posição.');
    default:
      return tr('Aviso do Habblaud World.');
  }
}
