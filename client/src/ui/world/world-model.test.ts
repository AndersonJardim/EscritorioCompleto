import { describe, expect, it } from 'vitest';
import { PART_KEYS } from '../../../../shared/appearance';
import { TRAIT_IDS } from '../../../../shared/world/traits';
import { WORLD_ERROR_CODES, type WorldMeta } from '../../net/world';
import {
  characterProblem,
  codeLooksValid,
  draftAppearance,
  emailLooksValid,
  fullParts,
  initialWorldUi,
  normalizeCode,
  parsePlayerName,
  passwordProblem,
  playerNameKey,
  screensFor,
  shouldShowInvite,
  singleScript,
  toggleTrait,
  traitBlock,
  traitsValid,
  worldErrorText,
  worldReduce,
  worldSectionMode,
  type WorldGate,
  type WorldUi,
} from './world-model';

const LOCAL: WorldGate = { remote: false, local: true, terminal: true, fake: false };
const meta = (state: WorldMeta['state'], extra: Partial<WorldMeta> = {}): WorldMeta => ({ enabled: true, configured: true, state, ...extra });

describe('quando a seção aparece', () => {
  it('sem meta.world ou com enabled:false, nada do World', () => {
    expect(worldSectionMode(undefined, LOCAL)).toBe('hidden');
    expect(worldSectionMode(meta('logged_out', { enabled: false }), LOCAL)).toBe('hidden');
  });

  it('sem servidor configurado: a seção mostra "desligado"', () => {
    expect(worldSectionMode(meta('off', { configured: false }), LOCAL)).toBe('off');
    expect(worldSectionMode(meta('off'), LOCAL)).toBe('off');
  });

  it('pela porta remota (celular), some; sem a trava do terminal ou fora do localhost, só o aviso', () => {
    expect(worldSectionMode(meta('logged_out'), { ...LOCAL, remote: true })).toBe('hidden');
    expect(worldSectionMode(meta('logged_out'), { ...LOCAL, terminal: false })).toBe('local_only');
    expect(worldSectionMode(meta('logged_out'), { ...LOCAL, local: false })).toBe('local_only');
    expect(worldSectionMode(meta('waiting'), LOCAL)).toBe('active');
  });

  it('no modo demonstração (falso) as travas não valem, mas a porta remota continua escondendo', () => {
    expect(worldSectionMode(meta('logged_out'), { remote: false, local: false, terminal: false, fake: true })).toBe('active');
    expect(worldSectionMode(meta('logged_out'), { remote: true, local: false, terminal: false, fake: true })).toBe('hidden');
  });
});

describe('cartão de convite', () => {
  const gate = { ...LOCAL, replaying: false };

  it('só para quem não tem conta, com servidor configurado, uma vez por navegador', () => {
    expect(shouldShowInvite(meta('logged_out'), gate, null)).toBe(true);
    expect(shouldShowInvite(meta('logged_out'), gate, 'seen')).toBe(false);
    for (const s of ['waiting', 'approved', 'off'] as const) expect(shouldShowInvite(meta(s), gate, null), s).toBe(false);
    expect(shouldShowInvite(meta('logged_out', { configured: false }), gate, null)).toBe(false);
    expect(shouldShowInvite(meta('logged_out', { enabled: false }), gate, null)).toBe(false);
    expect(shouldShowInvite(undefined, gate, null)).toBe(false);
  });

  it('nunca no celular pela porta remota, fora do computador ou no timelapse', () => {
    expect(shouldShowInvite(meta('logged_out'), { ...gate, remote: true }, null)).toBe(false);
    expect(shouldShowInvite(meta('logged_out'), { ...gate, local: false }, null)).toBe(false);
    expect(shouldShowInvite(meta('logged_out'), { ...gate, replaying: true }, null)).toBe(false);
  });
});

