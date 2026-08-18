#Requires -Version 5.1

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter()]
    [string]$RootPath = $PSScriptRoot,

    [Parameter()]
    [string]$StartMenuRoot,

    [Parameter()]
    [string]$TaskbarRoot,

    [Parameter()]
    [string]$InstallRoot,

    [Parameter()]
    [switch]$StartMenuOnly,

    [Parameter()]
    [switch]$SkipShellPin,

    [Parameter()]
    [datetime]$BackupTime = (Get-Date)
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$installSchema = 'lazurio.launchpad.windows_install.v1'

function Get-FullPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    return [System.IO.Path]::GetFullPath($Path)
}

function Get-Sha256Digest {
    param([Parameter(Mandatory = $true)][string]$Path)

    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        try {
            return [Convert]::ToBase64String($sha256.ComputeHash($stream))
        }
        finally {
            $sha256.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
}

function Test-PathContainsReparsePoint {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = Get-FullPath -Path $Path
    $pathRoot = [System.IO.Path]::GetPathRoot($fullPath)
    if ([string]::IsNullOrWhiteSpace($pathRoot)) {
        throw "Launchpad cannot determine the configured root path: $fullPath"
    }
    $relativePath = $fullPath.Substring($pathRoot.Length).TrimStart([char[]]'\/')
    $currentPath = $pathRoot
    foreach ($segment in ($relativePath -split '[\\/]' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
        $currentPath = Join-Path $currentPath $segment
        if (-not (Test-Path -LiteralPath $currentPath)) { return $false }
        $item = Get-Item -LiteralPath $currentPath -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $true }
    }
    return $false
}

function New-BackupRunRoot {
    param(
        [Parameter(Mandatory = $true)][string]$BackupBaseRoot,
        [Parameter(Mandatory = $true)][datetime]$BackupTime
    )

    if (-not (Test-Path -LiteralPath $BackupBaseRoot -PathType Container)) {
        New-Item -ItemType Directory -Path $BackupBaseRoot -Force | Out-Null
    }
    $timestamp = $BackupTime.ToString('yyyyMMdd-HHmmss')
    while ($true) {
        $candidateRoot = Join-Path $BackupBaseRoot ("{0}-{1}" -f $timestamp, [guid]::NewGuid().ToString('N'))
        try {
            New-Item -ItemType Directory -Path $candidateRoot -ErrorAction Stop | Out-Null
            return $candidateRoot
        }
        catch {
            if (-not (Test-Path -LiteralPath $candidateRoot)) { throw }
        }
    }
}

function Backup-ExistingShortcut {
    param(
        [Parameter(Mandatory = $true)][string]$ShortcutPath,
        [Parameter(Mandatory = $true)][string]$BackupRoot
    )

    if (-not (Test-Path -LiteralPath $ShortcutPath -PathType Leaf)) { return $null }
    if (-not (Test-Path -LiteralPath $BackupRoot -PathType Container)) {
        New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
    }
    $backupPath = Join-Path $BackupRoot ([System.IO.Path]::GetFileName($ShortcutPath))
    [System.IO.File]::Copy($ShortcutPath, $backupPath, $false)
    return $backupPath
}

function New-AtomicTemporaryPath {
    param([Parameter(Mandatory = $true)][string]$DestinationPath)

    $directory = Split-Path -Parent $DestinationPath
    $name = [System.IO.Path]::GetFileName($DestinationPath)
    return Join-Path $directory (".{0}.{1}.tmp" -f $name, [guid]::NewGuid().ToString('N'))
}

function Publish-AtomicTemporaryFile {
    param(
        [Parameter(Mandatory = $true)][string]$TemporaryPath,
        [Parameter(Mandatory = $true)][string]$DestinationPath
    )

    $backupPath = New-AtomicTemporaryPath -DestinationPath $DestinationPath
    try {
        try {
            [System.IO.File]::Replace($TemporaryPath, $DestinationPath, $backupPath)
        }
        catch {
            $replaceFailure = $_.Exception.GetBaseException()
            if ($replaceFailure -is [System.IO.FileNotFoundException]) {
                [System.IO.File]::Move($TemporaryPath, $DestinationPath)
            }
            else {
                throw
            }
        }
    }
    finally {
        if (Test-Path -LiteralPath $backupPath -PathType Leaf) {
            Remove-Item -LiteralPath $backupPath -Force
        }
    }
}

function Publish-AtomicFile {
    param(
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [Parameter(Mandatory = $true)][string]$DestinationPath
    )

    $temporaryPath = New-AtomicTemporaryPath -DestinationPath $DestinationPath
    try {
        Copy-Item -LiteralPath $SourcePath -Destination $temporaryPath -ErrorAction Stop
        Publish-AtomicTemporaryFile -TemporaryPath $temporaryPath -DestinationPath $DestinationPath
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
            Remove-Item -LiteralPath $temporaryPath -Force
        }
    }
}

