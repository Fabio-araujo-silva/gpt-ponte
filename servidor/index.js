#!/usr/bin/env node
// GPT Ponte: ponto de entrada da linha de comando.
//
//   node servidor/index.js              inicia a ponte
//   node servidor/index.js opencode     mostra (ou grava, com --instalar) a config do OpenCode
//   node servidor/index.js teste        manda uma pergunta para a ponte que já está rodando
//   node servidor/index.js teste --ferramentas   testa um ciclo de agente (ferramenta + continuação)

import { carregarConfig, lerArgumentos, ajudaOpcoes, ehLoopback, RAIZ } from './config.js';
import { criarPonte, VERSAO } from './app.js';
import { criarLog } from './log.js';
import { blocoV1, blocoV2, instalarNoOpenCode, arquivoDoOpenCode, versaoDoOpenCode, criarPerfil, ID_PROVEDOR } from './opencode.js';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const AJUDA = `GPT Ponte ${VERSAO}: o ChatGPT do seu navegador como API compatível com a da OpenAI.

Uso:
  node servidor/index.js [opções]          inicia a ponte
  node servidor/index.js opencode          mostra a configuração para o OpenCode
  node servidor/index.js opencode --instalar   grava essa configuração (com backup)
  node servidor/index.js opencode --perfil     cria o perfil "só ChatGPT" (usado pelo opencode-chatgpt)
  node servidor/index.js teste ["pergunta"]    testa a ponte que já está rodando
  node servidor/index.js teste --ferramentas   testa um ciclo de agente de verdade (2 passos)
  node servidor/index.js saude [--esperar <s>] diz se a ponte está no ar (e espera até <s> segundos)
  node servidor/index.js recarregar-extensao   recarrega a extensão (depois de atualizar os arquivos)
${ajudaOpcoes()}`;

function enderecoBase(cfg) {
  const host = ehLoopback(cfg.host) || cfg.host === '0.0.0.0' || cfg.host === '::' ? '127.0.0.1' : cfg.host;
  return `http://${host.includes(':') ? `[${host}]` : host}:${cfg.porta}`;
}

async function iniciar(cfg) {
  const log = criarLog({ nivel: cfg.log });
  if (!ehLoopback(cfg.host) && !cfg.chave) {
    cfg.chave = 'gp-' + randomBytes(18).toString('base64url');
    log.aviso(`A ponte vai escutar em ${cfg.host}, fora deste computador. Para ninguém usar sua conta, ela exige a chave: ${cfg.chave}`);
  }
  const ponte = criarPonte(cfg, { log });
  try {
    await ponte.escutar();
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      const base = enderecoBase(cfg);
      const jaRoda = await fetch(`${base}/saude`)
        .then((r) => r.json())
        .catch(() => null);
      if (jaRoda?.ok) {
        console.log(`A GPT Ponte já está rodando em ${base} (painel: ${base}/).`);
        process.exit(0);
      }
      log.erro(`A porta ${cfg.porta} já está em uso por outro programa. Use --porta para escolher outra.`);
      process.exit(1);
    }
    throw e;
  }
  const base = enderecoBase(cfg);
  const cor = process.stdout.isTTY && !process.env.NO_COLOR;
  const n = (t) => (cor ? `\x1b[1m${t}\x1b[0m` : t);
  console.log(`
  ${n('GPT Ponte')} ${VERSAO}${cfg.simular ? '  (modo simulação: sem navegador)' : ''}

  API (OpenAI):  ${n(base + '/v1')}
  Modelo:        chatgpt
  Chave:         ${cfg.chave ? cfg.chave : 'qualquer uma (só aceita pedidos deste computador)'}
  Painel:        ${base}/

  ${cfg.simular ? 'Respostas simuladas: nada vai para o ChatGPT.' : 'Esperando a extensão: deixe o Chrome aberto com a extensão GPT Ponte instalada.'}
  Para parar: Ctrl+C
`);
  if (!cfg.simular) {
    const aviso = setTimeout(() => {
      if (!ponte.gerente.conectada) {
        log.aviso('A extensão ainda não conectou. Confira se ela está instalada e ativa no Chrome; clicar no ícone dela conecta na hora.');
      }
    }, 35_000);
    aviso.unref();
  }
  const sair = () => {
    console.log('\nEncerrando a ponte...');
    ponte.fechar().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', sair);
  process.on('SIGTERM', sair);
}