describe('máquina de estados da seção', () => {
  const at = (server: WorldUi['server'], screen: WorldUi['screen'] = 'welcome'): WorldUi => ({ ...initialWorldUi(), server, screen });

  it('sem conta começa nas boas-vindas; com conta (na espera ou liberada), no início da conta', () => {
    expect(worldReduce(initialWorldUi(), { type: 'server', state: 'logged_out' }).screen).toBe('welcome');
    expect(worldReduce(initialWorldUi(), { type: 'server', state: 'waiting' }).screen).toBe('home');
    expect(worldReduce(initialWorldUi(), { type: 'server', state: 'approved' }).screen).toBe('home');
    expect(screensFor('off')).toEqual([]);
  });

  it('cadastro aceito vai para o código, guardando o e-mail', () => {
    const s = worldReduce(at('logged_out', 'register'), { type: 'code_sent', email: 'a@b.co' });
    expect(s).toMatchObject({ screen: 'verify', email: 'a@b.co', flash: 'code_sent' });
  });

  it('código confirmado: o status novo (na espera) leva ao início da conta', () => {
    const s = worldReduce(at('logged_out', 'verify'), { type: 'server', state: 'waiting' });
    expect(s.screen).toBe('home');
  });

  it('esqueci a senha → código e senha nova → login com o aviso', () => {
    let s = worldReduce(at('logged_out', 'login'), { type: 'go', screen: 'forgot' });
    s = worldReduce(s, { type: 'reset_code_sent', email: 'a@b.co' });
    expect(s).toMatchObject({ screen: 'reset', email: 'a@b.co' });
    s = worldReduce(s, { type: 'password_changed' });
    expect(s).toMatchObject({ screen: 'login', flash: 'password_changed', email: 'a@b.co' });
  });

  it('telas da conta não abrem sem conta, e as de entrar não abrem com conta', () => {
    expect(worldReduce(at('logged_out'), { type: 'go', screen: 'character' }).screen).toBe('welcome');
    expect(worldReduce(at('waiting', 'home'), { type: 'go', screen: 'register' }).screen).toBe('home');
    expect(worldReduce(at('waiting', 'home'), { type: 'go', screen: 'character' }).screen).toBe('character');
  });

  it('saiu da conta (ou o dispositivo foi revogado em outro lugar): volta às boas-vindas', () => {
    const s = worldReduce(at('approved', 'devices'), { type: 'server', state: 'logged_out' });
    expect(s.screen).toBe('welcome');
  });

  it('entrar apaga o aviso da tela de entrada ("Senha trocada")', () => {
    const s = worldReduce(at('logged_out', 'login'), { type: 'password_changed' });
    expect(worldReduce(s, { type: 'signed_in' }).flash).toBeNull();
  });

  it('navegar apaga o aviso; um aviso novo não muda a tela', () => {
    let s = worldReduce(at('logged_out', 'verify'), { type: 'flash', flash: 'code_resent' });
    expect(s).toMatchObject({ screen: 'verify', flash: 'code_resent' });
    s = worldReduce(s, { type: 'go', screen: 'welcome' });
    expect(s.flash).toBeNull();
  });
});

describe('e-mail, código e senha', () => {
  it('e-mail com cara de e-mail', () => {
    expect(emailLooksValid(' voce@exemplo.com ')).toBe(true);
    for (const bad of ['', 'voce', 'voce@', '@exemplo.com', 'voce@exemplo', 'vo ce@exemplo.com']) expect(emailLooksValid(bad), bad).toBe(false);
  });

  it('código: só os 6 dígitos (colar "123 456" vale)', () => {
    expect(normalizeCode('123 456')).toBe('123456');
    expect(normalizeCode('12-34-56-78')).toBe('123456');
    expect(codeLooksValid('123 456')).toBe(true);
    expect(codeLooksValid('12345')).toBe(false);
  });

  it('senha: de 12 a 128 caracteres contados em código (não em UTF-16)', () => {
    expect(passwordProblem('curta')).toBe('short');
    expect(passwordProblem('a'.repeat(11) + 'b')).toBeNull();
    expect(passwordProblem('🙂'.repeat(11))).toBe('short');
    expect(passwordProblem('🙂'.repeat(11) + 'x')).toBeNull();
    expect(passwordProblem('x'.repeat(129) + 'y')).toBe('long');
  });

  it('senha: nem o e-mail, nem só repetição', () => {
    expect(passwordProblem('voce.da.silva@exemplo.com', 'Voce.da.Silva@exemplo.com')).toBe('email');
    expect(passwordProblem('voce.da.silva', 'voce.da.silva@exemplo.com')).toBe('email');
    expect(passwordProblem('aaaaaaaaaaaa')).toBe('repeated');
    expect(passwordProblem('abcabcabcabc')).toBe('repeated');
    expect(passwordProblem('cavalo correto bateria grampo')).toBeNull();
  });
});

