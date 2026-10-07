// clash.mjs (src/off) — taking asight's route out of Clash Verge / mihomo, and asking the core whether it is gone (RFC 1.6 §4 「旧 MITM 达到 off 保证的条件」, §6 「入账」「核对生效」;
// D28 only the sentinel block goes; D29 the runtime is reloaded by payload and the live proxy list is read back). `asight off` (src/off/legacy.mjs) and `asight desktop off` (src/capture/
// desktop-steer.mjs) run THIS code: there is one undo, not two. Moved here from src/capture/desktop-steer.mjs without a change of behaviour — the steer's `on` side (scriptBlock, injectScript,
// spliceRuntime) stays there, and the old names are re-exported from it. Imports only node:* and src/off (0.1 §2: the standalone ~/.asight/bin/asight-off is made of this directory).
//   pure          stripBlock · stripRuntime · stripMergeLegacy — the text of a file with asight's route taken out, every other byte as it was
//   the core      knownMihomoSocks · mihomoSockCandidates · discoverMihomoSock · probeVersion · mihomoPayloadReload · probeProxy — the control socket is discovered, never hard-coded (D29)
import nodeFs from 'node:fs'
import http from 'node:http'

export const PROXY_NAME = 'atrace-mitm'
export const DESKTOP_RULE = `AND,((PROCESS-PATH-REGEX,(?i)Application Support/Claude/claude-code),(DOMAIN,api.anthropic.com)),${PROXY_NAME}`
// the sentinel INNER text is comment-syntax-agnostic; Script.js (JavaScript) writes it after `//`, a runtime YAML after `#` (a `//` line is NOT a YAML comment, it would break the parse)
export const MARK_BEGIN = '>>> atrace desktop capture (managed by asight desktop) >>>'
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
 *  + `- <DESKTOP_RULE>`). Stripping only the sentinel form was D29's bug: after any regen, on() spliced a second proxy of the same name (mihomo 400 "duplicate name") and off() pushed a config that
 *  still routed into the MITM. Only the top-level `proxies:` items named EXACTLY atrace-mitm and `rules:` items equal to DESKTOP_RULE go; every other byte stays. */
export function stripRuntime(yaml) {
  const lines = stripBlock(yaml).split('\n')
  const tail = lines.at(-1) === '' ? lines.pop() : null // keep the final newline out of any item
  const out = []
  let section = null, listIndent = null, item = null
  // the item's OWN `name` only (the dash line, or a key at the item's key column) — never a nested `name:` deeper inside some other proxy (e.g. plugin-opts), which would delete the user's proxy
  const nameIs = `name:\\s*(['"]?)${clashEscape(PROXY_NAME)}\\1\\s*(?:[,}]|$)`
  const isOurProxy = ([head, ...rest]) => {
    if (new RegExp(`^\\s*-\\s+(?:\\{\\s*)?${nameIs}`).test(head)) return true
    const inline = /^(\s*-\s+)\S/.exec(head) // `- key: v` → keys sit where `key` starts
    const keyCol = inline ? inline[1].length : (rest.find((l) => l.trim()) || '').search(/\S/) // bare `-`
    return rest.some((l) => l.length - l.trimStart().length === keyCol && new RegExp(`^\\s*${nameIs}`).test(l))
  }
  const isOurRule = (l) => new RegExp(`^\\s*-\\s+(['"]?)${clashEscape(DESKTOP_RULE)}\\1\\s*$`).test(l)
  const flush = () => { if (item && !isOurProxy(item)) out.push(...item); item = null }
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

/** The demo's atrace-desktop wrote `prepend-proxies:` / `prepend-rules:` blocks into Merge.yaml (inert on Verge 2.5.1). Strip that legacy shape too, so an off leaves a clean Merge.yaml. */
export function stripMergeLegacy(yaml) {
  return yaml
    .replace(/\n?prepend-proxies:\n(?:[ \t]*-[^\n]*\n?)+/g, '\n')
    .replace(/\n?prepend-rules:\n(?:[ \t]*-[^\n]*\n?)+/g, '\n')
}

// ── the mihomo control socket: discovered, never hard-coded (D29) ────────────────────────────────
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
