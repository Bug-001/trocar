// src/capture/desktop-steer.mjs — macOS-only Clash-Verge steer for CC-Desktop capture (D22 · 4.1:61).
//
// CC-Desktop force-overwrites its base_url and ignores settings.json env, so it can't be reverse-
// proxied (4.1:19); its ONLY capture path is a surgical Clash rule that routes exactly
//   claude-code → api.anthropic.com   →  the product MITM (`asight mitm`)
// and nothing else — the OS system proxy is NEVER touched (4.1:14/54 · Non-Goal · 必拒).
//
// DURABLE MECHANISM = the Clash Verge Rev GLOBAL Script (profiles/Script.js). Verge 2.5.1's global
// "Merge" is a plain RFC-7386 deep-merge that does NOT expand `prepend-rules`/`prepend-proxies`
// (they leak verbatim → mihomo ignores them → the demo's Merge.yaml steer is INERT here). The
// global Script instead runs LAST on the fully-assembled config on EVERY enhance (subscription /
// profile update, restart), so imperatively unshifting the proxy + rule both SURVIVES a regen and
// is RELIABLY applied. We also hot-reload mihomo once so it goes live immediately, without waiting
// for a natural regen (D29: discover the live control socket, reload by `{payload}`, write no file).
// mihomo validates a reload and keeps the OLD config on error → a bad edit can't break the VPN.
// macOS-only: non-darwin refuses explicitly (D22 — not a cross-OS contract).

import { homedir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import * as realFs from 'node:fs';

export const PROXY_NAME = 'atrace-mitm';
export const DESKTOP_RULE = `AND,((PROCESS-PATH-REGEX,(?i)Application Support/Claude/claude-code),(DOMAIN,api.anthropic.com)),${PROXY_NAME}`;
// sentinel INNER text is comment-syntax-agnostic; JS uses `//`, YAML uses `#` (a `//` line is NOT a
// YAML comment → it would break the runtime config parse). stripBlock matches the inner text so it
// removes either form.
const MARK_BEGIN = '>>> atrace desktop capture (managed by asight desktop) >>>';
const MARK_END = '<<< atrace desktop capture <<<';
const BEGIN = `// ${MARK_BEGIN}`;  // Script.js (JavaScript)
const END = `// ${MARK_END}`;
const YBEGIN = `# ${MARK_BEGIN}`;  // clash-verge.yaml (YAML)
const YEND = `# ${MARK_END}`;
const proxyLine = (port) => `- {name: ${PROXY_NAME}, type: http, server: 127.0.0.1, port: ${port}}`;

// ── pure transforms (unit-testable; no I/O) ──────────────────────────────────────────────────

// The imperative block injected into the global Script's main(). Idempotent + null-guarded: it
// only unshifts when the proxy/rule aren't already present, so re-running Verge's enhance N times
// keeps exactly one of each. unshift → the scoped rule wins ahead of the subscription's generic
// `DOMAIN-SUFFIX,anthropic.com` rules (mihomo is first-match).
export function scriptBlock(port) {
  return [
    `  ${BEGIN}`,
    '  config.proxies = config.proxies || [];',
    '  config.rules = config.rules || [];',
    `  if (!config.proxies.some(function (p) { return p && p.name === '${PROXY_NAME}'; })) config.proxies.unshift({ name: '${PROXY_NAME}', type: 'http', server: '127.0.0.1', port: ${port} });`,
    `  var __atraceRule = '${DESKTOP_RULE}';`,
    '  if (config.rules.indexOf(__atraceRule) === -1) config.rules.unshift(__atraceRule);',
    `  ${END}`,
  ].join('\n');
}

// strip any prior atrace block (between the sentinels, inclusive of its own line) from JS OR YAML —
// matches on the inner marker text so it catches both the `//`-prefixed and `#`-prefixed forms.
export function stripBlock(text) {
  const re = new RegExp(`\\n?[^\\n]*${escapeRe(MARK_BEGIN)}[\\s\\S]*?${escapeRe(MARK_END)}[^\\n]*`, 'g');
  return text.replace(re, '');
}

// A trivial (no-op) main — `function main(...) { return config; }`, with any whitespace/comments —
// which is exactly Clash Verge's stock global Script. Matching it lets us canonically REPLACE it
// (idempotent by construction: stripping our block leaves a trivial main again → same replacement).
const TRIVIAL_MAIN = /function\s+main\s*\([^)]*\)\s*\{\s*(?:\/\/[^\n]*\n\s*)*return\s+config\s*;?\s*\}/;

