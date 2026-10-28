param([Parameter(Mandatory=$true)][string]$Helper)
$ErrorActionPreference = "Stop"
# Run on a real Windows GPU. No CPU frame download or Electron mock is used.
# The parent integration suite must additionally import and capture these frames.
$start = [System.Diagnostics.ProcessStartInfo]::new((Resolve-Path $Helper).Path)
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardInput = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.Arguments = "--lumen-parent-pid=$PID --lumen-width=320 --lumen-height=180 --lumen-test-pattern --no-config --load-scripts=no --idle=yes --no-terminal"
$child = [System.Diagnostics.Process]::Start($start)
$diagnostics = $child.StandardError.ReadToEndAsync()
$child.StandardInput.NewLine = "`n"
function Read-Message {
    $pending = $child.StandardOutput.ReadLineAsync()
    if (-not $pending.Wait(10000)) { throw "Timed out waiting for helper output" }
    if ($null -eq $pending.Result) { throw "Helper closed stdout" }
    $message = $pending.Result | ConvertFrom-Json
    if ($message.type -eq "error") { throw $message.message }
    return $message
}
function Assert-Frame($frame, $width, $height) {
    if ($frame.type -ne "frame" -or $frame.width -ne $width -or $frame.height -ne $height -or
        $frame.sequence -le 0 -or $frame.handle -notmatch '^[1-9][0-9]*$') {
        throw "Invalid frame: $($frame | ConvertTo-Json -Compress)"
    }
}
try {
    if ((Read-Message).type -ne "ready") { throw "Missing ready" }
    $first = Read-Message
    Assert-Frame $first 320 180
    $child.StandardInput.WriteLine("resize 640 360")
    $second = Read-Message
    Assert-Frame $second 640 360
    $child.StandardInput.WriteLine("resize 800 450")
    $third = Read-Message
    Assert-Frame $third 800 450
    $child.StandardInput.WriteLine("resize 960 540")
    $pending = $child.StandardOutput.ReadLineAsync()
    if ($pending.Wait(250)) { throw "Published a fourth occupied texture" }
    # No importer exists in this transport-only test, so no GPU consumer owns it.
    $child.StandardInput.WriteLine("release $($first.sequence)")
    if (-not $pending.Wait(10000)) { throw "Resize did not repaint after release" }
    $fourth = $pending.Result | ConvertFrom-Json
    Assert-Frame $fourth 960 540
    if ($fourth.sequence -le $third.sequence) { throw "Non-monotonic sequence" }
    $child.StandardInput.WriteLine("release $($first.sequence)")
    $errorLine = $child.StandardOutput.ReadLineAsync()
    if (-not $errorLine.Wait(5000)) { throw "Missing protocol failure" }
    if (($errorLine.Result | ConvertFrom-Json).type -ne "error") { throw "Duplicate release accepted" }
    if (-not $child.WaitForExit(5000)) { throw "Shutdown exceeded deadline" }
    if ($child.ExitCode -eq 0) { throw "Malformed protocol exited successfully" }
    Write-Output "Three-slot transport, resize, sequence, duplicate-release and shutdown checks passed"
} finally {
    if (-not $child.HasExited) { $child.Kill(); $child.WaitForExit() }
    Write-Output $diagnostics.GetAwaiter().GetResult()
    $child.Dispose()
}
