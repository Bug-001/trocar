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
// for a natural regen. mihomo validates a reload and keeps the OLD config on error → a bad edit
// can't break the VPN. macOS-only: non-darwin refuses explicitly (D22 — not a cross-OS contract).

import { homedir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
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
export function stripRuntime(yaml) { return stripBlock(yaml); }

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ── the mihomo hot-reload (injectable; default = the Verge control unix socket) ────────────────

// mihomo's /configs PUT reloads from a FILE path (the `{payload}` form is rejected 400 on Verge's
// mihomo). So write the spliced config to a sibling file (NOT Verge's own clash-verge.yaml — Verge
// owns that) and reload from it. mihomo validates and keeps the OLD config on error → VPN-safe.
export function defaultMihomoReload(sock, applyPath) {
  return (yamlPayload) => new Promise((resolve) => {
    try { realFs.writeFileSync(applyPath, yamlPayload); } catch (e) { return resolve({ status: 0, error: e.message }); }
    const body = JSON.stringify({ path: applyPath });
    const req = http.request({ socketPath: sock, method: 'PUT', path: '/configs?force=true', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.write(body); req.end();
  });
}
function defaultProbeLive(sock) {
  return () => new Promise((resolve) => {
    const req = http.request({ socketPath: sock, method: 'GET', path: '/proxies' }, (res) => {
      let b = ''; res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(!!JSON.parse(b).proxies?.[PROXY_NAME]); } catch { resolve(false); } });
    });
    req.on('error', () => resolve(false)); req.end();
  });
}

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
  const sock = deps.sock || '/tmp/verge/verge-mihomo.sock';
  const applyPath = deps.applyPath || path.join(vergeDir, 'clash-verge-asight.yaml');
  const mihomoReload = deps.mihomoReload || defaultMihomoReload(sock, applyPath);
  const probeLive = deps.probeLive || defaultProbeLive(sock);
  const NO_OP = '// Define main function (script entry)\nfunction main(config, profileName) { return config; }\n';

  const read = (p, dflt = '') => { try { return fs.readFileSync(p, 'utf8'); } catch { return dflt; } };
  const backupOnce = (p) => { const bak = p + '.atrace-bak'; if (fs.existsSync(p) && !fs.existsSync(bak)) fs.writeFileSync(bak, fs.readFileSync(p, 'utf8')); };

  async function on({ port = 9899 } = {}) {
    // 1. DURABLE: augment the global Script (rebuild from the clean original each time → idempotent)
    backupOnce(scriptPath);
    const base = stripBlock(read(scriptPath, NO_OP)) || NO_OP;
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, injectScript(base, port));
    // 2. CLEANUP: drop any legacy inert atrace block the old Merge.yaml path left (wrong/9899 port)
    if (fs.existsSync(mergePath)) { const m = read(mergePath); const cleaned = stripBlock(stripMergeLegacy(m)); if (cleaned !== m) fs.writeFileSync(mergePath, cleaned); }
    // 3. IMMEDIATE: splice the current runtime + hot-reload mihomo so it goes live now (mihomo
    //    validates & keeps the old config on error → the VPN can't break on a bad edit)
    //    A splice that found no `proxies:`/`rules:` anchor (quoted keys, flow-style arrays, …) is a
    //    NO-OP: reloading that config would route nothing while reporting success, so the user would
    //    believe capture is live and silently record nothing. Refuse loudly instead.
    let reload = { status: null };
    const rt = read(runtimePath, null);
    if (rt) {
      const { yaml, splicedProxies, splicedRules } = spliceRuntime(rt, port);
      if (!splicedProxies || !splicedRules) {
        const missing = [!splicedProxies && 'proxies:', !splicedRules && 'rules:'].filter(Boolean).join(' + ');
        return {
          ok: false,
          reason: `runtime splice found no ${missing} anchor in ${runtimePath} — NOT live now (mihomo was not reloaded). The durable Script.js steer IS installed and should apply on the next Verge enhance/regen.`,
          port, scriptPath, reload, status: await status(),
        };
      }
      reload = await mihomoReload(yaml);
    }
    return { ok: true, port, scriptPath, reload, status: await status() };
  }

  async function off() {
    if (fs.existsSync(scriptPath)) { const bak = scriptPath + '.atrace-bak'; fs.writeFileSync(scriptPath, fs.existsSync(bak) ? fs.readFileSync(bak, 'utf8') : stripBlock(read(scriptPath, NO_OP))); }
    if (fs.existsSync(mergePath)) fs.writeFileSync(mergePath, stripBlock(stripMergeLegacy(read(mergePath))));
    let reload = { status: null };
    const rt = read(runtimePath, null);
    if (rt) reload = await mihomoReload(stripRuntime(rt));
    return { ok: true, reload, status: await status() };
  }

  async function status() {
    const scriptInstalled = read(scriptPath).includes(BEGIN);
    let live = null; try { live = await probeLive(); } catch { live = null; }
    return { platform, scriptInstalled, live, proxyName: PROXY_NAME, scriptPath };
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
