#Requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter()]
    [string]$ConfigPath = (Join-Path $PSScriptRoot 'install.json')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

try {
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
        throw "Launchpad installation config is missing: $ConfigPath"
    }

    $config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding utf8 | ConvertFrom-Json
    if ([string]$config.schema_version -ne 'lazurio.launchpad.windows_install.v1') {
        throw 'Launchpad installation config has an unsupported schema.'
    }
    if ($null -eq $config.root -or [string]::IsNullOrWhiteSpace([string]$config.root)) {
        throw 'Launchpad installation config does not contain a canonical root.'
    }

    $root = [System.IO.Path]::GetFullPath([string]$config.root)
    $launcher = Join-Path $root 'Launchpad.ps1'
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
        throw "Configured Launchpad root is not available: $root"
    }

    Push-Location -LiteralPath $root
    try {
        # The canonical launcher owns its own language-mode contract. The
        # bootstrap must behave like direct Launchpad.ps1 invocation.
        Set-StrictMode -Off
        & $launcher
        $launchpadExitCode = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
    exit $launchpadExitCode
}
catch {
    Write-Host ''
    Write-Host 'Launchpad se nepodařilo spustit z uživatelské instalace.' -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host 'V primárním Lazurio checkoutu spusť znovu: bun run install:windows-shortcut'
    Read-Host 'Stiskni Enter pro zavření'
    exit 1
}
