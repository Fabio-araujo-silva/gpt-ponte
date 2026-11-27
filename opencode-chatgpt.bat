@echo off
rem Abre o OpenCode usando SO o ChatGPT do navegador (GPT Ponte): modelo principal e titulos.
rem A sua configuracao normal do OpenCode nao e tocada.
rem
rem Uso: na pasta do seu projeto, rode este arquivo (pelo caminho completo ou pelo PATH).
rem Opcoes do opencode passam direto, ex.:  opencode-chatgpt.bat --continue
setlocal
chcp 65001 >nul
set "PONTE=%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo O Node.js nao esta instalado: https://nodejs.org
  exit /b 1
)
where opencode >nul 2>nul
if errorlevel 1 (
  echo O OpenCode nao esta instalado: https://opencode.ai
  exit /b 1
)

rem 1. A ponte esta rodando? Se nao, abre numa janela propria (minimizada).
node "%PONTE%servidor\index.js" saude >nul 2>nul
if errorlevel 1 (
  echo Iniciando a GPT Ponte numa janela separada...
  start "GPT Ponte" /min "%PONTE%iniciar.bat"
  node "%PONTE%servidor\index.js" saude --esperar 20
  if errorlevel 1 (
    echo A ponte nao respondeu. Abra o iniciar.bat para ver o erro.
    exit /b 1
  )
) else (
  node "%PONTE%servidor\index.js" saude
)

rem 2. Perfil do OpenCode so com o ChatGPT (criado na primeira vez).
if not exist "%PONTE%perfil-opencode\opencode\opencode.jsonc" (
  node "%PONTE%servidor\index.js" opencode --perfil >nul
)

rem 3. OpenCode com um servidor proprio que le so esse perfil.
set "XDG_CONFIG_HOME=%PONTE%perfil-opencode"
opencode --standalone %*
