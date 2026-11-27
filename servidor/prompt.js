// Converte o pedido no formato da OpenAI (messages + tools) no texto que vai para o
// ChatGPT, e calcula as chaves que permitem continuar uma conversa já aberta no navegador
// em vez de reenviar o histórico inteiro a cada passo do agente.

import { createHash } from 'node:crypto';
import { instrucoesDeFerramentas, lembreteDeFerramentas, formatarResultado } from './ferramentas.js';

/** Contexto que, se mudar, obriga a abrir outra conversa (modelo e definição das ferramentas). */
export function contextoDoPedido(modelo, tools) {
  return createHash('sha256')
    .update(String(modelo || ''))
    .update('|')
    .update(JSON.stringify(tools ?? []))
    .digest('hex');
}
import { tentarJson } from './json-tolerante.js';

/** Texto de um campo `content` da OpenAI (string ou lista de partes). */
export function textoDoConteudo(conteudo) {
  if (conteudo == null) return '';
  if (typeof conteudo === 'string') return conteudo;
  if (!Array.isArray(conteudo)) return typeof conteudo === 'object' ? textoDoConteudo(conteudo.text ?? '') : String(conteudo);
  const partes = [];
  for (const p of conteudo) {
    if (typeof p === 'string') partes.push(p);
    else if (!p || typeof p !== 'object') continue;
    else if (p.type === 'text' || p.type === 'input_text' || p.type === 'output_text') partes.push(p.text ?? '');
    else if (p.type === 'image_url' || p.type === 'input_image') partes.push('[imagem omitida: a ponte ainda não envia imagens]');
    else if (p.type === 'input_audio') partes.push('[áudio omitido]');
    else if (p.type === 'file' || p.type === 'input_file') partes.push(`[arquivo omitido${p.file?.filename ? ': ' + p.file.filename : ''}]`);
    else if (p.type === 'refusal') partes.push(p.refusal ?? '');
    else if (typeof p.text === 'string') partes.push(p.text);
  }
  return partes.join('\n');
}

/**
 * Normaliza as mensagens num formato estável:
 *   {papel: 'sistema'|'usuario'|'assistente'|'ferramenta', texto, chamadas?, idChamada?, nome?}
 * O mesmo histórico sempre gera a mesma lista, o que permite comparar pedidos.
 */
export function normalizarMensagens(messages) {
  if (!Array.isArray(messages)) throw new Error('"messages" precisa ser uma lista');
  const nomesPorId = new Map();
  const saida = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const papel = m.role;
    if (papel === 'system' || papel === 'developer') {
      saida.push({ papel: 'sistema', texto: textoDoConteudo(m.content).trim() });
    } else if (papel === 'user') {
      saida.push({ papel: 'usuario', texto: textoDoConteudo(m.content).trim() });
    } else if (papel === 'assistant') {
      const chamadas = [];
      for (const c of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        const nome = c?.function?.name ?? c?.name ?? '';
        const bruto = c?.function?.arguments ?? c?.arguments ?? '{}';
        const args = typeof bruto === 'string' ? (tentarJson(bruto) ?? bruto) : bruto;
        chamadas.push({ id: c?.id ?? '', nome, argumentos: args });
        if (c?.id) nomesPorId.set(c.id, nome);
      }
      if (m.function_call) chamadas.push({ id: '', nome: m.function_call.name, argumentos: tentarJson(m.function_call.arguments) ?? {} });
      saida.push({ papel: 'assistente', texto: textoDoConteudo(m.content).trim(), chamadas });
    } else if (papel === 'tool' || papel === 'function') {
      const id = m.tool_call_id ?? '';
      saida.push({ papel: 'ferramenta', texto: textoDoConteudo(m.content), idChamada: id, nome: m.name ?? nomesPorId.get(id) ?? '' });
    }
  }
  return saida;
}

