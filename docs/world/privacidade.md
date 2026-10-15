# Habblaud World: o que sai do seu computador

O Habblaud World é uma cidade online onde cada Habblaud vira um prédio: quem passa na rua vê, ao vivo, quantos projetos
e agentes você está rodando e o que cada personagem está fazendo. A regra que guia tudo aqui:

> **Com os dados que saem não dá para saber quem você é nem em que trabalha.**

**Situação hoje:** o World está em desenvolvimento e vem **desligado**. Sem `HABBLAUD_WORLD_URL` (veja o README), nada
aparece e nada sai do computador. Esta página é a lista completa do que pode sair quando ele estiver ligado; qualquer
mudança nela entra no código e nesta página no mesmo pull request.

## O que sai hoje (conta e personagem)

Nesta primeira fase, só a conta e o personagem existem. O prédio ainda não sobe. Ao usar o World, sai do computador,
por HTTPS, para o servidor do mundo:

| Sai | Quando | Por quê |
| --- | --- | --- |
| E-mail e senha | No cadastro, ao entrar e ao trocar a senha | Para a conta existir. A senha não fica gravada no computador; no servidor, só um hash (Argon2id) |
| Código de 6 dígitos | Ao confirmar o e-mail ou trocar a senha | Provar que o e-mail é seu |
| Idioma da interface (`pt-BR`, `en`, `es` ou `fr`) | No cadastro | Para os e-mails virem no seu idioma |
| Aceite dos Termos de Uso (só a versão, `v1`) e o código de convite, se você tiver um | No cadastro | Registrar o aceite; o convite põe a conta no próximo lote da lista de espera |
| Solução do desafio anti-robô (ALTCHA) | No cadastro, nos pedidos de e-mail e, se o servidor pedir, ao entrar | É só um número calculado pelo seu Habblaud, no lugar de um captcha |
| Personagem: nome de jogador, aparência (cores e estilos), 2 ou 3 traços e a frase de apresentação | Ao salvar o personagem | É o que os outros jogadores vão ver |
| Preferências de visibilidade (ao vivo ou discreto, fechado a visitas, esconder o país, mostrar tokens...) | Ao salvar | Para o mundo respeitar a sua escolha |
| Token do dispositivo | Em cada chamada da conta | Provar que é você, sem mandar a senha de novo |
| Qual dispositivo desconectar | Ao desconectar um | Só o id que o próprio servidor deu ao dispositivo |
| Versão do Habblaud | Em toda chamada, no cabeçalho `User-Agent` (`Habblaud/0.11.0`) | Compatibilidade e diagnóstico |

Enquanto a conta está na lista de espera, o Habblaud aberto pergunta ao servidor do mundo, a cada 30 minutos, se o
acesso já foi liberado (`GET /v1/me`, só com o token do dispositivo, sem mais nada). Liberado ou fora da conta, para.

O servidor do mundo vê o IP da conexão (como qualquer site) e guarda só o **país**, que dá para esconder.

## A lista fechada (quando o prédio subir)

Quando o seu prédio entrar no mundo (próximas fases), sai **só** isto:

