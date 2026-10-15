// Avisos do mundo na cena: cada id de NOTICE_IDS tem o seu texto (ou nada, se só interessa a quem depura), e um id
// que esta versão não conhece vira o genérico.
import { describe, expect, it } from 'vitest';
import { NOTICE_IDS } from '../../../../shared/world/protocol';
import { noticeText } from './notice';

describe('noticeText', () => {
  it('cada id do protocolo tem um texto próprio ou nenhum; um id desconhecido leva o genérico', () => {
    const generic = noticeText('id_novo');
    expect(generic).toBeTruthy();
    const texts = NOTICE_IDS.map((id) => noticeText(id));
    expect(texts.filter((t) => t === null)).toHaveLength(3);
    const shown = texts.filter((t): t is string => t !== null);
    expect(new Set([...shown, generic]).size).toBe(shown.length + 1);
  });
});
