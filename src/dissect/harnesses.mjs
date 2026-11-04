// src/dissect/harnesses.mjs — the read-side harness table (D37 ①⑤, RFC 3.4 table, 3.1): per v1 harness,
// how a record names it, which key groups its calls into a session, which headers / body fields hint at
// lanes, parents and compaction, and what trocar's trust injection changes (observer effects). Board,
// ETL and sharder all read THIS table: adding a harness = a registry row in src/off/harness-names.mjs (+ its icon) + a row here for its session keys.
//   • harness = proc.agent (D31). A record WITH proc is never re-identified from its UA, even when the
//     agent is unknown (id null). Only legacy records without proc use the UA, flagged inferred:true.
//   • never splits or joins a session by pid or connection (3.4 关键区分): proc.pid / flow_id / dst unread.
//   • proc.agent spellings: a row's `agents` = its registry row's read id, then its code id (the descriptor name), deduped (gate G2).
// Leaf module (0.1 §2): imports only its siblings and the harness registry (which imports nothing).
import { endpointOf } from './endpoints.mjs';
import { storedRequestBody } from './request-body.mjs';
import { HARNESS_REGISTRY, readIdOf } from '../off/harness-names.mjs';

const H = (name, confidence = 'high') => ({ from: 'header', name, confidence });
const B = (path, confidence = 'medium') => ({ from: 'body', name: path.join('.'), path, confidence });

// The headers the board grouped by before D37. They remain the key for records whose harness is not
// identified by proc (legacy captures, unknown agents), so upgrading never regroups an old capture.
const LEGACY_SESSION_KEYS = [H('x-claude-code-session-id'), H('x-session-id', 'medium'), H('session-id', 'medium'), H('thread-id', 'medium')];

// `traffic` (D40, RFC 4.6 §记录「保存级别」): which of the non-model traffic classes (session-sync · telemetry · files ·
// account) a call is, told by host + path — DATA, not code (D20, 0.1 §5: the capture core parses no provider). Each entry
// {host, path?, class}: `host` exact or `*.suffix`, any case; `path` a regex source tested on the path without its
// querystring; the first entry that matches wins. Nothing matches → the shared third-party hosts (src/dissect/traffic.mjs),
// then `other`. The class table (src/classes/table.mjs) compiles these entries; the collector applies it when it writes a
// record. A harness with no entries is not a loss: its calls are `other`, kept in full (4.1 Edge cases).
//
// `aux` (RFC 2.1 §种类怎么认): which background kind a call of the aux lane is, the first entry that matches. An entry reads one thing:
// `maxTokens` the reply cap (at or under it), `first` the first user message, `last` the last user message with text, `system` the
// system text. A kind listed here has a row in the lane kind table (LANE_META, LANE_KIND); no entry matches → `aux`.
//
// `cwd` (RFC 2.4 §保真边界 item 6): where a call states its working directory, a regex whose first group is the path; null: it states none.
const ROW = { ua: null, parentKeys: [], lane: [], compaction: [], requestKind: null, observerEffects: [], traffic: [], aux: [{ kind: 'quota', maxTokens: 1 }], cwd: null };
const T = (host, cls, pathSource) => ({ host, class: cls, ...(pathSource ? { path: pathSource } : {}) });
// 4.8 §5.6: injected trust changes the agent the same way in both modes; a legacy MITM / reverse-proxy capture still never carries one. `captures` scopes an
// effect to the mode whose entry causes it: 'transparent' is Linux's driver mode, 'proxy' the door of macOS / Windows (D47) — what trocar writes differs (4.11)
const BOTH = ['transparent', 'proxy'], LINUX = ['transparent'], DOOR = ['proxy']
const effect = (id, cause, what, captures = BOTH) => ({ id, captures, cause, what });

