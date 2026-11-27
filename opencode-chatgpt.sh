#!/usr/bin/env sh
# Abre o OpenCode usando SÓ o ChatGPT do navegador (GPT Ponte): modelo principal e títulos.
# A sua configuração normal do OpenCode não é tocada.
#
# Uso: na pasta do seu projeto, rode este script (pelo caminho completo ou pelo PATH).
# Opções do opencode passam direto, ex.:  opencode-chatgpt.sh --continue
PONTE="$(cd "$(dirname "$0")" && pwd)"

command -v node >/dev/null 2>&1 || { echo "O Node.js não está instalado: https://nodejs.org"; exit 1; }
command -v opencode >/dev/null 2>&1 || { echo "O OpenCode não está instalado: https://opencode.ai"; exit 1; }

# 1. A ponte está rodando? Se não, sobe em segundo plano (log em ponte.log).
if ! node "$PONTE/servidor/index.js" saude >/dev/null 2>&1; then
  echo "Iniciando a GPT Ponte em segundo plano (log em $PONTE/ponte.log)..."
  nohup node "$PONTE/servidor/index.js" >"$PONTE/ponte.log" 2>&1 &
  node "$PONTE/servidor/index.js" saude --esperar 20 || { echo "A ponte não respondeu. Veja $PONTE/ponte.log"; exit 1; }
else
  node "$PONTE/servidor/index.js" saude
fi

# 2. Perfil do OpenCode só com o ChatGPT (criado na primeira vez).
[ -f "$PONTE/perfil-opencode/opencode/opencode.jsonc" ] || node "$PONTE/servidor/index.js" opencode --perfil >/dev/null

# 3. OpenCode com um servidor próprio que lê só esse perfil.
XDG_CONFIG_HOME="$PONTE/perfil-opencode" exec opencode --standalone "$@"
