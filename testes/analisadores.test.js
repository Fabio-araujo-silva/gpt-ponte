import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../extensao/analisadores.js');
const A = globalThis.GptPonteAnalisadores;

function sse(eventos) {
  return eventos.map((e) => (typeof e === 'string' ? `data: ${e}\n\n` : `${e.event ? `event: ${e.event}\n` : ''}data: ${JSON.stringify(e.data)}\n\n`)).join('');
}

function analisar(texto, tipo, tamanho = Infinity) {
  const a = A.criarAnalisador(tipo);
  for (let i = 0; i < texto.length; i += tamanho) a.alimentar(texto.slice(i, i + tamanho));
  a.terminar();
  return a.resultado();
}

const DELTA_V1 = sse([
  { event: 'delta_encoding', data: 'v1' },
  {
    event: 'delta',
    data: {
      p: '',
      o: 'add',
      v: {
        message: { id: 'm1', author: { role: 'assistant' }, content: { content_type: 'text', parts: [''] }, status: 'in_progress', metadata: { model_slug: 'gpt-5' } },
        conversation_id: 'conv-1',
        error: null,
      },
      c: 0,
    },
  },
  { event: 'delta', data: { p: '/message/content/parts/0', o: 'append', v: 'Olá' } },
  { event: 'delta', data: { v: ', mun' } },
  { event: 'delta', data: { v: 'do <tool_call>\n{"name": "x"}' } },
  {
    event: 'delta',
    data: {
      p: '',
      o: 'patch',
      v: [
        { p: '/message/content/parts/0', o: 'append', v: '\n</tool_call>' },
        { p: '/message/status', o: 'replace', v: 'finished_successfully' },
      ],
    },
  },
  { data: { type: 'message_stream_complete', conversation_id: 'conv-1' } },
  '[DONE]',
]);

test('SSE com delta v1: texto, conversa e modelo', () => {
  for (const tamanho of [Infinity, 1, 3, 17]) {
    const r = analisar(DELTA_V1, 'text/event-stream; charset=utf-8', tamanho);
    assert.equal(r.texto, 'Olá, mundo <tool_call>\n{"name": "x"}\n</tool_call>', `pedaços de ${tamanho}`);
    assert.equal(r.conversaId, 'conv-1');
    assert.equal(r.modelo, 'gpt-5');
    assert.equal(r.erro, null);
    assert.equal(r.terminou, true);
  }
});

test('SSE: pensamento separado do texto, em mensagens diferentes', () => {
  const s = sse([
    { event: 'delta', data: { p: '', o: 'add', v: { message: { id: 't', author: { role: 'assistant' }, content: { content_type: 'thoughts', thoughts: [] }, metadata: {} }, conversation_id: 'c2' }, c: 0 } },
    { event: 'delta', data: { p: '/message/content/thoughts', o: 'append', v: [{ summary: 'Somando', content: 'Dois mais dois.' }] } },
    { event: 'delta', data: { p: '', o: 'add', v: { message: { id: 'm', author: { role: 'assistant' }, content: { content_type: 'text', parts: [''] }, metadata: {} }, conversation_id: 'c2' }, c: 1 } },
    { event: 'delta', data: { p: '/message/content/parts/0', o: 'append', v: '4' } },
    '[DONE]',
  ]);
  const r = analisar(s, 'text/event-stream');
  assert.equal(r.texto, '4');
  assert.equal(r.raciocinio, 'Somando\nDois mais dois.');
});

test('SSE: ignora mensagens para ferramentas internas e de usuário', () => {
  const s = sse([
    { event: 'delta', data: { p: '', o: 'add', v: { message: { id: 'u', author: { role: 'user' }, content: { content_type: 'text', parts: ['pergunta'] } } }, c: 0 } },
    { event: 'delta', data: { p: '', o: 'add', v: { message: { id: 'b', author: { role: 'assistant' }, recipient: 'web.run', content: { content_type: 'code', text: 'search(...)' } } }, c: 1 } },
    { event: 'delta', data: { p: '', o: 'add', v: { message: { id: 'r', author: { role: 'tool' }, content: { content_type: 'text', parts: ['resultados'] } } }, c: 2 } },
    { event: 'delta', data: { p: '', o: 'add', v: { message: { id: 'a', author: { role: 'assistant' }, recipient: 'all', content: { content_type: 'text', parts: ['Resposta final'] } } }, c: 3 } },
    '[DONE]',
  ]);
  assert.equal(analisar(s, 'text/event-stream').texto, 'Resposta final');
});

test('SSE no formato antigo (mensagem inteira a cada evento)', () => {
  const msg = (t) => ({ message: { id: 'm', author: { role: 'assistant' }, content: { content_type: 'text', parts: [t] } }, conversation_id: 'c3', error: null });
  const s = sse([{ data: msg('Ol') }, { data: msg('Olá a') }, { data: msg('Olá a todos') }, '[DONE]']);
  const r = analisar(s, 'text/event-stream');
  assert.equal(r.texto, 'Olá a todos');
  assert.equal(r.conversaId, 'c3');
});

test('SSE: erro no stream é reportado', () => {
  const s = sse([{ data: { message: null, conversation_id: 'c', error: 'You have reached the current usage cap for GPT-5.' } }]);
  const r = analisar(s, 'text/event-stream');
  assert.match(r.erro, /usage cap/);
  assert.equal(A.classificarErro(r.erro), 'limite');
});

