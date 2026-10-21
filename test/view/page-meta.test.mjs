import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionView, pageView, groupSessions, PAGED_META, SESSION_WIDE_EVENTS } from '../../src/view/board.mjs';
import { threadSession } from '../helpers/cc-threads.mjs';

// 3.5 §分页: a paged-out call ships the closed meta set PAGED_META and nothing else; lane events off the page ship as
// {type, step, streamId} unless their kind is read session-wide; the middle call's cache comparison call (2.3) always rides
// with its body. Pages are built over generated sessions along axes: two wire shapes (stateless Messages, Message Threads with
// interleaved lanes), failed calls, calls carrying labels with long texts (proxy-mode routing, a reply cut at the cap).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO = readFileSync(path.join(HERE, '..', '..', 'samples', 'demo-session.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

const AXES = {
  plain: (r) => r,
  proxy: (r) => ({ ...r, capture: 'proxy' }),
  cut: (r) => ({ ...r, resp: { ...r.resp, truncated: true, body_bytes: 10 } }),
  failed: (r, i) => (i % 3 === 1 ? { ...r, resp: { ...r.resp, status: 500 } } : r),
};
function sessions() {
  const out = [];
  for (const [axis, f] of Object.entries(AXES)) {
    out.push({ name: `demo/${axis}`, records: DEMO.map((r, i) => f(structuredClone(r), i)) });
    const t = threadSession();
    out.push({ name: `threads/${axis}`, records: [t.M0, t.S0, t.M1, t.S1, t.A, t.M2].map((r, i) => f(structuredClone(r), i)) });
  }
  return out.map((s) => ({ ...s, sid: [...groupSessions(s.records).entries()].sort((a, b) => b[1].length - a[1].length)[0][0] }));
}
const windows = (n) => {
  const w = [];
  for (let cursor = 0; cursor < n; cursor++) for (const limit of [1, 2, 3]) w.push({ cursor, limit });
  return w;
};
const byGi = (v) => new Map(v.analyzed.steps.map((c) => [c.gi, c]));
const subset = (keys, set, what) => { for (const k of keys) assert.ok(set.includes(k), `${what}: ${k} is outside the closed set`); };

test('a paged-out call carries only the closed meta set, and every member the full call had', () => {
  let seen = 0;
  for (const { name, records, sid } of sessions()) {
    const full = byGi(sessionView(records, sid));
    for (const spec of windows(full.size)) {
      const page = sessionView(records, sid, { page: spec });
      for (const c of page.analyzed.steps.filter((x) => x.paged_out)) {
        seen++;
        const at = `${name} ${JSON.stringify(spec)} gi ${c.gi}`;
        subset(Object.keys(c), PAGED_META.call, at);
        for (const k of ['respRefs', 'extraMessages', 'norm']) assert.equal(c[k], undefined, `${at}: ${k} rides only with the body`);
        if (c.wire) subset(Object.keys(c.wire), PAGED_META.wire, `${at} wire`);
        if (c.cacheBreak) subset(Object.keys(c.cacheBreak), PAGED_META.cacheBreak, `${at} cacheBreak`);
        for (const l of (c.wire && c.wire.labels) || []) { subset(Object.keys(l), PAGED_META.label, `${at} label`); assert.equal(l.text, undefined); }
        // (b) nothing the board reads from it is lost: each member of the set the full call had is still there, with its value
        const f = full.get(c.gi);
        for (const k of PAGED_META.call) {
          if (f[k] === undefined || ['flat', 'nonBlockKeys', 'paged_out', 'rec', 'wire', 'cacheBreak', 'usage'].includes(k)) continue;
          assert.deepEqual(c[k], f[k], `${at}: ${k}`);
        }
        if (f.wire) for (const k of PAGED_META.wire) if (k !== 'labels' && f.wire[k] !== undefined) assert.deepEqual(c.wire[k], f.wire[k], `${at} wire.${k}`);
        if (f.wire && f.wire.labels) assert.deepEqual(c.wire.labels.map((l) => [l.id, l.label]), f.wire.labels.map((l) => [l.id, l.label]), `${at} labels`);
        if (f.cacheBreak) for (const k of PAGED_META.cacheBreak) if (f.cacheBreak[k] !== undefined) assert.deepEqual(c.cacheBreak[k], f.cacheBreak[k], `${at} cacheBreak.${k}`);
        if (f.rec) assert.deepEqual(c.rec, { id: f.rec.id, request: { model: f.rec.request && f.rec.request.model } }, `${at} rec`);
        // the raw usage the full call had, read the way the board reads it: an empty one is usage:null, otherwise usage as is
        const empty = f.norm && 'usage' in f.norm && (f.norm.usage == null || !Object.keys(f.norm.usage).length);
        assert.deepEqual(c.usage, empty ? null : f.usage, `${at} usage`);
      }
    }
  }
  assert.ok(seen > 0, 'the windows must page some calls out');
});

