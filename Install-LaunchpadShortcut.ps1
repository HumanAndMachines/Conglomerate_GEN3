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
    [string]$InstalledAssetRoot,

    [Parameter()]
    [switch]$StartMenuOnly,

    [Parameter()]
    [switch]$SkipShellPin,

    [Parameter()]
    [datetime]$BackupTime = (Get-Date)
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-FullPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    return [System.IO.Path]::GetFullPath($Path)
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
            if (-not (Test-Path -LiteralPath $candidateRoot)) {
                throw
            }
        }
    }
}

function Backup-ExistingShortcut {
    param(
        [Parameter(Mandatory = $true)][string]$ShortcutPath,
        [Parameter(Mandatory = $true)][string]$BackupRoot
    )

    if (-not (Test-Path -LiteralPath $ShortcutPath -PathType Leaf)) {
        return $null
    }

    if (-not (Test-Path -LiteralPath $BackupRoot -PathType Container)) {
        New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
    }

    $backupPath = Join-Path $BackupRoot ([System.IO.Path]::GetFileName($ShortcutPath))
    [System.IO.File]::Copy($ShortcutPath, $backupPath, $false)
    return $backupPath
}

function New-LaunchpadShortcut {
    param(
        [Parameter(Mandatory = $true)][string]$ShortcutPath,
        [Parameter(Mandatory = $true)][string]$LaunchpadRoot,
        [Parameter(Mandatory = $true)][string]$PowerShellPath,
        [Parameter(Mandatory = $true)][string]$IconPath
    )

    $shortcutDirectory = Split-Path -Parent $ShortcutPath
    if (-not (Test-Path -LiteralPath $shortcutDirectory -PathType Container)) {
        New-Item -ItemType Directory -Path $shortcutDirectory -Force | Out-Null
    }

    $launchpadScript = Join-Path $LaunchpadRoot 'Launchpad.ps1'
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($ShortcutPath)
    $shortcut.TargetPath = $PowerShellPath
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$launchpadScript`""
    $shortcut.WorkingDirectory = $LaunchpadRoot
    $shortcut.IconLocation = "$IconPath,0"
    $shortcut.Description = 'HumanAndMachine GEN3 Launchpad'
    $shortcut.Save()
}

function Test-LaunchpadShortcut {
    param(
        [Parameter(Mandatory = $true)][string]$ShortcutPath,
        [Parameter(Mandatory = $true)][string]$LaunchpadRoot,
        [Parameter(Mandatory = $true)][string]$PowerShellPath,
        [Parameter(Mandatory = $true)][string]$IconPath
    )

    if (-not (Test-Path -LiteralPath $ShortcutPath -PathType Leaf)) {
        return $false
    }

    $launchpadScript = Join-Path $LaunchpadRoot 'Launchpad.ps1'
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($ShortcutPath)

    return (
        (Get-FullPath -Path $shortcut.TargetPath) -eq (Get-FullPath -Path $PowerShellPath) -and
        $shortcut.Arguments -like "*-File*`"$launchpadScript`"*" -and
        (Get-FullPath -Path $shortcut.WorkingDirectory) -eq $LaunchpadRoot -and
        $shortcut.IconLocation -eq "$IconPath,0"
    )
}

$resolvedRoot = Get-FullPath -Path $RootPath
$launchpadScriptPath = Join-Path $resolvedRoot 'Launchpad.ps1'
$sourceIconPath = Join-Path (Join-Path $PSScriptRoot 'assets') 'launchpad.ico'
$powerShellPath = Join-Path $PSHOME 'powershell.exe'

if (-not (Test-Path -LiteralPath $launchpadScriptPath -PathType Leaf)) {
    throw "Launchpad.ps1 was not found under '$resolvedRoot'."
}
if (-not (Test-Path -LiteralPath $sourceIconPath -PathType Leaf)) {
    throw "Launchpad icon was not found at '$sourceIconPath'."
}
if (-not (Test-Path -LiteralPath $powerShellPath -PathType Leaf)) {
    throw "Windows PowerShell was not found at '$powerShellPath'."
}

if ([string]::IsNullOrWhiteSpace($StartMenuRoot)) {
    $StartMenuRoot = Join-Path ([Environment]::GetFolderPath('Programs')) 'HumanAndMachine'
}
if ([string]::IsNullOrWhiteSpace($TaskbarRoot)) {
    $TaskbarRoot = Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
}
if ([string]::IsNullOrWhiteSpace($InstalledAssetRoot)) {
    $InstalledAssetRoot = Join-Path $env:LOCALAPPDATA 'HumanAndMachine\Launchpad\assets'
}

