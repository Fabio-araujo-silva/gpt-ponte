// Histórico das últimas tarefas, para a página do monitor (monitor.html).
//
// Carregado pelo service worker (importScripts). Guarda em memória e, ao fim de cada
// tarefa, em chrome.storage.session (que some quando o navegador fecha), e avisa ao vivo as
// páginas do monitor que estiverem abertas. Nada disso sai do navegador.

'use strict';

(function () {
  const MAX_TAREFAS = 40;
  const MAX_PROMPT = 400000; // caracteres do prompt guardados em memória por tarefa
  const MAX_PROMPT_SALVO = 60000; // e no storage.session (que tem limite de tamanho)
  const FINAIS = ['concluida', 'erro', 'cancelada'];

  /** @type {any[]} mais recente primeiro */
  const lista = [];
  const porId = new Map();
  const monitores = new Set();
  let timerSalvar = null;

  function semPrompt(t) {
    const copia = Object.assign({}, t);
    delete copia.prompt;
    return copia;
  }

  function difundir(msg) {
    for (const porta of monitores) {
      try {
        porta.postMessage(msg);
      } catch (_) {
        monitores.delete(porta);
      }
    }
  }

  function agendarSalvar() {
    clearTimeout(timerSalvar);
    timerSalvar = setTimeout(() => {
      const copia = lista.map((t) => Object.assign({}, t, { prompt: (t.prompt || '').slice(0, MAX_PROMPT_SALVO) }));
      chrome.storage.session.set({ historico: copia }).catch(() => {});
    }, 1000);
  }

  async function carregar() {
    const { historico = [] } = await chrome.storage.session.get('historico');
    for (const t of historico.slice().reverse()) {
      if (porId.has(t.id)) continue;
      if (!FINAIS.includes(t.estado)) {
        t.estado = 'erro';
        t.erro = t.erro || 'A extensão reiniciou no meio desta tarefa.';
      }
      lista.unshift(t);
      porId.set(t.id, t);
    }
  }

  function nova(m) {
    const agora = Date.now();
    const t = {
      id: m.id,
      inicio: agora,
      rotulo: m.rotulo || (m.nova ? 'conversa nova' : 'continuação'),
      nova: !!m.nova,
      modelo: m.modelo || null,
      prompt: String(m.prompt || '').slice(0, MAX_PROMPT),
      tamanhoPrompt: String(m.prompt || '').length,
      estado: 'na fila',
      etapas: [{ t: agora, nome: 'recebida da ponte' }],
      aba: null,
      texto: '',
      raciocinio: '',
      erro: null,
      enviadoEm: null,
      primeiraResposta: null,
      fim: null,
      conversaServidor: null,
      modeloUsado: null,
    };
    lista.unshift(t);
    porId.set(t.id, t);
    while (lista.length > MAX_TAREFAS) porId.delete(lista.pop().id);
    difundir({ tipo: 'monitor:tarefa', tarefa: semPrompt(t) });
    agendarSalvar();
    return t;
  }

  function atualizar(id, mudancas, etapa) {
    const t = porId.get(id);
    if (!t) return;
    Object.assign(t, mudancas);
    if (etapa) t.etapas.push({ t: Date.now(), nome: etapa });
    difundir({ tipo: 'monitor:tarefa', tarefa: semPrompt(t) });
    if (FINAIS.includes(t.estado)) agendarSalvar();
  }

  function delta(id, texto, raciocinio) {
    const t = porId.get(id);
    if (!t) return;
    if (!t.primeiraResposta && (texto || raciocinio)) t.primeiraResposta = Date.now();
    if (texto) t.texto += texto;
    if (raciocinio) t.raciocinio += raciocinio;
    if (monitores.size) difundir({ tipo: 'monitor:delta', id, texto: texto || '', raciocinio: raciocinio || '', primeiraResposta: t.primeiraResposta });
  }

  function limparConcluidas() {
    for (let i = lista.length - 1; i >= 0; i--) {
      if (FINAIS.includes(lista[i].estado)) {
        porId.delete(lista[i].id);
        lista.splice(i, 1);
      }
    }
    agendarSalvar();
    difundir({ tipo: 'monitor:lista', tarefas: lista.map(semPrompt) });
  }

  /** Liga uma página do monitor: manda o estado atual e responde aos pedidos dela. */
  function conectarMonitor(porta, estado) {
    monitores.add(porta);
    porta.onDisconnect.addListener(() => monitores.delete(porta));
    porta.onMessage.addListener((m) => {
      if (m.tipo === 'monitor:prompt') {
        const t = porId.get(m.id);
        porta.postMessage({ tipo: 'monitor:prompt', id: m.id, prompt: t ? t.prompt : '', tamanho: t ? t.tamanhoPrompt : 0 });
      } else if (m.tipo === 'monitor:limpar') {
        limparConcluidas();
      }
    });
    porta.postMessage({ tipo: 'monitor:inicio', tarefas: lista.map(semPrompt), estado: estado() });
  }

  self.Historico = { carregar, nova, atualizar, delta, conectarMonitor, difundir };
})();
