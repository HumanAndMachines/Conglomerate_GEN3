$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class LaunchpadDirectoryAnchor
{
    public const uint DELETE = 0x00010000;
    public const uint FILE_LIST_DIRECTORY = 0x00000001;
    public const uint FILE_READ_ATTRIBUTES = 0x00000080;
    public const uint SYNCHRONIZE = 0x00100000;
    public const uint FILE_SHARE_READ = 0x00000001;
    public const uint FILE_SHARE_WRITE = 0x00000002;
    public const uint FILE_ATTRIBUTE_HIDDEN = 0x00000002;
    public const uint OPEN_EXISTING = 3;
    public const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    public const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    public const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
    public const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
    public const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
    public const uint FILE_ATTRIBUTE_TEMPORARY = 0x00000100;

    private const uint OBJ_CASE_INSENSITIVE = 0x00000040;
    private const uint FILE_DIRECTORY_FILE = 0x00000001;
    private const uint FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020;
    private const uint FILE_NON_DIRECTORY_FILE = 0x00000040;
    private const uint FILE_DELETE_ON_CLOSE = 0x00001000;
    private const uint FILE_OPEN_REPARSE_POINT = 0x00200000;
    private const uint FILE_CREATE = 2;
    private const uint FILE_OPEN_IF = 3;

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

    [StructLayout(LayoutKind.Sequential)]
    private struct UNICODE_STRING
    {
        public ushort Length;
        public ushort MaximumLength;
        public IntPtr Buffer;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct OBJECT_ATTRIBUTES
    {
        public int Length;
        public IntPtr RootDirectory;
        public IntPtr ObjectName;
        public uint Attributes;
        public IntPtr SecurityDescriptor;
        public IntPtr SecurityQualityOfService;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_STATUS_BLOCK
    {
        public IntPtr Status;
        public UIntPtr Information;
    }

    public sealed class DirectoryResult
    {
        public SafeFileHandle Handle { get; set; }
        public BY_HANDLE_FILE_INFORMATION Information { get; set; }
    }

    public sealed class LockResult
    {
        public SafeFileHandle Handle { get; set; }
        public string Name { get; set; }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(
        SafeFileHandle file,
        out BY_HANDLE_FILE_INFORMATION information
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(
        SafeFileHandle file,
        StringBuilder path,
        uint pathLength,
        uint flags
    );

    [DllImport("ntdll.dll")]
    private static extern int NtCreateFile(
        out IntPtr fileHandle,
        uint desiredAccess,
        ref OBJECT_ATTRIBUTES objectAttributes,
        out IO_STATUS_BLOCK ioStatusBlock,
        IntPtr allocationSize,
        uint fileAttributes,
        uint shareAccess,
        uint createDisposition,
        uint createOptions,
        IntPtr eaBuffer,
        uint eaLength
    );

    [DllImport("ntdll.dll")]
    private static extern uint RtlNtStatusToDosError(int status);

    public static DirectoryResult OpenPathDirectory(string path)
    {
        SafeFileHandle handle = CreateFileW(
            path,
            FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            IntPtr.Zero,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            IntPtr.Zero
        );
        if (handle.IsInvalid)
        {
            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(error, "directory_anchor_open_failed");
        }
        return InspectDirectory(handle);
    }

    public static DirectoryResult OpenRelativeDirectory(
        SafeFileHandle parent,
        string name,
        bool createNew
    )
    {
        ValidateSegment(name);
        SafeFileHandle handle = NtOpenRelative(
            parent,
            name,
            FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_ATTRIBUTE_NORMAL,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            createNew ? FILE_CREATE : FILE_OPEN_IF,
            FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT
        );
        return InspectDirectory(handle);
    }

    public static LockResult CreateRelativeLock(SafeFileHandle directory)
    {
        string name = ".launchpad-materialization-" + Guid.NewGuid().ToString("N") + ".lock";
        SafeFileHandle handle = NtOpenRelative(
            directory,
            name,
            DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_TEMPORARY,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            FILE_CREATE,
            FILE_NON_DIRECTORY_FILE
                | FILE_SYNCHRONOUS_IO_NONALERT
                | FILE_DELETE_ON_CLOSE
                | FILE_OPEN_REPARSE_POINT
        );
        return new LockResult { Handle = handle, Name = name };
    }

    public static string GetFinalDirectoryPath(SafeFileHandle handle)
    {
        StringBuilder output = new StringBuilder(32768);
        uint length = GetFinalPathNameByHandleW(handle, output, (uint)output.Capacity, 0);
        if (length == 0 || length >= (uint)output.Capacity)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "directory_final_path_failed");
        }
        string path = output.ToString();
        if (path.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase))
        {
            return @"\\" + path.Substring(8);
        }
        if (path.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase))
        {
            return path.Substring(4);
        }
        return path;
    }

    private static DirectoryResult InspectDirectory(SafeFileHandle handle)
    {
        BY_HANDLE_FILE_INFORMATION information;
        if (!GetFileInformationByHandle(handle, out information))
        {
            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(error, "directory_anchor_stat_failed");
        }
        if (
            (information.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0
            || (information.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0
        )
        {
            handle.Dispose();
            throw new IOException("directory_anchor_not_plain_directory");
        }
        return new DirectoryResult { Handle = handle, Information = information };
    }

    private static SafeFileHandle NtOpenRelative(
        SafeFileHandle parent,
        string name,
        uint desiredAccess,
        uint fileAttributes,
        uint shareAccess,
        uint createDisposition,
        uint createOptions
    )
    {
        IntPtr nameBuffer = IntPtr.Zero;
        IntPtr unicodePointer = IntPtr.Zero;
        try
        {
            nameBuffer = Marshal.StringToHGlobalUni(name);
            UNICODE_STRING unicode = new UNICODE_STRING
            {
                Length = checked((ushort)(name.Length * 2)),
                MaximumLength = checked((ushort)((name.Length + 1) * 2)),
                Buffer = nameBuffer
            };
            unicodePointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING)));
            Marshal.StructureToPtr(unicode, unicodePointer, false);
            OBJECT_ATTRIBUTES attributes = new OBJECT_ATTRIBUTES
            {
                Length = Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES)),
                RootDirectory = parent.DangerousGetHandle(),
                ObjectName = unicodePointer,
                Attributes = OBJ_CASE_INSENSITIVE,
                SecurityDescriptor = IntPtr.Zero,
                SecurityQualityOfService = IntPtr.Zero
            };
            IO_STATUS_BLOCK statusBlock;
            IntPtr rawHandle;
            int status = NtCreateFile(
                out rawHandle,
                desiredAccess,
                ref attributes,
                out statusBlock,
                IntPtr.Zero,
                fileAttributes,
                shareAccess,
                createDisposition,
                createOptions,
                IntPtr.Zero,
                0
            );
            if (status < 0)
            {
                throw new Win32Exception(
                    unchecked((int)RtlNtStatusToDosError(status)),
                    "relative_anchor_open_failed"
                );
            }
            return new SafeFileHandle(rawHandle, true);
        }
        finally
        {
            if (unicodePointer != IntPtr.Zero) Marshal.FreeHGlobal(unicodePointer);
            if (nameBuffer != IntPtr.Zero) Marshal.FreeHGlobal(nameBuffer);
        }
    }

    private static void ValidateSegment(string name)
    {
        if (
            String.IsNullOrWhiteSpace(name)
            || name == "."
            || name == ".."
            || name.IndexOfAny(new[] { '\\', '/', '\0', '\r', '\n' }) >= 0
        )
        {
            throw new ArgumentException("invalid_relative_segment");
        }
    }
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
    return [LaunchpadDirectoryAnchor]::OpenPathDirectory($Path)
}

