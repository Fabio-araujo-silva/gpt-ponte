// Lê o stream de resposta do chatgpt.com e devolve o texto acumulado.
//
// Roda no contexto da página (MAIN world) e também no Node, nos testes. Entende os dois
// formatos que o site usa:
//   - SSE (text/event-stream) do app logado: eventos "delta" com operações de patch
//     sobre a mensagem (formato v1) ou a mensagem inteira a cada evento (formato antigo);
//   - NDJSON (application/vnd.openai.conversation-source+ndjson) do app "mweb": eventos
//     "content" com o markdown (ou o fallbackMarkdown do DIL, que vem escapado).

(function (raiz, fabrica) {
  const api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.GptPonteAnalisadores = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ------------------------------------------------------------------ utilidades

  const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
  const PONTUACAO = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

  /**
   * Desfaz o escape do markdown (\* \_ \< ...) e as entidades HTML (&amp; &#124; ...).
   * Com `parcial`, guarda um "\" ou uma entidade incompleta no fim (podem mudar quando
   * chegar o resto), para o texto devolvido só crescer.
   */
  function desescaparMarkdown(s, parcial) {
    let saida = '';
    let i = 0;
    const n = s.length;
    while (i < n) {
      const c = s[i];
      if (c === '\\') {
        if (i + 1 >= n) {
          if (!parcial) saida += c;
          break;
        }
        const prox = s[i + 1];
        if (PONTUACAO.includes(prox)) {
          saida += prox;
          i += 2;
          continue;
        }
        saida += c;
        i++;
        continue;
      }
      if (c === '&') {
        const m = /^&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/.exec(s.slice(i, i + 40));
        if (m) {
          const nome = m[1];
          let valor = null;
          if (nome[0] === '#') {
            const cod = nome[1] === 'x' || nome[1] === 'X' ? parseInt(nome.slice(2), 16) : parseInt(nome.slice(1), 10);
            if (cod > 0 && cod <= 0x10ffff) valor = String.fromCodePoint(cod);
          } else if (Object.prototype.hasOwnProperty.call(ENTIDADES, nome)) valor = ENTIDADES[nome];
          if (valor !== null) {
            saida += valor;
            i += m[0].length;
            continue;
          }
        } else if (parcial && /^&#?[a-zA-Z0-9]{0,31}$/.test(s.slice(i))) {
          break; // entidade ainda chegando
        }
      }
      saida += c;
      i++;
    }
    return saida;
  }

  function ehObjeto(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function textoDeErro(e) {
    if (!e) return '';
    if (typeof e === 'string') return e;
    if (typeof e.message === 'string') return e.message;
    if (typeof e.detail === 'string') return e.detail;
    if (ehObjeto(e.detail) && typeof e.detail.message === 'string') return e.detail.message;
    try {
      return JSON.stringify(e).slice(0, 500);
    } catch (_) {
      return String(e);
    }
  }

  // ------------------------------------------------------------------ SSE (app logado)

  /** Aplica uma operação de patch (formato "delta v1" do ChatGPT) num documento. */
  function aplicarOperacao(doc, op, valor, caminho) {
    const partes = caminho ? caminho.split('/').slice(1).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~')) : [];
    if (!partes.length) {
      if (op === 'append' && typeof doc === 'string') return doc + valor;
      if (op === 'append' && Array.isArray(doc)) return doc.concat(valor);
      if (op === 'remove' || op === 'delete') return undefined;
      return valor;
    }
    if (!ehObjeto(doc) && !Array.isArray(doc)) doc = {};
    let alvo = doc;
    for (let k = 0; k < partes.length - 1; k++) {
      const p = partes[k];
      if (alvo[p] === undefined || alvo[p] === null || typeof alvo[p] !== 'object') alvo[p] = /^\d+$/.test(partes[k + 1]) ? [] : {};
      alvo = alvo[p];
    }
    const ultima = partes[partes.length - 1];
    const atual = alvo[ultima];
    switch (op) {
      case 'append':
        if (typeof atual === 'string') alvo[ultima] = atual + (typeof valor === 'string' ? valor : '');
        else if (Array.isArray(atual)) alvo[ultima] = atual.concat(valor);
        else alvo[ultima] = valor;
        break;
      case 'truncate':
        if (typeof atual === 'string' || Array.isArray(atual)) alvo[ultima] = atual.slice(0, valor);
        break;
      case 'remove':
      case 'delete':
        if (Array.isArray(alvo)) alvo.splice(Number(ultima), 1);
        else delete alvo[ultima];
        break;
      default: // add, replace
        alvo[ultima] = valor;
    }
    return doc;
  }

  function textoDaMensagem(msg) {
    if (!ehObjeto(msg)) return null;
    const conteudo = msg.content;
    if (!ehObjeto(conteudo)) return null;
    const papel = msg.author && msg.author.role;
    const oculto = msg.metadata && msg.metadata.is_visually_hidden_from_conversation;
    if (oculto) return null;
    if (papel === 'assistant' && conteudo.content_type === 'text' && (msg.recipient === undefined || msg.recipient === 'all')) {
      return { tipo: 'texto', texto: (conteudo.parts || []).filter((p) => typeof p === 'string').join('') };
    }
    if (papel === 'assistant' && conteudo.content_type === 'multimodal_text' && (msg.recipient === undefined || msg.recipient === 'all')) {
      return { tipo: 'texto', texto: (conteudo.parts || []).map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('') };
    }
    if (conteudo.content_type === 'thoughts' && Array.isArray(conteudo.thoughts)) {
      return {
        tipo: 'raciocinio',
        texto: conteudo.thoughts.map((t) => [t && t.summary, t && t.content].filter(Boolean).join('\n')).join('\n\n'),
      };
    }
    if (conteudo.content_type === 'reasoning_recap') return null;
    return null;
  }

  function AnalisadorSSE() {
    this.buffer = '';
    this.canais = []; // documentos por "c" (mensagens do stream)
    this.ordem = []; // ordem em que os canais apareceram
    this.canalAtual = 0;
    this.ultimoCaminho = '';
    this.ultimaOp = 'append';
    this.conversaId = null;
    this.mensagemId = null;
    this.modelo = null;
    this.erro = null;
    this.terminou = false;
  }

  AnalisadorSSE.prototype.alimentar = function (pedaco) {
    this.buffer += pedaco.replace(/\r\n/g, '\n');
    let i;
    while ((i = this.buffer.indexOf('\n\n')) >= 0) {
      const bloco = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 2);
      this._evento(bloco);
    }
  };

  AnalisadorSSE.prototype.terminar = function () {
    if (this.buffer.trim()) this._evento(this.buffer);
    this.buffer = '';
    this.terminou = true;
  };

  AnalisadorSSE.prototype._evento = function (bloco) {
    let nome = 'message';
    const dados = [];
    for (const linha of bloco.split('\n')) {
      if (linha.startsWith('event:')) nome = linha.slice(6).trim();
      else if (linha.startsWith('data:')) dados.push(linha.slice(5).replace(/^ /, ''));
    }
    if (!dados.length) return;
    const bruto = dados.join('\n');
    if (bruto === '[DONE]') {
      this.terminou = true;
      return;
    }
    let d;
    try {
      d = JSON.parse(bruto);
    } catch (_) {
      return;
    }
    if (nome === 'delta_encoding') return;
    if (nome === 'delta' || (ehObjeto(d) && ('o' in d || 'p' in d || ('v' in d && Object.keys(d).every((k) => k === 'v' || k === 'c'))))) {
      this._delta(d);
      return;
    }
    if (!ehObjeto(d)) return;
    if (d.error) this.erro = textoDeErro(d.error);
    if (typeof d.conversation_id === 'string') this.conversaId = d.conversation_id;
    if (d.type === 'message_stream_complete') this.terminou = true;
    if (ehObjeto(d.message)) this._mensagemInteira(d);
  };

  AnalisadorSSE.prototype._canal = function (c) {
    if (!this.canais[c]) {
      this.canais[c] = {};
      this.ordem.push(c);
    }
    return this.canais[c];
  };

  AnalisadorSSE.prototype._mensagemInteira = function (envelope) {
    // Formato antigo: cada evento traz a mensagem inteira; o id separa as mensagens.
    const id = envelope.message.id || 'sem-id';
    if (!this._porId) this._porId = {};
    if (this._porId[id] === undefined) this._porId[id] = this.ordem.length ? Math.max.apply(null, this.ordem) + 1 : 0;
    const c = this._porId[id];
    this._canal(c);
    this.canais[c] = envelope;
    this._registrarMeta(envelope);
  };

  AnalisadorSSE.prototype._delta = function (d) {
    if (typeof d.c === 'number') this.canalAtual = d.c;
    const op = d.o || (d.p === undefined ? this.ultimaOp : 'replace');
    if (op === 'patch' && Array.isArray(d.v)) {
      for (const sub of d.v) {
        if (ehObjeto(sub)) this._operacao(sub.o || 'replace', sub.v, sub.p === undefined ? this.ultimoCaminho : sub.p, false);
      }
      return;
    }
    const caminho = d.p === undefined ? this.ultimoCaminho : d.p;
    this._operacao(op, d.v, caminho, true);
  };

  AnalisadorSSE.prototype._operacao = function (op, valor, caminho, lembrar) {
    const c = this.canalAtual;
    const doc = this._canal(c);
    const novo = aplicarOperacao(doc, op, valor, caminho);
    this.canais[c] = novo === undefined ? {} : novo;
    if (lembrar || op === 'append') {
      this.ultimoCaminho = caminho;
      this.ultimaOp = op;
    }
    if (caminho === '' || caminho === '/message' || caminho === '/error' || caminho === '/conversation_id') {
      this._registrarMeta(this.canais[c]);
    }
  };

  AnalisadorSSE.prototype._registrarMeta = function (envelope) {
    if (!ehObjeto(envelope)) return;
    if (typeof envelope.conversation_id === 'string') this.conversaId = envelope.conversation_id;
    if (envelope.error) this.erro = textoDeErro(envelope.error);
    const msg = envelope.message;
    if (ehObjeto(msg) && msg.author && msg.author.role === 'assistant') {
      if (msg.id) this.mensagemId = msg.id;
      if (msg.metadata && typeof msg.metadata.model_slug === 'string') this.modelo = msg.metadata.model_slug;
    }
  };

  AnalisadorSSE.prototype.resultado = function () {
    const textos = [];
    const raciocinios = [];
    for (const c of this.ordem) {
      const envelope = this.canais[c];
      const t = textoDaMensagem(envelope && envelope.message);
      if (!t || !t.texto) continue;
      (t.tipo === 'texto' ? textos : raciocinios).push(t.texto);
    }
    return {
      texto: textos.join('\n\n'),
      raciocinio: raciocinios.join('\n\n'),
      conversaId: this.conversaId,
      mensagemId: this.mensagemId,
      modelo: this.modelo,
      erro: this.erro,
      terminou: this.terminou,
    };
  };

  // ------------------------------------------------------------------ NDJSON (app mweb)

  function AnalisadorNdjson() {
    this.buffer = '';
    this.mensagens = {}; // messageId -> {texto, bruto, status}
    this.ordem = [];
    this.conversaId = null;
    this.mensagemId = null;
    this.erro = null;
    this.terminou = false;
  }

  AnalisadorNdjson.prototype.alimentar = function (pedaco) {
    this.buffer += pedaco;
    let i;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const linha = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (linha) this._linha(linha);
    }
  };

  AnalisadorNdjson.prototype.terminar = function () {
    if (this.buffer.trim()) this._linha(this.buffer.trim());
    this.buffer = '';
    this.terminou = true;
    // No fim, o escape parcial guardado pode ser resolvido.
    for (const id of this.ordem) {
      const m = this.mensagens[id];
      if (m.escapado) m.texto = desescaparMarkdown(m.bruto, false);
    }
  };

  AnalisadorNdjson.prototype._linha = function (linha) {
    let o;
    try {
      o = JSON.parse(linha);
    } catch (_) {
      return;
    }
    if (!ehObjeto(o)) return;
    const detalhe = ehObjeto(o.detail) ? o.detail : null;
    if (o.type === 'content' && typeof o.messageId === 'string') {
      this._conteudo(o);
    } else if (o.type === 'control' && detalhe) {
      if (typeof detalhe.conversationId === 'string') this.conversaId = detalhe.conversationId;
      if (/error|fail/i.test(detalhe.kind || '')) this.erro = textoDeErro(detalhe.error || detalhe.message || detalhe) || 'erro no ChatGPT';
    } else if (o.type === 'state' && ehObjeto(o.conversationState)) {
      const id = o.conversationState.backendConversationId || o.conversationState.conversationId;
      if (typeof id === 'string' && id) this.conversaId = id;
    } else if (o.type === 'end') {
      this.terminou = true;
    } else if (o.type === 'error' || o.error) {
      this.erro = textoDeErro(o.error || o.message || o.detail) || 'erro no ChatGPT';
    }
  };

  AnalisadorNdjson.prototype._conteudo = function (o) {
    const id = o.messageId;
    if (!this.mensagens[id]) {
      this.mensagens[id] = { texto: '', bruto: '', escapado: false, status: '' };
      this.ordem.push(id);
    }
    const m = this.mensagens[id];
    this.mensagemId = id;
    if (o.status) m.status = o.status;
    let novo = null;
    let escapado = false;
    if (typeof o.markdown === 'string' && o.markdown) novo = o.markdown;
    else if (ehObjeto(o.dil) && typeof o.dil.fallbackMarkdown === 'string') {
      novo = o.dil.fallbackMarkdown;
      escapado = true;
    }
    if (novo === null) {
      // Só mudou o status: ao completar, o escape guardado no fim pode ser resolvido.
      if (m.escapado && o.status === 'complete') m.texto = desescaparMarkdown(m.bruto, false);
      return;
    }
    // "replace" troca tudo; "append" pode vir acumulado (começa com o que já temos) ou só o pedaço novo.
    let bruto;
    if (o.mode === 'append' && !(m.bruto && novo.startsWith(m.bruto)) && m.escapado === escapado) bruto = m.bruto + novo;
    else bruto = novo;
    m.bruto = bruto;
    m.escapado = escapado;
    m.texto = escapado ? desescaparMarkdown(bruto, o.status !== 'complete') : bruto;
  };

  AnalisadorNdjson.prototype.resultado = function () {
    const textos = this.ordem.map((id) => this.mensagens[id].texto).filter(Boolean);
    return {
      texto: textos.join('\n\n'),
      raciocinio: '',
      conversaId: this.conversaId,
      mensagemId: this.mensagemId,
      modelo: null,
      erro: this.erro,
      terminou: this.terminou,
    };
  };

  /** Escolhe o analisador pelo Content-Type da resposta. */
  function criarAnalisador(tipoConteudo) {
    if (/ndjson/i.test(tipoConteudo || '')) return new AnalisadorNdjson();
    return new AnalisadorSSE();
  }

  /** Classifica uma mensagem de erro do ChatGPT nos códigos que a ponte entende. */
  function classificarErro(texto, status) {
    const t = String(texto || '').toLowerCase();
    if (status === 429 || /usage cap|rate limit|too many|limite|limit of|reached (our|the|your)|try again later|tente novamente mais tarde/.test(t)) return 'limite';
    if (status === 413 || /too long|too large|longa demais|muito long|context length|maximum length/.test(t)) return 'mensagem_longa';
    if (/captcha|turnstile|verify you are human|verifique|challenge/.test(t)) return 'verificacao';
    if (status === 401 || /log ?in|sign ?in|entrar|session|sessão/.test(t)) return 'sem_login';
    return 'chatgpt';
  }

  return {
    desescaparMarkdown,
    aplicarOperacao,
    AnalisadorSSE,
    AnalisadorNdjson,
    criarAnalisador,
    classificarErro,
  };
});