const ROWS = [
  { ...ROW, id: 'cc', ua: /claude-cli|claude-code/,
    sessionKeys: [H('x-claude-code-session-id')], // gate G3: body metadata.user_id not added until verified
    // a background call (progress summary, suggestion) is aux even when it carries its subagent's agent-id (3.4)
    lane: [{ header: 'x-claude-code-request-class', equals: 'auxiliary', lane: 'aux' }, { header: 'x-claude-code-agent-id', lane: 'subagent', key: true }],
    compaction: [{ header: 'x-cc-compaction-request' }],
    cwd: /^\s*-\s*Primary working directory: (.+)$/m,
    // Different utilities with different fates for their output. quota: a one-token liveness check, the reply discarded. titlegen: its reply
    // becomes the session's name. notify: a background summary (a JSON status) that drives Claude Desktop's push notifications. suggest: a
    // copy of the whole conversation asking for the next prompt, so its marker is only ever the LAST user text, and earlier turns may
    // quote it. websearch / webfetch: the calls the two web tools make on their own, the page summary with at most one line before the page.
    aux: [
      { kind: 'quota', maxTokens: 1 },
      { kind: 'quota', first: /^\s*quota\s*$/i },
      { kind: 'titlegen', first: /lowercase label for this job/i },
      { kind: 'notify', system: /walked away|Read the tail of what the agent/i },
      { kind: 'suggest', last: /^\s*\[SUGGESTION MODE:/ },
      { kind: 'websearch', first: /^\s*Perform a web search for the query:/ },
      { kind: 'webfetch', first: /^(?:[^\n]*\n+)?\s*Web page content:/ },
    ],
    observerEffects: [effect('cc-gzip-off', 'NODE_EXTRA_CA_CERTS in settings env',
      'Claude Code sends request bodies uncompressed while a custom CA is set')],
    // the endpoints measured on the live capture (2026-10-07): remote-session sync, telemetry, uploads,
    // account calls. The order matters: the upload before the broader /api/oauth/ account rule.
    traffic: [
      T('api.anthropic.com', 'session-sync', '^/v1/code/sessions(/|$)'),
      T('api.anthropic.com', 'telemetry', '^/api/event_logging/'),
      T('api.anthropic.com', 'files', '^/api/oauth/file_upload'),
      T('api.anthropic.com', 'files', '^/v1/files'),
      T('api.anthropic.com', 'account', '^/api/oauth/'),
      T('api.anthropic.com', 'account', '^/api/web/domain_info'),
      T('claude.ai', 'account'),
      T('downloads.claude.ai', 'files'),
    ] },
  { ...ROW, id: 'codex', ua: /codex/,
    sessionKeys: [H('session-id'), H('thread-id')], // over WebSocket these come from the upgrade request (4.6)
    parentKeys: [H('x-codex-parent-thread-id')],    // a THREAD id; resolved through aliases later (gate G4)
    lane: [{ header: 'x-openai-subagent', lane: 'subagent' }],
    requestKind: { header: 'x-codex-turn-metadata', jsonKey: 'request_kind', lanes: { prewarm: 'probe' }, compaction: ['compaction'] },
    observerEffects: [effect('codex-rustls-h2', 'SSL_CERT_FILE in $CODEX_HOME/.env',
      'model HTTP switched from native-tls to rustls; ALPN offers [h2, http/1.1]', LINUX)] }, // macOS / Windows trust the root in the store: no .env (4.11 codex forms)
  { ...ROW, id: 'opencode', ua: /opencode/,
    sessionKeys: [H('x-opencode-session-id'), H('session-id'), H('x-session-affinity'), H('x-session-id')],
    parentKeys: [H('x-opencode-parent-session-id')],
    observerEffects: [
      effect('opencode-plugin', 'trocar trust plugin',
        'trocar code runs inside the agent process; the first run adds one npm registry fetch of @opencode-ai/plugin', LINUX),
      effect('opencode-route-plugin', 'trocar route plugin',
        'trocar code runs inside the agent process; OpenCode 1.x\'s first run with a plugin adds one npm registry fetch of @opencode-ai/plugin', DOOR)] },
  { ...ROW, id: 'kimi',
    sessionKeys: [B(['prompt_cache_key']), B(['metadata', 'user_id'])],
    synth: true }, // without a body key → a synthesized key (src/dissect/synth-key.mjs, gate G11)
  { ...ROW, id: 'dsh',
    sessionKeys: [H('x-deepseek-harness-session-id')],
    parentKeys: [B(['dsh_session_log', 'session', 'parentSession'], 'high')],
    lane: [{ body: ['dsh_session_log', 'session', 'origin'], equals: 'subagent', lane: 'subagent' }],
    compaction: [{ header: 'x-deepseek-harness-compact', equals: '1' }],
    observerEffects: [effect('dsh-plugin', 'trocar trust plugin', 'trocar code runs inside the agent process')] },
  { ...ROW, id: 'hermes',
    sessionKeys: [B(['session_id']), B(['prompt_cache_key'])], // custom endpoints carry neither → synthesized
    synth: true, // (src/dissect/synth-key.mjs, gate G11)
    // a text marker (medium). Hermes is Python, so the em dash may arrive JSON-escaped.
    compaction: [{ marker: /\[CONTEXT COMPACTION (?:—|\\u2014) REFERENCE ONLY\]/ }] },
  { ...ROW, id: 'zcode',
    sessionKeys: [H('x-session-id')],
    lane: [{ header: 'x-zcode-session-type', equals: 'subagent', lane: 'subagent' }], // values not yet seen live
    observerEffects: [effect('zcode-node-https', 'network.caCertFile in ~/.zcode/cli/config.json',
      'HTTP client switched from undici to node:https: a new Agent per request, no ALPN (inferred, lab check pending)')] },
  { ...ROW, id: 'pi',
    // measured (pi 1.4.0, default configuration): openai-responses sends header session_id, Codex (WebSocket upgrade and SSE) header
    // session-id, both with body prompt_cache_key, all three = pi's session id; anthropic-messages (API key or OAuth) and chat-completions
    // send none → synthesized (src/dissect/synth-key.mjs, gate G11)
    sessionKeys: [H('session_id'), H('session-id'), B(['prompt_cache_key'])],
    synth: true,
    // the summary request (same endpoint, no tools, one user message) starts its system prompt with this sentence; a JSON string's start
    compaction: [{ marker: /(?<!\\)"You are a context summarization assistant\./ }],
    observerEffects: [
      effect('pi-extension', 'trocar trust extension', 'trocar code runs inside the agent process and pi lists it on its startup screen', LINUX),
      effect('pi-route-extension', 'trocar extension placed by install',
        'trocar code runs inside the agent process and pi lists it on its startup screen; while capture is on, the proxy variables it sets are inherited by the commands pi\'s tools run', DOOR)],
    // pi.dev: the install report (its version check is other, kept in full); github.com and its release assets: the fd / rg downloads of
    // pi's first interactive start (none in print or rpc mode)
    traffic: [T('pi.dev', 'telemetry', '^/api/report-install'), T('github.com', 'files'), T('release-assets.githubusercontent.com', 'files')] },
];
// agents: the proc.agent spellings that name a row — its registry row's read id, then its code id (the last; one when equal); no registry row → none
const agentsOf = (id) => { const r = HARNESS_REGISTRY.find((x) => !x.legacy && readIdOf(x) === id); return r ? [...new Set([readIdOf(r), r.id])] : []; };
export const HARNESSES = Object.freeze(ROWS.map((row) => ({ ...row, agents: agentsOf(row.id) })));

// Legacy-only row: the pre-D37 DeepSeek CLI. Reachable by UA inference only, never by proc.agent.
const LEGACY_DEEPSEEK_CLI = { id: 'deepseek-cli', ua: /deepseek/, legacy: true };
// the ids harnessOf can return that are in no table row: the board's chip table names each (test/web-v2/harness-seam.test.mjs)
export const LEGACY_HARNESS_IDS = Object.freeze([LEGACY_DEEPSEEK_CLI.id]);
const byId = (id) => HARNESSES.find((h) => h.id === id);
const UA_ORDER = [byId('cc'), byId('opencode'), byId('codex'), LEGACY_DEEPSEEK_CLI]; // opencode before codex, as before D37
const BY_AGENT = new Map(HARNESSES.flatMap((h) => h.agents.map((a) => [a, h])));

// The board's pricing key (gate G10): fixed for the harnesses whose upstream was fixed before D37,
// otherwise the wire dialect actually observed, or null. Never inferred from a harness name.
export const LEGACY_PROVIDER = Object.freeze({ cc: 'anthropic', codex: 'openai', 'deepseek-cli': 'deepseek' });
export function wireProviderOfEndpoint(endpoint) {
  const row = endpointOf(endpoint); // the endpoint table (./endpoints.mjs); D3: a bare /messages (a gateway's own route) is no wire
  const wire = (row && row.wire) || '';
  return wire === 'anthropic' ? 'anthropic' : wire.startsWith('openai-') ? 'openai' : null;
}

export function headerOf(rec, name) {
  const h = (rec && (rec.req_headers || rec.request_headers)) || null;
  if (!h || typeof h !== 'object') return null;
  if (h[name] != null) return String(h[name]);
  const want = String(name).toLowerCase();
  for (const k of Object.keys(h)) if (k.toLowerCase() === want && h[k] != null) return String(h[k]);
  return null;
}

// D40: a request that is not an inference call keeps its body too (up to 64 MiB: a Files upload, an update package, a telemetry batch). The
// readers parse a body only to read a session key / hint out of it (identity, lane, lineage), and that is for an INFERENCE call only: before D40
// a non-inference body was `{raw_chars}` and gave no key, so reading one now would change which session — or none — a record belongs to across
// the D40 boundary (a Hermes `session_id` in a telemetry body would key it), and the header-only sharder would disagree with the ETL (3.4:21).
// A non-inference record is identified by its headers alone, as it always was. One rule for every reader (this function, the ETL, the envelope
// adapter).
const parseableBody = (rec, text) => !!rec && typeof text === 'string' && rec.is_llm_call === true;

export function bodyOf(rec) {
  if (!rec || typeof rec !== 'object') return null;
  if (rec.request && typeof rec.request === 'object') return rec.request; // demo v0 shape
  const b = rec.req_body;
  if (b && typeof b === 'object') return b.verbatim === false ? null : b; // {raw_chars, verbatim:false} has no body
  if (typeof b !== 'string' || !b || !parseableBody(rec, b)) return null;
  const v = storedRequestBody(rec); // the record's one parse (src/dissect/request-body.mjs)
  return v && typeof v === 'object' ? v : null;
}
const at = (obj, path) => path.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
function valueOf(rec, key) {
  const v = key.from === 'header' ? headerOf(rec, key.name) : at(bodyOf(rec), key.path);
  if (typeof v === 'number') return String(v);
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export function harnessOf(rec) {
  if (rec && rec.proc && typeof rec.proc === 'object') {
    const agent = typeof rec.proc.agent === 'string' && rec.proc.agent ? rec.proc.agent : null;
    const row = (agent && BY_AGENT.get(agent)) || null;
    return { id: row ? row.id : null, row, inferred: false, agent };
  }
  const ua = String(headerOf(rec, 'user-agent') || headerOf(rec, 'originator') || '').toLowerCase();
  if (ua) for (const row of UA_ORDER) if (row.ua.test(ua)) return { id: row.id, row: row.legacy ? null : row, inferred: true, agent: null };
  return { id: null, row: null, inferred: false, agent: null };
}

// headersOnly: only the row's header keys are candidates — the sharder's rule (3.4:21, D35: it never reads a
// body key). The legacy keys are all headers already.
export function sessionKeyOf(rec, { headersOnly = false } = {}) {
  const NONE = { key: null, confidence: null, source: null, name: null, aliases: [] };
  if (!rec) return NONE;
  const { row } = harnessOf(rec);
  let hit = null;
  const aliases = [];
  for (const k of row ? row.sessionKeys : []) {
    if (headersOnly && k.from !== 'header') continue;
    const v = valueOf(rec, k);
    if (v == null) continue;
    if (!hit) hit = { key: v, confidence: k.confidence, source: k.from, name: k.name };
    else if (k.from === 'header' && v !== hit.key && !aliases.includes(v)) aliases.push(v);
  }
  if (!hit && !(rec.proc && row)) { // a proc-identified harness uses only its own keys
    for (const k of LEGACY_SESSION_KEYS) {
      const v = valueOf(rec, k);
      if (v != null) { hit = { key: v, confidence: k.confidence, source: 'legacy-header', name: k.name }; break; }
    }
  }
  return hit ? { ...hit, aliases } : NONE;
}

export function hintsOf(rec) {
  const out = { lane: null, laneKey: null, compaction: null, compactionMarker: false, parent: null, requestKind: null };
  const { row } = harnessOf(rec);
  if (!row) return out;
  if (row.requestKind) {
    const rk = row.requestKind;
    let kind = null;
    try { const j = JSON.parse(headerOf(rec, rk.header)); kind = j && typeof j[rk.jsonKey] === 'string' ? j[rk.jsonKey] : null; } catch { kind = null; }
    out.requestKind = kind;
    if (kind && rk.lanes[kind]) out.lane = rk.lanes[kind];
    if (kind && rk.compaction.includes(kind)) out.compaction = true;
  }
  for (const l of out.lane ? [] : row.lane) {
    const v = l.header ? headerOf(rec, l.header) : at(bodyOf(rec), l.body);
    if (v == null || String(v).trim() === '' || (l.equals != null && String(v).trim() !== l.equals)) continue;
    out.lane = l.lane;
    if (l.key) out.laneKey = String(v).trim(); // the value names one agent: one stream per value (3.4)
    break;
  }
  for (const c of row.compaction) {
    if (c.header) {
      const v = headerOf(rec, c.header);
      if (v != null && (c.equals == null || v.trim() === c.equals)) out.compaction = true;
    } else if (c.marker && typeof rec.req_body === 'string' && c.marker.test(rec.req_body)) out.compactionMarker = true;
  }
  for (const p of row.parentKeys) {
    const v = valueOf(rec, p);
    if (v != null) { out.parent = { id: v, confidence: p.confidence }; break; }
  }
  return out;
}

// D37 ⑤ / 4.6 R5: only calls captured through injected trust carry an effect; legacy MITM / reverse-proxy
// captures (the control group) never do.
// the words of a message: its text blocks, none for a tool_result-only turn
const textOf = (m) => (Array.isArray(m?.content) ? m.content.map((b) => (b?.type === 'text' ? b.text || '' : '')).join('') : typeof m?.content === 'string' ? m.content : '');

const systemOf = (b) => (Array.isArray(b.system) ? b.system.map((s) => s?.text || '').join('\n') : String(b.system || ''));

/** auxKindOf(rec) → the kind of a background call by its harness's `aux` table (2.1); a record with no row reads Claude Code's. */
export function auxKindOf(rec) {
  const b = bodyOf(rec) || {}, users = (Array.isArray(b.messages) ? b.messages : []).filter((m) => m?.role === 'user');
  const cap = typeof b.max_tokens === 'number' ? b.max_tokens : Infinity, first = textOf(users[0]), last = textOf(users.findLast(textOf));
  const system = systemOf(b);
  const hit = (harnessOf(rec).row || byId('cc')).aux.find((e) => cap <= e.maxTokens || e.first?.test(first) || e.last?.test(last) || e.system?.test(system));
  return hit ? hit.kind : 'aux';
}

const HOME_OF = /^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)[/\\]/;
const statedCwd = (rec) => {
  const re = harnessOf(rec).row?.cwd, b = re ? bodyOf(rec) : null;
  if (!b) return null;
  for (const text of [systemOf(b), ...(Array.isArray(b.messages) ? b.messages.slice(0, 2).map(textOf) : [])]) {
    const m = re.exec(text);
    if (m) return m[1].trim();
  }
  return null;
};
/** pathContext(rec) → what a shell read's path resolves against (2.4 §保真边界 item 6): `home` from the process's own path, null when it
 *  does not live under one; `cwd` the working directory the call states, null when it states none, read only when asked (it scans text). */
export function pathContext(rec) {
  const home = HOME_OF.exec(String(rec?.proc?.exe ?? ''))?.[1] ?? null;
  let cwd;
  return { home, get cwd() { return cwd === undefined ? (cwd = statedCwd(rec)) : cwd; } };
}

export function observerEffectsOf(rec) {
  const { row } = harnessOf(rec);
  if (!row || !rec) return null;
  const effects = row.observerEffects.filter((e) => e.captures.includes(rec.capture));
  return effects.length ? effects.map(({ id, what, cause }) => ({ id, what, cause })) : null;
}
