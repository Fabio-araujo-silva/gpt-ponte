import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { criarPonte } from '../servidor/app.js';
import { PADRAO } from '../servidor/config.js';
import { conectarWS } from '../servidor/websocket.js';

async function iniciarPonte(extra = {}) {
  const config = { ...PADRAO, origens: [], porta: 0, esperaExtensaoMs: 2000, ...extra };
  const ponte = criarPonte(config);
  const endereco = await ponte.escutar();
  const base = `http://127.0.0.1:${endereco.port}`;
  return { ponte, base, ws: `ws://127.0.0.1:${endereco.port}/extensao`, fechar: () => ponte.fechar() };
}

async function pedir(base, corpo, cabecalhos = {}) {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cabecalhos },
    body: JSON.stringify(corpo),
  });
  return r;
}

async function lerSSE(resposta) {
  const texto = await resposta.text();
  const eventos = [];
  for (const bloco of texto.split('\n\n')) {
    for (const linha of bloco.split('\n')) {
      if (!linha.startsWith('data: ')) continue;
      eventos.push(linha === 'data: [DONE]' ? '[DONE]' : JSON.parse(linha.slice(6)));
    }
  }
  return eventos;
}

function juntarStream(eventos) {
  let conteudo = '';
  const chamadas = [];
  let motivo = null;
  let uso = null;
  for (const e of eventos) {
    if (e === '[DONE]') continue;
    if (e.usage) uso = e.usage;
    const c = e.choices?.[0];
    if (!c) continue;
    if (c.delta?.content) conteudo += c.delta.content;
    for (const t of c.delta?.tool_calls ?? []) chamadas[t.index] = t;
    if (c.finish_reason) motivo = c.finish_reason;
  }
  return { conteudo, chamadas, motivo, uso };
}

/** Extensão de mentira falando o protocolo de verdade pelo WebSocket. */
async function extensaoFalsa(url, responder) {
  const c = await conectarWS(url, { origem: 'chrome-extension://teste' });
  const recebidas = [];
  c.on('mensagem', async (texto) => {
    const m = JSON.parse(texto);
    recebidas.push(m);
    if (m.tipo === 'ping') c.enviar({ tipo: 'pong' });
    if (m.tipo === 'tarefa') await responder(m, c);
  });
  c.enviar({ tipo: 'ola', protocolo: 1, versao: 'teste', navegador: 'Teste', config: { maxAbas: 2 } });
  await new Promise((r) => setTimeout(r, 30));
  return { conexao: c, recebidas };
}

test('modo simulação: resposta sem stream no formato da OpenAI', async () => {
  const p = await iniciarPonte({ simular: true });
  const r = await pedir(p.base, { model: 'chatgpt', messages: [{ role: 'user', content: 'Oi!' }] });
  assert.equal(r.status, 200);
  const corpo = await r.json();
  assert.equal(corpo.object, 'chat.completion');
  assert.match(corpo.id, /^chatcmpl-/);
  assert.equal(corpo.choices[0].message.role, 'assistant');
  assert.match(corpo.choices[0].message.content, /Simulação/);
  assert.equal(corpo.choices[0].finish_reason, 'stop');
  assert.ok(corpo.usage.prompt_tokens > 0);
  await p.fechar();
});

test('stream: papel no primeiro pedaço, motivo no último, uso e [DONE]', async () => {
  const p = await iniciarPonte({ simular: true });
  const r = await pedir(p.base, { model: 'chatgpt', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'Oi!' }] });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const eventos = await lerSSE(r);
  assert.equal(eventos.at(-1), '[DONE]');
  assert.equal(eventos[0].choices[0].delta.role, 'assistant');
  assert.equal(eventos[0].object, 'chat.completion.chunk');
  const j = juntarStream(eventos);
  assert.match(j.conteudo, /^Simulação \(turno 1/);
  assert.equal(j.motivo, 'stop');
  assert.ok(j.uso.total_tokens > 0);
  assert.deepEqual(eventos.at(-2).choices, []);
  await p.fechar();
});

