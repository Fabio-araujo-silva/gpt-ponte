// Service worker da extensão GPT Ponte.
//
// Mantém o WebSocket com a ponte local (node servidor/index.js), cuida das abas de
// trabalho do chatgpt.com e leva cada tarefa até a aba certa.

'use strict';

importScripts('historico.js');

const PROTOCOLO = 1;
const PADRAO = {
  endereco: 'ws://127.0.0.1:4545/extensao',
  maxAbas: 2,
  temporario: true, // chats temporários: não aparecem no histórico nem usam a memória
  fixarAbas: true,
  modoEnvio: 'marcador', // 'marcador' (troca no pedido) ou 'digitar' (escreve o prompt inteiro)
  ativo: true,
};

let config = { ...PADRAO };
let ws = null;
let tentativas = 0;
let timerReconexao = null;
let ultimoErroConexao = '';
let versaoPonte = null;
let conectadoDesde = null;

/** @type {Map<number, any>} */
const abas = new Map();
/** @type {Map<string, {aba: number}>} */
const tarefas = new Map();

// ---------------------------------------------------------------------- utilidades

function logLocal(...a) {
  console.log('[GPT Ponte]', ...a);
}

function enviarWs(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

function logPonte(nivel, mensagem) {
  logLocal(mensagem);
  enviarWs({ tipo: 'log', nivel, mensagem });
}

function nomeNavegador() {
  const ua = navigator.userAgent;
  const marcas = (navigator.userAgentData && navigator.userAgentData.brands) || [];
  const marca = marcas.map((b) => b.brand).find((b) => !/not.?a.?brand|chromium/i.test(b));
  if (marca) return marca;
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  return 'Chrome';
}

function novaAba(id) {
  return {
    id,
    porta: null,
    estado: 'carregando', // carregando | pronta | ocupada | erro
    conversa: crypto.randomUUID(), // token local da conversa aberta na aba
    conversaServidor: null,
    virgem: false,
    urlNova: null,
    usadoEm: 0,
    tarefa: null,
    reservada: false,
    frontend: null,
    logado: null,
    aviso: null,
    modoEnvio: null, // força 'digitar' quando o modo marcador falhou nesta aba
    esperas: [],
  };
}

function erroComCodigo(codigo, mensagem) {
  const e = new Error(mensagem);
  e.codigo = codigo;
  return e;
}

// ---------------------------------------------------------------------- inicialização

async function carregarConfig() {
  const salvo = await chrome.storage.local.get(PADRAO);
  config = { ...PADRAO, ...salvo };
}

async function carregarAbas() {
  const { abasTrabalho = [] } = await chrome.storage.session.get('abasTrabalho');
  for (const id of abasTrabalho) {
    try {
      await chrome.tabs.get(id);
      if (!abas.has(id)) abas.set(id, novaAba(id));
    } catch (_) {
      /* a aba foi fechada */
    }
  }
}

function salvarAbas() {
  return chrome.storage.session.set({ abasTrabalho: [...abas.keys()] });
}

const pronto = (async () => {
  await carregarConfig();
  await carregarAbas();
  await self.Historico.carregar().catch(() => {});
  // As abas que já existiam respondem ao "info" quando o content script reconectar.
  conectar();
})();

// ---------------------------------------------------------------------- conexão com a ponte

function urlDeSaude() {
  try {
    const u = new URL(config.endereco);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = '/saude';
    u.search = '';
    return u.href;
  } catch (_) {
    return null;
  }
}

async function conectar() {
  await pronto.catch(() => {});
  if (!config.ativo) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(timerReconexao);
  // Antes do WebSocket, um GET simples: se a ponte não está rodando, não enche o console de erros.
  const saude = urlDeSaude();
  if (!saude) {
    ultimoErroConexao = 'Endereço da ponte inválido.';
    atualizarIcone();
    return;
  }
  try {
    const r = await fetch(saude, { cache: 'no-store' });
    const j = await r.json();
    if (!j || !j.ok) throw new Error('resposta inesperada');
    versaoPonte = j.versao || null;
  } catch (_) {
    ultimoErroConexao = 'A ponte não está rodando (inicie com: node servidor/index.js).';
    atualizarIcone();
    agendarReconexao();
    return;
  }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  let socket;
  try {
    socket = new WebSocket(config.endereco);
  } catch (e) {
    ultimoErroConexao = 'Endereço da ponte inválido: ' + e.message;
    agendarReconexao();
    return;
  }
  ws = socket;
  socket.onopen = () => {
    tentativas = 0;
    ultimoErroConexao = '';
    conectadoDesde = Date.now();
    enviarWs({
      tipo: 'ola',
      protocolo: PROTOCOLO,
      versao: chrome.runtime.getManifest().version,
      navegador: nomeNavegador(),
      config: { maxAbas: config.maxAbas, temporario: config.temporario },
    });
    enviarEstado();
    atualizarIcone();
    // Pede às abas existentes que digam em que pé estão.
    for (const aba of abas.values()) if (aba.porta) aba.porta.postMessage({ tipo: 'info' });
  };
  socket.onmessage = (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch (_) {
      return;
    }
    tratarMensagemDaPonte(m);
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    conectadoDesde = null;
    if (!ultimoErroConexao) ultimoErroConexao = 'A conexão com a ponte caiu.';
    // Respostas em andamento não têm mais para onde ir.
    for (const [id, t] of tarefas) {
      const aba = abas.get(t.aba);
      if (aba && aba.porta) aba.porta.postMessage({ tipo: 'cancelar', id });
    }
    atualizarIcone();
    agendarReconexao();
  };
  socket.onerror = () => {
    ultimoErroConexao = 'Não consegui conectar na ponte em ' + config.endereco;
  };
}

function agendarReconexao() {
  clearTimeout(timerReconexao);
  if (!config.ativo) return;
  const atraso = Math.min(10000, 1000 * 2 ** Math.min(tentativas++, 3));
  timerReconexao = setTimeout(conectar, atraso);
}

function desconectar() {
  clearTimeout(timerReconexao);
  if (ws) {
    const s = ws;
    ws = null;
    s.close(1000, 'desligada');
  }
  atualizarIcone();
}

function tratarMensagemDaPonte(m) {
  switch (m.tipo) {
    case 'bemvindo':
      versaoPonte = m.versao || versaoPonte;
      if (m.protocolo !== PROTOCOLO) logPonte('aviso', `Protocolo diferente: extensão ${PROTOCOLO}, ponte ${m.protocolo}. Atualize as duas.`);
      break;
    case 'ping':
      enviarWs({ tipo: 'pong', t: m.t });
      break;
    case 'tarefa':
      self.Historico.nova(m);
      executarTarefa(m).catch((e) => {
        enviarWs({ tipo: 'erro', id: m.id, codigo: e.codigo || 'sem_aba', mensagem: e.message });
        self.Historico.atualizar(m.id, { estado: 'erro', erro: e.message, fim: Date.now() }, 'falhou');
      });
      break;
    case 'cancelar': {
      const t = tarefas.get(m.id);
      const aba = t && abas.get(t.aba);
      if (aba && aba.porta) aba.porta.postMessage({ tipo: 'cancelar', id: m.id });
      break;
    }
    default:
      break;
  }
}

function resumoDasAbas() {
  return [...abas.values()].map((a) => ({
    id: a.id,
    estado: a.estado,
    conversaId: a.conversa,
    conversaServidor: a.conversaServidor,
    frontend: a.frontend,
    logado: a.logado,
    aviso: a.aviso,
  }));
}

function estadoParaMonitor() {
  return {
    conectado: !!(ws && ws.readyState === WebSocket.OPEN),
    erro: ultimoErroConexao,
    versaoPonte,
    config,
    abas: resumoDasAbas(),
  };
}

function enviarEstado() {
  self.Historico.difundir({ tipo: 'monitor:estado', estado: estadoParaMonitor() });
  const lista = resumoDasAbas();
  const logados = lista.map((a) => a.logado).filter((v) => v !== null);
  enviarWs({
    tipo: 'estado',
    maxAbas: config.maxAbas,
    abas: lista,
    logado: logados.length ? logados.some(Boolean) : null,
  });
  atualizarIcone();
}

function atualizarIcone() {
  const conectado = !!(ws && ws.readyState === WebSocket.OPEN);
  const ocupadas = [...abas.values()].filter((a) => a.estado === 'ocupada').length;
  let texto = '';
  let cor = '#3657d6';
  if (!config.ativo) {
    texto = 'off';
    cor = '#6b7280';
  } else if (!conectado) {
    texto = '!';
    cor = '#b42318';
  } else if (ocupadas) {
    texto = String(ocupadas);
  }
  chrome.action.setBadgeText({ text: texto }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: cor }).catch(() => {});
  chrome.action
    .setTitle({ title: !config.ativo ? 'GPT Ponte: desligada' : conectado ? `GPT Ponte: conectada${ocupadas ? ` (${ocupadas} respondendo)` : ''}` : 'GPT Ponte: ponte desconectada' })
    .catch(() => {});
}

