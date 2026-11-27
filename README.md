# GPT Ponte

Use o **ChatGPT aberto no seu navegador como uma API compatível com a da OpenAI**.
A ponte cria um endereço `http://127.0.0.1:4545/v1` que qualquer programa "estilo OpenAI"
entende (OpenCode, Continue, Cline, Aider, os SDKs oficiais, `curl`...). Por trás, quem
responde é a sua conta do ChatGPT, na aba do navegador, sem chave de API e sem Codex.

```
 OpenCode / SDK / curl                   seu computador                        navegador
┌──────────────────────┐  HTTP (OpenAI)  ┌──────────────────┐  WebSocket   ┌────────────────────┐
│ POST /v1/chat/       ├────────────────▶│  ponte (Node.js) ├─────────────▶│ extensão GPT Ponte │
│      completions     │◀── stream SSE ──┤  127.0.0.1:4545  │◀─────────────┤  + aba chatgpt.com │
└──────────────────────┘                 └──────────────────┘              └────────────────────┘
```

> **Aviso.** Este projeto não tem nenhuma relação com a OpenAI. Os Termos de Uso do ChatGPT
> não permitem extrair respostas de forma automatizada, e um agente como o OpenCode manda
> muitas mensagens seguidas. **A sua conta pode ser limitada ou bloqueada.** Use por sua
> conta e risco, de preferência com moderação.

## Sumário

