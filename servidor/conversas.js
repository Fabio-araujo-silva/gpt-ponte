// Lembra quais conversas estão abertas no navegador e em que ponto cada uma está.
//
// Cada entrada liga a chave de um histórico (ver chavesDosPrefixos) à aba que tem
// exatamente esse histórico. Quando chega um pedido cujo histórico começa com uma
// dessas chaves, a ponte só envia o que é novo para aquela aba.

export class MemoriaDeConversas {
  constructor({ max = 64, validadeMs = 12 * 60 * 60 * 1000 } = {}) {
    this.max = max;
    this.validadeMs = validadeMs;
    /** @type {Map<string, {aba: number, conversaId?: string, mensagens: number, usadoEm: number}>} */
    this.porChave = new Map();
  }

  /** Registra que a aba `aba` agora tem o histórico de chave `chave`. */
  registrar(chave, info) {
    this.esquecerAba(info.aba);
    this.porChave.set(chave, { ...info, usadoEm: Date.now() });
    while (this.porChave.size > this.max) {
      const maisAntiga = this.porChave.keys().next().value;
      this.porChave.delete(maisAntiga);
    }
  }

  /**
   * Procura o maior prefixo conhecido do histórico.
   * @param {string[]} chaves chaves[k] = chave das mensagens 0..k
   * @param {(n: number) => boolean} [aceitavel] filtra prefixos (ex.: o resto precisa ser enviável)
   * @returns {{chave: string, info: object, mensagens: number} | null}
   */
  procurar(chaves, aceitavel = () => true) {
    const agora = Date.now();
    for (let k = chaves.length - 2; k >= 0; k--) {
      const info = this.porChave.get(chaves[k]);
      if (!info) continue;
      if (agora - info.usadoEm > this.validadeMs) {
        this.porChave.delete(chaves[k]);
        continue;
      }
      if (aceitavel(k + 1)) return { chave: chaves[k], info, mensagens: k + 1 };
    }
    return null;
  }

  /** Tira a entrada da memória (a conversa vai avançar ou foi perdida). */
  consumir(chave) {
    const info = this.porChave.get(chave);
    this.porChave.delete(chave);
    return info ?? null;
  }

  esquecerAba(aba) {
    for (const [chave, info] of this.porChave) if (info.aba === aba) this.porChave.delete(chave);
  }

  limpar() {
    this.porChave.clear();
  }

  get tamanho() {
    return this.porChave.size;
  }
}
