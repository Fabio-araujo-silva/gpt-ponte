// Gera (e opcionalmente grava) a configuração do OpenCode para usar a ponte.
// Suporta o formato do OpenCode 2 ("providers") e do OpenCode 1 ("provider").

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

export const ID_PROVEDOR = 'gpt-ponte';

export function blocoV2({ baseURL, chave, contexto = 64000 }) {
  return {
    name: 'ChatGPT (navegador, via GPT Ponte)',
    package: '@opencode/ai/providers/openai-compatible',
    settings: {
      baseURL,
      apiKey: chave || 'gpt-ponte',
      // o ChatGPT pode pensar por minutos antes da primeira palavra
      headerTimeout: 1800000,
      chunkTimeout: 900000,
    },
    compatibility: { reasoningField: 'reasoning_content', maxTokensField: 'max_tokens' },
    models: {
      chatgpt: {
        modelID: 'chatgpt',
        name: 'ChatGPT (navegador)',
        capabilities: { tools: true, input: ['text'], output: ['text'], temperature: false, reasoning: { supported: false } },
        limit: { context: contexto, output: 32000 },
        cost: { input: 0, output: 0 },
      },
    },
  };
}

export function blocoV1({ baseURL, chave, contexto = 64000 }) {
  return {
    npm: '@ai-sdk/openai-compatible',
    name: 'ChatGPT (navegador, via GPT Ponte)',
    options: { baseURL, apiKey: chave || 'gpt-ponte', timeout: false },
    models: {
      chatgpt: { name: 'ChatGPT (navegador)', tool_call: true, limit: { context: contexto, output: 32000 } },
    },
  };
}

/** Versão principal do OpenCode instalado (ou null). */
export function versaoDoOpenCode() {
  try {
    const saida = execSync('opencode --version', { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(saida);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

export function pastaDoOpenCode() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'opencode');
}

/** Acha o arquivo de configuração global do OpenCode (ou o caminho onde ele deveria ficar). */
export function arquivoDoOpenCode() {
  const pasta = pastaDoOpenCode();
  for (const nome of ['opencode.jsonc', 'opencode.json']) {
    const p = path.join(pasta, nome);
    if (fs.existsSync(p)) return p;
  }
  return path.join(pasta, 'opencode.json');
}

/** Remove comentários e vírgulas sobrando de um JSONC (respeitando strings). */
export function jsoncParaJson(texto) {
  let saida = '';
  let i = 0;
  while (i < texto.length) {
    const c = texto[i];
    if (c === '"') {
      let j = i + 1;
      while (j < texto.length && texto[j] !== '"') j += texto[j] === '\\' ? 2 : 1;
      saida += texto.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && texto[i + 1] === '/') {
      while (i < texto.length && texto[i] !== '\n') i++;
    } else if (c === '/' && texto[i + 1] === '*') {
      const fim = texto.indexOf('*/', i + 2);
      i = fim < 0 ? texto.length : fim + 2;
    } else {
      saida += c;
      i++;
    }
  }
  return saida.replace(/,(\s*[}\]])/g, '$1');
}

/** Índice do fecha-chaves que corresponde ao abre-chaves em `inicio` (ignora strings e comentários). */
function fechaChaves(texto, inicio) {
  let nivel = 0;
  for (let i = inicio; i < texto.length; i++) {
    const c = texto[i];
    if (c === '"') {
      i++;
      while (i < texto.length && texto[i] !== '"') i += texto[i] === '\\' ? 2 : 1;
    } else if (c === '/' && texto[i + 1] === '/') {
      while (i < texto.length && texto[i] !== '\n') i++;
    } else if (c === '/' && texto[i + 1] === '*') {
      const fim = texto.indexOf('*/', i + 2);
      i = fim < 0 ? texto.length : fim + 1;
    } else if (c === '{') nivel++;
    else if (c === '}') {
      nivel--;
      if (nivel === 0) return i;
    }
  }
  return -1;
}

function indentar(json, espacos) {
  return json.replace(/\n/g, '\n' + ' '.repeat(espacos));
}

/**
 * Insere (ou substitui) o provedor no texto da configuração, preservando comentários.
 * @returns {{texto: string, acao: 'inserido' | 'substituido' | 'criado'}}
 */
