// entries.mjs — the proxy entries' writer, undo and check (RFC 4.8 §2.1 · §2.3; W12's entry half, W19's combined case; plan Task 8(c)).
// The redirector decides WHEN these run (only after the kernel has read the group back as on; undone the other way round); this file is WHAT
// happens then: `forms.mjs proxyEntries`' edits written through the install journal (`applyJsonKey` / `applyTextEntry`, so the record, the
// `prior_value` and the backup are the same ones `off` and the standalone undo by), the dotenv lines of Codex and Hermes JOINING the sentinel
// block their trust entry wrote (`joinBlock: true` — one block per file, entered separately, 4.8 §2.3; the four W19 conditions hold,
// pinned by win32-trust.test.mjs's GATE), and undo through `src/off/journal.mjs undoEntry`, asight's value only (1.6 §9.5).
// The value an entry replaces may carry the user's proxy credentials: they reach the manifest (0600) and nothing else — no result, no note of
// this file carries them (the reason `install.mjs`'s prior-value note is not used for proxy entries).
import nodeFs from 'node:fs'
import { applyJsonKey, applyTextEntry, readManifest } from '../../core/trust/journal.mjs'
import { undoEntry } from '../../../off/journal.mjs'
import { parseDotenv, parseJsonc } from '../../core/config-read.mjs'
import { proxyEntries } from './forms.mjs'
import { proxyRecordsOf } from './route-plan.mjs'

const getIn = (data, keys) => keys.reduce((cur, k) => (cur !== null && typeof cur === 'object' && !Array.isArray(cur) ? cur[k] : undefined), data)
const msgOf = (e) => String((e && e.message) || e)

/** One group's edits as they are now: the file(s) its agent reads and the kernel port's address to point them at. No port yet → none (the kernel carries no listener for it; the caller says it as `skipped`). */
function editsOf(x, ctx, ingress) {
  const ing = ingress() || {}
  const port = (ing.groupPorts || {})[x.g]
  return Number.isInteger(port) ? proxyEntries(x.group, ctx, { port, listenerToken: ing.listenerToken }) : []
}

/**
 * createProxyEntries({ dir, home, groups, ctx, ingress, manifest, fs, now }) → { write(list), undo(list), check(list) } — the Redirector's `entries`
 * (4.8 §1). `list` is `[{ g, harness, entry }]` (`entry` 'auto' | 'opt-in' for a group that is on, null in an undo / check list of a group the plan has off).
 *   write  every file of the group's entry, through the journal: idempotent (a crash between the kernel's read-back and here is `on` again — the same
 *         edits, skip-intact), one `{ g, ok, reason? }` per group, a refusal is that group's ok:false and never an exception (the kernel and the other
 *         groups stand). Every entry kind that is not a file (an opt-in policy value, a shim: Task 14's) is ok:true with nothing written here.
 *   undo   the manifest's records of the group's proxy entry, asight's value only, byte for byte when the file is as it was left; a record of an
 *         install whose manifest is not the one the caller reads does not exist, so nothing is guessed at.
 *   check  whether the files hold the group's address now (the read-back `status` shows beside the kernel's).
 */
export function createProxyEntries({ dir, home, groups, ctx, ingress, manifest = null, fs = nodeFs, now = () => new Date() } = {}) {
  if (!Array.isArray(groups)) throw new TypeError('createProxyEntries needs the groups (route-plan.mjs groupsOf)')
  if (!ctx || typeof ctx.readTextOrError !== 'function') throw new TypeError('createProxyEntries needs the ctx (readTextOrError) that says where the files are')
  if (typeof ingress !== 'function') throw new TypeError('createProxyEntries needs ingress(): the kernel port and the listener token of each group')
  const groupOf = new Map(groups.map((x) => [x.g, x]))
  const freshManifest = () => { try { return (typeof manifest === 'function' ? manifest() : manifest) || readManifest(dir, fs) } catch { return null } }

  function write(list) {
    const out = []
    for (const item of list || []) {
      const x = groupOf.get(item && item.g)
      if (!x) { out.push({ g: item && item.g, ok: false, reason: 'no such group' }); continue }
      const edits = editsOf(x, ctx, ingress)
      let ok = true
      let reason = null
      for (const e of edits) {
        try {
          const m = freshManifest()
          if (!m) throw new Error('the install manifest cannot be read')
          if (e.kind === 'json-key') applyJsonKey({ dir, manifest: m, harness: x.harness, file: e.path, keys: e.keys, value: e.value, home, now: now(), fs })
          else applyTextEntry({ dir, manifest: m, harness: x.harness, file: e.path, edit: { ...e, joinBlock: true }, home, now: now(), fs }) // the journal joins only a block its own manifest lists for this harness (W19's gate lives there, default off for anyone else)
        } catch (err) { ok = false; reason = msgOf(err) }
      }
      out.push({ g: x.g, ok, ...(ok ? {} : { reason }) })
    }
    return out
  }

  function undo(list) {
    const out = []
    for (const item of list || []) {
      const x = groupOf.get(item && item.g)
      if (!x) { out.push({ g: item && item.g, ok: false, reason: 'no such group' }); continue }
      let ok = true
      let reason = null
      for (const rec of proxyRecordsOf(freshManifest(), x.group, x.harness)) {
        const r = undoEntry(rec, { fs })
        if (typeof r.result === 'string' && r.result.startsWith('left-')) { ok = false; reason = r.reason || r.result }
      }
      out.push({ g: x.g, ok, ...(ok ? {} : { ...(reason ? { reason } : {}) }) })
    }
    return out
  }

  function check(list) {
    const out = []
    for (const item of list || []) {
      const x = groupOf.get(item && item.g)
      if (!x) { out.push({ g: item && item.g, ok: false, reason: 'no such group' }); continue }
      let ok = true
      for (const e of editsOf(x, ctx, ingress)) {
        const r = ctx.readTextOrError(e.path)
        if (r.error != null || r.text == null) { ok = false; continue }
        const holds = e.kind === 'json-key'
          ? (() => { const { data, errors } = parseJsonc(r.text); return !errors && getIn(data, e.keys) === e.value })()
          : (parseDotenv(r.text).get(Object.keys(e.vars)[0]) === e.vars[Object.keys(e.vars)[0]])
        if (!holds) ok = false
      }
      out.push({ g: x.g, ok })
    }
    return out
  }

  return { write, undo, check }
}
