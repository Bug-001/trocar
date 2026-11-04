// src/query/named/block.mjs — `trocar query block --ref <ref> [--ref <ref> …]` (RFC 1.6 §4.1, 附录 C.5; 3.5 §会话读).
//
// Each ref's bytes, read back from the record they were captured in. A ref names its record as
// `<segment>:<line>` (D60) and, optionally, a field and a byte span inside it — the same text_ref the
// session view mints (src/raw/refs.mjs, mintRawRef / composeTextRef). The fidelity of what comes back is NOT smoothed over
// (invariant 4): it is classified by the resolver's own classifier, and the capture's own
// incompleteness labels are carried through as they are. Beside the bytes, each block's view: what extraction parsed of it and how to
// draw it, read from a stamped copy of the record — `raw` itself gives the bytes and their labels, which a stamped record no longer
// could (normalizing a v0 record drops the field its fidelity is read from).
import { parseRecordId } from '../../collector/core/record/segments.mjs';
import { parseTextRef } from '../../raw/refs.mjs';
import { TEXT_REF_FIELD, fieldTextOf } from '../../dissect/record-fields.mjs';
import { normalizeRecord } from '../../raw/ingest.mjs';
import { requestEncodingOf } from '../../dissect/request-body.mjs';
import { reqIncompleteOf } from '../../dissect/capture-labels.mjs';
import { classifyFidelity } from '../source.mjs';
import { recordReader, stampRecord } from '../records.mjs';
import { blockAt } from '../../view/extract.mjs';
import { viewOf } from '../../view/render-kind.mjs';
import { QueryArgError } from './index.mjs';

export const params = Object.freeze(['ref']);
/** `--ref` may be given again and again: one item per ref, in the order given (1.6 §4.1 参数). */
export const lists = Object.freeze(['ref']);

// What a reader must be told about bytes that are not the wire's own (src/query/source.mjs classifyFidelity).
const NOTE = {
  decoded: 'the wire carried this body compressed; these are its exact decompressed bytes',
  reserialized: 'the capture stored this as parsed JSON: these bytes were re-serialized from it, not taken off the wire',
};

export async function run({ home, fs, params: p, errors, progress = null }) {
  const refs = (Array.isArray(p.ref) ? p.ref : [p.ref]).filter((r) => r != null && r !== '').map(String);
  if (!refs.length) throw new QueryArgError('trocar query block: --ref is required (a block\'s ref, as `trocar query lane` gives it)');
  // a record with its parsed tables weighs several times its stored bytes: one record at a time, let go before the next (3.5 §会话读 `block`)
  const byRecord = new Map();
  refs.forEach((ref, i) => {
    const item = { i, ref, ...parsed1(ref) };
    if (!byRecord.has(item.recordId)) byRecord.set(item.recordId, []);
    byRecord.get(item.recordId).push(item);
  });
  const blocks = new Array(refs.length), read = recordReader({ home, fs, progress });
  for (const group of byRecord.values()) await readGroup({ read, errors, progress }, group, blocks);
  return { blocks };
}

function parsed1(ref) {
  const { recordId, field, start, end } = parseTextRef(ref);
  const at = parseRecordId(recordId);
  if (!at) throw new QueryArgError(`trocar query block: --ref ${JSON.stringify(ref)} names no record — a record is \`<segment>:<line>\``);
  if (field != null && !TEXT_REF_FIELD.test(field)) throw new QueryArgError(`trocar query block: "${field}" is not a ref field (RFC 4.2:40: resp.raw | resp.messages.<j> | req_extra_messages.<k>)`);
  return { recordId, field, start, end, at };
}

// The items of one record's refs, into `blocks` at their places.
async function readGroup({ read, errors, progress }, group, blocks) {
  const { recordId, at } = group[0];
  let raw = null, unread = null;
  try {
    raw = await read(at);
    if (!raw) unread = ['record-missing', `no record ${recordId} in this home's raw segments`];
  } catch (e) { unread = ['record-unreadable', `record ${recordId} could not be read back: ${String((e && e.message) || e)}`]; }
  const rec = raw && stampRecord(raw, { ...at, stream: raw._stream });
  for (const item of group) {
    blocks[item.i] = unread ? miss(errors, item.ref, ...unread) : one(errors, raw, rec, item);
    if (progress) progress();
  }
}

// What a ref cannot read is `bytes: null` and an errors entry with a BLOCK_PROBLEMS code (3.5 §会话读 `block`).
function miss(errors, where, code, reason, truncated = null) {
  errors.push({ where, code, reason });
  return { ref: where, bytes: null, encoding: null, fidelity: null, truncated };
}

function one(errors, raw, rec, { ref, recordId, field, start, end }) {
  // A field of a record is the stored decoded text itself (4.6 §记录), so it is verbatim as it stands, unless the field says otherwise.
  const got = field ? fieldTextOf(raw, field) : { text: normalizeRecord(raw).req_body };
  const fidelity = !field ? classifyFidelity(raw) : got.reserialized ? 'reserialized' : 'verbatim';
  const truncated = reqIncompleteOf(raw);
  if (typeof got.text !== 'string') return miss(errors, ref, 'field-missing', `record ${recordId} ${got.missing || 'carries no request body'}`, truncated);
  const bytes = start == null || end == null ? got.text : got.text.slice(start, end);
  const view = viewAt(errors, rec, ref);
  return {
    ref, bytes,
    encoding: requestEncodingOf(raw) || 'identity',
    fidelity: { verbatim: fidelity !== 'reserialized', ...(NOTE[fidelity] ? { note: NOTE[fidelity] } : {}) },
    truncated,
    ...(view ? { view } : {}),
  };
}

// The block's parsed view, or null when `ref` names no block or the block has nothing parsed to show; a parse that throws costs the
// view alone, and says so as a note: the bytes above are as good as ever.
function viewAt(errors, rec, ref) {
  try {
    const flat = blockAt(rec, ref), view = flat && viewOf(flat);
    return view && (flat.events ? { ...view, events: flat.events } : view);
  } catch (e) {
    errors.push({ where: ref, code: 'view-unreadable', reason: `this block's parsed view could not be built: ${String((e && e.message) || e)}`, level: 'note' });
    return null;
  }
}
