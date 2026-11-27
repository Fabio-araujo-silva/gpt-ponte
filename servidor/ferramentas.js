// Chamada de ferramentas (function calling) emulada por texto.
//
// O ChatGPT do navegador não expõe function calling. A ponte descreve as ferramentas no
// prompt e pede que o modelo responda com blocos
//
//   <tool_call>
//   {"name": "bash", "arguments": {"command": "ls"}}
//   </tool_call>
//
// Este módulo monta essas instruções e lê a resposta em streaming, separando o texto
// normal das chamadas, que viram `tool_calls` no formato da OpenAI.

import { randomBytes } from 'node:crypto';
import { tentarJson } from './json-tolerante.js';

export const ABRE = '<tool_call>';
export const FECHA = '</tool_call>';

const LETRAS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function novoIdChamada() {
  const b = randomBytes(24);
  let s = 'call_';
  for (const x of b) s += LETRAS[x % LETRAS.length];
  return s;
}

/** Ferramentas no formato da OpenAI → lista {nome, descricao, parametros}. */
export function lerFerramentas(tools) {
  if (!Array.isArray(tools)) return [];
  const lista = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    const f = t.type === 'function' || t.function ? t.function || t : null;
    if (!f || typeof f.name !== 'string' || !f.name) continue;
    lista.push({
      nome: f.name,
      descricao: typeof f.description === 'string' ? f.description.trim() : '',
      parametros: f.parameters && typeof f.parameters === 'object' ? f.parameters : { type: 'object', properties: {} },
    });
  }
  return lista;
}

/**
 * Texto que ensina o protocolo ao modelo e lista as ferramentas.
 * @param {ReturnType<typeof lerFerramentas>} ferramentas
 * @param {{toolChoice?: any, paralelas?: boolean}} [opcoes]
 */
export function instrucoesDeFerramentas(ferramentas, { toolChoice, paralelas = true } = {}) {
  if (!ferramentas.length) return '';
  const regras = [
    // Testado no chatgpt.com: dizer "as ferramentas são suas" faz o modelo responder que não
    // tem acesso; explicar que ELE PEDE e O APP EXECUTA funciona melhor (e é a verdade).
    "You can't run anything yourself here, but the app can: when you need one of the tools below, write a request block in the exact format shown. The app runs the request (for example on the user's computer) and sends you the result in the next message, inside <tool_result> tags. That is how you work in this app, so do not say you lack access and do not ask the user to do what a tool can do: write the request block.",
    '',
    'Request format (valid JSON between the tags):',
    ABRE,
    '{"name": "<tool name>", "arguments": {<arguments as JSON>}}',
    FECHA,
    '',
    'Example, with a hypothetical tool named "read":',
    'user: What is in package.json?',
    'assistant:',
    ABRE,
    '{"name": "read", "arguments": {"path": "package.json"}}',
    FECHA,
    'user: <tool_result name="read">{"name": "demo"}</tool_result>',
    'assistant: The package is called "demo".',
    '',
    'Rules:',
    paralelas
      ? '- You may write several request blocks in the same reply.'
      : '- Write at most ONE request block per reply.',
    '- After your request block(s), STOP and end your reply. Never write the results yourself.',
    '- Do not put the blocks inside code fences. Escape strings in the JSON as usual (\\n for new lines, \\" for quotes).',
    '- Only use the tools listed here, not your own built-in tools (web browsing, Python, canvas, image generation, memory).',
    '- If no tool is needed, just answer normally, without any block.',
  ];
  const obrigacao = descreverEscolha(toolChoice);
  if (obrigacao) regras.push(obrigacao);
  const lista = ferramentas.map((f) => {
    const partes = [`### ${f.nome}`];
    if (f.descricao) partes.push(f.descricao);
    partes.push(`Arguments (JSON Schema): ${JSON.stringify(f.parametros)}`);
    return partes.join('\n');
  });
  return [...regras, '', 'Available tools:', '', lista.join('\n\n')].join('\n');
}

