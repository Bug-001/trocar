// test/helpers/certutil-model.mjs — certutil's CurrentUser\Root as the Windows test machine shows it (2026-10-17), for the root-store
// tests: `-user -store Root` lists the user's own store (exit 0, empty or not); `-user -store Root <thumbprint>` of a certificate that is
// not there exits NTE_NOT_FOUND 0x80090011 when node spawns it (0 from a PowerShell prompt): a lookup's exit is not a fact the product reads.
// `-addstore` / `-delstore` change the store. `spaced`: the older listing, `Cert Hash(sha1): ab cd …`. → { run, store: Set(upper-case thumbprints), calls }
import crypto from 'node:crypto'
import fs from 'node:fs'

export const NTE_NOT_FOUND = 0x80090011

export function certutilModel({ store = [], spaced = false } = {}) {
  const have = new Set(store.map((t) => t.toUpperCase())), calls = []
  const entry = (t, i) => [`================ Certificate ${i} ================`, 'Serial Number: 1f2e3d4c', 'Issuer: CN=x', `Cert Hash(sha1): ${spaced ? t.toLowerCase().match(/../g).join(' ') : t.toLowerCase()}`, 'No key provider information'].join('\r\n')
  const listing = () => ['Root "Trusted Root Certification Authorities"', ...[...have].map(entry), 'CertUtil: -store command completed successfully.'].join('\r\n')
  const run = (file, args) => {
    calls.push([file, ...args])
    const [user, verb, name, arg] = args
    if (file !== 'certutil' || user !== '-user' || name !== 'Root') return { status: 87, stdout: '', stderr: `unexpected ${[file, ...args].join(' ')}` }
    if (verb === '-store' && arg == null) return { status: 0, stdout: listing(), stderr: '' }
    if (verb === '-store') return have.has(arg.toUpperCase()) ? { status: 0, stdout: listing(), stderr: '' } : { status: NTE_NOT_FOUND, stdout: '', stderr: 'CertUtil: -store command FAILED: 0x80090011 (-2146893807 NTE_NOT_FOUND)' }
    if (verb === '-addstore') { have.add(new crypto.X509Certificate(fs.readFileSync(arg)).fingerprint.replace(/:/g, '')); return { status: 0, stdout: '', stderr: '' } }
    if (verb === '-delstore') return have.delete(arg.toUpperCase()) ? { status: 0, stdout: '', stderr: '' } : { status: NTE_NOT_FOUND, stdout: '', stderr: '' }
    return { status: 87, stdout: '', stderr: `unexpected verb ${verb}` }
  }
  return { run, store: have, calls }
}
