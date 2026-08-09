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
    [string]$InstalledRoot,

    [Parameter()]
    [ValidateRange(1, 65535)]
    [int]$LaunchpadPort = 4174,

    [Parameter()]
    [switch]$StartMenuOnly,

    [Parameter()]
    [switch]$SkipShellPin,

    [Parameter()]
    [switch]$SkipLegacyTaskAudit,

    [Parameter()]
    [datetime]$BackupTime = (Get-Date)
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[string[]]$managedLegacyLaunchpadTaskNames = @(
    'HumanAndMachine Launchpad GEN3'
)
[string]$managedLegacyLaunchpadTaskPath = '\'

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
                # First installation has no destination yet. Move does not overwrite a
                # concurrently-created destination, so that race fails closed.
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
        [System.IO.File]::WriteAllText($temporaryPath, $Contents, [System.Text.UTF8Encoding]::new($true))
        Publish-AtomicTemporaryFile -TemporaryPath $temporaryPath -DestinationPath $DestinationPath
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
            Remove-Item -LiteralPath $temporaryPath -Force
        }
    }
}

function New-LaunchpadShortcut {
    param(
        [Parameter(Mandatory = $true)][string]$ShortcutPath,
        [Parameter(Mandatory = $true)][string]$InstalledBootstrapPath,
        [Parameter(Mandatory = $true)][string]$InstallConfigPath,
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
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$InstalledBootstrapPath`" -ConfigPath `"$InstallConfigPath`""
    $shortcut.WorkingDirectory = $InstalledRoot
    $shortcut.IconLocation = "$IconPath,0"
    $shortcut.Description = 'HumanAndMachine GEN3 Launchpad'
    $shortcut.Save()
}

function Test-LaunchpadShortcut {
    param(
        [Parameter(Mandatory = $true)][string]$ShortcutPath,
        [Parameter(Mandatory = $true)][string]$InstalledBootstrapPath,
        [Parameter(Mandatory = $true)][string]$InstallConfigPath,
        [Parameter(Mandatory = $true)][string]$InstalledRoot,
        [Parameter(Mandatory = $true)][string]$PowerShellPath,
        [Parameter(Mandatory = $true)][string]$IconPath
    )

    if (-not (Test-Path -LiteralPath $ShortcutPath -PathType Leaf)) {
        return $false
    }

    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($ShortcutPath)

    return (
        (Get-FullPath -Path $shortcut.TargetPath) -eq (Get-FullPath -Path $PowerShellPath) -and
        $shortcut.Arguments -like "*-File*`"$InstalledBootstrapPath`"*" -and
        $shortcut.Arguments -like "*-ConfigPath*`"$InstallConfigPath`"*" -and
        (Get-FullPath -Path $shortcut.WorkingDirectory) -eq $InstalledRoot -and
        $shortcut.IconLocation -eq "$IconPath,0"
    )
}

function Get-ScheduledTaskActionText {
    param([Parameter(Mandatory = $true)]$Action)

    $execute = if ($null -ne $Action.PSObject.Properties['Execute']) { [string]$Action.Execute } else { '' }
    $arguments = if ($null -ne $Action.PSObject.Properties['Arguments']) { [string]$Action.Arguments } else { '' }
    $workingDirectory = if ($null -ne $Action.PSObject.Properties['WorkingDirectory']) { [string]$Action.WorkingDirectory } else { '' }
    return "{0} {1} {2}" -f $execute, $arguments, $workingDirectory
}

function Test-ManagedLaunchpadScheduledTask {
    param([Parameter(Mandatory = $true)]$Task)

    if (
        $null -eq $Task.PSObject.Properties['TaskName'] -or
        $null -eq $Task.PSObject.Properties['TaskPath']
    ) {
        return $false
    }

    $taskName = [string]$Task.TaskName
    $taskPath = [string]$Task.TaskPath
    return (
        -not [string]::IsNullOrWhiteSpace($taskName) -and
        $taskPath -eq $managedLegacyLaunchpadTaskPath -and
        $managedLegacyLaunchpadTaskNames -contains $taskName
    )
}

function Test-TemporaryLaunchpadTaskAction {
    param([Parameter(Mandatory = $true)]$Task)

    if (-not (Test-ManagedLaunchpadScheduledTask -Task $Task)) {
        return $false
    }

    foreach ($action in @($Task.Actions)) {
        if ($null -eq $action) { continue }
        $actionText = Get-ScheduledTaskActionText -Action $action
        if ($actionText -match '(?i)launchpad' -and $actionText -match '(?i)[\\/]\.worktrees[\\/]') {
            return $true
        }
    }
    return $false
}

function Disable-TemporaryLaunchpadScheduledTasks {
    param([Parameter(Mandatory = $true)][bool]$Apply)

    $results = New-Object System.Collections.Generic.List[object]
    $getScheduledTask = Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue
    if ($null -eq $getScheduledTask) {
        $results.Add([pscustomobject]@{ task = $null; state = 'audit_unavailable'; action = $null })
        return $results.ToArray()
    }

    try {
        $tasks = @(Get-ScheduledTask -ErrorAction Stop)
    }
    catch {
        $results.Add([pscustomobject]@{ task = $null; state = 'audit_failed'; action = $_.Exception.Message })
        return $results.ToArray()
    }

    foreach ($task in $tasks) {
        try {
            if (-not (Test-TemporaryLaunchpadTaskAction -Task $task)) { continue }

            $taskIdentity = "{0}{1}" -f $task.TaskPath, $task.TaskName
            $actionText = (@($task.Actions) | ForEach-Object {
                if ($null -eq $_) { return '' }
                Get-ScheduledTaskActionText -Action $_
            }) -join ' | '
            $state = 'already_disabled'
            if ($task.State -ne 'Disabled') {
                if ($Apply -and $PSCmdlet.ShouldProcess($taskIdentity, 'Disable temporary Launchpad scheduled task')) {
                    Disable-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction Stop | Out-Null
                    $state = 'disabled'
                }
                else {
                    $state = 'would_disable'
                }
            }
            $results.Add([pscustomobject]@{ task = $taskIdentity; state = $state; action = $actionText })
        }
        catch {
            $taskIdentity = if ($null -ne $task -and $null -ne $task.PSObject.Properties['TaskName']) {
                "{0}{1}" -f $task.TaskPath, $task.TaskName
            }
            else {
                $null
            }
            $results.Add([pscustomobject]@{ task = $taskIdentity; state = 'task_audit_failed'; action = $_.Exception.Message })
        }
    }

    return $results.ToArray()
}

$resolvedRoot = Get-FullPath -Path $RootPath
$launchpadScriptPath = Join-Path $resolvedRoot 'Launchpad.ps1'
$sourceIconPath = Join-Path (Join-Path $PSScriptRoot 'assets') 'launchpad.ico'
$sourceBootstrapPath = Join-Path (Join-Path $PSScriptRoot 'assets') 'Launchpad-Bootstrap.ps1'
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
if ([string]::IsNullOrWhiteSpace($InstalledAssetRoot)) {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        throw 'Windows local AppData path could not be resolved. Pass -InstalledAssetRoot explicitly.'
    }
    $InstalledAssetRoot = Join-Path $env:LOCALAPPDATA 'HumanAndMachine\Launchpad\assets'
}
if ([string]::IsNullOrWhiteSpace($InstalledRoot)) {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        throw 'Windows local AppData path could not be resolved. Pass -InstalledRoot explicitly.'
    }
    $InstalledRoot = Join-Path $env:LOCALAPPDATA 'HumanAndMachine\Launchpad'
}