export function inserirProvedor(textoOriginal, { v2, bloco }) {
  const chaveRaiz = v2 ? 'providers' : 'provider';
  const texto = textoOriginal.trim() ? textoOriginal : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  const blocoJson = JSON.stringify(bloco, null, 2);

  // Já existe: substitui o objeto inteiro.
  const existente = new RegExp(`"${ID_PROVEDOR}"\\s*:\\s*\\{`).exec(texto);
  if (existente) {
    const abre = existente.index + existente[0].length - 1;
    const fecha = fechaChaves(texto, abre);
    if (fecha < 0) throw new Error('Não consegui entender o arquivo de configuração (chaves desbalanceadas).');
    const linha = texto.lastIndexOf('\n', existente.index);
    const recuo = existente.index - linha - 1;
    const novo = texto.slice(0, existente.index) + `"${ID_PROVEDOR}": ` + indentar(blocoJson, recuo) + texto.slice(fecha + 1);
    return { texto: novo, acao: 'substituido' };
  }

  const raiz = new RegExp(`"${chaveRaiz}"\\s*:\\s*\\{`).exec(texto);
  if (raiz) {
    const abre = raiz.index + raiz[0].length - 1;
    const linha = texto.lastIndexOf('\n', raiz.index);
    const recuo = raiz.index - linha - 1 + 2;
    const fecha = fechaChaves(texto, abre);
    const vazio = fecha >= 0 && jsoncParaJson(texto.slice(abre + 1, fecha)).trim() === '';
    const inserir = `\n${' '.repeat(recuo)}"${ID_PROVEDOR}": ${indentar(blocoJson, recuo)}${vazio ? '' : ','}`;
    return { texto: texto.slice(0, abre + 1) + inserir + texto.slice(abre + 1), acao: 'inserido' };
  }

  const inicio = texto.indexOf('{');
  if (inicio < 0) throw new Error('O arquivo de configuração não parece ser um objeto JSON.');
  const fecha = fechaChaves(texto, inicio);
  const vazio = fecha >= 0 && jsoncParaJson(texto.slice(inicio + 1, fecha)).trim() === '';
  const inserir = `\n  "${chaveRaiz}": {\n    "${ID_PROVEDOR}": ${indentar(blocoJson, 4)}\n  }${vazio ? '' : ','}`;
  return { texto: texto.slice(0, inicio + 1) + inserir + texto.slice(inicio + 1), acao: textoOriginal.trim() ? 'inserido' : 'criado' };
}

/**
 * Cria um perfil separado do OpenCode (uma pasta de configuração própria) em que tudo usa a
 * ponte: modelo principal, títulos e resumos. É lido quando o OpenCode roda com
 * XDG_CONFIG_HOME apontando para `pasta` (o opencode-chatgpt.bat/.sh faz isso), sem tocar na
 * configuração normal da pessoa.
 */
export function criarPerfil({ baseURL, chave, contexto, pasta }) {
  const arquivo = path.join(pasta, 'opencode', 'opencode.jsonc');
  const modelo = `${ID_PROVEDOR}/chatgpt`;
  const conteudo = {
    $schema: 'https://opencode.ai/config.json',
    model: modelo,
    small_model: modelo,
    providers: { [ID_PROVEDOR]: blocoV2({ baseURL, chave, contexto }) },
  };
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  fs.writeFileSync(
    arquivo,
    '// Perfil do OpenCode que usa SÓ o ChatGPT do navegador (GPT Ponte): modelo principal e títulos.\n' +
      '// Gerado por: node servidor/index.js opencode --perfil  (pode editar à vontade)\n' +
      JSON.stringify(conteudo, null, 2) +
      '\n',
  );
  return arquivo;
}

/** Grava a configuração com backup. Devolve o que foi feito. */
export function instalarNoOpenCode({ baseURL, chave, contexto, arquivo = arquivoDoOpenCode(), versao = versaoDoOpenCode() }) {
  const original = fs.existsSync(arquivo) ? fs.readFileSync(arquivo, 'utf8') : '';
  const v2 = original.includes('"providers"') || (!original.includes('"provider"') && (versao ?? 2) >= 2);
  const bloco = v2 ? blocoV2({ baseURL, chave, contexto }) : blocoV1({ baseURL, chave, contexto });
  const { texto, acao } = inserirProvedor(original, { v2, bloco });
  // Confere se o resultado continua sendo uma configuração válida antes de gravar.
  const lido = JSON.parse(jsoncParaJson(texto));
  const raiz = v2 ? lido.providers : lido.provider;
  if (!raiz?.[ID_PROVEDOR]) throw new Error('A configuração gerada ficou inválida; nada foi gravado.');
  let backup = null;
  if (original) {
    backup = `${arquivo}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(arquivo, backup);
  } else {
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  }
  fs.writeFileSync(arquivo, texto);
  return { arquivo, backup, acao, v2, modelo: `${ID_PROVEDOR}/chatgpt` };
}