describe('nome de jogador', () => {
  it('de 3 a 20 caracteres depois de NFC e das pontas aparadas', () => {
    expect(parsePlayerName('  Ana  ')).toEqual({ ok: true, name: 'Ana' });
    expect(parsePlayerName('Al')).toEqual({ ok: false, problem: 'length' });
    expect(parsePlayerName('a'.repeat(21))).toEqual({ ok: false, problem: 'length' });
    // "Júlia" em NFD tem 6 unidades; em NFC, 5 caracteres.
    expect(parsePlayerName('Júlia')).toEqual({ ok: true, name: 'Júlia' });
  });

  it('letras, dígitos, espaço, _ - . e nada invisível', () => {
    expect(parsePlayerName('dev_42.x-y z').ok).toBe(true);
    for (const bad of ['ana!', 'ana@b', 'ana\tb', 'a​na', 'ana‮b', 'emoji🙂']) expect(parsePlayerName(bad).ok, JSON.stringify(bad)).toBe(false);
  });

  it('um só sistema de escrita (japonês e coreano misturam o que é deles)', () => {
    expect(parsePlayerName('Mаria').ok).toBe(false); // "а" cirílico
    expect(parsePlayerName('Мария').ok).toBe(true);
    expect(singleScript('山田たろう')).toBe(true);
    expect(singleScript('김민준金')).toBe(true);
    expect(singleScript('Anaたろう')).toBe(false);
  });

  it('reservados não passam (comparados pela chave sem acento nem maiúscula)', () => {
    expect(parsePlayerName('Habblaud')).toEqual({ ok: false, problem: 'reserved' });
    expect(parsePlayerName('ADMIN')).toEqual({ ok: false, problem: 'reserved' });
    expect(parsePlayerName('Suporte')).toEqual({ ok: false, problem: 'reserved' });
  });

  it('chave de unicidade: NFKC, minúsculas, sem diacríticos, espaços colapsados', () => {
    expect(playerNameKey('Júlia  B')).toBe('julia b');
    expect(playerNameKey('ＡＢＣ')).toBe('abc');
    expect(playerNameKey('Júlia')).toBe(playerNameKey('JULIA'));
  });
});

describe('traços', () => {
  it('2 ou 3, sem repetir e sem os pares que não combinam', () => {
    expect(traitsValid(['cafeina'])).toBe(false);
    expect(traitsValid(['cafeina', 'games'])).toBe(true);
    expect(traitsValid(['cafeina', 'games', 'leitura'])).toBe(true);
    expect(traitsValid(['cafeina', 'games', 'leitura', 'calma'])).toBe(false);
    expect(traitsValid(['cafeina', 'cafeina'])).toBe(false);
    expect(traitsValid(['timidez', 'piadas'])).toBe(false);
    expect(traitsValid(['inventado', 'games'])).toBe(false);
  });

  it('os cinco pares do contrato estão bloqueados nos dois sentidos', () => {
    const pairs = [['timidez', 'piadas'], ['timidez', 'fofoca'], ['apostas', 'economia'], ['esporte', 'sonecas'], ['calma', 'competicao']] as const;
    for (const [a, b] of pairs) {
      expect(traitBlock([a], b), `${a}×${b}`).toEqual({ reason: 'clash', with: a });
      expect(traitBlock([b], a), `${b}×${a}`).toEqual({ reason: 'clash', with: b });
    }
  });

  it('com 3 escolhidos, os outros ficam desabilitados; os escolhidos sempre dá para desmarcar', () => {
    const three = ['cafeina', 'games', 'leitura'] as const;
    expect(traitBlock(three, 'series')).toEqual({ reason: 'full' });
    expect(traitBlock(three, 'games')).toBeNull();
    expect(toggleTrait(three, 'series')).toEqual([...three]);
    expect(toggleTrait(three, 'games')).toEqual(['cafeina', 'leitura']);
    expect(toggleTrait(['timidez'], 'piadas')).toEqual(['timidez']);
  });

  it('os 14 traços do escritório', () => {
    expect(TRAIT_IDS).toHaveLength(14);
  });
});

describe('personagem', () => {
  it('manda as 13 peças (o jogador não tem semente)', () => {
    for (const look of ['f', 'm'] as const) {
      const parts = fullParts(draftAppearance(look));
      expect(Object.keys(parts)).toEqual([...PART_KEYS]);
      expect(Object.values(parts).every((v) => typeof v === 'string' && v.length > 0)).toBe(true);
    }
  });

  it('as peças salvas voltam iguais ao editor', () => {
    const parts = fullParts(draftAppearance('m', undefined, 77));
    expect(fullParts(draftAppearance('m', parts))).toEqual(parts);
  });

  it('o primeiro problema: nome, depois traços, depois a frase', () => {
    expect(characterProblem({ name: 'x', traits: [], intro: null })).toEqual({ field: 'name', problem: 'length' });
    expect(characterProblem({ name: 'Pixel', traits: ['games'], intro: null })).toEqual({ field: 'traits' });
    expect(characterProblem({ name: 'Pixel', traits: ['games', 'cafeina'], intro: null })).toEqual({ field: 'intro' });
    expect(characterProblem({ name: 'Pixel', traits: ['games', 'cafeina'], intro: 'coffee' })).toBeNull();
  });
});

describe('erros', () => {
  it('todo código tem texto próprio (nenhum cai no genérico, menos o desconhecido)', () => {
    const generic = worldErrorText('qualquer-coisa', 'status');
    for (const code of WORLD_ERROR_CODES) {
      const text = worldErrorText(code, 'register');
      expect(text, code).toBeTruthy();
      if (code !== 'unknown') expect(text, code).not.toBe(generic);
    }
  });

  it('"invalid" diz o que foi recusado, conforme a ação', () => {
    const texts = new Set((['register', 'character', 'visibility', 'revoke'] as const).map((a) => worldErrorText('invalid', a)));
    expect(texts.size).toBe(4);
  });
});
