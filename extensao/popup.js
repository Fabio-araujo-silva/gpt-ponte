'use strict';

const $ = (id) => document.getElementById(id);
let configAtual = null;
let editando = false;

const NOMES_ESTADO = { pronta: 'pronta', ocupada: 'respondendo', carregando: 'carregando', erro: 'com problema' };

function pedir(msg) {
  return chrome.runtime.sendMessage(msg);
}

function enderecoDoPainel(ws) {
  try {
    const u = new URL(ws);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = '/';
    return u.href;
  } catch (_) {
    return 'http://127.0.0.1:4545/';
  }
}

function preencherConfig(c) {
  $('ativo').checked = !!c.ativo;
  $('temporario').checked = !!c.temporario;
  $('temporario-dica').textContent = c.temporario
    ? 'Ligado: as conversas da ponte não ficam no seu histórico nem usam a memória.'
    : 'Desligado: as conversas da ponte aparecem no seu histórico do ChatGPT.';
  if (editando) return;
  $('endereco').value = c.endereco;
  $('maxAbas').value = String(c.maxAbas);
  $('modoEnvio').value = c.modoEnvio;
  $('fixarAbas').checked = !!c.fixarAbas;
}

async function atualizar() {
  let e;
  try {
    e = await pedir({ tipo: 'popup:estado' });
  } catch (_) {
    return;
  }
  if (!e) return;
  configAtual = e.config;
  $('versao').textContent = 'v' + e.versao;
  preencherConfig(e.config);
  $('painel').href = enderecoDoPainel(e.config.endereco);

  const selo = $('selo');
  if (!e.config.ativo) {
    selo.className = 'selo';
    selo.textContent = 'desligada';
    $('detalhe').textContent = 'Ligue no interruptor acima para voltar a atender pedidos.';
    $('reconectar').hidden = true;
  } else if (e.conectado) {
    selo.className = 'selo ok';
    selo.textContent = 'conectada à ponte';
    $('detalhe').textContent = e.versaoPonte ? `Ponte ${e.versaoPonte} em ${e.config.endereco.replace(/^ws:\/\//, '').replace(/\/extensao$/, '')}` : '';
    $('reconectar').hidden = true;
  } else {
    selo.className = 'selo ruim';
    selo.textContent = 'ponte desconectada';
    $('detalhe').textContent = e.erro || 'Inicie a ponte no computador: node servidor/index.js';
    $('reconectar').hidden = false;
  }

  const lista = $('abas');
  lista.textContent = '';
  for (const a of e.abas) {
    const li = document.createElement('li');
    const s = document.createElement('span');
    s.className = 'selo' + (a.estado === 'pronta' ? ' ok' : a.estado === 'erro' ? ' ruim' : '');
    s.textContent = NOMES_ESTADO[a.estado] || a.estado;
    const t = document.createElement('span');
    t.textContent = `Aba ${a.id}${a.logado === false ? ' · sem login' : ''}`;
    li.append(s, t);
    if (a.aviso) {
      const av = document.createElement('span');
      av.className = 'aviso';
      av.textContent = a.aviso;
      li.append(av);
    }
    lista.append(li);
  }
  $('sem-abas').hidden = e.abas.length > 0;
}

$('ativo').addEventListener('change', async () => {
  await pedir({ tipo: 'popup:salvar', config: { ativo: $('ativo').checked } });
  atualizar();
});

$('reconectar').addEventListener('click', async () => {
  $('detalhe').textContent = 'Tentando conectar…';
  await pedir({ tipo: 'popup:reconectar' });
  setTimeout(atualizar, 400);
});

$('abrir-aba').addEventListener('click', () => pedir({ tipo: 'popup:abrir-aba' }));
$('abrir-monitor').addEventListener('click', () => pedir({ tipo: 'popup:abrir-monitor' }));

// O interruptor vale na hora (só para as conversas novas; as abertas continuam como estão).
$('temporario').addEventListener('change', async () => {
  await pedir({ tipo: 'popup:salvar', config: { temporario: $('temporario').checked } });
  atualizar();
});

for (const id of ['endereco', 'maxAbas', 'modoEnvio', 'fixarAbas']) {
  $(id).addEventListener('input', () => {
    editando = true;
  });
}

$('salvar').addEventListener('click', async () => {
  const endereco = $('endereco').value.trim();
  try {
    const u = new URL(endereco);
    if (!/^wss?:$/.test(u.protocol)) throw new Error();
  } catch (_) {
    $('salvo').textContent = 'Endereço inválido (ex.: ws://127.0.0.1:4545/extensao)';
    return;
  }
  await pedir({
    tipo: 'popup:salvar',
    config: {
      endereco,
      maxAbas: Number($('maxAbas').value),
      modoEnvio: $('modoEnvio').value,
      fixarAbas: $('fixarAbas').checked,
    },
  });
  editando = false;
  $('salvo').textContent = 'Salvo.';
  setTimeout(() => ($('salvo').textContent = ''), 1500);
  atualizar();
});

// Abrir o popup também acorda o service worker e tenta conectar na hora.
pedir({ tipo: 'popup:reconectar' }).finally(atualizar);
setInterval(atualizar, 1000);