function comandoOpenCode(cfg, opcoes) {
  const baseURL = `${enderecoBase(cfg)}/v1`;
  const contexto = opcoes.contexto ? Number(opcoes.contexto) : undefined;
  if (opcoes.perfil) {
    const pasta = typeof opcoes.perfil === 'string' ? path.resolve(opcoes.perfil) : path.join(RAIZ, 'perfil-opencode');
    const arquivo = criarPerfil({ baseURL, chave: cfg.chave, contexto, pasta });
    console.log(`Perfil "só ChatGPT" do OpenCode criado em ${arquivo}`);
    console.log(`Para abrir o OpenCode com ele: opencode-chatgpt.bat (Windows) ou ./opencode-chatgpt.sh, na pasta do seu projeto.`);
    return;
  }
  if (opcoes.instalar) {
    const r = instalarNoOpenCode({ baseURL, chave: cfg.chave, contexto, arquivo: typeof opcoes.arquivo === 'string' ? opcoes.arquivo : undefined });
    console.log(`Provedor "${ID_PROVEDOR}" ${r.acao === 'substituido' ? 'atualizado' : 'adicionado'} em ${r.arquivo}`);
    if (r.backup) console.log(`Backup do arquivo anterior: ${r.backup}`);
    console.log(`\nNo OpenCode, escolha o modelo com /models (ou rode: opencode --model ${r.modelo}).`);
    return;
  }
  const versao = versaoDoOpenCode();
  const v2 = (versao ?? 2) >= 2;
  const bloco = v2 ? blocoV2({ baseURL, chave: cfg.chave, contexto }) : blocoV1({ baseURL, chave: cfg.chave, contexto });
  const raiz = v2 ? 'providers' : 'provider';
  console.log(`Configuração para o OpenCode ${versao ?? '(versão não detectada, usando o formato do 2.x)'}.`);
  console.log(`Arquivo: ${arquivoDoOpenCode()}\n`);
  console.log(JSON.stringify({ [raiz]: { [ID_PROVEDOR]: bloco } }, null, 2));
  console.log(`\nPara gravar automaticamente (com backup): node servidor/index.js opencode --instalar`);
}

/** Pede à extensão conectada que se recarregue (depois de atualizar os arquivos dela). */
async function comandoRecarregarExtensao(cfg) {
  const base = enderecoBase(cfg);
  const r = await fetch(`${base}/extensao/recarregar`, { method: 'POST', headers: { Authorization: `Bearer ${cfg.chave || 'x'}` } }).catch(() => null);
  if (!r) {
    console.error(`A ponte não está rodando em ${base}.`);
    process.exit(1);
  }
  if (!r.ok) {
    console.error('A extensão não está conectada (ou a versão dela é anterior a 0.2.1: recarregue em chrome://extensions).');
    process.exit(1);
  }
  console.log('Pedido enviado: a extensão fecha as abas de trabalho e se recarrega em instantes.');
}

/** Diz se a ponte está no ar (código de saída 0) e se a extensão está conectada. */
async function comandoSaude(cfg, opcoes) {
  const base = enderecoBase(cfg);
  const esperarS = opcoes.esperar ? Number(opcoes.esperar) : 0;
  const ate = Date.now() + esperarS * 1000;
  for (;;) {
    const r = await fetch(`${base}/saude`)
      .then((x) => x.json())
      .catch(() => null);
    if (r?.ok) {
      console.log(`Ponte no ar em ${base} (versão ${r.versao}); extensão ${r.navegadorConectado ? 'conectada' : 'ainda não conectada: abra o Chrome com a extensão GPT Ponte'}.`);
      process.exit(0);
    }
    if (Date.now() >= ate) break;
    await new Promise((x) => setTimeout(x, 500));
  }
  console.log(`A ponte não está rodando em ${base}.`);
  process.exit(1);
}

const COR = process.stdout.isTTY && !process.env.NO_COLOR;
const apagado = (t) => (COR ? `\x1b[2m${t}\x1b[0m` : t);

/**
 * Manda um pedido com stream para a ponte e junta a resposta: texto, raciocínio (onde também
 * chegam as linhas de andamento da ponte), chamadas de ferramenta e o motivo do fim.
 */
