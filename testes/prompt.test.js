import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizarMensagens,
  montarPromptInicial,
  montarContinuacao,
  chavesDosPrefixos,
  mensagemDaResposta,
  textoDoConteudo,
  contextoDoPedido,
} from '../servidor/prompt.js';
import { MemoriaDeConversas } from '../servidor/conversas.js';
import { lerFerramentas } from '../servidor/ferramentas.js';

const FERRAMENTAS = lerFerramentas([
  { type: 'function', function: { name: 'bash', description: 'Roda comandos.', parameters: { type: 'object', properties: { command: { type: 'string' } } } } },
]);

test('conteúdo em partes vira texto e imagens viram aviso', () => {
  assert.equal(textoDoConteudo([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.match(textoDoConteudo([{ type: 'image_url', image_url: { url: 'data:...' } }]), /imagem omitida/);
  assert.equal(textoDoConteudo(null), '');
});

test('pedido simples vai sem moldura', () => {
  const msgs = normalizarMensagens([{ role: 'user', content: 'Oi, tudo bem?' }]);
  assert.equal(montarPromptInicial(msgs), 'Oi, tudo bem?');
});

test('sistema e ferramentas entram no prompt inicial', () => {
  const msgs = normalizarMensagens([
    { role: 'system', content: 'Você é um agente de código.' },
    { role: 'user', content: 'Liste os arquivos.' },
  ]);
  const p = montarPromptInicial(msgs, { ferramentas: FERRAMENTAS });
  assert.match(p, /<system_instructions>\nVocê é um agente de código\.\n<\/system_instructions>/);
  assert.match(p, /<tools>[\s\S]*### bash[\s\S]*<\/tools>/);
  assert.match(p, /The user says:\n\nListe os arquivos\.$/);
});

test('histórico com chamadas e resultados vira uma conversa legível', () => {
  const msgs = normalizarMensagens([
    { role: 'system', content: 'S' },
    { role: 'user', content: 'U1' },
    { role: 'assistant', content: 'Vou ver.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'a.txt' },
  ]);
  assert.equal(msgs[3].nome, 'bash');
  const p = montarPromptInicial(msgs, { ferramentas: FERRAMENTAS });
  assert.match(p, /<message role="user">\nU1\n<\/message>/);
  assert.match(p, /<message role="assistant">\nVou ver\.\n<tool_call>\n\{"name":"bash","arguments":\{"command":"ls"\}\}\n<\/tool_call>\n<\/message>/);
  assert.match(p, /<tool_result name="bash" call_id="call_1">\na\.txt\n<\/tool_result>/);
  assert.match(p, /Now write the next assistant reply\.$/);
});

test('continuação manda só resultados e a mensagem nova', () => {
  const novas = normalizarMensagens([
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'saída' },
    { role: 'user', content: 'e agora?' },
  ]).slice(1);
  const p = montarContinuacao(novas, { ferramentas: FERRAMENTAS });
  assert.match(p, /^<tool_result name="bash" call_id="c1">\nsaída\n<\/tool_result>/);
  assert.match(p, /The user says:\n\ne agora\?/);
  assert.match(p, /Reminder/);
  assert.equal(montarContinuacao(normalizarMensagens([{ role: 'user', content: 'só texto' }])), 'só texto');
  assert.equal(montarContinuacao(normalizarMensagens([{ role: 'assistant', content: 'x' }])), null);
  assert.equal(montarContinuacao([]), null);
});

test('chaves dos prefixos ignoram ids e formatação dos argumentos', () => {
  const a = normalizarMensagens([
    { role: 'user', content: 'U' },
    { role: 'assistant', content: 'ok', tool_calls: [{ id: 'x1', function: { name: 'bash', arguments: '{"b":1,"a":2}' } }] },
  ]);
  const b = normalizarMensagens([
    { role: 'user', content: 'U' },
    { role: 'assistant', content: ' ok\n', tool_calls: [{ id: 'outro', function: { name: 'bash', arguments: '{"a": 2, "b": 1}' } }] },
  ]);
  assert.deepEqual(chavesDosPrefixos(a), chavesDosPrefixos(b));
  assert.notDeepEqual(chavesDosPrefixos(a, 'modelo-1'), chavesDosPrefixos(a, 'modelo-2'));
  const c = normalizarMensagens([{ role: 'user', content: 'V' }]);
  assert.notEqual(chavesDosPrefixos(a)[0], chavesDosPrefixos(c)[0]);
});

test('fluxo de agente: cada passo continua a conversa anterior', () => {
  const memoria = new MemoriaDeConversas();
  const ctx = contextoDoPedido('chatgpt', [{ name: 'bash' }]);
  // Passo 1: pedido novo
  const passo1 = normalizarMensagens([
    { role: 'system', content: 'S' },
    { role: 'user', content: 'U' },
  ]);
  assert.equal(memoria.procurar(chavesDosPrefixos(passo1, ctx)), null);
  // A ponte respondeu com uma chamada de ferramenta
  const resposta1 = mensagemDaResposta('Vou listar.', [{ id: 'call_A', nome: 'bash', argumentos: '{"command":"ls"}' }]);
  const chaves1 = chavesDosPrefixos([...passo1, resposta1], ctx);
  memoria.registrar(chaves1.at(-1), { aba: 7, conversaId: 'conv-1', mensagens: 3 });

  // Passo 2: o cliente devolve o histórico + o resultado da ferramenta
  const passo2 = normalizarMensagens([
    { role: 'system', content: 'S' },
    { role: 'user', content: 'U' },
    { role: 'assistant', content: 'Vou listar.', tool_calls: [{ id: 'call_A', type: 'function', function: { name: 'bash', arguments: '{"command": "ls"}' } }] },
    { role: 'tool', tool_call_id: 'call_A', content: 'a.txt b.txt' },
  ]);
  const achado = memoria.procurar(chavesDosPrefixos(passo2, ctx));
  assert.ok(achado);
  assert.equal(achado.info.aba, 7);
  assert.equal(achado.mensagens, 3);
  assert.deepEqual(passo2.slice(achado.mensagens).map((m) => m.papel), ['ferramenta']);

  // Ao consumir, a mesma entrada não serve para outro pedido
  memoria.consumir(achado.chave);
  assert.equal(memoria.procurar(chavesDosPrefixos(passo2, ctx)), null);
});

test('memória esquece abas reaproveitadas e respeita o limite', () => {
  const m = new MemoriaDeConversas({ max: 2 });
  m.registrar('k1', { aba: 1 });
  m.registrar('k2', { aba: 1 }); // mesma aba: k1 deixa de valer
  assert.equal(m.tamanho, 1);
  m.registrar('k3', { aba: 2 });
  m.registrar('k4', { aba: 3 });
  assert.equal(m.tamanho, 2);
  assert.equal(m.procurar(['k2', 'x']), null);
  assert.ok(m.procurar(['k4', 'x']));
});
