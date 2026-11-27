// Configuração: valores padrão < config.local.json < variáveis de ambiente < argumentos.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PADRAO = Object.freeze({
  porta: 4545,
  host: '127.0.0.1',
  chave: '', // se definida, a API exige "Authorization: Bearer <chave>"
  esperaExtensaoMs: 30_000, // quanto um pedido espera a extensão conectar
  limiteMs: 30 * 60_000, // tempo máximo de uma resposta
  inatividadeMs: 10 * 60_000, // tempo máximo sem nenhum sinal do navegador
  reaproveitarConversas: true,
  progresso: true, // linhas de andamento no reasoning_content enquanto o ChatGPT não escreve
  origens: [], // sites liberados para chamar a API pelo navegador (CORS)
  log: 'info',
  simular: false,
});

const AJUDA_OPCOES = `
Opções:
  --porta <n>            porta da API (padrão ${PADRAO.porta})
  --host <endereço>      endereço de escuta (padrão ${PADRAO.host}; use 0.0.0.0 para a rede local)
  --chave <texto>        exige "Authorization: Bearer <texto>" nos pedidos
  --origem <url>         libera um site para chamar a API pelo navegador (pode repetir)
  --sem-reaproveitar     sempre abre conversa nova (reenvia o histórico inteiro)
  --sem-progresso        não escreve o andamento no bloco de raciocínio do cliente
  --simular              responde sem navegador (para testar a ligação com o cliente)
  --log <nível>          debug, info, aviso ou erro
  --config <arquivo>     lê opções de um JSON (padrão: config.local.json, se existir)
`;

export function ajudaOpcoes() {
  return AJUDA_OPCOES;
}

/** Lê "--chave valor" e "--chave=valor"; devolve {opcoes, posicionais}. */
export function lerArgumentos(argv) {
  const opcoes = {};
  const posicionais = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      posicionais.push(a);
      continue;
    }
    const igual = a.indexOf('=');
    const nome = (igual >= 0 ? a.slice(2, igual) : a.slice(2)).trim();
    let valor = igual >= 0 ? a.slice(igual + 1) : undefined;
    if (valor === undefined) {
      const prox = argv[i + 1];
      if (prox !== undefined && !prox.startsWith('--')) {
        valor = prox;
        i++;
      } else valor = true;
    }
    if (opcoes[nome] !== undefined) opcoes[nome] = [].concat(opcoes[nome], valor);
    else opcoes[nome] = valor;
  }
  return { opcoes, posicionais };
}

function numero(v, nome) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Valor inválido para ${nome}: ${v}`);
  return n;
}

export function carregarConfig({ opcoes = {}, env = process.env, raiz = RAIZ } = {}) {
  const cfg = { ...PADRAO, origens: [] };

  const arquivo = typeof opcoes.config === 'string' ? path.resolve(opcoes.config) : path.join(raiz, 'config.local.json');
  if (fs.existsSync(arquivo)) {
    let lido;
    try {
      lido = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    } catch (e) {
      throw new Error(`Não consegui ler ${arquivo}: ${e.message}`);
    }
    for (const [k, v] of Object.entries(lido)) if (k in PADRAO) cfg[k] = v;
    cfg.arquivo = arquivo;
  } else if (typeof opcoes.config === 'string') {
    throw new Error(`Arquivo de configuração não encontrado: ${arquivo}`);
  }

  if (env.GPT_PONTE_PORTA) cfg.porta = numero(env.GPT_PONTE_PORTA, 'GPT_PONTE_PORTA');
  if (env.GPT_PONTE_HOST) cfg.host = env.GPT_PONTE_HOST;
  if (env.GPT_PONTE_CHAVE) cfg.chave = env.GPT_PONTE_CHAVE;
  if (env.GPT_PONTE_LOG) cfg.log = env.GPT_PONTE_LOG;

  if (opcoes.porta !== undefined) cfg.porta = numero(opcoes.porta, '--porta');
  if (typeof opcoes.host === 'string') cfg.host = opcoes.host;
  if (typeof opcoes.chave === 'string') cfg.chave = opcoes.chave;
  if (opcoes.origem !== undefined) cfg.origens = [...cfg.origens, ...[].concat(opcoes.origem).filter((o) => typeof o === 'string')];
  if (opcoes['sem-reaproveitar']) cfg.reaproveitarConversas = false;
  if (opcoes['sem-progresso']) cfg.progresso = false;
  if (opcoes.simular) cfg.simular = true;
  if (typeof opcoes.log === 'string') cfg.log = opcoes.log;

  if (!Number.isInteger(cfg.porta) || cfg.porta < 0 || cfg.porta > 65535) throw new Error(`Porta inválida: ${cfg.porta}`);
  cfg.origens = cfg.origens.map((o) => String(o).replace(/\/+$/, ''));
  return cfg;
}

export function ehLoopback(host) {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(host).toLowerCase()) || /^127\./.test(host);
}
