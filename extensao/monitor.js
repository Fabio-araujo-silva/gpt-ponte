'use strict';

// Monitor ao vivo das chamadas: recebe do service worker cada tarefa e os pedaços de texto
// conforme o ChatGPT responde.

const $ = (id) => document.getElementById(id);

const NOMES = {
  'na fila': 'na fila',
  'abrindo aba': 'abrindo a aba',
  enviando: 'enviando',
  aguardando: 'ChatGPT pensando',
  respondendo: 'respondendo',
  concluida: 'concluída',
  erro: 'erro',
  cancelada: 'cancelada',
};
const FINAIS = ['concluida', 'erro', 'cancelada'];

/** @type {any[]} mais recente primeiro */
let tarefas = [];
let selecionada = null;
let estado = null;
let porta = null;
let desenhoPendente = false;
const prompts = new Map();

// ------------------------------------------------------------------ utilidades

function classeDoEstado(e) {
  if (e === 'concluida') return 'ok';
  if (e === 'erro') return 'ruim';
  if (e === 'cancelada') return '';
  return 'andamento';
}

function segundos(ms) {
  if (ms == null || ms < 0) return '—';
  return ms < 10000 ? (ms / 1000).toFixed(1) + ' s' : Math.round(ms / 1000) + ' s';
}

function hora(t) {
  return new Date(t).toLocaleTimeString('pt-BR', { hour12: false });
}

function milhares(n) {
  return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace('.', ',') + ' mil' : String(n);
}

function el(tag, attrs = {}, ...filhos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'texto') e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const f of filhos) if (f != null) e.append(f);
  return e;
}

/** Quebra a resposta em texto e blocos <tool_call>, para destacar as chamadas de ferramenta. */
function segmentos(texto) {
  const partes = [];
  const re = /<tool_call>([\s\S]*?)(<\/tool_call>|$)/g;
  let ultimo = 0;
  let m;
  while ((m = re.exec(texto))) {
    if (m.index > ultimo) partes.push({ tipo: 'texto', texto: texto.slice(ultimo, m.index) });
    partes.push({ tipo: 'chamada', corpo: m[1], completa: m[2] === '</tool_call>' });
    ultimo = re.lastIndex;
    if (m[0] === '') break;
  }
  if (ultimo < texto.length) partes.push({ tipo: 'texto', texto: texto.slice(ultimo) });
  return partes;
}

function blocoDeChamada(seg) {
  const caixa = el('span', { class: 'ferramenta' });
  let nome = null;
  let args = seg.corpo.trim();
  try {
    const obj = JSON.parse(seg.corpo);
    nome = obj.name || obj.tool || null;
    args = JSON.stringify(obj.arguments ?? obj.args ?? obj, null, 2);
  } catch (_) {
    /* JSON incompleto ou inválido: mostra como veio */
  }
  caixa.append(el('b', { texto: `🔧 ${nome ?? 'chamada de ferramenta'}${seg.completa ? '' : ' (chegando…)'}` }), '\n', args);
  return caixa;
}

// ------------------------------------------------------------------ desenho

function desenharCabecalho() {
  const sel = $('conexao');
  if (!estado) {
    sel.className = 'selo';
    sel.textContent = 'extensão reiniciando…';
    return;
  }
  sel.className = 'selo ' + (estado.conectado ? 'ok' : 'ruim');
  sel.textContent = estado.conectado ? `ponte conectada${estado.versaoPonte ? ' · v' + estado.versaoPonte : ''}` : 'ponte desconectada';
  sel.title = estado.conectado ? '' : estado.erro || '';
  $('temporario').checked = !!estado.config.temporario;
  try {
    const u = new URL(estado.config.endereco);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = '/';
    $('painel').href = u.href;
  } catch (_) {
    /* endereço inválido */
  }
}

