// sign-helper.swift — asight's macOS key custody (RFC 4.11 P1 `keychain`, plan decision #10), ported from the lab's
// The root's P-256 private key lives in the user's login keychain, not extractable
// and sensitive (the flags at the top level as well, R3-M1); its ACL names this binary, so only this binary signs with it.
// It signs nothing a caller hands it: it BUILDS both certificates itself (CM3) — the root (CA pathLen 1, KU keyCertSign|cRLSign,
// EKU serverAuth, SKI) and the 7-day intermediate (CA pathLen 0, same KU/EKU, SKI, AKI = the root's key, issuer = the root).
//   asight-sign-helper create --subject <cn>        → {"rootDer":b64}        (exit 5 + {"error":"exists"} when a key is there)
//   asight-sign-helper exists                       → {"exists":true|false}
//   asight-sign-helper issue --spki <b64 P-256 SPKI> --serial <hex> --not-before <iso>  → {"certDer":b64}
//   asight-sign-helper remove                       → {"removed":true|false}
// No GUI session (CSSMERR_CSP_NO_USER_INTERACTION over ssh, R3-M3), interaction not allowed, a locked keychain:
// {"error":"unavailable"}, exit 3. No key: {"error":"no-key"}, exit 4. Bad argv: exit 2. Anything else: exit 1.
// Build: scripts/build-darwin-native.sh (universal, pinned in native/pins.json). Never run it in a test: it writes the keychain.
import CryptoKit
import Foundation
import Security

let LABEL = "asight root key"
func emit(_ o: [String: Any], _ code: Int32 = 0) -> Never {
  FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]) + Data([0x0a]))
  exit(code)
}
let UNAVAILABLE: Set<Int> = [Int(errSecInteractionNotAllowed), Int(errSecInteractionRequired), Int(CSSMERR_CSP_NO_USER_INTERACTION)]
func fail(_ st: Int, _ what: String) -> Never {
  if UNAVAILABLE.contains(st) { emit(["error": "unavailable", "status": st], 3) }
  if st == Int(errSecItemNotFound) { emit(["error": "no-key"], 4) }
  emit(["error": "failed", "status": st, "what": what, "message": (SecCopyErrorMessageString(OSStatus(truncatingIfNeeded: st), nil) as String?) ?? ""], 1)
}
func cfFail(_ e: Unmanaged<CFError>?, _ what: String) -> Never { fail(e.map { CFErrorGetCode($0.takeRetainedValue()) } ?? -1, what) }
func usage(_ s: String) -> Never { emit(["error": "usage", "message": s], 2) }

// ---- DER: just what the two certificate shapes need ----
func hx(_ s: String) -> Data { Data(stride(from: 0, to: s.count, by: 2).map { UInt8(s.dropFirst($0).prefix(2), radix: 16)! }) }
func tlv(_ t: UInt8, _ parts: [Data]) -> Data {
  let b = parts.reduce(Data(), +)
  var h = Data([t])
  if b.count < 0x80 { h.append(UInt8(b.count)) } else {
    var n = b.count, l = [UInt8]()
    while n > 0 { l.insert(UInt8(n & 0xff), at: 0); n >>= 8 }
    h.append(0x80 | UInt8(l.count)); h.append(contentsOf: l)
  }
  return h + b
}
func seq(_ p: Data...) -> Data { tlv(0x30, p) }
func octet(_ d: Data) -> Data { tlv(0x04, [d]) }
func integer(_ mag: Data) -> Data {
  var m = Data(mag.drop(while: { $0 == 0 })); if m.isEmpty { m = Data([0]) }
  if m[m.startIndex] & 0x80 != 0 { m.insert(0, at: 0) }
  return tlv(0x02, [m])
}
let TRUE = hx("0101ff"), ECDSA_SHA256 = seq(hx("06082a8648ce3d040302"))
let SPKI_P256 = hx("3059301306072a8648ce3d020106082a8648ce3d030107034200") // + the 65-byte uncompressed point
func name(_ cn: String) -> Data { seq(tlv(0x31, [seq(hx("0603550403"), tlv(0x0c, [Data(cn.utf8)]))])) }
func time(_ d: Date) -> Data {
  let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(identifier: "UTC")
  let y = Calendar(identifier: .gregorian).dateComponents(in: f.timeZone, from: d).year!
  f.dateFormat = y < 2050 ? "yyMMddHHmmss'Z'" : "yyyyMMddHHmmss'Z'"
  return tlv(y < 2050 ? 0x17 : 0x18, [Data(f.string(from: d).utf8)])
}
func keyId(_ point: Data) -> Data { Data(Insecure.SHA1.hash(data: point)) }
func caExtensions(pathLen: UInt8, point: Data) -> [Data] {
  [seq(hx("0603551d13"), TRUE, octet(seq(TRUE, integer(Data([pathLen]))))),          // basicConstraints CA, pathLen (critical)
   seq(hx("0603551d0f"), TRUE, octet(hx("03020106"))),                                // keyUsage keyCertSign|cRLSign (critical)
   seq(hx("0603551d25"), octet(seq(hx("06082b06010505070301")))),                    // EKU serverAuth
   seq(hx("0603551d0e"), octet(octet(keyId(point))))]                                 // subjectKeyId
}
func certificate(key: SecKey, serial: Data, issuer: Data, subject: Data, notBefore: Date, notAfter: Date, point: Data, exts: [Data]) -> Data {
  let tbs = seq(tlv(0xa0, [integer(Data([2]))]), integer(serial), ECDSA_SHA256, issuer, seq(time(notBefore), time(notAfter)),
                subject, SPKI_P256 + point, tlv(0xa3, [tlv(0x30, exts)]))
  var e: Unmanaged<CFError>?
  guard let sig = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, tbs as CFData, &e) as Data? else { cfFail(e, "sign") }
  return seq(tbs, ECDSA_SHA256, tlv(0x03, [Data([0]) + sig]))
}

