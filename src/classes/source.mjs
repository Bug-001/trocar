// src/classes/source.mjs — the live class table for the capture side (D60③, RFC 4.6 §记录「保存级别」, 1.6 §4.2).
// ./table.mjs says WHAT the table is and HOW it is edited; this says WHEN the capture re-reads it:
//   - the file is re-checked by (inode, size, mtime) at most once per recheckMs (1 s) — no watcher, no restart, so an
//     edit reaches the calls that START within a second of it;
//   - a call samples its class and level once, at its start (the engine asks classOf + keepOf then): an in-flight call
//     keeps what it started with, and nothing already stored changes (invariant 2);
//   - a file that cannot be read, parsed or compiled never costs a call its bytes: the builtin table applies and that
//     is ONE failure event per state change (D38), not one per call; `classes-ok` says it reads cleanly again.
// It knows no harness: the caller resolves `harness` from the process (the core names none — D20, 0.1 §5).
import nodeFs from 'node:fs'
import { classesFile } from '../paths.mjs'
import { BUILTIN, readTable, classify, keepOf } from './table.mjs'

const errText = (e) => String((e && e.message) || e)

/**
 * createClassSource({home, fs, now, recheckMs, onFailure, onOk}) → {classOf, keepOf, problems}
 *   classOf({host, path, harness}) → the class name of a call that starts now
 *   keepOf(className)              → 'full' | 'log'
 *   problems                       → what is wrong with the user's file right now ([] = nothing)
 *   onFailure({event:'failure', where:'classes', code, reason}) · onOk({event:'classes-ok', where:'classes', reason})
 */
export function createClassSource({ home = undefined, fs = nodeFs, now = Date.now, recheckMs = 1000, onFailure = () => {}, onOk = () => {} } = {}) {
  const file = classesFile(home)
  let table = { classes: BUILTIN }, classOf = classify(table), problems = []
  let sig, checkedAt = -Infinity, loaded = false, problemsKey = null
  const emit = (fn, rec) => { try { fn({ where: 'classes', ...rec }) } catch { /* a recorder that throws must not stop a call from being captured */ } }
  const statKey = () => { try { const st = fs.statSync(file); return `${st.ino}:${st.size}:${st.mtimeMs}` } catch { return null } }

  function refresh() {
    const t = now()
    if (loaded && t - checkedAt < recheckMs) return
    checkedAt = t
    const cur = statKey()
    if (loaded && cur === sig) return // unchanged file: nothing to re-read
    sig = cur; loaded = true
    const r = readTable({ home, fs })
    table = r; classOf = classify(r); problems = r.problems
    const key = r.problems.map((p) => `${p.code}\u0000${p.reason}`).join('\u0001') || null
    if (key === problemsKey) return
    if (key == null) emit(onOk, { event: 'classes-ok', reason: `${file} reads cleanly again; the classes in it apply from the next call` })
    // a rule that does not compile is `pattern-invalid` (4.6 §记录「类别与保存级别」); the rest keep table.mjs's own code
    else for (const p of r.problems) emit(onFailure, { event: 'failure', code: p.code === 'classes-bad-rule' ? 'pattern-invalid' : p.code, reason: p.reason })
    problemsKey = key
  }

  return {
    classOf(call) {
      refresh()
      try { return classOf(call) } catch (e) {
        emit(onFailure, { event: 'failure', code: 'classify-failed', reason: `classifying ${(call && call.host) || '?'} ${String((call && call.path) || '').split('?')[0]} failed (${errText(e)}); it is kept as other` })
        return 'other'
      }
    },
    keepOf(className) { refresh(); return keepOf(table, className) },
    get problems() { refresh(); return problems },
  }
}
