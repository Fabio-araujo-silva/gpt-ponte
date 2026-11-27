# Desenvolvimento

- [Estrutura](#estrutura)
- [Testes](#testes)
- [Rodando em modo de desenvolvimento](#rodando-em-modo-de-desenvolvimento)
- [Depurando a extensão](#depurando-a-extensão)
- [Quando o site muda](#quando-o-site-muda)
- [Mexendo no protocolo de ferramentas](#mexendo-no-protocolo-de-ferramentas)
- [Publicando uma versão](#publicando-uma-versão)

## Estrutura

```
gpt-ponte/
├── servidor/                 a ponte (Node.js puro, sem dependências)
│   ├── index.js              linha de comando: iniciar, opencode, teste
│   ├── app.js                servidor HTTP, rotas, segurança, WebSocket da extensão
│   ├── openai.js             /v1/models e /v1/chat/completions (stream e sem stream)
│   ├── prompt.js             messages → texto; chaves dos históricos
│   ├── ferramentas.js        protocolo <tool_call> e leitor em streaming
│   ├── json-tolerante.js     leitor de JSON escrito por modelo
│   ├── conversas.js          memória histórico → aba
│   ├── extensao.js           fila, tempo limite e cancelamento das tarefas
│   ├── websocket.js          WebSocket RFC 6455 (servidor e cliente)
│   ├── simulador.js          "navegador" de mentira para --simular e testes
│   ├── opencode.js           gera/grava a configuração do OpenCode
│   ├── config.js, erros.js, log.js, registro.js
│   └── painel.html           painel em http://127.0.0.1:4545
├── extensao/                 extensão do Chrome (Manifest V3)
│   ├── manifest.json
│   ├── fundo.js              service worker
│   ├── conteudo.js           content script (mundo isolado)
│   ├── pagina.js             script da página (mundo MAIN): troca do marcador e leitura do stream
│   ├── analisadores.js       leitores SSE e NDJSON (roda na página e no Node)
│   ├── popup.html/.css/.js
│   └── icones/
├── ferramentas/gerar-icones.mjs
├── testes/                   node --test
├── docs/
├── iniciar.bat, iniciar.sh
└── package.json
```

## Testes

```sh
npm test
```

São testes do `node:test`, sem dependências, e rodam em poucos segundos:

| Arquivo | O que cobre |
|---|---|
| `websocket.test.js` | Handshake, tamanhos de quadro, fragmentação, ping, fechamento, origem, limite. |
| `ferramentas.test.js` | JSON tolerante, interpretação das chamadas e o leitor em streaming, com todos os tamanhos de pedaço. |
| `prompt.test.js` | Montagem do prompt, continuação, chaves dos históricos, memória. |
| `api.test.js` | A API de ponta a ponta: modo simulação, uma extensão falsa falando o protocolo real pelo WebSocket, erros, cancelamento, fila, segurança, fluxo do OpenCode. |
| `analisadores.test.js` | Leitores do stream do site: SSE delta v1, formato antigo, pensamento, NDJSON com o escape do DIL (com dados no formato visto ao vivo). |
| `opencode.test.js` | Inserção da configuração do OpenCode preservando comentários, substituição, backup. |

Para rodar um arquivo só: `node --test testes/ferramentas.test.js`. Para um teste só:
`node --test --test-name-pattern="fila" testes/api.test.js`.

## Rodando em modo de desenvolvimento

- `node servidor/index.js --simular --log debug`: a ponte responde sozinha e mostra um resumo
  de cada pedido (modelo, papéis das mensagens, tamanho, ferramentas, outros campos). Na
  mensagem, `/ferramenta NOME {"arg": 1}` faz o simulador devolver uma chamada de ferramenta,
  o que permite testar o ciclo inteiro de um agente sem gastar mensagens.
- Para testar o OpenCode sem tocar na sua configuração global, crie um projeto de teste com um
  `opencode.jsonc` próprio (com `model` e `small_model` apontando para `gpt-ponte/chatgpt`) e
  rode `opencode run --standalone --format json "..."` dentro dele.
- O painel (`http://127.0.0.1:4545`) atualiza a cada 2 segundos e mostra os últimos pedidos.

## Depurando a extensão

- **Service worker**: em `chrome://extensions`, no cartão da GPT Ponte, clique em
  *service worker* para abrir o console dele (mensagens com o prefixo `[GPT Ponte]`).
- **Content script e script da página**: abra o DevTools (F12) na aba de trabalho. No console,
  o seletor de contexto (canto superior esquerdo) alterna entre a página (`top`, onde roda o
  `pagina.js`) e a extensão (onde roda o `conteudo.js`).
- **Logs no terminal da ponte**: o content script manda mensagens importantes para a ponte
  (`[extensão] Aba 123: ...`).
- Depois de mudar arquivos da extensão: botão de recarregar no cartão em `chrome://extensions`
  e recarregue (ou feche) a aba de trabalho.

## Quando o site muda

A extensão depende de poucas coisas do chatgpt.com. Se algo quebrar, o lugar de mexer é quase
sempre um destes:

| Sintoma | Onde | O que conferir |
|---|---|---|
| `pagina_mudou`: não acha o campo | `extensao/conteudo.js`, `SELETORES_CAMPO` | O seletor do campo de mensagem (hoje `#prompt-textarea` no app logado e `form textarea[name="prompt"]` no app sem login). |
| Não aperta enviar | `conteudo.js`, `acharBotaoEnviar` | `data-testid="send-button"`, `#composer-submit-button`, `aria-label` com *send*/*enviar*, `button[type=submit]` do formulário. |
| Não para a geração ao cancelar | `conteudo.js`, `acharBotaoParar` | `data-testid="stop-button"` ou `aria-label` com *stop*/*parar*. |
| Mensagem sai mas nada é lido | `extensao/pagina.js`, `ehEnvioDeMensagem` | O caminho do pedido de envio (hoje termina em `/conversation` ou `/conversation/updates`). |
| Lê, mas o texto sai errado ou vazio | `extensao/analisadores.js` | O formato do stream. |
| Erros classificados errado | `analisadores.js`, `classificarErro` | As frases que o site usa. |

Para capturar um formato novo de stream: na aba do ChatGPT, abra o DevTools → *Network*,
mande uma mensagem, clique no pedido de envio e copie a aba *Response* (ou *EventStream*).
Transforme num teste em `testes/analisadores.test.js` antes de mudar o leitor. Atenção para
não colar tokens, cookies ou ids da sua conta no teste.

## Mexendo no protocolo de ferramentas

O texto que ensina o formato ao modelo fica em `servidor/ferramentas.js`
(`instrucoesDeFerramentas`, `lembreteDeFerramentas`) e a moldura do prompt em
`servidor/prompt.js` (`montarPromptInicial`, `montarContinuacao`). Lições dos testes:

- falar em primeira pessoa (o usuário explicando o próprio app) funciona melhor que "você é o
  modelo por trás de uma API";
- explicar que o modelo **pede** e o app **executa**, em vez de dizer que ele "tem acesso";
- um exemplo completo de ida e volta ajuda modelos menores;
- terminar o prompt lembrando que "o bloco sozinho basta".

O leitor das respostas (`LeitorDeFerramentas`) é testado com todas as quebras de pedaço
possíveis; ao mudá-lo, acrescente casos em `CASOS` no `testes/ferramentas.test.js`.

## Publicando uma versão

1. Atualize a versão em `package.json` **e** em `extensao/manifest.json`.
2. Se mudar o formato das mensagens entre ponte e extensão, aumente `PROTOCOLO` em
   `servidor/extensao.js` **e** em `extensao/fundo.js`.
3. `npm test`.
4. Teste ao vivo: ponte + extensão recarregada + `node servidor/index.js teste` e um ciclo de
   ferramenta no OpenCode.
5. Commit, tag (`git tag v0.2.0`) e push.
