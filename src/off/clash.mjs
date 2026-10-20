// clash.mjs (src/off) — taking trocar's route out of Clash Verge / mihomo, and asking the core whether it is gone (only the sentinel block goes; the runtime is reloaded by payload and the live proxy list is read back). `trocar desktop off` (src/capture/
// desktop-steer.mjs) runs THIS code. Moved here from src/capture/desktop-steer.mjs without a change of behaviour — the steer's `on` side (scriptBlock, injectScript,
// spliceRuntime) stays there, and the old names are re-exported from it. Imports only node:* and src/off (0.1 §2: the standalone ~/.trocar/bin/trocar-off is made of this directory).
//   pure          stripBlock · stripRuntime · stripMergeLegacy — the text of a file with trocar's route taken out, every other byte as it was
//   the core      knownMihomoSocks · mihomoSockCandidates · discoverMihomoSock · probeVersion · mihomoPayloadReload · probeProxy — the control socket is discovered, never hard-coded
//   makeClash     the files of one Verge install and the core behind them: read, status, off (strip → reload → verify), with the reload and the probe replaceable by a test
import nodeFs from 'node:fs'
import http from 'node:http'
import { execTool } from './exec.mjs'

export const PROXY_NAME = 'atrace-mitm'
export const DESKTOP_RULE = `AND,((PROCESS-PATH-REGEX,(?i)Application Support/Claude/claude-code),(DOMAIN,api.anthropic.com)),${PROXY_NAME}`
// the sentinel INNER text is comment-syntax-agnostic; Script.js (JavaScript) writes it after `//`, a runtime YAML after `#` (a `//` line is NOT a YAML comment, it would break the parse)
export const MARK_BEGIN = '>>> atrace desktop capture (managed by trocar desktop) >>>'
export const MARK_END = '<<< atrace desktop capture <<<'
/** The line in Script.js that says the block is there. */
export const SCRIPT_BEGIN = `// ${MARK_BEGIN}`

const clashEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ── pure transforms ────────────────────────────────────────────────────────────────────────────

/** Strips any prior atrace block (between the sentinels, inclusive of its own line) from JS OR YAML — it matches on the inner marker text, so it catches the `//` and the `#` form. */
export function stripBlock(text) {
  const re = new RegExp(`\\n?[^\\n]*${clashEscape(MARK_BEGIN)}[\\s\\S]*?${clashEscape(MARK_END)}[^\\n]*`, 'g')
  return text.replace(re, '')
}

/** Removes EVERY atrace route from a runtime yaml: our sentinel-marked splice, AND the unmarked copy the durable Script.js puts there at each Verge regen (serde_yaml block style, `- name: atrace-mitm`
 *  + `- <DESKTOP_RULE>`). Stripping only the sentinel form was a bug: after any regen, on() spliced a second proxy of the same name (mihomo 400 "duplicate name") and off() pushed a config that
 *  still routed into the MITM. Only the top-level `proxies:` items named EXACTLY atrace-mitm and `rules:` items equal to DESKTOP_RULE go; every other byte stays. */
