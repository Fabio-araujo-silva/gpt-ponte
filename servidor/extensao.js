// Conversa com a extensão do navegador pelo WebSocket: entrega tarefas, recebe o texto
// em streaming e controla fila, tempo limite e cancelamento.

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { ErroDaPonte } from './erros.js';

export const PROTOCOLO = 1;

export class GerenteDaExtensao extends EventEmitter {
  /**
   * @param {{log?: any, limiteMs?: number, inatividadeMs?: number, pingMs?: number, versao?: string}} [opcoes]
   */
  constructor({ log, limiteMs = 30 * 60e3, inatividadeMs = 10 * 60e3, pingMs = 20e3, versao = '0.0.0' } = {}) {
    super();
    this.log = log ?? { info() {}, aviso() {}, erro() {}, debug() {} };
    this.limiteMs = limiteMs;
    this.inatividadeMs = inatividadeMs;
    this.pingMs = pingMs;
    this.versao = versao;
    this.conexao = null;
    this.info = null; // dados do "ola" da extensão
    this.situacao = { abas: [], modelos: [] }; // último "estado" enviado pela extensão
    this.tarefas = new Map(); // em andamento
    this.fila = [];
    this.vagasEmUso = 0;
    this._ultimoPong = 0;
    this._timerPing = null;
  }

  get conectada() {
    return !!this.conexao?.aberta;
  }

  /** Quantas tarefas podem rodar ao mesmo tempo (uma por aba). */
  get capacidade() {
    const n = Number(this.info?.config?.maxAbas ?? this.situacao?.maxAbas ?? 1);
    return Number.isFinite(n) && n >= 1 ? Math.min(n, 8) : 1;
  }

  estado() {
    return {
      conectada: this.conectada,
      extensao: this.info ? { versao: this.info.versao, navegador: this.info.navegador, protocolo: this.info.protocolo, config: this.info.config } : null,
      abas: this.situacao.abas ?? [],
      modelos: this.situacao.modelos ?? [],
      logado: this.situacao.logado ?? null,
      plano: this.situacao.plano ?? null,
      emAndamento: this.tarefas.size,
      naFila: this.fila.length,
      capacidade: this.capacidade,
    };
  }

  /** Liga uma conexão WebSocket recém-aceita. Uma nova conexão substitui a anterior. */
  aceitar(conexao) {
    if (this.conexao && this.conexao !== conexao) {
      this.log.info('Outra janela da extensão conectou; a conexão anterior foi encerrada.');
      const antiga = this.conexao;
      this.conexao = null;
      this._falharTodas(new ErroDaPonte('extensao_desconectada', 'A extensão reconectou e a resposta em andamento foi perdida.'));
      antiga.fechar(4001, 'substituída');
    }
    this.conexao = conexao;
    this.info = null;
    this._ultimoPong = Date.now();
    conexao.on('mensagem', (texto) => this._mensagem(conexao, texto));
    conexao.on('fechada', (codigo, motivo) => {
      if (this.conexao !== conexao) return;
      this.conexao = null;
      clearInterval(this._timerPing);
      this.log.aviso(`Extensão desconectou (${codigo}${motivo ? ': ' + motivo : ''}).`);
      this._falharTodas(new ErroDaPonte('extensao_desconectada'));
      this.emit('desconectou');
    });
    conexao.enviar({ tipo: 'bemvindo', protocolo: PROTOCOLO, versao: this.versao });
    clearInterval(this._timerPing);
    this._timerPing = setInterval(() => {
      if (!this.conectada) return;
      if (Date.now() - this._ultimoPong > this.pingMs * 3) {
        this.log.aviso('A extensão parou de responder; derrubando a conexão.');
        this.conexao.destruir();
        return;
      }
      this.conexao.enviar({ tipo: 'ping', t: Date.now() });
    }, this.pingMs);
    this._timerPing.unref?.();
  }

