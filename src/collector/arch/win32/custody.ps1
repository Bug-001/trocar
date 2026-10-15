# custody.ps1 - asight's Windows key custody (RFC 4.11 P1 `cng`, plan decision #9), one-shot: one verb per run, then exit. Ported from
# the Windows test machine's signing and certificate-chain scripts.
# The root's P-256 private key is a CNG key with ExportPolicy None, on the Microsoft Platform Crypto Provider (the TPM) when one takes it,
# else the Software KSP (R3-W1). It signs nothing a caller hands it: it BUILDS both certificates itself (CM3) and signs them through
# X509SignatureGenerator (R3-W2) - the root (CA pathLen 1, KU keyCertSign|cRLSign, EKU serverAuth, SKI) and the 7-day intermediate
# (CA pathLen 0, same KU/EKU, SKI, AKI = the root's key, issuer = the root's encoded subject, kept on the key as a persisted property).
# The argv is core/tls/custody-cli.mjs's, the same as the macOS helper's:
#   create --subject <cn>                                          -> {"rootDer":b64,"provider":...}  (exit 5 + {"error":"exists"} when a key is there)
#   exists                                                         -> {"exists":true|false}
#   issue --spki <b64 P-256 SPKI> --serial <hex> --not-before <iso> -> {"certDer":b64}
#   remove                                                         -> {"removed":true|false}
# No provider that opens: {"error":"unavailable"}, exit 3. No key: {"error":"no-key"}, exit 4. Bad argv: exit 2. Anything else: exit 1.
# Windows PowerShell 5.1 on .NET Framework 4.7.2+ (CertificateRequest, X509SignatureGenerator). Never run in a test: it writes the user's key store.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$C = 'System.Security.Cryptography'; $X = 'System.Security.Cryptography.X509Certificates'
$KeyName = 'asight root key'
$NameProp = 'asight-root-name'
$SpkiP256 = [Convert]::FromBase64String('MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgA=') # the 26-byte head of a P-256 SubjectPublicKeyInfo, before the 65-byte point

function Emit($o, [int]$code = 0) { [Console]::Out.WriteLine((ConvertTo-Json -InputObject $o -Compress)); exit $code }
function Usage([string]$why) { Emit ([ordered]@{ error = 'usage'; message = $why }) 2 }
trap { Emit ([ordered]@{ error = 'failed'; message = [string]$_.Exception.Message }) 1 }
$Verb = if ($args.Count -gt 0) { [string]$args[0] } else { '' }
$script:argv = $args
function ArgOf([string]$flag) { for ($i = 1; $i -lt $script:argv.Count - 1; $i++) { if ($script:argv[$i] -eq $flag) { return [string]$script:argv[$i + 1] } }; Usage ($flag + ' is missing') }

$Providers = @()
foreach ($p in @('Microsoft Platform Crypto Provider', 'Microsoft Software Key Storage Provider')) { try { $Providers += ,(New-Object ($C + '.CngProvider') $p) } catch { } }
if ($Providers.Count -eq 0) { Emit ([ordered]@{ error = 'unavailable'; message = 'no CNG key storage provider opens' }) 3 }