async function pedirComStream(cfg, corpo, { aoTexto, aoRaciocinio } = {}) {
  const base = enderecoBase(cfg);
  let resposta;
  try {
    resposta = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.chave || 'teste'}` },
      body: JSON.stringify({ model: 'chatgpt', stream: true, ...corpo }),
    });
  } catch {
    return { erro: `Não consegui falar com a ponte em ${base}. Ela está rodando? (node servidor/index.js)` };
  }
  if (!resposta.ok) {
    const j = await resposta.json().catch(() => ({}));
    return { erro: `Erro ${resposta.status}: ${j?.error?.message || resposta.statusText}` };
  }
  const r = { id: null, texto: '', raciocinio: '', chamadas: [], fim: null, erro: null };
  const leitor = resposta.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const evento = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const linha of evento.split('\n')) {
        if (!linha.startsWith('data: ') || linha === 'data: [DONE]') continue;
        const dados = JSON.parse(linha.slice(6));
        if (dados.error) {
          r.erro = dados.error.message;
          continue;
        }
        r.id ??= dados.id;
        const escolha = dados.choices?.[0];
        const d = escolha?.delta;
        if (d?.content) {
          r.texto += d.content;
          aoTexto?.(d.content);
        }
        if (d?.reasoning_content) {
          r.raciocinio += d.reasoning_content;
          aoRaciocinio?.(d.reasoning_content);
        }
        for (const c of d?.tool_calls ?? []) {
          const ch = (r.chamadas[c.index ?? 0] ??= { id: '', nome: '', argumentos: '' });
          if (c.id) ch.id = c.id;
          if (c.function?.name) ch.nome += c.function.name;
          if (c.function?.arguments) ch.argumentos += c.function.arguments;
        }
        if (escolha?.finish_reason) r.fim = escolha.finish_reason;
      }
    }
  }
  return r;
}

async function comandoTeste(cfg, pergunta) {
  const inicio = Date.now();
  console.log(`Perguntando à ponte em ${enderecoBase(cfg)}...\n`);
  const r = await pedirComStream(
    cfg,
    { messages: [{ role: 'user', content: pergunta || 'Responda só: a ponte funciona!' }] },
    { aoTexto: (t) => process.stdout.write(t), aoRaciocinio: (t) => process.stdout.write(apagado(t)) },
  );
  if (r.erro) {
    console.error(`\n${r.erro}`);
    process.exit(1);
  }
  console.log(`\n\n(${((Date.now() - inicio) / 1000).toFixed(1)} s)`);
}

/**
 * Teste de agente de ponta a ponta, como um cliente tipo OpenCode faria: (1) o modelo tem uma
 * ferramenta e precisa pedi-la; (2) recebe o resultado e responde com o que só estava nele.
 * Depois confere no /estado que cada passo foi ao navegador uma vez só e que o segundo
 * continuou a conversa do primeiro (em vez de reenviar tudo).
 */
async function comandoTesteFerramentas(cfg) {
  const base = enderecoBase(cfg);
  const palavra = `LARANJA-${10 + Math.floor(Math.random() * 90)}`;
  const tools = [
    {
      type: 'function',
      function: {
        name: 'read',
        description: 'Reads a file from the project folder and returns its contents.',
        parameters: { type: 'object', properties: { filePath: { type: 'string', description: 'Path of the file to read' } }, required: ['filePath'] },
      },
    },
  ];
  const messages = [
    { role: 'system', content: "You are a coding agent working in the user's project folder. Look at the files with your tools before answering." },
    { role: 'user', content: 'Qual é a palavra-código escrita no arquivo notas.txt? Responda só com ela.' },
  ];
  const andamento = { aoRaciocinio: (t) => process.stdout.write(apagado(t)) };
  const antes = await fetch(`${base}/estado`).then((x) => x.json()).catch(() => null);
  if (!antes) {
    console.error(`A ponte não está rodando em ${base}. (node servidor/index.js)`);
    process.exit(1);
  }
  // No modo simulação (sem navegador) o simulador só chama ferramentas quando a mensagem pede.
  if (antes.simulado) messages[1].content += '\n/ferramenta read {"filePath": "notas.txt"}';
  else if (!antes.navegador?.conectada) console.log('A extensão ainda não está conectada: a ponte espera por ela até 30 s.\n');
  const falhar = (msg) => {
    console.error(`\n✗ ${msg}`);
    process.exit(1);
  };
  console.log(`Teste de agente na ponte em ${base}: o modelo precisa pedir a ferramenta "read" e depois usar o resultado.\n`);

  let t = Date.now();
  const r1 = await pedirComStream(cfg, { messages, tools }, andamento);
  if (r1.erro) falhar(`Passo 1: ${r1.erro}`);
  const chamada = r1.chamadas[0];
  if (!chamada?.nome) falhar(`Passo 1: o modelo respondeu sem pedir a ferramenta:\n${r1.texto.trim().slice(0, 600)}`);
  console.log(`\n✓ 1/2: pediu ${chamada.nome}(${chamada.argumentos}) em ${((Date.now() - t) / 1000).toFixed(1)} s\n`);

  messages.push({ role: 'assistant', content: r1.texto.trim() || null, tool_calls: [{ id: chamada.id, type: 'function', function: { name: chamada.nome, arguments: chamada.argumentos } }] });
  messages.push({ role: 'tool', tool_call_id: chamada.id, content: `Anotações do projeto\nA palavra-código é ${palavra}.\n` });
  t = Date.now();
  const r2 = await pedirComStream(cfg, { messages, tools }, andamento);
  if (r2.erro) falhar(`Passo 2: ${r2.erro}`);
  if (!r2.texto.includes(palavra)) falhar(`Passo 2: a resposta não trouxe a palavra-código (${palavra}):\n${(r2.texto || '(vazia)').trim().slice(0, 600)}`);
  console.log(`\n✓ 2/2: respondeu "${r2.texto.replace(/\s+/g, ' ').trim().slice(0, 100)}" em ${((Date.now() - t) / 1000).toFixed(1)} s\n`);

  // Como a ponte atendeu cada passo.
  const estado = await fetch(`${base}/estado`).then((x) => x.json()).catch(() => null);
  const p1 = estado?.pedidos?.find((p) => p.id === r1.id);
  const p2 = estado?.pedidos?.find((p) => p.id === r2.id);
  if (!p1 || !p2) {
    console.log('As duas respostas estão certas (não consegui ler o /estado para conferir as abas).');
    return;
  }
  const problemas = [];
  const descrever = (p) => `${p.modo}, ${p.envios ?? '?'} envio(s), aba ${(p.abas ?? [p.aba]).join(', ')}${p.correcoes ? `, ${p.correcoes} correção(ões) automática(s)` : ''}`;
  for (const [n, p] of [[1, p1], [2, p2]]) {
    const esperado = 1 + (p.correcoes ?? 0);
    if ((p.envios ?? 1) > esperado) problemas.push(`o passo ${n} foi ao navegador ${p.envios} vezes (o esperado era ${esperado})`);
  }
  if (p2.modo !== 'continuação') problemas.push('o passo 2 abriu uma conversa nova em vez de continuar a do passo 1');
  else if (String(p2.abas ?? p2.aba) !== String(p1.abas ?? p1.aba)) problemas.push('o passo 2 foi para outra aba');
  console.log(`Passo 1: ${descrever(p1)}\nPasso 2: ${descrever(p2)}\n`);
  if (problemas.length) {
    console.log(`As respostas estão certas, mas: ${problemas.join('; ')}.`);
    process.exit(1);
  }
  console.log('Tudo certo: o modelo usou a ferramenta, cada passo foi ao navegador uma vez e o segundo continuou a conversa do primeiro.');
}

async function main() {
  const { opcoes, posicionais } = lerArgumentos(process.argv.slice(2));
  if (opcoes.ajuda || opcoes.help || opcoes.h) {
    console.log(AJUDA);
    return;
  }
  if (opcoes.versao || opcoes.version) {
    console.log(VERSAO);
    return;
  }
  let cfg;
  try {
    cfg = carregarConfig({ opcoes });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const comando = posicionais[0];
  if (!comando) return iniciar(cfg);
  if (comando === 'opencode') return comandoOpenCode(cfg, opcoes);
  if (comando === 'teste') return opcoes.ferramentas ? comandoTesteFerramentas(cfg) : comandoTeste(cfg, posicionais.slice(1).join(' '));
  if (comando === 'saude') return comandoSaude(cfg, opcoes);
  if (comando === 'recarregar-extensao') return comandoRecarregarExtensao(cfg);
  console.error(`Comando desconhecido: ${comando}\n\n${AJUDA}`);
  process.exit(1);
}

main().catch((e) => {
  console.error(e?.stack || e);
  process.exit(1);
});
