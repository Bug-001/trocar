# shortcut.ps1 - the opt-in item `start-menu-launcher` (RFC 4.8 s2.4, plan Task 14): the user's OpenCode
# shortcuts (Start menu, desktop) start asight's launcher instead of the app. The launcher file itself is
# written here from the content asight rendered; each shortcut named on the command line is REPOINTED to it
# (asight has saved a copy of every one of them before this runs - the undo restores that copy, not this
# script's doing). APPLY ONLY: the undo is an inline function in src/off/win32-optin.mjs. ASCII; it writes
# nothing but its own launcher and the shortcuts it was named.
param(
    [Parameter(Mandatory = $true)][string]$Launcher,
    [Parameter(Mandatory = $true)][string]$LauncherB64,
    [Parameter(Mandatory = $true)][string[]]$Shortcut
)
$ErrorActionPreference = 'Stop'
try {
    $d = Split-Path -Parent $Launcher
    if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
    [IO.File]::WriteAllBytes($Launcher, [Convert]::FromBase64String($LauncherB64))
    $shell = New-Object -ComObject WScript.Shell
    foreach ($s in $Shortcut) {
        $lnk = $shell.CreateShortcut($s)
        $lnk.TargetPath = $Launcher
        $lnk.Save()
    }
    exit 0
} catch {
    Write-Error $_
    exit 1
}
