// Content script (mundo isolado) das abas de trabalho do chatgpt.com.
//
// Recebe tarefas do service worker, escreve no campo de mensagem, aperta enviar e repassa
// o que o script da página (pagina.js) lê do stream da resposta. Em abas que não são de
// trabalho ele não faz nada.

(function () {
  'use strict';
  if (window.__gptPonteConteudo) return;
  window.__gptPonteConteudo = true;

  const CANAL = 'gpt-ponte';
  const A = globalThis.GptPonteAnalisadores; // carregado antes deste arquivo
  let porta = null;
  let atual = null; // tarefa em andamento
  let selo = null;
  let urlDaConversa = null; // caminho da página quando a última resposta terminou

  // ------------------------------------------------------------------ utilidades

  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

  function visivel(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getClientRects();
    if (!r.length) return false;
    const estilo = getComputedStyle(el);
    return estilo.visibility !== 'hidden' && estilo.display !== 'none';
  }

  /**
   * Espera `teste()` devolver algo verdadeiro. Usa MutationObserver (que não sofre a
   * limitação de timers das abas em segundo plano) mais uma checagem periódica.
   */
  function esperar(teste, limiteMs) {
    return new Promise((resolve) => {
      let feito = false;
      const checar = () => {
        if (feito) return;
        let v = null;
        try {
          v = teste();
        } catch (_) {
          v = null;
        }
        if (v) {
          feito = true;
          obs.disconnect();
          clearInterval(intervalo);
          clearTimeout(limite);
          resolve(v);
        }
      };
      const obs = new MutationObserver(checar);
      obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: false });
      const intervalo = setInterval(checar, 250);
      const limite = setTimeout(() => {
        if (feito) return;
        feito = true;
        obs.disconnect();
        clearInterval(intervalo);
        resolve(null);
      }, limiteMs);
      checar();
    });
  }

  function postarPagina(msg) {
    window.postMessage(Object.assign({ canal: CANAL, de: 'conteudo' }, msg), location.origin);
  }

  function enviarFundo(msg) {
    try {
      if (porta) porta.postMessage(msg);
    } catch (_) {
      porta = null;
    }
  }

  function log(nivel, mensagem) {
    enviarFundo({ tipo: 'log', nivel, mensagem });
  }

  function erroComCodigo(codigo, mensagem) {
    const e = new Error(mensagem);
    e.codigo = codigo;
    return e;
  }

  // ------------------------------------------------------------------ leitura da página

  const SELETORES_CAMPO = [
    '#prompt-textarea',
    'form textarea[name="prompt"]',
    'div[contenteditable="true"][role="textbox"]',
    'form [contenteditable="true"]',
    'main form textarea',
    'form textarea',
  ];

  function acharCampo() {
    for (const sel of SELETORES_CAMPO) {
      for (const el of document.querySelectorAll(sel)) {
        if (visivel(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true') return el;
      }
    }
    return null;
  }

  function botoes(escopo) {
    return [...(escopo || document).querySelectorAll('button, [role="button"]')].filter(visivel);
  }

  function rotulo(b) {
    return [b.getAttribute('aria-label'), b.getAttribute('data-testid'), b.id, b.getAttribute('title'), (b.innerText || '').trim()].filter(Boolean).join(' | ');
  }

  function acharBotaoEnviar(campo) {
    const form = campo && campo.closest('form');
    const escopos = form ? [form, document] : [document];
    for (const escopo of escopos) {
      const lista = botoes(escopo);
      const achado =
        lista.find((b) => b.matches('[data-testid="send-button"], #composer-submit-button')) ||
        lista.find((b) => /\b(send|enviar|submit)\b/i.test(b.getAttribute('aria-label') || '')) ||
        (escopo === form ? lista.find((b) => b.type === 'submit') : null);
      if (achado) return achado;
    }
    return null;
  }

  function acharBotaoParar() {
    return (
      botoes().find((b) => b.matches('[data-testid="stop-button"]')) ||
      botoes().find((b) => /\b(stop|parar|interromper)\b/i.test(b.getAttribute('aria-label') || ''))
    );
  }

  function pareceLogado() {
    if (document.querySelector('form[action*="unauth"]')) return false;
    if (document.querySelector('[data-testid="login-button"]')) return false;
    const textos = botoes().map((b) => (b.innerText || '').trim().toLowerCase());
    if (textos.some((t) => t === 'entrar' || t === 'log in' || t === 'fazer login' || t === 'sign up' || t === 'cadastre-se grátis')) return false;
    return true;
  }

  function frontend(campo) {
    if (!campo) return 'desconhecido';
    if (campo.tagName === 'TEXTAREA' && (campo.name === 'prompt' || document.querySelector('form[action*="mweb"]'))) return 'mweb';
    if (campo.id === 'prompt-textarea') return 'classico';
    return campo.tagName === 'TEXTAREA' ? 'textarea' : 'editor';
  }

  /** Por que a página não está utilizável? */
  function diagnosticar() {
    const titulo = document.title || '';
    if (/just a moment|um momento|attention required/i.test(titulo) || document.querySelector('iframe[src*="challenges.cloudflare.com"], #challenge-form, [id^="cf-chl"]')) {
      return { codigo: 'verificacao', mensagem: 'O ChatGPT pediu uma verificação anti-robô. Abra a aba da GPT Ponte e resolva manualmente.' };
    }
    const alerta = [...document.querySelectorAll('[role="alert"], [data-testid*="error"], .text-token-text-error')]
      .filter(visivel)
      .map((e) => (e.innerText || '').trim())
      .find(Boolean);
    if (alerta) return { codigo: A ? A.classificarErro(alerta) : 'chatgpt', mensagem: 'O ChatGPT mostrou: ' + alerta.slice(0, 300) };
    if (!acharCampo() && !pareceLogado()) return { codigo: 'sem_login', mensagem: 'O ChatGPT está pedindo login nesta aba.' };
    return { codigo: 'pagina_mudou', mensagem: 'Não encontrei o campo de mensagem do ChatGPT. Talvez o site tenha mudado; atualize a extensão.' };
  }

  function conversaDaUrl() {
    const m = /\/(?:c|uc|g\/[^/]+\/c)\/([0-9a-f-]{20,})/i.exec(location.pathname);
    return m ? m[1] : null;
  }

  /**
   * Espera o campo de mensagem. Numa aba em segundo plano o ChatGPT às vezes não desenha o
   * campo até a aba ficar visível; nesse caso pede ao service worker para trazê-la à frente.
   */
  async function esperarCampo(limiteMs) {
    let campo = await esperar(acharCampo, Math.min(limiteMs, 8000));
    if (campo || limiteMs <= 8000) return campo;
    if (document.visibilityState === 'hidden') {
      log('info', 'Campo de mensagem não apareceu com a aba escondida; pedindo para mostrá-la.');
      enviarFundo({ tipo: 'acordar' });
    }
    campo = await esperar(acharCampo, limiteMs - 8000);
    return campo;
  }

  function infoDaPagina() {
    const campo = acharCampo();
    return {
      url: location.href,
      frontend: frontend(campo),
      logado: pareceLogado(),
      conversaServidor: conversaDaUrl(),
      virgem: location.pathname === '/' || location.pathname === '',
      temCampo: !!campo,
    };
  }

  // ------------------------------------------------------------------ escrever e enviar

  function escrever(campo, texto) {
    campo.focus();
    if (campo.tagName === 'TEXTAREA' || campo.tagName === 'INPUT') {
      const proto = campo.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const definir = Object.getOwnPropertyDescriptor(proto, 'value').set;
      definir.call(campo, texto);
      campo.dispatchEvent(new Event('input', { bubbles: true }));
      return campo.value === texto;
    }
    // Editor rico (ProseMirror do app logado): seleciona tudo e insere como se fosse digitado.
    const sel = window.getSelection();
    const faixa = document.createRange();
    faixa.selectNodeContents(campo);
    sel.removeAllRanges();
    sel.addRange(faixa);
    document.execCommand('insertText', false, texto);
    const normal = (t) => t.replace(/\s+/g, ' ').trim();
    if (normal(campo.innerText || '') === normal(texto)) return true;
    // Plano B: colar.
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', texto);
      sel.removeAllRanges();
      faixa.selectNodeContents(campo);
      sel.addRange(faixa);
      campo.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    } catch (_) {
      /* segue para a checagem */
    }
    return normal(campo.innerText || '') === normal(texto);
  }

  function limparCampo(campo) {
    try {
      if (campo) escrever(campo, '');
    } catch (_) {
      /* tanto faz */
    }
  }

  async function apertarEnviar(campo) {
    const botao = await esperar(() => {
      const b = acharBotaoEnviar(campo);
      return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' ? b : null;
    }, 6000);
    if (botao) {
      botao.click();
      return true;
    }
    // Sem botão: Enter no campo.
    campo.focus();
    const opcoes = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    campo.dispatchEvent(new KeyboardEvent('keydown', opcoes));
    campo.dispatchEvent(new KeyboardEvent('keyup', opcoes));
    return true;
  }

  function aleatorio() {
    const b = new Uint8Array(8);
    crypto.getRandomValues(b);
    return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  }

  // ------------------------------------------------------------------ tarefas

  function terminar(tipo, dados) {
    if (!atual) return;
    const id = atual.id;
    clearTimeout(atual.vigia);
    atual = null;
    enviarFundo(Object.assign({ tipo, id }, dados));
    atualizarSelo();
  }

  function falhar(codigo, mensagem) {
    if (!atual) return;
    postarPagina({ tipo: 'cancelar', id: atual.id });
    terminar('erro', { codigo, mensagem });
  }

  async function executar(tarefa) {
    if (atual) {
      enviarFundo({ tipo: 'erro', id: tarefa.id, codigo: 'chatgpt', mensagem: 'A aba já está respondendo outra coisa.' });
      return;
    }
    atual = { id: tarefa.id, inicio: Date.now(), enviado: false, comStream: false, texto: '', raciocinio: '' };
    atualizarSelo();
    try {
      if (tarefa.continuar && urlDaConversa && location.pathname !== urlDaConversa) {
        throw erroComCodigo('conversa_indisponivel', 'A aba mudou de conversa.');
      }
      const campo = await esperarCampo(25000);
      if (!campo) {
        const d = diagnosticar();
        throw erroComCodigo(d.codigo, d.mensagem);
      }
      // Se ainda houver uma resposta sendo gerada, espera ela acabar.
      if (acharBotaoParar()) await esperar(() => !acharBotaoParar(), 30000);

      const porMarcador = tarefa.modoEnvio !== 'digitar';
      const marcador = 'GPTPONTE' + aleatorio();
      atual.marcador = porMarcador ? marcador : null;
      postarPagina({ tipo: 'armar', id: tarefa.id, marcador: atual.marcador, prompt: tarefa.prompt });
      if (!escrever(campo, porMarcador ? marcador : tarefa.prompt)) {
        postarPagina({ tipo: 'desarmar', id: tarefa.id });
        throw erroComCodigo('pagina_mudou', 'Não consegui escrever no campo de mensagem do ChatGPT.');
      }
      await dormir(80);
      // O script da página avisa quando o pedido saiu ("enviado"); sem isso em 20 s, algo deu errado.
      atual.vigia = setTimeout(() => {
        if (atual && atual.id === tarefa.id && !atual.enviado) {
          postarPagina({ tipo: 'desarmar', id: tarefa.id });
          const d = diagnosticar();
          limparCampo(acharCampo());
          falhar(d.codigo, d.codigo === 'pagina_mudou' ? 'A mensagem não saiu: o ChatGPT não enviou o pedido. ' + d.mensagem : d.mensagem);
        }
      }, 20000);
      await apertarEnviar(campo);
    } catch (e) {
      falhar(e.codigo || 'chatgpt', e.message || String(e));
    }
  }

  /**
   * Plano B do modo marcador. Só age com prova: o script da página viu o pedido de envio
   * desta tarefa sair SEM o marcador no corpo (formato que ele não soube editar). Aí para a
   * geração e pede para a tarefa ser repetida com o texto digitado, na mesma aba.
   *
   * (Ver o marcador na tela não prova nada: o site logado mostra o balão da mensagem antes
   * de o pedido sair. Usar isso como sinal duplicava os pedidos.)
   */
  function marcadorNaoTrocado(id) {
    setTimeout(() => {
      if (!atual || atual.id !== id || atual.enviado) return;
      log('aviso', 'O pedido de envio saiu sem o marcador (formato que a extensão não sabe editar); repetindo com o texto digitado.');
      postarPagina({ tipo: 'desarmar', id });
      const parar = acharBotaoParar();
      if (parar) parar.click();
      terminar('erro', { codigo: 'reenviar', mensagem: 'O envio não passou pela troca do marcador.', modoEnvio: 'digitar' });
    }, 1500);
  }

  function cancelar(id) {
    if (!atual || atual.id !== id) return;
    postarPagina({ tipo: 'cancelar', id });
    const parar = acharBotaoParar();
    if (parar) parar.click();
    terminar('erro', { codigo: 'cancelado', mensagem: 'Cancelado.' });
  }

  // Mensagens do script da página (pagina.js).
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.canal !== CANAL || d.de !== 'pagina') return;
    if (d.tipo === 'aviso') {
      log('aviso', d.mensagem);
      return;
    }
    if (d.tipo === 'envio-sem-marcador') {
      if (atual && d.id === atual.id && atual.marcador) marcadorNaoTrocado(d.id);
      return;
    }
    if (!atual || d.id !== atual.id) return;
    switch (d.tipo) {
      case 'enviado':
        atual.enviado = true;
        enviarFundo({ tipo: 'enviado', id: d.id });
        clearTimeout(atual.vigia);
        // Do envio até o stream começar: até 2 min (o site pode fazer fila).
        atual.vigia = setTimeout(() => {
          if (atual && atual.id === d.id && !atual.comStream) {
            const diag = diagnosticar();
            falhar(diag.codigo === 'pagina_mudou' ? 'sem_resposta' : diag.codigo, diag.codigo === 'pagina_mudou' ? 'O ChatGPT não começou a responder.' : diag.mensagem);
          }
        }, 120000);
        break;
      case 'stream-inicio':
        atual.comStream = true;
        clearTimeout(atual.vigia);
        enviarFundo({ tipo: 'inicio', id: d.id });
        break;
      case 'progresso':
        if (d.conversaId) atual.conversaServidor = d.conversaId;
        if (d.texto || d.raciocinio) enviarFundo({ tipo: 'delta', id: d.id, texto: d.texto || '', raciocinio: d.raciocinio || '' });
        break;
      case 'stream-fim':
        if (d.erro && !d.texto) {
          const codigo = A ? A.classificarErro(d.erro) : 'chatgpt';
          falhar(codigo, 'O ChatGPT respondeu com erro: ' + d.erro);
          break;
        }
        if (!d.texto && !d.raciocinio) {
          const diag = diagnosticar();
          falhar(diag.codigo === 'pagina_mudou' ? 'sem_resposta' : diag.codigo, diag.codigo === 'pagina_mudou' ? 'A resposta do ChatGPT veio vazia.' : diag.mensagem);
          break;
        }
        // Dá um instante para a URL da conversa se atualizar antes de guardar.
        setTimeout(() => {
          urlDaConversa = location.pathname;
        }, 300);
        urlDaConversa = location.pathname;
        terminar('fim', { texto: d.texto, raciocinio: d.raciocinio || '', conversaServidor: d.conversaId || conversaDaUrl(), modelo: d.modelo || null });
        break;
      case 'erro-http': {
        let detalhe = '';
        try {
          const j = JSON.parse(d.corpo);
          detalhe = (j && (j.detail && (j.detail.message || j.detail)) ) || j.message || j.error || '';
          if (typeof detalhe !== 'string') detalhe = JSON.stringify(detalhe);
        } catch (_) {
          detalhe = (d.corpo || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
        }
        const codigo = A ? A.classificarErro(detalhe, d.status) : 'chatgpt';
        falhar(codigo, `O ChatGPT recusou o envio (HTTP ${d.status})${detalhe ? ': ' + detalhe : '.'}`);
        break;
      }
      case 'stream-erro':
        falhar('chatgpt', 'A resposta foi interrompida: ' + d.mensagem);
        break;
      default:
        break;
    }
  });

  // ------------------------------------------------------------------ selo na página

  let hospedeDoSelo = null;

  function atualizarSelo() {
    if (!document.body) return;
    if (!selo) {
      hospedeDoSelo = document.createElement('div');
      hospedeDoSelo.id = 'gpt-ponte-selo';
      hospedeDoSelo.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647;pointer-events:none;';
      const sombra = hospedeDoSelo.attachShadow({ mode: 'open' });
      sombra.innerHTML =
        '<style>div{font:12px/1.4 system-ui,sans-serif;background:rgba(20,22,28,.86);color:#fff;padding:5px 10px;border-radius:999px;box-shadow:0 2px 8px rgba(0,0,0,.25)}b{color:#7ee0a6}</style><div></div>';
      selo = sombra.querySelector('div');
    }
    // O site pode refazer o <body>: recoloca o selo se ele sumiu.
    if (!hospedeDoSelo.isConnected) document.body.appendChild(hospedeDoSelo);
    selo.innerHTML = atual ? '<b>●</b> GPT Ponte: respondendo…' : '<b>●</b> GPT Ponte: aba de trabalho (não use para conversar)';
  }

  // ------------------------------------------------------------------ ligação com o service worker

  function conectar() {
    try {
      porta = chrome.runtime.connect({ name: 'aba-chatgpt' });
    } catch (_) {
      porta = null; // extensão recarregada: este script ficou órfão
      return;
    }
    porta.onMessage.addListener((m) => {
      if (m.tipo === 'executar') executar(m.tarefa);
      else if (m.tipo === 'cancelar') cancelar(m.id);
      else if (m.tipo === 'info') {
        const info = infoDaPagina();
        enviarFundo(Object.assign(info.temCampo ? { tipo: 'pronta' } : Object.assign({ tipo: 'problema' }, diagnosticar()), info));
      }
    });
    porta.onDisconnect.addListener(() => {
      porta = null;
      // O service worker reiniciou: a tarefa em andamento se perdeu.
      if (atual) cancelar(atual.id);
      setTimeout(conectar, 1000);
    });
    anunciar();
  }

  async function anunciar() {
    const campo = await esperarCampo(35000);
    if (campo) {
      enviarFundo(Object.assign({ tipo: 'pronta' }, infoDaPagina()));
    } else {
      const d = diagnosticar();
      enviarFundo(Object.assign({ tipo: 'problema' }, d, infoDaPagina()));
      // Continua olhando: se a pessoa resolver a verificação ou fizer login, avisa.
      const depois = await esperar(acharCampo, 10 * 60 * 1000);
      if (depois) enviarFundo(Object.assign({ tipo: 'pronta' }, infoDaPagina()));
    }
  }

  function iniciar() {
    if (document.body) atualizarSelo();
    else document.addEventListener('DOMContentLoaded', atualizarSelo, { once: true });
    conectar();
  }

  // Esta aba é de trabalho? (marcada na URL ao ser aberta, ou registrada no service worker)
  const marcadaNaUrl = /[?&]gpt-ponte=1\b/.test(location.search);
  try {
    chrome.runtime.sendMessage({ tipo: 'quem-sou', marcadaNaUrl }, (r) => {
      if (chrome.runtime.lastError) return;
      if (r && r.trabalhadora) iniciar();
    });
  } catch (_) {
    /* extensão recarregada */
  }
})();