// ---------------------------------------------------------------------- abas de trabalho

function urlNovaConversa(modelo) {
  const u = new URL('https://chatgpt.com/');
  if (config.temporario) u.searchParams.set('temporary-chat', 'true');
  if (modelo) u.searchParams.set('model', modelo);
  u.searchParams.set('gpt-ponte', '1');
  return u.href;
}

function esperarPronta(aba, limiteMs = 60000) {
  if (aba.estado === 'pronta' && aba.porta) return Promise.resolve(aba);
  return new Promise((resolve, reject) => {
    const espera = { resolve, reject };
    espera.timer = setTimeout(() => {
      aba.esperas = aba.esperas.filter((e) => e !== espera);
      reject(erroComCodigo('sem_aba', aba.aviso || 'A aba do ChatGPT não carregou a tempo.'));
    }, limiteMs);
    aba.esperas.push(espera);
  });
}

function resolverEsperas(aba, erro) {
  const esperas = aba.esperas;
  aba.esperas = [];
  for (const e of esperas) {
    clearTimeout(e.timer);
    if (erro) e.reject(erro);
    else e.resolve(aba);
  }
}

async function criarAba(url) {
  const tab = await chrome.tabs.create({ url, active: false, pinned: !!config.fixarAbas, index: 0 });
  const aba = novaAba(tab.id);
  aba.conversa = crypto.randomUUID();
  aba.urlNova = url;
  aba.virgem = true;
  abas.set(tab.id, aba);
  await salvarAbas();
  chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  enviarEstado();
  return aba;
}

