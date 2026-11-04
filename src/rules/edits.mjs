// Byte patches between the wire bytes and the agent's bytes (spec 5.1 §记录与标注).
// A step is {at, del, ins, old}: at and del are bytes, at is relative to the state the steps
// before it left, ins and old are strings. An edit is the recorded form, {at, del, ins}.
import { Buffer, isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';

const MIB = 1024 * 1024;
const EDIT_OVERHEAD = 32;
const INVERTED_ON = new Set(['request', 'ws-client']);

const byteLength = (s) => Buffer.byteLength(s, 'utf8');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// spans: sorted, non-overlapping [{start, end, ins}] in JS string indices over text. Only the
// text between spans is measured, so the whole walk is one pass over text. offset is in bytes.
export function spansToSteps(text, spans, offset = 0) {
  const steps = [];
  let at = offset;
  let pos = 0;
  for (const { start, end, ins } of spans) {
    at += byteLength(text.slice(pos, start));
    const old = text.slice(start, end);
    steps.push({ at, del: byteLength(old), ins, old });
    at += byteLength(ins);
    pos = end;
  }
  return steps;
}

// A gap buffer: the cost is how far the gap travels, so a list that runs up the buffer or back
// down it (every inverted list) is one pass, where copying per step would be steps x length.
export function applySteps(buf, steps) {
  const size = buf.length + steps.reduce((n, s) => n + byteLength(s.ins), 0);
  const out = Buffer.allocUnsafe(size);
  let gap = 0;
  let tail = size - buf.length;
  buf.copy(out, tail);
  for (const { at, del, ins } of steps) {
    if (at < gap) {
      tail -= gap - at;
      out.copy(out, tail, at, gap);
    } else {
      out.copy(out, gap, tail, tail + at - gap);
      tail += at - gap;
    }
    tail += del;
    gap = at + out.write(ins, at);
  }
  out.copy(out, gap, tail, size);
  return out.subarray(0, gap + size - tail);
}

export const applyEdits = applySteps;

export function invertSteps(steps) {
  return steps.toReversed().map(({ at, ins, old }) => ({ at, del: byteLength(ins), ins: old, old: ins }));
}

// Edits run from the wire bytes to the agent's bytes. On the way up the wire carries the changed
// bytes, so the record undoes the steps; on the way down the agent got them, so it repeats them.
export function recordEdits(on, steps) {
  const directed = INVERTED_ON.has(on) ? invertSteps(steps) : steps;
  return directed.map(({ at, del, ins }) => ({ at, del, ins }));
}

export function editsCost(edits) {
  return edits.reduce((n, e) => n + byteLength(e.ins) + EDIT_OVERHEAD, 0);
}

export function editsLimit(unitBytes) {
  return Math.min(8 * MIB, Math.max(MIB, unitBytes));
}

// The envelope writes the brackets; empty is length 0 so it can tell there is nothing to splice.
export function serializeEdits(edits) {
  return Buffer.from(edits.map((e) => JSON.stringify(e)).join(','), 'utf8');
}

// Sizes compare in the terms the record's limit counts: editsCost against the base64 length.
export function recoverOf({ wire, agent, edits, compressed }) {
  const sums = { base_sha256: sha256(wire), result_sha256: sha256(agent) };
  if (compressed || !isUtf8(agent) || editsCost(edits) > Math.ceil(agent.length / 3) * 4) {
    return { recover: 'inline', body_b64: agent.toString('base64'), ...sums };
  }
  return { recover: 'patch', edits, ...sums };
}
