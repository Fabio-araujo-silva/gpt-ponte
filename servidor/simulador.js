// "Navegador de mentira" para o modo --simular e para os testes: responde na hora, sem
// ChatGPT, imitando o que a extensão faria (inclusive abas e conversas).
//
// Para testar ferramentas, escreva na mensagem:  /ferramenta NOME {"arg": "valor"}

import { ErroDaPonte } from './erros.js';

export class Simulador {
  constructor({ atrasoMs = 15, maxAbas = 2 } = {}) {
    this.atrasoMs = atrasoMs;
    this.maxAbas = maxAbas;
    this.conversas = new Map(); // aba -> {id, turnos}
    this.proximaAba = 1;
    this.proximaConversa = 1;
    this.historico = []; // tarefas recebidas (para os testes conferirem)
  }

  estado() {
    return {
      conectada: true,
      simulado: true,
      extensao: { versao: 'simulador', navegador: 'simulador' },
      abas: [...this.conversas.entries()].map(([id, c]) => ({ id, estado: 'pronta', conversaId: c.id })),
      modelos: [{ id: 'chatgpt' }],
      emAndamento: 0,
      naFila: 0,
      capacidade: this.maxAbas,
    };
  }

  async executar(tarefa, { aoEvento = () => {}, sinal } = {}) {
    this.historico.push(tarefa);
    let aba;
    if (tarefa.nova) {
      aba = this.conversas.size < this.maxAbas ? this.proximaAba++ : [...this.conversas.keys()][0];
      this.conversas.set(aba, { id: `sim-${this.proximaConversa++}`, turnos: 0 });
    } else {
      aba = tarefa.continuar?.aba;
      const c = this.conversas.get(aba);
      if (!c || (tarefa.continuar?.conversaId && c.id !== tarefa.continuar.conversaId)) {
        throw new ErroDaPonte('conversa_indisponivel');
      }
    }
    const conversa = this.conversas.get(aba);
    conversa.turnos++;
    aoEvento({ tipo: 'inicio', aba, conversaId: conversa.id });

    const resposta = this.responder(tarefa.prompt, conversa);
    const pedacos = resposta.match(/[\s\S]{1,7}/g) ?? [];
    for (const p of pedacos) {
      if (sinal?.aborted) throw new ErroDaPonte('cancelado');
      if (this.atrasoMs) await new Promise((r) => setTimeout(r, this.atrasoMs));
      aoEvento({ tipo: 'texto', texto: p });
    }
    if (sinal?.aborted) throw new ErroDaPonte('cancelado');
    return { texto: resposta, raciocinio: '', aba, conversaId: conversa.id, modelo: 'simulador' };
  }

  responder(promptCompleto, conversa) {
    // As instruções de ferramentas têm um exemplo de <tool_result>: olha só o que vem fora delas.
    const prompt = promptCompleto.replace(/<tools>[\s\S]*?<\/tools>/, '');
    const pedido = /\/ferramenta\s+([\w.-]+)\s*(\{[\s\S]*?\})?\s*$/m.exec(prompt);
    if (pedido && !/<tool_result\s/.test(prompt)) {
      return `Vou usar a ferramenta ${pedido[1]}.\n<tool_call>\n{"name": "${pedido[1]}", "arguments": ${pedido[2] || '{}'}}\n</tool_call>`;
    }
    const resultado = /<tool_result\s[^>]*>\n?([\s\S]*?)\n?<\/tool_result>/.exec(prompt);
    if (resultado) return `A ferramenta respondeu: ${resultado[1].trim().slice(0, 200)}`;
    const ultima = prompt.trim().split('\n').filter(Boolean).at(-1) ?? '';
    return `Simulação (turno ${conversa.turnos} da conversa ${conversa.id}): recebi ${prompt.length} caracteres. Última linha: ${ultima.slice(0, 200)}`;
  }
}