function Write-AtomicUtf8File {
    param(
        [Parameter(Mandatory = $true)][string]$DestinationPath,
        [Parameter(Mandatory = $true)][string]$Contents
    )

    $temporaryPath = New-AtomicTemporaryPath -DestinationPath $DestinationPath
    try {
        [System.IO.File]::WriteAllText($temporaryPath, $Contents, [System.Text.UTF8Encoding]::new($false))
        Publish-AtomicTemporaryFile -TemporaryPath $temporaryPath -DestinationPath $DestinationPath
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
            Remove-Item -LiteralPath $temporaryPath -Force
        }
    }
}

function Publish-VerifiedInstallConfig {
    param(
        [Parameter(Mandatory = $true)][string]$DestinationPath,
        [Parameter(Mandatory = $true)][string]$Contents,
        [Parameter(Mandatory = $true)][string]$ExpectedRoot,
        [Parameter(Mandatory = $true)][string]$ExpectedSchema
    )

    $hadPreviousConfig = Test-Path -LiteralPath $DestinationPath -PathType Leaf
    if ((Test-Path -LiteralPath $DestinationPath) -and -not $hadPreviousConfig) {
        throw "Launchpad install config path is not a regular file: $DestinationPath"
    }
    $rollbackPath = $null
    $activationAttempted = $false
    $preserveRollback = $false
    if ($hadPreviousConfig) {
        $rollbackPath = New-AtomicTemporaryPath -DestinationPath $DestinationPath
        [System.IO.File]::Copy($DestinationPath, $rollbackPath, $false)
    }

    try {
        $activationAttempted = $true
        Write-AtomicUtf8File -DestinationPath $DestinationPath -Contents $Contents
        $installedConfig = Get-Content -LiteralPath $DestinationPath -Raw -Encoding utf8 | ConvertFrom-Json
        $configValid = (
            [string]$installedConfig.schema_version -eq $ExpectedSchema -and
            (Get-FullPath -Path ([string]$installedConfig.root)) -eq $ExpectedRoot
        )
        if (-not $configValid) {
            throw 'Launchpad install config activation validation failed.'
        }
        if ($null -ne $rollbackPath -and (Test-Path -LiteralPath $rollbackPath -PathType Leaf)) {
            Remove-Item -LiteralPath $rollbackPath -Force
            $rollbackPath = $null
        }
        return $true
    }
    catch {
        $activationFailure = $_.Exception
        if ($activationAttempted) {
            try {
                if ($hadPreviousConfig) {
                    Publish-AtomicTemporaryFile -TemporaryPath $rollbackPath -DestinationPath $DestinationPath
                    $rollbackPath = $null
                }
                elseif (Test-Path -LiteralPath $DestinationPath -PathType Leaf) {
                    Remove-Item -LiteralPath $DestinationPath -Force
                }
            }
            catch {
                $preserveRollback = $true
                throw "Launchpad config activation failed and rollback could not be completed. Previous config recovery file: $rollbackPath"
            }
        }
        throw $activationFailure
    }
    finally {
        if (-not $preserveRollback -and $null -ne $rollbackPath -and (Test-Path -LiteralPath $rollbackPath -PathType Leaf)) {
            Remove-Item -LiteralPath $rollbackPath -Force -ErrorAction SilentlyContinue
        }
    }
}

