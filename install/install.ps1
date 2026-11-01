# trocar installer for Windows (spec 4.5 section A, D74):
#   powershell -NoProfile -ExecutionPolicy Bypass -c "irm <url>/install.ps1 | iex"
# It places the npm tarball of trocar and a pinned official Node under ~\.trocar\app, checks both against their hashes before
# anything runs, then hands over to `trocar install` (first time) or `trocar update`. Machine state is never touched here.
# The body is one script block: a truncated download does not parse and runs nothing. Under iex it never calls exit;
# with -File it sets the exit code (0 done, 1 failed, 2 refused). Options: -Check, -Stage (as install.sh's --check, --stage).
# Outside FullLanguage (Constrained Language Mode) it refuses first: `trocar install` needs FullLanguage too.
# Pure ASCII with no BOM, so Windows PowerShell 5.1 reads it the same in every code page.
& {
# >>> SOURCES (the data lines equal install.sh's, line for line: release check `installer`)
$SOURCES = @'
package trocar-cli
registry https://registry.npmjs.org
registry https://registry.npmmirror.com
node https://nodejs.org/dist
node https://npmmirror.com/mirrors/node
'@
# <<< SOURCES
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072 } catch { }
$st = @{ code = 1; curl = $null; tar = $null }

function Say([string]$m) { try { [Console]::Error.WriteLine($m) } catch { Write-Host $m } }
function Fail([string]$m) { $st.code = 1; throw $m }
function Refuse([string]$m) { $st.code = 2; throw $m }
function List([string]$k) { @($SOURCES -split "`n" | ForEach-Object { $f = $_.Trim() -split ' '; if ($f[0] -eq $k) { $f[1] } }) }
function Bases([string]$envName, [string]$k) { $e = [Environment]::GetEnvironmentVariable($envName); if ($e) { @($e -split ' ' | Where-Object { $_ }) } else { List $k } }
function HostOf([string]$u) { ($u -replace '^[a-z]+://', '') -replace '/.*$', '' }
# https only; plain http only to this machine (tests, a local mirror)
function UrlOk([string]$u) { $u -match '^https://' -or $u -match '^http://(127\.0\.0\.1|localhost|\[::1\])([:/]|$)' }
function Older([string]$a, [string]$b) { # true when version $a is older than $b (major.minor.patch)
  $x = $a -split '[.+-]'; $y = $b -split '[.+-]'
  for ($i = 0; $i -lt 3; $i++) { if ([int]$x[$i] -lt [int]$y[$i]) { return $true }; if ([int]$x[$i] -gt [int]$y[$i]) { return $false } }
  $false
}
function Hash([string]$algo, [string]$file) { (Get-FileHash -LiteralPath $file -Algorithm $algo).Hash.ToLowerInvariant() }
function B64Hex([string]$b) { (([Convert]::FromBase64String($b)) | ForEach-Object { $_.ToString('x2') }) -join '' }
function Proxy([string]$u) { # HTTPS_PROXY / ALL_PROXY, else the system proxy (WinINET, read only: D43 D49)
  foreach ($n in 'HTTPS_PROXY', 'ALL_PROXY') { $p = [Environment]::GetEnvironmentVariable($n); if ($p) { return $p } }
  try { $p = [Net.WebRequest]::GetSystemWebProxy().GetProxy([Uri]$u).AbsoluteUri; if ($p -and $p.TrimEnd('/') -ne $u.TrimEnd('/')) { return $p } } catch { }
  $null
}
function RunCurl([string[]]$a, [string]$u) { # runs curl.exe; returns its exit code
  $base = @('-fL', '--connect-timeout', '10', '--retry', '2')
  if ($u -match '^https://') { $base += @('--proto', '=https', '--proto-redir', '=https', '--tlsv1.2') } else { $base += @('--proto', '=http') }
  $p = Proxy $u
  if ($p) { $base += @('-x', $p) }
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $exe = $st.curl
  try { & $exe @base @a $u 2>$null | Out-Null } finally { $ErrorActionPreference = $eap }
  $LASTEXITCODE
}
function GetText([string]$u) { # body or $null
  if (-not (UrlOk $u)) { return $null }
  if ($st.curl) {
    $tmp = Join-Path $env:TEMP "trocar-meta-$PID.json"
    try { if ((RunCurl @('-sS', '--max-time', '30', '-o', $tmp) $u) -eq 0) { return [IO.File]::ReadAllText($tmp) } } finally { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
  }
  try { return (Invoke-WebRequest -UseBasicParsing -Uri $u -TimeoutSec 30).Content } catch { return $null }
}
function Download([string]$want, [string]$algo, [string]$out, [string[]]$urls) { # verified bytes at $out, or one reason line per source
  $part = Join-Path $st.app ".dl\$want.part"
  $slow = @($urls)
  foreach ($pass in 1, 2) {
    $todo = $slow; $slow = @()
    foreach ($u in $todo) {
      if (-not (UrlOk $u)) { Say "  $(HostOf $u): not https, skipped."; continue }
      for ($try = 0; $try -lt 2; $try++) {
        if ((Test-Path -LiteralPath $part) -and (Hash $algo $part) -eq $want) { Move-Item -LiteralPath $part -Destination $out -Force; return }
        $rc = 1
        if ($st.curl) { $floor = if ($pass -eq 1) { @('51200', '15') } else { @('1024', '30') }; $rc = RunCurl @('-sS', '-C', '-', '--speed-limit', $floor[0], '--speed-time', $floor[1], '-o', $part) $u }
        if ($rc -ne 0 -and $rc -ne 28 -and $rc -ne 33) { # no curl.exe, or one that cannot connect (an old one fails revocation checks): Invoke-WebRequest, which cannot resume
          try { Invoke-WebRequest -UseBasicParsing -Uri $u -OutFile $part; $rc = 0 } catch { }
        }
        if ((Test-Path -LiteralPath $part) -and (Hash $algo $part) -eq $want) { Move-Item -LiteralPath $part -Destination $out -Force; return }
        if ($rc -eq 28) { $slow += $u; Say "  $(HostOf $u): too slow, trying the next source."; break }
        if ($rc -ne 0 -and $rc -ne 33) { Say "  $(HostOf $u): download failed (error $rc)."; break }
        Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
        if ($try -eq 1) { Say "  $(HostOf $u): the bytes do not match the expected hash." }
      }
    }
    if (-not $slow.Count) { break }
  }
  Fail "Could not download $(Split-Path -Leaf $out) from any source. Nothing changed."
}
function Place([string]$from, [string]$to) { # Move-Item, retried while Defender scans a fresh exe
  for ($i = 0; ; $i++) {
    try { Move-Item -LiteralPath $from -Destination $to; return } catch [IO.IOException], [UnauthorizedAccessException] { if ($i -ge 10) { throw }; Start-Sleep -Milliseconds 500 }
  }
}
function Gate([string]$exe, [string[]]$a, [string]$want, [string]$what) {
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $got = (& $exe @a 2>&1 | Out-String).Trim() } catch { Fail "Windows blocked this program in your profile: $($_.Exception.Message)" } finally { $ErrorActionPreference = $eap }
  if ($got -ne $want) { Fail "$what does not run here: $got" }
}

