// WebSocket mínimo (RFC 6455) sem dependências: servidor e cliente.
//
// O servidor aceita a conexão da extensão do navegador; o cliente existe para os testes
// e para a ferramenta de diagnóstico. Só implementa o que a ponte usa: mensagens de texto
// (binárias são lidas como UTF-8), fragmentação, ping/pong e fechamento.

import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OP = Object.freeze({ CONT: 0x0, TEXTO: 0x1, BIN: 0x2, FECHAR: 0x8, PING: 0x9, PONG: 0xa });

const MAX_PADRAO = 64 * 1024 * 1024; // 64 MB por mensagem

export function chaveDeAceite(chave) {
  return createHash('sha1').update(chave + GUID).digest('base64');
}

function aplicarMascara(dados, mascara) {
  const saida = Buffer.allocUnsafe(dados.length);
  for (let i = 0; i < dados.length; i++) saida[i] = dados[i] ^ mascara[i & 3];
  return saida;
}

export class ConexaoWS extends EventEmitter {
  /**
   * @param {import('node:net').Socket} socket
   * @param {{cliente?: boolean, maxMensagem?: number}} [opcoes]
   *   cliente: true quando somos o lado cliente (aí os quadros enviados são mascarados).
   */
  constructor(socket, { cliente = false, maxMensagem = MAX_PADRAO } = {}) {
    super();
    this.socket = socket;
    this.cliente = cliente;
    this.maxMensagem = maxMensagem;
    this.aberta = true;
    this._buf = Buffer.alloc(0);
    this._fragmentos = [];
    this._tamFragmentos = 0;
    this._opFragmentado = 0;
    this._fechamentoEnviado = false;
    socket.setNoDelay?.(true);
    socket.on('data', (d) => this._receber(d));
    // O socket do http.Server aceita "meia conexão": sem isto, um FIN do outro lado só seria
    // percebido na próxima escrita.
    socket.on('end', () => {
      socket.destroy();
      this._encerrar(1006, 'conexão encerrada pelo outro lado');
    });
    socket.on('close', () => this._encerrar(1006, 'conexão caiu'));
    socket.on('error', (e) => {
      if (this.listenerCount('erro')) this.emit('erro', e);
      this._encerrar(1006, e.message);
    });
  }

  /** Envia texto; objetos viram JSON. Devolve false se a conexão já fechou. */
  enviar(mensagem) {
    if (!this.aberta) return false;
    const texto = typeof mensagem === 'string' ? mensagem : JSON.stringify(mensagem);
    return this._enviarQuadro(OP.TEXTO, Buffer.from(texto, 'utf8'));
  }

  ping(dados = Buffer.alloc(0)) {
    if (!this.aberta) return false;
    return this._enviarQuadro(OP.PING, Buffer.from(dados));
  }

  /** Inicia o fechamento educado; derruba o socket se o outro lado não responder. */
  fechar(codigo = 1000, motivo = '') {
    if (!this.aberta) return;
    this._enviarFechamento(codigo, motivo);
    const t = setTimeout(() => this.socket.destroy(), 2000);
    t.unref?.();
    this.socket.end();
    this._encerrar(codigo, motivo);
  }

  /** Derruba na hora, sem handshake de fechamento. */
  destruir() {
    this.socket.destroy();
    this._encerrar(1006, 'destruída');
  }

  // ---------------------------------------------------------------- interno

  _enviarFechamento(codigo, motivo) {
    if (this._fechamentoEnviado) return;
    this._fechamentoEnviado = true;
    const m = Buffer.from(String(motivo || '').slice(0, 100), 'utf8');
    const carga = Buffer.alloc(2 + m.length);
    carga.writeUInt16BE(codigo, 0);
    m.copy(carga, 2);
    this._enviarQuadro(OP.FECHAR, carga);
  }

  _enviarQuadro(op, carga, fin = true) {
    if (this.socket.destroyed || this.socket.writableEnded) return false;
    const tam = carga.length;
    const tamMascara = this.cliente ? 4 : 0;
    let cab;
    if (tam < 126) {
      cab = Buffer.alloc(2 + tamMascara);
      cab[1] = tam;
    } else if (tam < 65536) {
      cab = Buffer.alloc(4 + tamMascara);
      cab[1] = 126;
      cab.writeUInt16BE(tam, 2);
    } else {
      cab = Buffer.alloc(10 + tamMascara);
      cab[1] = 127;
      cab.writeUInt32BE(Math.floor(tam / 2 ** 32), 2);
      cab.writeUInt32BE(tam >>> 0, 6);
    }
    cab[0] = (fin ? 0x80 : 0) | op;
    let corpo = carga;
    if (this.cliente) {
      cab[1] |= 0x80;
      const mascara = randomBytes(4);
      mascara.copy(cab, cab.length - 4);
      corpo = aplicarMascara(carga, mascara);
    }
    this.socket.write(Buffer.concat([cab, corpo]));
    return true;
  }