// ---- the key ----
let query: [String: Any] = [kSecClass as String: kSecClassKey, kSecAttrLabel as String: LABEL,
                            kSecAttrKeyClass as String: kSecAttrKeyClassPrivate]
/// The private key and the root's subject (kept in the key's application tag), or nil when there is none.
func findKey() -> (SecKey, String)? {
  var q = query; q[kSecReturnRef as String] = true; q[kSecReturnAttributes as String] = true
  var r: CFTypeRef?
  let st = SecItemCopyMatching(q as CFDictionary, &r)
  if st == errSecItemNotFound { return nil }
  if st != errSecSuccess { fail(Int(st), "find") }
  let d = r as! [String: Any]
  guard let tag = d[kSecAttrApplicationTag as String] as? Data, let cn = String(data: tag, encoding: .utf8) else { fail(-1, "the key has no subject tag") }
  return (d[kSecValueRef as String] as! SecKey, cn)
}
func pointOf(_ k: SecKey) -> Data {
  var e: Unmanaged<CFError>?
  guard let p = SecKeyCopyPublicKey(k), let d = SecKeyCopyExternalRepresentation(p, &e) as Data? else { cfFail(e, "public key") }
  return d
}
func randomSerial() -> Data { var b = [UInt8](repeating: 0, count: 16); _ = SecRandomCopyBytes(kSecRandomDefault, 16, &b); b[0] &= 0x7f; return Data(b) }
func arg(_ flag: String) -> String {
  let a = CommandLine.arguments
  guard let i = a.firstIndex(of: flag), i + 1 < a.count else { usage("missing \(flag)") }
  return a[i + 1]
}
func iso(_ s: String) -> Date? {
  let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  if let d = f.date(from: s) { return d }
  f.formatOptions = [.withInternetDateTime]; return f.date(from: s)
}

let DAY: TimeInterval = 86400
switch CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "" {
case "create":
  let cn = arg("--subject")
  if findKey() != nil { emit(["error": "exists"], 5) }
  let flags: [String: Any] = [kSecAttrIsExtractable as String: false, kSecAttrIsSensitive as String: true]
  let priv = flags.merging([kSecAttrIsPermanent as String: true, kSecAttrLabel as String: LABEL,
                            kSecAttrApplicationTag as String: Data(cn.utf8)]) { $1 }
  let attrs = flags.merging([kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeySizeInBits as String: 256,
                             kSecPrivateKeyAttrs as String: priv]) { $1 }
  var e: Unmanaged<CFError>?
  guard let k = SecKeyCreateRandomKey(attrs as CFDictionary, &e) else { cfFail(e, "create") }
  let now = Date(), point = pointOf(k)
  let root = certificate(key: k, serial: randomSerial(), issuer: name(cn), subject: name(cn), notBefore: now - DAY,
                         notAfter: now + 3650 * DAY, point: point, exts: caExtensions(pathLen: 1, point: point))
  emit(["rootDer": root.base64EncodedString()])
case "exists":
  emit(["exists": findKey() != nil])
case "issue":
  guard let spki = Data(base64Encoded: arg("--spki")), spki.count == SPKI_P256.count + 65, spki.prefix(SPKI_P256.count) == SPKI_P256
  else { usage("--spki is not a P-256 SubjectPublicKeyInfo") }
  let serialHex = arg("--serial")
  guard serialHex.count % 2 == 0, (2...40).contains(serialHex.count), serialHex.allSatisfy(\.isHexDigit) else { usage("--serial is not 1-20 bytes of hex") }
  guard let nb = iso(arg("--not-before")) else { usage("--not-before is not an ISO 8601 time") }
  guard let found = findKey() else { emit(["error": "no-key"], 4) }
  let (k, cn) = found
  let point = spki.suffix(65), rootPoint = pointOf(k)
  let aki = seq(hx("0603551d23"), octet(seq(tlv(0x80, [keyId(rootPoint)]))))
  let subject = name("asight intermediate \(ISO8601DateFormatter().string(from: nb))")
  let cert = certificate(key: k, serial: hx(serialHex), issuer: name(cn), subject: subject, notBefore: nb, notAfter: nb + 7 * DAY,
                         point: Data(point), exts: caExtensions(pathLen: 0, point: Data(point)) + [aki])
  emit(["certDer": cert.base64EncodedString()])
case "remove":
  let st = SecItemDelete(query as CFDictionary)
  if st != errSecSuccess && st != errSecItemNotFound { fail(Int(st), "remove") }
  emit(["removed": st == errSecSuccess])
default:
  usage("asight-sign-helper create --subject <cn> | exists | issue --spki <b64> --serial <hex> --not-before <iso> | remove")
}
