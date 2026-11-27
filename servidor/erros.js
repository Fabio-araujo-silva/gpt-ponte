// Erros da ponte e como eles aparecem para o cliente (formato de erro da OpenAI).

const TABELA = {
  sem_extensao: { status: 503, tipo: 'server_error', mensagem: 'A extensão GPT Ponte não está conectada. Abra o Chrome com a extensão instalada e uma aba do chatgpt.com.' },
  extensao_desconectada: { status: 503, tipo: 'server_error', mensagem: 'A extensão desconectou no meio da resposta.' },
  sem_aba: { status: 503, tipo: 'server_error', mensagem: 'Não foi possível abrir uma aba do ChatGPT.' },
  pagina_mudou: { status: 502, tipo: 'server_error', mensagem: 'A página do ChatGPT mudou e a extensão não encontrou o campo de mensagem. Atualize a extensão.' },
  verificacao: { status: 503, tipo: 'server_error', mensagem: 'O ChatGPT pediu uma verificação. Abra a aba do ChatGPT e resolva manualmente.' },
  limite: { status: 429, tipo: 'rate_limit_error', mensagem: 'O ChatGPT avisou que você atingiu o limite de uso. Espere um pouco ou troque de modelo.' },
  mensagem_longa: { status: 400, tipo: 'invalid_request_error', mensagem: "This model's maximum context length was exceeded: a mensagem ficou grande demais para o ChatGPT.", codigo: 'context_length_exceeded' },
  conversa_indisponivel: { status: 409, tipo: 'server_error', mensagem: 'A conversa não está mais aberta no navegador.' },
  cancelado: { status: 499, tipo: 'server_error', mensagem: 'Pedido cancelado.' },
  tempo_esgotado: { status: 504, tipo: 'server_error', mensagem: 'O ChatGPT demorou demais para responder.' },
  sem_resposta: { status: 502, tipo: 'server_error', mensagem: 'O ChatGPT não respondeu (a resposta veio vazia).' },
  chatgpt: { status: 502, tipo: 'server_error', mensagem: 'O ChatGPT devolveu um erro.' },
  pedido_invalido: { status: 400, tipo: 'invalid_request_error', mensagem: 'Pedido inválido.' },
  nao_autorizado: { status: 401, tipo: 'invalid_request_error', mensagem: 'Chave de API inválida.', codigo: 'invalid_api_key' },
  origem_bloqueada: { status: 403, tipo: 'invalid_request_error', mensagem: 'Origem não permitida.' },
  nao_encontrado: { status: 404, tipo: 'invalid_request_error', mensagem: 'Rota não encontrada.' },
  interno: { status: 500, tipo: 'server_error', mensagem: 'Erro interno da ponte.' },
};

export class ErroDaPonte extends Error {
  constructor(codigo, mensagem, extra = {}) {
    const base = TABELA[codigo] ?? TABELA.interno;
    super(mensagem || base.mensagem);
    this.codigo = TABELA[codigo] ? codigo : 'interno';
    this.status = extra.status ?? base.status;
    this.tipo = base.tipo;
    this.codigoOpenAI = base.codigo ?? this.codigo;
    this.detalhe = extra.detalhe;
  }

  /** Corpo de erro no formato da OpenAI. */
  paraOpenAI() {
    return { error: { message: this.message, type: this.tipo, param: null, code: this.codigoOpenAI } };
  }
}

/** Converte qualquer coisa lançada num ErroDaPonte. */
export function comoErroDaPonte(e) {
  if (e instanceof ErroDaPonte) return e;
  return new ErroDaPonte('interno', e?.message ? `Erro interno da ponte: ${e.message}` : undefined);
}
