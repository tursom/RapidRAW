param(
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [ValidateRange(1, 3600)][int]$Seconds = 120
)

# Run in the same interactive desktop as the test. Never opens the clipboard.
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ClipboardProcessObserver {
    [DllImport("user32.dll")] public static extern IntPtr GetOpenClipboardWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
}
'@

$absolute = [IO.Path]::GetFullPath($OutputPath)
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($absolute)) | Out-Null
# CreateNew prevents accidentally replacing an earlier observation.
$stream = [IO.File]::Open($absolute, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
$writer = New-Object IO.StreamWriter($stream, (New-Object Text.UTF8Encoding($false)))
$writer.AutoFlush = $true
$timer = [Diagnostics.Stopwatch]::StartNew()
$seen = @{}
$lastState = ''
try {
    $writer.WriteLine((@{
        type = 'environment'; utc = [DateTime]::UtcNow.ToString('o')
        sessionId = (Get-Process -Id $PID).SessionId
        qpcFrequency = [Diagnostics.Stopwatch]::Frequency
        durationSeconds = $Seconds; requestedIntervalMs = 10
        method = 'Window/PID queries only; no clipboard open or content reads; unknown identities remain unknown'
    } | ConvertTo-Json -Compress))
    while ($timer.Elapsed.TotalSeconds -lt $Seconds) {
        $window = [ClipboardProcessObserver]::GetOpenClipboardWindow()
        [uint32]$openerId = 0
        if ($window -ne [IntPtr]::Zero) {
            [ClipboardProcessObserver]::GetWindowThreadProcessId($window, [ref]$openerId) | Out-Null
        }
        $sequence = [ClipboardProcessObserver]::GetClipboardSequenceNumber()
        $state = "$window/$openerId/$sequence"
        if ($state -ne $lastState) {
            $row = [ordered]@{
                type = 'observation'; utc = [DateTime]::UtcNow.ToString('o')
                qpc = [Diagnostics.Stopwatch]::GetTimestamp(); elapsedMs = $timer.Elapsed.TotalMilliseconds
                window = $window.ToInt64(); processId = $openerId; sequence = $sequence
                processName = $null; creationUtc = $null; executablePath = $null
            }
            if ($openerId -ne 0) {
                try {
                    $proc = Get-Process -Id $openerId -ErrorAction Stop
                    try {
                        $row.processName = $proc.ProcessName
                        $row.creationUtc = $proc.StartTime.ToUniversalTime().ToString('o')
                        $row.executablePath = $proc.Path
                    } finally { $proc.Dispose() }
                } catch { $row.identityError = $_.Exception.GetType().FullName }
                $seen[[string]$openerId] = $true
            }
            $writer.WriteLine(($row | ConvertTo-Json -Compress))
            $lastState = $state
        }
        Start-Sleep -Milliseconds 10
    }
    # Capture service mappings while they still exist; no command lines collected.
    Get-CimInstance Win32_Service | Where-Object { $seen.ContainsKey([string]$_.ProcessId) } | ForEach-Object {
        $writer.WriteLine((@{
            type = 'service'; utc = [DateTime]::UtcNow.ToString('o')
            processId = $_.ProcessId; name = $_.Name; displayName = $_.DisplayName
        } | ConvertTo-Json -Compress))
    }
    $writer.WriteLine((@{type = 'completed'; utc = [DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress))
} finally {
    $writer.Dispose()
    $stream.Dispose()
}