function descreverEscolha(toolChoice) {
  if (toolChoice === 'required') return '- In this reply you MUST write at least one request block.';
  if (toolChoice === 'none') return '- In this reply you must NOT write any request block.';
  const nome = toolChoice?.function?.name || toolChoice?.name;
  if (nome) return `- In this reply you MUST write a request block for the tool "${nome}".`;
  return '';
}

/**
 * Lembrete curto que vai junto de cada continuação da conversa. Em conversas longas o ChatGPT
 * pode esquecer o começo; o lembrete repete o essencial (formato e nomes das ferramentas).
 */
export function lembreteDeFerramentas(nomes = []) {
  const lista = nomes.length > 30 ? `${nomes.slice(0, 30).join(', ')}, …` : nomes.join(', ');
  const ferramentas = lista ? ` (${lista})` : '';
  return `(Reminder: you work through the app's tools${ferramentas}. To use one, write ${ABRE}{"name": ..., "arguments": {...}}${FECHA} and stop; when the task is done, answer normally.)`;
}

/** Formata o resultado de uma ferramenta para mandar de volta ao modelo. */
export function formatarResultado({ nome, id, conteudo }) {
  const atributos = [nome ? `name="${nome}"` : '', id ? `call_id="${id}"` : ''].filter(Boolean).join(' ');
  return `<tool_result${atributos ? ' ' + atributos : ''}>\n${conteudo}\n</tool_result>`;
}

/**
 * Interpreta o conteúdo de um bloco <tool_call>.
 * @returns {{nome: string, argumentos: object} | null}
 */
export function interpretarChamada(corpo, nomesValidos = []) {
  const obj = tentarJson(corpo);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  let nome =
    pegarTexto(obj.name) ??
    pegarTexto(obj.tool) ??
    pegarTexto(obj.tool_name) ??
    pegarTexto(obj.function?.name) ??
    pegarTexto(obj.function) ??
    pegarTexto(obj.recipient_name);
  let argumentos = obj.arguments ?? obj.args ?? obj.parameters ?? obj.input ?? obj.params ?? obj.function?.arguments;
  if (!nome) {
    // {"bash": {"command": "ls"}}
    const chaves = Object.keys(obj);
    const reservadas = ['arguments', 'args', 'parameters', 'input', 'params', 'function'];
    const ehFerramenta = (c) =>
      !reservadas.includes(c) && (!nomesValidos.length || nomesValidos.includes(corrigirNome(c, nomesValidos)));
    if (chaves.length === 1 && ehFerramenta(chaves[0]) && obj[chaves[0]] && typeof obj[chaves[0]] === 'object') {
      nome = chaves[0];
      argumentos = obj[chaves[0]];
    }
  }
  if (!nome) return null;
  if (typeof argumentos === 'string') {
    const lido = tentarJson(argumentos);
    argumentos = lido && typeof lido === 'object' ? lido : { input: argumentos };
  }
  if (!argumentos || typeof argumentos !== 'object' || Array.isArray(argumentos)) argumentos = {};
  const nomeFinal = corrigirNome(nome, nomesValidos);
  const chamada = { nome: nomeFinal, argumentos };
  if (nomesValidos.length && !nomesValidos.includes(nomeFinal)) chamada.desconhecida = true;
  return chamada;
}

/** Por que um bloco não virou chamada (para pedir a correção ao modelo). */
export function motivoDoBlocoInvalido(corpo, nomesValidos = []) {
  const chamada = interpretarChamada(corpo, nomesValidos);
  if (chamada?.desconhecida) {
    return `there is no tool named "${chamada.nome}". Available tools: ${nomesValidos.join(', ')}.`;
  }
  if (!tentarJson(corpo)) return 'the content between the tags is not valid JSON.';
  return 'the JSON must be an object like {"name": "<tool name>", "arguments": {...}}.';
}

