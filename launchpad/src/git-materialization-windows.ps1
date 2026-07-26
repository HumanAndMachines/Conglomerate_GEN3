$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class LaunchpadDirectoryAnchor
{
    public const uint FILE_READ_ATTRIBUTES = 0x00000080;
    public const uint FILE_SHARE_READ = 0x00000001;
    public const uint FILE_SHARE_WRITE = 0x00000002;
    public const uint OPEN_EXISTING = 3;
    public const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    public const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    public const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
    public const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;

    [StructLayout(LayoutKind.Sequential)]
    public struct BY_HANDLE_FILE_INFORMATION
    {
        public uint FileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern SafeFileHandle CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CreateDirectoryW(
        string pathName,
        IntPtr securityAttributes
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetFileInformationByHandle(
        SafeFileHandle file,
        out BY_HANDLE_FILE_INFORMATION information
    );
}
"@

function Write-Result {
    param(
        [hashtable]$Payload,
        [int]$ExitCode
    )
    [Console]::Out.Write(($Payload | ConvertTo-Json -Compress -Depth 6))
    exit $ExitCode
}

function Open-DirectoryAnchor {
    param([string]$Path)

    $handle = [LaunchpadDirectoryAnchor]::CreateFileW(
        $Path,
        [LaunchpadDirectoryAnchor]::FILE_READ_ATTRIBUTES,
        (
            [LaunchpadDirectoryAnchor]::FILE_SHARE_READ -bor
            [LaunchpadDirectoryAnchor]::FILE_SHARE_WRITE
        ),
        [IntPtr]::Zero,
        [LaunchpadDirectoryAnchor]::OPEN_EXISTING,
        (
            [LaunchpadDirectoryAnchor]::FILE_FLAG_BACKUP_SEMANTICS -bor
            [LaunchpadDirectoryAnchor]::FILE_FLAG_OPEN_REPARSE_POINT
        ),
        [IntPtr]::Zero
    )
    if ($handle.IsInvalid) {
        $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        $handle.Dispose()
        throw "directory_anchor_open_failed:$errorCode"
    }

    $information = New-Object LaunchpadDirectoryAnchor+BY_HANDLE_FILE_INFORMATION
    if (-not [LaunchpadDirectoryAnchor]::GetFileInformationByHandle(
        $handle,
        [ref]$information
    )) {
        $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        $handle.Dispose()
        throw "directory_anchor_stat_failed:$errorCode"
    }
    if (
        ($information.FileAttributes -band [LaunchpadDirectoryAnchor]::FILE_ATTRIBUTE_DIRECTORY) -eq 0 -or
        ($information.FileAttributes -band [LaunchpadDirectoryAnchor]::FILE_ATTRIBUTE_REPARSE_POINT) -ne 0
    ) {
        $handle.Dispose()
        throw "directory_anchor_not_plain_directory"
    }

    return [PSCustomObject]@{
        Handle = $handle
        Information = $information
    }
}

function Open-OrCreateDirectoryAnchor {
    param([string]$Path)
    try {
        return Open-DirectoryAnchor -Path $Path
    }
    catch {
        if ($_.Exception.Message -notmatch 'directory_anchor_open_failed:(2|3)$') {
            throw
        }
    }
    if (-not [LaunchpadDirectoryAnchor]::CreateDirectoryW(
        $Path,
        [IntPtr]::Zero
    )) {
        $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($errorCode -ne 183) {
            throw "parent_claim_failed:$errorCode"
        }
    }
    return Open-DirectoryAnchor -Path $Path
}

function Pause-ForTest {
    param(
        [object]$Hook,
        [string]$Phase
    )
    if ($null -eq $Hook -or $Hook.phase -ne $Phase) {
        return
    }
    if (
        [string]::IsNullOrWhiteSpace([string]$Hook.readyPath) -or
        [string]::IsNullOrWhiteSpace([string]$Hook.proceedPath)
    ) {
        throw "invalid_test_hook"
    }
    $ready = [IO.File]::Open(
        [string]$Hook.readyPath,
        [IO.FileMode]::CreateNew,
        [IO.FileAccess]::Write,
        [IO.FileShare]::None
    )
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes("ready`n")
        $ready.Write($bytes, 0, $bytes.Length)
    }
    finally {
        $ready.Dispose()
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while (-not [IO.File]::Exists([string]$Hook.proceedPath)) {
        if ([DateTime]::UtcNow -ge $deadline) {
            throw "test_hook_timeout"
        }
        Start-Sleep -Milliseconds 20
    }
}

function Invoke-Git {
    param([string[]]$Arguments)
    $nativeOutput = & $script:GitExecutable @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    $text = (($nativeOutput | ForEach-Object { $_.ToString() }) -join "`n").Trim()
    return [PSCustomObject]@{
        Ok = $exitCode -eq 0
        ExitCode = $exitCode
        Output = $text
    }
}

function Assert-Git {
    param([string[]]$Arguments)
    $result = Invoke-Git -Arguments $Arguments
    if (-not $result.Ok) {
        throw "git_write_failed:$($Arguments[0]):$($result.ExitCode)"
    }
}

$claimed = $false
$anchors = New-Object System.Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeFileHandle]
$originalLocation = Get-Location

try {
    $inputJson = [Console]::In.ReadToEnd()
    $config = $inputJson | ConvertFrom-Json
    if (
        $null -eq $config -or
        [string]::IsNullOrWhiteSpace([string]$config.organizationRoot) -or
        $null -eq $config.slotSegments -or
        $config.slotSegments.Count -lt 1 -or
        [string]::IsNullOrWhiteSpace([string]$config.remote) -or
        [string]::IsNullOrWhiteSpace([string]$config.branch) -or
        [string]::IsNullOrWhiteSpace([string]$config.gitExecutable)
    ) {
        throw "invalid_config"
    }
    foreach ($segmentValue in $config.slotSegments) {
        $segment = [string]$segmentValue
        if (
            [string]::IsNullOrWhiteSpace($segment) -or
            $segment -eq "." -or
            $segment -eq ".." -or
            $segment.IndexOfAny([char[]]@('\', '/', "`0", "`r", "`n")) -ge 0
        ) {
            throw "invalid_segment"
        }
    }

    $script:GitExecutable = [string]$config.gitExecutable
    $currentPath = [IO.Path]::GetFullPath([string]$config.organizationRoot)
    $organizationAnchor = Open-DirectoryAnchor -Path $currentPath
    $anchors.Add($organizationAnchor.Handle)

    for ($index = 0; $index -lt $config.slotSegments.Count - 1; $index += 1) {
        $currentPath = [IO.Path]::Combine(
            $currentPath,
            [string]$config.slotSegments[$index]
        )
        $parentAnchor = Open-OrCreateDirectoryAnchor -Path $currentPath
        $anchors.Add($parentAnchor.Handle)
    }

    Pause-ForTest -Hook $config.testHook -Phase "before_claim"

    $targetPath = [IO.Path]::Combine(
        $currentPath,
        [string]$config.slotSegments[$config.slotSegments.Count - 1]
    )
    if (-not [LaunchpadDirectoryAnchor]::CreateDirectoryW(
        $targetPath,
        [IntPtr]::Zero
    )) {
        $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($errorCode -eq 183) {
            Write-Result -Payload @{
                ok = $false
                outcome = "target_exists"
                code = "materialization_target_appeared"
                message = "Another process created the target checkout; Launchpad left it unchanged."
            } -ExitCode 20
        }
        throw "target_claim_failed:$errorCode"
    }
    $claimed = $true

    $targetAnchor = Open-DirectoryAnchor -Path $targetPath
    $anchors.Add($targetAnchor.Handle)
    $entries = [IO.Directory]::EnumerateFileSystemEntries($targetPath).GetEnumerator()
    try {
        if ($entries.MoveNext()) {
            throw "target_not_empty"
        }
    }
    finally {
        if ($entries -is [IDisposable]) {
            $entries.Dispose()
        }
    }

    Set-Location -LiteralPath $targetPath
    Pause-ForTest -Hook $config.testHook -Phase "after_target_anchor"

    Assert-Git -Arguments @("init", "--initial-branch=$($config.branch)", ".")
    Assert-Git -Arguments @("remote", "add", "origin", [string]$config.remote)
    Assert-Git -Arguments @(
        "config",
        "remote.origin.fetch",
        "+refs/heads/$($config.branch):refs/remotes/origin/$($config.branch)"
    )
    Assert-Git -Arguments @("fetch", "--no-tags", "origin")
    Assert-Git -Arguments @(
        "checkout",
        "--force",
        "-B",
        [string]$config.branch,
        "--track",
        "origin/$($config.branch)"
    )

    $root = Invoke-Git -Arguments @("rev-parse", "--show-toplevel")
    $currentBranch = Invoke-Git -Arguments @("branch", "--show-current")
    $origin = Invoke-Git -Arguments @("remote", "get-url", "origin")
    $head = Invoke-Git -Arguments @("rev-parse", "--verify", "HEAD^{commit}")
    $status = Invoke-Git -Arguments @("status", "--porcelain=v1")
    if (
        -not $root.Ok -or
        [string]::IsNullOrWhiteSpace($root.Output) -or
        -not $currentBranch.Ok -or
        $currentBranch.Output -cne [string]$config.branch -or
        -not $origin.Ok -or
        $origin.Output -cne [string]$config.remote -or
        -not $head.Ok -or
        $head.Output -notmatch '^[0-9a-f]{40}$' -or
        -not $status.Ok -or
        $status.Output -ne ""
    ) {
        throw "git_verification_failed"
    }

    Write-Result -Payload @{
        ok = $true
        outcome = "materialized"
        code = $null
        message = "The manifest module was cloned through an anchored directory handle."
        branch = [string]$config.branch
        head = $head.Output
        remote = [string]$config.remote
        anchor = @{
            volume = [string]$targetAnchor.Information.VolumeSerialNumber
            indexHigh = [string]$targetAnchor.Information.FileIndexHigh
            indexLow = [string]$targetAnchor.Information.FileIndexLow
        }
    } -ExitCode 0
}
catch {
    $failureDetail = ([string]$_.Exception.Message).Substring(
        0,
        [Math]::Min(160, ([string]$_.Exception.Message).Length)
    )
    if ($claimed) {
        Write-Result -Payload @{
            ok = $false
            outcome = "failed"
            code = "materialization_incomplete"
            message = "The anchored Git checkout failed after claiming the target; the partial directory remains for manual inspection."
            detail = $failureDetail
        } -ExitCode 30
    }
    Write-Result -Payload @{
        ok = $false
        outcome = "failed"
        code = "materialization_path_forbidden"
        message = "A no-follow directory anchor could not be acquired; the target was not created."
        detail = $failureDetail
    } -ExitCode 31
}
finally {
    Set-Location -LiteralPath $originalLocation
    foreach ($handle in $anchors) {
        if ($null -ne $handle) {
            $handle.Dispose()
        }
    }
}