| Sai | Como | Por quê |
| --- | --- | --- |
| Tema em uso | `none`, `halloween` ou `christmas` (o "Automático" vira o tema do dia) | O prédio e o interior com o seu tema |
| Andares | Um por sala com sessão aberta: só um id aleatório, que não vem do caminho da pasta e **troca a cada 24 h** (com sorteio de ±6 h). Sem horário nenhum | Altura do prédio e as salas do interior. Quem visita hoje e amanhã não sabe se é o mesmo projeto |
| Agentes | Por agente: id aleatório, principal ou subagente (e o id do pai), ferramenta (`claude` ou `codex`), status (`working`, `waiting`, `idle`, `shell`), dica visual (`f`/`m`), um nome sorteado (nunca o nome do escritório, editado ou não) e as cores e estilos da aparência. **Sem** "desde quando" | O personagem fazendo a coisa certa na mesa certa |
| Consumo de tokens | Total do prédio no dia e na semana, arredondado a 2 algarismos; os outros só veem a **faixa** (até 100 mil, 1 milhão, 10 milhões, 100 milhões, acima). Dá para desligar | O medidor da fachada |
| Tarefas concluídas | Por agente, só a faixa do dia (0, 1–2, 3–5, 6+); nunca o título | O "+1" sobre a cabeça do personagem |
| Compactação de contexto (se você ligar) | Só o fato de ter acontecido | A lixeira da sala enche |
| Versão do Habblaud | `1.0.0` | Compatibilidade |
| Idioma da interface | `pt-BR`, `en`, `es` ou `fr`, na primeira mensagem da conexão | Para os avisos virem no seu idioma; não vai no pacote do prédio |
| Primeira mensagem da conexão | O token do dispositivo, a versão, o idioma e o commit do build, com a marca de "cópia modificada" | Autenticar e saber se é uma versão oficial; nunca o caminho da pasta nem nada da máquina |
| Comandos do seu personagem no mundo | Andar, entrar e sair de prédios, like, cumprimento, perfil, bloqueio, denúncia | São seus no mundo, nunca do escritório |

Mais nada. O pacote de um escritório com 3 projetos e 5 agentes tem uns 2 KB. O servidor confere cada campo (nomes
dentro da lista de nomes, cores dentro das paletas, ids no formato, no máximo 64 andares, 64 agentes por andar e 256
no total) e recusa o pacote inteiro se aparecer qualquer campo fora da lista.

### Exemplo real de um pacote

```json
{
  "v": 1,
  "version": "1.0.0",
  "theme": "halloween",
  "floors": [
    {
      "id": "f_8c1e5f7a2b",
      "agents": [
        { "id": "a_3f9d2c7e", "kind": "main", "provider": "claude", "status": "working",
          "look": "f", "name": "Marina",
          "parts": { "skin": "#e8b48c", "hair": "#2b1d14", "hairStyle": "bob", "eyes": "#3b5a7a", "top": "#4a6fa5",
                     "topStyle": "hoodie", "bottom": "#2f3542", "bottomStyle": "pants", "shoes": "#ffffff",
                     "accessory": "glasses", "accessoryColor": "#222222", "facialHair": "none" } },
        { "id": "a_71c0b5a9", "kind": "sub", "parentId": "a_3f9d2c7e", "provider": "claude", "status": "working",
          "look": "m", "name": "Caio", "parts": { "...": "..." } }
      ]
    },
    { "id": "f_02aa91c4de",
      "agents": [ { "id": "a_b2e74d10", "kind": "main", "provider": "codex", "status": "idle",
                    "look": "m", "name": "Rafael", "parts": { "...": "..." } } ] }
  ]
}
```

(`"...": "..."` abrevia peças iguais às da Marina. O formato exato está em
[`shared/world/schema.json`](../../shared/world/schema.json), e um teste confere este exemplo contra ele.)

## O que nunca sai

| Nunca sai | Exemplos |
| --- | --- |
| Caminho e nome do projeto, nome que você deu à sala | `/Users/voce/projetos/cliente-x`, "Projeto secreto" |
| Título da sessão, branch, modo de permissão, modelo | "Corrigir o login", `feat/pagamentos`, `opus` |
| O que os agentes fazem | Atividades, tarefas, comandos, shells, pedidos de permissão, perguntas, mensagens, o terminal |
| Custo e números de trabalho | Dinheiro gasto, linhas de código, chamadas de ferramenta (tokens saem só como o total do prédio, arredondado) |
| A sua conta do Claude ou do Codex | E-mail, organização, plano, uso de 5 horas e semanal |
| O nome que você deu a um personagem | Pode ser o seu nome real: no mundo, o personagem ganha outro nome sorteado |
| A semente do personagem | A aparência no mundo é sorteada a partir de um id aleatório; só as peças escolhidas no editor sobem iguais |
| Coisas da máquina | Nome do computador, usuário do sistema, fuso horário. O dispositivo aparece só como "Dispositivo 1/2/3" |
| O seu histórico | Estatísticas do Meu dia, a linha do tempo do timelapse, o histórico de sessões |
| Agentes do modo demonstração | Ficam de fora antes de montar o pacote |

