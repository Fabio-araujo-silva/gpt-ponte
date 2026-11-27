import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { aceitarUpgrade, conectarWS, chaveDeAceite, OP } from '../servidor/websocket.js';

async function servidorEco(opcoes = {}) {
  const conexoes = [];
  const srv = http.createServer((_req, res) => res.end('ok'));
  srv.on('upgrade', (req, socket, cabeca) => {
    const c = aceitarUpgrade(req, socket, cabeca, opcoes);
    if (!c) return;
    conexoes.push(c);
    c.on('mensagem', (m) => c.enviar(m));
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const url = `ws://127.0.0.1:${srv.address().port}/ws`;
  return {
    url,
    conexoes,
    fechar: () =>
      new Promise((r) => {
        for (const c of conexoes) c.destruir();
        srv.close(r);
      }),
  };
}

function proxima(conexao) {
  return new Promise((resolve) => conexao.once('mensagem', resolve));
}

test('chave de aceite segue o exemplo da RFC 6455', () => {
  assert.equal(chaveDeAceite('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('eco de mensagens pequenas, médias, grandes e com acentos', async () => {
  const s = await servidorEco();
  const c = await conectarWS(s.url);
  for (const tam of [0, 1, 125, 126, 200, 65535, 65536, 300_000, 2_000_000]) {
    const texto = 'ação✓'.repeat(Math.ceil(tam / 5)).slice(0, tam);
    const volta = proxima(c);
    c.enviar(texto);
    assert.equal(await volta, texto, `tamanho ${tam}`);
  }
  c.fechar();
  await s.fechar();
});

test('objetos viram JSON', async () => {
  const s = await servidorEco();
  const c = await conectarWS(s.url);
  const volta = proxima(c);
  c.enviar({ tipo: 'ola', n: 1 });
  assert.deepEqual(JSON.parse(await volta), { tipo: 'ola', n: 1 });
  c.fechar();
  await s.fechar();
});

test('mensagem fragmentada com ping no meio', async () => {
  const s = await servidorEco();
  const c = await conectarWS(s.url);
  const volta = proxima(c);
  const pong = once(c, 'pong');
  c._enviarQuadro(OP.TEXTO, Buffer.from('olá, '), false);
  c._enviarQuadro(OP.PING, Buffer.from('p'));
  c._enviarQuadro(OP.CONT, Buffer.from('mundo'), false);
  c._enviarQuadro(OP.CONT, Buffer.from('!'), true);
  assert.equal(await volta, 'olá, mundo!');
  const [dados] = await pong;
  assert.equal(dados.toString(), 'p');
  c.fechar();
  await s.fechar();
});

test('muitas mensagens em sequência chegam inteiras e na ordem', async () => {
  const s = await servidorEco();
  const c = await conectarWS(s.url);
  const recebidas = [];
  const fim = new Promise((resolve) =>
    c.on('mensagem', (m) => {
      recebidas.push(m);
      if (recebidas.length === 500) resolve();
    }),
  );
  for (let i = 0; i < 500; i++) c.enviar(`m${i}:` + 'x'.repeat(i * 37));
  await fim;
  recebidas.forEach((m, i) => assert.ok(m.startsWith(`m${i}:`)));
  c.fechar();
  await s.fechar();
});

test('fechamento chega ao servidor com código e motivo', async () => {
  const s = await servidorEco();
  const c = await conectarWS(s.url);
  await new Promise((r) => setTimeout(r, 20));
  const fechou = once(s.conexoes[0], 'fechada');
  c.fechar(4000, 'tchau');
  const [codigo, motivo] = await fechou;
  assert.equal(codigo, 4000);
  assert.equal(motivo, 'tchau');
  assert.equal(c.aberta, false);
  await s.fechar();
});

test('origem não permitida é recusada com 403', async () => {
  const s = await servidorEco({ origemPermitida: (o) => o.startsWith('chrome-extension://') });
  await assert.rejects(conectarWS(s.url, { origem: 'https://site-malicioso.com' }), /HTTP 403/);
  await assert.rejects(conectarWS(s.url), /HTTP 403/);
  const c = await conectarWS(s.url, { origem: 'chrome-extension://abc' });
  const volta = proxima(c);
  c.enviar('oi');
  assert.equal(await volta, 'oi');
  c.fechar();
  await s.fechar();
});

test('mensagem acima do limite derruba a conexão com 1009', async () => {
  const s = await servidorEco({ maxMensagem: 1000 });
  const c = await conectarWS(s.url);
  const fechou = once(c, 'fechada');
  c.enviar('x'.repeat(5000));
  const [codigo] = await fechou;
  assert.equal(codigo, 1009);
  await s.fechar();
});
