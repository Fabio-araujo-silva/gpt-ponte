# Referência

- [Linha de comando](#linha-de-comando)
- [Configuração](#configuração)
- [Rotas HTTP](#rotas-http)
- [POST /v1/chat/completions](#post-v1chat-completions)
- [Erros](#erros)
- [Protocolo ponte ↔ extensão](#protocolo-ponte--extensão)

## Linha de comando

```
node servidor/index.js [opções]                 inicia a ponte
node servidor/index.js opencode [--instalar]     mostra/grava a configuração do OpenCode
node servidor/index.js opencode --perfil [pasta] cria o perfil "só ChatGPT" do OpenCode
node servidor/index.js teste ["pergunta"]        pergunta algo à ponte que já está rodando
node servidor/index.js teste --ferramentas       ciclo de agente de verdade (ferramenta + continuação)
node servidor/index.js saude [--esperar <s>]     diz se a ponte está no ar (código de saída 0/1)
node servidor/index.js recarregar-extensao       recarrega a extensão (pega o código novo da pasta)
node servidor/index.js --ajuda                   ajuda
node servidor/index.js --versao                  versão
```

`iniciar.bat` (Windows) e `iniciar.sh` (macOS/Linux) chamam o primeiro comando e repassam as
opções. `npm start` também funciona. `opencode-chatgpt.bat`/`.sh` abrem o OpenCode só com o
ChatGPT (veja [opencode.md](opencode.md#só-o-chatgpt-opencode-chatgpt)).

## Configuração

Ordem de prioridade (a última vence): valores padrão → `config.local.json` → variáveis de
ambiente → argumentos.

| Argumento | Variável | Chave em `config.local.json` | Padrão | Descrição |
|---|---|---|---|---|
| `--porta <n>` | `GPT_PONTE_PORTA` | `porta` | `4545` | Porta da API, do painel e do WebSocket. |
| `--host <end>` | `GPT_PONTE_HOST` | `host` | `127.0.0.1` | Endereço de escuta. Fora do loopback, a chave é obrigatória (gerada se faltar). |
| `--chave <txt>` | `GPT_PONTE_CHAVE` | `chave` | (nenhuma) | Exige `Authorization: Bearer <txt>` (ou `x-api-key`). |
| `--origem <url>` | — | `origens` (lista) | `[]` | Sites liberados para chamar a API pelo navegador. `*` libera todos (não recomendado). |
| `--sem-reaproveitar` | — | `reaproveitarConversas: false` | ligado | Desliga a continuação de conversas. |
| `--simular` | — | `simular: true` | desligado | Respostas simuladas, sem navegador. |
| `--sem-progresso` | — | `progresso: false` | ligado | Não escreve o andamento (`[GPT Ponte] ...`) no `reasoning_content`. |
| `--log <nível>` | `GPT_PONTE_LOG` | `log` | `info` | `debug`, `info`, `aviso` ou `erro`. |
| `--config <arq>` | — | — | `config.local.json` | Outro arquivo de configuração. |
| — | — | `esperaExtensaoMs` | `30000` | Quanto um pedido espera a extensão conectar. |
| — | — | `limiteMs` | `1800000` | Tempo máximo de uma resposta (30 min). |
| — | — | `inatividadeMs` | `600000` | Tempo máximo sem nenhum sinal do navegador (10 min). |

Exemplo de `config.local.json` (fica fora do Git):

```json
{
  "porta": 4545,
  "chave": "uma-chave-que-so-eu-sei",
  "origens": ["http://localhost:3000"],
  "inatividadeMs": 900000
}
```

Configurações da extensão (popup → Configurações):

| Campo | Padrão | Descrição |
|---|---|---|
| Endereço da ponte | `ws://127.0.0.1:4545/extensao` | Onde a extensão procura a ponte. |
| Abas ao mesmo tempo | `2` | De 1 a 4. Cada aba atende uma resposta por vez. |
| Como enviar o texto | Automático | *Automático* troca um marcador pelo prompt no pedido; *Digitar* escreve o prompt inteiro no campo. |
| Chat temporário (interruptor na frente do popup e no monitor) | ligado | Conversas novas fora do histórico e sem a memória do ChatGPT. Vale na hora. |
| Fixar as abas de trabalho | ligado | Abas de trabalho fixadas à esquerda. |
| Interruptor (topo) | ligado | Desligado, a extensão se desconecta e não atende pedidos. |

## Rotas HTTP

| Método e caminho | Descrição |
|---|---|
| `GET /` ou `/painel` | Painel web (estado, últimos pedidos, teste). |
| `GET /estado` | Estado em JSON: versão, navegador, abas, últimos pedidos (só metadados: modo, `envios` ao navegador, `abas` usadas, `correcoes`, duração). |
| `GET /saude` ou `/health` | `{"ok": true, "versao": "...", "navegadorConectado": true}`. |
| `GET /v1/models` | Lista de modelos (`chatgpt` e os que a extensão informar). |
| `GET /v1/models/{id}` | Um modelo. |
| `POST /v1/chat/completions` | Chat Completions, com e sem stream. |
| `GET /extensao` (WebSocket) | Conexão da extensão. Só aceita `Origin` de extensão. |
| `POST /extensao/recarregar` | Pede à extensão conectada (0.2.1 ou mais nova) que feche as abas de trabalho e se recarregue. `503` se ela não está conectada. |

As rotas também respondem sem o prefixo `/v1` (`/chat/completions`, `/models`). As rotas da
API e `/extensao/recarregar` exigem a chave quando ela está configurada; o painel, `/estado` e
`/saude` não.

## POST /v1/chat/completions

### Campos aceitos

| Campo | Suporte |
|---|---|
| `model` | `chatgpt` usa o modelo padrão da conta. Outro nome vai para o site como `?model=<nome>` ao abrir a conversa. |
| `messages` | `system`, `developer`, `user`, `assistant` (com `tool_calls`), `tool` e o antigo `function`. Conteúdo em texto ou em partes (`text`); imagens, áudio e arquivos viram um aviso no texto. |
| `stream` | `true` para SSE. |
| `stream_options.include_usage` | Manda um último pedaço com `usage` e `choices: []`. |
| `tools` | Ferramentas `type: "function"` com `name`, `description` e `parameters` (JSON Schema). |
| `tool_choice` | `"auto"`, `"none"`, `"required"` ou `{"type": "function", "function": {"name": ...}}`. |
| `parallel_tool_calls` | `false` pede no máximo uma chamada por resposta. |
| `response_format` | `{"type": "json_object"}` ou `{"type": "json_schema", "json_schema": {...}}`, por instrução ao modelo. |
| `stop` | Texto ou lista; a ponte corta a resposta na primeira ocorrência e para a geração. |

Campos ignorados (o site não oferece): `temperature`, `top_p`, `max_tokens`,
`max_completion_tokens`, `n`, `seed`, `logprobs`, `top_logprobs`, `presence_penalty`,
`frequency_penalty`, `logit_bias`, `user`, `reasoning_effort` e parecidos. Mandá-los não dá
erro.

### Resposta sem stream

```json
{
  "id": "chatcmpl-6f1c...",
  "object": "chat.completion",
  "created": 1795742408,
  "model": "chatgpt",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Vou listar os arquivos.",
      "tool_calls": [{
        "id": "call_Qk3...",
        "type": "function",
        "function": { "name": "bash", "arguments": "{\"command\":\"ls\"}" }
      }]
    },
    "logprobs": null,
    "finish_reason": "tool_calls"
  }],
  "usage": { "prompt_tokens": 8458, "completion_tokens": 21, "total_tokens": 8479 },
  "system_fingerprint": null
}
```

- `content` é `null` quando só há chamadas de ferramenta.
- `reasoning_content` aparece na mensagem quando o site mostra o raciocínio do modelo.
- `usage` é estimado (cerca de 4 caracteres por token) e conta o histórico inteiro.

### Resposta em stream

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":...,"model":"chatgpt","choices":[{"index":0,"delta":{"role":"assistant","content":"Vou"},"logprobs":null,"finish_reason":null}]}

data: {... "delta":{"content":" listar os arquivos."} ...}

data: {... "delta":{"tool_calls":[{"index":0,"id":"call_...","type":"function","function":{"name":"bash","arguments":"{\"command\":\"ls\"}"}}]} ...}

data: {... "delta":{},"finish_reason":"tool_calls"}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk",...,"choices":[],"usage":{...}}

data: [DONE]
```

- O primeiro pedaço traz `"role": "assistant"`.
- Cada chamada de ferramenta chega inteira num pedaço só (nome e argumentos completos).
- Raciocínio chega como `delta.reasoning_content`. Antes do texto, a ponte também manda ali
  linhas de andamento (`[GPT Ponte] mensagem enviada...`, `esperando o ChatGPT… 20 s`), a menos
  que você use `--sem-progresso`.
- A cada 15 s sem dados a ponte manda um comentário SSE (`: gpt-ponte`) para a conexão não
  cair enquanto o modelo pensa.

## Erros

Formato (o mesmo da OpenAI):

```json
{ "error": { "message": "...", "type": "rate_limit_error", "param": null, "code": "limite" } }
```

| Status | `code` | Quando |
|---|---|---|
| 400 | `pedido_invalido` | JSON inválido, `messages` vazio, corpo acima de 64 MB. |
| 400 | `context_length_exceeded` | O ChatGPT recusou a mensagem por tamanho. |
| 401 | `invalid_api_key` | Chave configurada e ausente/errada. |
| 403 | `origem_bloqueada` | Pedido vindo de um site não liberado, ou `Host` estranho. |
| 404 | `nao_encontrado` | Rota inexistente. |
| 429 | `limite` | Limite de uso do plano do ChatGPT. |
| 502 | `chatgpt` | O site devolveu um erro. |
| 502 | `sem_resposta` | A resposta veio vazia. |
| 502 | `pagina_mudou` | A extensão não achou o campo ou o botão (o site mudou?). |
| 502 | `reenviar` | A mensagem saiu sem a troca do marcador (a ponte já repetiu uma vez, na mesma aba). |
| 503 | `sem_extensao` | A extensão não conectou a tempo. |
| 503 | `extensao_desconectada` | A extensão caiu no meio da resposta. |
| 503 | `verificacao` | O site pediu captcha: resolva na aba de trabalho. |
| 503 | `sem_login` | O site pediu login. |
| 503 | `sem_aba` | Não foi possível abrir/carregar a aba do ChatGPT. |
| 504 | `tempo_esgotado` | Passou do tempo limite ou da inatividade máxima. |

## Protocolo ponte ↔ extensão

WebSocket em `ws://127.0.0.1:<porta>/extensao`, mensagens JSON. Versão do protocolo: `1`.

### Extensão → ponte

| `tipo` | Campos | Quando |
|---|---|---|
| `ola` | `protocolo`, `versao`, `navegador`, `config: {maxAbas, temporario}` | Ao conectar (e quando a configuração muda). |
| `estado` | `maxAbas`, `abas: [{id, estado, conversaId, conversaServidor, frontend, logado, aviso}]`, `logado` | Sempre que algo muda nas abas. |
| `etapa` | `id`, `etapa` (`abrindo-aba` ou `enviado`), `detalhe`, `aba` | Andamento antes da resposta (vira linha de andamento no cliente). |
| `inicio` | `id`, `aba`, `conversaId` | A resposta começou a chegar. |
| `delta` | `id`, `texto`, `raciocinio` | Texto novo (só o que cresceu). |
| `fim` | `id`, `texto`, `raciocinio`, `aba`, `conversaId`, `modelo` | Resposta completa (o `texto` final vale mais que a soma dos deltas). |
| `erro` | `id`, `codigo`, `mensagem`, `aba` | A tarefa falhou (códigos da tabela de erros). A ponte usa `aba` para repetir na mesma aba. |
| `pong` | `t` | Resposta ao `ping`. |
| `log` | `nivel`, `mensagem` | Mensagem para o terminal da ponte. |

### Ponte → extensão

| `tipo` | Campos | Quando |
|---|---|---|
| `bemvindo` | `protocolo`, `versao` | Ao aceitar a conexão. |
| `tarefa` | `id`, `prompt`, `nova`, `continuar: {aba, conversaId} \| null`, `modelo`, `rotulo`, `preferirAba` | Um pedido para o ChatGPT. O `rotulo` (conversa nova, continuação, correção, título da sessão) aparece no monitor. `preferirAba` pede uma aba específica para a conversa nova (usado ao repetir uma tarefa). |
| `cancelar` | `id` | O cliente desistiu ou o tempo acabou. |
| `recarregar` | (nenhum) | Fecha as abas de trabalho e recarrega a extensão (`POST /extensao/recarregar`). |
| `ping` | `t` | A cada 20 s (mantém o service worker vivo). |

Só uma extensão fica conectada por vez: uma conexão nova substitui a anterior (e as respostas
em andamento na anterior falham).

### Dentro da extensão

Entre o content script e o script da página (`window.postMessage`, `canal: "gpt-ponte"`):

| De → para | `tipo` | Significado |
|---|---|---|
| conteúdo → página | `armar` (`id`, `marcador`, `prompt`) | O próximo envio de mensagem é desta tarefa. |
| conteúdo → página | `desarmar`, `cancelar` (`id`) | Desiste da tarefa. |
| página → conteúdo | `enviado` | O pedido de envio saiu (com a troca feita). |
| página → conteúdo | `envio-fora-de-tarefa` | Saiu um envio de mensagem sem tarefa armada. Numa aba de trabalho, o content script avisa a ponte (alguém digitou nela, ou o site repetiu o envio). |
| página → conteúdo | `envio-sem-marcador` | O envio desta tarefa saiu sem o marcador no corpo (formato que o script não sabe editar). Se o `enviado` não chegar em 1,5 s, o content script pede `reenviar`. |
| página → conteúdo | `stream-inicio`, `progresso`, `stream-fim`, `stream-erro` | Andamento da resposta. |
| página → conteúdo | `erro-http` (`status`, `corpo`) | O site respondeu com erro HTTP. |

Entre o content script e o service worker (porta `aba-chatgpt`): `pronta`, `problema`,
`enviado`, `inicio`, `delta`, `fim`, `erro`, `acordar`, `log` (da aba para o service worker) e
`executar`, `cancelar`, `info` (do service worker para a aba).

Entre o monitor e o service worker (porta `monitor`): `monitor:inicio` (todas as tarefas e o
estado), `monitor:tarefa` (uma tarefa mudou), `monitor:delta` (texto novo), `monitor:estado`,
`monitor:lista` e `monitor:prompt` (do service worker para o monitor); `monitor:prompt` e
`monitor:limpar` (do monitor para o service worker).
