// RFC 3.4 #8 (§工作目录(项目), D83): a session's project is the absolute working directory its own request states, read by
// the harness's `cwd` rules from an inference body; anything else, and every harness without rules, states none.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HARNESSES } from '../../src/dissect/harnesses.mjs';
import { projectOf } from '../../src/dissect/project.mjs';

const agentOf = (id) => HARNESSES.find((h) => h.id === id).agents[0];
const rec = (id, body, over = {}) => ({
  id: 'req_1', ts: '2026-10-06T00:00:00.000Z', endpoint: 'https://api.example.test/v1/messages', method: 'POST',
  req_headers: { host: 'api.example.test' }, req_body: typeof body === 'string' ? body : JSON.stringify(body),
  is_llm_call: true, capture: 'transparent', proc: { pid: 1, exe: '/x/a', agent: agentOf(id) }, ...over,
});

const envUser = (p) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text: `<environment_context>\n  <cwd>${p}</cwd>\n  <shell>zsh</shell>\n</environment_context>` }] });
const BUILD = {
  cc: (p) => ({ system: [{ type: 'text', text: 'You are Claude Code.' }, { type: 'text', text: 'Be brief.' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: `# Environment\nYou have been invoked in the following environment: \n - Primary working directory: ${p}\n - Is a git repository: true\nEnd.` }, { type: 'text', text: 'q0' }] }] }),
  codex: (p) => ({ instructions: 'You are Codex.', input: [envUser(p), { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q0' }] }] }),
  opencode: (p) => ({ messages: [{ role: 'system', content: `You are opencode.\n<env>\n  Working directory: ${p}\n  Is directory a git repo: yes\n</env>` }, { role: 'user', content: 'q0' }] }),
  hermes: (p) => ({ messages: [{ role: 'system', content: `You are Hermes.\nCurrent working directory: ${p}\nEnd.` }, { role: 'user', content: 'q0' }] }),
  zcode: (p) => ({ system: [{ type: 'text', text: `# Environment\n - Primary working directory: ${p}\n` }], messages: [{ role: 'user', content: 'q0' }] }),
  pi: (p) => ({ system: [{ type: 'text', text: `You are pi.\nWhen asked, answer with a line like:\nWorking directory: /w/decoy\nA note quoting <cwd>/w/decoy</cwd> in a line.\n<cwd>\n${p}\n</cwd>\n` }],
    messages: [{ role: 'user', content: 'q0' }] }),
};
const PATHS = ['/w/project', '/w/my project/é', 'C:\\w\\p', '\\\\srv\\share\\p'];

test('3.4 #8 every harness with cwd rules reads the absolute path its request states, verbatim', () => {
  const ruled = HARNESSES.filter((h) => h.cwd.length);
  assert.ok(ruled.length > 0);
  for (const h of ruled) {
    assert.ok(BUILD[h.id], `no body builder for ${h.id}`);
    for (const p of PATHS) assert.equal(projectOf(rec(h.id, BUILD[h.id](p))), p, `${h.id} ${p}`);
  }
  // cc subagent prompt: a bare line, with or without list markers
  for (const line of ['Working directory: /w/project', '  Working directory: /w/project', '* Primary working directory: /w/project']) {
    const sub = BUILD.cc('/w/x');
    sub.system[1].text = `Here is useful information.\n<env>\n${line}\n</env>`;
    assert.equal(projectOf(rec('cc', sub)), '/w/project', line);
  }
});

test('3.4 #8 a path that is not absolute, too long or has a control char, a non-inference call, or a body that is not JSON states none', () => {
  const bad = ['w/project', '~/w', '/' + 'a'.repeat(1024), '/w/p\u0001q'];
  for (const h of HARNESSES.filter((x) => x.cwd.length)) {
    for (const p of bad) assert.equal(projectOf(rec(h.id, BUILD[h.id](p))), null, `${h.id} ${JSON.stringify(p)}`);
    assert.equal(projectOf(rec(h.id, BUILD[h.id]('/w/project'), { is_llm_call: false })), null, `${h.id} D40`);
    assert.equal(projectOf(rec(h.id, '{not json')), null, `${h.id} not JSON`);
  }
});

test('3.4 #8 decoys lose: a tool result, a later environment context, a quoted instruction', () => {
  const cc = BUILD.cc('/w/project');
  cc.messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Working directory: /w/decoy' }] });
  assert.equal(projectOf(rec('cc', cc)), '/w/project');
  const codex = BUILD.codex('/w/project');
  codex.input.push(envUser('/w/decoy'));
  assert.equal(projectOf(rec('codex', codex)), '/w/project');
  assert.equal(projectOf(rec('pi', BUILD.pi('/w/project'))), '/w/project');
  assert.equal(projectOf(rec('pi', { system: [{ type: 'text', text: 'You are pi.\nWorking directory: /w/p\n' }], messages: [] })), null);
});

test('3.4 #8 a harness with no cwd rules states none, whatever its text says', () => {
  const none = HARNESSES.filter((h) => !h.cwd.length && h.agents.length);
  assert.ok(none.length > 0);
  const body = { system: 'Working directory: /w/p', messages: [{ role: 'system', content: 'Working directory: /w/p' }, { role: 'user', content: 'Working directory: /w/p' }] };
  for (const h of none) assert.equal(projectOf(rec(h.id, body)), null, h.id);
});
