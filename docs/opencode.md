# OpenCode

O [OpenCode](https://opencode.ai) é um agente de programação de terminal. Com a GPT Ponte ele
passa a usar o ChatGPT do seu navegador como modelo, inclusive para ler, editar e criar
arquivos e rodar comandos.

- [Configuração automática](#configuração-automática)
- [Configuração manual](#configuração-manual)
- [Escolher o modelo](#escolher-o-modelo)
- [Tamanho do contexto](#tamanho-do-contexto)
- [O que esperar](#o-que-esperar)
- [Dicas](#dicas)
- [Problemas no OpenCode](#problemas-no-opencode)

## Configuração automática

Com a ponte instalada (veja [instalacao.md](instalacao.md)), rode na pasta do projeto:

```sh
node servidor/index.js opencode --instalar
```

O comando:

1. descobre a versão do OpenCode (`opencode --version`) e o arquivo de configuração global
   (`~/.config/opencode/opencode.jsonc` ou `opencode.json`; no Windows,
   `C:\Users\<você>\.config\opencode\`);
2. guarda uma cópia do arquivo como `opencode.jsonc.bak-<data>`;
3. adiciona o provedor `gpt-ponte` sem apagar comentários nem o que já existe (se o provedor já
   estiver lá, só atualiza o bloco dele);
4. confere se o arquivo continua válido antes de gravar.

Ele **não troca o seu modelo padrão**. Para usar a ponte, escolha o modelo (próxima seção).

Opções do comando:

| Opção | Efeito |
|---|---|
| `--porta <n>` | Usa outra porta na `baseURL` (se a ponte roda em outra porta). |
| `--chave <texto>` | Grava essa chave em `apiKey` (se a ponte exige chave). |
| `--contexto <n>` | Muda o limite de contexto declarado (padrão 64000 tokens). |
| `--arquivo <caminho>` | Grava em outro arquivo (por exemplo, o `opencode.jsonc` de um projeto). |

Sem `--instalar`, o comando só mostra a configuração na tela.

## Configuração manual

### OpenCode 2.x

No arquivo `~/.config/opencode/opencode.jsonc`, dentro de `"providers"`:

```jsonc
{
  "providers": {
    "gpt-ponte": {
      "name": "ChatGPT (navegador, via GPT Ponte)",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "http://127.0.0.1:4545/v1",
        "apiKey": "gpt-ponte",
        // o ChatGPT pode pensar por minutos antes da primeira palavra
        "headerTimeout": 1800000,
        "chunkTimeout": 900000
      },
      "compatibility": { "reasoningField": "reasoning_content", "maxTokensField": "max_tokens" },
      "models": {
        "chatgpt": {
          "modelID": "chatgpt",
          "name": "ChatGPT (navegador)",
          "capabilities": {
            "tools": true,
            "input": ["text"],
            "output": ["text"],
            "temperature": false,
            "reasoning": { "supported": false }
          },
          "limit": { "context": 64000, "output": 32000 },
          "cost": { "input": 0, "output": 0 }
        }
      }
    }
  }
}
```

### OpenCode 1.x

No arquivo `~/.config/opencode/opencode.json`, dentro de `"provider"`:

```json
{
  "provider": {
    "gpt-ponte": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "ChatGPT (navegador, via GPT Ponte)",
      "options": { "baseURL": "http://127.0.0.1:4545/v1", "apiKey": "gpt-ponte", "timeout": false },
      "models": {
        "chatgpt": { "name": "ChatGPT (navegador)", "tool_call": true, "limit": { "context": 64000, "output": 32000 } }
      }
    }
  }
}
```

### Só num projeto

O mesmo bloco pode ir num `opencode.jsonc` na raiz de um projeto; aí a ponte só aparece
nesse projeto. Para gerar direto lá:

```sh
node servidor/index.js opencode --instalar --arquivo caminho/do/projeto/opencode.jsonc
```

## Escolher o modelo

- Dentro do OpenCode: `/models` e escolha **ChatGPT (navegador)**.
- Ao abrir: `opencode --model gpt-ponte/chatgpt`.
- Numa execução só: `opencode run --model gpt-ponte/chatgpt "explique este projeto"`.

Para deixar como padrão, no arquivo de configuração:

```jsonc
"model": "gpt-ponte/chatgpt",
"small_model": "gpt-ponte/chatgpt"
```

O `small_model` é o modelo que o OpenCode usa para gerar o título das sessões. Se ele apontar
para outro provedor, os títulos (e o começo da sua conversa) vão para esse outro provedor.

### Escolher o modelo do ChatGPT (GPT-5, Thinking...)

O modelo `chatgpt` usa o que estiver selecionado por padrão na sua conta. Qualquer outro nome
de modelo é repassado ao site como `chatgpt.com/?model=<nome>` ao abrir a conversa. Para
expor, por exemplo, um modelo de raciocínio, acrescente outro modelo ao provedor:

```jsonc
"models": {
  "chatgpt": { "...": "como acima" },
  "gpt-5-thinking": {
    "modelID": "gpt-5-thinking",
    "name": "ChatGPT Thinking (navegador)",
    "capabilities": { "tools": true, "input": ["text"], "output": ["text"], "temperature": false, "reasoning": { "supported": false } },
    "limit": { "context": 64000, "output": 32000 },
    "cost": { "input": 0, "output": 0 }
  }
}
```

O nome precisa ser um que o chatgpt.com aceite no parâmetro `model` da URL (os nomes mudam
com o tempo; confira no seletor de modelos do site). Se o site não reconhecer o nome, ele usa
o modelo padrão da conta.

## Tamanho do contexto

O `limit.context` diz ao OpenCode quando **compactar** a sessão (resumir o histórico e
recomeçar). A ponte informa o uso de tokens por estimativa (cerca de 4 caracteres por token),
somando o histórico inteiro.

O padrão de 64 mil tokens é conservador de propósito: a janela de contexto do ChatGPT depende
do plano e do modelo, e quando uma conversa passa do limite o site começa a esquecer o começo
dela em silêncio, o que inclui as instruções das ferramentas. Compactar um pouco antes é mais
seguro. Se o seu plano tem janela grande (modelos de raciocínio dos planos pagos costumam ter),
você pode subir para 100000 ou mais com `--contexto`.

Só as instruções de sistema e as ferramentas do OpenCode 2 ocupam cerca de 34 mil caracteres
(uns 8 a 9 mil tokens) na primeira mensagem.

## O que esperar

- **Primeira mensagem**: a ponte abre uma conversa nova e manda as instruções, a lista de
  ferramentas e a sua mensagem (dezenas de milhares de caracteres). O OpenCode também pede um
  título para a sessão ao mesmo tempo, que vai para uma segunda aba.
- **Passos seguintes**: cada chamada de ferramenta vira uma mensagem curta na mesma conversa
  (só o resultado da ferramenta). No terminal da ponte, `✚` marca conversa nova e `↪` marca
  continuação.
- **Velocidade**: alguns segundos a mais por passo que na API, porque cada resposta passa pela
  página.
- **Histórico**: com *chats temporários* ligados (padrão), nada disso aparece no histórico do
  ChatGPT.

## Dicas

- Deixe **2 abas** (padrão) na extensão. Com 1 aba, o pedido de título disputa a aba com o
  agente e a conversa às vezes precisa ser reenviada inteira.
- Uma sessão do OpenCode por vez funciona melhor. Várias sessões ao mesmo tempo dividem as
  abas e entram na fila.
- Se o modelo começar a "esquecer" as ferramentas numa sessão muito longa, compacte
  (`/compact`) ou abra uma sessão nova.
- Se a ponte exigir chave (`--chave`), coloque a mesma em `apiKey`.

## Problemas no OpenCode

**`Invalid arguments for tool ...` aparece de vez em quando**: o modelo errou o nome de um
argumento. O OpenCode devolve o erro ao modelo, que corrige na mesma hora. É normal acontecer
às vezes.

**O modelo responde "não tenho acesso aos seus arquivos"**: confira se você está logado no
ChatGPT. Se estiver, tente de novo ou abra uma sessão nova. Veja
[problemas.md](problemas.md#o-modelo-não-usa-as-ferramentas).

**Erro `503 ... extensão ... não está conectada`**: a ponte está rodando, mas a extensão não.
Abra o Chrome e clique no ícone da GPT Ponte.

**Demora e erro de tempo esgotado**: os tempos da configuração acima aguentam respostas de até
30 minutos. Se você mudou `headerTimeout`/`chunkTimeout`, aumente.

**O provedor não aparece em `/models`**: confira se o bloco está em `"providers"` (OpenCode 2)
ou `"provider"` (OpenCode 1) e reinicie o OpenCode (`opencode reload` no OpenCode 2).
