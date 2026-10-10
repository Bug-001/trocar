# cert-user.ps1 - the opt-in item `cert-store-current-user`, certificate half (RFC 4.8 s2.4, plan Task 14):
# asight's CA into the CURRENT USER's Root store. Windows shows its own confirmation box and the user
# answers it - a refusal is the user's own no, the script then exits non-zero and asight records the item
# as opted-in-failed (NOT pending-admin: nobody was asked for administrator rights). certutil is used (not
# Import-Certificate) because the collector's CA file is a PEM and certutil reads one as it is. APPLY ONLY:
# the undo is an inline function in src/off/win32-optin.mjs (delete by thumbprint). ASCII; this script
# touches nothing but the one store.
param(
    [Parameter(Mandatory = $true)][string]$CertFile
)
$ErrorActionPreference = 'Stop'
certutil -user -addstore Root $CertFile
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
exit 0