function New-LaunchpadShortcut {
    param(
        [Parameter(Mandatory = $true)][string]$ShortcutPath,
        [Parameter(Mandatory = $true)][string]$BootstrapPath,
        [Parameter(Mandatory = $true)][string]$ConfigPath,
        [Parameter(Mandatory = $true)][string]$InstalledRoot,
        [Parameter(Mandatory = $true)][string]$PowerShellPath,
        [Parameter(Mandatory = $true)][string]$IconPath
    )

    $shortcutDirectory = Split-Path -Parent $ShortcutPath
    if (-not (Test-Path -LiteralPath $shortcutDirectory -PathType Container)) {
        New-Item -ItemType Directory -Path $shortcutDirectory -Force | Out-Null
    }
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($ShortcutPath)
    $shortcut.TargetPath = $PowerShellPath
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$BootstrapPath`" -ConfigPath `"$ConfigPath`""
    $shortcut.WorkingDirectory = $InstalledRoot
    $shortcut.IconLocation = "$IconPath,0"
    $shortcut.Description = 'HumanAndMachine GEN3 Launchpad'
    $shortcut.Save()
}

function Test-LaunchpadShortcut {
    param(
        [Parameter(Mandatory = $true)][string]$ShortcutPath,
        [Parameter(Mandatory = $true)][string]$BootstrapPath,
        [Parameter(Mandatory = $true)][string]$ConfigPath,
        [Parameter(Mandatory = $true)][string]$InstalledRoot,
        [Parameter(Mandatory = $true)][string]$PowerShellPath,
        [Parameter(Mandatory = $true)][string]$IconPath
    )

    if (-not (Test-Path -LiteralPath $ShortcutPath -PathType Leaf)) { return $false }
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($ShortcutPath)
    $expectedArguments = "-NoProfile -ExecutionPolicy Bypass -File `"$BootstrapPath`" -ConfigPath `"$ConfigPath`""
    return (
        (Get-FullPath -Path $shortcut.TargetPath) -eq (Get-FullPath -Path $PowerShellPath) -and
        $shortcut.Arguments -eq $expectedArguments -and
        -not [string]::IsNullOrWhiteSpace($shortcut.WorkingDirectory) -and
        (Get-FullPath -Path $shortcut.WorkingDirectory) -eq $InstalledRoot -and
        $shortcut.IconLocation -eq "$IconPath,0"
    )
}

