# zcode-desktop.ps1 - the opt-in item `zcode-app-settings` (RFC 4.8 s2.4, plan Task 14): the two keys of
# Z-Code Desktop's own settings file (v2\setting.json) that route the whole app through asight's kernel and
# make it trust asight's CA - httpProxy and httpProxyCaCertPath. asight computed the whole new settings text
# (a minimal text edit of the user's own file, comments and order kept) and hands it here as base64. A copy
# of the file was saved before this runs; the undo is an inline function in src/off/win32-optin.mjs. APPLY
# ONLY. ASCII; this script writes nothing but the one file it was named.
param(
    [Parameter(Mandatory = $true)][string]$File,
    [Parameter(Mandatory = $true)][string]$ContentB64
)
$ErrorActionPreference = 'Stop'
$d = Split-Path -Parent $File
if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
[IO.File]::WriteAllBytes($File, [Convert]::FromBase64String($ContentB64))
exit 0
