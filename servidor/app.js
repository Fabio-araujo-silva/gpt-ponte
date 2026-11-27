// Servidor HTTP da ponte: API da OpenAI, painel, estado e o WebSocket da extensão.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { aceitarUpgrade } from './websocket.js';
import { GerenteDaExtensao } from './extensao.js';
import { Simulador } from './simulador.js';
import { MemoriaDeConversas } from './conversas.js';
import { RegistroDePedidos } from './registro.js';
import { ApiOpenAI, enviarJson, MODELO_PADRAO } from './openai.js';
import { ErroDaPonte, comoErroDaPonte } from './erros.js';
import { RAIZ, ehLoopback } from './config.js';
import { logMudo } from './log.js';

export const VERSAO = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8')).version;

const LIMITE_CORPO = 64 * 1024 * 1024;
const ORIGEM_EXTENSAO = /^(chrome-extension|moz-extension|safari-web-extension|extension):\/\/[\w.-]+$/;

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    const partes = [];
    let tamanho = 0;
    req.on('data', (p) => {
      tamanho += p.length;
      if (tamanho > LIMITE_CORPO) {
        reject(new ErroDaPonte('pedido_invalido', 'Pedido grande demais (máximo de 64 MB).'));
        req.destroy();
        return;
      }
      partes.push(p);
    });
    req.on('end', () => resolve(Buffer.concat(partes).toString('utf8')));
    req.on('error', reject);
  });
}

function hostDoCabecalho(host) {
  const h = String(host || '').toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0];
}

/**
 * Cria a ponte (ainda sem escutar).
 * @param {ReturnType<import('./config.js').carregarConfig>} config
 */