$StartMenuRoot = Get-FullPath -Path $StartMenuRoot
$TaskbarRoot = Get-FullPath -Path $TaskbarRoot
$InstalledAssetRoot = Get-FullPath -Path $InstalledAssetRoot
$iconPath = Join-Path $InstalledAssetRoot 'launchpad.ico'
$shortcutName = 'HumanAndMachine Launchpad GEN3.lnk'
$startMenuShortcut = Join-Path $StartMenuRoot $shortcutName
$taskbarShortcut = Join-Path $TaskbarRoot $shortcutName
$backupBaseRoot = Join-Path $env:LOCALAPPDATA 'HumanAndMachine\Launchpad\shortcut-backups'
$backups = New-Object System.Collections.Generic.List[string]
$installApplied = $false
$taskbarStatus = if ($StartMenuOnly) { 'not_requested' } else { 'not_applied' }

if ($PSCmdlet.ShouldProcess($resolvedRoot, 'Install HumanAndMachine Launchpad icon and shortcuts')) {
    $installApplied = $true
    if (-not (Test-Path -LiteralPath $InstalledAssetRoot -PathType Container)) {
        New-Item -ItemType Directory -Path $InstalledAssetRoot -Force | Out-Null
    }
    Copy-Item -LiteralPath $sourceIconPath -Destination $iconPath -Force

    $backupRoot = $null
    if (
        (Test-Path -LiteralPath $startMenuShortcut -PathType Leaf) -or
        (-not $StartMenuOnly -and (Test-Path -LiteralPath $taskbarShortcut -PathType Leaf))
    ) {
        $backupRoot = New-BackupRunRoot -BackupBaseRoot $backupBaseRoot -BackupTime $BackupTime
    }

    if ($null -ne $backupRoot) {
        $startMenuBackupRoot = Join-Path $backupRoot 'start-menu'
        $backup = Backup-ExistingShortcut -ShortcutPath $startMenuShortcut -BackupRoot $startMenuBackupRoot
        if ($null -ne $backup) { $backups.Add($backup) }
    }
    New-LaunchpadShortcut -ShortcutPath $startMenuShortcut -LaunchpadRoot $resolvedRoot -PowerShellPath $powerShellPath -IconPath $iconPath

    if (-not $StartMenuOnly) {
        if ($null -ne $backupRoot) {
            $taskbarBackupRoot = Join-Path $backupRoot 'taskbar'
            $backup = Backup-ExistingShortcut -ShortcutPath $taskbarShortcut -BackupRoot $taskbarBackupRoot
            if ($null -ne $backup) { $backups.Add($backup) }
        }
        New-LaunchpadShortcut -ShortcutPath $taskbarShortcut -LaunchpadRoot $resolvedRoot -PowerShellPath $powerShellPath -IconPath $iconPath
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
                # Windows 11 may intentionally suppress the taskbarpin verb. The
                # validated pinned-folder shortcut remains available for Explorer.
                $taskbarStatus = 'shortcut_installed_shell_pin_unavailable'
            }
        }
    }
}

$startMenuValid = if ($installApplied) {
    Test-LaunchpadShortcut -ShortcutPath $startMenuShortcut -LaunchpadRoot $resolvedRoot -PowerShellPath $powerShellPath -IconPath $iconPath
} else {
    $null
}
$taskbarValid = if (-not $installApplied -or $StartMenuOnly) {
    $null
} else {
    Test-LaunchpadShortcut -ShortcutPath $taskbarShortcut -LaunchpadRoot $resolvedRoot -PowerShellPath $powerShellPath -IconPath $iconPath
}

if ($installApplied -and (-not $startMenuValid -or (-not $StartMenuOnly -and -not $taskbarValid))) {
    throw 'Launchpad shortcut validation failed.'
}

[pscustomobject]@{
    root = $resolvedRoot
    installed_icon = $iconPath
    start_menu_shortcut = $startMenuShortcut
    start_menu_valid = $startMenuValid
    taskbar_shortcut = if ($StartMenuOnly) { $null } else { $taskbarShortcut }
    taskbar_shortcut_valid = $taskbarValid
    taskbar_status = $taskbarStatus
    backups = @($backups)
} | ConvertTo-Json -Depth 3