async function navegar(aba, url) {
  aba.estado = 'carregando';
  aba.porta = null; // ignora mensagens do documento antigo
  aba.conversa = crypto.randomUUID();
  aba.conversaServidor = null;
  aba.urlNova = url;
  aba.virgem = true;
  aba.aviso = null;
  enviarEstado();
  await chrome.tabs.update(aba.id, { url });
  return esperarPronta(aba);
}

function avisarAbrindoAba(idTarefa) {
  if (!idTarefa) return;
  enviarWs({ tipo: 'etapa', id: idTarefa, etapa: 'abrindo-aba' });
  self.Historico.atualizar(idTarefa, { estado: 'abrindo aba' }, 'abrindo uma conversa nova no ChatGPT');
}

async function abaParaConversaNova(modelo, idTarefa) {
  const url = urlNovaConversa(modelo);
  const livres = [...abas.values()].filter((a) => a.estado !== 'ocupada' && !a.reservada);
  // 1. Uma aba já aberta numa conversa nova, ainda sem uso.
  let aba = livres.find((a) => a.estado === 'pronta' && a.porta && a.virgem && a.urlNova === url);
  if (aba) {
    aba.reservada = true;
    return aba;
  }
  // 2. Ainda cabe uma aba nova.
  if (abas.size < config.maxAbas) {
    avisarAbrindoAba(idTarefa);
    aba = await criarAba(url);
    aba.reservada = true;
    try {
      await esperarPronta(aba);
    } catch (e) {
      aba.reservada = false;
      throw e;
    }
    return aba;
  }
  // 3. Reaproveita a aba livre usada há mais tempo.
  aba = livres.sort((x, y) => x.usadoEm - y.usadoEm)[0];
  if (!aba) throw erroComCodigo('sem_aba', 'Todas as abas do ChatGPT estão ocupadas.');
  aba.reservada = true;
  avisarAbrindoAba(idTarefa);
  try {
    await navegar(aba, url);
  } catch (e) {
    aba.reservada = false;
    throw e;
  }
  return aba;
}

