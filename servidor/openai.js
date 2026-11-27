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
import { lerFerramentas, LeitorDeFerramentas, blocoComoTexto, ABRE, FECHA } from './ferramentas.js';

export const MODELO_PADRAO = 'chatgpt';

// Frases de "não tenho acesso" (pt e en). Só valem no começo de uma resposta sem blocos.
const RECUSAS = [
  /n[ãa]o tenho (acesso|como acessar|permiss[ãa]o para acessar)/i,
  /n[ãa]o (consigo|posso|sou capaz de) (acessar|executar comandos|rodar comandos|ver (os |seus )?arquivos|ler (os |seus )?arquivos|mexer no seu|navegar n)/i,
  /sem acesso (direto )?(ao|aos|à|às) (seu|sua|seus|suas)/i,
  /\bI (do not|don't|can't|cannot) (have )?(direct |any )?access\b/i,
  /\bI(?:'m| am) (unable|not able) to (access|run|execute|read|see|browse)\b/i,
  /\bI (can't|cannot) (run|execute) (commands|code|anything|programs)\b/i,
];

/** O começo da resposta é o modelo dizendo que não tem acesso ao computador? */
export function pareceRecusa(texto) {
  if (!texto || texto.length > 1500 || texto.includes(ABRE)) return false;
  return RECUSAS.some((r) => r.test(texto));
}

/** Pede ao modelo que reescreva os blocos que não deram para usar. */
export function mensagemDeCorrecao(invalidos) {
  const itens = invalidos
    .slice(0, 5)
    .map((inv) => `- ${inv.motivo}\n  Block: ${inv.bruto.trim().slice(0, 300)}${inv.bruto.trim().length > 300 ? '…' : ''}`)
    .join('\n');
  return [
    'The app could not use the request block(s) in your last reply:',
    itens,
    '',
    `Please write the request block(s) again, correctly: valid JSON between ${ABRE} and ${FECHA}, with "name" set to one of the available tools. Write only the corrected block(s).`,
  ].join('\n');
}

/** Lembra o modelo de que as ferramentas funcionam de verdade. */
export function mensagemContraRecusa(nomes) {
  return [
    'You do have access here: this app runs your request blocks on my computer and sends the results back to you. Please continue the task now by writing the request block(s) you need, for example:',
    ABRE,
    `{"name": "${nomes[0] ?? '<tool name>'}", "arguments": {...}}`,
    FECHA,
    `Available tools: ${nomes.join(', ')}.`,
  ].join('\n');
}

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
        if (e?.codigo !== 'conversa_indisponivel' && e?.codigo !== 'reenviar') throw e;
        this.log.info('A conversa não está mais aberta no navegador; reenviando o histórico numa conversa nova.');
        aoEvento({ tipo: 'etapa', etapa: 'reenviando' });
      }
    }
    const prompt = montarPromptInicial(plano.mensagens, plano.opcoesPrompt);
    let r;
    try {
      r = await this.executor.executar({ prompt, nova: true, modelo }, { aoEvento, sinal, esperaMs });
    } catch (e) {
      // A extensão percebeu que a mensagem saiu errada antes de qualquer resposta: repete uma vez.
      if (e?.codigo !== 'reenviar') throw e;
      this.log.info('A extensão pediu para repetir o envio (modo digitação); repetindo numa conversa nova.');
      r = await this.executor.executar({ prompt, nova: true, modelo }, { aoEvento, sinal, esperaMs });
    }
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
    this.log.debug(`Pedido: ${resumoDoPedido(corpo)}`);
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
    const nomesDasFerramentas = plano.ferramentas.map((f) => f.nome);
    const cortador = new CortadorDeParada(corpo.stop);
    let conteudo = '';
    let raciocinio = '';
    const chamadas = [];
    let cabecalhoEnviado = false;
    let papelEnviado = false;
    let manterViva = null;

    // Cada "rodada" é uma resposta do ChatGPT. Normalmente há uma só; a ponte faz outra na
    // mesma conversa quando precisa pedir uma correção (bloco inválido, recusa, resposta vazia).
    // Recusa só é vigiada quando o pedido termina com mensagem do usuário: depois de um
    // resultado de ferramenta, "não consigo abrir o arquivo" pode ser uma resposta legítima.
    const vigiarRecusa = usaFerramentas && plano.mensagens.at(-1)?.papel === 'usuario';
    const novaRodada = () => ({
      leitor: usaFerramentas ? new LeitorDeFerramentas({ nomes: nomesDasFerramentas }) : null,
      recebido: '',
      guarda: vigiarRecusa ? '' : null, // começo da resposta, segurado até saber se é recusa
      descartado: '',
      recusou: false,
      invalidos: [],
      emitiu: 0,
    });
    let rodada = novaRodada();

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
          if (!e.texto) continue;
          conteudo += e.texto;
          rodada.emitiu++;
          comecouTexto = true;
          if (stream) {
            enviarCabecalho();
            pedaco({ content: e.texto });
          }
        } else if (e.tipo === 'chamada') {
          const indice = chamadas.length;
          chamadas.push(e);
          rodada.emitiu++;
          comecouTexto = true;
          if (stream) {
            enviarCabecalho();
            pedaco({ tool_calls: [{ index: indice, id: e.id, type: 'function', function: { name: e.nome, arguments: e.argumentos } }] });
          }
        } else if (e.tipo === 'invalido') {
          rodada.invalidos.push(e); // a ponte pede a correção antes de mostrar qualquer coisa
        }
      }
    };
    const passarAdiante = (texto) => {
      const seguro = cortador.receber(texto);
      if (seguro) emitir(rodada.leitor ? rodada.leitor.receber(seguro) : [{ tipo: 'texto', texto: seguro }]);
      if (cortador.parou) controle.abort();
    };
    const receberTexto = (texto) => {
      rodada.recebido += texto;
      if (rodada.recusou) {
        rodada.descartado += texto;
        return;
      }
      if (rodada.guarda === null) return passarAdiante(texto);
      // Segura o começo: se for "não tenho acesso ao seu computador", nem chega ao cliente.
      rodada.guarda += texto;
      const g = rodada.guarda;
      if (g.includes('<tool_call>') || g.length >= 400) {
        rodada.guarda = null;
        if (pareceRecusa(g)) {
          rodada.recusou = true;
          rodada.descartado = g;
        } else passarAdiante(g);
      }
    };
    /** Fim de uma rodada: completa pelo texto final e esvazia o que estava guardado. */
    const fecharRodada = (resultado) => {
      const final = resultado?.texto ?? '';
      if (final && !cortador.parou) {
        if (final.startsWith(rodada.recebido)) {
          if (final.length > rodada.recebido.length) receberTexto(final.slice(rodada.recebido.length));
        } else {
          this.log.debug(`O texto final difere do que veio em pedaços (${rodada.recebido.length} → ${final.length} caracteres).`);
        }
      }
      if (rodada.guarda !== null) {
        const g = rodada.guarda;
        rodada.guarda = null;
        if (pareceRecusa(g)) {
          rodada.recusou = true;
          rodada.descartado = g;
        } else passarAdiante(g);
      }
      if (!rodada.recusou) {
        const resto = cortador.terminar();
        if (resto) emitir(rodada.leitor ? rodada.leitor.receber(resto) : [{ tipo: 'texto', texto: resto }]);
        if (rodada.leitor) emitir(rodada.leitor.terminar());
      }
    };
    /** O que fazer depois da rodada: nada, ou a mensagem de correção a mandar na mesma conversa. */
    const correcoes = { bloco: 0, recusa: 0, vazio: 0 };
    const proximaCorrecao = () => {
      if (cortador.parou) return null;
      if (rodada.invalidos.length && correcoes.bloco < 2) {
        correcoes.bloco++;
        return {
          aviso: `o bloco de ferramenta veio com erro (${rodada.invalidos[0].motivo}); pedindo a correção ao ChatGPT…`,
          prompt: mensagemDeCorrecao(rodada.invalidos),
        };
      }
      if (rodada.recusou && correcoes.recusa < 1) {
        correcoes.recusa++;
        return { aviso: 'o ChatGPT disse que não tinha acesso; lembrando que as ferramentas funcionam…', prompt: mensagemContraRecusa(nomesDasFerramentas) };
      }
      if (!rodada.emitiu && !rodada.invalidos.length && !rodada.recusou && !chamadas.length && !conteudo.trim() && correcoes.vazio < 1) {
        correcoes.vazio++;
        return {
          aviso: 'a resposta veio vazia; pedindo de novo…',
          prompt:
            'Your last reply arrived empty here (it may have gone to a canvas or to one of your own tools, which this app cannot see). Please write your answer, or your request block(s), directly in the chat.',
        };
      }
      return null;
    };
    /** Sem mais correções possíveis: o que sobrou vira texto, para o cliente ver o que aconteceu. */
    const entregarSobras = () => {
      if (rodada.recusou && rodada.descartado) emitir([{ tipo: 'texto', texto: rodada.descartado }]);
      for (const inv of rodada.invalidos) emitir([{ tipo: 'texto', texto: (conteudo ? '\n' : '') + blocoComoTexto(inv) }]);
      rodada.invalidos = [];
    };

    // Andamento no bloco de "pensando" do cliente (reasoning_content), até o texto começar:
    // assim quem usa o OpenCode vê que o pedido está andando, como numa API de verdade.
    const mostrarProgresso = stream && this.config.progresso !== false;
    let comecouTexto = false;
    let escreveuProgresso = false;
    let ultimaLinhaEm = 0;
    let relogio = null;
    const linhaDeProgresso = (msg, sempre = false) => {
      if (!mostrarProgresso || (comecouTexto && !sempre)) return;
      enviarCabecalho();
      pedaco({ reasoning_content: `[GPT Ponte] ${msg}\n` });
      escreveuProgresso = true;
      ultimaLinhaEm = Date.now();
    };
    const ligarRelogio = () => {
      if (!mostrarProgresso || relogio) return;
      relogio = setInterval(() => {
        if (comecouTexto || Date.now() - ultimaLinhaEm < 9500) return;
        linhaDeProgresso(`esperando o ChatGPT… ${Math.round((Date.now() - inicio) / 1000)} s`);
      }, 10e3);
      relogio.unref?.();
    };
    const etapas = {
      fila: (e) => `na fila: ${e.detalhe ?? 1} pedido(s) na frente`,
      despachado: () => (plano.continuacao ? 'continuando a conversa que já está aberta no ChatGPT' : 'abrindo uma conversa nova no ChatGPT'),
      'abrindo-aba': () => 'carregando a página do ChatGPT…',
      enviado: (e) => `mensagem enviada${e.detalhe ? ` (${Math.max(1, Math.round(e.detalhe / 1000))} mil caracteres)` : ''}; esperando a resposta…`,
      reenviando: () => 'a conversa anterior não está mais aberta; reenviando o histórico numa conversa nova',
    };

    const aoEvento = (e) => {
      if (e.tipo === 'etapa') {
        if (e.aba != null && entrada) entrada.aba = e.aba;
        const msg = etapas[e.etapa]?.(e);
        if (msg) linhaDeProgresso(msg);
        ligarRelogio();
      } else if (e.tipo === 'inicio') {
        if (entrada) entrada.aba = e.aba;
        enviarCabecalho();
        linhaDeProgresso('o ChatGPT começou a responder');
      } else if (e.tipo === 'raciocinio') {
        raciocinio += e.texto;
        if (stream) {
          enviarCabecalho();
          // Separa as linhas da ponte do raciocínio de verdade do modelo.
          pedaco({ reasoning_content: (escreveuProgresso && raciocinio === e.texto ? '\n' : '') + e.texto });
          ultimaLinhaEm = Date.now();
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
      fecharRodada(resultado);

      // Correções na mesma conversa (bloco inválido, recusa, resposta vazia), sem o cliente perceber.
      for (let correcao = proximaCorrecao(); correcao && resultado?.aba != null; correcao = proximaCorrecao()) {
        this.log.info(`Correção automática: ${correcao.aviso}`);
        linhaDeProgresso(correcao.aviso, true);
        const anterior = resultado;
        rodada = novaRodada();
        rodada.guarda = null; // numa rodada de correção, o que vier vai para o cliente
        try {
          resultado = await this.executor.executar(
            { prompt: correcao.prompt, nova: false, continuar: { aba: anterior.aba, conversaId: anterior.conversaId }, modelo: plano.modelo === MODELO_PADRAO ? null : plano.modelo },
            { aoEvento, sinal: controle.signal, esperaMs: this.config.esperaExtensaoMs ?? 30e3 },
          );
        } catch (e) {
          if (e?.codigo === 'cancelado' || e?.codigo === 'extensao_desconectada') throw e;
          this.log.aviso(`A correção automática falhou (${e?.message}); entregando o que já havia.`);
          resultado = anterior;
          break;
        }
        resultado = { ...resultado, modo: anterior.modo, tamanhoPrompt: anterior.tamanhoPrompt };
        fecharRodada(resultado);
        if (entrada) entrada.correcoes = (entrada.correcoes ?? 0) + 1;
      }
      entregarSobras();

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
      clearInterval(relogio);
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

/** Uma linha que descreve o pedido sem mostrar o conteúdo das mensagens (para o log de depuração). */
export function resumoDoPedido(corpo) {
  if (!corpo || typeof corpo !== 'object') return 'corpo vazio';
  const msgs = Array.isArray(corpo.messages) ? corpo.messages : [];
  const papeis = msgs.map((m) => m?.role?.[0] ?? '?').join('');
  const tamanho = JSON.stringify(msgs).length;
  const ferramentas = Array.isArray(corpo.tools) ? corpo.tools.map((t) => t?.function?.name ?? t?.type).join(',') : '';
  const outros = Object.keys(corpo).filter((k) => !['messages', 'tools', 'model'].includes(k));
  return `modelo=${corpo.model} mensagens=${msgs.length} (${papeis}) ~${tamanho} caracteres; ferramentas=[${ferramentas}]; outros campos: ${outros.map((k) => `${k}=${JSON.stringify(corpo[k])}`).join(' ')}`;
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
