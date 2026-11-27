// Log no terminal, com hora e cor quando o terminal suporta.

const NIVEIS = { debug: 10, info: 20, aviso: 30, erro: 40 };
const CORES = { debug: '\x1b[90m', info: '\x1b[36m', aviso: '\x1b[33m', erro: '\x1b[31m' };
const ROTULOS = { debug: 'debug', info: 'info ', aviso: 'aviso', erro: 'erro ' };

export function criarLog({ nivel = 'info', saida = process.stderr, cor = saida.isTTY && !process.env.NO_COLOR } = {}) {
  const minimo = NIVEIS[nivel] ?? NIVEIS.info;
  const escrever = (n, partes) => {
    if (NIVEIS[n] < minimo) return;
    const hora = new Date().toLocaleTimeString('pt-BR', { hour12: false });
    const texto = partes.map((p) => (p instanceof Error ? p.stack || p.message : typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
    const rotulo = cor ? `${CORES[n]}${ROTULOS[n]}\x1b[0m` : ROTULOS[n];
    saida.write(`${cor ? '\x1b[90m' : ''}${hora}${cor ? '\x1b[0m' : ''} ${rotulo} ${texto}\n`);
  };
  return {
    debug: (...p) => escrever('debug', p),
    info: (...p) => escrever('info', p),
    aviso: (...p) => escrever('aviso', p),
    erro: (...p) => escrever('erro', p),
  };
}

export const logMudo = { debug() {}, info() {}, aviso() {}, erro() {} };
