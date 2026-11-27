# Instalação

Este guia leva você do zero até a primeira resposta, explicando o que deve aparecer em cada
etapa. São três peças:

1. **A ponte**: um programa pequeno em Node.js que roda no seu computador e cria a API em
   `http://127.0.0.1:4545/v1`.
2. **A extensão**: instalada no Chrome, liga a ponte às abas do chatgpt.com.
3. **A sua conta do ChatGPT**, logada no mesmo navegador.

- [1. Instalar o Node.js](#1-instalar-o-nodejs)
- [2. Baixar a GPT Ponte](#2-baixar-a-gpt-ponte)
- [3. Iniciar a ponte](#3-iniciar-a-ponte)
- [4. Instalar a extensão](#4-instalar-a-extensão)
- [5. Entrar no ChatGPT](#5-entrar-no-chatgpt)
- [6. Testar](#6-testar)
- [Iniciar junto com o computador](#iniciar-junto-com-o-computador)
- [Atualizar](#atualizar)
- [Desinstalar](#desinstalar)

## 1. Instalar o Node.js

A ponte precisa do **Node.js 22 ou mais novo**.

- **Windows e macOS**: baixe o instalador da versão **LTS** em [nodejs.org](https://nodejs.org)
  e siga com as opções padrão.
- **Linux**: use o gerenciador da sua distribuição ou o [nvm](https://github.com/nvm-sh/nvm)
  (`nvm install --lts`).

Para conferir, abra um terminal (no Windows: tecla Windows, digite `cmd`, Enter) e rode:

```sh
node --version
```

Deve aparecer algo como `v22.12.0` ou um número maior.

## 2. Baixar a GPT Ponte

Escolha um dos jeitos:

- **Sem Git**: na página do projeto no GitHub, clique no botão verde **Code** e depois em
  **Download ZIP**. Extraia o ZIP numa pasta fixa (por exemplo `Documentos\gpt-ponte`). Não
  deixe na pasta Downloads se você costuma limpá-la: a extensão é carregada dessa pasta.
- **Com Git**:
  ```sh
  git clone https://github.com/Fabio-araujo-silva/gpt-ponte.git
  cd gpt-ponte
  ```

Não é preciso rodar `npm install`: o projeto não tem dependências.

## 3. Iniciar a ponte

- **Windows**: dê dois cliques em `iniciar.bat`.
- **macOS / Linux**: no terminal, dentro da pasta, rode `./iniciar.sh`
  (ou `node servidor/index.js`).

Uma janela de terminal fica aberta com:

```
  GPT Ponte 0.1.0

  API (OpenAI):  http://127.0.0.1:4545/v1
  Modelo:        chatgpt
  Chave:         qualquer uma (só aceita pedidos deste computador)
  Painel:        http://127.0.0.1:4545/

  Esperando a extensão: deixe o Chrome aberto com a extensão GPT Ponte instalada.
  Para parar: Ctrl+C
```

**Deixe essa janela aberta** enquanto quiser usar a API. Para parar, feche a janela ou
aperte `Ctrl+C`.

> Se aparecer `A porta 4545 já está em uso por outro programa`, inicie com outra porta:
> `iniciar.bat --porta 5000` (e depois ajuste a porta na extensão e no seu cliente). Se
> aparecer `A GPT Ponte já está rodando`, é porque ela já está aberta em outra janela.

## 4. Instalar a extensão

A extensão não está na Chrome Web Store; ela é carregada direto da pasta do projeto.

1. No Chrome, abra o endereço `chrome://extensions` (no Edge: `edge://extensions`; no Brave:
   `brave://extensions`).
2. Ligue o **Modo do desenvolvedor** (interruptor no canto superior direito; no Edge fica na
   barra lateral).
3. Clique em **Carregar sem compactação** (*Load unpacked*).
4. Escolha a pasta **`extensao`** que está dentro da pasta da GPT Ponte (a pasta que contém o
   arquivo `manifest.json`).
5. A extensão **GPT Ponte** aparece na lista. Clique no ícone de quebra-cabeça da barra do
   Chrome e no alfinete ao lado de GPT Ponte para deixar o ícone sempre visível.

Em poucos segundos o ícone conecta na ponte. Clique nele:

- **conectada à ponte** (verde): tudo certo.
- **ponte desconectada** (vermelho): a ponte não está rodando ou está em outra porta. Inicie a
  ponte e clique em **Tentar de novo**.

> O Chrome pode mostrar um aviso sobre extensões no modo do desenvolvedor ao abrir. É normal
> para extensões carregadas de uma pasta. Não apague a pasta do projeto: a extensão depende
> dela.

## 5. Entrar no ChatGPT

Abra [chatgpt.com](https://chatgpt.com) e faça login na sua conta, no mesmo perfil do Chrome
em que instalou a extensão.

Sem login a ponte até funciona para perguntas simples, mas o modelo gratuito sem conta não
aceita usar ferramentas. Para usar com o OpenCode, faça login.

## 6. Testar

Com a ponte e a extensão conectadas:

- abra o painel em `http://127.0.0.1:4545` e use **Testar agora**; ou
- rode no terminal, dentro da pasta da ponte:
  ```sh
  node servidor/index.js teste "Diga olá em três idiomas"
  ```

Na primeira mensagem a extensão abre uma **aba de trabalho** do ChatGPT (fixada, à esquerda).
Você vai ver nela uma mensagem curta começando com `GPTPONTE...`: é um marcador que a
extensão troca pelo pedido completo antes de enviar (veja
[como-funciona.md](como-funciona.md#o-marcador)). No canto da página aparece o selo
**GPT Ponte: aba de trabalho**.

Regras da aba de trabalho:

- deixe-a aberta (se fechar, a extensão abre outra no próximo pedido);
- não converse por ela;
- se ela pedir verificação ou login, resolva ali mesmo.

Pronto. Agora configure o seu programa: [OpenCode](opencode.md) ou
[outros clientes](clientes.md).

## Iniciar junto com o computador

A ponte é só um programa de terminal; qualquer jeito de abrir programas no login serve.

- **Windows**: aperte `Win+R`, digite `shell:startup` e Enter. Na pasta que abrir, crie um
  atalho para o `iniciar.bat` (botão direito no `iniciar.bat` → *Mostrar mais opções* →
  *Criar atalho*, e mova o atalho para lá). Nas propriedades do atalho você pode escolher
  *Executar: Minimizada*.
- **macOS**: crie um *Agente de Inicialização* (`launchd`) ou adicione um script em
  *Ajustes → Geral → Itens de Início*.
- **Linux**: use um serviço de usuário do systemd. Exemplo em
  `~/.config/systemd/user/gpt-ponte.service`:
  ```ini
  [Unit]
  Description=GPT Ponte

  [Service]
  ExecStart=/usr/bin/node /caminho/para/gpt-ponte/servidor/index.js
  Restart=on-failure

  [Install]
  WantedBy=default.target
  ```
  e depois `systemctl --user enable --now gpt-ponte`.

A extensão reconecta sozinha quando a ponte aparece (em até 30 segundos; clicar no ícone
conecta na hora).

## Atualizar

1. Baixe a versão nova (ZIP por cima da pasta antiga, ou `git pull`).
2. Reinicie a ponte (feche a janela e abra o `iniciar.bat` de novo).
3. Em `chrome://extensions`, clique no botão de **recarregar** (seta circular) do cartão da
   GPT Ponte.
4. Feche a aba de trabalho do ChatGPT; a extensão abre uma nova no próximo pedido.

A ponte e a extensão conversam por um protocolo numerado; se as versões não combinarem, a
ponte avisa no terminal.

## Desinstalar

1. Em `chrome://extensions`, clique em **Remover** no cartão da GPT Ponte.
2. Apague a pasta do projeto.
3. Se você usou `opencode --instalar`, remova o bloco `"gpt-ponte"` do arquivo de configuração
   do OpenCode (o caminho aparece quando você roda `node servidor/index.js opencode`). O
   instalador deixou um backup `*.bak-<data>` ao lado, se preferir voltar a ele.
