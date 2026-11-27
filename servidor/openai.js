// Rotas no formato da API da OpenAI: /v1/models e /v1/chat/completions (com e sem stream).

import { randomBytes } from 'node:crypto';
import { ErroDaPonte, comoErroDaPonte } from './erros.js';
import {
  normalizarMensagens,
  montarPromptInicial,
  montarContinuacao,
  chavesDosPrefixos,
  mensagemDaResposta,
  estimarTokens,
  contextoDoPedido,
} from './prompt.js';
import { lerFerramentas, LeitorDeFerramentas } from './ferramentas.js';

export const MODELO_PADRAO = 'chatgpt';

function novoId(prefixo) {
  return prefixo + randomBytes(12).toString('hex');
}

/** Corta o texto na primeira sequência de parada (parâmetro "stop"), em streaming. */
class CortadorDeParada {
  constructor(paradas) {
    this.paradas = (Array.isArray(paradas) ? paradas : paradas ? [paradas] : []).filter((s) => typeof s === 'string' && s);
    this.guardado = '';
    this.parou = false;
  }

  get ativo() {
    return this.paradas.length > 0;
  }

  receber(texto) {
    if (!this.ativo) return texto;
    if (this.parou) return '';
    const tudo = this.guardado + texto;
    let corte = -1;
    for (const p of this.paradas) {
      const i = tudo.indexOf(p);
      if (i >= 0 && (corte < 0 || i < corte)) corte = i;
    }
    if (corte >= 0) {
      this.parou = true;
      this.guardado = '';
      return tudo.slice(0, corte);
    }
    const guardar = Math.max(...this.paradas.map((p) => p.length)) - 1;
    const pronto = tudo.slice(0, Math.max(0, tudo.length - guardar));
    this.guardado = tudo.slice(pronto.length);
    return pronto;
  }

  terminar() {
    const resto = this.parou ? '' : this.guardado;
    this.guardado = '';
    return resto;
  }
}

export class ApiOpenAI {
  /**
   * @param {{executor: {executar: Function, estado: Function}, memoria: import('./conversas.js').MemoriaDeConversas, log: any, registro?: any, config: any}} deps
   */
  constructor({ executor, memoria, log, registro, config }) {
    this.executor = executor;
    this.memoria = memoria;
    this.log = log;
    this.registro = registro;
    this.config = config;
  }

  listarModelos() {
    const criado = 1735689600; // fixo: o "modelo" é o ChatGPT do navegador
    const ids = new Set([MODELO_PADRAO]);
    for (const m of this.executor.estado().modelos ?? []) if (m?.id) ids.add(String(m.id));
    return {
      object: 'list',
      data: [...ids].map((id) => ({ id, object: 'model', created: criado, owned_by: 'gpt-ponte' })),
    };
  }

  /** Lê e valida o corpo, decide entre conversa nova e continuação. */
  planejar(corpo) {
    if (!corpo || typeof corpo !== 'object') throw new ErroDaPonte('pedido_invalido', 'O corpo precisa ser um objeto JSON.');
    if (!Array.isArray(corpo.messages) || !corpo.messages.length) {
      throw new ErroDaPonte('pedido_invalido', '"messages" precisa ser uma lista com pelo menos uma mensagem.');
    }
    const modelo = typeof corpo.model === 'string' && corpo.model ? corpo.model : MODELO_PADRAO;
    const mensagens = normalizarMensagens(corpo.messages);
    if (!mensagens.length) throw new ErroDaPonte('pedido_invalido', 'Nenhuma mensagem com papel conhecido (system, user, assistant, tool).');
    const ferramentas = lerFerramentas(corpo.tools);
    const opcoesPrompt = {
      ferramentas,
      toolChoice: corpo.tool_choice,
      paralelas: corpo.parallel_tool_calls !== false,
      formato: corpo.response_format,
    };
    const contexto = contextoDoPedido(modelo, corpo.tools);
    const chaves = chavesDosPrefixos(mensagens, contexto);

    let continuacao = null;
    if (this.config.reaproveitarConversas !== false) {
      const achado = this.memoria.procurar(chaves, (n) => montarContinuacao(mensagens.slice(n), opcoesPrompt) !== null);
      if (achado) {
        continuacao = {
          chave: achado.chave,
          info: achado.info,
          prompt: montarContinuacao(mensagens.slice(achado.mensagens), opcoesPrompt),
        };
      }
    }
    return { modelo, mensagens, ferramentas, opcoesPrompt, contexto, continuacao };
  }