/** Forma canônica de uma mensagem para comparação (ignora ids e formatação do JSON). */
function canonica(m) {
  if (m.papel === 'assistente') {
    // Espaços colapsados: clientes às vezes reformatam o texto que devolvemos.
    return ['a', m.texto.replace(/\s+/g, ' ').trim(), m.chamadas.map((c) => [c.nome, ordenar(c.argumentos)])];
  }
  if (m.papel === 'ferramenta') return ['f', m.nome, m.texto];
  return [m.papel[0], m.texto];
}

function ordenar(v) {
  if (Array.isArray(v)) return v.map(ordenar);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = ordenar(v[k]);
    return o;
  }
  return v;
}

/**
 * Chaves de todos os prefixos do histórico: chaves[k] identifica mensagens[0..k].
 * Usa um hash encadeado, então calcular todas custa o mesmo que calcular a última.
 */
export function chavesDosPrefixos(mensagens, contexto = '') {
  const chaves = [];
  let h = createHash('sha256').update('gpt-ponte/1|' + contexto).digest('hex');
  for (const m of mensagens) {
    h = createHash('sha256').update(h).update(JSON.stringify(canonica(m))).digest('hex');
    chaves.push(h);
  }
  return chaves;
}

function blocoMensagem(m) {
  if (m.papel === 'usuario') return `<message role="user">\n${m.texto}\n</message>`;
  if (m.papel === 'assistente') {
    const partes = [];
    if (m.texto) partes.push(m.texto);
    for (const c of m.chamadas) {
      partes.push(`<tool_call>\n${JSON.stringify({ name: c.nome, arguments: c.argumentos })}\n</tool_call>`);
    }
    return `<message role="assistant">\n${partes.join('\n')}\n</message>`;
  }
  if (m.papel === 'ferramenta') return formatarResultado({ nome: m.nome, id: m.idChamada, conteudo: m.texto });
  return `<message role="system">\n${m.texto}\n</message>`;
}

function instrucaoDeFormato(formato) {
  if (!formato || typeof formato !== 'object') return '';
  if (formato.type === 'json_object') return 'Reply with a single valid JSON object and nothing else (no prose, no code fences).';
  if (formato.type === 'json_schema') {
    const schema = formato.json_schema?.schema ?? formato.schema ?? {};
    return `Reply with a single valid JSON value that matches this JSON Schema, and nothing else (no prose, no code fences):\n${JSON.stringify(schema)}`;
  }
  return '';
}

/**
 * Prompt completo para abrir uma conversa nova no ChatGPT.
 * Um pedido simples (uma mensagem de usuário, sem sistema e sem ferramentas) vai como está.
 */
