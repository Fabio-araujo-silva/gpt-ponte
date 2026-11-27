import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inserirProvedor, jsoncParaJson, blocoV2, blocoV1, instalarNoOpenCode } from '../servidor/opencode.js';

const BASE = { baseURL: 'http://127.0.0.1:4545/v1' };

const CONFIG_V2 = `{
  "$schema": "https://opencode.ai/config.json",

  // comentário que precisa sobreviver
  "model": "qwen-modal/flash-next",
  "providers": {
    "qwen-modal": {
      "name": "Qwen", // outro comentário
      "settings": { "baseURL": "https://exemplo/v1" }
    }
  }
}
`;

test('jsonc vira json (comentários, vírgulas sobrando, "//" dentro de string)', () => {
  const t = '{\n // c\n "a": "http://x", /* b */ "b": [1,2,],\n}';
  assert.deepEqual(JSON.parse(jsoncParaJson(t)), { a: 'http://x', b: [1, 2] });
});

test('insere o provedor no OpenCode 2 sem perder comentários nem o que já existe', () => {
  const { texto, acao } = inserirProvedor(CONFIG_V2, { v2: true, bloco: blocoV2(BASE) });
  assert.equal(acao, 'inserido');
  assert.match(texto, /\/\/ comentário que precisa sobreviver/);
  assert.match(texto, /"name": "Qwen", \/\/ outro comentário/);
  const lido = JSON.parse(jsoncParaJson(texto));
  assert.equal(lido.model, 'qwen-modal/flash-next');
  assert.ok(lido.providers['qwen-modal']);
  assert.equal(lido.providers['gpt-ponte'].settings.baseURL, BASE.baseURL);
  assert.equal(lido.providers['gpt-ponte'].models.chatgpt.capabilities.tools, true);
});

test('rodar de novo substitui o bloco em vez de duplicar', () => {
  const primeira = inserirProvedor(CONFIG_V2, { v2: true, bloco: blocoV2(BASE) }).texto;
  const segunda = inserirProvedor(primeira, { v2: true, bloco: blocoV2({ baseURL: 'http://127.0.0.1:9999/v1' }) });
  assert.equal(segunda.acao, 'substituido');
  assert.equal(segunda.texto.match(/"gpt-ponte"\s*:/g).length, 1);
  const lido = JSON.parse(jsoncParaJson(segunda.texto));
  assert.equal(lido.providers['gpt-ponte'].settings.baseURL, 'http://127.0.0.1:9999/v1');
  assert.ok(lido.providers['qwen-modal']);
});

test('cria "providers" quando não existe e cria o arquivo quando está vazio', () => {
  const r = inserirProvedor('{\n  "model": "x/y"\n}\n', { v2: true, bloco: blocoV2(BASE) });
  assert.equal(JSON.parse(jsoncParaJson(r.texto)).providers['gpt-ponte'].package, '@opencode/ai/providers/openai-compatible');
  const vazio = inserirProvedor('', { v2: true, bloco: blocoV2(BASE) });
  assert.equal(vazio.acao, 'criado');
  assert.ok(JSON.parse(jsoncParaJson(vazio.texto)).providers['gpt-ponte']);
  const providersVazio = inserirProvedor('{ "providers": {} }', { v2: true, bloco: blocoV2(BASE) });
  assert.ok(JSON.parse(jsoncParaJson(providersVazio.texto)).providers['gpt-ponte']);
});

test('formato do OpenCode 1 usa "provider" e o pacote da AI SDK', () => {
  const r = inserirProvedor('{\n  "provider": {}\n}', { v2: false, bloco: blocoV1(BASE) });
  const lido = JSON.parse(jsoncParaJson(r.texto));
  assert.equal(lido.provider['gpt-ponte'].npm, '@ai-sdk/openai-compatible');
  assert.equal(lido.provider['gpt-ponte'].options.baseURL, BASE.baseURL);
});

test('instalar grava com backup e o resultado é válido', () => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-ponte-'));
  const arquivo = path.join(pasta, 'opencode.jsonc');
  fs.writeFileSync(arquivo, CONFIG_V2);
  const r = instalarNoOpenCode({ ...BASE, arquivo, versao: 2 });
  assert.ok(r.backup && fs.existsSync(r.backup));
  assert.equal(fs.readFileSync(r.backup, 'utf8'), CONFIG_V2);
  const lido = JSON.parse(jsoncParaJson(fs.readFileSync(arquivo, 'utf8')));
  assert.ok(lido.providers['gpt-ponte']);
  assert.equal(r.modelo, 'gpt-ponte/chatgpt');
  fs.rmSync(pasta, { recursive: true, force: true });
});
