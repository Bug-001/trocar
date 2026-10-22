// src/query/named/block.mjs — `trocar query block --ref <ref> [--ref <ref> …]` (RFC 1.6 §4.1, 附录 C.5; 3.5 §会话读).
//
// Each ref's bytes, read back from the record they were captured in. A ref names its record as
// `<segment>:<line>` (D60) and, optionally, a field and a byte span inside it — the same text_ref the
// session view mints (src/raw/refs.mjs, mintRawRef / composeTextRef). The fidelity of what comes back is NOT smoothed over
// (invariant 4): it is classified by the resolver's own classifier, and the capture's own
// incompleteness labels are carried through as they are.
import { parseRecordId } from '../../collector/core/record/segments.mjs';
import { parseTextRef } from '../../raw/refs.mjs';
import { TEXT_REF_FIELD, fieldTextOf } from '../../dissect/record-fields.mjs';
import { normalizeRecord } from '../../raw/ingest.mjs';
import { requestEncodingOf } from '../../dissect/request-body.mjs';
import { reqIncompleteOf } from '../../dissect/capture-labels.mjs';
import { classifyFidelity } from '../source.mjs';
import { readRecord } from '../records.mjs';
import { QueryArgError } from './index.mjs';

export const params = Object.freeze(['ref']);
/** `--ref` may be given again and again: one item per ref, in the order given (1.6 §4.1 参数). */
export const lists = Object.freeze(['ref']);

// What a reader must be told about bytes that are not the wire's own (src/query/source.mjs classifyFidelity).
const NOTE = {
  decoded: 'the wire carried this body compressed; these are its exact decompressed bytes',
  reserialized: 'the capture stored the request as parsed JSON: these bytes were re-serialized from it, not taken off the wire',
};

export async function run({ home, fs, params: p, errors }) {
  const refs = (Array.isArray(p.ref) ? p.ref : [p.ref]).filter((r) => r != null && r !== '').map(String);
  if (!refs.length) throw new QueryArgError('trocar query block: --ref is required (a block\'s ref, as `trocar query lane` gives it)');
  const parsed = refs.map(parsed1);
  const blocks = [];
  for (const [i, ref] of refs.entries()) blocks.push(await one({ home, fs, errors }, ref, parsed[i]));
  return { blocks };
}

function parsed1(ref) {
  const { recordId, field, start, end } = parseTextRef(ref);
  const at = parseRecordId(recordId);
  if (!at) throw new QueryArgError(`trocar query block: --ref ${JSON.stringify(ref)} names no record — a record is \`<segment>:<line>\``);
  if (field != null && !TEXT_REF_FIELD.test(field)) throw new QueryArgError(`trocar query block: "${field}" is not a ref field (RFC 4.2:40: resp.raw | resp.messages.<j> | req_extra_messages.<k>)`);
  return { recordId, field, start, end, at };
}

// One ref's item; what it cannot read is `bytes: null` and an errors entry with a BLOCK_PROBLEMS code (3.5 §会话读 `block`).
async function one({ home, fs, errors }, ref, { recordId, field, start, end, at }) {
  const miss = (code, reason) => { errors.push({ where: ref, code, reason }); return { ref, bytes: null, encoding: null, fidelity: null, truncated: null }; };
  let raw;
  try { raw = await readRecord({ home, fs, ...at }); } catch (e) { return miss('record-unreadable', `record ${recordId} could not be read back: ${String((e && e.message) || e)}`); }
  if (!raw) return miss('record-missing', `no record ${recordId} in this home's raw segments`);

  // A field of a record is the stored decoded text itself (4.6 §记录), so it is verbatim as it stands.
  const got = field ? fieldTextOf(raw, field) : { text: normalizeRecord(raw).req_body };
  const fidelity = field ? 'verbatim' : classifyFidelity(raw);
  const truncated = reqIncompleteOf(raw);
  if (typeof got.text !== 'string') return { ...miss('field-missing', `record ${recordId} ${got.missing || 'carries no request body'}`), truncated };
  const bytes = start == null || end == null ? got.text : got.text.slice(start, end);
  return {
    ref, bytes,
    encoding: requestEncodingOf(raw) || 'identity',
    fidelity: { verbatim: fidelity !== 'reserialized', ...(NOTE[fidelity] ? { note: NOTE[fidelity] } : {}) },
    truncated,
  };
}