  _receber(dados) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, dados]) : dados;
    while (this.aberta) {
      const b = this._buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const rsv = b[0] & 0x70;
      const op = b[0] & 0x0f;
      const mascarado = (b[1] & 0x80) !== 0;
      let tam = b[1] & 0x7f;
      let pos = 2;
      if (rsv) return this._falha(1002, 'bits RSV não suportados');
      if (tam === 126) {
        if (b.length < 4) return;
        tam = b.readUInt16BE(2);
        pos = 4;
      } else if (tam === 127) {
        if (b.length < 10) return;
        const alto = b.readUInt32BE(2);
        if (alto > 0x1fffff) return this._falha(1009, 'mensagem grande demais');
        tam = alto * 2 ** 32 + b.readUInt32BE(6);
        pos = 10;
      }
      if (tam > this.maxMensagem) return this._falha(1009, 'mensagem grande demais');
      // O cliente sempre mascara; o servidor nunca.
      if (!this.cliente && !mascarado) return this._falha(1002, 'quadro do cliente sem máscara');
      if (this.cliente && mascarado) return this._falha(1002, 'quadro do servidor com máscara');
      let mascara = null;
      if (mascarado) {
        if (b.length < pos + 4) return;
        mascara = b.subarray(pos, pos + 4);
        pos += 4;
      }
      if (b.length < pos + tam) return;
      const bruto = b.subarray(pos, pos + tam);
      const carga = mascara ? aplicarMascara(bruto, mascara) : Buffer.from(bruto);
      this._buf = b.length === pos + tam ? Buffer.alloc(0) : b.subarray(pos + tam);
      this._quadro(fin, op, carga);
    }
  }

  _quadro(fin, op, carga) {
    if (op >= 0x8) {
      if (!fin || carga.length > 125) return this._falha(1002, 'quadro de controle inválido');
      if (op === OP.FECHAR) {
        const codigo = carga.length >= 2 ? carga.readUInt16BE(0) : 1005;
        const motivo = carga.length > 2 ? carga.subarray(2).toString('utf8') : '';
        this._enviarFechamento(codigo === 1005 ? 1000 : codigo, '');
        this.socket.end();
        this._encerrar(codigo, motivo);
        return;
      }
      if (op === OP.PING) {
        this._enviarQuadro(OP.PONG, carga);
        return;
      }
      if (op === OP.PONG) {
        this.emit('pong', carga);
        return;
      }
      return this._falha(1002, 'opcode de controle desconhecido');
    }
    if (op === OP.CONT) {
      if (!this._opFragmentado) return this._falha(1002, 'continuação inesperada');
    } else {
      if (this._opFragmentado) return this._falha(1002, 'mensagem fragmentada interrompida');
      if (op !== OP.TEXTO && op !== OP.BIN) return this._falha(1002, 'opcode desconhecido');
      this._opFragmentado = op;
    }
    this._fragmentos.push(carga);
    this._tamFragmentos += carga.length;
    if (this._tamFragmentos > this.maxMensagem) return this._falha(1009, 'mensagem grande demais');
    if (!fin) return;
    const tudo = this._fragmentos.length === 1 ? this._fragmentos[0] : Buffer.concat(this._fragmentos);
    this._fragmentos = [];
    this._tamFragmentos = 0;
    this._opFragmentado = 0;
    this.emit('mensagem', tudo.toString('utf8'));
  }

  _falha(codigo, motivo) {
    this._enviarFechamento(codigo, motivo);
    this.socket.end();
    const t = setTimeout(() => this.socket.destroy(), 500);
    t.unref?.();
    this._encerrar(codigo, motivo);
  }

  _encerrar(codigo, motivo) {
    if (!this.aberta) return;
    this.aberta = false;
    this._buf = Buffer.alloc(0);
    this.emit('fechada', codigo, motivo);
  }
}

function recusar(socket, status, texto) {
  socket.end(`HTTP/1.1 ${status} ${texto}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(texto)}\r\n\r\n${texto}`);
}

/**
 * Completa o handshake de um pedido 'upgrade' do http.Server.
 * @param {http.IncomingMessage} req
 * @param {import('node:net').Socket} socket
 * @param {Buffer} cabeca bytes que já chegaram depois do cabeçalho
 * @param {{origemPermitida?: (origem: string) => boolean, maxMensagem?: number}} [opcoes]
 * @returns {ConexaoWS | null}
 */
export function aceitarUpgrade(req, socket, cabeca, { origemPermitida, maxMensagem } = {}) {
  const chave = req.headers['sec-websocket-key'];
  const versao = req.headers['sec-websocket-version'];
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  if (req.method !== 'GET' || upgrade !== 'websocket' || !chave || versao !== '13') {
    recusar(socket, 400, 'Bad Request');
    return null;
  }
  if (origemPermitida && !origemPermitida(String(req.headers.origin || ''))) {
    recusar(socket, 403, 'Forbidden');
    return null;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${chaveDeAceite(chave)}\r\n\r\n`,
  );
  const conexao = new ConexaoWS(socket, { maxMensagem });
  if (cabeca && cabeca.length) conexao._receber(cabeca);
  return conexao;
}

/**
 * Cliente WebSocket simples (usado nos testes e no diagnóstico).
 * @param {string} url ws://host:porta/caminho
 * @param {{origem?: string, timeout?: number}} [opcoes]
 * @returns {Promise<ConexaoWS>}
 */
export function conectarWS(url, { origem, timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const chave = randomBytes(16).toString('base64');
    const req = http.request({
      host: u.hostname.replace(/^\[|\]$/g, ''),
      port: u.port || 80,
      path: u.pathname + u.search,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': chave,
        'Sec-WebSocket-Version': '13',
        ...(origem ? { Origin: origem } : {}),
      },
    });
    req.setTimeout(timeout, () => req.destroy(new Error('tempo esgotado ao conectar')));
    req.on('upgrade', (res, socket, cabeca) => {
      req.setTimeout(0);
      if (res.headers['sec-websocket-accept'] !== chaveDeAceite(chave)) {
        socket.destroy();
        reject(new Error('handshake inválido'));
        return;
      }
      const conexao = new ConexaoWS(socket, { cliente: true });
      if (cabeca && cabeca.length) conexao._receber(cabeca);
      resolve(conexao);
    });
    req.on('response', (res) => {
      res.resume();
      reject(new Error(`HTTP ${res.statusCode}`));
    });
    req.on('error', reject);
    req.end();
  });
}