export function stripRuntime(yaml) {
  const lines = stripBlock(yaml).split('\n')
  const tail = lines.at(-1) === '' ? lines.pop() : null // keep the final newline out of any item
  const out = []
  let section = null, listIndent = null, item = null
  const isOurRule = (l) => new RegExp(`^\\s*-\\s+(['"]?)${clashEscape(DESKTOP_RULE)}\\1\\s*$`).test(l)
  const flush = () => { if (item && !isOurProxyItem(item)) out.push(...item); item = null }
  for (const ln of lines) {
    const top = /^[^\s#-][^:]*:/.test(ln)
    if (top) { flush(); section = ln.split(':')[0]; listIndent = null; out.push(ln); continue }
    const dash = /^(\s*)-(?:\s|$)/.exec(ln)
    if (dash && listIndent === null) listIndent = dash[1].length
    if (section === 'proxies') {
      if (dash && dash[1].length === listIndent) { flush(); item = [ln]; continue }
      if (item) { item.push(ln); continue }
    } else if (section === 'rules' && dash && dash[1].length === listIndent && isOurRule(ln)) continue
    out.push(ln)
  }
  flush()
  if (tail !== null) out.push(tail)
  return out.join('\n')
}

// A proxy list item (its lines) that is trocar's: its OWN `name` is exactly atrace-mitm (the dash line, or a key at the item's key column) — never a nested `name:` deeper inside some other proxy (e.g. plugin-opts),
// which would delete the user's proxy.
function isOurProxyItem([head, ...rest]) {
  const nameIs = `name:\\s*(['"]?)${clashEscape(PROXY_NAME)}\\1\\s*(?:[,}]|$)`
  if (new RegExp(`^\\s*-\\s+(?:\\{\\s*)?${nameIs}`).test(head)) return true
  const inline = /^(\s*-\s+)\S/.exec(head) // `- key: v` → keys sit where `key` starts
  const keyCol = inline ? inline[1].length : (rest.find((l) => l.trim()) || '').search(/\S/) // bare `-`
  return rest.some((l) => l.length - l.trimStart().length === keyCol && new RegExp(`^\\s*${nameIs}`).test(l))
}

// A rule list item (its first line) that is trocar's: the rule's target is the proxy atrace-mitm (nobody else's rule sends traffic to a proxy of that name).
function isOurRuleItem(line) {
  const text = line.replace(/^\s*-\s+/, '').trim().replace(/^(['"])(.*)\1$/, '$2')
  return new RegExp(`,\\s*${clashEscape(PROXY_NAME)}\\s*(?:,\\s*no-resolve\\s*)?$`).test(text)
}

/** The demo's atrace-desktop wrote `prepend-proxies:` / `prepend-rules:` blocks into Merge.yaml (inert on Verge 2.5.1). Takes out TROCAR'S items of those two lists and nothing else (every other
 *  byte stays): a proxy named exactly atrace-mitm, a rule whose target is atrace-mitm. A list's header goes with its last item; a list that holds anything else — the user's own `prepend-rules`
 *  — keeps its header and its items, and a Merge.yaml with none of trocar's items comes back byte for byte. (The old version took both lists whole, whatever they held.) */
export function stripMergeLegacy(yaml) {
  const lines = stripBlock(yaml).split('\n') // the demo's sentinel-wrapped form goes whole, as in stripRuntime
  const tail = lines.at(-1) === '' ? lines.pop() : null
  const out = []
  let section = null, listIndent = null, item = null, header = -1, kept = 0, dropped = 0
  const endItem = () => {
    if (!item) return
    let n = item.length
    while (n > 1 && item[n - 1].trim() === '') n-- // the blank lines after an item are not its own
    const ours = section === 'prepend-proxies' ? isOurProxyItem(item.slice(0, n)) : isOurRuleItem(item[0])
    if (ours) { dropped++; out.push(...item.slice(n)) } else { kept++; out.push(...item) }
    item = null
  }
  const endSection = () => {
    endItem()
    if (header >= 0 && dropped > 0 && kept === 0) out.splice(header, 1)
    section = null; header = -1; listIndent = null; kept = 0; dropped = 0
  }
  for (const ln of lines) {
    if (/^[^\s#-][^:]*:/.test(ln)) { // a top-level key ends the list before it
      endSection()
      if (/^prepend-(?:proxies|rules):[ \t\r]*(?:#.*)?$/.test(ln)) { section = ln.split(':')[0]; header = out.length }
      out.push(ln); continue
    }
    if (!section) { out.push(ln); continue }
    const dash = /^(\s*)-(?:\s|$)/.exec(ln)
    if (dash && listIndent === null) listIndent = dash[1].length
    if (dash && dash[1].length === listIndent) { endItem(); item = [ln]; continue }
    if (item) { item.push(ln); continue }
    out.push(ln)
  }
  endSection()
  if (tail !== null) out.push(tail)
  return out.join('\n')
}

// ── the mihomo control socket: discovered, never hard-coded ────────────────────────────────
// Where the live core listens depends on how Verge runs it: 2.5.x service mode = clash-verge-service starts mihomo as root with `-ext-ctl-unix /var/run/clash-verge-service/users/<uid>/…`; older
// service mode used /tmp/verge/…; sidecar mode uses the runtime yaml's external-controller-unix (which service mode leaves STALE). So: ask the running process first, then the yaml, then the
// known spots — and only trust a candidate that actually answers.
export const knownMihomoSocks = (uid) => [
  ...(uid != null ? [`/var/run/clash-verge-service/users/${uid}/verge-mihomo.sock`] : []),
  '/tmp/verge/verge-mihomo.sock',
]

export function mihomoSockCandidates({ psText = '', runtimeYaml = '', known = [] } = {}) {
  const fromPs = []
  for (const line of psText.split('\n')) {
    // the path may contain spaces (ps joins argv with ' '): take it up to the next ` -flag` or EOL
    const m = /(?:^|\s)--?ext-ctl-unix(?:=|\s+)(.+?)(?=\s+-{1,2}[A-Za-z][\w-]*(?:[=\s]|$)|\s*$)/.exec(line)
    if (m) fromPs.push(m[1])
  }
  const y = /^external-controller-unix:[ \t]*(['"]?)(.+?)\1[ \t]*$/m.exec(runtimeYaml)
  return [...new Set([...fromPs, ...(y ? [y[2]] : []), ...known])]
}

export async function discoverMihomoSock(candidates, probe = probeVersion) {
  const tried = []
  for (const c of candidates) {
    tried.push(c)
    if (await probe(c).catch(() => false)) return { sock: c, tried }
  }
  return { sock: null, tried }
}

/** Read-only: does something speaking mihomo's API answer on this socket? Only a socket owned by root (service mode) or by us (sidecar mode) qualifies: the reload sends it the WHOLE config inline,
 *  subscription credentials included, so a socket another local user planted (world-writable /tmp, or a `-ext-ctl-unix` on some other process's command line) must never be picked. */
export function probeVersion(sock) {
  try {
    const st = nodeFs.statSync(sock)
    if (!st.isSocket() || (st.uid !== 0 && st.uid !== process.getuid?.())) return Promise.resolve(false)
  } catch { return Promise.resolve(false) }
  return new Promise((resolve) => {
    const req = http.request({ socketPath: sock, method: 'GET', path: '/version', timeout: 1500 }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c))
      res.on('end', () => { try { resolve(res.statusCode === 200 && !!JSON.parse(b).version) } catch { resolve(false) } })
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', () => resolve(false)); req.end()
  })
}

// ── the mihomo hot-reload: PUT /configs {payload} ────────────────────────────────────────────────
// The `{path}` form is dead in service mode: mihomo only loads files under its home dir / SAFE_PATHS, and there that is a root-owned dir the user cannot write (400 "path is not subpath of home
// directory or SAFE_PATHS"). `{payload}` carries the config inline (204 on v1.19.31) → no file is written anywhere. mihomo validates and keeps the OLD config on error → VPN-safe; its own error
// message is carried back so a rejection is diagnosable, not just a status code.
export function mihomoPayloadReload(sock) {
  return (yamlPayload) => new Promise((resolve) => {
    const body = JSON.stringify({ payload: yamlPayload })
    const req = http.request({ socketPath: sock, method: 'PUT', path: '/configs?force=true', timeout: 30000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => {
        let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c))
        res.on('end', () => {
          const r = { status: res.statusCode }
          if (res.statusCode >= 300) { let msg = b.trim(); try { msg = JSON.parse(b).message || msg } catch { /* not JSON */ } if (msg) r.error = msg }
          resolve(r)
        })
      })
    req.on('timeout', () => req.destroy(new Error('timed out waiting for mihomo')))
    req.on('error', (e) => resolve({ status: 0, error: e.message }))
    req.end(body)
  })
}

/** Is `atrace-mitm` in the core's live proxy list: true / false, or null when the core could not be asked — UNKNOWN, never "not live". */
export function probeProxy(sock) {
  return new Promise((resolve) => {
    const req = http.request({ socketPath: sock, method: 'GET', path: '/proxies', timeout: 5000 }, (res) => {
      let b = ''; res.on('data', (c) => (b += c))
      res.on('end', () => { try { resolve(!!JSON.parse(b).proxies?.[PROXY_NAME]) } catch { resolve(null) } })
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', () => resolve(null)); req.end()
  })
}

// ── one Verge install and the core behind it ─────────────────────────────────────────────────────

/** A reload we never had to make (no runtime config on disk) is not a failure; any attempted reload that mihomo did not accept IS one — the steer is not live, whatever the durable half did. */
export const reloadOk = (r) => r == null || r.status === null || r.status === 200 || r.status === 204
export const reloadWhy = (r) => `mihomo reload FAILED (status ${r?.status}${r?.error ? `: ${r.error}` : ''})`

/** The hand fix when the immediate step cannot be made: there is no supported external API for "regenerate" in Verge 2.5.x. */
export const REACTIVATE_HINT = 'open Clash Verge → Profiles and click the flame (reactivate) button on the active profile'

/**
 * The files of one Clash Verge install and the core that runs them. Everything that touches the world is a parameter a test replaces: `fs`, `psText` (the process listing the socket is looked for in),
 * `knownSocks`, `mihomoReload(yaml)`, `probeLive()`, `exec` (the runner of `ps`), `env`. The live control socket: `sock` pins it; otherwise it is discovered lazily — only by the DEFAULT reload /
 * probe, so a caller that injects both never has the real machine probed. A found socket is remembered; a miss is retried next call (Verge may just be starting). TROCAR_MIHOMO_SOCK in `env` pins it
 * too (unusual installs; and CLI tests, so a sandboxed run can never reach the developer's own core). No Verge runtime config for this HOME → there is no Verge to look for.
 * → { platform, scriptPath, runtimePath, mergePath, read, mihomoReload, probeLive, located, status, off }
 */
export function makeClash({ fs = nodeFs, scriptPath, runtimePath, mergePath, sock = null, psText = null, knownSocks = null, mihomoReload = null, probeLive = null, exec = null, env = process.env, uid = (typeof process.getuid === 'function' ? process.getuid() : null), platform = 'darwin' }) {
  const pinned = sock || env.TROCAR_MIHOMO_SOCK
  let located = pinned ? { sock: pinned, tried: [pinned] } : null
  const locate = async () => {
    if (located?.sock) return located
    if (!fs.existsSync(runtimePath)) return (located = { sock: null, tried: [] })
    let ps = ''
    try { ps = psText ? psText() : execTool('/bin/ps', ['-axww', '-o', 'command='], { run: exec, env, timeoutMs: 3000 }).out } catch (e) { if (e && e.code === 'ESANDBOX') throw e /* no ps → other candidates */ }
    let runtimeYaml = ''
    try { runtimeYaml = fs.readFileSync(runtimePath, 'utf8') } catch { /* absent / unreadable → other candidates */ }
    located = await discoverMihomoSock(mihomoSockCandidates({ psText: ps, runtimeYaml, known: knownSocks || knownMihomoSocks(uid) }))
    return located
  }
  const noSock = (l) => `no live mihomo control socket found (tried: ${l.tried.join(', ') || 'none'})`
  const reload = mihomoReload || (async (yaml) => {
    const l = await locate()
    return l.sock ? mihomoPayloadReload(l.sock)(yaml) : { status: 0, error: noSock(l) }
  })
  // no socket → UNKNOWN (null), never "not live": we could not ask
  const live = probeLive || (async () => { const l = await locate(); return l.sock ? probeProxy(l.sock) : null })

  // ONLY a genuinely absent file may fall back to the default. Every other read failure (EACCES on the user's own Script.js, a directory, a broken symlink) MUST NOT degrade into "empty → use the NO_OP
  // stub", because `on` would then write a GENERATED script over Clash logic it never saw. Throw, naming the file, before anything is written (same discipline as onboard's settings.json).
  const read = (p, dflt = '') => {
    try { return fs.readFileSync(p, 'utf8') } catch (e) {
      if (e && e.code === 'ENOENT') return dflt
      // carry the cause forward: callers that already wrote something MUST render their own, accurate "what state is the machine in now" message rather than this pre-write one.
      const err = new Error(`trocar refused to touch ${p}: cannot read it (${e.code || e.message}). Nothing was written — fix or move the file, then retry.`)
      err.code = e && e.code; err.path = p
      throw err
    }
  }

  async function status() {
    // status() must never crash: an unreadable Script.js is reported as UNKNOWN (null) + why, which is honest, rather than as `false` (= "not installed"), which would be a lie.
    let scriptInstalled = false, readError = null
    try { scriptInstalled = read(scriptPath).includes(SCRIPT_BEGIN) } catch (e) { scriptInstalled = null; readError = e.message }
    let isLive = null; try { isLive = await live() } catch (e) { if (e && e.code === 'ESANDBOX') throw e; isLive = null }
    return { platform, scriptInstalled, live: isLive, proxyName: PROXY_NAME, scriptPath, ...(located ? { mihomoSock: located.sock } : {}), ...(readError ? { readError } : {}) }
  }

  // off() MUST report the REAL teardown outcome. A failed undo that reports ok:true tells the user monitoring is off while CC-Desktop traffic is STILL routed into the MITM — the worst shape of failure
  // for a tool whose undo is first-class. The undo strips ONLY the sentinel block (1.6 R2). Everything outside it — the user's own global-Script logic, including rules
  // added while capture was on — stays byte-for-byte. Never roll the whole file back to a snapshot: that silently deletes whatever the user changed since it was taken.
  // The file having no block does not skip the reload: the runtime may still hold the route (a regen wrote it there), so it is stripped, reloaded and read back all the same.
  async function off() {
    let restoreError = null
    if (fs.existsSync(scriptPath)) {
      try {
        const cur = read(scriptPath)
        const clean = stripBlock(cur)
        if (clean !== cur) fs.writeFileSync(scriptPath, clean)
      } catch (e) { restoreError = `could not strip the atrace block from ${scriptPath} (${e.code || e.message})` }
    }
    let mergeCleanup = null
    try {
      if (fs.existsSync(mergePath)) {
        const cur = read(mergePath), clean = stripBlock(stripMergeLegacy(cur))
        if (clean !== cur) fs.writeFileSync(mergePath, clean) // a file with nothing of ours in it is not written (it would only move its mtime)
      }
    } catch (e) { mergeCleanup = { ok: false, path: mergePath, error: e.message } }
    // An unreadable runtime must not throw out of off() either: the Script.js strip has ALREADY run, so a throw leaves the machine half-torn-down with no structured result at all.
    let reloaded = { status: null }
    let runtimeError = null, rt = null
    try { rt = read(runtimePath, null) } catch (e) {
      runtimeError = `cannot read the runtime config ${runtimePath} (${e.code || e.message}) — the runtime splice was NOT cleared`
    }
    if (rt) reloaded = await reload(stripRuntime(rt))
    const st = await status()
    // Verify the undo actually landed — do not take the write's word for it.
    const why = []
    if (restoreError) why.push(restoreError)
    else if (st.scriptInstalled) why.push(`${scriptPath} still carries the atrace block after the strip (sentinel lines edited or missing?)`)
    // UNKNOWN (unreadable Script.js) is not "clean": never claim a teardown we could not verify.
    else if (st.scriptInstalled === null) why.push(`could not verify the strip — ${scriptPath} is unreadable (${st.readError || 'unknown error'})`)
    if (runtimeError) why.push(runtimeError)
    if (!reloadOk(reloaded)) why.push(reloadWhy(reloaded))
    // an ACCEPTED reload is not proof either: if the core still lists the proxy, the route is live
    else if (reloaded.status != null && st.live === true) why.push(`mihomo accepted the reload but ${PROXY_NAME} is STILL in its live proxy list`)
    // no reload was made (there is no runtime config to build a clean one from) and the core still lists the route: it is live, and nothing done here took it out
    else if (reloaded.status == null && st.live === true) why.push(`${PROXY_NAME} is still in the core's live proxy list and no reload was made: there is no runtime config (${runtimePath}) to build a clean one from`)
    if (why.length) {
      return {
        ok: false,
        // Once the block is really gone from Script.js, a Verge regen drops the live route too — so that is the by-hand fix. While the block is still there, reactivating would RE-APPLY it.
        reason: `desktop steer NOT fully removed: ${why.join('; ')}. CC-Desktop traffic may STILL be routed into the MITM; ${st.scriptInstalled === false
          ? `the atrace block IS gone from Script.js — to drop the live route now, ${REACTIVATE_HINT}`
          : 're-run `trocar desktop off` and check `trocar desktop status`'}.`,
        reload: reloaded, status: st, ...(mergeCleanup ? { mergeCleanup } : {}),
      }
    }
    return { ok: true, reload: reloaded, status: st, ...(mergeCleanup ? { mergeCleanup } : {}) }
  }

  return { platform, scriptPath, runtimePath, mergePath, read, mihomoReload: reload, probeLive: live, located: () => located, status, off }
}