  /** Executa no navegador; se a conversa a continuar sumiu, reenvia tudo numa conversa nova. */
  async executar(plano, aoEvento, sinal) {
    const modelo = plano.modelo === MODELO_PADRAO ? null : plano.modelo;
    const esperaMs = this.config.esperaExtensaoMs ?? 30e3;
    if (plano.continuacao) {
      this.memoria.consumir(plano.continuacao.chave);
      try {
        const r = await this.executor.executar(
          { prompt: plano.continuacao.prompt, nova: false, continuar: plano.continuacao.info, modelo },
          { aoEvento, sinal, esperaMs },
        );
        return { ...r, modo: 'continuação', tamanhoPrompt: plano.continuacao.prompt.length };
      } catch (e) {
        if (e?.codigo !== 'conversa_indisponivel') throw e;
        this.log.info('A conversa não está mais aberta no navegador; reenviando o histórico numa conversa nova.');
      }
    }
    const prompt = montarPromptInicial(plano.mensagens, plano.opcoesPrompt);
    const r = await this.executor.executar({ prompt, nova: true, modelo }, { aoEvento, sinal, esperaMs });
    return { ...r, modo: 'nova', tamanhoPrompt: prompt.length };
  }

  /**
   * POST /v1/chat/completions
   * @param {any} corpo
   * @param {import('node:http').ServerResponse} res
   * @param {AbortSignal} sinalDoCliente
   */
  async chatCompletions(corpo, res, sinalDoCliente) {
    const inicio = Date.now();
    const plano = this.planejar(corpo);
    const stream = corpo.stream === true;
    const incluirUso = stream && corpo.stream_options?.include_usage === true;
    const id = novoId('chatcmpl-');
    const criado = Math.floor(Date.now() / 1000);
    const nomeModelo = plano.modelo;
    const entrada = this.registro?.novo({
      id,
      modelo: nomeModelo,
      stream,
      mensagens: plano.mensagens.length,
      ferramentas: plano.ferramentas.length,
      modo: plano.continuacao ? 'continuação' : 'nova',
    });

    const controle = new AbortController();
    const aoAbortarCliente = () => controle.abort();
    sinalDoCliente?.addEventListener('abort', aoAbortarCliente, { once: true });

    const usaFerramentas = plano.ferramentas.length > 0 && corpo.tool_choice !== 'none';
    const leitor = usaFerramentas ? new LeitorDeFerramentas({ nomes: plano.ferramentas.map((f) => f.nome) }) : null;
    const cortador = new CortadorDeParada(corpo.stop);
    let conteudo = '';
    let raciocinio = '';
    const chamadas = [];
    let cabecalhoEnviado = false;
    let papelEnviado = false;
    let manterViva = null;

    const escrever = (obj) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };
    const enviarCabecalho = () => {
      if (cabecalhoEnviado || !stream) return;
      cabecalhoEnviado = true;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();
      // Comentário SSE a cada 15 s: mantém a conexão viva enquanto o modelo pensa.
      manterViva = setInterval(() => !res.writableEnded && res.write(': gpt-ponte\n\n'), 15e3);
      manterViva.unref?.();
    };
    const pedaco = (delta, motivo = null) => {
      if (!papelEnviado) {
        delta = { role: 'assistant', ...delta };
        papelEnviado = true;
      }
      escrever({ id, object: 'chat.completion.chunk', created: criado, model: nomeModelo, choices: [{ index: 0, delta, logprobs: null, finish_reason: motivo }] });
    };
    const emitir = (eventos) => {
      for (const e of eventos) {
        if (e.tipo === 'texto') {
          conteudo += e.texto;
          if (stream && e.texto) {
            enviarCabecalho();
            pedaco({ content: e.texto });
          }
        } else if (e.tipo === 'chamada') {
          const indice = chamadas.length;
          chamadas.push(e);
          if (stream) {
            enviarCabecalho();
            pedaco({ tool_calls: [{ index: indice, id: e.id, type: 'function', function: { name: e.nome, arguments: e.argumentos } }] });
          }
        }
      }
    };
    let recebido = ''; // texto bruto que chegou da extensão até agora
    const receberTexto = (texto) => {
      recebido += texto;
      const seguro = cortador.receber(texto);
      if (seguro) emitir(leitor ? leitor.receber(seguro) : [{ tipo: 'texto', texto: seguro }]);
      if (cortador.parou) controle.abort();
    };

    const aoEvento = (e) => {
      if (e.tipo === 'inicio') {
        if (entrada) entrada.aba = e.aba;
        enviarCabecalho();
      } else if (e.tipo === 'raciocinio') {
        raciocinio += e.texto;
        if (stream) {
          enviarCabecalho();
          pedaco({ reasoning_content: e.texto });
        }
      } else if (e.tipo === 'texto') {
        receberTexto(e.texto);
      }
    };