$resolvedRoot = Get-FullPath -Path $RootPath
if (-not (Test-Path -LiteralPath $resolvedRoot -PathType Container)) {
    throw "Launchpad root is not available: $resolvedRoot"
}
$rootSegments = $resolvedRoot -split '[\\/]'
if ($rootSegments -contains '.worktrees') {
    throw "Launchpad refuses to install from a worktree root: $resolvedRoot"
}
if (Test-PathContainsReparsePoint -Path $resolvedRoot) {
    throw "Launchpad refuses a root through a reparse point: $resolvedRoot"
}
$gitMarkerPath = Join-Path $resolvedRoot '.git'
if (Test-Path -LiteralPath $gitMarkerPath) {
    $gitMarker = Get-Item -LiteralPath $gitMarkerPath -Force
    if (-not $gitMarker.PSIsContainer) {
        throw "Launchpad refuses a linked Git worktree root: $resolvedRoot"
    }
    if (($gitMarker.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Launchpad refuses an indirect Git metadata root: $resolvedRoot"
    }
}

$launchpadScriptPath = Join-Path $resolvedRoot 'Launchpad.ps1'
$sourceIconPath = Join-Path (Join-Path $PSScriptRoot 'assets') 'launchpad.ico'
$sourceBootstrapPath = Join-Path $PSScriptRoot 'Launchpad-Bootstrap.ps1'
$powerShellPath = Join-Path $PSHOME 'powershell.exe'
if (-not (Test-Path -LiteralPath $launchpadScriptPath -PathType Leaf)) {
    throw "Launchpad.ps1 was not found under '$resolvedRoot'."
}
if (-not (Test-Path -LiteralPath $sourceIconPath -PathType Leaf)) {
    throw "Launchpad icon was not found at '$sourceIconPath'."
}
if (-not (Test-Path -LiteralPath $sourceBootstrapPath -PathType Leaf)) {
    throw "Launchpad bootstrap was not found at '$sourceBootstrapPath'."
}
if (-not (Test-Path -LiteralPath $powerShellPath -PathType Leaf)) {
    throw "Windows PowerShell was not found at '$powerShellPath'."
}

if ([string]::IsNullOrWhiteSpace($StartMenuRoot)) {
    $programsRoot = [Environment]::GetFolderPath('Programs')
    if ([string]::IsNullOrWhiteSpace($programsRoot) -and -not [string]::IsNullOrWhiteSpace($env:APPDATA)) {
        $programsRoot = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
    }
    if ([string]::IsNullOrWhiteSpace($programsRoot)) {
        throw 'Windows Start Menu path could not be resolved. Pass -StartMenuRoot explicitly.'
    }
    $StartMenuRoot = Join-Path $programsRoot 'HumanAndMachine'
}
if ([string]::IsNullOrWhiteSpace($TaskbarRoot)) {
    if ([string]::IsNullOrWhiteSpace($env:APPDATA)) {
        throw 'Windows roaming AppData path could not be resolved. Pass -TaskbarRoot explicitly.'
    }
    $TaskbarRoot = Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
}
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        throw 'Windows local AppData path could not be resolved. Pass -InstallRoot explicitly.'
    }
    $InstallRoot = Join-Path $env:LOCALAPPDATA 'HumanAndMachine\Launchpad'
}

$StartMenuRoot = Get-FullPath -Path $StartMenuRoot
$TaskbarRoot = Get-FullPath -Path $TaskbarRoot
$InstallRoot = Get-FullPath -Path $InstallRoot
$assetRoot = Join-Path $InstallRoot 'assets'
$iconPath = Join-Path $assetRoot 'launchpad.ico'
$installedBootstrapPath = Join-Path $InstallRoot 'Launchpad-Bootstrap.ps1'
$installConfigPath = Join-Path $InstallRoot 'install.json'
$shortcutName = 'HumanAndMachine Launchpad GEN3.lnk'
$startMenuShortcut = Join-Path $StartMenuRoot $shortcutName
$taskbarShortcut = Join-Path $TaskbarRoot $shortcutName
$backupBaseRoot = Join-Path $InstallRoot 'shortcut-backups'
$backups = New-Object System.Collections.Generic.List[string]
$installApplied = $false
$taskbarStatus = if ($StartMenuOnly) { 'not_requested' } else { 'not_applied' }
$startMenuValid = $null
$taskbarValid = $null
$configValid = $null
$bootstrapValid = $null

