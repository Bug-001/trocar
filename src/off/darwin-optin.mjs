// darwin-optin.mjs (src/off) — the registry of the darwin user-level opt-in undos (RFC 4.9 §2.4; the flip checklist ④, the twin of
// src/off/win32-optin.mjs): every user-level undo lives HERE, in JavaScript and execTool, with no script file — the standalone
// `asight-off` is made of src/off alone and must take the opt-in items out with the source tree gone (1.6 R3, 0.1 §2). A machine-level
// item does not exist on darwin in v1 (4.9 §2.4: no form needs it), so there is no needs-admin arm here; an entry of a scope this
// registry has no undo for is the win32 twin's unknown-kind: left alone, said, never guessed.
//
// The rc PATH line is the SHARED item the reference count is about (4.9 §2.3's kimi row, 4.8 §6.3's semantics): each command's shim is
// its own file, and the lines + the shim directory go when the LAST shim in them is removed, so `off kimi-code` does not break opencode.
// The count is by shim files that still exist, not by manifest entries — both harnesses' entries are in the manifest while one `off`
// walks them. The line itself is dropped from the CURRENT text (D28: never the pre-asight file written back wholesale); a file the user
// has not touched since the apply is restored from its backup byte for byte (R2's copy, the win32 settings twin's rule).
// The keychain certificate is keyed by its SHA-256 fingerprint end to end (V56: 点名后按指纹可查、按指纹撤销) — see its undo below.
import path from 'node:path'
import crypto from 'node:crypto'
import nodeFs from 'node:fs'
import { removeAsightText, lineComment } from './text-edit.mjs'
import { execTool } from './exec.mjs'
import { certBlocks } from './pem.mjs'

const rcSha256 = (text) => crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
const rcOk = (result, reason) => (reason === undefined ? { ok: true, result } : { ok: true, result, reason })

/** The sentinel PATH line — arch/darwin/optin.mjs rcLineOf's own copy (src/off imports nothing from src/collector, 0.1 §2); the copies
 *  are the contract and test/collector/arch/darwin/optin.test.mjs holds them equal, the way test/off/win32-optin.test.mjs holds the
 *  registry argv twins. ONE text for every command: the line is the shared item. */
export const rcLineOf = (binDir) => `export PATH="${binDir}:$PATH" ${lineComment('runs kimi / opencode through its asight launch shim')}`

/** kind → ({ entry, manifest, exec, env, fs, home }) → { ok, result: 'undone' | 'absent' | 'left' | 'failed', reason? }. One inline
 *  function per user-level darwin kind; a kind with no function here is an item a newer build wrote (the loop says so, never guesses),
 *  and test/collector/arch/darwin/optin.test.mjs holds Object.keys(DARWIN_UNDO_BY_KIND) to the kinds the apply can produce — adding a
 *  kind without its undo is red. */
