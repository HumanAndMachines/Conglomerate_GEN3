$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$bunCandidates = @()
$bunCommands = Get-Command bun -All -CommandType Application -ErrorAction SilentlyContinue
foreach ($bunCommand in $bunCommands) {
  if ($bunCommand.Path) {
    $bunCandidates += $bunCommand.Path
  } elseif ($bunCommand.Source) {
    $bunCandidates += $bunCommand.Source
  }
}
if ($env:USERPROFILE) {
  $bunCandidates += Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
}
if ($env:LOCALAPPDATA) {
  $bunCandidates += Join-Path $env:LOCALAPPDATA "bun\bin\bun.exe"
}

$bunExecutable = $null
foreach ($candidate in ($bunCandidates | Where-Object { $_ } | Select-Object -Unique)) {
  try {
    & $candidate --version *> $null
    if ($LASTEXITCODE -eq 0) {
      $bunExecutable = $candidate
      break
    }
  } catch {
    # Nefunkční WindowsApps alias nesmí zastínit další validní instalaci.
  }
}

if (-not $bunExecutable) {
  Write-Host "Bun není nainstalovaný nebo není v PATH."
  Write-Host "Nainstaluj Bun a spusť Launchpad znovu."
  Read-Host "Stiskni Enter pro zavření"
  exit 1
}

& $bunExecutable run launchpad
