import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonTolerante, tentarJson } from '../servidor/json-tolerante.js';
import {
  LeitorDeFerramentas,
  separarChamadas,
  interpretarChamada,
  instrucoesDeFerramentas,
  lerFerramentas,
  formatarResultado,
  corrigirNome,
} from '../servidor/ferramentas.js';

// ------------------------------------------------------------------ JSON tolerante

test('JSON válido passa direto', () => {
  assert.deepEqual(jsonTolerante('{"a": [1, 2.5, -3e2], "b": null, "c": "x\\ny"}'), { a: [1, 2.5, -300], b: null, c: 'x\ny' });
});

test('JSON com os erros comuns de modelo', () => {
  assert.deepEqual(jsonTolerante('```json\n{"a": 1,}\n```'), { a: 1 });
  assert.deepEqual(jsonTolerante('{"conteudo": "linha 1\nlinha 2\tfim"}'), { conteudo: 'linha 1\nlinha 2\tfim' });
  assert.deepEqual(jsonTolerante("{'a': 'b', c: True, d: None}"), { a: 'b', c: true, d: null });
  assert.deepEqual(jsonTolerante('{"a": 1} e depois texto'), { a: 1 });
  assert.deepEqual(jsonTolerante('{"a": 1 // comentário\n, /* outro */ "b": 2}'), { a: 1, b: 2 });
  assert.deepEqual(jsonTolerante('{"cmd": "echo "oi" > a.txt"}'), { cmd: 'echo "oi" > a.txt' });
  assert.deepEqual(jsonTolerante('{"path": "C:\\pasta\\arquivo"}'), { path: 'C:\\pasta\\arquivo' });
  assert.deepEqual(jsonTolerante('{"a": {"b": [1, 2'), { a: { b: [1, 2] } });
});

test('tentarJson devolve undefined quando não dá', () => {
  assert.equal(tentarJson('isto não é json'), undefined);
  assert.equal(tentarJson(''), undefined);
});

// ------------------------------------------------------------------ interpretar chamada

test('interpreta os formatos de chamada que os modelos costumam usar', () => {
  const nomes = ['bash', 'read'];
  assert.deepEqual(interpretarChamada('{"name": "bash", "arguments": {"command": "ls"}}', nomes), { nome: 'bash', argumentos: { command: 'ls' } });
  assert.deepEqual(interpretarChamada('{"name": "bash", "arguments": "{\\"command\\": \\"ls\\"}"}', nomes), { nome: 'bash', argumentos: { command: 'ls' } });
  assert.deepEqual(interpretarChamada('{"tool": "read", "args": {"path": "a"}}', nomes), { nome: 'read', argumentos: { path: 'a' } });
  assert.deepEqual(interpretarChamada('{"function": {"name": "functions.bash", "arguments": {"command": "pwd"}}}', nomes), { nome: 'bash', argumentos: { command: 'pwd' } });
  assert.deepEqual(interpretarChamada('{"bash": {"command": "ls"}}', nomes), { nome: 'bash', argumentos: { command: 'ls' } });
  assert.deepEqual(interpretarChamada('{"name": "Read"}', nomes), { nome: 'read', argumentos: {} });
  assert.equal(interpretarChamada('sem json', nomes), null);
  assert.equal(interpretarChamada('{"arguments": {}}', nomes), null);
});

test('corrige nomes de ferramenta', () => {
  assert.equal(corrigirNome('functions.bash', ['bash']), 'bash');
  assert.equal(corrigirNome('BASH', ['bash']), 'bash');
  assert.equal(corrigirNome('outra', ['bash']), 'outra');
  assert.equal(corrigirNome('qualquer', []), 'qualquer');
});

// ------------------------------------------------------------------ leitor em streaming

let contador = 0;
const idFixo = () => `call_${++contador}`;

function lerEmPedacos(texto, tamanhos, nomes = ['bash', 'read']) {
  contador = 0;
  const leitor = new LeitorDeFerramentas({ nomes, gerarId: idFixo });
  const eventos = [];
  let i = 0;
  let k = 0;
  while (i < texto.length) {
    const n = Math.max(1, tamanhos[k++ % tamanhos.length]);
    eventos.push(...leitor.receber(texto.slice(i, i + n)));
    i += n;
  }
  eventos.push(...leitor.terminar());
  // blocos inválidos voltam como texto aqui (na API, a ponte antes pede a correção ao modelo)
  const conteudo = eventos.map((e) => (e.tipo === 'texto' ? e.texto : e.tipo === 'invalido' ? `<tool_call>${e.bruto}</tool_call>` : '')).join('');
  const chamadas = eventos.filter((e) => e.tipo === 'chamada').map(({ nome, argumentos }) => ({ nome, argumentos: JSON.parse(argumentos) }));
  return { conteudo, chamadas };
}

