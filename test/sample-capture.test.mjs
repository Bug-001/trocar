import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectsView, sessionView } from '../src/view/board.mjs';

// The shipped demo capture is the FIRST THING a new user sees (`npm run demo`), and the only way a
// GitHub visitor can evaluate the tool without first MITM-ing their own agent — asight's real test
// fixture is a personal session and is gitignored, so before this sample existed `git clone` rendered
// an empty board. That makes the sample load-bearing: if it stops rendering, the project's shop
// window goes dark and nothing else in the suite would notice.
//
// It is also the one committed capture that is SAFE to assert against in detail, being entirely
// synthetic (no real prompts, file contents or credentials).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(HERE, '..', 'samples', 'demo-session.ndjson');
const records = readFileSync(SAMPLE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('the shipped sample loads and lands in exactly one session', () => {
  const { projects } = projectsView(records);
  const sessions = projects.flatMap((p) => p.sessions);
  assert.equal(sessions.length, 1, 'the demo should present one clean session, not a confusing set');
  assert.equal(sessions[0].harness, 'cc');
  assert.ok(sessions[0].calls >= 6, 'enough calls to make scrubbing meaningful');
});

test('every panel the demo is supposed to show has real data behind it', () => {
  const id = projectsView(records).projects[0].sessions[0].session_id;
  const v = sessionView(records, id);
  const steps = v.analyzed.steps;

  assert.ok(steps.length >= 6, 'timeline has bars');
  assert.equal(v.truncated, null, 'the demo must never be truncated — it exists to show the full view');

  const last = steps[steps.length - 1];
  assert.ok(last.flat.length > 10, 'context window has blocks');
  assert.ok(last.flat.some((b) => b.sec === 'tools'), 'tool schemas render (the verbatim-schema story)');
  assert.ok(last.flat.some((b) => b.sec === 'system'), 'system prompt renders');
  assert.ok(last.flat.some((b) => b.sec === 'messages'), 'conversation renders');
  assert.ok(last.usage.read > 0, 'cache overlay has a real cache_read to draw');
});

test('the sample exercises the error path (a red bar exists to be seen)', () => {
  const id = projectsView(records).projects[0].sessions[0].session_id;
  const { analyzed } = sessionView(records, id);
  const statuses = new Set(analyzed.steps.map((s) => s.status));
  assert.ok(statuses.has(429),
    'the demo should show a failed call — error rendering was unreachable for months precisely '
    + 'because no fixture contained one');
});

test('a failed call does not corrupt the cache-break chain in the shipped demo', () => {
  const id = projectsView(records).projects[0].sessions[0].session_id;
  const { analyzed } = sessionView(records, id);
  const bad = analyzed.steps.filter((s) => s.cacheBreak.attribution !== 'harmless');
  assert.equal(bad.length, 0,
    `the demo session is a clean append-only conversation; any non-harmless break means the chain ran `
    + `through the 429. Got: ${bad.map((s) => s.id + ':' + s.cacheBreak.cause).join(', ')}`);
});

test('the sample contains no real credentials', () => {
  const raw = readFileSync(SAMPLE, 'utf8');
  for (const h of ['authorization', 'x-api-key', 'cookie']) {
    const re = new RegExp(`"${h}"\\s*:\\s*"(?!<redacted>)[^"]+"`, 'i');
    assert.doesNotMatch(raw, re, `${h} must be redacted in a committed sample`);
  }
  assert.doesNotMatch(raw, /sk-ant-|sk-[A-Za-z0-9]{20}/, 'no API-key-shaped strings may ship');
});

// The documented one-liner must ACTUALLY WORK. `npm run demo` was defined as
// `node src/server.mjs --source samples/demo-session.ndjson`, but src/server.mjs only ever read the
// ASIGHT_SOURCE env var and silently ignored --source — so the command a new user is told to run
// served an empty board. It was verified during development with the env var, which is exactly the
// class of mistake that produces a README that traps people: the maintainer never types what the
// docs say. This drives the REAL published script.
test('`npm run demo` — the documented command — actually serves the sample', async () => {
  const { spawn } = await import('node:child_process');
  const pkg = JSON.parse(readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
  const cmd = pkg.scripts.demo;
  assert.ok(cmd, 'package.json must define a demo script');

  const port = 9861;
  const child = spawn('sh', ['-c', cmd], {
    cwd: path.join(HERE, '..'),
    env: { ...process.env, ASIGHT_PORT: String(port), ASIGHT_SOURCE: '' },
    stdio: 'ignore',
  });
  try {
    let body = null;
    for (let i = 0; i < 40 && body == null; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/projects`);
        if (res.ok) body = await res.json();
      } catch { /* not up yet */ }
    }
    assert.ok(body, 'the demo server never came up');
    const sessions = (body.projects || []).flatMap((p) => p.sessions || []);
    assert.ok(sessions.length > 0,
      'the demo command served ZERO sessions — the sample is not reaching the board, so a new '
      + 'user following the README sees an empty page');
    assert.ok(sessions[0].calls >= 6, 'the demo session should carry its calls');
  } finally { child.kill('SIGKILL'); }
});