  /** Espera a extensão conectar (ou devolve na hora se já está conectada). */
  esperarConexao(ms) {
    if (this.conectada && this.info) return Promise.resolve();
    if (ms <= 0) return Promise.reject(new ErroDaPonte('sem_extensao'));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.off('pronta', ok);
        reject(new ErroDaPonte('sem_extensao'));
      }, ms);
      const ok = () => {
        clearTimeout(t);
        resolve();
      };
      this.once('pronta', ok);
    });
  }

  /**
   * Executa uma tarefa no navegador.
   * @param {{prompt: string, nova: boolean, continuar?: {aba: number, conversaId?: string} | null, modelo?: string}} tarefa
   * @param {{aoEvento?: (e: object) => void, sinal?: AbortSignal, esperaMs?: number}} [opcoes]
   * @returns {Promise<{texto: string, raciocinio: string, aba: number, conversaId?: string, modelo?: string}>}
   */
  async executar(tarefa, { aoEvento = () => {}, sinal, esperaMs = 30e3 } = {}) {
    if (sinal?.aborted) throw new ErroDaPonte('cancelado');
    await this.esperarConexao(esperaMs);
    if (this.vagasEmUso >= this.capacidade || this.fila.length) aoEvento({ tipo: 'etapa', etapa: 'fila', detalhe: this.fila.length + 1 });
    await this._esperarVez(sinal);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const registro = {
        id,
        tarefa,
        aoEvento,
        resolve,
        reject,
        inicio: Date.now(),
        ultimoEvento: Date.now(),
        timer: null,
        aoAbortar: null,
      };
      let acabou = false;
      const acabar = () => {
        if (acabou) return;
        acabou = true;
        clearInterval(registro.timer);
        sinal?.removeEventListener('abort', registro.aoAbortar);
        this.tarefas.delete(id);
        this._devolverVaga();
      };
      registro.acabar = acabar;
      registro.timer = setInterval(() => {
        const agora = Date.now();
        if (agora - registro.inicio > this.limiteMs || agora - registro.ultimoEvento > this.inatividadeMs) {
          this._cancelarNaExtensao(id);
          acabar();
          reject(new ErroDaPonte('tempo_esgotado'));
        }
      }, 1000);
      registro.timer.unref?.();
      registro.aoAbortar = () => {
        this._cancelarNaExtensao(id);
        acabar();
        reject(new ErroDaPonte('cancelado'));
      };
      sinal?.addEventListener('abort', registro.aoAbortar, { once: true });
      this.tarefas.set(id, registro);
      const enviado = this.conexao?.enviar({
        tipo: 'tarefa',
        id,
        prompt: tarefa.prompt,
        nova: !!tarefa.nova,
        continuar: tarefa.continuar ?? null,
        modelo: tarefa.modelo ?? null,
        rotulo: tarefa.rotulo ?? null,
      });
      if (!enviado) {
        acabar();
        reject(new ErroDaPonte('sem_extensao'));
      } else {
        aoEvento({ tipo: 'etapa', etapa: 'despachado' });
      }
    });
  }

  cancelarTudo() {
    for (const id of this.tarefas.keys()) this._cancelarNaExtensao(id);
    this._falharTodas(new ErroDaPonte('cancelado'));
  }

  // ---------------------------------------------------------------- interno

  /** Reserva uma vaga (síncrono, para duas chamadas não pegarem a mesma vaga). */
  _esperarVez(sinal) {
    if (this.vagasEmUso < this.capacidade && !this.fila.length) {
      this.vagasEmUso++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const item = {};
      const aoAbortar = () => {
        const i = this.fila.indexOf(item);
        if (i >= 0) this.fila.splice(i, 1);
        reject(new ErroDaPonte('cancelado'));
      };
      item.liberar = () => {
        sinal?.removeEventListener('abort', aoAbortar);
        resolve();
      };
      sinal?.addEventListener('abort', aoAbortar, { once: true });
      this.fila.push(item);
    });
  }

  _chamarProximo() {
    while (this.fila.length && this.vagasEmUso < this.capacidade) {
      this.vagasEmUso++;
      this.fila.shift().liberar();
    }
  }

  _devolverVaga() {
    this.vagasEmUso = Math.max(0, this.vagasEmUso - 1);
    this._chamarProximo();
  }

  _cancelarNaExtensao(id) {
    this.conexao?.enviar({ tipo: 'cancelar', id });
  }

  _falharTodas(erro) {
    for (const registro of [...this.tarefas.values()]) {
      registro.acabar();
      registro.reject(erro);
    }
  }

  _mensagem(conexao, texto) {
    let m;
    try {
      m = JSON.parse(texto);
    } catch {
      this.log.aviso('Mensagem inválida da extensão (não é JSON).');
      return;
    }
    if (!m || typeof m !== 'object') return;
    switch (m.tipo) {
      case 'ola': {
        this.info = m;
        if (m.protocolo !== PROTOCOLO) {
          this.log.aviso(`A extensão usa o protocolo ${m.protocolo} e a ponte o ${PROTOCOLO}. Atualize as duas para a mesma versão.`);
        }
        this.log.info(`Extensão conectada (${m.navegador || 'navegador'}, extensão ${m.versao || '?'}).`);
        this.emit('pronta');
        this._chamarProximo();
        return;
      }
      case 'estado':
        this.situacao = { ...this.situacao, ...m, tipo: undefined };
        this.emit('estado', this.situacao);
        this._chamarProximo();
        return;
      case 'pong':
        this._ultimoPong = Date.now();
        return;
      case 'log': {
        const nivel = ['info', 'aviso', 'erro', 'debug'].includes(m.nivel) ? m.nivel : 'info';
        this.log[nivel](`[extensão] ${m.mensagem}`);
        return;
      }
      default:
        break;
    }
    this._ultimoPong = Date.now();
    const registro = m.id ? this.tarefas.get(m.id) : null;
    if (!registro) return; // tarefa já encerrada (cancelada, tempo esgotado)
    registro.ultimoEvento = Date.now();
    switch (m.tipo) {
      case 'etapa':
        if (m.aba != null) registro.aba = m.aba;
        registro.aoEvento({ tipo: 'etapa', etapa: m.etapa, detalhe: m.detalhe, aba: m.aba });
        return;
      case 'inicio':
        registro.aba = m.aba;
        registro.aoEvento({ tipo: 'inicio', aba: m.aba, conversaId: m.conversaId });
        return;
      case 'delta':
        if (m.raciocinio) registro.aoEvento({ tipo: 'raciocinio', texto: m.raciocinio });
        if (m.texto) registro.aoEvento({ tipo: 'texto', texto: m.texto });
        return;
      case 'fim':
        registro.acabar();
        registro.resolve({
          texto: typeof m.texto === 'string' ? m.texto : '',
          raciocinio: typeof m.raciocinio === 'string' ? m.raciocinio : '',
          aba: m.aba ?? registro.aba,
          conversaId: m.conversaId,
          modelo: m.modelo,
        });
        return;
      case 'erro':
        registro.acabar();
        registro.reject(new ErroDaPonte(m.codigo || 'chatgpt', m.mensagem || undefined, { detalhe: m.detalhe }));
        return;
      default:
        return;
    }
  }
}