test('lane events off the page ship as {type, step, streamId}; on the page, or of a session-wide kind, whole', () => {
  let slim = 0;
  for (const { name, records, sid } of sessions()) {
    const full = sessionView(records, sid);
    for (const spec of windows(full.analyzed.steps.length)) {
      const page = sessionView(records, sid, { page: spec });
      const lo = spec.cursor - 1, hi = spec.cursor + spec.limit;
      page.analyzed.lanes.forEach((l, li) => (l.events || []).forEach((e, k) => {
        const f = full.analyzed.lanes[li].events[k];
        const at = `${name} ${JSON.stringify(spec)} lane ${li} event ${k}`;
        if (SESSION_WIDE_EVENTS.has(f.type) || (f.step != null && f.step >= lo && f.step < hi)) assert.deepEqual(e, f, at);
        else {
          const want = {};
          for (const key of ['type', 'step', 'streamId']) if (f[key] !== undefined) want[key] = f[key];
          assert.deepEqual(e, want, at);
          slim++;
        }
      }));
    }
  }
  assert.ok(slim > 0, 'the windows must leave some events off the page');
});

// (d) Two lanes interleaved: the anchor lane's previous call lies more than limit/2 before the window's middle, and the budget is
// smaller than either body — the middle call and its comparison call still both ride, and page.returned counts both.
test('the middle call\'s cache comparison call rides with its body, outside the window and over the budget', () => {
  const comp = { user: 100 };
  const call = (gi, extra = {}) => ({ gi, comp, ctx: 1, flat: [{ key: `b${gi}` }], ...extra });
  for (const named of [false, true]) {
    for (const failedBetween of [false, true]) {
      // main: 0 1 2 [15 failed?] 16 · sub: every other gi of 3..19 — the window [12, 20) has its middle at 16 (main)
      const main = [call(0), call(1), call(2)];
      if (failedBetween) main.push(call(15, { status: 500 }));
      const mid = call(16, named ? { cacheBreak: { cause: 'append', refGi: 1 } } : {});
      main.push(mid);
      const sub = [];
      for (let gi = 3; gi < 20; gi++) if (!main.some((c) => c.gi === gi)) sub.push(call(gi));
      const steps = [...main, ...sub].sort((a, b) => a.gi - b.gi);
      const view = { analyzed: { steps, lanes: [{ kind: 'main', calls: main, events: [] }, { kind: 'subagent', calls: sub, events: [] }] } };
      const page = pageView(view, { cursor: 12, limit: 8 }, { budget: 1 });
      const want = named ? 1 : 2;
      const at = `named ${named} failedBetween ${failedBetween}`;
      const shipped = new Map(page.analyzed.steps.map((c) => [c.gi, c]));
      assert.ok(!shipped.get(16).paged_out, `${at}: the middle call rides`);
      assert.ok(!shipped.get(want).paged_out, `${at}: its comparison call (gi ${want}) rides`);
      assert.equal(page.page.returned, 2, `${at}: returned counts the middle call and its comparison call`);
    }
  }
});
