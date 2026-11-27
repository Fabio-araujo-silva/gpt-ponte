// Histórico curto dos últimos pedidos (só metadados, nunca o conteúdo), para o painel.

export class RegistroDePedidos {
  constructor(max = 100) {
    this.max = max;
    this.itens = [];
    this.totais = { pedidos: 0, ok: 0, erros: 0 };
  }

  novo(dados) {
    const entrada = { ...dados, quando: new Date().toISOString(), status: 'andamento' };
    this.itens.unshift(entrada);
    if (this.itens.length > this.max) this.itens.length = this.max;
    this.totais.pedidos++;
    return entrada;
  }

  concluir(entrada, dados) {
    if (!entrada) return;
    Object.assign(entrada, dados);
    if (dados.status === 'ok') this.totais.ok++;
    else this.totais.erros++;
  }

  lista(n = 50) {
    return this.itens.slice(0, n);
  }
}
