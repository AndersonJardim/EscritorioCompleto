// Frases de apresentação do personagem do Habblaud World: o jogador escolhe uma da lista (não há bio livre: o nome é o
// único texto livre do produto). No fio vai só o id; o texto é traduzido em quem lê. Na junção com o servidor, os ids
// podem ir para shared/world/intro.ts (a mesma lista do contrato, na mesma ordem).
import { tr } from '../../../../shared/i18n';

/** Ordem fixa do contrato (é a ordem do menu). */
export const INTRO_IDS = [
  'night_owl',
  'early_bird',
  'coffee',
  'tea',
  'tabs',
  'spaces',
  'dark_mode',
  'light_mode',
  'vim',
  'tests_first',
  'ship_fast',
  'refactor',
  'pixel_art',
  'music',
  'silence',
  'cats',
  'dogs',
  'open_source',
  'learning',
  'hello',
] as const;

export type IntroId = (typeof INTRO_IDS)[number];

/** Montado a cada chamada: o dicionário do idioma pode chegar depois que este módulo carrega. */
function labels(): Record<IntroId, string> {
  return {
    night_owl: tr('Codo de madrugada'),
    early_bird: tr('Acordo cedo para codar'),
    coffee: tr('Movido a café'),
    tea: tr('Time do chá'),
    tabs: tr('Time dos tabs'),
    spaces: tr('Time dos espaços'),
    dark_mode: tr('Modo escuro sempre'),
    light_mode: tr('Modo claro, sem medo'),
    vim: tr('Vim até o fim'),
    tests_first: tr('Testo antes de escrever'),
    ship_fast: tr('Entrego rápido'),
    refactor: tr('Refatorar é meu hobby'),
    pixel_art: tr('Fã de pixel art'),
    music: tr('Codo ouvindo música'),
    silence: tr('Codo em silêncio'),
    cats: tr('Gente de gato'),
    dogs: tr('Gente de cachorro'),
    open_source: tr('Vivo de código aberto'),
    learning: tr('Sempre aprendendo'),
    hello: tr('Oi, prazer!'),
  };
}

export function isIntroId(v: unknown): v is IntroId {
  return typeof v === 'string' && (INTRO_IDS as readonly string[]).includes(v);
}

/** Texto da frase no idioma da interface (id desconhecido: o próprio id). */
export function introLabel(id: string): string {
  return isIntroId(id) ? labels()[id] : id;
}