$StartMenuRoot = Get-FullPath -Path $StartMenuRoot
$TaskbarRoot = Get-FullPath -Path $TaskbarRoot
$InstalledAssetRoot = Get-FullPath -Path $InstalledAssetRoot
$InstalledRoot = Get-FullPath -Path $InstalledRoot
$iconPath = Join-Path $InstalledAssetRoot 'launchpad.ico'
$installedBootstrapPath = Join-Path $InstalledRoot 'Launchpad-Bootstrap.ps1'
$installConfigPath = Join-Path $InstalledRoot 'install.json'
$shortcutName = 'HumanAndMachine Launchpad GEN3.lnk'
$startMenuShortcut = Join-Path $StartMenuRoot $shortcutName
$taskbarShortcut = Join-Path $TaskbarRoot $shortcutName
$backupBaseRoot = Join-Path $env:LOCALAPPDATA 'HumanAndMachine\Launchpad\shortcut-backups'
$backups = New-Object System.Collections.Generic.List[string]
$installApplied = $false
$taskbarStatus = if ($StartMenuOnly) { 'not_requested' } else { 'not_applied' }
$legacyScheduledTasks = @()

if ($PSCmdlet.ShouldProcess($resolvedRoot, 'Install HumanAndMachine Launchpad icon and shortcuts')) {
    $installApplied = $true
    if (-not (Test-Path -LiteralPath $InstalledAssetRoot -PathType Container)) {
        New-Item -ItemType Directory -Path $InstalledAssetRoot -Force | Out-Null
    }
    if (-not (Test-Path -LiteralPath $InstalledRoot -PathType Container)) {
        New-Item -ItemType Directory -Path $InstalledRoot -Force | Out-Null
    }
    Publish-AtomicFile -SourcePath $sourceIconPath -DestinationPath $iconPath
    Publish-AtomicFile -SourcePath $sourceBootstrapPath -DestinationPath $installedBootstrapPath
    $installConfig = [pscustomobject]@{
        schema_version = 'humanandmachine.launchpad.windows_install.v1'
        root = $resolvedRoot
        port = $LaunchpadPort
        installed_at = (Get-Date).ToString('o')
    } | ConvertTo-Json -Depth 3
    Write-AtomicUtf8File -DestinationPath $installConfigPath -Contents $installConfig

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
    New-LaunchpadShortcut -ShortcutPath $startMenuShortcut -InstalledBootstrapPath $installedBootstrapPath -InstallConfigPath $installConfigPath -InstalledRoot $InstalledRoot -PowerShellPath $powerShellPath -IconPath $iconPath

    if (-not $StartMenuOnly) {
        if ($null -ne $backupRoot) {
            $taskbarBackupRoot = Join-Path $backupRoot 'taskbar'
            $backup = Backup-ExistingShortcut -ShortcutPath $taskbarShortcut -BackupRoot $taskbarBackupRoot
            if ($null -ne $backup) { $backups.Add($backup) }
        }
        New-LaunchpadShortcut -ShortcutPath $taskbarShortcut -InstalledBootstrapPath $installedBootstrapPath -InstallConfigPath $installConfigPath -InstalledRoot $InstalledRoot -PowerShellPath $powerShellPath -IconPath $iconPath
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

    if (-not $SkipLegacyTaskAudit) {
        $legacyScheduledTasks = @(Disable-TemporaryLaunchpadScheduledTasks -Apply $true)
    }
}

$startMenuValid = if ($installApplied) {
    Test-LaunchpadShortcut -ShortcutPath $startMenuShortcut -InstalledBootstrapPath $installedBootstrapPath -InstallConfigPath $installConfigPath -InstalledRoot $InstalledRoot -PowerShellPath $powerShellPath -IconPath $iconPath
} else {
    $null
}
$taskbarValid = if (-not $installApplied -or $StartMenuOnly) {
    $null
} else {
    Test-LaunchpadShortcut -ShortcutPath $taskbarShortcut -InstalledBootstrapPath $installedBootstrapPath -InstallConfigPath $installConfigPath -InstalledRoot $InstalledRoot -PowerShellPath $powerShellPath -IconPath $iconPath
}

if ($installApplied -and (-not $startMenuValid -or (-not $StartMenuOnly -and -not $taskbarValid))) {
    throw 'Launchpad shortcut validation failed.'
}

[pscustomobject]@{
    root = $resolvedRoot
    installed_root = $InstalledRoot
    installed_bootstrap = $installedBootstrapPath
    install_config = $installConfigPath
    launchpad_port = $LaunchpadPort
    installed_icon = $iconPath
    start_menu_shortcut = $startMenuShortcut
    start_menu_valid = $startMenuValid
    taskbar_shortcut = if ($StartMenuOnly) { $null } else { $taskbarShortcut }
    taskbar_shortcut_valid = $taskbarValid
    taskbar_status = $taskbarStatus
    legacy_scheduled_tasks = @($legacyScheduledTasks)
    backups = @($backups)
} | ConvertTo-Json -Depth 3
