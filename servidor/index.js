#!/usr/bin/env node
// GPT Ponte: ponto de entrada da linha de comando.
//
//   node servidor/index.js              inicia a ponte
//   node servidor/index.js opencode     mostra (ou grava, com --instalar) a config do OpenCode
//   node servidor/index.js teste        manda uma pergunta para a ponte que já está rodando

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

async function comandoTeste(cfg, pergunta) {
  const base = enderecoBase(cfg);
  const inicio = Date.now();
  console.log(`Perguntando à ponte em ${base}...`);
  let resposta;
  try {
    resposta = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.chave || 'teste'}` },
      body: JSON.stringify({ model: 'chatgpt', stream: true, messages: [{ role: 'user', content: pergunta || 'Responda só: a ponte funciona!' }] }),
    });
  } catch {
    console.error(`Não consegui falar com a ponte em ${base}. Ela está rodando? (node servidor/index.js)`);
    process.exit(1);
  }
  if (!resposta.ok) {
    const corpo = await resposta.json().catch(() => ({}));
    console.error(`Erro ${resposta.status}: ${corpo?.error?.message || resposta.statusText}`);
    process.exit(1);
  }
  const leitor = resposta.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  process.stdout.write('\n');
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
          console.error(`\nErro: ${dados.error.message}`);
          process.exit(1);
        }
        const d = dados.choices?.[0]?.delta;
        if (d?.content) process.stdout.write(d.content);
      }
    }
  }
  console.log(`\n\n(${((Date.now() - inicio) / 1000).toFixed(1)} s)`);
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
  if (comando === 'teste') return comandoTeste(cfg, posicionais.slice(1).join(' '));
  if (comando === 'saude') return comandoSaude(cfg, opcoes);
  if (comando === 'recarregar-extensao') return comandoRecarregarExtensao(cfg);
  console.error(`Comando desconhecido: ${comando}\n\n${AJUDA}`);
  process.exit(1);
}

main().catch((e) => {
  console.error(e?.stack || e);
  process.exit(1);
});
