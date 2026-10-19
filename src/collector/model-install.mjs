// model-install.mjs — `asight install` on macOS and Windows (RFC 4.11 §1「install」, P1–P4, P8, P9; 1.6 §1.6; plan T20). Everything here is
// user-level and phase 'install': the root's key in its custody, the root in the user's root store, the certificate carriers of every PRESENT form,
// asight-ca.pem, the standalone asight-off, the autostart unit. Never a login-environment variable (CM26), never an admin step (CM25).
// Idempotent (D54): an item already there and unchanged is not written again, the root store is read back by fingerprint before an add (no
// prompt), so `install; install` changes no byte and makes no second key. The world is injected (0.1 §3): custody, rootStore, the sources ctx,
// owns(), the wrapper kit, fs, now. The caller holds op.lock and has refused root and a v2 manifest.
import nodeFs from 'node:fs'
import path from 'node:path'
import tls from 'node:tls'
import { collectorHome } from '../paths.mjs'
import { caPaths } from './core/tls/ca-store.mjs'
import { ROOT, checkProfile, certPem, pemToDer } from './core/tls/cert.mjs'
import { rootIdOf } from '../off/root-store.mjs'
import { readManifest, saveManifest, newManifest, applyJsonKey, applyTextEntry, writeOwnedFile, judgeOwned, sha256 } from './core/trust/journal.mjs'
import { installComplete, itemsOfPhase, undoByHand, OFF_VERSION } from '../off/manifest.mjs'
import { writeStandalone } from '../off/standalone.mjs'
import { missingDirs } from '../off/fsutil.mjs'
import { resolveLoc, readSrc, holds, isPresent } from './core/proxymode/sources.mjs'
import { noProxyNames } from './core/proxymode/entries.mjs'
import { placeWrapper, managedTree } from './core/proxymode/hooks/wrapper.mjs'
import { lineComment, removeAsightText } from '../off/text-edit.mjs'
import { livenessOf } from './core/registry.mjs'
import { readAgentList } from '../off/identity.mjs'
import { unitedLiveness } from './install.mjs'
import { CODE } from './core/codes.mjs'

/** The OSes the collector model (4.11) runs on — the one list `install`, `on`, `uninstall` and the arch backends ask. */
export const MODEL_OS = Object.freeze(['darwin', 'win32'])
export const isModelOs = (os) => MODEL_OS.includes(os)

const STORE = Object.freeze({ darwin: 'darwin-user-trust', win32: 'win-currentuser-root' }) // the store the user root goes into (src/off/root-store.mjs removes it on uninstall)
export const ROOT_SUBJECT = 'asight local root' // also how the lab's reset knows asight's own certificate (spec 4.10 §7 还原)
const NOT_USERS = CODE.notUsersFile
const errText = (e) => String((e && e.message) || e)
// The key custody is a native program (4.11 P1): 'unavailable' is a VALUE, but it can also FAIL outright — a HOME with no login keychain answers
// "A default keychain could not be found" (a macOS test machine 2026-10-18, where install exited 70 with a stack at the person). A failure is a stated
// refusal: `install` says what happened and what to do, carries `error.code` and exits 1.
export const CUSTODY_FAILED = 'key-custody-failed'
const CUSTODY_ADVICE = Object.freeze({
  darwin: 'asight needs the login keychain of this user: log in to this Mac at its own desktop once (that is where the keychain is made), then run asight install again there',
  win32: 'run asight install again from a terminal of your own desktop session',
})
// an OS prompt that was not answered (timeout, no GUI session) is pending; one the user answered no is declined (1.6 §1.6)
const promptState = (r) => r.state || (/time[d ]?out|no gui|interaction|session|unavailable/i.test(String(r.reason || '')) ? 'pending' : 'declined')

