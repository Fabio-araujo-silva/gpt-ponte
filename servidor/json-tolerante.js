// Lê JSON escrito por um modelo de linguagem, que nem sempre é JSON válido.
//
// Aceita, além do JSON normal: cercas de código (```json ... ```), quebras de linha e
// tabs crus dentro de strings, vírgula sobrando, comentários, aspas simples, chaves sem
// aspas, True/False/None do Python e texto sobrando depois do valor.

export class ErroJson extends Error {}

export function jsonTolerante(texto) {
  const limpo = tirarCerca(String(texto ?? '').trim());
  try {
    return JSON.parse(limpo);
  } catch {
    // segue para o leitor tolerante
  }
  const leitor = new Leitor(limpo);
  leitor.espacos();
  const valor = leitor.valor();
  return valor;
}

/** Tenta ler; devolve undefined em vez de lançar erro. */
export function tentarJson(texto) {
  try {
    return jsonTolerante(texto);
  } catch {
    return undefined;
  }
}

function tirarCerca(t) {
  const m = /^```[\w-]*[ \t]*\n([\s\S]*?)\n?```\s*$/.exec(t);
  return m ? m[1].trim() : t;
}

const ESCAPES = { '"': '"', "'": "'", '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

class Leitor {
  constructor(t) {
    this.t = t;
    this.i = 0;
  }

  erro(msg) {
    throw new ErroJson(`${msg} (posição ${this.i})`);
  }

  espacos() {
    const t = this.t;
    for (;;) {
      const c = t[this.i];
      if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '﻿') {
        this.i++;
      } else if (c === '/' && t[this.i + 1] === '/') {
        while (this.i < t.length && t[this.i] !== '\n') this.i++;
      } else if (c === '/' && t[this.i + 1] === '*') {
        const fim = t.indexOf('*/', this.i + 2);
        this.i = fim < 0 ? t.length : fim + 2;
      } else {
        return;
      }
    }
  }

  valor() {
    this.espacos();
    const c = this.t[this.i];
    if (c === '{') return this.objeto();
    if (c === '[') return this.lista();
    if (c === '"' || c === "'") return this.string(c);
    if (c === '-' || c === '+' || c === '.' || (c >= '0' && c <= '9')) return this.numero();
    const palavra = this.palavra();
    switch (palavra) {
      case 'true':
      case 'True':
        return true;
      case 'false':
      case 'False':
        return false;
      case 'null':
      case 'None':
      case 'undefined':
        return null;
      case '':
        return this.erro('valor esperado');
      default:
        return this.erro(`palavra inesperada "${palavra}"`);
    }
  }

  palavra() {
    const m = /^[A-Za-z_$][\w$]*/.exec(this.t.slice(this.i, this.i + 64));
    if (!m) return '';
    this.i += m[0].length;
    return m[0];
  }

  objeto() {
    const obj = {};
    this.i++; // {
    for (;;) {
      this.espacos();
      const c = this.t[this.i];
      if (c === '}') {
        this.i++;
        return obj;
      }
      if (c === undefined) return obj; // objeto não fechado: devolve o que deu
      if (c === ',') {
        this.i++;
        continue;
      }
      let chave;
      if (c === '"' || c === "'") chave = this.string(c);
      else {
        chave = this.palavra();
        if (!chave) {
          const m = /^[^:\s]+/.exec(this.t.slice(this.i));
          if (!m) this.erro('chave esperada');
          chave = m[0];
          this.i += m[0].length;
        }
      }
      this.espacos();
      if (this.t[this.i] !== ':') this.erro('":" esperado');
      this.i++;
      obj[chave] = this.valor();
      this.espacos();
      if (this.t[this.i] === ',') this.i++;
    }
  }

  lista() {
    const arr = [];
    this.i++; // [
    for (;;) {
      this.espacos();
      const c = this.t[this.i];
      if (c === ']') {
        this.i++;
        return arr;
      }
      if (c === undefined) return arr;
      if (c === ',') {
        this.i++;
        continue;
      }
      arr.push(this.valor());
      this.espacos();
      if (this.t[this.i] === ',') this.i++;
    }
  }

  string(aspas) {
    const t = this.t;
    this.i++;
    let s = '';
    for (;;) {
      if (this.i >= t.length) return s; // string não fechada
      const c = t[this.i++];
      if (c === aspas) {
        // Aspas sem escape no meio do texto: só fecha se o que vem depois faz sentido.
        if (aspas === '"' && !this.fechaString()) {
          s += c;
          continue;
        }
        return s;
      }
      if (c !== '\\') {
        s += c;
        continue;
      }
      const e = t[this.i++];
      if (e === 'u') {
        const hex = t.slice(this.i, this.i + 4);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          s += String.fromCharCode(parseInt(hex, 16));
          this.i += 4;
        } else s += '\\u';
      } else if (e in ESCAPES) s += ESCAPES[e];
      else if (e === '\n') s += '\n';
      else if (e === undefined) return s + '\\';
      else s += '\\' + e; // escape inválido: mantém como estava escrito
    }
  }

  /** Depois de uma aspa: só é fim de string se vier , } ] : ou o fim do texto. */
  fechaString() {
    let j = this.i;
    while (j < this.t.length && ' \t\r\n'.includes(this.t[j])) j++;
    const c = this.t[j];
    return c === undefined || c === ',' || c === '}' || c === ']' || c === ':';
  }

  numero() {
    const m = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(this.t.slice(this.i));
    if (!m) this.erro('número inválido');
    this.i += m[0].length;
    return Number(m[0]);
  }
}