if ($PSCmdlet.ShouldProcess($resolvedRoot, 'Install per-user HumanAndMachine Launchpad bootstrap and shortcuts')) {
    $installApplied = $true
    if (-not (Test-Path -LiteralPath $InstallRoot -PathType Container)) {
        New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
    }
    if (-not (Test-Path -LiteralPath $assetRoot -PathType Container)) {
        New-Item -ItemType Directory -Path $assetRoot -Force | Out-Null
    }

    Publish-AtomicFile -SourcePath $sourceBootstrapPath -DestinationPath $installedBootstrapPath
    Publish-AtomicFile -SourcePath $sourceIconPath -DestinationPath $iconPath
    $backupRoot = $null
    if (
        (Test-Path -LiteralPath $startMenuShortcut -PathType Leaf) -or
        (-not $StartMenuOnly -and (Test-Path -LiteralPath $taskbarShortcut -PathType Leaf))
    ) {
        $backupRoot = New-BackupRunRoot -BackupBaseRoot $backupBaseRoot -BackupTime $BackupTime
    }
    if ($null -ne $backupRoot) {
        $backup = Backup-ExistingShortcut -ShortcutPath $startMenuShortcut -BackupRoot (Join-Path $backupRoot 'start-menu')
        if ($null -ne $backup) { $backups.Add($backup) }
    }
    New-LaunchpadShortcut -ShortcutPath $startMenuShortcut -BootstrapPath $installedBootstrapPath -ConfigPath $installConfigPath -InstalledRoot $InstallRoot -PowerShellPath $powerShellPath -IconPath $iconPath

    if (-not $StartMenuOnly) {
        if ($null -ne $backupRoot) {
            $backup = Backup-ExistingShortcut -ShortcutPath $taskbarShortcut -BackupRoot (Join-Path $backupRoot 'taskbar')
            if ($null -ne $backup) { $backups.Add($backup) }
        }
        New-LaunchpadShortcut -ShortcutPath $taskbarShortcut -BootstrapPath $installedBootstrapPath -ConfigPath $installConfigPath -InstalledRoot $InstallRoot -PowerShellPath $powerShellPath -IconPath $iconPath
        $taskbarStatus = 'shortcut_installed'
        if (-not $SkipShellPin) {
            try {
                $shellApplication = New-Object -ComObject Shell.Application
                $startMenuFolder = $shellApplication.Namespace((Split-Path -Parent $startMenuShortcut))
                $startMenuItem = $startMenuFolder.ParseName((Split-Path -Leaf $startMenuShortcut))
                $startMenuItem.InvokeVerb('taskbarpin')
                $taskbarStatus = 'pin_requested'
            }
            catch {
                $taskbarStatus = 'shortcut_installed_shell_pin_unavailable'
            }
        }
    }

    $startMenuValid = Test-LaunchpadShortcut -ShortcutPath $startMenuShortcut -BootstrapPath $installedBootstrapPath -ConfigPath $installConfigPath -InstalledRoot $InstallRoot -PowerShellPath $powerShellPath -IconPath $iconPath
    $taskbarValid = if ($StartMenuOnly) { $null } else {
        Test-LaunchpadShortcut -ShortcutPath $taskbarShortcut -BootstrapPath $installedBootstrapPath -ConfigPath $installConfigPath -InstalledRoot $InstallRoot -PowerShellPath $powerShellPath -IconPath $iconPath
    }
    $bootstrapValid = (Get-Sha256Digest -Path $installedBootstrapPath) -eq
        (Get-Sha256Digest -Path $sourceBootstrapPath)
    if (-not $startMenuValid -or (-not $StartMenuOnly -and -not $taskbarValid) -or -not $bootstrapValid) {
        throw 'Launchpad per-user installation validation failed before activation.'
    }

    $installConfig = [pscustomobject]@{
        schema_version = $installSchema
        root = $resolvedRoot
        installed_at = (Get-Date).ToString('o')
    } | ConvertTo-Json -Depth 3
    $configValid = Publish-VerifiedInstallConfig -DestinationPath $installConfigPath -Contents $installConfig -ExpectedRoot $resolvedRoot -ExpectedSchema $installSchema
}

[pscustomobject]@{
    root = $resolvedRoot
    installed_root = $InstallRoot
    installed_bootstrap = $installedBootstrapPath
    install_config = $installConfigPath
    install_config_valid = $configValid
    bootstrap_valid = $bootstrapValid
    installed_icon = $iconPath
    start_menu_shortcut = $startMenuShortcut
    start_menu_valid = $startMenuValid
    taskbar_shortcut = if ($StartMenuOnly) { $null } else { $taskbarShortcut }
    taskbar_shortcut_valid = $taskbarValid
    taskbar_status = $taskbarStatus
    backups = @($backups)
} | ConvertTo-Json -Depth 3