/** Rule U (P4): may asight append its block to `file`? → null (yes) or the reason it is not this user's own file. */
function usersFileWhy(file, { fs = nodeFs, owns }) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return `${file} is not an absolute path`
  let real
  try { real = fs.realpathSync(file) } catch { return `${file} does not exist` }
  const tree = managedTree(real)
  if (tree) return `${real} is inside ${tree}, which a package manager or the system rewrites`
  try { if (!fs.statSync(real).isFile()) return `${real} is not a file` } catch (e) { return `${real} cannot be read (${e.code || e.message})` }
  const o = owns(real)
  if (o !== true) return o === false ? `${real} belongs to another user` : `who owns ${real} cannot be told`
  try { fs.accessSync(real, nodeFs.constants.W_OK) } catch { return `${real} is read-only for this user` }
  return null
}

/** runInstall({ os, home, env, harnesses, custody, rootStore, ctx, owns, … }) → { manifest, fp256, items, carriers, pending, problems, exit }. See the header. */
export async function runInstall({ os, home, env = process.env, harnesses, custody, rootStore, ctx, owns, installHelper = null, interactive = false, wrapperKit = null, renderHook = null, facts = {}, unit = null, nodeRoots = tls.rootCertificates, fs = nodeFs, now = () => new Date() }) {
  const dir = collectorHome(path.join(home, '.asight'))
  const ca = caPaths(path.join(dir, 'ca'))
  const m = readManifest(dir, fs) || newManifest(now())
  const before = JSON.stringify(m)
  const items = [], carriers = [], pending = [], problems = [], installedHarnesses = [] // the last: read by finish(), which an install with no root reaches early
  const said = (item, state, extra = {}) => items.push({ item, state, ...extra })
  const save = () => saveManifest(dir, m, fs)
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); save() }
  const stdl = writeStandalone({ home, version: OFF_VERSION, fs }) // the way back first (R3)
  said('asight-off', stdl.written ? 'written' : 'intact', { path: stdl.path })
  if (installHelper) { const h = installHelper(interactive); if (h && h.why && h.why !== 'same') problems.push(h.why) }

  // a · the root's key (P1): created only when the custody has none; the root it returns must have the ROOT profile (T12)
  let rootDer = null
  const rec = m.entries.find((e) => e.kind === 'root-key')
  // one call shape for every custody verb: a program that cannot be used is a refusal with its reason, never a stack (P5)
  let custodyWhy = null
  const ask = async (verb, arg) => {
    try { return await custody[verb](arg) } catch (e) {
      custodyWhy = `the key that signs certificates could not be ${verb === 'create' ? 'made' : 'read'} (${errText(e)}). ${CUSTODY_ADVICE[os] || CUSTODY_ADVICE.win32}`
      pending.push({ item: 'root-key', state: 'failed', code: CUSTODY_FAILED, reason: custodyWhy })
      return null
    }
  }
  const has = await ask('exists')
  if (custodyWhy) return finish()
  if (has === 'unavailable') { pending.push({ item: 'root-key', state: 'pending', reason: 'the key custody is not reachable (macOS: no graphical login session); run asight install again in a terminal of that session' }) }
  else if (rec && has === true && fs.existsSync(ca.pem)) { rootDer = pemToDer(fs.readFileSync(ca.pem, 'utf8')); said('root-key', 'intact', { fp256: rec.fp256 }) }
  else {
    // 4.11 §3 ㉒: a key that is gone (exists() false while the manifest records one), or one whose root asight cannot read back (no record, or
    // asight-ca.pem gone: the custody has no verb that returns the root), is replaced — never refused. A stray key goes first (create over it is
    // the helper's 'exists'); then the old root leaves the store by its recorded fingerprint; the carriers below are rewritten for the new root.
    if (has === true) {
      const gone = await ask('remove', rec ? rec.custody : { kind: custody.kind })
      if (custodyWhy) return finish()
      if (!gone || typeof gone !== 'object' || typeof gone.removed !== 'boolean') { pending.push({ item: 'root-key', state: 'pending', reason: `the custody holds a key whose root certificate asight can no longer read back, and could not remove it now (${JSON.stringify(gone)}); run asight install again in a terminal of the graphical login session` }); return finish() }
    }
    if (rec) { m.entries.splice(m.entries.indexOf(rec), 1); save() }
    // every root this manifest put in the store belongs to a key that is gone now (the record of the key may be gone too): each leaves by its fingerprint
    for (const old of m.entries.filter((e) => e.kind === 'system-root' && e.store === STORE[os])) {
      let r
      try { r = await rootStore.remove({ fp256: old.fp256, sha1: old.thumbprint || (old.values && old.values.thumbprint) }) } catch (e) { r = { ok: false, reason: errText(e) } }
      if (r && r.ok) { m.entries.splice(m.entries.indexOf(old), 1); save(); said('old-root', 'removed', { fp256: old.fp256 }) }
      else { // its key is gone, so it signs nothing any more: an orphan, kept on record for uninstall, and named with its removal (1.6 §9.4 orphan)
        old.orphan = true; save()
        said('old-root', 'orphan', { fp256: old.fp256 })
        problems.push(`orphan: the old asight root ${old.fp256} is still in your root store (${(r && r.reason) || 'the removal was not confirmed'}); its key is gone, so it signs nothing. Remove it by hand: ${old.undo_by_hand || undoByHand(old)}`)
      }
    }
    const made = await ask('create', { subject: ROOT_SUBJECT })
    if (custodyWhy) return finish()
    if (made === 'unavailable') pending.push({ item: 'root-key', state: 'pending', reason: 'the key custody could not create the key now (no graphical login session?); run asight install again there' })
    else {
      const bad = checkProfile(made.rootDer, ROOT)
      if (bad.length) { problems.push(`the root the custody made does not have the root profile (${bad.join('; ')}); nothing uses it`); await ask('remove', { kind: custody.kind, id: made.fp256 }) }
      else {
        rootDer = made.rootDer
        const k = { kind: 'root-key', harness: null, phase: 'install', custody: { kind: custody.kind, id: made.id || made.fp256 }, fp256: made.fp256, ...(made.provider ? { provider: made.provider } : {}), installed_at: now().toISOString() }
        k.undo_by_hand = undoByHand(k)
        m.entries.push(k); save()
        said('root-key', 'created', { fp256: made.fp256 })
      }
    }
  }
  if (!rootDer) return finish()
  const rootPem = certPem(rootDer)
  const rootBody = rootPem.replace(/-----[A-Z ]+-----|\s/g, '') // the base64 of the root: how a pem-block of this root is told from one of an older root
  const id = rootIdOf(rootDer)
  m.dirs.push(...missingDirs(ca.dir, fs).filter((d) => !m.dirs.includes(d))) // CM32: uninstall takes ca/ away once its files are gone
  owned(ca.pem, 'ca-cert', null, rootPem, 0o644)

  // b · the root in the user's root store (P3): read back by fingerprint first, so a second install raises no prompt
  const storeKind = STORE[os]
  const inStore = await rootStore.has(id)
  let storeRec = m.entries.find((e) => e.kind === 'system-root' && e.store === storeKind && e.fp256 === id.fp256)
  const asked = !inStore.error && !inStore.present // the OS is asked to add the root: from then on it may be in the user's store, trusted or not
  if (inStore.error) pending.push({ item: 'root-store', state: 'pending', reason: inStore.error })
  else if (asked) {
    const r = await rootStore.add(rootDer)
    if (!r.ok) pending.push({ item: 'root-store', state: promptState(r), reason: r.reason })
    else { // the add is read back as the next install's would be: an OS tool that answers 0 while the trust it was asked for is absent (a box cancelled,
      // a setting refused) leaves the root untrusted — said and pending, never "added" (D38; 1.6 §1.6 OS 框)
      const back = await rootStore.has(id)
      if (back.error || !back.present) pending.push({ item: 'root-store', state: 'pending', reason: back.error || 'the OS took the root, but reading your trust settings back does not find it trusted (was the box cancelled?)' })
    }
  }
  const rootPending = pending.find((p) => p.item === 'root-store')
  // the record uninstall removes the root by (D48): written once the OS was asked, whatever it answered — a cancelled macOS box leaves the certificate
  // in the login keychain without trust, a prompt left open may still be answered yes after the timeout, a Windows listing that failed hides a root that
  // is there; remove() answers `absent` for one that never landed (1.6 §1.6 OS 框)
  if (!storeRec && (inStore.present || asked)) {
    storeRec = { kind: 'system-root', store: storeKind, scope: 'user', harness: null, phase: 'install', path: ca.pem, fp256: id.fp256, thumbprint: id.sha1, cert_file: ca.pem, values: { fp256: id.fp256, thumbprint: id.sha1, ...(os === 'darwin' ? { keychain: path.join(home, 'Library', 'Keychains', 'login.keychain-db') } : {}) }, installed_at: now().toISOString() }
    storeRec.undo_by_hand = undoByHand(storeRec)
    m.entries.push(storeRec); save()
  } else if (storeRec && asked && !rootPending) { storeRec.installed_at = now().toISOString(); save() } // trusted only now (an earlier add left it pending): the carrier time is now (P11 ③)
  said('root-store', rootPending ? rootPending.state : inStore.present ? 'intact' : 'added')

  // c · the carriers of every present form (P4)
  for (const desc of harnesses.filter((d) => d.proxyMode)) {
    const pm = desc.proxyMode
    const forms = pm.forms.filter((f) => f.os.includes(os) && isPresent(f, ctx))
    if (!forms.length) continue
    installedHarnesses.push(desc.name)
    const done = new Map()
    for (const f of forms) {
      const c = f.cert === 'root' ? null : pm.certs[f.cert]
      const when = c && c.when ? holds(c.when, ctx) : true
      if (!c || when === false) { carriers.push({ harness: desc.name, form: f.id, carrier: 'root' }); continue }
      if (when && when.error) { carriers.push({ harness: desc.name, form: f.id, carrier: c.kind, state: 'skipped', code: 'config-unreadable', why: `${when.where}: ${when.error}` }); continue }
      if (!done.has(f.cert)) done.set(f.cert, await carrier(desc, c))
      carriers.push({ harness: desc.name, form: f.id, carrier: c.kind, ...done.get(f.cert) })
    }
    for (const src of pm.userCertFiles || []) ruleU(desc, src)
  }

  // d · the autostart unit (inert until on enables it)
  if (unit) { const text = unit.text({}); owned(unit.path, 'unit', null, text, 0o644) }
  const agentList = readAgentList({ home, fs }).entries
  for (const d of harnesses.filter((x) => installedHarnesses.includes(x.name))) m.liveness[d.name] = { ...unitedLiveness(m.liveness[d.name], livenessOf(d, { agentList, os })), ...pick(m.liveness[d.name], ['on_at', 'off_at']) }
  return finish()

  function finish() {
    const names = [...new Set([...((m.install && m.install.harnesses) || []), ...installedHarnesses])].sort()
    const state = pending.length || problems.length || !rootDer ? 'partial' : 'complete'
    // what install placed for each harness, by kind and path: precondition ⑪ refuses a harness one of these has gone from, even when its record went with it
    const placed = Object.fromEntries(names.map((h) => [h, itemsOfPhase(m, 'install').filter((x) => x.harness === h).map((x) => ({ kind: x.kind, path: x.path }))]))
    const next = { state, at: installComplete(m) && state === 'complete' ? m.install.at : now().toISOString(), pending, harnesses: names, items: placed }
    if (JSON.stringify(next) !== JSON.stringify(m.install)) m.install = next
    if (JSON.stringify(m) !== before) save()
    const skipped = carriers.filter((x) => x.state === 'skipped').length + items.filter((x) => x.state === 'skipped').length
    return { manifest: m, fp256: rootDer ? rootIdOf(rootDer).fp256 : null, items, carriers, pending, problems, exit: pending.length || problems.length || skipped ? 1 : 0 }
  }

  function owned(file, role, harness, data, mode) {
    const j = judgeOwned({ manifest: m, file, planned: sha256(Buffer.from(data)), fs })
    if (j.action === 'skip-intact') return said(role, 'intact', { path: file, harness })
    writeOwnedFile({ dir, manifest: m, harness, role, phase: 'install', file, data, mode, now: now(), fs })
    said(role, 'written', { path: file, harness })
  }

  function jsonKey(desc, file, keys, value) {
    const e = applyJsonKey({ dir, manifest: m, harness: desc.name, phase: 'install', file, keys, value, home, now: now(), fs })
    said('config-key', e ? 'written' : 'intact', { path: file, keys, harness: desc.name })
  }

  // one carrier kind for one harness → { state, code?, why? }
  async function carrier(desc, c) {
    try {
      if (c.kind === 'config-key') {
        const at = readSrc({ file: c.file, format: c.format, keys: c.keys }, ctx)
        if (at.error) return { state: 'skipped', code: 'config-unreadable', why: `${at.where}: ${at.error}` }
        const inEnv = c.semantics === 'add' && readSrc({ env: c.keys.at(-1) }, ctx).set // CM10: absent in the settings AND the install env
        const file = resolveLoc(c.file, ctx)[0]
        if (at.set && !(m.entries.some((e) => e.kind === 'json-key' && e.phase === 'install' && e.path === file && JSON.stringify(e.keys) === JSON.stringify(c.keys)))) return { state: 'rule-u' }
        if (inEnv) return { state: 'rule-u' }
        if (c.semantics === 'replace') { // CM9: Node's own roots plus the asight root, no system roots
          const bundle = path.join(dir, 'ca', `bundle-${desc.name}.pem`)
          owned(bundle, 'bundle', desc.name, `${[...nodeRoots, rootPem].map((p) => p.trim()).join('\n')}\n`, 0o644)
          jsonKey(desc, file, c.keys, bundle)
        } else jsonKey(desc, file, c.keys, ca.pem)
        return { state: 'placed' }
      }
      if (c.kind === 'wrapper') {
        if (!wrapperKit) return { state: 'skipped', code: NOT_USERS, why: `this build has no wrapper for ${os}` }
        const wctx = { ...ctx, fs, owns, facts, dir, manifest: m, harness: desc.name, switchFile: path.join(dir, 'switch', desc.name), caFile: ca.pem, proxyEnv: (desc.proxy && desc.proxy.env) || [], proxyNames: (desc.proxy && desc.proxy.env) || [], now }
        const r = placeWrapper(wctx, c, wrapperKit)
        return r.ok ? { state: r.result } : { state: 'skipped', code: r.code, why: r.why }
      }
      if (c.kind === 'plugin') {
        const pdir = resolveLoc(c.dir, ctx)[0], loader = resolveLoc(c.loader.file, ctx)[0]
        if (!pdir || !loader) return { state: 'skipped', code: 'not-routed', why: 'the plugin folder does not resolve here' }
        if (!renderHook) return { state: 'skipped', code: 'not-routed', why: 'this build was given no hook renderer' }
        const hook = renderHook(c.template, { CA_FILE: ca.pem, SWITCH: path.join(dir, 'switch', desc.name), PROXY_ENV: (desc.proxy && desc.proxy.env) || [], NO_PROXY_ENV: noProxyNames(desc) })
        const file = path.join(pdir, hook.name), text = hook.text
        owned(file, 'plugin', desc.name, text, 0o644)
        const e = applyTextEntry({ dir, manifest: m, harness: desc.name, phase: 'install', file: loader, edit: { format: 'yaml-list', line: `- ${c.loader.keys.at(-1)}: [{ name: ${JSON.stringify(file)} }] ${lineComment("loads asight's CA trust plugin")}` }, home, now: now(), fs })
        said('plugin-loader', e ? 'written' : 'intact', { path: loader, harness: desc.name })
        return { state: 'placed' }
      }
      return { state: 'skipped', code: 'not-routed', why: `no carrier kind ${c.kind}` }
    } catch (e) { problems.push(`${desc.name}: ${errText(e)}`); return { state: 'skipped', code: e.code || 'install-error', why: errText(e) } }
  }

  // rule U: a setting that already names a certificate file → a marked block at its end, only in the user's own file
  function ruleU(desc, src) {
    const r = readSrc(src, ctx)
    if (r.error || !r.set || typeof r.value !== 'string') return
    if (m.entries.some((e) => e.kind === 'json-key' && e.phase === 'install' && e.value === r.value)) return // asight's own key, set by this install
    const file = path.isAbsolute(r.value) ? r.value : path.resolve(home, r.value)
    const why = usersFileWhy(file, { fs, owns })
    if (why) { carriers.push({ harness: desc.name, carrier: 'pem-block', path: file, state: 'skipped', code: NOT_USERS, why }); return }
    try {
      // ㉒: a block this manifest placed for an older root comes out by its marks (the user's bytes outside them stay, read and written as bytes),
      // and its record with it; the block for this root is then placed as new (a fresh installed_at)
      const older = m.entries.find((e) => e.kind === 'text' && e.format === 'pem-block' && e.harness === desc.name && e.path === file && !(e.ops || []).some((o) => o.pem && o.inserted.replace(/\s/g, '').includes(rootBody)))
      if (older) {
        const out = removeAsightText(fs.readFileSync(file, 'latin1'), older.ops)
        if (out.found) fs.writeFileSync(file, out.text, 'latin1')
        m.entries.splice(m.entries.indexOf(older), 1); save()
      }
      // two harnesses whose settings name one file (Claude Code and Kimi Code both read NODE_EXTRA_CA_CERTS; Codex and Hermes SSL_CERT_FILE) share
      // one block: the first places it and its entry is the file's one record, undone once; the next finds this root's block there (a Windows test machine 2026-10-17)
      const shared = m.entries.find((x) => x.kind === 'text' && x.format === 'pem-block' && x.harness !== desc.name && x.path === file && (x.ops || []).some((o) => o.pem && o.inserted.replace(/\s/g, '').includes(rootBody)))
      if (shared) { carriers.push({ harness: desc.name, carrier: 'pem-block', path: file, state: 'intact', shared_with: shared.harness }); return }
      const e = applyTextEntry({ dir, manifest: m, harness: desc.name, phase: 'install', file, edit: { format: 'pem-block', pem: rootPem }, home, now: now(), fs })
      carriers.push({ harness: desc.name, carrier: 'pem-block', path: file, state: e ? 'placed' : 'intact' })
    } catch (e) { carriers.push({ harness: desc.name, carrier: 'pem-block', path: file, state: 'skipped', code: e.code || NOT_USERS, why: errText(e) }) }
  }
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && o[k] != null).map((k) => [k, o[k]]))

