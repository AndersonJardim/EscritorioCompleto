// Botão Mundo na barra do topo: troca o escritório pela cidade do Habblaud World e volta (botão Escritório ou Esc).
// Só aparece com a cena disponível: `meta.world.scene.available` do servidor local (no modo demonstração, com a
// conta liberada), nunca no timelapse. A cena em si é montada por app.ts (CitySceneHost); aqui fica o botão, o
// estado "na cidade" da interface (classe `is-city` no #ui) e a ida e volta.
import { tr } from '../../../../shared/i18n';
import type { WorldSource } from '../../net/world';
import type { UiComponent, UiContext } from '../context';
import { h, setAttr, setHidden, setText, setTitle } from '../dom';
import { ICONS } from '../icons';

/** O que a interface precisa da cena da cidade (implementado em app.ts, com a cena carregada sob demanda). */
export interface CitySceneHost {
  readonly open: boolean;
  /** Mostra a cidade (carrega a cena na primeira vez) e esconde o escritório. */
  show(): Promise<void>;
  hide(): void;
  zoomBy(factor: number): void;
  recenter(): void;
  /** Esc: fecha o que estiver aberto na cidade (cartão); false = nada para fechar. */
  escape(): boolean;
}

/**
 * A cena Mundo está disponível? `meta.world.scene.available` (do servidor local: conta liberada, personagem criado, a
 * trava do terminal e sem banimento nem suspensão; no modo demonstração, o do FakeWorldApi); sem o campo, não.
 */
export function citySceneAvailable(src: WorldSource): boolean {
  return src.meta()?.scene?.available === true;
}

export class SceneSwitch implements UiComponent {
  readonly button: HTMLButtonElement;
  private readonly icon: HTMLElement;
  private readonly label: HTMLElement;
  private busy = false;
  private autoOpen: boolean;

  constructor(
    private readonly ctx: UiContext,
    private readonly src: WorldSource,
    private readonly host: CitySceneHost,
    private readonly onChange: () => void,
  ) {
    this.icon = h('span', { class: 'ui-scene-btn__icon', attrs: { 'aria-hidden': 'true' } });
    this.label = h('span', { class: 'ui-scene-btn__label' });
    this.button = h('button', { class: 'ui-scene-btn', type: 'button', hidden: true, on: { click: () => void this.toggle() } }, this.icon, this.label);
    // ?scene=city: abre direto na cidade (capturas do modo demonstração)
    this.autoOpen = typeof location !== 'undefined' && new URLSearchParams(location.search).get('scene') === 'city';
  }

  get inCity(): boolean {
    return this.host.open;
  }

  private available(): boolean {
    return citySceneAvailable(this.src) && !this.ctx.store.replaying && !this.ctx.isTimelapseOpen();
  }

  async toggle(): Promise<void> {
    if (this.host.open) this.close();
    else await this.open();
  }

  async open(): Promise<void> {
    if (this.busy || this.host.open || !this.available()) return;
    this.busy = true;
    try {
      // a gaveta e o terminal fecham: na cidade não há agente selecionado
      if (this.ctx.selection()) this.ctx.select(null);
      await this.host.show();
      this.ctx.announce(tr('Você está na cidade do Habblaud World. Esc volta ao escritório.'));
    } catch (err) {
      console.error('[ui] a cidade não abriu', err);
    } finally {
      this.busy = false;
      this.onChange();
    }
  }

  close(): void {
    if (!this.host.open) return;
    this.host.hide();
    this.ctx.announce(tr('De volta ao escritório.'));
    this.onChange();
  }

  render(): void {
    const ok = this.available();
    // a cena saiu do ar (conta, timelapse): volta ao escritório
    if (!ok && this.host.open) this.close();
    setHidden(this.button, !ok && !this.host.open);
    const city = this.host.open;
    this.icon.innerHTML = city ? ICONS.office : ICONS.city;
    setText(this.label, city ? tr('Escritório') : tr('Mundo'));
    const title = city ? tr('Voltar ao escritório (Esc)') : tr('Mundo: andar pela cidade do Habblaud World');
    setTitle(this.button, title);
    setAttr(this.button, 'aria-label', title);
    setAttr(this.button, 'aria-pressed', String(city));
    this.button.classList.toggle('is-city', city);
    if (this.autoOpen && ok) {
      this.autoOpen = false;
      void this.open();
    }
  }
}