async function executarTarefa(t) {
  await pronto;
  let aba;
  if (!t.nova && t.continuar) {
    aba = abas.get(t.continuar.aba);
    if (!aba || !aba.porta || aba.estado !== 'pronta' || (t.continuar.conversaId && aba.conversa !== t.continuar.conversaId)) {
      throw erroComCodigo('conversa_indisponivel', 'A conversa não está mais aberta no navegador.');
    }
  } else {
    aba = await abaParaConversaNova(t.modelo, t.id);
  }
  aba.reservada = false;
  aba.estado = 'ocupada';
  aba.tarefa = t.id;
  aba.virgem = false;
  aba.usadoEm = Date.now();
  tarefas.set(t.id, { aba: aba.id, tamanho: (t.prompt || '').length });
  self.Historico.atualizar(t.id, { estado: 'enviando', aba: aba.id }, 'entregue à aba ' + aba.id);
  enviarEstado();
  aba.porta.postMessage({
    tipo: 'executar',
    tarefa: { id: t.id, prompt: t.prompt, continuar: !t.nova, modoEnvio: aba.modoEnvio || config.modoEnvio },
  });
}

/**
 * Uma aba carregada em segundo plano às vezes não desenha o campo de mensagem até ficar
 * visível. Traz a aba para frente por um instante e volta para a aba que estava ativa.
 */
async function acordarAba(aba) {
  if (aba.acordando) return;
  aba.acordando = true;
  try {
    const tab = await chrome.tabs.get(aba.id);
    if (tab.active) return;
    const [ativa] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    logPonte('info', 'Aba ' + aba.id + ': em segundo plano o ChatGPT não desenhou o campo de mensagem; trazendo a aba para frente por um instante.');
    await chrome.tabs.update(aba.id, { active: true });
    await new Promise((r) => setTimeout(r, 2500));
    if (ativa && ativa.id !== aba.id) await chrome.tabs.update(ativa.id, { active: true }).catch(() => {});
  } catch (_) {
    /* aba fechou */
  } finally {
    aba.acordando = false;
  }
}

function liberarAba(aba, idTarefa) {
  tarefas.delete(idTarefa);
  if (aba.tarefa === idTarefa) aba.tarefa = null;
  if (aba.estado === 'ocupada') aba.estado = 'pronta';
  aba.usadoEm = Date.now();
  enviarEstado();
}

// Mensagens dos content scripts das abas.
chrome.runtime.onConnect.addListener((porta) => {
  if (porta.name === 'monitor') {
    pronto.then(() => self.Historico.conectarMonitor(porta, estadoParaMonitor));
    return;
  }
  if (porta.name !== 'aba-chatgpt' || !porta.sender || !porta.sender.tab) return;
  const idAba = porta.sender.tab.id;
  pronto.then(() => {
    let aba = abas.get(idAba);
    if (!aba) {
      porta.disconnect();
      return;
    }
    const esperavamNavegacao = aba.esperas.length > 0 || aba.estado === 'carregando';
    if (!esperavamNavegacao && aba.porta !== porta) {
      // A página recarregou sem a extensão pedir (F5, clique em outra conversa...):
      // a conversa anterior não vale mais.
      aba.conversa = crypto.randomUUID();
      aba.virgem = false;
    }
    if (aba.tarefa && aba.porta !== porta) {
      enviarWs({ tipo: 'erro', id: aba.tarefa, codigo: 'conversa_indisponivel', mensagem: 'A aba do ChatGPT recarregou no meio da resposta.' });
      liberarAba(aba, aba.tarefa);
    }
    aba.porta = porta;
    porta.onMessage.addListener((m) => tratarMensagemDaAba(aba, porta, m));
    porta.onDisconnect.addListener(() => {
      if (aba.porta !== porta) return;
      aba.porta = null;
      if (aba.estado !== 'carregando') aba.estado = 'carregando';
      if (aba.tarefa) {
        enviarWs({ tipo: 'erro', id: aba.tarefa, codigo: 'conversa_indisponivel', mensagem: 'A aba do ChatGPT saiu da página no meio da resposta.' });
        liberarAba(aba, aba.tarefa);
      }
      enviarEstado();
    });
  });
});