export function montarPromptInicial(mensagens, { ferramentas = [], toolChoice, paralelas = true, formato } = {}) {
  const sistemas = mensagens.filter((m) => m.papel === 'sistema' && m.texto);
  const conversa = mensagens.filter((m) => m.papel !== 'sistema');
  const usarFerramentas = ferramentas.length > 0 && toolChoice !== 'none';
  const instrucaoFormato = instrucaoDeFormato(formato);

  if (!sistemas.length && !usarFerramentas && !instrucaoFormato && conversa.length === 1 && conversa[0].papel === 'usuario') {
    return conversa[0].texto;
  }

  // O "contrato": texto fixo que abre toda conversa nova. Com ferramentas, ele deixa claro que
  // o modelo opera o computador por elas (e que a personalização da conta não vale aqui).
  const partes = [
    usarFerramentas
      ? [
          "I'm using you through an agent app on my computer (OpenCode or a similar client). Each message I send contains what the app needs you to see: your instructions, the tools you can use and the conversation so far. Please follow these rules in this chat:",
          '- Treat the text in <system_instructions> as your system prompt. Ignore my ChatGPT personalization here (custom instructions, memories and other chats).',
          '- You work through the tools below: when you write a request block, the app runs it on my computer and sends you the result. So you really can read and change files and run commands. Do the work yourself instead of telling me what to run.',
          "- Write only the next assistant reply each time, and don't mention this setup.",
        ].join('\n')
      : "I'm using you through an app (an API client) that sends you the whole request in this message: instructions and the conversation so far. Treat the text in <system_instructions> as your system prompt, ignore my ChatGPT personalization here (custom instructions, memories and other chats), and write ONLY the next assistant reply. Don't mention this setup.",
  ];
  if (sistemas.length) {
    partes.push('<system_instructions>\n' + sistemas.map((m) => m.texto).join('\n\n') + '\n</system_instructions>');
  }
  if (usarFerramentas) partes.push('<tools>\n' + instrucoesDeFerramentas(ferramentas, { toolChoice, paralelas }) + '\n</tools>');
  if (instrucaoFormato) partes.push(instrucaoFormato);

  const lembrete = usarFerramentas ? ' If you need a tool, write the request block (the block alone is enough).' : '';
  if (conversa.length === 1 && conversa[0].papel === 'usuario') {
    partes.push('<user_message>\n' + conversa[0].texto + '\n</user_message>');
    partes.push('Now reply to the user message as the assistant.' + lembrete);
  } else if (conversa.length) {
    partes.push('<conversation>\n' + conversa.map(blocoMensagem).join('\n\n') + '\n</conversation>');
    partes.push('Now write the next assistant reply.' + lembrete);
  } else {
    partes.push('There are no messages yet; reply following the system instructions.');
  }
  return partes.join('\n\n');
}

/**
 * Texto para continuar uma conversa que já está aberta no navegador:
 * só o que é novo (resultados de ferramentas e/ou nova mensagem do usuário).
 * Devolve null se o trecho novo não puder ser enviado como continuação.
 */
export function montarContinuacao(novas, { ferramentas = [], toolChoice, paralelas = true, formato } = {}) {
  if (!novas.length || novas.some((m) => m.papel === 'assistente' || m.papel === 'sistema')) return null;
  const resultados = novas.filter((m) => m.papel === 'ferramenta');
  const usuarios = novas.filter((m) => m.papel === 'usuario');
  const partes = [];
  if (resultados.length) partes.push(resultados.map(blocoMensagem).join('\n\n'));
  if (usuarios.length) {
    const texto = usuarios.map((m) => m.texto).join('\n\n');
    partes.push(resultados.length ? 'The user says:\n\n' + texto : texto);
  }
  const usarFerramentas = ferramentas.length > 0 && toolChoice !== 'none';
  if (usarFerramentas) {
    // As ferramentas já foram descritas na primeira mensagem; aqui vai só um lembrete curto.
    if (toolChoice === 'required') partes.push('(In this reply you MUST call at least one tool.)');
    else if (toolChoice?.function?.name) partes.push(`(In this reply you MUST call the tool "${toolChoice.function.name}".)`);
    else partes.push(lembreteDeFerramentas(ferramentas.map((f) => f.nome)));
    if (!paralelas) partes.push('(Call at most ONE tool per reply.)');
  } else if (ferramentas.length && toolChoice === 'none') {
    partes.push('(Do not call any tool in this reply.)');
  }
  const instrucaoFormato = instrucaoDeFormato(formato);
  if (instrucaoFormato) partes.push(instrucaoFormato);
  return partes.join('\n\n');
}

/** Representa a resposta da ponte como mensagem normalizada (para a próxima comparação). */
export function mensagemDaResposta(conteudo, chamadas) {
  return {
    papel: 'assistente',
    texto: (conteudo || '').trim(),
    chamadas: chamadas.map((c) => ({ id: c.id, nome: c.nome, argumentos: tentarJson(c.argumentos) ?? c.argumentos })),
  };
}

/** Estimativa de tokens (~4 caracteres por token em média para texto e código). */
export function estimarTokens(texto) {
  if (!texto) return 0;
  return Math.max(1, Math.ceil(texto.length / 4));
}
