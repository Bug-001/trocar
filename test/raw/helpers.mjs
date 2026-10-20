// test/raw/helpers.mjs — synthetic shards for the D35 sealer tests (no real capture is ever read).
import fs from 'node:fs';
import path from 'node:path';
import { openSealed } from '../../src/raw/reader.mjs';
import { tmpDir as removedAtExit } from '../helpers/tmp.mjs';

// Gone when the test process ends, pass or fail (test/helpers/tmp.mjs). Every raw test and the HOME sandbox below use it.
export const tmpDir = (p = 'trocar-seal-') => removedAtExit(p);

// Backstop: anything that falls back to a default under ~/.trocar (the raw journal) lands in a sandbox,
// never in the real home (tests never touch ~/.trocar). Each test file runs in its own process.
process.env.HOME = tmpDir('trocar-home-');

let clock = Date.parse('2026-10-05T10:00:00.000Z');
export function envelope({ sid = null, sidHeader = 'x-claude-code-session-id', id, body, resp = { kind: 'sse', status: 200 }, endpoint = '/v1/messages', llm = true }) {
  const ts = new Date(clock += 1000).toISOString();
  const h = { 'user-agent': 'claude-cli/2.0', 'anthropic-version': '2023-06-01' };
  if (sid) h[sidHeader] = sid;
  return { ts, endpoint, method: 'POST', req_headers: h, req_body: body, resp, id, ts_request: ts, is_llm_call: llm, capture: 'mitm' };
}

// A conversation that grows like a real one: every call re-sends the history plus one turn.
export function conversation(sid, n, { idPrefix = 'req_', sidHeader, start = 0 } = {}) {
  const out = []; const msgs = [];
  for (let i = 0; i < n; i++) {
    msgs.push({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i} of ${sid}: ` + 'lorem ipsum dolor sit amet '.repeat(20 + i) });
    const body = JSON.stringify({ model: 'claude-opus-4-6', system: [{ type: 'text', text: `cch=${i}` }, { type: 'text', text: 'You are Claude Code.' }], messages: msgs });
    out.push(envelope({ sid, sidHeader, id: `${idPrefix}${String(start + i).padStart(5, '0')}`, body, resp: { kind: 'sse', status: 200, text: `answer ${i}`, usage: { input_tokens: 10 + i, output_tokens: 3 } } }));
  }
  return out;
}

export const toLine = (rec, eol = '\n') => Buffer.from(JSON.stringify(rec) + eol);

// The E1 fixture: two sessions, session-less traffic, a duplicated id, a line that is not JSON, a
// blank line, a CRLF line, a numeric id, and a torn final line with no newline.
export function e1Lines() {
  const s1 = conversation('11111111-aaaa-4aaa-8aaa-111111111111', 6);
  const s2 = conversation('22222222-bbbb-4bbb-8bbb-222222222222', 4, { sidHeader: 'session-id', idPrefix: 'resp_' });
  const ls = [];
  ls.push(toLine(s1[0]), toLine(s2[0]), toLine(envelope({ id: 'tel_1', body: { raw_chars: 120, verbatim: false }, endpoint: '/api/event_logging/batch', llm: false })));
  ls.push(toLine(s1[1]), toLine({ ...s1[2], id: 'req_dup' }), toLine({ ...s1[3], id: 'req_dup' }));
  ls.push(Buffer.from('{"ts":"2026-10-05T10:00:00Z","broken json\n'), Buffer.from('\n'));
  ls.push(toLine(s2[1], '\r\n'), toLine({ ...s2[2], id: 4242 }), toLine(s1[4]), toLine(s2[3]), toLine(s1[5]));
  ls.push(Buffer.from('{"ts":"2026-10-05T10:09:00Z","req_headers":{"x-claude-code-session-id":"1111'));  // torn, no "\n"
  return ls;
}

export function writeShard(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat(lines), { mode: 0o600 });
  return file;
}

export function listFiles(root, re = /\.sealed$/) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (re.test(e.name)) out.push(p); } };
  walk(root);
  return out.sort();
}

// Every record of the given sealed files, keyed by source line number (asserts no line twice).
export function decodeAll(files) {
  const byLine = new Map();
  for (const f of files) {
    const sf = openSealed(f);
    for (const { line, entry } of sf.lines()) {
      if (byLine.has(entry.lineNo)) throw new Error(`line ${entry.lineNo} sealed twice`);
      byLine.set(entry.lineNo, { line, entry, file: f });
    }
    sf.close();
  }
  return byLine;
}