function desenharLista() {
  const ol = $('tarefas');
  ol.textContent = '';
  $('vazio').hidden = tarefas.length > 0;
  const rodando = tarefas.filter((t) => !FINAIS.includes(t.estado)).length;
  const erros = tarefas.filter((t) => t.estado === 'erro').length;
  const abas = estado ? estado.abas.length : 0;
  $('resumo').textContent = `${tarefas.length} chamada(s) · ${rodando} em andamento · ${erros} com erro · ${abas} aba(s) de trabalho`;
  for (const t of tarefas) {
    const fim = t.fim || Date.now();
    const li = el(
      'li',
      { class: t.id === selecionada ? 'selecionada' : '' },
      el('span', { class: 'rotulo', texto: t.rotulo }),
      el('span', { class: 'selo ' + classeDoEstado(t.estado), texto: NOMES[t.estado] || t.estado }),
      el('span', {
        class: 'info',
        texto: `${hora(t.inicio)} · ${segundos(fim - t.inicio)} · prompt ${milhares(t.tamanhoPrompt)} car.${t.texto ? ' · resposta ' + milhares(t.texto.length) + ' car.' : ''}${t.aba ? ' · aba ' + t.aba : ''}`,
      }),
    );
    li.addEventListener('click', () => {
      $('seguir').checked = false;
      selecionar(t.id);
    });
    ol.append(li);
  }
}

function desenharDetalhe() {
  const t = tarefas.find((x) => x.id === selecionada);
  $('detalhe').hidden = !t;
  $('nada').hidden = !!t;
  if (!t) return;
  $('d-titulo').textContent = t.rotulo;
  $('d-estado').className = 'selo ' + classeDoEstado(t.estado);
  $('d-estado').textContent = NOMES[t.estado] || t.estado;
  $('d-ver-aba').hidden = !t.aba || !estado || !estado.abas.some((a) => a.id === t.aba);

  const agora = Date.now();
  const fatos = [
    ['Início', hora(t.inicio)],
    ['Aba', t.aba ? String(t.aba) : '—'],
    ['Prompt', `${milhares(t.tamanhoPrompt)} caracteres`],
    ['Até enviar', t.enviadoEm ? segundos(t.enviadoEm - t.inicio) : FINAIS.includes(t.estado) ? '—' : 'em andamento'],
    ['1ª resposta', t.primeiraResposta ? segundos(t.primeiraResposta - t.inicio) : FINAIS.includes(t.estado) ? '—' : 'esperando'],
    ['Total', segundos((t.fim || agora) - t.inicio) + (t.fim ? '' : ' (correndo)')],
    ['Modelo', t.modeloUsado || t.modelo || 'padrão da conta'],
    ['Conversa', t.conversaServidor ? t.conversaServidor.slice(0, 8) + '…' : '—'],
  ];
  const dl = $('d-fatos');
  dl.textContent = '';
  for (const [k, v] of fatos) dl.append(el('div', {}, el('dt', { texto: k }), el('dd', { texto: v })));

  $('d-erro').hidden = !t.erro;
  $('d-erro').textContent = t.erro || '';

  const etapas = $('d-etapas');
  etapas.textContent = '';
  for (const e of t.etapas) etapas.append(el('li', {}, el('span', { class: 'tempo', texto: '+' + segundos(e.t - t.inicio) }), el('span', { texto: e.nome })));

  desenharResposta(t);

  $('d-raciocinio-caixa').hidden = !t.raciocinio;
  $('d-raciocinio').textContent = t.raciocinio || '';

  $('d-prompt-tamanho').textContent = `(${milhares(t.tamanhoPrompt)} caracteres)`;
  if ($('d-prompt-caixa').open) mostrarPrompt(t.id);
}

function desenharResposta(t) {
  const caixa = $('d-resposta');
  caixa.textContent = '';
  if (!t.texto) {
    caixa.append(el('span', { class: 'suave', texto: FINAIS.includes(t.estado) ? '(sem texto)' : 'esperando o ChatGPT escrever…' }));
  } else {
    for (const seg of segmentos(t.texto)) caixa.append(seg.tipo === 'texto' ? seg.texto : blocoDeChamada(seg));
  }
  if (!FINAIS.includes(t.estado)) caixa.append(el('span', { class: 'cursor' }));
  $('d-tamanho').textContent = t.texto ? `(${milhares(t.texto.length)} caracteres)` : '';
}

