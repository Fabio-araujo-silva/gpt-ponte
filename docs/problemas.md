# Solução de problemas

Antes de tudo, dois lugares mostram o que está acontecendo:

- **o terminal da ponte**: cada pedido aparece com `✚` (conversa nova) ou `↪` (continuação),
  e os erros vêm explicados. Para ver mais, inicie com `--log debug`;
- **o popup da extensão** (clique no ícone): estado da conexão e de cada aba.

Para separar problema da ponte de problema do navegador, rode a ponte com `--simular`: se o
seu programa funciona assim, a ligação com ele está certa e o problema está no lado do
navegador.

- [Não vejo o andamento nem a aba trabalhando](#não-vejo-o-andamento-nem-a-aba-trabalhando)
- [A extensão não conecta na ponte](#a-extensão-não-conecta-na-ponte)
- [Erro 503: a extensão não está conectada](#erro-503-a-extensão-não-está-conectada)
- [A porta já está em uso](#a-porta-já-está-em-uso)
- [O ChatGPT pediu verificação (captcha)](#o-chatgpt-pediu-verificação-captcha)
- [O ChatGPT pediu login](#o-chatgpt-pediu-login)
- [Erro 429: limite de uso](#erro-429-limite-de-uso)
- [O modelo não usa as ferramentas](#o-modelo-não-usa-as-ferramentas)
- [A resposta veio vazia](#a-resposta-veio-vazia)
- [Não encontrei o campo de mensagem / a página mudou](#não-encontrei-o-campo-de-mensagem--a-página-mudou)
- [A aba de trabalho mostra só "GPTPONTE..."](#a-aba-de-trabalho-mostra-só-gptponte)
- [O mesmo pedido aparece em duas abas](#o-mesmo-pedido-aparece-em-duas-abas)
- [Toda resposta abre conversa nova](#toda-resposta-abre-conversa-nova)
- [Respostas lentas ou tempo esgotado](#respostas-lentas-ou-tempo-esgotado)
- [Erro 403: origem não permitida](#erro-403-origem-não-permitida)
- [Mensagem grande demais](#mensagem-grande-demais)

## Não vejo o andamento nem a aba trabalhando

- A **aba de trabalho** fica fixada e em segundo plano, no canto esquerdo da janela do Chrome
  (de propósito, para não roubar o foco). Clique nela para assistir.
- O **monitor** (botão no popup) mostra cada chamada ao vivo: etapas, tempos, a resposta
  chegando, as chamadas de ferramenta e o prompt enviado.
- No **OpenCode**, o andamento aparece no bloco de raciocínio ("pensando"), com linhas
  `[GPT Ponte] ...`. Se não aparecer, confira se a ponte não está com `--sem-progresso` e se a
  versão da ponte é a 0.2.0 ou mais nova.

## A extensão não conecta na ponte

O popup mostra **ponte desconectada**.

1. A ponte está rodando? Deve haver uma janela de terminal com `GPT Ponte ...`. Se não,
   abra o `iniciar.bat`.
2. Abra `http://127.0.0.1:4545/saude` no navegador. Deve aparecer `{"ok":true,...}`.
   - Não abriu: a ponte não está rodando ou está em outra porta.
   - Abriu: confira no popup, em *Configurações*, se o endereço é
     `ws://127.0.0.1:4545/extensao` (com a porta certa), salve e clique em **Tentar de novo**.
3. A extensão está ligada? O interruptor no topo do popup precisa estar verde.
4. Antivírus ou firewall podem bloquear conexões locais; libere o Node.js para a rede
   privada se o Windows perguntar.

Quando a ponte começa a rodar depois do navegador, a extensão a encontra em até 30 segundos.
Clicar no ícone conecta na hora.

## Erro 503: a extensão não está conectada

O seu programa recebe `A extensão GPT Ponte não está conectada...`. A ponte está bem, mas
nenhum navegador com a extensão se conectou nos 30 segundos de espera. Abra o Chrome (o
perfil em que a extensão está instalada) e siga o item anterior.

## A porta já está em uso

`A porta 4545 já está em uso por outro programa.` Outro programa usa a porta. Escolha outra:

```sh
iniciar.bat --porta 5050
```

E ajuste nos dois outros lugares: no popup da extensão (`ws://127.0.0.1:5050/extensao`) e no
seu cliente (`http://127.0.0.1:5050/v1`, ou `node servidor/index.js opencode --instalar --porta 5050`).

Se a mensagem for `A GPT Ponte já está rodando`, já existe uma ponte aberta; use aquela.

## O ChatGPT pediu verificação (captcha)

Erro `O ChatGPT pediu uma verificação anti-robô`. O site às vezes pede para confirmar que é
uma pessoa. A extensão **não** resolve isso: abra a aba de trabalho (a fixada, com o selo GPT
Ponte), resolva a verificação e repita o pedido. Se acontecer com frequência, diminua o ritmo:
muitas mensagens seguidas aumentam a chance de verificação.

## O ChatGPT pediu login

Erro `O ChatGPT pediu login` ou popup com **sem login**. Entre na sua conta em
[chatgpt.com](https://chatgpt.com) no mesmo perfil do Chrome. Se a sessão expirar, o mesmo
erro volta: basta entrar de novo.

## Erro 429: limite de uso

O plano da sua conta tem limites de mensagens por período, que variam por modelo. A ponte
repassa o aviso do site. Espere o tempo indicado ou use outro modelo. Lembre que um agente
manda uma mensagem por passo (cada ferramenta usada é um passo).

## O modelo não usa as ferramentas

O modelo responde coisas como "não tenho acesso aos seus arquivos" ou "execute este comando",
em vez de escrever blocos `<tool_call>`.

- **Sem login**: o modelo gratuito sem conta recusa o formato de ferramentas. Faça login.
- **Conversa muito longa**: o ChatGPT pode ter esquecido as instruções do começo. Compacte
  (`/compact` no OpenCode) ou abra uma sessão nova.
- **Modelo**: modelos menores seguem pior o formato. Prefira o modelo principal da sua conta.
- **Tente de novo**: às vezes é só uma resposta ruim. Mandar "use as ferramentas" costuma
  resolver.

## A resposta veio vazia

Erro `502 A resposta do ChatGPT veio vazia`. Aconteceu nos testes quando a conta sem login
foi rebaixada para o "modelo básico", que respondeu sem texto. Com login, normalmente indica
um problema momentâneo do site: repita. Olhe a aba de trabalho para ver se há algum aviso na
página.

## Não encontrei o campo de mensagem / a página mudou

Erro `pagina_mudou`. A extensão não achou o campo de mensagem ou o botão de enviar.

1. Olhe a aba de trabalho: há algum aviso, pop-up ou página de erro? Feche o aviso e repita.
2. Recarregue a aba (F5) e repita.
3. Se continuar, a OpenAI provavelmente mudou o site. Veja se há versão nova da GPT Ponte,
   ou ajuste os seletores (veja [desenvolvimento.md](desenvolvimento.md#quando-o-site-muda)).

## A aba de trabalho mostra só "GPTPONTE..."

É o esperado. A extensão escreve esse marcador no campo, e o pedido completo vai para o
ChatGPT no lugar dele (veja [como-funciona.md](como-funciona.md#o-marcador)). A sua mensagem
aparece como o marcador e a resposta é ao pedido completo.

Se o ChatGPT responder **ao marcador** ("o que você quer que eu faça com GPTPONTE...?"), a
troca falhou. Quando o script da página vê o pedido sair sem a troca, a extensão passa aquela
aba para o modo *Digitar* e a ponte repete o pedido uma vez, na mesma aba. Se acontecer
sempre, escolha *Digitar o texto no campo* no popup.

## O mesmo pedido aparece em duas abas

No começo de uma sessão do OpenCode saem **dois pedidos diferentes** ao mesmo tempo: a
mensagem do agente e o pedido do título da sessão (no monitor, "título da sessão"). Isso é
normal, e com 2 abas cada um vai para a sua.

Se o **mesmo** prompt aparece em duas abas, você está com a extensão 0.2.0: nela, o plano B do
marcador tinha um falso alarme e repetia o pedido em outra aba. Atualize (veja
[instalacao.md](instalacao.md#atualizar)).

## Toda resposta abre conversa nova

No terminal, todos os pedidos aparecem com `✚` em vez de `↪`. Causas comuns:

- **Só uma aba**: com o OpenCode, o pedido de título disputa a aba com o agente. Use 2 abas no
  popup.
- **O cliente reescreve o histórico**: se ele resume, corta ou reformata mensagens antigas, o
  histórico deixa de bater com a conversa da aba. Nesse caso a ponte reenvia tudo de
  propósito, e o resultado continua certo, só mais lento.
- **A aba recarregou** ou você conversou por ela.
- `--sem-reaproveitar` está ligado.

## Respostas lentas ou tempo esgotado

- Cada resposta passa pela página do ChatGPT, então há alguns segundos a mais que na API.
- Modelos de raciocínio podem pensar por minutos antes de escrever; a ponte aguenta até 10
  minutos sem nenhum sinal e 30 minutos no total (ajuste `inatividadeMs` e `limiteMs`).
- Confira o tempo limite do seu cliente (o SDK da OpenAI usa 10 minutos por padrão; a
  configuração gerada para o OpenCode usa 30).
- Abas em segundo plano por muito tempo podem ficar mais lentas no Chrome. Se notar isso,
  deixe a aba de trabalho numa janela própria.

## Erro 403: origem não permitida

Um site (ou um app web no navegador) tentou chamar a ponte. Se foi você, libere a origem:
`node servidor/index.js --origem http://localhost:3000`. Veja
[clientes.md](clientes.md#páginas-web-e-apps-no-navegador).

## Mensagem grande demais

Erro `400 context_length_exceeded`. O ChatGPT recusou o tamanho da mensagem. Clientes como o
OpenCode reagem compactando a sessão. Se acontecer na primeira mensagem, o seu pedido
(instruções + ferramentas + mensagem) é grande demais para o modelo escolhido: diminua o
pedido ou use um modelo com janela maior.