# the key and the provider it lives on, or $null
function Find-Key { foreach ($p in $Providers) { try { if ([System.Security.Cryptography.CngKey]::Exists($KeyName, $p)) { return [System.Security.Cryptography.CngKey]::Open($KeyName, $p) } } catch { } }; return $null }
function Point-Of($key) { $b = $key.Export([System.Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob); return ,[byte[]](@(4) + $b[8..($b.Length - 1)]) } # BCRYPT_ECCKEY_BLOB: 8-byte header, X, Y
function PublicKey-Of([byte[]]$point) {
  $curve = New-Object ($C + '.AsnEncodedData') (,[byte[]](0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07))
  New-Object ($X + '.PublicKey') (New-Object ($C + '.Oid') '1.2.840.10045.2.1'), $curve, (New-Object ($C + '.AsnEncodedData') (,$point))
}
function Ski-Of($pub) { New-Object ($X + '.X509SubjectKeyIdentifierExtension') $pub, $false }
# the CA extensions both profiles share (core/tls/cert.mjs caExtensions): BC CA:true pathLen, KU keyCertSign|cRLSign, EKU serverAuth alone, SKI
function Request-Of($name, $pub, [int]$pathLen) {
  $req = New-Object ($X + '.CertificateRequest') $name, $pub, ([System.Security.Cryptography.HashAlgorithmName]::SHA256)
  $req.CertificateExtensions.Add((New-Object ($X + '.X509BasicConstraintsExtension') $true, $true, $pathLen, $true))
  $req.CertificateExtensions.Add((New-Object ($X + '.X509KeyUsageExtension') ([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]'KeyCertSign,CrlSign'), $true))
  $oids = New-Object ($C + '.OidCollection'); [void]$oids.Add((New-Object ($C + '.Oid') '1.3.6.1.5.5.7.3.1'))
  $req.CertificateExtensions.Add((New-Object ($X + '.X509EnhancedKeyUsageExtension') $oids, $false))
  $req.CertificateExtensions.Add((Ski-Of $pub))
  return $req
}
function Serial-Random { $s = New-Object byte[] 16; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($s); $s[0] = $s[0] -band 0x7F; if ($s[0] -eq 0) { $s[0] = 1 }; return ,$s } # the leading comma keeps a byte[] (PowerShell unrolls a returned array)
function Hex-Bytes([string]$h) { $b = New-Object byte[] ($h.Length / 2); for ($i = 0; $i -lt $b.Length; $i++) { $b[$i] = [Convert]::ToByte($h.Substring($i * 2, 2), 16) }; return ,$b }

switch ($Verb) {
  'create' {
    $subject = ArgOf '--subject'
    if ($null -ne (Find-Key)) { Emit ([ordered]@{ error = 'exists' }) 5 }
    $name = New-Object ($X + '.X500DistinguishedName') ('CN=' + $subject.Replace('"', '').Replace(',', ' '))
    $key = $null; $prov = $null; $last = $null
    foreach ($p in $Providers) { # the TPM first; a provider that will not create the key, or keep its property, gives way to the next
      try {
        $kp = New-Object ($C + '.CngKeyCreationParameters')
        $kp.Provider = $p
        $kp.ExportPolicy = [System.Security.Cryptography.CngExportPolicies]::None
        $kp.KeyUsage = [System.Security.Cryptography.CngKeyUsages]::Signing
        $k = [System.Security.Cryptography.CngKey]::Create([System.Security.Cryptography.CngAlgorithm]::ECDsaP256, $KeyName, $kp)
        try { $k.SetProperty((New-Object ($C + '.CngProperty') $NameProp, $name.RawData, ([System.Security.Cryptography.CngPropertyOptions]::Persist))) }
        catch { try { $k.Delete() } catch { }; throw }
        $key = $k; $prov = $p.Provider; break
      } catch { $last = $_.Exception.Message }
    }
    if ($null -eq $key) { Emit ([ordered]@{ error = 'unavailable'; message = ('no provider created the key: ' + $last) }) 3 }
    $pub = PublicKey-Of (Point-Of $key)
    $gen = [System.Security.Cryptography.X509Certificates.X509SignatureGenerator]::CreateForECDsa((New-Object ($C + '.ECDsaCng') $key))
    $now = [DateTimeOffset]::UtcNow
    $root = (Request-Of $name $pub 1).Create($name, $gen, $now.AddDays(-1), $now.AddDays(3650), (Serial-Random))
    Emit ([ordered]@{ rootDer = [Convert]::ToBase64String($root.RawData); provider = $prov })
  }
  'exists' { Emit ([ordered]@{ exists = ($null -ne (Find-Key)) }) }
  'issue' {
    $spki = [Convert]::FromBase64String((ArgOf '--spki'))
    if ($spki.Length -ne $SpkiP256.Length + 65 -or [Convert]::ToBase64String($spki, 0, $SpkiP256.Length) -ne [Convert]::ToBase64String($SpkiP256)) { Usage '--spki is not a P-256 SubjectPublicKeyInfo' }
    $serialHex = ArgOf '--serial'
    if ($serialHex -notmatch '^([0-9a-fA-F]{2}){1,20}$') { Usage '--serial is not 1-20 bytes of hex' }
    $nb = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse((ArgOf '--not-before'), [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$nb)) { Usage '--not-before is not an ISO 8601 time' }
    $key = Find-Key
    if ($null -eq $key) { Emit ([ordered]@{ error = 'no-key' }) 4 }
    $issuer = New-Object ($X + '.X500DistinguishedName') (,[byte[]]$key.GetProperty($NameProp, ([System.Security.Cryptography.CngPropertyOptions]::Persist)).GetValue())
    $pub = PublicKey-Of ([byte[]]$spki[$SpkiP256.Length..($spki.Length - 1)])
    $req = Request-Of (New-Object ($X + '.X500DistinguishedName') ('CN=asight intermediate ' + $nb.UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ssZ'))) $pub 0
    $aki = [byte[]]((0x30, 0x16, 0x80, 0x14) + (Ski-Of (PublicKey-Of (Point-Of $key))).RawData[2..21]) # AKI [0] keyIdentifier = the root's SKI (the SKI extension's value is 04 14 <20 bytes>)
    $req.CertificateExtensions.Add((New-Object ($X + '.X509Extension') '2.5.29.35', $aki, $false))
    $gen = [System.Security.Cryptography.X509Certificates.X509SignatureGenerator]::CreateForECDsa((New-Object ($C + '.ECDsaCng') $key))
    $cert = $req.Create($issuer, $gen, $nb, $nb.AddDays(7), (Hex-Bytes $serialHex))
    Emit ([ordered]@{ certDer = [Convert]::ToBase64String($cert.RawData) })
  }
  'remove' {
    $removed = $false
    foreach ($p in $Providers) { try { if ([System.Security.Cryptography.CngKey]::Exists($KeyName, $p)) { ([System.Security.Cryptography.CngKey]::Open($KeyName, $p)).Delete(); $removed = $true } } catch { Emit ([ordered]@{ error = 'remove-failed'; message = $_.Exception.Message }) 1 } }
    Emit ([ordered]@{ removed = $removed })
  }
  default { Usage 'custody.ps1 create --subject <cn> | exists | issue --spki <b64> --serial <hex> --not-before <iso> | remove' }
}
