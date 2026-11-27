#!/usr/bin/env sh
# GPT Ponte: inicia a ponte local.  Uso: ./iniciar.sh [opções]
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "O Node.js não está instalado. Baixe a versão LTS em https://nodejs.org"
  exit 1
fi

maior=$(node -p "process.versions.node.split('.')[0]")
if [ "$maior" -lt 22 ]; then
  echo "O seu Node.js é a versão $maior, e a ponte precisa da 22 ou mais nova (https://nodejs.org)."
  exit 1
fi

exec node servidor/index.js "$@"
