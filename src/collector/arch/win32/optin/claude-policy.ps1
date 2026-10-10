# claude-policy.ps1 - the opt-in item `cert-store-current-user`, policy half (RFC 4.8 s2.4, plan Task 14):
# the ONE HKCU policy value that is Claude Desktop's only proxy door - egressProxyUrl, an address only
# (no credentials: the form's listener takes none). The prior value (or its absence) was read and ledgered
# before this runs. APPLY ONLY: the undo is an inline function in src/off/win32-optin.mjs. ASCII; this
# script writes nothing but the one named value of the one named key.
param(
    [Parameter(Mandatory = $true)][string]$Url
)
$ErrorActionPreference = 'Stop'
if ($Url -notmatch '^https?://[^\s"]+$') { throw "the policy value is an http address, nothing else: $Url" }
reg add 'HKCU\SOFTWARE\Policies\Claude' /v egressProxyUrl /t REG_SZ /d $Url /f
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
exit 0