function tratarMensagemDaAba(aba, porta, m) {
  if (aba.porta !== porta) return;
  switch (m.tipo) {
    case 'pronta':
      aba.frontend = m.frontend || aba.frontend;
      aba.logado = m.logado ?? aba.logado;
      aba.aviso = null;
      if (aba.estado !== 'ocupada') aba.estado = 'pronta';
      if (!m.virgem) aba.virgem = false;
      resolverEsperas(aba);
      enviarEstado();
      break;
    case 'problema':
      aba.estado = 'erro';
      aba.aviso = m.mensagem;
      aba.logado = m.logado ?? aba.logado;
      resolverEsperas(aba, erroComCodigo(m.codigo || 'sem_aba', m.mensagem));
      logPonte('aviso', `Aba ${aba.id}: ${m.mensagem}`);
      enviarEstado();
      break;
    case 'enviado': {
      const t = tarefas.get(m.id);
      enviarWs({ tipo: 'etapa', id: m.id, etapa: 'enviado', detalhe: t ? t.tamanho : undefined, aba: aba.id });
      self.Historico.atualizar(m.id, { estado: 'aguardando', enviadoEm: Date.now() }, 'mensagem enviada ao ChatGPT');
      break;
    }
    case 'inicio':
      enviarWs({ tipo: 'inicio', id: m.id, aba: aba.id, conversaId: aba.conversa });
      self.Historico.atualizar(m.id, { estado: 'respondendo' }, 'o ChatGPT começou a responder');
      break;
    case 'delta':
      enviarWs({ tipo: 'delta', id: m.id, texto: m.texto, raciocinio: m.raciocinio });
      self.Historico.delta(m.id, m.texto, m.raciocinio);
      break;
    case 'fim':
      if (m.conversaServidor) aba.conversaServidor = m.conversaServidor;
      enviarWs({ tipo: 'fim', id: m.id, texto: m.texto, raciocinio: m.raciocinio, aba: aba.id, conversaId: aba.conversa, modelo: m.modelo });
      self.Historico.atualizar(
        m.id,
        { estado: 'concluida', texto: m.texto || '', raciocinio: m.raciocinio || '', fim: Date.now(), conversaServidor: m.conversaServidor || null, modeloUsado: m.modelo || null },
        'resposta completa',
      );
      liberarAba(aba, m.id);
      break;
    case 'acordar':
      acordarAba(aba);
      break;
    case 'erro':
      // O modo marcador falhou nesta página: daqui em diante a aba digita o texto inteiro.
      if (m.modoEnvio) aba.modoEnvio = m.modoEnvio;
      enviarWs({ tipo: 'erro', id: m.id, codigo: m.codigo, mensagem: m.mensagem });
      self.Historico.atualizar(
        m.id,
        { estado: m.codigo === 'cancelado' ? 'cancelada' : 'erro', erro: m.mensagem, fim: Date.now() },
        m.codigo === 'cancelado' ? 'cancelada' : 'erro (' + m.codigo + ')',
      );
      if (m.codigo === 'verificacao' || m.codigo === 'sem_login') {
        aba.aviso = m.mensagem;
      }
      // Depois de um erro a conversa pode ter ficado pela metade: não continua nela.
      aba.conversa = crypto.randomUUID();
      liberarAba(aba, m.id);
      break;
    case 'log':
      logPonte(m.nivel || 'info', `Aba ${aba.id}: ${m.mensagem}`);
      break;
    default:
      break;
  }
}