test('ferramentas: chamada vira tool_calls e o passo seguinte continua a mesma conversa', async () => {
  const p = await iniciarPonte({ simular: true });
  const tools = [{ type: 'function', function: { name: 'bash', description: 'Roda um comando', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }];
  const historico = [
    { role: 'system', content: 'Você é um agente.' },
    { role: 'user', content: 'Liste.\n/ferramenta bash {"command": "ls"}' },
  ];
  const r1 = await pedir(p.base, { model: 'chatgpt', stream: true, tools, messages: historico });
  const j1 = juntarStream(await lerSSE(r1));
  assert.equal(j1.motivo, 'tool_calls');
  assert.equal(j1.chamadas.length, 1);
  assert.equal(j1.chamadas[0].function.name, 'bash');
  assert.deepEqual(JSON.parse(j1.chamadas[0].function.arguments), { command: 'ls' });
  assert.equal(j1.conteudo, 'Vou usar a ferramenta bash.');

  historico.push({ role: 'assistant', content: j1.conteudo, tool_calls: [{ id: j1.chamadas[0].id, type: 'function', function: j1.chamadas[0].function }] });
  historico.push({ role: 'tool', tool_call_id: j1.chamadas[0].id, content: 'a.txt\nb.txt' });
  const r2 = await pedir(p.base, { model: 'chatgpt', tools, messages: historico });
  const c2 = await r2.json();
  assert.match(c2.choices[0].message.content, /A ferramenta respondeu: a\.txt/);

  const sim = p.ponte.executor;
  assert.equal(sim.historico.length, 2);
  assert.equal(sim.historico[0].nova, true);
  assert.match(sim.historico[0].prompt, /<tools>/);
  assert.equal(sim.historico[1].nova, false, 'o segundo passo deve continuar a conversa');
  assert.match(sim.historico[1].prompt, /^<tool_result name="bash"/);
  assert.doesNotMatch(sim.historico[1].prompt, /<tools>/);
  await p.fechar();
});

test('sem a extensão conectada o pedido falha com 503 e mensagem clara', async () => {
  const p = await iniciarPonte({ esperaExtensaoMs: 50 });
  const r = await pedir(p.base, { messages: [{ role: 'user', content: 'Oi' }] });
  assert.equal(r.status, 503);
  const corpo = await r.json();
  assert.match(corpo.error.message, /extensão/i);
  await p.fechar();
});

test('extensão de verdade pelo WebSocket: inicio, deltas e fim', async () => {
  const p = await iniciarPonte();
  const ext = await extensaoFalsa(p.ws, async (m, c) => {
    c.enviar({ tipo: 'inicio', id: m.id, aba: 42, conversaId: 'conv-x' });
    for (const parte of ['Olá', ', ', 'mundo', '!']) c.enviar({ tipo: 'delta', id: m.id, texto: parte });
    c.enviar({ tipo: 'fim', id: m.id, texto: 'Olá, mundo!', aba: 42, conversaId: 'conv-x' });
  });
  const r = await pedir(p.base, { stream: true, messages: [{ role: 'user', content: 'Diga olá' }] });
  const j = juntarStream(await lerSSE(r));
  assert.equal(j.conteudo, 'Olá, mundo!');
  const tarefa = ext.recebidas.find((m) => m.tipo === 'tarefa');
  assert.equal(tarefa.prompt, 'Diga olá');
  assert.equal(tarefa.nova, true);
  const estado = await fetch(`${p.base}/estado`).then((x) => x.json());
  assert.equal(estado.navegador.conectada, true);
  assert.equal(estado.navegador.capacidade, 2);
  ext.conexao.fechar();
  await p.fechar();
});

test('erro da extensão vira status HTTP certo (limite → 429)', async () => {
  const p = await iniciarPonte();
  const ext = await extensaoFalsa(p.ws, async (m, c) => {
    c.enviar({ tipo: 'erro', id: m.id, codigo: 'limite', mensagem: 'Você atingiu o limite.' });
  });
  const r = await pedir(p.base, { messages: [{ role: 'user', content: 'Oi' }] });
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error.message, 'Você atingiu o limite.');
  ext.conexao.fechar();
  await p.fechar();
});

test('extensão cai no meio da resposta: o stream recebe um erro', async () => {
  const p = await iniciarPonte();
  const ext = await extensaoFalsa(p.ws, async (m, c) => {
    c.enviar({ tipo: 'inicio', id: m.id, aba: 1 });
    c.enviar({ tipo: 'delta', id: m.id, texto: 'começo...' });
    setTimeout(() => c.destruir(), 30);
  });
  const r = await pedir(p.base, { stream: true, messages: [{ role: 'user', content: 'Oi' }] });
  const eventos = await lerSSE(r);
  assert.ok(eventos.some((e) => e.error && /desconectou/.test(e.error.message)));
  assert.equal(juntarStream(eventos).conteudo, 'começo...');
  ext.conexao.fechar();
  await p.fechar();
});