export function criarPonte(config, { log = logMudo, executor } = {}) {
  const memoria = new MemoriaDeConversas();
  const registro = new RegistroDePedidos();
  const gerente = new GerenteDaExtensao({
    log,
    limiteMs: config.limiteMs,
    inatividadeMs: config.inatividadeMs,
    versao: VERSAO,
  });
  const exec = executor ?? (config.simular ? new Simulador() : gerente);
  const api = new ApiOpenAI({ executor: exec, memoria, log, registro, config });
  const loopback = ehLoopback(config.host);

  gerente.on('desconectou', () => memoria.limpar());
  gerente.on('estado', (s) => {
    // Abas que sumiram ou trocaram de conversa não servem mais para continuar.
    const vivas = new Map((s.abas ?? []).map((a) => [a.id, a]));
    for (const [chave, info] of memoria.porChave) {
      const aba = vivas.get(info.aba);
      if (!aba || (info.conversaId && aba.conversaId && aba.conversaId !== info.conversaId)) memoria.consumir(chave);
    }
  });

  function hostPermitido(req) {
    if (!loopback) return true;
    const h = hostDoCabecalho(req.headers.host);
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(h);
  }

  function origemPermitida(req) {
    const origem = req.headers.origin;
    if (!origem || origem === 'null') return { ok: !origem, cors: null };
    if (origem === `http://${req.headers.host}`) return { ok: true, cors: null };
    if (config.origens.includes('*') || config.origens.includes(origem)) return { ok: true, cors: origem };
    return { ok: false, cors: null };
  }

  function autorizado(req) {
    if (!config.chave) return true;
    const auth = String(req.headers.authorization || '');
    const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : String(req.headers['x-api-key'] || req.headers['api-key'] || '');
    return token === config.chave;
  }

  function estado() {
    return {
      nome: 'gpt-ponte',
      versao: VERSAO,
      simulado: !!config.simular,
      endereco: `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${config.porta}`,
      exigeChave: !!config.chave,
      navegador: exec.estado(),
      conversasLembradas: memoria.tamanho,
      totais: registro.totais,
      pedidos: registro.lista(30),
    };
  }

  async function tratar(req, res) {
    const url = new URL(req.url, 'http://ponte');
    const rota = url.pathname.replace(/\/+$/, '') || '/';

    if (!hostPermitido(req)) {
      enviarJson(res, 403, new ErroDaPonte('origem_bloqueada', 'Host não permitido.').paraOpenAI());
      return;
    }
    const origem = origemPermitida(req);
    if (!origem.ok) {
      enviarJson(res, 403, new ErroDaPonte('origem_bloqueada', `Origem ${req.headers.origin} não permitida. Use --origem para liberar.`).paraOpenAI());
      return;
    }
    if (origem.cors) {
      res.setHeader('Access-Control-Allow-Origin', origem.cors);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-api-key, openai-organization, openai-project');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && (rota === '/' || rota === '/painel')) {
      const html = fs.readFileSync(path.join(RAIZ, 'servidor', 'painel.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && rota === '/estado') {
      enviarJson(res, 200, estado(), { 'Cache-Control': 'no-store' });
      return;
    }
    if (req.method === 'GET' && (rota === '/saude' || rota === '/health')) {
      const nav = exec.estado();
      enviarJson(res, 200, { ok: true, versao: VERSAO, navegadorConectado: !!nav.conectada });
      return;
    }

    const caminhoApi = rota.replace(/^\/v1(?=\/)/, '');
    const ehApi = ['/models', '/chat/completions'].includes(caminhoApi) || caminhoApi.startsWith('/models/');
    if (!ehApi) {
      enviarJson(res, 404, new ErroDaPonte('nao_encontrado', `Rota não encontrada: ${req.method} ${url.pathname}`).paraOpenAI());
      return;
    }
    if (!autorizado(req)) {
      enviarJson(res, 401, new ErroDaPonte('nao_autorizado').paraOpenAI());
      return;
    }

    if (req.method === 'GET' && caminhoApi === '/models') {
      enviarJson(res, 200, api.listarModelos());
      return;
    }
    if (req.method === 'GET' && caminhoApi.startsWith('/models/')) {
      const id = decodeURIComponent(caminhoApi.slice('/models/'.length));
      const modelo = api.listarModelos().data.find((m) => m.id === id) ?? { id, object: 'model', created: 1735689600, owned_by: 'gpt-ponte' };
      enviarJson(res, 200, modelo);
      return;
    }
    if (req.method === 'POST' && caminhoApi === '/chat/completions') {
      let corpo;
      try {
        const texto = await lerCorpo(req);
        corpo = JSON.parse(texto || 'null');
      } catch (e) {
        const erro = e instanceof ErroDaPonte ? e : new ErroDaPonte('pedido_invalido', 'O corpo do pedido não é JSON válido.');
        enviarJson(res, erro.status, erro.paraOpenAI());
        return;
      }
      const controle = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) controle.abort();
      });
      await api.chatCompletions(corpo, res, controle.signal);
      return;
    }
    enviarJson(res, 405, new ErroDaPonte('nao_encontrado', `Método ${req.method} não suportado em ${url.pathname}.`).paraOpenAI());
  }

  const servidor = http.createServer((req, res) => {
    tratar(req, res).catch((e) => {
      const erro = comoErroDaPonte(e);
      log.erro('Erro ao tratar pedido:', e);
      if (!res.headersSent) enviarJson(res, erro.status, erro.paraOpenAI());
      else res.end();
    });
  });
  servidor.keepAliveTimeout = 65_000;
  servidor.requestTimeout = 0; // respostas longas (o modelo pode pensar por minutos)
  servidor.headersTimeout = 60_000;

  servidor.on('upgrade', (req, socket, cabeca) => {
    const rota = new URL(req.url, 'http://ponte').pathname;
    if (rota !== '/extensao' || !hostPermitido(req)) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const conexao = aceitarUpgrade(req, socket, cabeca, { origemPermitida: (o) => ORIGEM_EXTENSAO.test(o) });
    if (conexao) gerente.aceitar(conexao);
  });

  return {
    config,
    servidor,
    gerente,
    executor: exec,
    api,
    memoria,
    registro,
    estado,
    modeloPadrao: MODELO_PADRAO,
    escutar() {
      return new Promise((resolve, reject) => {
        servidor.once('error', reject);
        servidor.listen(config.porta, config.host, () => {
          servidor.off('error', reject);
          resolve(servidor.address());
        });
      });
    },
    fechar() {
      gerente.cancelarTudo();
      gerente.conexao?.destruir();
      return new Promise((resolve) => {
        servidor.close(() => resolve());
        servidor.closeAllConnections?.();
      });
    },
  };
}
