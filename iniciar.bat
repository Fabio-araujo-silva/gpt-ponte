@echo off
rem GPT Ponte: inicia a ponte local (de dois cliques neste arquivo).
chcp 65001 >nul
title GPT Ponte
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  O Node.js nao esta instalado.
  echo  Baixe a versao LTS em https://nodejs.org e rode este arquivo de novo.
  echo.
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAIOR=%%v
if %NODE_MAIOR% LSS 22 (
  echo.
  echo  O seu Node.js e a versao %NODE_MAIOR%, e a ponte precisa da 22 ou mais nova.
  echo  Atualize em https://nodejs.org e rode este arquivo de novo.
  echo.
  pause
  exit /b 1
)

node servidor\index.js %*
if errorlevel 1 pause
