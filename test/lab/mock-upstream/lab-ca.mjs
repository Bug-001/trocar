// lab-ca.mjs — a TEST-ONLY CA and server leaf for the mock upstream, made with the openssl CLI
// (OpenSSL 3 on a Linux test machine, LibreSSL on macOS). It exists so clients can reach the mock under real
// provider hostnames; it must never be trusted outside a lab. Usage: node lab-ca.mjs <out-dir>
//
// Both certs are proper X.509 v3 (some clients reject a v1 or extension-less CA): the CA has a
// critical basicConstraints CA:TRUE and keyUsage keyCertSign/cRLSign; the leaf has SANs, EKU
// serverAuth and an AKI. 397 days is the longest validity clients accept for a server cert.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const LAB_HOSTS = ['relay.asight.test', '*.asight.test', 'api.anthropic.com', 'api.openai.com', 'api.deepseek.com',
  'api.moonshot.cn', 'api.moonshot.ai', 'open.bigmodel.cn', 'api.z.ai', 'openrouter.ai', 'localhost']
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

const CA_CNF = `[req]
distinguished_name = dn
prompt = no
[dn]
CN = trocar lab CA - TEST ONLY
[v3_ca]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
`
const LEAF_CNF = `[req]
distinguished_name = dn
prompt = no
[dn]
CN = relay.asight.test
[v3_leaf]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid, issuer
subjectAltName = @alt
[alt]
${LAB_HOSTS.map((h, i) => `DNS.${i + 1} = ${h}`).join('\n')}
IP.1 = 127.0.0.1
`

// A test that needs the lab CA (or openssl as its verifier) spreads `skip: NO_OPENSSL`: false where `openssl version` runs, else the reason.
// The lab CA stands in for a third party's upstream, so it is never made by the code under test (node crypto through src/).
export const NO_OPENSSL = spawnSync('openssl', ['version'], { stdio: 'ignore' }).error ? "the lab CA is made with the openssl CLI, which is not on this host's PATH" : false

// Writes ca.key, ca.crt, leaf.key, leaf.crt into dir and returns their paths.
export function makeLabCa(dir, { days = 397 } = {}) {
  const out = path.resolve(dir)
  if (out === REPO || out.startsWith(REPO + path.sep)) throw new Error(`lab-ca: refusing to write keys inside the repo (${out})`)
  fs.mkdirSync(out, { recursive: true, mode: 0o700 })
  const P = (f) => path.join(out, f)
  const ssl = (...args) => execFileSync('openssl', args, { stdio: ['ignore', 'ignore', 'pipe'] })
  fs.writeFileSync(P('ca.cnf'), CA_CNF)
  fs.writeFileSync(P('leaf.cnf'), LEAF_CNF)
  ssl('genrsa', '-out', P('ca.key'), '2048')
  ssl('req', '-x509', '-new', '-key', P('ca.key'), '-sha256', '-days', String(days), '-config', P('ca.cnf'), '-extensions', 'v3_ca', '-out', P('ca.crt'))
  ssl('genrsa', '-out', P('leaf.key'), '2048')
  ssl('req', '-new', '-key', P('leaf.key'), '-config', P('leaf.cnf'), '-out', P('leaf.csr'))
  ssl('x509', '-req', '-in', P('leaf.csr'), '-CA', P('ca.crt'), '-CAkey', P('ca.key'), '-set_serial', `0x${randomBytes(8).toString('hex')}`,
    '-days', String(days), '-sha256', '-extfile', P('leaf.cnf'), '-extensions', 'v3_leaf', '-out', P('leaf.crt'))
  for (const f of ['ca.key', 'leaf.key']) fs.chmodSync(P(f), 0o600)
  return { caCert: P('ca.crt'), caKey: P('ca.key'), cert: P('leaf.crt'), key: P('leaf.key') }
}

// node --test runs every .mjs under test/ as a test file; only act when run as a real command.
// import.meta.url is the realpath but argv[1] is as typed, so compare realpaths (symlinked checkouts,
// macOS /tmp -> /private/tmp, shared folders).
export const isCommand = (metaUrl) => {
  if (process.env.NODE_TEST_CONTEXT || !process.argv[1]) return false
  try { return fs.realpathSync(process.argv[1]) === fileURLToPath(metaUrl) } catch { return false }
}
if (isCommand(import.meta.url)) {
  if (!process.argv[2]) { console.error('usage: node lab-ca.mjs <out-dir>'); process.exit(2) }
  console.log(JSON.stringify(makeLabCa(process.argv[2]), null, 2))
}