const CASOS = [
  {
    nome: 'texto puro',
    texto: 'Olá! Tudo certo por aqui.\n\nSegunda linha com `código` e <tag>.',
    conteudo: 'Olá! Tudo certo por aqui.\n\nSegunda linha com `código` e <tag>.',
    chamadas: [],
  },
  {
    nome: 'texto e uma chamada',
    texto: 'Vou listar os arquivos.\n\n<tool_call>\n{"name": "bash", "arguments": {"command": "ls -la"}}\n</tool_call>\n',
    conteudo: 'Vou listar os arquivos.',
    chamadas: [{ nome: 'bash', argumentos: { command: 'ls -la' } }],
  },
  {
    nome: 'duas chamadas seguidas',
    texto: '<tool_call>\n{"name": "read", "arguments": {"path": "a.txt"}}\n</tool_call>\n<tool_call>\n{"name": "read", "arguments": {"path": "b.txt"}}\n</tool_call>',
    conteudo: '',
    chamadas: [
      { nome: 'read', argumentos: { path: 'a.txt' } },
      { nome: 'read', argumentos: { path: 'b.txt' } },
    ],
  },
  {
    nome: 'chamada dentro de cerca de código',
    texto: 'Lendo:\n```xml\n<tool_call>\n{"name": "read", "arguments": {"path": "x"}}\n</tool_call>\n```\n',
    conteudo: 'Lendo:',
    chamadas: [{ nome: 'read', argumentos: { path: 'x' } }],
  },
  {
    nome: 'duas chamadas dentro da mesma cerca',
    texto: '```\n<tool_call>\n{"name": "read", "arguments": {"path": "1"}}\n</tool_call>\n<tool_call>\n{"name": "read", "arguments": {"path": "2"}}\n</tool_call>\n```',
    conteudo: '',
    chamadas: [
      { nome: 'read', argumentos: { path: '1' } },
      { nome: 'read', argumentos: { path: '2' } },
    ],
  },
  {
    nome: 'bloco de código normal antes da chamada fica intacto',
    texto: 'Exemplo:\n```js\nconst a = 1;\n```\n<tool_call>\n{"name": "bash", "arguments": {"command": "node a.js"}}\n</tool_call>',
    conteudo: 'Exemplo:\n```js\nconst a = 1;\n```',
    chamadas: [{ nome: 'bash', argumentos: { command: 'node a.js' } }],
  },
  {
    nome: 'código com quebra de linha crua no JSON',
    texto: '<tool_call>\n{"name": "bash", "arguments": {"command": "cat <<EOF > a.txt\nlinha \\"1\\"\nEOF"}}\n</tool_call>',
    conteudo: '',
    chamadas: [{ nome: 'bash', argumentos: { command: 'cat <<EOF > a.txt\nlinha "1"\nEOF' } }],
  },
  {
    nome: 'chamada sem tag de fechamento no fim da resposta',
    texto: 'Ok.\n<tool_call>\n{"name": "bash", "arguments": {"command": "pwd"}}',
    conteudo: 'Ok.',
    chamadas: [{ nome: 'bash', argumentos: { command: 'pwd' } }],
  },
  {
    nome: 'bloco inválido volta como texto',
    texto: 'Antes <tool_call>isto não é json</tool_call> depois',
    conteudo: 'Antes<tool_call>isto não é json</tool_call> depois',
    chamadas: [],
  },
  {
    nome: 'texto que termina com começo de tag',
    texto: 'compare a <tool_c',
    conteudo: 'compare a <tool_c',
    chamadas: [],
  },
  {
    nome: 'resposta termina com bloco de código',
    texto: 'Pronto:\n```\nfeito\n```',
    conteudo: 'Pronto:\n```\nfeito\n```',
    chamadas: [],
  },
  {
    nome: 'texto depois da chamada é mantido',
    texto: '<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>\n\nAguardo o resultado.',
    conteudo: '\n\nAguardo o resultado.',
    chamadas: [{ nome: 'bash', argumentos: { command: 'ls' } }],
  },
];

