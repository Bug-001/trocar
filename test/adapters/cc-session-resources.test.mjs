import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ccAdapter, parseSession, parseResources } from '../../src/adapters/cc.mjs';
import { createRegistry } from '../../src/adapters/contract.mjs';
import { ccLlmRecord, nonCcRecord } from '../fixtures/cc-record.mjs';

test('parseSession: native_id from header (high), lane main, entrypoint + cwd, no parent/fork', () => {
  const s = parseSession(ccLlmRecord());
  assert.equal(s.native_id, 'sess-abc');
  assert.equal(s.native_id_confidence, 'high');
  assert.equal(s.lane, 'main');
  assert.equal(s.entrypoint, 'cli');
  assert.equal(s.cwd, '/repo');
  assert.equal(s.parent, null); // main lane; parent 认亲 resolved by ETL, not per-record
  assert.equal(s.fork_of, null); // CC has no online fork signal (3.4)
});

test('parseSession lane: subagent marker → subagent (delegates to 3.4 identity)', () => {
  const sub = ccLlmRecord({ req: { system: [{ type: 'text', text: 'cc_is_subagent=true' }] } });
  assert.equal(parseSession(sub).lane, 'subagent');
});

test('parseResources: a Read enters as kind=file (event=enter); a path only mentioned in a result is event=seen (names-only)', () => {
  const rec = ccLlmRecord({
    req: {
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/opened.mjs' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'see also src/other.ts here' }] },
      ],
    },
  });
  const evs = parseResources(rec);
  const opened = evs.find((e) => e.kind === 'file' && e.label === '/repo/opened.mjs');
  assert.ok(opened && opened.event === 'enter');
  const seen = evs.find((e) => e.event === 'seen' && e.label === 'src/other.ts');
  assert.ok(seen, 'only-seen path is emitted names-only');
  assert.equal(seen.via, 'mention');
});

test('parseResources: an mcp__ tool surfaces as kind=mcp', () => {
  const rec = ccLlmRecord({ req: { tools: [{ name: 'mcp__github__list_repos' }], messages: [] } });
  const evs = parseResources(rec);
  const mcp = evs.find((e) => e.kind === 'mcp');
  assert.ok(mcp, 'mcp tool becomes a resource_event');
  assert.equal(mcp.event, 'enter');
});

test('ccAdapter registers and claims CC records; a non-CC record quarantines (never dropped)', () => {
  const reg = createRegistry().register(ccAdapter);
  assert.equal(reg.dispatch(ccLlmRecord()).adapter.name, 'cc-anthropic');
  assert.equal(reg.dispatch(nonCcRecord()).status, 'quarantine');
  assert.equal(reg.stats().quarantined, 1);
});