function pegarTexto(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Corrige nomes como "functions.bash" ou "Bash" quando existe a ferramenta "bash". */
export function corrigirNome(nome, nomesValidos) {
  if (!nomesValidos.length || nomesValidos.includes(nome)) return nome;
  const sem = nome.replace(/^(functions|tools|default_api)\./, '');
  if (nomesValidos.includes(sem)) return sem;
  const minusculo = sem.toLowerCase();
  return nomesValidos.find((n) => n.toLowerCase() === minusculo) ?? sem;
}

/** Tamanho do maior final de `texto` que é começo de `marca` (para não cortar uma tag ao meio). */
function prefixoParcial(texto, marca) {
  const max = Math.min(texto.length, marca.length - 1);
  for (let n = max; n > 0; n--) {
    if (marca.startsWith(texto.slice(texto.length - n))) return n;
  }
  return 0;
}

const CERCA_FINAL = /(?:^|\n)[ \t]*```[\w-]*[ \t]*\n?[ \t]*$/;

/** A última cerca do texto abre um bloco de código (e não fecha um)? */
function abreCerca(texto) {
  return (texto.match(/^[ \t]*```/gm) || []).length % 2 === 1;
}

/**
 * Lê o texto do modelo aos pedaços e devolve eventos:
 *   {tipo: 'texto', texto}
 *   {tipo: 'chamada', id, nome, argumentos}   (`argumentos` já em string JSON, como a OpenAI)
 *   {tipo: 'invalido', bruto, motivo}         (bloco que não deu para entender: quem chama
 *                                              decide se pede correção ou mostra como texto)
 */
export class LeitorDeFerramentas {
  constructor({ nomes = [], gerarId = novoIdChamada } = {}) {
    this.nomes = nomes;
    this.gerarId = gerarId;
    this.estado = 'fora';
    this.buf = '';
    this.espacoPendente = '';
    this.tirarCercaDepois = false;
    this.chamadas = [];
    this.textoTotal = '';
  }

  get houveChamadas() {
    return this.chamadas.length > 0;
  }

  receber(delta) {
    const eventos = [];
    if (delta) this.buf += delta;
    this._processar(eventos, false);
    return eventos;
  }

  terminar() {
    const eventos = [];
    this._processar(eventos, true);
    if (this.estado === 'dentro') {
      // Bloco sem </tool_call>: aproveita se o JSON estiver completo.
      const chamada = interpretarChamada(this.buf, this.nomes);
      if (chamada && !chamada.desconhecida) this._emitirChamada(eventos, chamada);
      else this._emitirInvalido(eventos, this.buf, chamada ? undefined : 'the block was not closed with </tool_call> and its JSON is incomplete.');
      this.buf = '';
      this.estado = 'fora';
    } else if (this.buf) {
      this._emitirTexto(eventos, this.buf);
      this.buf = '';
    }
    this.espacoPendente = '';
    return eventos;
  }