/** What install would place, read only (the plan 1.6 §1.6 prints before it asks): one row per present form → { harness, form, carrier }. */
// The certificate carrier of one form, as a path and a key: whatever shape the descriptor uses for it (a config file and its keys, a plugin's
// directory and its loader, a wrapper's bin directory) resolved the way `on` and `install` resolve it — so the plan names the file it will change
// (1.6 §1.4「计划写全」) instead of a kind alone. A carrier whose place cannot be resolved on this machine says so, and why.
const carrierLoc = (c) => c.file || (c.loader && c.loader.file) || c.dir || c.binDir || null
const carrierKeys = (c) => c.keys || (c.loader && c.loader.keys) || (c.file && c.file.keys) || null

export function planInstall({ os, harnesses, ctx }) {
  const rows = []
  for (const desc of harnesses.filter((d) => d.proxyMode)) {
    for (const f of desc.proxyMode.forms.filter((x) => x.os.includes(os) && isPresent(x, ctx))) {
      const c = f.cert === 'root' ? null : desc.proxyMode.certs[f.cert]
      const when = c && c.when ? holds(c.when, ctx) : true
      const carrier = !c || when === false ? 'root' : c.kind
      const loc = carrier === 'root' ? null : carrierLoc(c)
      const paths = loc ? resolveLoc(loc, ctx) : []
      rows.push({ harness: desc.name, form: f.id, carrier, paths, keys: carrierKeys(c || {}) || null })
    }
  }
  return rows
}
