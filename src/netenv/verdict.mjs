// verdict.mjs (src/netenv) — what `trocar status` says of one harness: captured now, or not and why (RFC 1.6 §2, V32). Pure. `src/cli/status.mjs` re-exports it and feeds it what it read; the network
// topology (topology.mjs, §9) calls the same function on the same facts for each branch's `captured` and `reason`, so the table `status` prints and the path it draws cannot disagree.
// Imports nothing.
const at = (t) => (typeof t === 'string' ? Date.parse(t) : t)
const verdict = (captured, reason = null) => ({ captured, reason })
const NOT_SEEN = 'not-seen' // 4.11 P11 status 4–5: the door has not seen this life and history cannot tell — captured null, no restart

/**
 * The verdict on one harness (V32), pure. Inputs, every one of them `null` / 'unknown' when it could not be read:
 *   desired      'on' | 'off'
 *   entryIntact  true | false | null — the trust entry trocar wrote is still there; `entryWhy` says what is wrong with it when false ('entry-missing' | 'entry-changed')
 *   attached     true | false | null — this harness's path into trocar is up: Linux, the kernel has this instance's link (read back by the daemon); proxy mode, every door group `on`
 *                recorded for it listens (a missing door with the daemon running is forwarder-down). `helper` 'missing' says the capability helper is absent or the wrong version
 *   daemon       'running' | 'not-running' | 'not-responding' | 'unknown'
 *   deadDoor     proxy mode (macOS, Windows): the agents' proxy entries name trocar's door, which lives in the daemon — a daemon that is not running, or a door it does not hold, is a dead door (forwarder-down)
 *   procs        [{ pid, startedAt (ms or ISO), trusted: true | false | null, reason, negative, cause }] — the harness's processes that send requests. `trusted` is the daemon's verdict when it answered;
 *                null = not judged: then the entry, then the certificate, then the start time against the entry's `installedAt` decides (a process older than its entry never read it: config-after-start, 4.6 §确认信任);
 *                in proxy mode the caller gives `start` instead — the door's own start-time rule over the carrier and the on windows (4.11 P11 status): null = passes, `not-seen` = not known, else its code
 *   formsHere    true | false | null — proxy mode: some form of the harness on this OS is on the machine (descriptor `present`, 4.11 P5); false = none is, so no route or
 *                certificate carrier of its can apply and what runs under its name does not go through trocar (`not-routed`, before the entry: an entry is written only for a form that is there)
 *   localUpstream  proxy mode: every API host the agent's own config names is on this machine (4.11 P6): loopback never reaches the door, so not captured (`local-upstream`)
 *   cert         true | null | a code — the certificate the harness's agents check trocar's leaves with is in effect (true; also where nothing says otherwise, Linux), not known (null), or not
 *                in effect and why (the 1.6 附录 B `cert-*` code of the form's `certificate`, certOfForms below). Like the entry, it decides only a process the daemon has not judged, and the harness's own row
 * → { captured: true | false | null, rows: [{ pid?, captured, reason }] }; `reason` is one of STATUS_REASONS, null when captured or not known. With no process the one row has no pid and is
 * the harness's own: 「link 已挂、入口完好且证书生效」(§1.5, V32). The order of the reasons: desired off · the daemon · the helper · the link · (for a process, its own verdict first) · no form here · the entry · the certificate · (a process) its start time.
 * The harness is not captured when any row is not; captured when every row is, or some are and every other is `not-seen`; else not known.
 */
export function judgeHarness({ desired, entryIntact = null, entryWhy = 'entry-missing', attached = null, helper = 'ok', daemon = 'unknown', procs = [], installedAt = null, deadDoor = false, formsHere = true, cert = true, localUpstream = false }) {
  const world = (() => {
    if (desired === 'off') return verdict(false, 'desired-off')
    if (desired !== 'on') return verdict(null)
    if (daemon === 'not-running') return verdict(false, deadDoor ? 'forwarder-down' : 'daemon-not-running')
    if (daemon === 'not-responding') return verdict(false, 'daemon-not-responding')
    if (daemon !== 'running') return verdict(null)
    if (helper === 'missing') return verdict(false, 'helper-missing')
    if (attached === false) return verdict(false, deadDoor ? 'forwarder-down' : 'link-missing')
    if (attached !== true) return verdict(null)
    if (localUpstream) return verdict(false, 'local-upstream')
    return null // nothing in the way
  })()
  const absent = formsHere === true ? null : verdict(formsHere === null ? null : false, formsHere === null ? null : 'not-routed')
  const entry = entryIntact === true ? null : entryIntact === false ? verdict(false, entryWhy) : verdict(null)
  const certificate = cert === true ? null : verdict(cert === null ? null : false, cert) // V32: after the entry (a broken entry is fixed first), before the start time (a restart does not bring a certificate)
  if (!procs.length) {
    const v = world || absent || entry || certificate || verdict(true)
    return { captured: v.captured, rows: [v] }
  }
  const installed = at(installedAt)
  const rows = procs.map((p) => {
    const row = (v) => ({ pid: p.pid, ...v })
    if (world) return row(world)
    if (p.trusted === false) return row(verdict(false, p.reason === 'off' ? 'desired-off' : p.reason ?? null))
    if (p.trusted === true) return row(p.negative ? { ...verdict(false, 'negative-cache'), ...(p.cause ? { cause: p.cause } : {}), ...(p.negatives ? { negatives: p.negatives } : {}) } : verdict(true)) // the engine's cause picks the words (1.6 附录 B)
    if (absent) return row(absent)
    if (entry) return row(entry)
    if (certificate) return row(certificate)
    if (p.start !== undefined) return row(p.start === null ? verdict(true) : p.start === NOT_SEEN ? verdict(null, NOT_SEEN) : verdict(false, p.start)) // proxy mode: the door's own rule, judged by the caller (4.11 P11 status)
    const started = at(p.startedAt)
    if (started == null || Number.isNaN(started)) return row(verdict(false, 'start-time-unknown'))
    if (installed == null || Number.isNaN(installed)) return row(verdict(null))
    return row(started < installed ? verdict(false, 'config-after-start') : verdict(true))
  })
  // 1.6 §2 判词: a `not-seen` row never makes the harness `no`, and beside a captured one it is `yes` ("N not seen yet", from the rows)
  const open = rows.filter((r) => r.captured === null)
  const captured = rows.some((r) => r.captured === false) ? false : rows.some((r) => r.captured === true) && open.every((r) => r.reason === NOT_SEEN) ? true : open.length ? null : true
  return { captured, rows }
}

/** A harness's `cert` for judgeHarness (V32) from its forms' `certificate` (1.6 §9.4, proxy mode): true when every present form's is in effect (or none says), else the first one that is not —
 *  its code, or null (not known) when it has none (the user's root store could not be read). */
export function certOfForms(forms) {
  const bad = (forms || []).find((x) => x.certificate && x.certificate.in_effect === false)
  return bad ? bad.certificate.code ?? null : true
}
