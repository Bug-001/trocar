import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyMeta, foldRecord, mergeMeta } from '../../src/etl/session-meta.mjs';
import { projectsView, projectsViewFromMetas } from '../../src/view/board.mjs';

// THE ARCHIVE-LAYER META MUST AGREE WITH THE LIVE COMPUTATION, RECORD FOR RECORD.
//
// The board's session list is normally `projectsView(records)` — but that loads every record and
// OOMs on a multi-GB capture. The archive layer precomputes a per-session meta by FOLDING records
// one at a time, so the board can list sessions without loading them. If the fold ever computes a
// field differently from `sessionMetaFor` (probe classification, harness UA table, subagent
// detection, last_ts), the list silently disagrees with the session you open. This cross-checks the
// two paths produce the SAME projects view, which is the only guarantee that matters.

const rec = ({ sid, tag, ts, ua = 'claude-cli/2.1 (external, cli)', endpoint = '/v1/messages', llm = true, agent = null, app = 'cli' }) => ({
  id: tag, endpoint, method: 'POST', is_llm_call: llm, ts_request: ts,
  req_headers: {
    'x-claude-code-session-id': sid, 'user-agent': ua, 'x-app': app,
    ...(agent ? { 'x-claude-code-agent-id': agent } : {}),
  },
  req_body: JSON.stringify({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: tag }] }),
  resp: { status: 200, body: {} },
});

// A realistic mix: two sessions, a probe, a subagent turn, a Codex record.
const RECORDS = [
  rec({ sid: 'S1', tag: 'a', ts: '2026-07-20T00:00:01Z' }),
  rec({ sid: 'S1', tag: 'p', ts: '2026-07-20T00:00:02Z', endpoint: '/v1/messages/count_tokens', llm: false }),
  rec({ sid: 'S1', tag: 'b', ts: '2026-07-20T00:00:05Z', agent: 'sub-1' }),
  rec({ sid: 'S2', tag: 'c', ts: '2026-07-20T00:01:00Z', ua: 'codex/1.0', endpoint: '/v1/responses', app: '' }),
];

function foldAll(records) {
  const by = new Map();
  for (const r of records) {
    const sid = r.req_headers['x-claude-code-session-id'];
    if (!sid) continue;
    if (!by.has(sid)) by.set(sid, emptyMeta(sid));
    foldRecord(by.get(sid), r);
  }
  return [...by.values()];
}

test('projectsViewFromMetas(fold(records)) === projectsView(records)', () => {
  const live = projectsView(RECORDS);
  const archived = projectsViewFromMetas(foldAll(RECORDS));
  assert.deepEqual(archived, live,
    'the folded archive meta disagrees with the live session-list computation — the board would list '
    + 'a session differently from how it opens');
});

test('the cross-check survives enrich (project/title) on both paths', () => {
  const enrich = (id) => ({ slug: `-proj-${id}`, cwd: `/Users/u/proj-${id}`, title: `session ${id}` });
  assert.deepEqual(
    projectsViewFromMetas(foldAll(RECORDS), { enrich }),
    projectsView(RECORDS, { enrich }),
    'enrich (project slug / path / title) is applied differently between the two paths');
});

test('fold counts calls vs probes the way the board classifies them', () => {
  const m = foldAll(RECORDS).find((x) => x.session_id === 'S1');
  assert.equal(m.calls, 2, 'S1 has two /v1/messages calls (the count_tokens probe is not a call)');
  assert.equal(m.probes, 1, 'the count_tokens record must be a probe, not a call');
  assert.equal(m.other, 0, 'S1 has no non-inference session traffic');
  assert.equal(m.has_subagent, true, 'the x-claude-code-agent-id turn must mark the session has a subagent');
  assert.equal(m.last_ts, '2026-07-20T00:00:05Z', 'last_ts must be the max, not the last-seen');
});

test('fold counts the third class — session-tagged non-inference — as `other` (classOf parity)', () => {
  // A record that is neither a real /v1/messages call nor a count_tokens probe is the sharder's
  // `other` stream. calls + probes + other MUST equal the session's record count, so the three
  // counters partition the session exactly the way classOf routes the bytes.
  const recs = [
    rec({ sid: 'S', tag: 'a', ts: '2026-07-20T00:00:01Z' }),
    rec({ sid: 'S', tag: 'p', ts: '2026-07-20T00:00:02Z', endpoint: '/v1/messages/count_tokens', llm: false }),
    rec({ sid: 'S', tag: 'o', ts: '2026-07-20T00:00:03Z', endpoint: '/api/roles', llm: false }),
  ];
  const m = foldAll(recs).find((x) => x.session_id === 'S');
  assert.equal(m.calls, 1);
  assert.equal(m.probes, 1);
  assert.equal(m.other, 1, 'the /api/roles record is neither call nor probe → other');
  assert.equal(m.calls + m.probes + m.other, recs.length, 'the three classes must partition the session');
});

test('mergeMeta accumulates incremental runs (counts add, last_ts maxes, flags OR)', () => {
  const run1 = foldRecord(emptyMeta('S'), rec({ sid: 'S', tag: 'a', ts: '2026-07-20T00:00:01Z' }));
  const run2 = foldRecord(emptyMeta('S'), rec({ sid: 'S', tag: 'b', ts: '2026-07-20T00:00:09Z', agent: 'x' }));
  const m = mergeMeta(run1, run2);
  assert.equal(m.calls, 2, 'incremental runs must add call counts, not replace');
  assert.equal(m.last_ts, '2026-07-20T00:00:09Z', 'merged last_ts must be the later run');
  assert.equal(m.has_subagent, true, 'a subagent seen in either run must survive the merge');
});
