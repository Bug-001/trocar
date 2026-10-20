// src/capture/desktop-steer.mjs — macOS-only Clash-Verge steer for CC-Desktop capture (D22 · 4.1:61).
//
// CC-Desktop force-overwrites its base_url and ignores settings.json env, so it can't be reverse-
// proxied (4.1:19); its ONLY capture path is a surgical Clash rule that routes exactly
//   claude-code → api.anthropic.com   →  the product MITM (`trocar mitm`)
// and nothing else — the OS system proxy is NEVER touched (4.1:14/54 · Non-Goal · 必拒).
//
// DURABLE MECHANISM = the Clash Verge Rev GLOBAL Script (profiles/Script.js). Verge 2.5.1's global
// "Merge" is a plain RFC-7386 deep-merge that does NOT expand `prepend-rules`/`prepend-proxies`
// (they leak verbatim → mihomo ignores them → the demo's Merge.yaml steer is INERT here). The
// global Script instead runs LAST on the fully-assembled config on EVERY enhance (subscription /
// profile update, restart), so imperatively unshifting the proxy + rule both SURVIVES a regen and
// is RELIABLY applied. We also hot-reload mihomo once so it goes live immediately, without waiting
// for a natural regen (discover the live control socket, reload by `{payload}`, write no file).
// mihomo validates a reload and keeps the OLD config on error → a bad edit can't break the VPN.
// macOS-only: non-darwin refuses explicitly (D22 — not a cross-OS contract).

import { homedir } from 'node:os';
import path from 'node:path';
import * as realFs from 'node:fs';
import {
  PROXY_NAME, DESKTOP_RULE, MARK_BEGIN, MARK_END, stripBlock, stripRuntime, stripMergeLegacy, knownMihomoSocks, mihomoSockCandidates,
  discoverMihomoSock, mihomoPayloadReload, makeClash, reloadOk, reloadWhy, REACTIVATE_HINT,
} from '../off/clash.mjs';

// The strip / reload / verify half and the socket discovery live in src/off/clash.mjs (`desktop off` runs it); the names tests and other modules import from here stay.
export { PROXY_NAME, DESKTOP_RULE, stripBlock, stripRuntime, stripMergeLegacy, knownMihomoSocks, mihomoSockCandidates, discoverMihomoSock, mihomoPayloadReload, REACTIVATE_HINT };
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

// ── the macOS steer + non-darwin reserved stub ───────────────────────────────────────────────

const reserved = (platform) => ({
  platform,
  on() { return { ok: false, reserved: true, reason: `Clash steer is a macOS-Desktop-only implementation (D22); not applicable on ${platform}. For CC-CLI use \`trocar on\` where the per-process collector exists (Linux), or \`trocar monitor on --no-autostart\` (the old CC-CLI steer).` }; },
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

  // The files of this Verge install and the core behind them (src/off/clash.mjs): the live control socket is discovered there, `read` refuses a file it cannot read, and `status` / `off` are the
  // undo `trocar off` runs too. deps.sock / psText / knownSocks / mihomoReload / probeLive are that module's own seams.
  const clash = makeClash({ fs, scriptPath, runtimePath, mergePath, sock: deps.sock, psText: deps.psText, knownSocks: deps.knownSocks, mihomoReload: deps.mihomoReload, probeLive: deps.probeLive, exec: deps.exec, env: deps.env || process.env, platform });
  const { read, mihomoReload, status } = clash;

  async function on({ port = 9899 } = {}) {
    // 1. DURABLE: augment the global Script (rebuild from the clean original each time → idempotent).
    //    READ FIRST: a present-but-unreadable Script.js throws here, before anything is written.
    //    No whole-file backup (1.6 R2): the undo is stripping our sentinel block, not a snapshot restore.
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

  return { platform, on, off: clash.off, status };
}
