// O texto de cada aviso do servidor do mundo na cena (`notice {level, text}`): o `text` é um id de NOTICE_IDS do
// protocolo, traduzido aqui (o servidor nunca manda frases).
import { tr } from '../../../../shared/i18n';
import type { NoticeId } from '../../../../shared/world/protocol';

/**
 * Texto de um `notice` (o `text` é um id de NOTICE_IDS do protocolo, traduzido aqui; um id desconhecido vira um aviso
 * genérico). null = nada para mostrar (ids que só interessam a quem depura). Um id novo no protocolo sem `case` aqui
 * não compila.
 */
export function noticeText(raw: NoticeId | (string & {})): string | null {
  const id = raw as NoticeId;
  switch (id) {
    case 'ignored':
    case 'invalid':
    case 'view_required':
      return null;
    case 'rate_limited':
      return tr('Devagar: o mundo pediu um tempo entre as ações.');
    case 'not_found':
      return tr('Essa pessoa não está mais por perto.');
    case 'street_left':
      return tr('Você ficou um bom tempo parado e saiu da rua: ande para voltar.');
    case 'chunk_full':
      return tr('A área está cheia: só os jogadores mais perto aparecem.');
    case 'afk':
      return tr('Você ficou um tempo parado.');
    case 'server_restart':
      return tr('O Habblaud World vai reiniciar: a conexão cai e volta sozinha.');
    case 'left':
      return tr('Sua conta saiu do mundo: o prédio volta com "Voltar ao mundo", em Configurações.');
    case 'too_far':
      return tr('Chegue mais perto da porta para entrar.');
    case 'closed':
      return tr('Este prédio está fechado a visitas.');
    case 'blocked':
      return tr('Você não pode entrar neste prédio.');
    case 'full':
      return tr('O prédio está lotado (20 visitantes). Tente daqui a pouco.');
    case 'daily_limit':
      return tr('Limite do dia atingido: amanhã tem mais.');
    case 'already_done':
      return tr('Você já fez isso hoje.');
    default:
      void (id satisfies never);
      return tr('Aviso do Habblaud World.');
  }
}
