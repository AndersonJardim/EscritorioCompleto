// Chip do Habblaud World na barra do topo, ao lado da versão: "🏙️ no mundo" com o prédio aceso, "⏸ pausado",
// "reconectando…" quando a conexão caiu e "⚠️ parado" quando o servidor do mundo parou o prédio. Só com
// `meta.world.building` (conta aprovada; fora do mundo, nada) e nunca no celular pela porta remota (worldChipState).
// Um clique abre Configurações › Habblaud World, onde estão o cartão "Seu prédio", a pausa e o motivo de uma parada.
import { tr } from '../../../../shared/i18n';
import type { WorldSource } from '../../net/world';
import type { UiComponent, UiContext } from '../context';
import { h, setAttr, setHidden, setText, setTitle, setVariant } from '../dom';
import { worldGate } from './settings-world';
import { agentsText, floorsText, worldChipState, type WorldChipState } from './world-model';

const ICON: Record<WorldChipState, string> = { live: '🏙️', paused: '⏸', reconnecting: '🏙️', stopped: '⚠️' };

export class WorldChip implements UiComponent {
  readonly el: HTMLButtonElement;
  private readonly icon: HTMLElement;
  private readonly text: HTMLElement;

  constructor(
    private readonly ctx: UiContext,
    private readonly src: WorldSource,
    open: () => void,
  ) {
    this.icon = h('span', { class: 'ui-world-chip__icon', attrs: { 'aria-hidden': 'true' } });
    this.text = h('span', { class: 'ui-world-chip__text' });
    this.el = h('button', { class: 'ui-world-chip', type: 'button', hidden: true, attrs: { 'aria-haspopup': 'dialog' }, on: { click: open } }, this.icon, this.text);
  }

  render(): void {
    const meta = this.src.meta();
    const state = worldChipState(meta, worldGate(this.ctx, this.src));
    setHidden(this.el, !state);
    if (!state) return;
    const b = meta?.building;
    setVariant(this.el, 'is-', state);
    setText(this.icon, ICON[state]);
    const texts: Record<WorldChipState, [text: string, title: string]> = {
      live: [tr('no mundo'), tr('Seu prédio está aceso no Habblaud World: {0} e {1}. Clique para ver em Configurações.', [floorsText(b?.floors ?? 0), agentsText(b?.agents ?? 0)])],
      paused: [tr('pausado'), tr('Seu prédio está pausado e apagado no Habblaud World: nada sai deste computador. Clique para retomar em Configurações.')],
      reconnecting: [tr('reconectando…'), tr('Sem conexão com o Habblaud World agora; o Habblaud tenta de novo sozinho. Clique para ver em Configurações.')],
      stopped: [tr('parado'), tr('Seu prédio parou de subir ao Habblaud World. Clique para ver o motivo em Configurações.')],
    };
    const [text, title] = texts[state];
    setText(this.text, text);
    setTitle(this.el, title);
    setAttr(this.el, 'aria-label', title);
  }
}
