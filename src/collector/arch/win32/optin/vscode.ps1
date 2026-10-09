# vscode.ps1 - the opt-in item `vscode-settings-and-launcher` (RFC 4.8 s2.4, plan Task 14): VS Code's user
# settings get http.proxy (this form's kernel listener) and http.systemCertificates=false - asight computed
# the whole new settings text (a minimal text edit of the user's own file, comments and order kept) and
# hands it here as base64 - and the user's VS Code shortcuts start an asight launcher (it sets the CA file
# Node reads) written here from the content asight rendered. Copies of the settings file and of every
# shortcut were saved before this runs; the undo is an inline function in src/off/win32-optin.mjs. APPLY
# ONLY. ASCII; this script writes nothing but its own settings file, its own launcher and the shortcuts it
# was named.
param(
    [Parameter(Mandatory = $true)][string]$Settings,
    [Parameter(Mandatory = $true)][string]$SettingsB64,
    [Parameter(Mandatory = $true)][string]$Launcher,
    [Parameter(Mandatory = $true)][string]$LauncherB64,
    [string[]]$Shortcut = @()
)
$ErrorActionPreference = 'Stop'
try {
    foreach ($p in @($Settings, $Launcher)) {
        $d = Split-Path -Parent $p
        if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
    }
    [IO.File]::WriteAllBytes($Settings, [Convert]::FromBase64String($SettingsB64))
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