- [O que ela faz](#o-que-ela-faz)
- [Requisitos](#requisitos)
- [Instalação rápida](#instalação-rápida)
- [Usar no OpenCode](#usar-no-opencode)
- [Usar em outros programas](#usar-em-outros-programas)
- [Configurações](#configurações)
- [Limitações](#limitações)
- [Segurança e privacidade](#segurança-e-privacidade)
- [Problemas comuns](#problemas-comuns)
- [Documentação completa](#documentação-completa)
- [Licença](#licença)

## O que ela faz

- **API no formato da OpenAI**: `GET /v1/models` e `POST /v1/chat/completions`, com e sem
  streaming (SSE), no mesmo formato de resposta, de erros e de uso de tokens.
- **Chamada de ferramentas (function calling)**: o ChatGPT do navegador não tem esse recurso,
  então a ponte descreve as ferramentas no prompt, lê a resposta e devolve `tool_calls`
  exatamente como a OpenAI devolveria. É o que deixa o OpenCode trabalhar como agente
  (ler, editar e criar arquivos, rodar comandos).
- **Agente sólido**: toda conversa nova começa com um contrato fixo (o modelo trabalha pelas
  ferramentas no seu PC, sem a personalização da conta) e cada passo lembra o formato e o
  nome das ferramentas. Se o ChatGPT escrever um bloco de ferramenta quebrado, disser "não
  tenho acesso" ou responder vazio, a ponte pede a correção na mesma conversa antes de
  responder, sem o cliente ver o erro.
- **Andamento visível**: enquanto o ChatGPT pensa, o cliente recebe linhas de andamento no
  bloco de raciocínio (no OpenCode aparecem como "pensando"): fila, mensagem enviada, há
  quanto tempo está esperando, correções.
- **Monitor ao vivo**: uma página da extensão mostra cada chamada com etapas, tempos, a
  resposta chegando, as chamadas de ferramenta e o prompt enviado.
- **Conversas reaproveitadas**: a cada passo do agente, a ponte reconhece o histórico e manda
  ao ChatGPT só o que é novo (o resultado da ferramenta), na mesma conversa da aba.
- **Sem dependências**: a ponte é Node.js puro e a extensão não precisa de nada além do Chrome.
- **Robusta**: fila por aba, tempo limite, cancelamento quando o cliente desiste, nova
  tentativa automática quando a aba perde a conversa, detecção de verificação anti-robô, de
  falta de login e de limite de uso, com mensagens de erro em português.
- **Painel** em `http://127.0.0.1:4545` com o estado do navegador, os últimos pedidos e um
  campo para testar na hora.
- **Modo simulação** (`--simular`) para conferir a ligação com o seu programa sem gastar
  mensagens do ChatGPT.

## Requisitos

- **Node.js 22 ou mais novo** ([nodejs.org](https://nodejs.org), versão LTS).
- **Google Chrome** (ou Edge, Brave, Opera, Vivaldi: qualquer navegador baseado no Chromium,
  versão 116 ou mais nova).
- **Uma conta do ChatGPT** logada no navegador. Sem login a ponte até responde perguntas
  simples, mas o modelo gratuito sem conta **se recusa a usar ferramentas**, então não serve
  como agente (ver [Limitações](#limitações)).

## Instalação rápida

O passo a passo com mais detalhes (e o que você deve ver em cada etapa) está em
[docs/instalacao.md](docs/instalacao.md).

1. **Baixe o projeto**: botão verde **Code → Download ZIP** no GitHub (e extraia), ou
   ```sh
   git clone https://github.com/Fabio-araujo-silva/gpt-ponte.git
   ```
2. **Inicie a ponte**: dê dois cliques em `iniciar.bat` (Windows) ou rode `./iniciar.sh`
   (macOS/Linux). Deixe essa janela aberta. Ela mostra:
   ```
   GPT Ponte 0.1.0
   API (OpenAI):  http://127.0.0.1:4545/v1
   ```
3. **Instale a extensão**: no Chrome, abra `chrome://extensions`, ligue o **Modo do
   desenvolvedor** (canto superior direito), clique em **Carregar sem compactação** e escolha a
   pasta `extensao` do projeto. Fixe o ícone da GPT Ponte na barra (ícone de quebra-cabeça).
4. **Entre no ChatGPT**: abra [chatgpt.com](https://chatgpt.com) e faça login na sua conta.
5. **Confira**: clique no ícone da extensão. Ele deve mostrar **conectada à ponte**. Depois
   abra `http://127.0.0.1:4545` e use **Testar agora**, ou rode no terminal:
   ```sh
   node servidor/index.js teste "Diga olá"
   ```

Na primeira mensagem a extensão abre sozinha uma aba fixada do ChatGPT. Essa é a **aba de
trabalho**: deixe-a aberta e não converse por ela (o selo no canto da página avisa).

## Usar no OpenCode

**Só com o ChatGPT (motor único)**: na pasta do seu projeto, rode o lançador do projeto.

```sh
D:\caminho\para\gpt-ponte\opencode-chatgpt.bat      # Windows
/caminho/para/gpt-ponte/opencode-chatgpt.sh          # macOS / Linux
```

Ele sobe a ponte se ela não estiver rodando e abre o OpenCode num perfil próprio, em que o
modelo principal **e** os títulos das sessões vão para o ChatGPT. A sua configuração normal
do OpenCode fica intacta. Detalhes em [docs/opencode.md](docs/opencode.md#só-o-chatgpt-opencode-chatgpt).

**Como mais um provedor** na sua configuração normal: com a ponte rodando, um comando
adiciona a ponte como provedor no OpenCode (com backup do arquivo anterior e sem mexer no
resto da sua configuração):

```sh
node servidor/index.js opencode --instalar
```

Depois, dentro do OpenCode, escolha o modelo **ChatGPT (navegador)** com `/models`, ou rode:

```sh
opencode --model gpt-ponte/chatgpt
```

Para ver a configuração antes de gravar, use só `node servidor/index.js opencode`. A
configuração manual (OpenCode 2 e 1), como deixar a ponte como modelo padrão e como ajustar o
tamanho do contexto estão em [docs/opencode.md](docs/opencode.md).

## Usar em outros programas

Qualquer programa que aceite uma "base URL" da OpenAI funciona:

| Campo | Valor |
|---|---|
| Base URL | `http://127.0.0.1:4545/v1` |
| Chave de API | qualquer texto (ex.: `gpt-ponte`), a menos que você configure uma com `--chave` |
| Modelo | `chatgpt` |

```sh
curl http://127.0.0.1:4545/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "chatgpt", "messages": [{"role": "user", "content": "Olá!"}]}'
```

```python
from openai import OpenAI

cliente = OpenAI(base_url="http://127.0.0.1:4545/v1", api_key="gpt-ponte")
resposta = cliente.chat.completions.create(
    model="chatgpt",
    messages=[{"role": "user", "content": "Explique recursão em uma frase."}],
)
print(resposta.choices[0].message.content)
```

Exemplos para JavaScript, Continue, Cline, Aider, LangChain e outros estão em
[docs/clientes.md](docs/clientes.md).

## Configurações

### Ponte

Passe na linha de comando (`node servidor/index.js --porta 5000`), em variáveis de ambiente
ou num arquivo `config.local.json` na pasta do projeto.

| Opção | Variável | Padrão | Para que serve |
|---|---|---|---|
| `--porta <n>` | `GPT_PONTE_PORTA` | `4545` | Porta da API e do painel. |
| `--host <endereço>` | `GPT_PONTE_HOST` | `127.0.0.1` | Use `0.0.0.0` para aceitar outros computadores da rede (aí a chave vira obrigatória). |
| `--chave <texto>` | `GPT_PONTE_CHAVE` | nenhuma | Exige `Authorization: Bearer <texto>` em todo pedido. |
| `--origem <url>` | — | nenhuma | Libera um site para chamar a API pelo navegador (CORS). Pode repetir. |
| `--sem-reaproveitar` | — | desligado | Sempre abre conversa nova e manda o histórico inteiro. |
| `--simular` | — | desligado | Responde sem navegador, para testar a ligação. |
| `--sem-progresso` | — | desligado | Não escreve o andamento no bloco de raciocínio do cliente. |
| `--log <nível>` | `GPT_PONTE_LOG` | `info` | `debug` mostra um resumo de cada pedido (sem o conteúdo). |

Todas as opções, inclusive tempos limite, estão em [docs/referencia.md](docs/referencia.md).

### Extensão

Na frente do popup (ícone da extensão):

- **Chat temporário** (interruptor): ligado, as conversas novas da ponte não aparecem no seu
  histórico nem usam a memória do ChatGPT; desligado, aparecem no histórico. Vale na hora.
- **Abrir o monitor das chamadas**: página que mostra cada chamada ao vivo (estado, etapas,
  tempos, resposta chegando, ferramentas, prompt enviado e erros).

Em **Configurações**:

- **Endereço da ponte**: `ws://127.0.0.1:4545/extensao` (mude se usar outra porta).
- **Abas ao mesmo tempo**: quantas respostas podem rodar em paralelo (1 a 4; o padrão é 2,
  porque o OpenCode pede o título da sessão junto com a primeira resposta).
- **Como enviar o texto**: *Automático* (recomendado) ou *Digitar o texto no campo*.
- **Fixar as abas de trabalho**: deixa a aba de trabalho fixada à esquerda.
- O **interruptor** no topo liga e desliga a extensão.

## Limitações

- **Sem login, nada de agente**: o modelo gratuito sem conta respondeu, nos testes, que "não
  tem acesso" às ferramentas e se recusou a usar o formato de chamada. Faça login.
- **As ferramentas são emuladas por texto**: o modelo escreve blocos `<tool_call>{json}</tool_call>`
  e a ponte converte. Funciona bem com os modelos bons, mas pode falhar mais que o function
  calling nativo da API.
- **Parâmetros ignorados**: `temperature`, `top_p`, `max_tokens`, `n`, `seed`, `logprobs` e
  parecidos não têm efeito (o site não os aceita). `stop` é aplicado pela própria ponte.
- **Só texto**: imagens, áudio e arquivos nas mensagens viram um aviso no texto. Não há
  embeddings nem geração de imagem pela API.
- **Uso de tokens é estimado** (cerca de 4 caracteres por token).
- **Velocidade**: cada resposta passa pela página do ChatGPT, então há alguns segundos a mais
  que na API.
- **O site muda**: se a OpenAI mudar o chatgpt.com, a extensão pode parar até ser atualizada.
  O guia [docs/desenvolvimento.md](docs/desenvolvimento.md) mostra onde ajustar.

## Segurança e privacidade

- A ponte **só escuta em 127.0.0.1** por padrão: outros computadores não a alcançam.
- **Sites não conseguem usá-la**: pedidos vindos de páginas da web são recusados (cabeçalho
  `Origin`) e nomes de host estranhos também (proteção contra *DNS rebinding*). O WebSocket só
  aceita conexões de extensões.
- A ponte **não guarda o conteúdo** das conversas: o painel mostra só metadados (quando, quantas
  mensagens, quanto tempo). Os prompts vão apenas para o ChatGPT, na sua aba.
- A extensão só atua em `chatgpt.com` e só nas **abas de trabalho** que ela mesma abriu. As
  suas outras abas do ChatGPT continuam normais.
- Se a página pedir verificação anti-robô (captcha) ou login, a extensão **para e avisa**; quem
  resolve é você, na aba.

## Problemas comuns

| Sintoma | O que fazer |
|---|---|
| Não vejo a aba do ChatGPT trabalhando | Ela fica fixada e em segundo plano, à esquerda da sua janela; clique nela. Ou abra o **monitor** pelo popup. |
| Popup mostra **ponte desconectada** | Inicie a ponte (`iniciar.bat`) e clique em **Tentar de novo**. |
| Erro **503: A extensão GPT Ponte não está conectada** | Abra o Chrome com a extensão ativa; clicar no ícone dela conecta na hora. |
| Erro **pediu uma verificação** | Abra a aba de trabalho do ChatGPT e resolva o captcha. |
| Erro **429** | Você bateu no limite de uso do seu plano. Espere ou troque de modelo. |
| O modelo responde "não tenho acesso" em vez de usar ferramentas | Confira se está logado; tente de novo (veja [docs/problemas.md](docs/problemas.md)). |
| `A porta 4545 já está em uso` | Use `--porta 5000` na ponte e ajuste o endereço na extensão e no cliente. |

Mais casos, com explicação, em [docs/problemas.md](docs/problemas.md).

## Documentação completa

| Guia | Conteúdo |
|---|---|
| [docs/instalacao.md](docs/instalacao.md) | Instalação detalhada no Windows, macOS e Linux; atualizar e desinstalar. |
| [docs/opencode.md](docs/opencode.md) | Configuração do OpenCode 2 e 1, modelo padrão, contexto, dicas. |
| [docs/clientes.md](docs/clientes.md) | curl, Python, JavaScript, Continue, Cline, Aider, LangChain e outros. |
| [docs/como-funciona.md](docs/como-funciona.md) | Arquitetura, caminho de um pedido, protocolo de ferramentas, reaproveitamento de conversas. |
| [docs/referencia.md](docs/referencia.md) | Rotas HTTP, campos aceitos, erros, opções e o protocolo ponte ↔ extensão. |
| [docs/problemas.md](docs/problemas.md) | Solução de problemas, um sintoma de cada vez. |
| [docs/desenvolvimento.md](docs/desenvolvimento.md) | Estrutura do código, testes, depuração e como adaptar quando o site mudar. |

## Licença

[MIT](LICENSE).
