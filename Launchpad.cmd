@echo off
chcp 65001 >nul
setlocal

cd /d "%~dp0"

set "BUN_EXE="
for /f "delims=" %%I in ('where bun 2^>nul') do (
  if not defined BUN_EXE (
    "%%~fI" --version >nul 2>nul
    if not errorlevel 1 set "BUN_EXE=%%~fI"
  )
)
if not defined BUN_EXE if exist "%USERPROFILE%\.bun\bin\bun.exe" (
  "%USERPROFILE%\.bun\bin\bun.exe" --version >nul 2>nul
  if not errorlevel 1 set "BUN_EXE=%USERPROFILE%\.bun\bin\bun.exe"
)
if not defined BUN_EXE if exist "%LOCALAPPDATA%\bun\bin\bun.exe" (
  "%LOCALAPPDATA%\bun\bin\bun.exe" --version >nul 2>nul
  if not errorlevel 1 set "BUN_EXE=%LOCALAPPDATA%\bun\bin\bun.exe"
)

if not defined BUN_EXE (
  echo Bun není nainstalovaný nebo není v PATH.
  echo Nainstaluj Bun a spusť Launchpad znovu.
  pause
  exit /b 1
)

"%BUN_EXE%" run launchpad
if errorlevel 1 pause