/** Junta vários pedaços num desenho só (o stream pode mandar dezenas por segundo). */
function pedirDesenho() {
  if (desenhoPendente) return;
  desenhoPendente = true;
  requestAnimationFrame(() => {
    desenhoPendente = false;
    desenharLista();
    desenharDetalhe();
  });
}

function selecionar(id) {
  selecionada = id;
  $('d-prompt').textContent = 'carregando…';
  pedirDesenho();
}

function mostrarPrompt(id) {
  if (prompts.has(id)) {
    $('d-prompt').textContent = prompts.get(id) || '(vazio)';
    return;
  }
  porta && porta.postMessage({ tipo: 'monitor:prompt', id });
}

// ------------------------------------------------------------------ conexão com o service worker

function receber(m) {
  switch (m.tipo) {
    case 'monitor:inicio':
      tarefas = m.tarefas;
      estado = m.estado;
      if (!selecionada && tarefas.length) selecionada = tarefas[0].id;
      desenharCabecalho();
      pedirDesenho();
      break;
    case 'monitor:lista':
      tarefas = m.tarefas;
      if (!tarefas.some((t) => t.id === selecionada)) selecionada = tarefas[0] ? tarefas[0].id : null;
      pedirDesenho();
      break;
    case 'monitor:estado':
      estado = m.estado;
      desenharCabecalho();
      pedirDesenho();
      break;
    case 'monitor:tarefa': {
      const i = tarefas.findIndex((t) => t.id === m.tarefa.id);
      if (i >= 0) tarefas[i] = m.tarefa;
      else {
        tarefas.unshift(m.tarefa);
        if ($('seguir').checked) selecionada = m.tarefa.id;
      }
      pedirDesenho();
      break;
    }
    case 'monitor:delta': {
      const t = tarefas.find((x) => x.id === m.id);
      if (!t) break;
      t.texto += m.texto;
      t.raciocinio += m.raciocinio;
      if (m.primeiraResposta) t.primeiraResposta = m.primeiraResposta;
      pedirDesenho();
      break;
    }
    case 'monitor:prompt':
      prompts.set(m.id, m.prompt);
      if (m.id === selecionada) $('d-prompt').textContent = m.prompt || '(vazio)';
      break;
    default:
      break;
  }
}

function conectar() {
  try {
    porta = chrome.runtime.connect({ name: 'monitor' });
  } catch (_) {
    $('conexao').className = 'selo ruim';
    $('conexao').textContent = 'extensão recarregada: recarregue esta página';
    return;
  }
  porta.onMessage.addListener(receber);
  porta.onDisconnect.addListener(() => {
    // O service worker reiniciou: reconecta e recebe tudo de novo.
    porta = null;
    estado = null;
    desenharCabecalho();
    setTimeout(conectar, 800);
  });
}

// ------------------------------------------------------------------ controles

$('temporario').addEventListener('change', () => {
  chrome.runtime.sendMessage({ tipo: 'popup:salvar', config: { temporario: $('temporario').checked } });
});
$('limpar').addEventListener('click', () => porta && porta.postMessage({ tipo: 'monitor:limpar' }));
$('seguir').addEventListener('change', () => {
  if ($('seguir').checked && tarefas[0]) selecionar(tarefas[0].id);
});
$('d-ver-aba').addEventListener('click', () => {
  const t = tarefas.find((x) => x.id === selecionada);
  if (t && t.aba) chrome.runtime.sendMessage({ tipo: 'popup:ver-aba', aba: t.aba });
});
$('d-prompt-caixa').addEventListener('toggle', () => {
  if ($('d-prompt-caixa').open && selecionada) mostrarPrompt(selecionada);
});
$('d-copiar').addEventListener('click', async () => {
  const texto = prompts.get(selecionada);
  if (!texto) return;
  await navigator.clipboard.writeText(texto);
  $('d-copiado').textContent = 'copiado';
  setTimeout(() => ($('d-copiado').textContent = ''), 1500);
});

// Tempos correndo das chamadas em andamento.
setInterval(() => {
  if (tarefas.some((t) => !FINAIS.includes(t.estado))) pedirDesenho();
}, 1000);

conectar();