// inject the atrace block into the global Script's main(). Rebuilds from a clean base (strip first)
// so re-running is idempotent — Script.js always ends with exactly one block.
export function injectScript(baseScript, port) {
  const clean = stripBlock(baseScript);
  const canonicalMain = `function main(config, profileName) {\n${scriptBlock(port)}\n  return config;\n}`;
  if (TRIVIAL_MAIN.test(clean)) return clean.replace(TRIVIAL_MAIN, canonicalMain); // the stock no-op path
  // a CUSTOM main() → insert the block right after its opening brace (runs first, user logic after)
  const opens = clean.match(/function\s+main\s*\([^)]*\)\s*\{/g);
  if (opens) {
    const open = opens[opens.length - 1];
    const at = clean.lastIndexOf(open) + open.length;
    return clean.slice(0, at) + '\n' + scriptBlock(port) + clean.slice(at);
  }
  return `${clean.replace(/\s+$/, '')}\n${canonicalMain}\n`; // no main at all → define one (defensive)
}

// splice the atrace proxy + rule into a RUNTIME clash-verge.yaml's REAL `proxies:`/`rules:` arrays
// (for immediate effect before the next Verge regen). Idempotent: strip first, then insert one line
// right after each top-level `proxies:` / `rules:` key. Prepends → wins first-match.
export function spliceRuntime(yaml, port) {
  const lines = stripRuntime(yaml).split('\n');
  const out = [];
  let didP = false, didR = false;
  for (const ln of lines) {
    out.push(ln);
    if (!didP && ln.replace(/\s+$/, '') === 'proxies:') { out.push(YBEGIN, proxyLine(port), YEND); didP = true; }
    else if (!didR && ln.replace(/\s+$/, '') === 'rules:') { out.push(YBEGIN, `- ${DESKTOP_RULE}`, YEND); didR = true; }
  }
  return { yaml: out.join('\n'), splicedProxies: didP, splicedRules: didR };
}

