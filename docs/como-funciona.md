# Como funciona

Este documento explica o que acontece por dentro, do pedido HTTP até a resposta. Serve para
quem quer entender, auditar ou modificar a ponte.

- [Visão geral](#visão-geral)
- [O caminho de um pedido](#o-caminho-de-um-pedido)
- [O marcador](#o-marcador)
- [Lendo a resposta do site](#lendo-a-resposta-do-site)
- [Ferramentas emuladas](#ferramentas-emuladas)
- [O contrato e as correções automáticas](#o-contrato-e-as-correções-automáticas)
- [Andamento e monitor](#andamento-e-monitor)
- [Reaproveitamento de conversas](#reaproveitamento-de-conversas)
- [Abas, fila e o service worker](#abas-fila-e-o-service-worker)
- [Erros e novas tentativas](#erros-e-novas-tentativas)
- [Segurança](#segurança)

## Visão geral

```
┌─────────────┐  HTTP   ┌───────────────────────── ponte (Node.js) ─────────────────────────┐
│   cliente   │────────▶│ app.js        rotas, segurança (Origin/Host/chave), painel          │
│ (OpenCode,  │◀────────│ openai.js     formato OpenAI, streaming SSE, uso de tokens          │
│  SDK, curl) │   SSE   │ prompt.js     messages+tools → texto; chaves dos históricos         │
└─────────────┘         │ ferramentas.js protocolo <tool_call>, leitor em streaming           │
                        │ conversas.js  memória: histórico → aba que já tem esse histórico    │
                        │ extensao.js   fila, tempo limite, cancelamento                      │
                        └──────────────────────────────┬─────────────────────────────────────┘
                                                       │ WebSocket ws://127.0.0.1:4545/extensao
                        ┌──────────────────────────────┴───── extensão (Chrome) ─────────────┐
                        │ fundo.js       service worker: conexão, abas de trabalho, tarefas   │
                        │ conteudo.js    content script: campo, botão enviar, diagnóstico     │
                        │ pagina.js      script na página: troca o marcador, lê o stream      │
                        │ analisadores.js leitores SSE (app logado) e NDJSON (app mweb)       │
                        └──────────────────────────────┬─────────────────────────────────────┘
                                                       │ o próprio site faz o pedido
                                                  chatgpt.com
```

A ideia central: **quem conversa com os servidores da OpenAI é a própria página do
chatgpt.com**, com o login, os cookies e as verificações anti-robô que ela já faz. A extensão
só preenche o campo de mensagem, aperta enviar e lê a resposta. Por isso não é preciso
reimplementar nada do site, e uma mudança de servidor não quebra a ponte (só mudanças na
página podem quebrar).

## O caminho de um pedido

1. O cliente faz `POST /v1/chat/completions` com `messages`, talvez `tools` e `stream: true`.
2. `app.js` confere o `Host` (contra DNS rebinding), o `Origin` (contra sites) e a chave.
3. `openai.js` normaliza as mensagens (`prompt.js`) e calcula a chave de cada prefixo do
   histórico. Se uma aba já tem o começo desse histórico, o pedido vira **continuação**: só as
   mensagens novas são enviadas. Senão, vira **conversa nova** com o prompt completo.
4. `extensao.js` espera uma vaga (uma resposta por aba) e manda a tarefa pelo WebSocket:
   `{tipo: "tarefa", id, prompt, nova, continuar, modelo, rotulo, preferirAba}`.
5. `fundo.js` escolhe a aba: a que tem a conversa (continuação), ou uma aba livre, que ele
   leva para `chatgpt.com/?temporary-chat=true` (conversa nova).
6. `conteudo.js` arma o `pagina.js` com o prompt, escreve um **marcador** curto no campo de
   mensagem e aperta enviar.
7. A página monta o pedido de envio. `pagina.js`, que embrulha o `window.fetch`, troca o
   marcador pelo prompt completo dentro desse pedido e deixa ele seguir.
8. Quando a resposta começa a chegar, `pagina.js` lê uma cópia do stream (`Response.clone()`),
   interpreta com `analisadores.js` e repassa só o texto novo de cada pedaço.
9. Os pedaços voltam pelo caminho inverso (página → content script → service worker →
   WebSocket → ponte). `openai.js` passa o texto pelo leitor de ferramentas, que separa o texto
   normal dos blocos `<tool_call>`, e transforma tudo em pedaços SSE no formato da OpenAI.
10. No fim, a ponte manda `finish_reason` (`stop` ou `tool_calls`), o uso estimado de tokens e
    `data: [DONE]`, e guarda na memória que aquela aba agora tem esse histórico mais a resposta.

## O marcador

Em vez de digitar o prompt inteiro no campo de mensagem, a extensão digita algo como
`GPTPONTE3f9a1c0b2d4e5f60` e troca esse texto pelo prompt no corpo do pedido que a página
envia. Vantagens:

- **Fidelidade**: o editor do site não reformata nada (espaços, quebras de linha, markdown).
- **Velocidade**: escrever 50 mil caracteres num editor rico é lento; um marcador é instantâneo.
- **Sem anexo automático**: o site não transforma o texto longo em "arquivo colado".
- **Login e verificações intactos**: quem monta e assina o pedido continua sendo o site.

A troca entende corpo em JSON (o texto entra escapado), `URLSearchParams`, `FormData`, texto
`application/x-www-form-urlencoded`, `Blob`, `ArrayBuffer` e objetos `Request`. Na aba de
trabalho você vê o marcador como a sua mensagem; a resposta é ao prompt completo.

**Plano B**: só entra em ação com prova. Quem decide é o `pagina.js`, que vê o pedido de envio
desta tarefa sair **sem** o marcador no corpo (num formato que ele não sabe editar) e avisa
`envio-sem-marcador`. O content script espera 1,5 s pela confirmação da troca (`enviado`); se
ela não vem, para a geração, marca a aba para usar o modo **digitar** e responde `reenviar`. A
ponte repete a tarefa uma vez, **na mesma aba** (`preferirAba`), agora com o texto inteiro
digitado no campo. O modo também pode ser escolhido no popup.

Ver o marcador na tela não é sinal de falha: no app logado, o balão `GPTPONTE...` aparece
antes de o pedido sair. (Até a 0.2.0, um vigia olhava a tela, tomava isso por falha e repetia o
pedido em outra aba: o mesmo prompt ia duas vezes e a conversa da outra aba se perdia.)

Se o pedido não sair de jeito nenhum, um vigia de 20 s desarma a tarefa e devolve
`pagina_mudou` (ou o problema que a página mostrar), sem repetir nada.

## Lendo a resposta do site

`pagina.js` roda no contexto da página (`"world": "MAIN"`), em `document_start`, antes de
qualquer script do site, e embrulha o `window.fetch`. Ele só age quando está **armado** (logo
depois de a extensão escrever no campo) e só no pedido de envio de mensagem (um `POST` cujo
caminho termina em `/conversation` ou `/conversation/updates`). Em qualquer outra situação o
`fetch` passa direto, então as suas abas normais do ChatGPT não são afetadas.

O site usa dois formatos de resposta, e `analisadores.js` entende os dois:

**SSE (`text/event-stream`), app logado.** Os eventos `delta` são operações de patch sobre a
mensagem:

```
event: delta
data: {"p": "", "o": "add", "v": {"message": {...}, "conversation_id": "..."}, "c": 0}

event: delta
data: {"p": "/message/content/parts/0", "o": "append", "v": "Olá"}

event: delta
data: {"v": ", mundo"}            ← sem "p"/"o": repete o último caminho e operação

event: delta
data: {"p": "", "o": "patch", "v": [{"p": "/message/content/parts/0", "o": "append", "v": "!"}, ...]}

data: [DONE]
```

O leitor aplica `add`, `replace`, `append`, `truncate`, `remove` e `patch` por mensagem
(campo `c`), junta só as mensagens de texto do assistente endereçadas ao usuário e separa o
pensamento (`content_type: "thoughts"`), que vira `reasoning_content`. Mensagens para
ferramentas internas (busca, Python) e mensagens ocultas são ignoradas. O formato antigo, com
a mensagem inteira a cada evento, também é aceito.

**NDJSON (`application/vnd.openai.conversation-source+ndjson`), app "mweb".** Uma linha JSON
por evento. O texto vem em eventos `content`, no campo `markdown` ou, quando o site usa a sua
interface gerada (DIL), em `dil.fallbackMarkdown`, com o markdown **escapado**
(`\<tool\_call>`, `&amp;&amp;`, `&#124;`). O leitor desfaz o escape. Enquanto a resposta ainda
chega, ele guarda uma barra ou entidade incompleta no fim, para o texto só crescer e nunca
"desdizer" um pedaço já enviado.

**Fim da resposta.** Quando o leitor vê o evento final (`[DONE]` no SSE, `{"type": "end"}`
no NDJSON), `pagina.js` encerra a sua cópia do stream na hora. Isso importa: nos testes o
servidor às vezes deixa a conexão aberta depois do fim (o site cancela a leitura dele ao ver o
evento final), e sem isso a resposta nunca terminaria.

## Ferramentas emuladas

Quando o pedido traz `tools`, o prompt explica ao modelo um formato de pedido:

```
<tool_call>
{"name": "read", "arguments": {"path": "package.json"}}
</tool_call>
```

O texto das instruções (em `servidor/ferramentas.js`) foi ajustado em testes reais. Dizer ao
modelo que "as ferramentas são dele" o fazia responder que não tem acesso ao computador.
Funciona melhor explicar a verdade: ele não executa nada, ele **escreve um pedido** e o app
executa e devolve o resultado. As instruções trazem um exemplo completo de ida e volta, as
regras (vários blocos por resposta, parar depois dos blocos, nada de cercas de código, não usar
as ferramentas internas do ChatGPT) e a lista de ferramentas com descrição e JSON Schema.

O resultado de cada ferramenta volta ao modelo como:

```
<tool_result name="read" call_id="call_Ab12...">
...conteúdo...
</tool_result>
```

O `LeitorDeFerramentas` lê a resposta em streaming:

- emite o texto normal na hora, mas **segura** o que pode ser o começo de uma tag
  (`<tool_c...`) ou de uma cerca de código, para nada vazar pela metade;
- remove cercas ```` ``` ```` em volta dos blocos (só quando a cerca abre um bloco, não quando
  fecha um bloco de código normal) e espaços em branco entre texto e bloco;
- lê o JSON com um leitor tolerante (quebras de linha cruas dentro de strings, vírgula
  sobrando, aspas simples, `True`/`None` do Python, aspas sem escape no meio do texto);
- aceita variações (`{"tool": ..., "args": ...}`, `{"function": {...}}`, argumentos como
  string JSON, `{"bash": {...}}`) e corrige nomes (`functions.bash` → `bash`, `BASH` → `bash`);
- se a resposta termina sem `</tool_call>` mas o JSON está completo, aproveita a chamada; se
  o bloco não é JSON válido, ele volta como texto normal.

Cada chamada vira um `tool_call` com id `call_` + 24 caracteres, como na OpenAI.
`tool_choice` (`required`, `none` ou uma função) e `parallel_tool_calls: false` viram
instruções extras; com `tool_choice: "none"` a ponte nem procura blocos na resposta.

## O contrato e as correções automáticas

Para o agente se comportar como numa API de verdade, a ponte fixa algumas regras e corrige
os desvios sozinha.

**Contrato.** Toda conversa nova com ferramentas começa com o mesmo texto (em
`montarPromptInicial`, `servidor/prompt.js`), na voz de quem usa o app:

- o texto em `<system_instructions>` é o prompt de sistema;
- a personalização da conta (instruções personalizadas, memórias, outros chats) não vale
  naquela conversa;
- o modelo trabalha pelas ferramentas: ele escreve o pedido e o app executa no computador,
  então ele deve fazer o trabalho em vez de mandar o usuário rodar comandos;
- escrever só a próxima resposta, sem comentar o arranjo.

Em cada passo seguinte vai um lembrete curto com o formato do bloco e o **nome de todas as
ferramentas**, porque em conversas longas o ChatGPT esquece o começo.

**Correções na mesma conversa.** Depois de cada resposta, antes de devolver ao cliente, a
ponte confere:

| Problema | O que a ponte faz | Quantas vezes |
|---|---|---|
| Bloco `<tool_call>` com JSON inválido ou ferramenta que não existe | Devolve o motivo ao modelo ("there is no tool named X. Available tools: ...") e pede o bloco de novo | até 2 |
| Recusa no começo ("não tenho acesso ao seu computador", "I can't run commands") | Segura o começo da resposta (até 400 caracteres); se for recusa, ela não chega ao cliente e a ponte lembra o modelo de que as ferramentas funcionam | 1 |
| Resposta vazia (por exemplo, foi para um canvas) | Pede a resposta de novo, direto no chat | 1 |

A vigia de recusa só vale quando o pedido termina com uma mensagem do usuário: depois de um
resultado de ferramenta, "não consigo abrir esse arquivo" pode ser a resposta certa. Se as
correções se esgotarem, os blocos que sobraram viram texto, para o cliente ver o que houve.
Cada correção é uma mensagem a mais na mesma conversa do ChatGPT; o cliente só recebe a
versão boa.

## Andamento e monitor

**No cliente.** Enquanto o ChatGPT não escreve, a ponte manda pedaços de
`reasoning_content` com linhas `[GPT Ponte] ...`: fila, conversa nova ou continuação, página
carregando, mensagem enviada (com o tamanho), "esperando o ChatGPT… N s" a cada 10 segundos,
as correções automáticas e as repetições (conversa que sumiu, troca do marcador que falhou). O OpenCode mostra isso no bloco de raciocínio ("pensando"). Quando
o site manda o raciocínio de verdade do modelo, ele vem logo depois. As linhas de andamento
não entram na conta de tokens. `--sem-progresso` desliga.

O stream só é aberto quando a tarefa já foi entregue à extensão; até lá, os erros ainda saem
com o status HTTP certo (por exemplo, `503` se a extensão não estiver conectada).

**No monitor.** O service worker guarda as últimas 40 tarefas (`extensao/historico.js`), com
etapas e horários, o texto e o raciocínio chegando, o erro e o prompt enviado, e avisa ao vivo
as páginas `monitor.html` abertas. Os dados ficam em `chrome.storage.session` (somem quando o
navegador fecha) e não saem do navegador.

## Reaproveitamento de conversas

A API é sem estado: o cliente manda o histórico inteiro a cada pedido. O ChatGPT é com estado:
a conversa fica no servidor. Para não reenviar dezenas de milhares de caracteres a cada passo
do agente, a ponte reconhece históricos.

1. **Forma canônica**: cada mensagem vira uma forma estável. Ids de chamadas são ignorados, os
   argumentos são comparados como objeto (a ordem das chaves e os espaços do JSON não
   importam) e os espaços do texto do assistente são normalizados, porque os clientes às vezes
   reformatam o que receberam.
2. **Chaves encadeadas**: `chave[k] = sha256(chave[k-1] + mensagem[k])`, começando por um
   contexto que inclui o modelo e a definição das ferramentas. Calcular a chave de todos os
   prefixos custa o mesmo que calcular a do histórico inteiro.
3. **Memória**: depois de cada resposta, a ponte guarda `chave(histórico + resposta) → aba`.
4. **Continuação**: no pedido seguinte, ela procura o maior prefixo conhecido. Se o resto
   do histórico só tem resultados de ferramentas e mensagens do usuário (não dá para "injetar"
   uma resposta do assistente numa conversa real), manda só isso, mais um lembrete curto do
   formato das ferramentas.
5. **Consumo**: ao enviar uma continuação, a entrada sai da memória. Se a resposta for
   cancelada ou falhar no meio, a conversa da aba ficou num estado que o cliente não conhece, e
   não deve ser reaproveitada.
6. **Validação na aba**: cada aba tem um token de conversa, renovado sempre que ela é levada a
   uma conversa nova, recarregada ou dá erro. A continuação só roda se o token bater; se não
   bater, a extensão responde `conversa_indisponivel` e a ponte reenvia o histórico inteiro
   numa conversa nova, sem o cliente perceber.

Se o cliente compactar o histórico, mudar o prompt de sistema ou as ferramentas, o prefixo não
bate e a ponte abre uma conversa nova. Com `--sem-reaproveitar`, toda resposta abre conversa
nova.

## Abas, fila e o service worker

- **Abas de trabalho** são abertas pela própria extensão, fixadas e marcadas para o Chrome não
  descartá-las da memória (`autoDiscardable: false`). A URL leva `gpt-ponte=1`, o que permite
  reconhecê-las mesmo depois de o service worker reiniciar.
- **Escolha da aba**: continuação vai para a aba da conversa. Conversa nova usa, nesta ordem,
  a aba pedida em `preferirAba` (quando a ponte repete uma tarefa, ela volta para a aba de onde
  veio, para não derrubar a conversa de outro pedido), uma aba já aberta numa conversa nova e
  sem uso, uma aba nova (se ainda cabe no máximo do popup) ou a aba livre usada há mais tempo.
- **Fila**: a ponte nunca manda mais tarefas do que o número de abas. Os pedidos excedentes
  esperam em ordem; se o cliente desistir enquanto espera, o pedido sai da fila.
- **Service worker**: o Chrome desliga o service worker de uma extensão parada há 30 segundos.
  A ponte manda um `ping` a cada 20 segundos pelo WebSocket, e a atividade do WebSocket mantém
  o service worker vivo. Com a ponte desligada, ele dorme, e um alarme o acorda a cada 30
  segundos para tentar de novo. Antes de abrir o WebSocket, ele faz um `GET /saude`, para não
  encher o console de erros de conexão.
- **Content script**: espera o campo de mensagem com `MutationObserver`, que não sofre a
  limitação de timers das abas em segundo plano. Também detecta verificação anti-robô
  (Cloudflare), falta de login e alertas de erro na página.
- **Aba que acorda**: uma aba carregada em segundo plano às vezes não desenha o campo de
  mensagem até ficar visível. Se o campo não aparece em 8 segundos com a aba escondida, a
  extensão traz a aba à frente por 2,5 segundos e volta para a aba em que você estava.

## Erros e novas tentativas

| Situação | O que acontece |
|---|---|
| Extensão não conectada | O pedido espera até 30 s; depois, `503` com instrução. |
| A conversa a continuar sumiu (aba recarregou, fechou, deu erro) | Repete com o histórico inteiro numa conversa nova, na mesma aba quando ela ainda existe. |
| O script da página viu a mensagem sair sem a troca do marcador | A aba passa ao modo digitar e a tarefa é repetida uma vez, na mesma aba. |
| A mensagem não saiu em 20 s | `pagina_mudou` (ou o problema mostrado na página); nada é repetido. |
| Verificação anti-robô | `503` "resolva na aba"; a extensão não tenta resolver. |
| Limite de uso | `429` com a mensagem do site. |
| Mensagem grande demais | `400` com `code: "context_length_exceeded"` (o OpenCode entende e compacta). |
| Cliente desistiu (fechou a conexão) | A ponte manda `cancelar`; a extensão aperta *parar* no site. |
| Nenhum sinal do navegador por 10 min, ou 30 min no total | `504` e cancelamento. |
| A extensão caiu no meio | Erro na hora (no stream, um pedaço `{"error": ...}`). |
| Resposta vazia | `502` "a resposta veio vazia". |

Antes de a resposta começar, os erros saem com o status HTTP certo. Depois que o stream
começou, saem como um último pedaço `data: {"error": {...}}`, como faz a OpenAI.

## Segurança

- **Só local por padrão**: escuta em `127.0.0.1`. Com `--host` fora do loopback e sem
  `--chave`, a ponte gera uma chave aleatória e a mostra no terminal.
- **Sites bloqueados**: pedidos com cabeçalho `Origin` de outro site recebem `403` (a não ser
  as origens liberadas com `--origem`). Sem isso, qualquer página aberta no navegador poderia
  usar a sua conta.
- **DNS rebinding**: com escuta local, só são aceitos `Host` de loopback (`127.0.0.1`,
  `localhost`, `[::1]`, `*.localhost`).
- **WebSocket**: só aceita conexões com `Origin` de extensão (`chrome-extension://...`).
  Páginas da web não conseguem se passar pela extensão.
- **Nada de conteúdo guardado**: a ponte não grava prompts nem respostas. O painel e o log
  (mesmo em `--log debug`) mostram só metadados.
- **Escopo da extensão**: permissões só para `chatgpt.com` e para a ponte local
  (`127.0.0.1`/`localhost`). Ela só atua nas abas que ela mesma abriu e não lê as suas outras
  conversas.