    try {
      let resultado = null;
      try {
        resultado = await this.executar(plano, aoEvento, controle.signal);
      } catch (e) {
        if (!(cortador.parou && e?.codigo === 'cancelado')) throw e;
      }
      // O texto final da extensão vale mais que a soma dos pedaços: completa o que faltou.
      const final = resultado?.texto ?? '';
      if (final && !cortador.parou) {
        if (final.startsWith(recebido)) {
          if (final.length > recebido.length) receberTexto(final.slice(recebido.length));
        } else {
          this.log.debug(`O texto final difere do que veio em pedaços (${recebido.length} → ${final.length} caracteres).`);
        }
      }
      // Fecha o streaming: o que estava guardado no cortador e no leitor.
      const resto = cortador.terminar();
      if (resto) emitir(leitor ? leitor.receber(resto) : [{ tipo: 'texto', texto: resto }]);
      if (leitor) emitir(leitor.terminar());

      if (!conteudo.trim() && !chamadas.length) throw new ErroDaPonte('sem_resposta');

      const motivo = chamadas.length ? 'tool_calls' : 'stop';
      const uso = this.calcularUso(plano, conteudo, chamadas, raciocinio);

      if (resultado?.aba != null && !cortador.parou) {
        const depois = [...plano.mensagens, mensagemDaResposta(conteudo, chamadas)];
        const chave = chavesDosPrefixos(depois, plano.contexto).at(-1);
        this.memoria.registrar(chave, { aba: resultado.aba, conversaId: resultado.conversaId, mensagens: depois.length });
      }

      if (stream) {
        enviarCabecalho();
        pedaco({}, motivo);
        if (incluirUso) escrever({ id, object: 'chat.completion.chunk', created: criado, model: nomeModelo, choices: [], usage: uso });
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        const mensagem = { role: 'assistant', content: conteudo || (chamadas.length ? null : '') };
        if (chamadas.length) {
          mensagem.tool_calls = chamadas.map((c) => ({ id: c.id, type: 'function', function: { name: c.nome, arguments: c.argumentos } }));
        }
        if (raciocinio) mensagem.reasoning_content = raciocinio;
        enviarJson(res, 200, {
          id,
          object: 'chat.completion',
          created: criado,
          model: nomeModelo,
          choices: [{ index: 0, message: mensagem, logprobs: null, finish_reason: motivo }],
          usage: uso,
          system_fingerprint: null,
        });
      }
      this.registro?.concluir(entrada, {
        status: 'ok',
        modo: resultado?.modo,
        tamanhoPrompt: resultado?.tamanhoPrompt,
        caracteres: conteudo.length,
        chamadas: chamadas.length,
        duracaoMs: Date.now() - inicio,
      });
      this.log.info(
        `${resultado?.modo === 'continuação' ? '↪' : '✚'} ${nomeModelo}: ${chamadas.length ? chamadas.length + ' chamada(s) de ferramenta' : conteudo.length + ' caracteres'} em ${((Date.now() - inicio) / 1000).toFixed(1)} s` +
          (resultado?.aba != null ? ` (aba ${resultado.aba})` : ''),
      );
    } catch (e) {
      const erro = comoErroDaPonte(e);
      this.registro?.concluir(entrada, { status: 'erro', erro: erro.message, codigo: erro.codigo, duracaoMs: Date.now() - inicio });
      if (erro.codigo === 'cancelado') {
        this.log.info('Pedido cancelado pelo cliente.');
      } else {
        this.log.aviso(`Pedido falhou: ${erro.message}`);
      }
      if (cabecalhoEnviado) {
        escrever(erro.paraOpenAI());
        res.end();
      } else if (!res.headersSent && !res.writableEnded) {
        enviarJson(res, erro.status, erro.paraOpenAI());
      }
    } finally {
      clearInterval(manterViva);
      sinalDoCliente?.removeEventListener('abort', aoAbortarCliente);
    }
  }

  calcularUso(plano, conteudo, chamadas, raciocinio) {
    // O ChatGPT não informa tokens; a estimativa cobre o histórico inteiro, que é o que ocupa
    // o contexto do lado do cliente (e é o que faz o OpenCode compactar na hora certa).
    const entrada = plano.mensagens.reduce((soma, m) => soma + estimarTokens(m.texto) + 4, 0);
    const saida = estimarTokens(conteudo) + chamadas.reduce((s, c) => s + estimarTokens(c.argumentos) + 8, 0);
    const pensamento = estimarTokens(raciocinio);
    return {
      prompt_tokens: entrada,
      completion_tokens: saida + pensamento,
      total_tokens: entrada + saida + pensamento,
      ...(pensamento ? { completion_tokens_details: { reasoning_tokens: pensamento } } : {}),
    };
  }
}

export function enviarJson(res, status, corpo, cabecalhos = {}) {
  if (res.headersSent) {
    res.end();
    return;
  }
  const texto = JSON.stringify(corpo);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(texto), ...cabecalhos });
  res.end(texto);
}