chrome.tabs.onRemoved.addListener((idAba) => {
  const aba = abas.get(idAba);
  if (!aba) return;
  abas.delete(idAba);
  salvarAbas();
  resolverEsperas(aba, erroComCodigo('sem_aba', 'A aba do ChatGPT foi fechada.'));
  if (aba.tarefa) {
    enviarWs({ tipo: 'erro', id: aba.tarefa, codigo: 'sem_aba', mensagem: 'A aba do ChatGPT foi fechada no meio da resposta.' });
    self.Historico.atualizar(aba.tarefa, { estado: 'erro', erro: 'A aba do ChatGPT foi fechada no meio da resposta.', fim: Date.now() }, 'aba fechada');
    tarefas.delete(aba.tarefa);
  }
  enviarEstado();
});

// ---------------------------------------------------------------------- mensagens avulsas

chrome.runtime.onMessage.addListener((msg, sender, responder) => {
  (async () => {
    await pronto;
    switch (msg && msg.tipo) {
      case 'quem-sou': {
        const id = sender.tab && sender.tab.id;
        if (id === undefined) return responder({ trabalhadora: false });
        if (!abas.has(id) && msg.marcadaNaUrl) {
          // Aba aberta pela extensão antes de um reinício do service worker.
          abas.set(id, novaAba(id));
          abas.get(id).conversa = crypto.randomUUID();
          await salvarAbas();
        }
        return responder({ trabalhadora: abas.has(id) });
      }
      case 'popup:estado':
        return responder({
          conectado: !!(ws && ws.readyState === WebSocket.OPEN),
          conectadoDesde,
          erro: ultimoErroConexao,
          versaoPonte,
          versao: chrome.runtime.getManifest().version,
          config,
          abas: resumoDasAbas(),
        });
      case 'popup:salvar': {
        const antes = config.endereco;
        const novo = { ...config, ...msg.config };
        novo.maxAbas = Math.max(1, Math.min(4, Number(novo.maxAbas) || PADRAO.maxAbas));
        config = novo;
        await chrome.storage.local.set(config);
        if (!config.ativo) desconectar();
        else if (antes !== config.endereco) {
          desconectar();
          tentativas = 0;
          conectar();
        } else {
          conectar();
          if (ws && ws.readyState === WebSocket.OPEN) {
            enviarWs({ tipo: 'ola', protocolo: PROTOCOLO, versao: chrome.runtime.getManifest().version, navegador: nomeNavegador(), config: { maxAbas: config.maxAbas, temporario: config.temporario } });
          }
        }
        enviarEstado();
        return responder({ ok: true });
      }
      case 'popup:reconectar':
        tentativas = 0;
        await conectar();
        return responder({ ok: true });
      case 'popup:abrir-monitor': {
        const url = chrome.runtime.getURL('monitor.html');
        const [aberta] = await chrome.tabs.query({ url });
        if (aberta) {
          await chrome.tabs.update(aberta.id, { active: true });
          await chrome.windows.update(aberta.windowId, { focused: true });
        } else {
          await chrome.tabs.create({ url });
        }
        return responder({ ok: true });
      }
      case 'popup:ver-aba': {
        const aba = abas.get(msg.aba);
        if (aba) {
          const tab = await chrome.tabs.update(aba.id, { active: true });
          if (tab && tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
        }
        return responder({ ok: !!aba });
      }
      case 'popup:abrir-aba': {
        const existente = [...abas.values()][0];
        if (existente) {
          const tab = await chrome.tabs.update(existente.id, { active: true });
          if (tab && tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
        } else {
          const aba = await criarAba(urlNovaConversa(null));
          await chrome.tabs.update(aba.id, { active: true });
        }
        return responder({ ok: true });
      }
      default:
        return responder(null);
    }
  })().catch((e) => {
    try {
      responder({ erro: e.message });
    } catch (_) {
      /* canal fechado */
    }
  });
  return true; // resposta assíncrona
});

// Acorda de tempos em tempos para reconectar (o service worker dorme quando a ponte está fora).
chrome.alarms.create('gpt-ponte-reconectar', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'gpt-ponte-reconectar') conectar();
});
chrome.runtime.onStartup.addListener(() => conectar());
chrome.runtime.onInstalled.addListener(() => {
  conectar();
});
