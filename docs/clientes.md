# Usar em outros programas

A ponte fala o formato da API de Chat Completions da OpenAI. Em qualquer programa que aceite
um "provedor compatível com a OpenAI", use:

| Campo | Valor |
|---|---|
| Base URL | `http://127.0.0.1:4545/v1` |
| Chave de API | qualquer texto (ex.: `gpt-ponte`), ou a chave passada em `--chave` |
| Modelo | `chatgpt` |

Os exemplos abaixo supõem a ponte na porta padrão, sem chave.

- [curl](#curl)
- [Python (SDK oficial)](#python-sdk-oficial)
- [JavaScript / TypeScript (SDK oficial)](#javascript--typescript-sdk-oficial)
- [Ferramentas (function calling)](#ferramentas-function-calling)
- [Continue (VS Code / JetBrains)](#continue-vs-code--jetbrains)
- [Cline / Roo Code](#cline--roo-code)
- [Aider](#aider)
- [LangChain](#langchain)
- [LiteLLM](#litellm)
- [Páginas web e apps no navegador](#páginas-web-e-apps-no-navegador)

## curl

Resposta inteira:

```sh
curl http://127.0.0.1:4545/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "chatgpt",
    "messages": [
      {"role": "system", "content": "Responda sempre em português, de forma curta."},
      {"role": "user", "content": "O que é uma API?"}
    ]
  }'
```

Em streaming (os pedaços chegam conforme o ChatGPT escreve):

```sh
curl -N http://127.0.0.1:4545/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "chatgpt", "stream": true, "messages": [{"role": "user", "content": "Conte até 10."}]}'
```

No Windows (PowerShell), use `curl.exe` e aspas simples por fora, ou o `Invoke-RestMethod`:

```powershell
$corpo = @{ model = "chatgpt"; messages = @(@{ role = "user"; content = "Olá!" }) } | ConvertTo-Json -Depth 5
Invoke-RestMethod -Uri http://127.0.0.1:4545/v1/chat/completions -Method Post -ContentType "application/json" -Body $corpo
```

## Python (SDK oficial)

```sh
pip install openai
```

```python
from openai import OpenAI

cliente = OpenAI(base_url="http://127.0.0.1:4545/v1", api_key="gpt-ponte")

# resposta inteira
r = cliente.chat.completions.create(
    model="chatgpt",
    messages=[{"role": "user", "content": "Dê três ideias de nome para um gato."}],
)
print(r.choices[0].message.content)

# streaming
stream = cliente.chat.completions.create(
    model="chatgpt",
    stream=True,
    messages=[{"role": "user", "content": "Escreva um haicai sobre pontes."}],
)
for pedaco in stream:
    if pedaco.choices and pedaco.choices[0].delta.content:
        print(pedaco.choices[0].delta.content, end="", flush=True)
```

O tempo limite padrão do SDK é de 10 minutos. Para respostas de modelos que pensam muito,
aumente: `OpenAI(..., timeout=1800)`.

## JavaScript / TypeScript (SDK oficial)

```sh
npm install openai
```

```js
import OpenAI from 'openai';

const cliente = new OpenAI({ baseURL: 'http://127.0.0.1:4545/v1', apiKey: 'gpt-ponte' });

const stream = await cliente.chat.completions.create({
  model: 'chatgpt',
  stream: true,
  messages: [{ role: 'user', content: 'Explique closures em JavaScript.' }],
});
for await (const pedaco of stream) {
  process.stdout.write(pedaco.choices[0]?.delta?.content ?? '');
}
```

Com a [AI SDK](https://ai-sdk.dev) da Vercel, use o provedor `@ai-sdk/openai-compatible` com
`baseURL: 'http://127.0.0.1:4545/v1'`.

## Ferramentas (function calling)

Funciona como na API: mande `tools` e trate `tool_calls` na resposta.

```python
import json
from openai import OpenAI

cliente = OpenAI(base_url="http://127.0.0.1:4545/v1", api_key="gpt-ponte")
ferramentas = [{
    "type": "function",
    "function": {
        "name": "clima",
        "description": "Diz o clima atual de uma cidade.",
        "parameters": {
            "type": "object",
            "properties": {"cidade": {"type": "string"}},
            "required": ["cidade"],
        },
    },
}]
mensagens = [{"role": "user", "content": "Está chovendo em São Carlos?"}]

r = cliente.chat.completions.create(model="chatgpt", messages=mensagens, tools=ferramentas)
msg = r.choices[0].message
if msg.tool_calls:
    mensagens.append(msg)
    for chamada in msg.tool_calls:
        args = json.loads(chamada.function.arguments)
        resultado = {"cidade": args["cidade"], "tempo": "nublado, 19 °C"}  # sua função de verdade aqui
        mensagens.append({"role": "tool", "tool_call_id": chamada.id, "content": json.dumps(resultado)})
    r = cliente.chat.completions.create(model="chatgpt", messages=mensagens, tools=ferramentas)

print(r.choices[0].message.content)
```

`tool_choice` (`"auto"`, `"none"`, `"required"` ou uma função específica) e
`parallel_tool_calls: false` também são respeitados (por instrução ao modelo). Como as
chamadas são emuladas por texto, valide os argumentos antes de executar algo importante.

## Continue (VS Code / JetBrains)

No `config.yaml` do [Continue](https://continue.dev):

```yaml
models:
  - name: ChatGPT (navegador)
    provider: openai
    model: chatgpt
    apiBase: http://127.0.0.1:4545/v1
    apiKey: gpt-ponte
    roles: [chat, edit, apply]
```

Evite usar a ponte para **autocomplete** (`roles: [autocomplete]`): o autocomplete dispara um
pedido a cada tecla, o que é lento pelo navegador e pode estourar o limite da sua conta.

## Cline / Roo Code

Em *Settings → API Provider*, escolha **OpenAI Compatible** e preencha:

- **Base URL**: `http://127.0.0.1:4545/v1`
- **API Key**: `gpt-ponte`
- **Model ID**: `chatgpt`

Seja com o function calling da API ou com o formato de ferramentas em texto que o próprio
Cline usa em alguns modos, a ponte atende: no primeiro caso ela converte as chamadas; no
segundo, o texto passa como está.

## Aider

```sh
aider --openai-api-base http://127.0.0.1:4545/v1 --openai-api-key gpt-ponte --model openai/chatgpt
```

## LangChain

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(base_url="http://127.0.0.1:4545/v1", api_key="gpt-ponte", model="chatgpt")
print(llm.invoke("Resuma a teoria da relatividade em duas frases.").content)
```

## LiteLLM

```python
import litellm

r = litellm.completion(
    model="openai/chatgpt",
    api_base="http://127.0.0.1:4545/v1",
    api_key="gpt-ponte",
    messages=[{"role": "user", "content": "Olá!"}],
)
print(r.choices[0].message.content)
```

## Páginas web e apps no navegador

Por segurança, a ponte recusa pedidos feitos por páginas da web (qualquer site aberto no seu
navegador poderia, senão, usar a sua conta do ChatGPT). Se você quer usar a ponte a partir de
uma interface web que roda no navegador (por exemplo uma instância local do Open WebUI ou um
app seu em `http://localhost:3000`), libere a origem dela:

```sh
node servidor/index.js --origem http://localhost:3000
```

Interfaces que chamam a API pelo próprio servidor (o Open WebUI, por padrão, faz assim) não
precisam disso. Se essa interface roda em Docker, use a base URL
`http://host.docker.internal:4545/v1` e inicie a ponte com `--host 0.0.0.0 --chave <algo>`.