// Remove EVERY atrace route from a runtime yaml: our sentinel-marked splice, AND the unmarked copy
// the durable Script.js puts there at each Verge regen (serde_yaml block style, `- name: atrace-mitm`
// + `- <DESKTOP_RULE>`). Stripping only the sentinel form was D29's bug: after any regen, on()
// spliced a second proxy of the same name (mihomo 400 "duplicate name") and off() pushed a config
// that still routed into the MITM. Only the top-level `proxies:` items named EXACTLY atrace-mitm and
// `rules:` items equal to DESKTOP_RULE go; every other byte stays.
export function stripRuntime(yaml) {
  const lines = stripBlock(yaml).split('\n');
  const tail = lines.at(-1) === '' ? lines.pop() : null; // keep the final newline out of any item
  const out = [];
  let section = null, listIndent = null, item = null;
  // the item's OWN `name` only (the dash line, or a key at the item's key column) — never a nested
  // `name:` deeper inside some other proxy (e.g. plugin-opts), which would delete the user's proxy
  const nameIs = `name:\\s*(['"]?)${escapeRe(PROXY_NAME)}\\1\\s*(?:[,}]|$)`;
  const isOurProxy = ([head, ...rest]) => {
    if (new RegExp(`^\\s*-\\s+(?:\\{\\s*)?${nameIs}`).test(head)) return true;
    const inline = /^(\s*-\s+)\S/.exec(head); // `- key: v` → keys sit where `key` starts
    const keyCol = inline ? inline[1].length : (rest.find((l) => l.trim()) || '').search(/\S/); // bare `-`
    return rest.some((l) => l.length - l.trimStart().length === keyCol && new RegExp(`^\\s*${nameIs}`).test(l));
  };
  const isOurRule = (l) => new RegExp(`^\\s*-\\s+(['"]?)${escapeRe(DESKTOP_RULE)}\\1\\s*$`).test(l);
  const flush = () => { if (item && !isOurProxy(item)) out.push(...item); item = null; };
  for (const ln of lines) {
    const top = /^[^\s#-][^:]*:/.test(ln);
    if (top) { flush(); section = ln.split(':')[0]; listIndent = null; out.push(ln); continue; }
    const dash = /^(\s*)-(?:\s|$)/.exec(ln);
    if (dash && listIndent === null) listIndent = dash[1].length;
    if (section === 'proxies') {
      if (dash && dash[1].length === listIndent) { flush(); item = [ln]; continue; }
      if (item) { item.push(ln); continue; }
    } else if (section === 'rules' && dash && dash[1].length === listIndent && isOurRule(ln)) continue;
    out.push(ln);
  }
  flush();
  if (tail !== null) out.push(tail);
  return out.join('\n');
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ── the mihomo control socket: discovered, never hard-coded (D29) ─────────────────────────────
// Where the live core listens depends on how Verge runs it: 2.5.x service mode = clash-verge-service
// starts mihomo as root with `-ext-ctl-unix /var/run/clash-verge-service/users/<uid>/…`; older service
// mode used /tmp/verge/…; sidecar mode uses the runtime yaml's external-controller-unix (which service
// mode leaves STALE). So: ask the running process first, then the yaml, then the known spots — and
// only trust a candidate that actually answers.
export const knownMihomoSocks = (uid) => [
  ...(uid != null ? [`/var/run/clash-verge-service/users/${uid}/verge-mihomo.sock`] : []),
  '/tmp/verge/verge-mihomo.sock',
];

export function mihomoSockCandidates({ psText = '', runtimeYaml = '', known = [] } = {}) {
  const fromPs = [];
  for (const line of psText.split('\n')) {
    // the path may contain spaces (ps joins argv with ' '): take it up to the next ` -flag` or EOL
    const m = /(?:^|\s)--?ext-ctl-unix(?:=|\s+)(.+?)(?=\s+-{1,2}[A-Za-z][\w-]*(?:[=\s]|$)|\s*$)/.exec(line);
    if (m) fromPs.push(m[1]);
  }
  const y = /^external-controller-unix:[ \t]*(['"]?)(.+?)\1[ \t]*$/m.exec(runtimeYaml);
  return [...new Set([...fromPs, ...(y ? [y[2]] : []), ...known])];
}

export async function discoverMihomoSock(candidates, probe = probeVersion) {
  const tried = [];
  for (const c of candidates) {
    tried.push(c);
    if (await probe(c).catch(() => false)) return { sock: c, tried };
  }
  return { sock: null, tried };
}

// read-only: does something speaking mihomo's API answer on this socket? Only a socket owned by root
// (service mode) or by us (sidecar mode) qualifies: the reload sends it the WHOLE config inline,
// subscription credentials included, so a socket another local user planted (world-writable /tmp,
// or a `-ext-ctl-unix` on some other process's command line) must never be picked.
function probeVersion(sock) {
  try {
    const st = realFs.statSync(sock);
    if (!st.isSocket() || (st.uid !== 0 && st.uid !== process.getuid?.())) return Promise.resolve(false);
  } catch { return Promise.resolve(false); }
  return new Promise((resolve) => {
    const req = http.request({ socketPath: sock, method: 'GET', path: '/version', timeout: 1500 }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(res.statusCode === 200 && !!JSON.parse(b).version); } catch { resolve(false); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(false)); req.end();
  });
}

// ── the mihomo hot-reload: PUT /configs {payload} ─────────────────────────────────────────────
// The `{path}` form is dead in service mode: mihomo only loads files under its home dir / SAFE_PATHS,
// and there that is a root-owned dir the user cannot write (400 "path is not subpath of home
// directory or SAFE_PATHS"). `{payload}` carries the config inline (204 on v1.19.31) → no file is
// written anywhere. mihomo validates and keeps the OLD config on error → VPN-safe; its own error
// message is carried back so a rejection is diagnosable, not just a status code.
export function mihomoPayloadReload(sock) {
  return (yamlPayload) => new Promise((resolve) => {
    const body = JSON.stringify({ payload: yamlPayload });
    const req = http.request({ socketPath: sock, method: 'PUT', path: '/configs?force=true', timeout: 30000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => {
        let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c));
        res.on('end', () => {
          const r = { status: res.statusCode };
          if (res.statusCode >= 300) { let msg = b.trim(); try { msg = JSON.parse(b).message || msg; } catch { /* not JSON */ } if (msg) r.error = msg; }
          resolve(r);
        });
      });
    req.on('timeout', () => req.destroy(new Error('timed out waiting for mihomo')));
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.end(body);
  });
}
function probeProxy(sock) {
  return new Promise((resolve) => {
    const req = http.request({ socketPath: sock, method: 'GET', path: '/proxies', timeout: 5000 }, (res) => {
      let b = ''; res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(!!JSON.parse(b).proxies?.[PROXY_NAME]); } catch { resolve(null); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(null)); req.end(); // could not ask → UNKNOWN, never "not live"
  });
}

// The by-hand way to make Verge regenerate (and so apply the durable Script.js state) when the
// immediate step cannot: there is no supported external API for "regenerate" in Verge 2.5.x.
export const REACTIVATE_HINT = 'open Clash Verge → Profiles and click the flame (reactivate) button on the active profile';

// ── the macOS steer + non-darwin reserved stub ───────────────────────────────────────────────

const reserved = (platform) => ({
  platform,
  on() { return { ok: false, reserved: true, reason: `Clash steer is a macOS-Desktop-only implementation (D22); not applicable on ${platform}. Use \`asight on\` (reverse-proxy) for CC-CLI.` }; },
  off() { return { ok: false, reserved: true, reason: `not applicable on ${platform}` }; },
  status() { return { platform, reserved: true, scriptInstalled: false }; },
});

export function getDesktopSteer(platform = process.platform, deps = {}) {
  if (platform !== 'darwin') return reserved(platform);
  const fs = deps.fs || realFs;
  const home = deps.home || homedir();
  const vergeDir = deps.vergeDir || path.join(home, 'Library', 'Application Support', 'io.github.clash-verge-rev.clash-verge-rev');
  const scriptPath = deps.scriptPath || path.join(vergeDir, 'profiles', 'Script.js');
  const runtimePath = deps.runtimePath || path.join(vergeDir, 'clash-verge.yaml');
  const mergePath = deps.mergePath || path.join(vergeDir, 'profiles', 'Merge.yaml');
  const NO_OP = '// Define main function (script entry)\nfunction main(config, profileName) { return config; }\n';

  // The live control socket (D29). deps.sock pins it; otherwise it is discovered lazily — only by the
  // DEFAULT reload/probe, so a caller that injects both never has the real machine probed. A found
  // socket is remembered for this steer; a miss is retried next call (Verge may just be starting).
  // ASIGHT_MIHOMO_SOCK pins it too (unusual installs; and CLI tests, so a sandboxed run can never reach
  // the developer's own core). No Verge runtime config for this HOME → there is no Verge to look for.
  const pinned = deps.sock || process.env.ASIGHT_MIHOMO_SOCK;
  let located = pinned ? { sock: pinned, tried: [pinned] } : null;
  const locate = async () => {
    if (located?.sock) return located;
    if (!fs.existsSync(runtimePath)) return (located = { sock: null, tried: [] });
    let psText = '';
    try { psText = deps.psText ? deps.psText() : execFileSync('/bin/ps', ['-axww', '-o', 'command='], { encoding: 'utf8', timeout: 3000 }); } catch { /* no ps → other candidates */ }
    let runtimeYaml = '';
    try { runtimeYaml = fs.readFileSync(runtimePath, 'utf8'); } catch { /* absent/unreadable → other candidates */ }
    const known = deps.knownSocks || knownMihomoSocks(process.getuid?.());
    located = await discoverMihomoSock(mihomoSockCandidates({ psText, runtimeYaml, known }));
    return located;
  };
  const noSock = (l) => `no live mihomo control socket found (tried: ${l.tried.join(', ') || 'none'})`;
  const mihomoReload = deps.mihomoReload || (async (yaml) => {
    const l = await locate();
    return l.sock ? mihomoPayloadReload(l.sock)(yaml) : { status: 0, error: noSock(l) };
  });
  // no socket → UNKNOWN (null), never "not live": we could not ask
  const probeLive = deps.probeLive || (async () => { const l = await locate(); return l.sock ? probeProxy(l.sock) : null; });

  // ONLY a genuinely absent file may fall back to the default. Every other read failure (EACCES on
  // the user's own Script.js, a directory, a broken symlink) MUST NOT degrade into "empty → use the
  // NO_OP stub", because on() would then write a GENERATED script over Clash logic it never saw.
  // Throw, naming the file, before anything is written (same discipline as onboard's settings.json).
  const read = (p, dflt = '') => {
    try { return fs.readFileSync(p, 'utf8'); } catch (e) {
      if (e && e.code === 'ENOENT') return dflt;
      // carry the cause forward: callers that already wrote something MUST render their own,
      // accurate "what state is the machine in now" message rather than this pre-write one.
      const err = new Error(`asight refused to touch ${p}: cannot read it (${e.code || e.message}). Nothing was written — fix or move the file, then retry.`);
      err.code = e && e.code; err.path = p;
      throw err;
    }
  };
  // A reload we never had to make (no runtime config on disk) is not a failure; any attempted reload
  // that mihomo did not accept IS one — the steer is not live, whatever the durable half did.
  const reloadOk = (r) => r == null || r.status === null || r.status === 200 || r.status === 204;
  const reloadWhy = (r) => `mihomo reload FAILED (status ${r?.status}${r?.error ? `: ${r.error}` : ''})`;

  async function on({ port = 9899 } = {}) {
    // 1. DURABLE: augment the global Script (rebuild from the clean original each time → idempotent).
    //    READ FIRST: a present-but-unreadable Script.js throws here, before anything is written.
    //    No whole-file backup (D28): the undo is stripping our sentinel block, not a snapshot restore.
    const original = read(scriptPath, null);
    const base = stripBlock(original ?? NO_OP) || NO_OP;
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, injectScript(base, port));
    // 2. CLEANUP: drop any legacy inert atrace block the old Merge.yaml path left (wrong/9899 port).
    //    Best-effort: that block is INERT on Verge 2.5.1, so failing to tidy it neither routes nor
    //    un-routes anything — but never let it abort (or silently pass for) the real steer.
    let mergeCleanup = null;
    try {
      if (fs.existsSync(mergePath)) { const m = read(mergePath); const cleaned = stripBlock(stripMergeLegacy(m)); if (cleaned !== m) fs.writeFileSync(mergePath, cleaned); }
    } catch (e) { mergeCleanup = { ok: false, path: mergePath, error: e.message }; }
    // 3. IMMEDIATE: splice the current runtime + hot-reload mihomo so it goes live now (mihomo
    //    validates & keeps the old config on error → the VPN can't break on a bad edit)
    //    A splice that found no `proxies:`/`rules:` anchor (quoted keys, flow-style arrays, …) is a
    //    NO-OP: reloading that config would route nothing while reporting success, so the user would
    //    believe capture is live and silently record nothing. Refuse loudly instead.
    //    An UNREADABLE runtime (EACCES/EISDIR) must not throw out of on(): Script.js has already
    //    been written by this point, so an exception would leave the machine half-applied AND give
    //    the caller no structured result to report. Fail loudly, as a result.
    let reload = { status: null };
    let rt;
    try { rt = read(runtimePath, null); } catch (e) {
      return {
        ok: false,
        reason: `cannot read the runtime config ${runtimePath} (${e.code || e.message}) — NOT live now (mihomo was not reloaded). The durable Script.js steer IS installed and applies at Verge's next regen — to apply it now, ${REACTIVATE_HINT}.`,
        port, scriptPath, reload, status: await status(), ...(mergeCleanup ? { mergeCleanup } : {}),
      };
    }
    if (rt) {
      const { yaml, splicedProxies, splicedRules } = spliceRuntime(rt, port);
      if (!splicedProxies || !splicedRules) {
        const missing = [!splicedProxies && 'proxies:', !splicedRules && 'rules:'].filter(Boolean).join(' + ');
        return {
          ok: false,
          reason: `runtime splice found no ${missing} anchor in ${runtimePath} — NOT live now (mihomo was not reloaded). The durable Script.js steer IS installed and applies at Verge's next regen — to apply it now, ${REACTIVATE_HINT}.`,
          port, scriptPath, reload, status: await status(), ...(mergeCleanup ? { mergeCleanup } : {}),
        };
      }
      reload = await mihomoReload(yaml);
    }
    // A reload mihomo refused (rejected config) or never received (control socket down) means the
    // steer is NOT live now — the machine-readable result MUST say so, not just the CLI's printout.
    const st = await status();
    // an ACCEPTED reload is not proof: check the core really carries the route now (null = could not ask)
    if (reloadOk(reload) && reload.status != null && st.live === false) reload = { ...reload, notLive: true };
    if (!reloadOk(reload) || reload.notLive) {
      return {
        ok: false,
        reason: `${reload.notLive ? `mihomo accepted the reload but ${PROXY_NAME} is NOT in its live proxy list` : reloadWhy(reload)} — NOT live now. The durable Script.js steer IS installed and applies at Verge's next regen — to apply it now, ${REACTIVATE_HINT}.`,
        port, scriptPath, reload, status: st, ...(mergeCleanup ? { mergeCleanup } : {}),
      };
    }
    return { ok: true, port, scriptPath, reload, status: st, ...(mergeCleanup ? { mergeCleanup } : {}) };
  }

  // off() MUST report the REAL teardown outcome. A failed undo that reports ok:true tells the user
  // monitoring is off while CC-Desktop traffic is STILL routed into the MITM — the worst shape of
  // failure for a tool whose undo is first-class (4.1:64 「off 对称 … 零残留」).
  // The undo strips ONLY the sentinel block (D28). Everything outside it — the user's own global-
  // Script logic, including rules added while capture was on — stays byte-for-byte. Never roll the
  // whole file back to a snapshot: that silently deletes whatever the user changed since it was taken.
  async function off() {
    let restoreError = null;
    if (fs.existsSync(scriptPath)) {
      try {
        const cur = read(scriptPath);
        const clean = stripBlock(cur);
        if (clean !== cur) fs.writeFileSync(scriptPath, clean);
      } catch (e) { restoreError = `could not strip the atrace block from ${scriptPath} (${e.code || e.message})`; }
    }
    let mergeCleanup = null;
    try {
      if (fs.existsSync(mergePath)) fs.writeFileSync(mergePath, stripBlock(stripMergeLegacy(read(mergePath))));
    } catch (e) { mergeCleanup = { ok: false, path: mergePath, error: e.message }; }
    // An unreadable runtime must not throw out of off() either: the Script.js strip has ALREADY
    // run, so a throw leaves the machine half-torn-down with no structured result at all.
    let reload = { status: null };
    let runtimeError = null, rt = null;
    try { rt = read(runtimePath, null); } catch (e) {
      runtimeError = `cannot read the runtime config ${runtimePath} (${e.code || e.message}) — the runtime splice was NOT cleared`;
    }
    if (rt) reload = await mihomoReload(stripRuntime(rt));
    const st = await status();
    // Verify the undo actually landed — do not take the write's word for it.
    const why = [];
    if (restoreError) why.push(restoreError);
    else if (st.scriptInstalled) why.push(`${scriptPath} still carries the atrace block after the strip (sentinel lines edited or missing?)`);
    // UNKNOWN (unreadable Script.js) is not "clean": never claim a teardown we could not verify.
    else if (st.scriptInstalled === null) why.push(`could not verify the strip — ${scriptPath} is unreadable (${st.readError || 'unknown error'})`);
    if (runtimeError) why.push(runtimeError);
    if (!reloadOk(reload)) why.push(reloadWhy(reload));
    // an ACCEPTED reload is not proof either: if the core still lists the proxy, the route is live
    else if (reload.status != null && st.live === true) why.push(`mihomo accepted the reload but ${PROXY_NAME} is STILL in its live proxy list`);
    if (why.length) {
      return {
        ok: false,
        // Once the block is really gone from Script.js, a Verge regen drops the live route too — so
        // that is the by-hand fix. While the block is still there, reactivating would RE-APPLY it.
        reason: `desktop steer NOT fully removed — ${why.join('; ')}. CC-Desktop traffic may STILL be routed into the MITM; ${st.scriptInstalled === false
          ? `the atrace block IS gone from Script.js — to drop the live route now, ${REACTIVATE_HINT}`
          : 're-run \`asight desktop off\` and check \`asight desktop status\`'}.`,
        reload, status: st, ...(mergeCleanup ? { mergeCleanup } : {}),
      };
    }
    return { ok: true, reload, status: st, ...(mergeCleanup ? { mergeCleanup } : {}) };
  }

  async function status() {
    // status() must never crash: an unreadable Script.js is reported as UNKNOWN (null) + why, which
    // is honest, rather than as `false` (= "not installed"), which would be a lie.
    let scriptInstalled = false, readError = null;
    try { scriptInstalled = read(scriptPath).includes(BEGIN); } catch (e) { scriptInstalled = null; readError = e.message; }
    let live = null; try { live = await probeLive(); } catch { live = null; }
    return { platform, scriptInstalled, live, proxyName: PROXY_NAME, scriptPath, ...(located ? { mihomoSock: located.sock } : {}), ...(readError ? { readError } : {}) };
  }

  return { platform, on, off, status };
}

// The demo's atrace-desktop wrote `prepend-proxies:`/`prepend-rules:` blocks into Merge.yaml (inert
// on Verge 2.5.1). Strip that legacy shape too, so `desktop on/off` leaves a clean Merge.yaml.
export function stripMergeLegacy(yaml) {
  return yaml
    .replace(/\n?prepend-proxies:\n(?:[ \t]*-[^\n]*\n?)+/g, '\n')
    .replace(/\n?prepend-rules:\n(?:[ \t]*-[^\n]*\n?)+/g, '\n');
}