## Ao vivo, sem identificar ninguém

O que aparece para quem visita: **quem visita o mundo vê, ao vivo, quantos projetos e agentes você está rodando e o
que cada personagem está fazendo (trabalhando, esperando, à toa). Ninguém vê quais projetos são, o que os agentes
fazem, nem quem você é: só o nickname e o avatar que você escolheu.**

- **Ninguém é identificado:** só o nickname e o avatar que você escolheu e o país do IP (dá para esconder). Sem e-mail,
  nome real, nome de conta ou máquina.
- **Nenhum projeto é identificável:** os ids dos andares são aleatórios e trocam a cada 24 h (±6 h), com a ordem das
  salas embaralhada.
- **Nenhum horário do escritório sai:** o pacote não tem "desde quando" nem nada de tempo. A visita mostra o status,
  nunca "há quanto tempo".
- **Nenhum histórico do prédio fica:** do prédio, o servidor guarda só o dia do último sinal e o mês em que entrou no
  mundo. Não existe linha do tempo de prédio nem "visto por último".
- **Sem feed global:** cada pessoa só recebe o pedaço da cidade em volta do personagem dela; nenhuma rota lista
  prédios ou jogadores.
- **Nada prova que você está no computador:** os agentes trabalham sozinhos. O cartão diz "aceso" ou "apagado" sobre o
  prédio, nunca "online" sobre a pessoa.
- **Modo discreto:** só aceso ou apagado e o número de andares, sem contadores nem status. **Fechado a visitas:**
  ninguém entra.
- **Bloqueio nos dois sentidos:** quem você bloqueia some para você e você some para essa pessoa, inclusive o prédio.

Dito com clareza: quem observar o mesmo prédio por muito tempo pode notar padrões (mais agentes em dias úteis, por
exemplo). Quem não quiser nem isso usa o modo discreto ou pausa.

## Neste computador

- A conta do World fica em `~/.habblaud/world.json` (no Docker, no volume `/data`), com permissão só para o seu
  usuário. O token do dispositivo sai dali só para o servidor do mundo, por HTTPS, e nunca vai para o navegador, para
  os logs ou para a URL.
- A seção do World só funciona pelo próprio computador (`http://localhost`), nunca pelo celular, e só com o Habblaud
  acessível apenas pelo próprio computador. Como acontece com as mensagens pelo escritório, qualquer programa deste
  computador que alcance o `localhost` consegue agir pela conta.
- **Sair** apaga o token deste computador e o desconecta no servidor. A lista de dispositivos mostra onde a conta está
  conectada (até 3) e desconecta um por um.

## Como a garantia é mantida

1. **O protocolo é público e fechado:** [`shared/world/protocol.ts`](../../shared/world/protocol.ts) e
   [`schema.json`](../../shared/world/schema.json) definem cada campo; o servidor recusa qualquer outro.
2. **Um arquivo só monta o pacote do prédio** (próximas fases), com testes que conferem cada chave e que nenhum texto
   do escritório (caminhos, títulos, comandos, nomes) aparece no pacote.
3. **Você vê o que foi enviado:** Configurações › Habblaud World › Ver o que foi enviado mostrará o JSON exato da última
   remessa (próximas fases).
4. **Código aberto:** quem revisa um pull request que mexe em `shared/world/` ou `server/world/` confere esta lista
   contra o que o código manda ([`CONTRIBUTING.md`](../../CONTRIBUTING.md)).
