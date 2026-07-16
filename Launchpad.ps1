$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Write-Host "Bun není nainstalovaný nebo není v PATH."
  Write-Host "Nainstaluj Bun a spusť Launchpad znovu."
  Read-Host "Stiskni Enter pro zavření"
  exit 1
}

bun run launchpad