function Open-OrCreateDirectoryAnchor {
    param(
        [Microsoft.Win32.SafeHandles.SafeFileHandle]$Parent,
        [string]$Name
    )
    return [LaunchpadDirectoryAnchor]::OpenRelativeDirectory($Parent, $Name, $false)
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
    $priorErrorAction = $ErrorActionPreference
    try {
        # Windows PowerShell 5.1 wraps native stderr lines as ErrorRecord
        # objects. "Stop" would turn an ordinary successful `git fetch`
        # progress line into a terminating PowerShell exception.
        $ErrorActionPreference = "Continue"
        $safeArguments = @(
            "-c", "core.sshCommand=",
            "-c", "core.gitProxy="
        ) + $Arguments
        $nativeOutput = & $script:GitExecutable @safeArguments 2>&1
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $priorErrorAction
    }
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
        $null -eq $config.organizationIdentity -or
        [string]::IsNullOrWhiteSpace([string]$config.organizationIdentity.dev) -or
        [string]::IsNullOrWhiteSpace([string]$config.organizationIdentity.ino) -or
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
    $organizationAnchor = Open-DirectoryAnchor -Path (
        [IO.Path]::GetFullPath([string]$config.organizationRoot)
    )
    $anchors.Add($organizationAnchor.Handle)
    $actualInode = (
        ([UInt64]$organizationAnchor.Information.FileIndexHigh -shl 32) -bor
        [UInt64]$organizationAnchor.Information.FileIndexLow
    )
    if (
        [string]$organizationAnchor.Information.VolumeSerialNumber -ne [string]$config.organizationIdentity.dev -or
        [string]$actualInode -ne [string]$config.organizationIdentity.ino
    ) {
        throw "organization_anchor_changed"
    }
    $organizationPath = [LaunchpadDirectoryAnchor]::GetFinalDirectoryPath(
        $organizationAnchor.Handle
    )
    Set-Location -LiteralPath $organizationPath
    $rootCdup = Invoke-Git -Arguments @("rev-parse", "--show-cdup")
    if (-not $rootCdup.Ok -or $rootCdup.Output -ne "") {
        Write-Result -Payload @{
            ok = $false
            outcome = "failed"
            code = "materialization_path_forbidden"
            message = "The anchored Organization root is not its own Git checkout."
        } -ExitCode 31
    }
    $slotPath = (($config.slotSegments | ForEach-Object { [string]$_ }) -join "/") + "/"
    $ignored = Invoke-Git -Arguments @("check-ignore", "--quiet", "--no-index", "--", $slotPath)
    if (-not $ignored.Ok) {
        Write-Result -Payload @{
            ok = $false
            outcome = "failed"
            code = "materialization_manifest_invalid"
            message = "The manifest checkout path is not gitignored in the Organization root."
        } -ExitCode 31
    }
    $validBranch = Invoke-Git -Arguments @("check-ref-format", "--branch", [string]$config.branch)
    if (-not $validBranch.Ok) {
        Write-Result -Payload @{
            ok = $false
            outcome = "failed"
            code = "materialization_manifest_invalid"
            message = "The manifest declares an invalid Git branch name."
        } -ExitCode 31
    }
    $source = Invoke-Git -Arguments @(
        "ls-remote", "--exit-code", "--heads", "--",
        [string]$config.remote, "refs/heads/$($config.branch)"
    )
    if (-not $source.Ok -or [string]::IsNullOrWhiteSpace($source.Output)) {
        Write-Result -Payload @{
            ok = $false
            outcome = "missing_access"
            code = "materialization_source_unavailable"
            message = "The manifest repository or branch is unavailable to the current GitHub credentials; no checkout was created."
        } -ExitCode 10
    }
    $organizationLock = [LaunchpadDirectoryAnchor]::CreateRelativeLock(
        $organizationAnchor.Handle
    )
    $anchors.Add($organizationLock.Handle)
    $currentAnchor = $organizationAnchor

    for ($index = 0; $index -lt $config.slotSegments.Count - 1; $index += 1) {
        $parentAnchor = Open-OrCreateDirectoryAnchor `
            -Parent $currentAnchor.Handle `
            -Name ([string]$config.slotSegments[$index])
        $anchors.Add($parentAnchor.Handle)
        $parentLock = [LaunchpadDirectoryAnchor]::CreateRelativeLock(
            $parentAnchor.Handle
        )
        $anchors.Add($parentLock.Handle)
        $currentAnchor = $parentAnchor
    }

    Pause-ForTest -Hook $config.testHook -Phase "before_claim"

    $targetName = [string]$config.slotSegments[$config.slotSegments.Count - 1]
    try {
        $targetAnchor = [LaunchpadDirectoryAnchor]::OpenRelativeDirectory(
            $currentAnchor.Handle,
            $targetName,
            $true
        )
    }
    catch [System.ComponentModel.Win32Exception] {
        if ($_.Exception.NativeErrorCode -eq 183) {
            Write-Result -Payload @{
                ok = $false
                outcome = "target_exists"
                code = "materialization_target_appeared"
                message = "Another process created the target checkout; Launchpad left it unchanged."
            } -ExitCode 20
        }
        throw
    }
    $claimed = $true

    $anchors.Add($targetAnchor.Handle)
    $targetLock = [LaunchpadDirectoryAnchor]::CreateRelativeLock(
        $targetAnchor.Handle
    )
    $anchors.Add($targetLock.Handle)
    $targetPath = [LaunchpadDirectoryAnchor]::GetFinalDirectoryPath(
        $targetAnchor.Handle
    )
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($targetPath)) {
        if ([IO.Path]::GetFileName($entry) -cne $targetLock.Name) {
            throw "target_not_empty"
        }
    }

    Pause-ForTest -Hook $config.testHook -Phase "after_target_anchor"
    # Refresh the path from the retained target handle after the deterministic
    # race hook. The lock file normally blocks the rename; if a filesystem
    # permits it, Git still receives the final path of the anchored directory,
    # never the redirected manifest pathname.
    $targetPath = [LaunchpadDirectoryAnchor]::GetFinalDirectoryPath(
        $targetAnchor.Handle
    )
    Set-Location -LiteralPath $targetPath

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
    # The anchored, delete-on-close lock is intentionally the sole untracked
    # entry until helper exit. The JS caller performs the final full clean
    # status after every lock handle has closed.
    $status = Invoke-Git -Arguments @(
        "status",
        "--porcelain=v1",
        "--untracked-files=no"
    )
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
    for ($index = $anchors.Count - 1; $index -ge 0; $index -= 1) {
        $handle = $anchors[$index]
        if ($null -ne $handle) {
            $handle.Dispose()
        }
    }
}
