# kimi-marker.ps1 - the per-pid launch-marker writer of the win kimi shim (RFC 4.6 "mark"; the darwin shim's
# `echo ... > trust/$$` door, win twin - a cmd cannot know the pid of the child it runs, and there is no exec).
# Started by kimi.cmd as a hidden background job; this script's PARENT is the cmd.exe interpreting the shim, and
# the kimi.exe the shim runs is that same cmd's child, so the marker names exactly this run's kimi:
#   <MarkerDir>\<kimi pid> = the process creation time in epoch ms UTC (the helper's own convention, procinfo.mjs
#   StartedOf: GetProcessTimes FILETIME -> epoch ms; the tracker tolerates MARKER_TOLERANCE_MS anyway).
# Best effort by contract: every failure is silence, nothing is printed, nothing is broken - a marker that does
# not appear costs this run's capture and nothing else (the mac shim's 2>/dev/null rule).
#   -MarkerDir <dir>   where the tracker reads markers from (asight's <collector>\run\trust)
#   -Image <name>      the image to wait for (default kimi.exe)
#   -WaitSecs <n>      how long to keep looking (default 12; the kimi boots in well under that)
param([string]$MarkerDir, [string]$Image = 'kimi.exe', [int]$WaitSecs = 12)
try {
  if (-not $MarkerDir) { exit 0 }
  $me = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
  if (-not $me) { exit 0 }
  $shimCmd = $me.ParentProcessId
  $deadline = (Get-Date).AddSeconds($WaitSecs)
  while ((Get-Date) -lt $deadline) {
    $kids = Get-CimInstance Win32_Process -Filter "Name='$Image'" -ErrorAction SilentlyContinue |
      Where-Object { $_.ParentProcessId -eq $shimCmd }
    if ($kids) {
      $k = $kids | Sort-Object CreationDate -Descending | Select-Object -First 1
      $ms = [DateTimeOffset]::new($k.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()
      New-Item -ItemType Directory -Force $MarkerDir | Out-Null
      [IO.File]::WriteAllText((Join-Path $MarkerDir ([string]$k.ProcessId)), [string]$ms)
      exit 0
    }
    Start-Sleep -Milliseconds 60
  }
} catch { }
exit 0
