// Roda dentro da página do chatgpt.com (MAIN world), antes de qualquer script do site.
//
// Embrulha window.fetch para:
//   1. trocar o marcador curto digitado no campo de mensagem pelo prompt completo, dentro
//      do pedido que o próprio site monta (assim o site cuida de login e verificações);
//   2. copiar a resposta em streaming e repassar o texto para o content script.
//
// Fora das abas de trabalho da extensão ele não faz nada: só repassa o fetch.

(function () {
  'use strict';
  if (window.__gptPonteInstalado) return;
  window.__gptPonteInstalado = true;

  const CANAL = 'gpt-ponte';
  const fetchOriginal = window.fetch;
  /** @type {{id: string, marcador: string|null, prompt: string, desde: number} | null} */
  let armado = null;
  const leitores = new Map(); // id -> leitor do stream (para cancelar)
  const VALIDADE_ARMADO_MS = 120000;

  function postar(msg) {
    window.postMessage(Object.assign({ canal: CANAL, de: 'pagina' }, msg), location.origin);
  }

  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.canal !== CANAL || d.de !== 'conteudo') return;
    if (d.tipo === 'armar') armado = { id: d.id, marcador: d.marcador || null, prompt: d.prompt, desde: Date.now() };
    else if (d.tipo === 'desarmar') {
      if (!d.id || (armado && armado.id === d.id)) armado = null;
    } else if (d.tipo === 'cancelar') {
      if (armado && armado.id === d.id) armado = null;
      const leitor = leitores.get(d.id);
      if (leitor) leitor.cancel().catch(() => {});
      leitores.delete(d.id);
    }
  });

  function caminhoDe(url) {
    try {
      return new URL(url, location.href).pathname;
    } catch (_) {
      return '';
    }
  }

  /** O pedido que envia uma mensagem (app logado, sem login e mweb). */
  function ehEnvioDeMensagem(url, metodo) {
    return metodo === 'POST' && /\/conversation(\/updates)?\/?$/.test(caminhoDe(url));
  }

  function trocarTexto(texto, marcador, prompt) {
    if (!texto.includes(marcador)) return null;
    const t = texto.trimStart();
    let substituto = prompt;
    if (t.startsWith('{') || t.startsWith('[')) substituto = JSON.stringify(prompt).slice(1, -1);
    else if (/^[\w.%-]+=/.test(t) && !t.includes('\n')) substituto = encodeURIComponent(prompt);
    return texto.split(marcador).join(substituto);
  }

  function trocarParametros(params, marcador, prompt) {
    let trocou = false;
    const novo = new URLSearchParams();
    for (const [k, v] of params) {
      if (v.includes(marcador)) {
        trocou = true;
        novo.append(k, v.split(marcador).join(prompt));
      } else novo.append(k, v);
    }
    return trocou ? novo : null;
  }

  function trocarFormulario(form, marcador, prompt) {
    let trocou = false;
    const novo = new FormData();
    for (const [k, v] of form) {
      if (typeof v === 'string' && v.includes(marcador)) {
        trocou = true;
        novo.append(k, v.split(marcador).join(prompt));
      } else novo.append(k, v);
    }
    return trocou ? novo : null;
  }

  /** Devolve [input, init] com o marcador trocado, ou null se o marcador não está no corpo. */
  async function trocarCorpo(input, init, marcador, prompt) {
    const corpo = init ? init.body : undefined;
    if (corpo === undefined || corpo === null) {
      if (input instanceof Request) {
        const texto = await input.clone().text();
        const novo = trocarTexto(texto, marcador, prompt);
        return novo === null ? null : [new Request(input, { body: novo }), init];
      }
      return null;
    }
    let novoCorpo = null;
    if (typeof corpo === 'string') novoCorpo = trocarTexto(corpo, marcador, prompt);
    else if (corpo instanceof URLSearchParams) novoCorpo = trocarParametros(corpo, marcador, prompt);
    else if (typeof FormData !== 'undefined' && corpo instanceof FormData) novoCorpo = trocarFormulario(corpo, marcador, prompt);
    else if (corpo instanceof Blob) {
      const texto = await corpo.text();
      const t = trocarTexto(texto, marcador, prompt);
      novoCorpo = t === null ? null : new Blob([t], { type: corpo.type });
    } else if (corpo instanceof ArrayBuffer || ArrayBuffer.isView(corpo)) {
      const texto = new TextDecoder().decode(corpo);
      const t = trocarTexto(texto, marcador, prompt);
      novoCorpo = t === null ? null : new TextEncoder().encode(t);
    }
    if (novoCorpo === null) return null;
    return [input, Object.assign({}, init, { body: novoCorpo })];
  }

  /** Lê o stream da resposta e repassa o texto em pedaços (só o que cresceu). */
  async function acompanhar(id, resposta) {
    const tipo = resposta.headers.get('content-type') || '';
    const A = window.GptPonteAnalisadores;
    if (!A) {
      postar({ tipo: 'stream-erro', id, mensagem: 'Os analisadores da extensão não carregaram nesta página.' });
      return;
    }
    const analisador = A.criarAnalisador(tipo);
    const leitor = resposta.body.getReader();
    leitores.set(id, leitor);
    const dec = new TextDecoder();
    let enviadoTexto = '';
    let enviadoRac = '';
    let ultimaConversa = null;
    postar({ tipo: 'stream-inicio', id, formato: /ndjson/.test(tipo) ? 'ndjson' : 'sse' });
    const repassar = () => {
      const r = analisador.resultado();
      const msg = { tipo: 'progresso', id };
      let mudou = false;
      if (r.texto.length > enviadoTexto.length && r.texto.startsWith(enviadoTexto)) {
        msg.texto = r.texto.slice(enviadoTexto.length);
        enviadoTexto = r.texto;
        mudou = true;
      }
      if (r.raciocinio.length > enviadoRac.length && r.raciocinio.startsWith(enviadoRac)) {
        msg.raciocinio = r.raciocinio.slice(enviadoRac.length);
        enviadoRac = r.raciocinio;
        mudou = true;
      }
      if (r.conversaId && r.conversaId !== ultimaConversa) {
        msg.conversaId = ultimaConversa = r.conversaId;
        mudou = true;
      }
      if (mudou) postar(msg);
      return r;
    };
    try {
      for (;;) {
        const { done, value } = await leitor.read();
        if (done) break;
        analisador.alimentar(dec.decode(value, { stream: true }));
        repassar();
        // O servidor às vezes deixa a conexão aberta depois do fim (o site cancela a leitura
        // dele ao ver o evento final). A nossa cópia também precisa parar aí.
        if (analisador.terminou) {
          leitor.cancel().catch(() => {});
          break;
        }
      }
      analisador.alimentar(dec.decode());
      analisador.terminar();
      const r = repassar();
      postar({ tipo: 'stream-fim', id, texto: r.texto, raciocinio: r.raciocinio, conversaId: r.conversaId, modelo: r.modelo, erro: r.erro });
    } catch (e) {
      if (leitores.has(id)) postar({ tipo: 'stream-erro', id, mensagem: String((e && e.message) || e) });
    } finally {
      leitores.delete(id);
    }
  }

  window.fetch = function (input, init) {
    let url = '';
    let metodo = 'GET';
    try {
      url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input && input.url) || '';
      metodo = String((init && init.method) || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    } catch (_) {
      return fetchOriginal.apply(this, arguments);
    }
    if (armado && Date.now() - armado.desde > VALIDADE_ARMADO_MS) armado = null;
    if (!ehEnvioDeMensagem(url, metodo)) return fetchOriginal.apply(this, arguments);
    if (!armado) {
      // Envio de mensagem sem tarefa armada. Numa aba de trabalho isso é alguém digitando nela ou
      // um envio repetido; o content script avisa a ponte (nas outras abas ninguém escuta).
      postar({ tipo: 'envio-fora-de-tarefa' });
      return fetchOriginal.apply(this, arguments);
    }
    const tarefa = armado;
    const self = this;
    return (async () => {
      let args = [input, init];
      if (tarefa.marcador) {
        let trocado = null;
        try {
          trocado = await trocarCorpo(input, init, tarefa.marcador, tarefa.prompt);
        } catch (e) {
          postar({ tipo: 'aviso', id: tarefa.id, mensagem: 'Falha ao trocar o marcador: ' + ((e && e.message) || e) });
        }
        if (!trocado) {
          // Um envio de mensagem sem o marcador: ou não é o nosso, ou o corpo veio num formato
          // que não sabemos editar. O content script decide: se a troca não acontecer logo
          // depois (`enviado`), ele para a geração e pede para repetir digitando.
          postar({ tipo: 'envio-sem-marcador', id: tarefa.id });
          return fetchOriginal.call(self, input, init);
        }
        args = trocado;
      }
      if (armado === tarefa) armado = null;
      postar({ tipo: 'enviado', id: tarefa.id });
      const resposta = await fetchOriginal.apply(self, args);
      try {
        const tipo = resposta.headers.get('content-type') || '';
        if (!resposta.ok) {
          resposta
            .clone()
            .text()
            .then((corpo) => postar({ tipo: 'erro-http', id: tarefa.id, status: resposta.status, corpo: corpo.slice(0, 4000) }))
            .catch(() => postar({ tipo: 'erro-http', id: tarefa.id, status: resposta.status, corpo: '' }));
        } else if (resposta.body && (/event-stream|ndjson|json/.test(tipo) || !tipo)) {
          acompanhar(tarefa.id, resposta.clone());
        } else {
          postar({ tipo: 'stream-erro', id: tarefa.id, mensagem: 'Resposta inesperada do ChatGPT (' + tipo + ').' });
        }
      } catch (e) {
        postar({ tipo: 'stream-erro', id: tarefa.id, mensagem: String((e && e.message) || e) });
      }
      return resposta;
    })();
  };
  postar({ tipo: 'pagina-pronta' });
})();