for (const caso of CASOS) {
  test(`leitor: ${caso.nome} (inteiro e em todos os tamanhos de pedaço)`, () => {
    const esperado = { conteudo: caso.conteudo, chamadas: caso.chamadas };
    for (const tamanhos of [[100000], [1], [2], [3], [5], [7, 1, 13], [4, 11, 2, 1, 9]]) {
      assert.deepEqual(lerEmPedacos(caso.texto, tamanhos), esperado, `pedaços ${tamanhos.join(',')}`);
    }
  });
}

test('separarChamadas gera ids únicos no formato da OpenAI', () => {
  const r = separarChamadas('<tool_call>{"name":"bash","arguments":{}}</tool_call><tool_call>{"name":"bash","arguments":{}}</tool_call>', ['bash']);
  assert.equal(r.chamadas.length, 2);
  assert.match(r.chamadas[0].id, /^call_[A-Za-z0-9]{24}$/);
  assert.notEqual(r.chamadas[0].id, r.chamadas[1].id);
  assert.equal(r.chamadas[0].argumentos, '{}');
});

test('o leitor não deixa vazar pedaço de tag no streaming', () => {
  const leitor = new LeitorDeFerramentas({ nomes: ['bash'] });
  const saida = [];
  for (const ch of 'Oi <tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>') {
    for (const e of leitor.receber(ch)) if (e.tipo === 'texto') saida.push(e.texto);
  }
  leitor.terminar();
  assert.equal(saida.join(''), 'Oi');
  assert.ok(!saida.join('').includes('<'));
});

// ------------------------------------------------------------------ instruções

test('instruções listam as ferramentas e respeitam tool_choice', () => {
  const ferramentas = lerFerramentas([
    { type: 'function', function: { name: 'bash', description: 'Roda um comando.', parameters: { type: 'object', properties: { command: { type: 'string' } } } } },
    { type: 'function', function: { name: 'read' } },
    { type: 'custom', custom: { name: 'ignorada' } },
  ]);
  assert.deepEqual(ferramentas.map((f) => f.nome), ['bash', 'read']);
  const texto = instrucoesDeFerramentas(ferramentas, { toolChoice: 'required' });
  assert.match(texto, /### bash\nRoda um comando\.\nArguments \(JSON Schema\): \{"type":"object"/);
  assert.match(texto, /### read/);
  assert.match(texto, /MUST write at least one request block/);
  assert.match(instrucoesDeFerramentas(ferramentas, { toolChoice: { type: 'function', function: { name: 'read' } } }), /MUST write a request block for the tool "read"/);
  assert.match(instrucoesDeFerramentas(ferramentas, { paralelas: false }), /at most ONE request block/);
  assert.equal(instrucoesDeFerramentas([]), '');
});

test('resultado de ferramenta é formatado com nome e id', () => {
  assert.equal(formatarResultado({ nome: 'bash', id: 'call_1', conteudo: 'ok' }), '<tool_result name="bash" call_id="call_1">\nok\n</tool_result>');
});

test('blocos inválidos viram eventos "invalido" com o motivo, para a ponte pedir correção', () => {
  const nomes = ['read', 'bash'];
  const r1 = separarChamadas('Ok.\n<tool_call>\n{"name": "ler_arquivo", "arguments": {"path": "a"}}\n</tool_call>', nomes);
  assert.equal(r1.chamadas.length, 0);
  assert.equal(r1.invalidos.length, 1);
  assert.match(r1.invalidos[0].motivo, /no tool named "ler_arquivo"\. Available tools: read, bash/);
  const r2 = separarChamadas('<tool_call>{"name": "read", "arguments": {"path": </tool_call>', nomes);
  assert.equal(r2.invalidos.length, 1);
  assert.match(r2.invalidos[0].motivo, /JSON|object/);
  const r3 = separarChamadas('<tool_call>isto não é json</tool_call>', nomes);
  assert.match(r3.invalidos[0].motivo, /not valid JSON/);
  // sem lista de ferramentas, qualquer nome vale
  assert.equal(separarChamadas('<tool_call>{"name": "x", "arguments": {}}</tool_call>').chamadas.length, 1);
});
