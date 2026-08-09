#Requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter()]
    [string]$ConfigPath = (Join-Path $PSScriptRoot 'install.json')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-FullPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    return [System.IO.Path]::GetFullPath($Path)
}

try {
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
        throw "Launchpad installation config is missing: $ConfigPath"
    }

    $config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding utf8 | ConvertFrom-Json
    if ($null -eq $config.root -or [string]::IsNullOrWhiteSpace([string]$config.root)) {
        throw 'Launchpad installation config does not contain a canonical root.'
    }

    $root = Get-FullPath -Path ([string]$config.root)
    $pathSegments = $root -split '[\\/]'
    if ($pathSegments -contains '.worktrees') {
        throw "Launchpad refuses to start from a temporary worktree: $root"
    }

    $rootMarker = Join-Path $root 'launchpad.gen3.json'
    $launcher = Join-Path $root 'Launchpad.ps1'
    if (-not (Test-Path -LiteralPath $rootMarker -PathType Leaf)) {
        throw "Configured Launchpad root is not valid: $root"
    }
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
        throw "Configured Launchpad launcher is missing: $launcher"
    }

    Set-Location -LiteralPath $root
    & $launcher
    exit $LASTEXITCODE
}
catch {
    Write-Host ''
    Write-Host 'Launchpad could not start from its canonical installation.' -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host 'Run Install-LaunchpadShortcut.ps1 again from the primary Conglomerate checkout.'
    exit 1
}
