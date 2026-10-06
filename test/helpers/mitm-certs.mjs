// test/helpers/mitm-certs.mjs — an ephemeral CA + a leaf for a host (the atrace-mkca recipe; throwaway dir, never the
// keychain, never a system trust flag). Exports only: node --test also loads this file and it must run nothing at import.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { tmpDir } from './tmp.mjs'

export function makeCerts(host = 'api.anthropic.com') {
  const dir = tmpDir('asight-ca-')
  const P = (f) => path.join(dir, f)
  const ssl = (...a) => execFileSync('openssl', a, { stdio: 'ignore' })
  ssl('genrsa', '-out', P('ca.key'), '2048')
  ssl('req', '-x509', '-new', '-nodes', '-key', P('ca.key'), '-sha256', '-days', '3', '-subj', '/CN=asight test CA', '-out', P('ca.crt'))
  ssl('genrsa', '-out', P('leaf.key'), '2048')
  ssl('req', '-new', '-key', P('leaf.key'), '-subj', `/CN=${host}`, '-out', P('leaf.csr'))
  fs.writeFileSync(P('leaf.ext'), `subjectAltName=DNS:${host}\nextendedKeyUsage=serverAuth\n`)
  ssl('x509', '-req', '-in', P('leaf.csr'), '-CA', P('ca.crt'), '-CAkey', P('ca.key'), '-CAcreateserial', '-days', '3', '-sha256', '-extfile', P('leaf.ext'), '-out', P('leaf.crt'))
  return { caCert: fs.readFileSync(P('ca.crt')), leaf: { key: fs.readFileSync(P('leaf.key')), cert: fs.readFileSync(P('leaf.crt')) } }
}