export const DARWIN_UNDO_BY_KIND = {
  // the rc PATH item: the shim goes now; the lines and the shim directory go with the LAST shim (the reference count)
  'optin-rc-path': async ({ entry, manifest, fs }) => {
    const v = entry.values || {}
    if (!v.command || !v.binDir) return { ok: false, result: 'failed', reason: `${entry.path}: the entry holds no shim to undo` }
    const shim = path.join(v.binDir, v.command)
    try { fs.rmSync(shim, { force: true }) } catch (e) { return { ok: false, result: 'failed', reason: `the shim ${shim} could not be removed (${(e && e.code) || e})` } }
    const others = (manifest && Array.isArray(manifest.entries) ? manifest.entries : [])
      .filter((e) => e && e !== entry && e.kind === 'optin-rc-path' && e.values && e.values.command && e.values.binDir)
      .map((e) => path.join(e.values.binDir, e.values.command))
    if (others.some((p) => fs.existsSync(p))) {
      const names = others.filter((p) => fs.existsSync(p)).map((p) => path.basename(p))
      return rcOk('undone', `${v.command} removed; the PATH lines and the shim directory stay (${names.join(', ')} still resolves through them)`)
    }
    // the last shim: the line goes from every rc file the apply listed — byte for byte from the backup when the user has not touched the
    // file since (R2), else only asight's line goes and the user's own edits stay (D28; removeAsightText's own rule)
    const line = rcLineOf(v.binDir)
    const notes = []
    for (const rc of Array.isArray(v.rcs) ? v.rcs : []) {
      if (!fs.existsSync(rc.file)) { notes.push(`${rc.file} is already gone`); continue }
      const text = fs.readFileSync(rc.file, 'utf8')
      if (rc.backup && rc.post && fs.existsSync(rc.backup) && rcSha256(text) === rc.post) {
        try { fs.copyFileSync(rc.backup, rc.file) } catch (e) { notes.push(`${rc.file} could not be restored from its backup (${(e && e.code) || e}); the line was taken out instead`); fs.writeFileSync(rc.file, removeAsightText(text, [{ inserted: line, removed: '' }]).text) }
        continue
      }
      const r = removeAsightText(text, [{ inserted: line, removed: '' }])
      if (r.found) fs.writeFileSync(rc.file, r.text)
      else notes.push(`${rc.file} no longer holds asight's line`)
    }
    try { fs.rmdirSync(v.binDir) } catch { /* not empty (another file of the user's) or already gone: said by the files themselves */ }
    return rcOk('undone', notes.length ? notes.join('; ') : undefined)
  },

  // the keychain certificate: found, taken out and re-checked by its SHA-256 fingerprint (V56's shape — never the common name, a second
  // certificate of the same name never matches). remove-trusted-cert takes the TRUST setting away (the certificate block the keychain
  // itself holds is dumped by find-certificate, written to one temp file under ~/.asight, removed after), delete-certificate -Z the cert.
  // The temp file is under ~/.asight (which holds the manifest being walked), not TMPDIR — off cleans it in a finally, and a crash there
  // leaves asight's own directory holding one asight-owned file, not the system temp.
  'optin-keychain-cert': async ({ entry, exec = null, env = process.env, fs = nodeFs, home = null }) => {
    const v = entry.values || {}
    if (!v.fp256 || !v.keychain || !home) return { ok: false, result: 'failed', reason: `${entry.path}: the entry holds no fingerprint or keychain to undo by` }
    const dump = execTool('security', ['find-certificate', '-a', '-p', v.keychain], { run: exec, env })
    if (dump.code !== 0) return { ok: false, result: 'failed', reason: `security find-certificate failed (exit ${dump.code ?? 'none'}${dump.err ? `: ${dump.err.slice(0, 200)}` : ''})` }
    const mine = certBlocks(dump.out).find((c) => c.fp === v.fp256)
    if (!mine) return rcOk('absent', 'the certificate is not in the login keychain (already gone)')
    const sha1 = crypto.createHash('sha1').update(new crypto.X509Certificate(mine.pem).raw).digest('hex').toUpperCase()
    const tmp = path.join(home, '.asight', 'collector', 'optin-tmp-cert.pem')
    try {
      fs.mkdirSync(path.dirname(tmp), { recursive: true, mode: 0o700 })
      fs.writeFileSync(tmp, mine.pem, { mode: 0o600 })
      const t = execTool('security', ['remove-trusted-cert', tmp], { run: exec, env, timeoutMs: 120000 }) // the dialog may ask again
      if (t.code !== 0) return { ok: false, result: 'failed', reason: `security remove-trusted-cert failed (exit ${t.code ?? 'none'}${t.err ? `: ${t.err.slice(0, 200)}` : ''})` }
      const d = execTool('security', ['delete-certificate', '-Z', sha1, v.keychain], { run: exec, env, timeoutMs: 120000 })
      if (d.code !== 0) return { ok: false, result: 'failed', reason: `security delete-certificate -Z failed (exit ${d.code ?? 'none'}${d.err ? `: ${d.err.slice(0, 200)}` : ''})` }
      const back = execTool('security', ['find-certificate', '-a', '-p', v.keychain], { run: exec, env })
      if (back.code === 0 && certBlocks(back.out).some((c) => c.fp === v.fp256)) return { ok: false, result: 'failed', reason: 'the removal ran, but the certificate is still in the login keychain' }
      if (back.code !== 0) return rcOk('undone', `the removal ran; the re-check could not read the login keychain (exit ${back.code ?? 'none'})`)
      return rcOk('undone')
    } finally { try { fs.rmSync(tmp, { force: true }) } catch { /* the next run's write replaces it */ } }
  },
}

/** The user-level opt-in items of `manifest` on darwin, undone by kind — the win32 twin's loop, same logic (the standalone bundle needs
 *  every top-level name unique, hence this file's own name and DARWIN_UNDO_BY_KIND's). → `{ results: [{ path, kind, scope, form?, item?,
 *  result, reason? }], needsAdmin: [], unknown: [{ path, kind }] }`; `form` / `item` ride along from the manifest entry so the caller can
 *  say WHICH item a row is. Nothing throws — an item that could not be undone is a result, and the caller decides the exit. */
export async function undoDarwinOptIns({ manifest, ids = null, exec = null, env = process.env, fs = null, home = null } = {}) {
  const out = { results: [], needsAdmin: [], unknown: [] }
  const inScope = (h) => typeof h === 'string' && (ids == null || ids.includes(h))
  for (const e of (manifest && Array.isArray(manifest.entries) ? manifest.entries : [])) {
    if (!e || !e.scope || e.scope === 'agent' || !inScope(e.harness)) continue // the opt-in ones are scope 'user' / 'machine'; an 'agent' entry is the harness undo's own (parseManifest defaults every entry's scope)
    const row = (r) => out.results.push({ path: e.path, kind: e.kind, scope: e.scope, ...(e.form != null && e.item != null ? { form: e.form, item: e.item } : {}), ...r })
    if (e.scope === 'machine') { out.unknown.push({ path: e.path, kind: e.kind }); row({ result: 'unknown-kind', reason: `${e.path} is a machine-level opt-in item, which darwin has no form of in v1 (4.9 §2.4); use the asight that wrote it` }); continue }
    const undo = DARWIN_UNDO_BY_KIND[e.kind]
    if (!undo) { out.unknown.push({ path: e.path, kind: e.kind }); row({ result: 'unknown-kind', reason: `${e.path} is an opt-in item of kind ${JSON.stringify(e.kind)}, which this build has no undo for; use the asight that wrote it` }); continue }
    try { row(await undo({ entry: e, manifest, exec, env, fs: fs || nodeFs, home })) } catch (err) { row({ result: 'failed', reason: String((err && err.message) || err) }) }
  }
  return out
}
