# user-path.ps1 - the file half of the opt-in item `user-path-shim` (RFC 4.8 s2.4 / s6.3, plan Task 14).
# It creates asight's shim directory and writes ONE launch shim into it, from the content asight rendered
# (the base64 of the .cmd bytes). The registry half - the directory first on the user PATH - is NOT this
# script's: it is userpath.mjs's prependUserPath (reg.exe through execTool), so both halves answer to the
# same tests. APPLY ONLY: the undo is an inline function in src/off/win32-optin.mjs, which runs with the
# source tree gone; this script is ASCII, its parameters are its whole surface, and it writes nothing but
# its own directory and its own shim file.
param(
    [Parameter(Mandatory = $true)][string]$BinDir,
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string]$ShimB64
)
$ErrorActionPreference = 'Stop'
try {
    if ($Command -notmatch '^[A-Za-z0-9._-]+$') { throw "the command name is not a plain word: $Command" }
    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    [IO.File]::WriteAllBytes((Join-Path $BinDir ($Command + '.cmd')), [Convert]::FromBase64String($ShimB64))
    exit 0
} catch {
    Write-Error $_
    exit 1
}
