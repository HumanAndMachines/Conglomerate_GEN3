@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"

where bun >nul 2>nul
if errorlevel 1 (
  echo Bun není nainstalovaný nebo není v PATH.
  echo Nainstaluj Bun a spusť Launchpad znovu.
  pause
  exit /b 1
)

bun run launchpad
if errorlevel 1 pause