test('cliente desiste: a extensão recebe "cancelar"', async () => {
  const p = await iniciarPonte();
  let idTarefa;
  const ext = await extensaoFalsa(p.ws, async (m, c) => {
    idTarefa = m.id;
    c.enviar({ tipo: 'inicio', id: m.id, aba: 1 });
    c.enviar({ tipo: 'delta', id: m.id, texto: 'pensando' });
  });
  const controle = new AbortController();
  const r = await fetch(`${p.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'Oi' }] }),
    signal: controle.signal,
  });
  const leitor = r.body.getReader();
  await leitor.read();
  controle.abort();
  for (let i = 0; i < 50 && !ext.recebidas.some((m) => m.tipo === 'cancelar'); i++) await new Promise((x) => setTimeout(x, 20));
  const cancelar = ext.recebidas.find((m) => m.tipo === 'cancelar');
  assert.ok(cancelar, 'a extensão deveria receber cancelar');
  assert.equal(cancelar.id, idTarefa);
  ext.conexao.fechar();
  await p.fechar();
});

test('conversa sumiu do navegador: a ponte reenvia tudo numa conversa nova', async () => {
  const p = await iniciarPonte();
  let n = 0;
  const ext = await extensaoFalsa(p.ws, async (m, c) => {
    n++;
    if (!m.nova) {
      c.enviar({ tipo: 'erro', id: m.id, codigo: 'conversa_indisponivel' });
      return;
    }
    const texto = n === 1 ? 'Resposta 1' : 'Resposta 2';
    c.enviar({ tipo: 'inicio', id: m.id, aba: 5, conversaId: 'c' + n });
    c.enviar({ tipo: 'delta', id: m.id, texto });
    c.enviar({ tipo: 'fim', id: m.id, texto, aba: 5, conversaId: 'c' + n });
  });
  const msgs = [{ role: 'user', content: 'Primeira' }];
  const c1 = await (await pedir(p.base, { messages: msgs })).json();
  msgs.push({ role: 'assistant', content: c1.choices[0].message.content }, { role: 'user', content: 'Segunda' });
  const c2 = await (await pedir(p.base, { messages: msgs })).json();
  assert.equal(c2.choices[0].message.content, 'Resposta 2');
  const tarefas = ext.recebidas.filter((m) => m.tipo === 'tarefa');
  assert.deepEqual(tarefas.map((t) => t.nova), [true, false, true]);
  assert.equal(tarefas[1].prompt, 'Segunda');
  assert.match(tarefas[2].prompt, /<conversation>[\s\S]*Primeira[\s\S]*Resposta 1[\s\S]*Segunda/);
  ext.conexao.fechar();
  await p.fechar();
});

test('stop corta a resposta na sequência pedida', async () => {
  const p = await iniciarPonte();
  const ext = await extensaoFalsa(p.ws, async (m, c) => {
    c.enviar({ tipo: 'inicio', id: m.id, aba: 1 });
    for (const parte of ['um, dois, ', 'TRÊS', ', quatro']) c.enviar({ tipo: 'delta', id: m.id, texto: parte });
    c.enviar({ tipo: 'fim', id: m.id, texto: 'um, dois, TRÊS, quatro', aba: 1 });
  });
  const c1 = await (await pedir(p.base, { stop: ['TRÊS'], messages: [{ role: 'user', content: 'conte' }] })).json();
  assert.equal(c1.choices[0].message.content, 'um, dois, ');
  ext.conexao.fechar();
  await p.fechar();
});

/** fetch não deixa trocar Origin e Host; http.request deixa. */
function pedidoCru(base, { metodo = 'GET', caminho = '/v1/models', cabecalhos = {}, corpo } = {}) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, method: metodo, path: caminho, headers: cabecalhos }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(corpo);
  });
}

test('segurança: sites, Host estranho, chave e origem do WebSocket', async () => {
  const p = await iniciarPonte({ simular: true, chave: 'segredo' });
  const corpo = { messages: [{ role: 'user', content: 'Oi' }] };
  assert.equal((await pedir(p.base, corpo)).status, 401);
  assert.equal((await pedir(p.base, corpo, { Authorization: 'Bearer errada' })).status, 401);
  assert.equal((await pedir(p.base, corpo, { Authorization: 'Bearer segredo' })).status, 200);
  const comChave = { Authorization: 'Bearer segredo', 'Content-Type': 'application/json' };
  const json = JSON.stringify(corpo);
  // Um site aberto no navegador tentando usar a ponte (CSRF):
  assert.equal(await pedidoCru(p.base, { metodo: 'POST', caminho: '/v1/chat/completions', cabecalhos: { ...comChave, Origin: 'https://site-malicioso.com' }, corpo: json }), 403);
  // A própria página da ponte pode:
  assert.equal(await pedidoCru(p.base, { metodo: 'POST', caminho: '/v1/chat/completions', cabecalhos: { ...comChave, Origin: p.base }, corpo: json }), 200);
  // DNS rebinding (Host de outro domínio apontando para 127.0.0.1):
  assert.equal(await pedidoCru(p.base, { cabecalhos: { ...comChave, Host: 'evil.example.com' } }), 403);
  assert.equal(await pedidoCru(p.base, { cabecalhos: { ...comChave, Host: 'localhost:4545' } }), 200);
  await assert.rejects(conectarWS(p.ws, { origem: 'https://site-malicioso.com' }), /403/);
  const modelos = await fetch(`${p.base}/v1/models`, { headers: { Authorization: 'Bearer segredo' } }).then((r) => r.json());
  assert.ok(modelos.data.some((m) => m.id === 'chatgpt'));
  assert.equal((await fetch(`${p.base}/saude`)).status, 200);
  await p.fechar();
});

test('pedido inválido devolve 400 no formato da OpenAI', async () => {
  const p = await iniciarPonte({ simular: true });
  const r = await pedir(p.base, { messages: [] });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.type, 'invalid_request_error');
  const r2 = await fetch(`${p.base}/v1/chat/completions`, { method: 'POST', body: '{quebrado' });
  assert.equal(r2.status, 400);
  await p.fechar();
});

test('fila: com uma aba só, dois pedidos rodam um depois do outro', async () => {
  const p = await iniciarPonte();
  let ativos = 0;
  let maximo = 0;
  const c = await conectarWS(p.ws, { origem: 'chrome-extension://teste' });
  c.on('mensagem', (t) => {
    const m = JSON.parse(t);
    if (m.tipo !== 'tarefa') return;
    ativos++;
    maximo = Math.max(maximo, ativos);
    setTimeout(() => {
      ativos--;
      c.enviar({ tipo: 'fim', id: m.id, texto: 'ok ' + m.prompt, aba: 1 });
    }, 60);
  });
  c.enviar({ tipo: 'ola', protocolo: 1, versao: 'teste', config: { maxAbas: 1 } });
  await once(p.ponte.gerente, 'pronta');
  const [a, b] = await Promise.all([
    pedir(p.base, { messages: [{ role: 'user', content: 'A' }] }).then((r) => r.json()),
    pedir(p.base, { messages: [{ role: 'user', content: 'B' }] }).then((r) => r.json()),
  ]);
  assert.equal(maximo, 1);
  assert.deepEqual([a.choices[0].message.content, b.choices[0].message.content].sort(), ['ok A', 'ok B']);
  c.fechar();
  await p.fechar();
});

test('fluxo do OpenCode: pedido de título em paralelo não atrapalha a continuação', async () => {
  const p = await iniciarPonte({ simular: true });
  const tools = [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
  const principal = [
    { role: 'system', content: 'Você é um agente.' },
    { role: 'user', content: 'Leia.\n/ferramenta read {"path": "a.txt"}' },
  ];
  const [r1] = await Promise.all([
    pedir(p.base, { stream: true, tools, messages: principal }),
    pedir(p.base, { stream: true, messages: [{ role: 'system', content: 'Gere um título.' }, { role: 'user', content: 'Leia.' }] }),
  ]);
  const j1 = juntarStream(await lerSSE(r1));
  assert.equal(j1.motivo, 'tool_calls');
  principal.push({ role: 'assistant', content: j1.conteudo, tool_calls: j1.chamadas.map((c) => ({ id: c.id, type: 'function', function: c.function })) });
  principal.push({ role: 'tool', tool_call_id: j1.chamadas[0].id, content: 'conteúdo de a.txt' });
  const j2 = juntarStream(await lerSSE(await pedir(p.base, { stream: true, tools, messages: principal })));
  assert.match(j2.conteudo, /conteúdo de a\.txt/);
  const ultima = p.ponte.executor.historico.at(-1);
  assert.equal(ultima.nova, false, 'o passo depois da ferramenta deve continuar a conversa do agente');
  await p.fechar();
});