// Linhas no formato visto no chatgpt.com sem login (app "mweb").
const MWEB = [
  { version: 2, type: 'control', detail: { kind: 'started' } },
  { version: 2, type: 'control', detail: { kind: 'conversation-id', conversationId: '6b08cb97-8124-83ea-905b-850845a6a944' } },
  { version: 2, type: 'content', messageId: 'm1', revision: 1, mode: 'replace', markdown: '', dil: { fallbackMarkdown: 'Antes.\n\\<tool\\_call>\n{"name": "read", "arguments' }, status: 'streaming' },
  {
    version: 2,
    type: 'content',
    messageId: 'm1',
    revision: 2,
    mode: 'append',
    baseRevision: 1,
    markdown: '',
    dil: {
      fallbackMarkdown:
        'Antes.\n\\<tool\\_call>\n{"name": "read", "arguments": {"path": "a.txt", "n": 2}}\n\\</tool\\_call>\n\\`\\`\\`js\nconst x = 1 \\< 2 &amp;&amp; "a";\n\\`\\`\\`\n\\*\\*negrito\\*\\* e \\_italico\\_\n&#124; a &#124; b &#124;',
    },
    status: 'streaming',
  },
  { version: 2, type: 'content', messageId: 'm1', revision: 3, mode: 'append', markdown: '', status: 'complete' },
  { version: 2, type: 'end' },
]
  .map((o) => JSON.stringify(o))
  .join('\n');

test('NDJSON (mweb): desfaz o escape do fallbackMarkdown e acumula', () => {
  for (const tamanho of [Infinity, 1, 7]) {
    const r = analisar(MWEB + '\n', 'application/vnd.openai.conversation-source+ndjson', tamanho);
    assert.equal(
      r.texto,
      'Antes.\n<tool_call>\n{"name": "read", "arguments": {"path": "a.txt", "n": 2}}\n</tool_call>\n```js\nconst x = 1 < 2 && "a";\n```\n**negrito** e _italico_\n| a | b |',
      `pedaços de ${tamanho}`,
    );
    assert.equal(r.conversaId, '6b08cb97-8124-83ea-905b-850845a6a944');
    assert.equal(r.terminou, true);
  }
});

test('NDJSON: markdown normal em modo append de pedaços', () => {
  const linhas = [
    { type: 'content', messageId: 'a', mode: 'replace', markdown: 'Um', status: 'streaming' },
    { type: 'content', messageId: 'a', mode: 'append', markdown: ', dois', status: 'streaming' },
    { type: 'content', messageId: 'a', mode: 'append', markdown: ', três', status: 'complete' },
  ]
    .map((o) => JSON.stringify(o))
    .join('\n');
  assert.equal(analisar(linhas, 'application/x-ndjson').texto, 'Um, dois, três');
});

test('o texto só cresce durante o streaming, mesmo com escape cortado no meio', () => {
  const a = new A.AnalisadorNdjson();
  const passos = ['Custo \\', 'Custo \\< 5 &am', 'Custo \\< 5 &amp; mais'];
  let anterior = '';
  for (const fb of passos) {
    a.alimentar(JSON.stringify({ type: 'content', messageId: 'x', mode: 'append', dil: { fallbackMarkdown: fb }, status: 'streaming' }) + '\n');
    const t = a.resultado().texto;
    assert.ok(t.startsWith(anterior), `"${t}" deveria começar com "${anterior}"`);
    anterior = t;
  }
  a.alimentar(JSON.stringify({ type: 'content', messageId: 'x', mode: 'append', status: 'complete' }) + '\n');
  assert.equal(a.resultado().texto, 'Custo < 5 & mais');
});

test('desescaparMarkdown', () => {
  assert.equal(A.desescaparMarkdown('a \\* b \\\\ c \\q &lt;x&gt; &#x41;&#66; &copy; &nbsp;'), 'a * b \\ c \\q <x> AB &copy;  ');
  assert.equal(A.desescaparMarkdown('fim com barra \\', true), 'fim com barra ');
  assert.equal(A.desescaparMarkdown('fim com barra \\', false), 'fim com barra \\');
  assert.equal(A.desescaparMarkdown('R&D e &amp', true), 'R&D e ');
  assert.equal(A.desescaparMarkdown('R&D e &amp', false), 'R&D e &amp');
});

test('aplicarOperacao cobre add, replace, append, truncate e remove', () => {
  let d = A.aplicarOperacao({}, 'add', { a: { b: ['x'] }, s: 'oi' }, '');
  d = A.aplicarOperacao(d, 'append', 'y', '/a/b/0');
  d = A.aplicarOperacao(d, 'append', ['z'], '/a/b');
  d = A.aplicarOperacao(d, 'replace', 'tchau', '/s');
  d = A.aplicarOperacao(d, 'add', 1, '/novo/caminho');
  assert.deepEqual(d, { a: { b: ['xy', 'z'] }, s: 'tchau', novo: { caminho: 1 } });
  d = A.aplicarOperacao(d, 'truncate', 1, '/a/b');
  d = A.aplicarOperacao(d, 'remove', null, '/novo');
  assert.deepEqual(d, { a: { b: ['xy'] }, s: 'tchau' });
});

test('classificarErro', () => {
  assert.equal(A.classificarErro('Too many requests', 429), 'limite');
  assert.equal(A.classificarErro("You've reached our limit of messages per hour."), 'limite');
  assert.equal(A.classificarErro('The message you submitted was too long'), 'mensagem_longa');
  assert.equal(A.classificarErro('Unusual activity: please verify you are human'), 'verificacao');
  assert.equal(A.classificarErro('Something went wrong', 500), 'chatgpt');
});
