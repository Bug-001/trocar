#!/usr/bin/env node
// bench/raw-gen.mjs — a SYNTHETIC Claude-Code-shaped capture shard for the D35 benchmarks (4.6 E3/E4).
// usage: node bench/raw-gen.mjs <out.ndjson> [targetGB=2.5] [seed=1]
//
// Nothing here comes from a real capture. It imitates the shape that makes raw logs grow
// quadratically (4.6 §日志体积预算 「根因」): every call re-sends the whole conversation plus one turn,
// a ~30 KB tool list, a system block whose first ~170 bytes change every call (cch=…), cache_control
// markers that move to the newest messages, a `diagnostics` field that changes, interleaved sessions
// (main + subagent-like), and compactions that restart a conversation. Turn text is pseudo-random
// words, so the compression ratio is a property of this generator — E7 on real data is the yardstick.
import fs from 'node:fs';

const [out, gbArg = '2.5', seedArg = '1'] = process.argv.slice(2);
if (!out) { console.error('usage: node bench/raw-gen.mjs <out.ndjson> [targetGB] [seed]'); process.exit(1); }
const target = Number(gbArg) * 2 ** 30;
let s = Number(seedArg) >>> 0;
const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const VOCAB = Array.from({ length: 6000 }, () => { let w = ''; const n = 2 + Math.floor(rnd() * 9); for (let i = 0; i < n; i++) w += 'abcdefghijklmnopqrstuvwxyz'[Math.floor(rnd() * 26)]; return w; });
const words = (n) => { let t = ''; for (let i = 0; i < n; i++) t += VOCAB[Math.floor(rnd() * VOCAB.length)] + (rnd() < 0.08 ? '.\n' : ' '); return t; };
const TOOLS = Array.from({ length: 40 }, (_, i) => ({ name: `Tool${i}`, description: words(90), input_schema: { type: 'object', properties: { a: { type: 'string', description: words(12) } } } }));
const SYSTEM_TAIL = { type: 'text', text: 'You are Claude Code. ' + words(1500) };

function session(id, sub) { return { id, sub, msgs: [], turn: 0, limit: 60 + Math.floor(rnd() * 120) }; }
const sessions = [session('11111111-0000-4000-8000-000000000001', false), session('11111111-0000-4000-8000-000000000002', true), session('11111111-0000-4000-8000-000000000003', true)];
const fd = fs.openSync(out, 'w', 0o600);
let bytes = 0, n = 0, clock = Date.parse('2026-10-05T08:00:00Z');
while (bytes < target) {
  const ss = sessions[rnd() < 0.6 ? 0 : 1 + Math.floor(rnd() * 2)];
  if (ss.turn >= ss.limit) { ss.msgs = [{ role: 'user', content: [{ type: 'text', text: 'Summary of the earlier conversation: ' + words(800) }] }]; ss.turn = 0; ss.limit = 60 + Math.floor(rnd() * 120); }
  ss.msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_${n}`, content: words(80 + Math.floor(rnd() * 900)) }] });
  const msgs = ss.msgs.map((m, i) => (i >= ss.msgs.length - 2 ? { ...m, content: m.content.map((c) => ({ ...c, cache_control: { type: 'ephemeral' } })) } : m));
  const body = JSON.stringify({ model: 'claude-opus-4-6', max_tokens: 32000, messages: msgs,
    system: [{ type: 'text', text: `x-anthropic-billing-header: cc_version=2.0.${n % 97}; cch=${(n * 2654435761 >>> 0).toString(16)}; ${words(18)}` }, SYSTEM_TAIL],
    tools: ss.sub ? TOOLS.slice(0, 12) : TOOLS, diagnostics: { turn: ss.turn, files: words(6) }, stream: true });
  const ts = new Date(clock += 2000 + Math.floor(rnd() * 20000)).toISOString();
  const answer = words(150 + Math.floor(rnd() * 800));
  const rec = { ts, endpoint: '/v1/messages', method: 'POST',
    req_headers: { 'x-claude-code-session-id': ss.id, 'user-agent': 'claude-cli/2.0.0', 'anthropic-beta': 'interleaved-thinking-2025-05-14', ...(ss.sub ? { 'x-claude-code-agent-id': 'agent-1' } : {}) },
    req_body: body, resp: { kind: 'sse', status: 200, text: answer, usage: { input_tokens: 3, cache_read_input_tokens: body.length >> 2, output_tokens: 400 } },
    id: `req_bench-${String(n).padStart(6, '0')}`, ts_request: ts, ts_response_end: ts, duration_ms: 4000, is_llm_call: true, capture: 'synthetic-bench' };
  ss.msgs.push({ role: 'assistant', content: [{ type: 'text', text: answer }] });
  ss.turn++;
  const line = JSON.stringify(rec) + '\n';
  fs.writeSync(fd, line); bytes += Buffer.byteLength(line); n++;
  if (n % 1000 === 0) process.stderr.write(`\r${n} records, ${(bytes / 2 ** 30).toFixed(2)} GiB`);
}
fs.closeSync(fd);
console.log(JSON.stringify({ out, records: n, bytes, gib: +(bytes / 2 ** 30).toFixed(3) }));