function Handoff([string]$root, [string]$verb) { # `trocar install` / `update` on a terminal, else the command to run
  $bin = Join-Path $root 'bin'
  $other = Get-Command trocar -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($other -and $other.Source -ne "$bin\trocar.cmd") { Say "Another trocar is on your PATH: $($other.Source). It is found before $bin\trocar.cmd until you remove it." }
  $tty = $false
  try { $tty = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected } catch { }
  if (-not $tty) { Say "Next: $bin\trocar.cmd $verb"; return }
  $env:Path = "$env:Path;$bin" # this session only; `trocar install` adds it for good
  & "$bin\trocar.cmd" $verb
  $st.code = $LASTEXITCODE; if ($st.code) { throw "trocar $verb exited with $($st.code)." }
}

function Main([string[]]$argv) {
  if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { Refuse "PowerShell runs in $($ExecutionContext.SessionState.LanguageMode) here (an application control policy): trocar needs FullLanguage. Nothing changed." }
  $mode = 'install'
  foreach ($a in $argv) {
    switch ($a) { '-Check' { $mode = 'check' } '-Stage' { $mode = 'stage' } default { Refuse "Unknown option: $a. Usage: install.ps1 [-Check | -Stage]" } }
  }
  $envKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
  $arch = switch ((Get-ItemProperty -LiteralPath $envKey).PROCESSOR_ARCHITECTURE) { 'AMD64' { 'x64' } 'ARM64' { 'arm64' } default { $null } }
  if (-not $arch) { Refuse 'This CPU is not supported: trocar needs x64 or arm64.' }
  $build = [int](Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').CurrentBuildNumber
  if ($build -lt 17763) { Refuse "This Windows (build $build) is too old: trocar needs Windows 10 1809 or later." }
  $target = "win-$arch"
  $sys = Join-Path $env:SystemRoot 'System32'
  if (Test-Path -LiteralPath "$sys\curl.exe") { $st.curl = "$sys\curl.exe" }
  if (-not (Test-Path -LiteralPath "$sys\tar.exe")) { Refuse "$sys\tar.exe is missing: trocar needs the tar that ships with Windows." }
  $tar = "$sys\tar.exe"
  $root = Join-Path $env:USERPROFILE '.trocar'
  $app = Join-Path $root 'app'; $st.app = $app
  $pkg = @(List 'package')[0]

  $regs = @(Bases 'TROCAR_REGISTRY' 'registry')
  $v = $null
  foreach ($r in $regs) {
    $r = $r.TrimEnd('/')
    $body = GetText "$r/$pkg/latest"
    if ($null -eq $body) { Say "  $(HostOf $r): the package record could not be read."; continue }
    try { $m = $body | ConvertFrom-Json; $tball = [string]$m.dist.tarball; $integ = [string]$m.dist.integrity } catch { $tball = ''; $integ = '' }
    if ($integ.StartsWith("sha512-") -and $tball -match "/$([regex]::Escape($pkg))-([0-9][0-9A-Za-z.+-]*)\.tgz$") {
      $v = $Matches[1]; $hex = B64Hex $integ.Substring(7)
      if ($r -ne $regs[0].TrimEnd('/')) { Say "Verified against $(HostOf $r)'s package record." }
      break
    }
    Say "  $(HostOf $r): the package record has no usable tarball or sha512 integrity."
  }
  if (-not $v) { Fail 'Could not read the trocar package record from any registry. Nothing changed.' }
  if ($mode -eq 'check') { "trocar-installer: latest $v"; return }

  $cur = $null, $null
  if (Test-Path -LiteralPath "$app\current") { $cur = @(((Get-Content -LiteralPath "$app\current" -TotalCount 1) -split ' ') + $null)[0, 1] }
  if ($cur[0] -eq $v -and $cur[1] -and (Test-Path -LiteralPath "$app\node\$($cur[1])\node.exe")) {
    if ($mode -eq 'stage') { "trocar-installer: up-to-date $v"; return }
    Say "trocar $v is already installed: $root\bin\trocar.cmd"
    Handoff $root 'update' # a first run whose `trocar install` was cancelled leaves the pointer: the re-run still says what comes next
    return
  }
  if ($cur[0] -and (Older $v $cur[0])) {
    Say "The package record ($v) is older than the installed trocar ($($cur[0])); a mirror has not caught up yet. Nothing changed."
    if ($mode -eq 'stage') { "trocar-installer: up-to-date $($cur[0])" }
    return
  }

  New-Item -ItemType Directory -Force -Path "$app\.dl", "$app\node" | Out-Null
  Get-ChildItem -LiteralPath $app -Directory -Filter '.staging-*' | ForEach-Object { # leftovers of runs whose process is gone
    $p = $_.Name.Substring(9)
    if ($p -match '^\d+$' -and -not (Get-Process -Id ([int]$p) -ErrorAction SilentlyContinue)) { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
  }
  $stage = Join-Path $app ".staging-$PID"
  New-Item -ItemType Directory -Path $stage | Out-Null
  try {
    $pkgdir = "$app\$v"
    if (-not (Test-Path -LiteralPath "$pkgdir\bin\trocar.mjs")) {
      if (Test-Path -LiteralPath $pkgdir) { Fail "$pkgdir is incomplete: remove it, then run this again." }
      $urls = @($tball) + @($regs | ForEach-Object { "$($_.TrimEnd('/'))/$pkg/-/$pkg-$v.tgz" } | Where-Object { $_ -ne $tball })
      Say "Downloading trocar $v..."
      Download $hex 'SHA512' "$stage\pkg.tgz" $urls
      New-Item -ItemType Directory -Path "$stage\pkg" | Out-Null
      & $tar -xzf "$stage\pkg.tgz" -C "$stage\pkg"
      if ($LASTEXITCODE -ne 0) { Fail "The trocar $v package did not unpack. Nothing changed." }
      Move-Item -LiteralPath "$stage\pkg\package" -Destination "$stage\$v"
      $pkgdir = "$stage\$v"
    }
    $line = Get-Content -LiteralPath "$pkgdir\install\node.sha256" -ErrorAction SilentlyContinue | Where-Object { $_ -match "  node-v\S+-$target\.zip$" } | Select-Object -First 1
    if (-not $line) { Fail "trocar $v names no Node build for $target. Nothing changed." }
    $nhex, $nfile = $line -split '  '
    $nver = $nfile -replace '^node-v', '' -replace "-$target\.zip$", ''
    $nid = "$nver-$target"
    $ndir = "$app\node\$nid"
    if (-not (Test-Path -LiteralPath "$ndir\node.exe")) {
      $urls = @(Bases 'TROCAR_NODE_MIRROR' 'node' | ForEach-Object { "$($_.TrimEnd('/'))/v$nver/$nfile" })
      Say "Downloading Node $nver for $target..."
      Download $nhex 'SHA256' "$stage\$nfile" $urls
      New-Item -ItemType Directory -Path "$stage\nx", "$stage\node" | Out-Null
      & $tar -xf "$stage\$nfile" -C "$stage\nx" "node-v$nver-$target/node.exe"
      if ($LASTEXITCODE -ne 0) { Fail "The Node $nver archive did not unpack. Nothing changed." }
      Move-Item -LiteralPath "$stage\nx\node-v$nver-$target\node.exe" -Destination "$stage\node\node.exe"
      $ndir = "$stage\node"
    }
    # the gates replace any OS-version table: a Node or a trocar that does not start here stops the install before it is placed
    Gate "$ndir\node.exe" @('--version') "v$nver" "This Node build ($nver)"
    Gate "$ndir\node.exe" @("$pkgdir\bin\trocar.mjs", '--version') "trocar $v" "trocar $v on Node $nver"
    if (-not (Test-Path -LiteralPath "$app\node\$nid\node.exe")) { Place "$stage\node" "$app\node\$nid" }
    if (-not (Test-Path -LiteralPath "$app\$v\bin\trocar.mjs")) { Place "$stage\$v" "$app\$v" }
  } finally { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
  if ($mode -eq 'stage') { "trocar-installer: staged $v $app\$v"; return }

  $verb = if ($cur[0]) { 'update' } else { 'install' }
  & "$app\node\$nid\node.exe" "$app\$v\bin\trocar.mjs" place "$app\$v"
  if ($LASTEXITCODE -ne 0) { Fail "Could not switch to trocar $v (trocar place failed). The version that was active stays active." }
  Handoff $root $verb
}

$rc = 0
try { Main $args } catch { Say "$($_.Exception.Message)"; $rc = $st.code }
if ({}.File) { exit $rc } # the file this block was parsed from: the .ps1 under -File, none under iex (at a prompt or inside a caller's .ps1)
} @args