  _processar(eventos, final) {
    for (;;) {
      if (this.estado === 'fora') {
        if (this.tirarCercaDepois) {
          // O bloco veio dentro de ```: descarta o ``` que fecha (pode haver outros blocos antes dele).
          const m = /^\s*```[ \t]*(\n|$)/.exec(this.buf);
          const resto = this.buf.trimStart();
          if (m && (m[1] === '\n' || final)) {
            this.buf = this.buf.slice(m[0].length);
            this.tirarCercaDepois = false;
          } else if (resto.startsWith(ABRE)) {
            // outro bloco dentro da mesma cerca: segue lendo
          } else if (!final && (resto === '' || '```'.startsWith(resto) || ABRE.startsWith(resto) || /^```[ \t]*$/.test(resto))) {
            return; // ainda pode ser a cerca ou outro bloco: espera mais texto
          } else this.tirarCercaDepois = false;
        }
        const i = this.buf.indexOf(ABRE);
        if (i >= 0) {
          let antes = this.buf.slice(0, i);
          const cerca = this.tirarCercaDepois ? null : CERCA_FINAL.exec(antes);
          if (cerca && abreCerca(this.textoTotal + this.espacoPendente + antes)) {
            antes = antes.slice(0, cerca.index);
            this.tirarCercaDepois = true;
          }
          this._emitirTexto(eventos, antes.replace(/\s+$/, ''));
          this.espacoPendente = '';
          this.buf = this.buf.slice(i + ABRE.length);
          this.estado = 'dentro';
          continue;
        }
        if (final) return;
        const guardar = this._quantoGuardar();
        const pronto = this.buf.slice(0, this.buf.length - guardar);
        this.buf = this.buf.slice(this.buf.length - guardar);
        this._emitirTexto(eventos, pronto);
        return;
      }
      // dentro de um bloco
      const j = this.buf.indexOf(FECHA);
      if (j < 0) return;
      const corpo = this.buf.slice(0, j);
      this.buf = this.buf.slice(j + FECHA.length);
      this.estado = 'fora';
      const chamada = interpretarChamada(corpo, this.nomes);
      if (chamada && !chamada.desconhecida) this._emitirChamada(eventos, chamada);
      else this._emitirInvalido(eventos, corpo);
    }
  }

  _emitirInvalido(eventos, corpo, motivo) {
    eventos.push({ tipo: 'invalido', bruto: corpo, motivo: motivo ?? motivoDoBlocoInvalido(corpo, this.nomes) });
  }

  /** Quantos caracteres do fim do buffer ainda podem virar parte de uma tag ou cerca. */
  _quantoGuardar() {
    const b = this.buf;
    let guardar = prefixoParcial(b, ABRE);
    // Última linha começando com ``` (ou só crases): pode ser a cerca antes de um bloco.
    const ultimaQuebra = b.lastIndexOf('\n');
    const ultimaLinha = b.slice(ultimaQuebra + 1);
    const semEspaco = ultimaLinha.trimStart();
    if ((semEspaco && '```'.startsWith(semEspaco)) || semEspaco.startsWith('```')) {
      guardar = Math.max(guardar, ultimaLinha.length + (ultimaQuebra >= 0 ? 1 : 0));
    } else if (ultimaQuebra >= 0 && ABRE.startsWith(semEspaco)) {
      // A linha anterior é uma cerca e a atual ainda pode ser o começo de <tool_call>.
      const anterior = b.lastIndexOf('\n', ultimaQuebra - 1);
      const linhaAnterior = b.slice(anterior + 1, ultimaQuebra).trim();
      if (/^```[\w-]*$/.test(linhaAnterior)) guardar = Math.max(guardar, b.length - (anterior + 1) + (anterior >= 0 ? 1 : 0));
    }
    return Math.min(guardar, b.length);
  }

  _emitirTexto(eventos, texto) {
    if (!texto) return;
    // Espaço no fim fica guardado: se vier uma chamada logo depois, ele some.
    const m = /\s+$/.exec(texto);
    const corpo = m ? texto.slice(0, m.index) : texto;
    if (corpo) {
      const saida = this.espacoPendente + corpo;
      this.espacoPendente = '';
      this.textoTotal += saida;
      const ultimo = eventos[eventos.length - 1];
      if (ultimo && ultimo.tipo === 'texto') ultimo.texto += saida;
      else eventos.push({ tipo: 'texto', texto: saida });
    }
    if (m) this.espacoPendente += m[0];
  }

  _emitirChamada(eventos, { nome, argumentos }) {
    const chamada = { tipo: 'chamada', id: this.gerarId(), nome, argumentos: JSON.stringify(argumentos) };
    this.chamadas.push(chamada);
    eventos.push(chamada);
  }
}

/** Atalho para quando a resposta inteira já chegou. */
export function separarChamadas(texto, nomes = []) {
  const leitor = new LeitorDeFerramentas({ nomes });
  const eventos = [...leitor.receber(texto), ...leitor.terminar()];
  const conteudo = eventos.map((e) => (e.tipo === 'texto' ? e.texto : e.tipo === 'invalido' ? blocoComoTexto(e) : '')).join('');
  const chamadas = eventos.filter((e) => e.tipo === 'chamada');
  const invalidos = eventos.filter((e) => e.tipo === 'invalido');
  return { conteudo, chamadas, invalidos };
}

/** Um bloco inválido de volta ao texto original (quando não deu para corrigir). */
export function blocoComoTexto(evento) {
  return ABRE + evento.bruto + FECHA;
}
