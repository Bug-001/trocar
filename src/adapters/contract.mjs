// src/adapters/contract.mjs — the harness-agnostic adapter seam (RFC 3.1).
//
// ONE Adapter interface + ONE registry. A record is claimed by the adapter whose
// detect() returns true. Behaviour that the RFC mandates (§ Invariants / Edge cases):
//   • zero claims      → quarantine + count (MUST NOT drop/throw)
//   • exactly one claim → claimed
//   • multiple claims   → pick by precedence AND emit a conflict report (MUST NOT
//                         silently choose one — invariants 2/4).
//
// Adapter shape:
//   { name:string, priority?:number, detect(record)->bool,
//     parseSession, parseCall, parseBlocks, parseResources }

// Unmapped-fields invariant helper (RFC 3.1 § Invariants): diff an object's keys
// against the keys a parse* actually consumed; the remainder goes verbatim into
// `extra`, and the count feeds parseCall.unmapped_count. The contract is
//   (canonical-column keys) ∪ (extra keys) == obj keys   AND   unmapped_count == |extra keys|.
// Never delete an unrecognized field for "cleanliness" — surface it in extra.
export function collectExtra(obj, consumedKeys) {
  const consumed = consumedKeys instanceof Set ? consumedKeys : new Set(consumedKeys);
  const extra = {};
  let unmapped_count = 0;
  for (const k of Object.keys(obj || {})) {
    if (!consumed.has(k)) {
      extra[k] = obj[k];
      unmapped_count++;
    }
  }
  return { extra, unmapped_count };
}

export function createRegistry() {
  const adapters = [];
  let quarantined = 0;
  const conflicts = [];

  // Precedence: higher priority first; ties broken by name for determinism.
  const sortAdapters = () =>
    adapters.sort(
      (x, y) => (y.priority || 0) - (x.priority || 0) || x.name.localeCompare(y.name),
    );

  return {
    register(a) {
      if (!a || typeof a.detect !== 'function' || !a.name) {
        throw new Error('invalid adapter (need name + detect())');
      }
      adapters.push(a);
      sortAdapters();
      return this;
    },
    // All adapters whose detect() claims the record, already precedence-sorted. A
    // throwing detect() is treated as "no claim" (a broken adapter MUST NOT crash dispatch).
    detectAll(record) {
      return adapters.filter((a) => {
        try {
          return a.detect(record);
        } catch {
          return false;
        }
      });
    },
    dispatch(record) {
      const claims = this.detectAll(record); // precedence-sorted
      if (claims.length === 0) {
        quarantined++;
        return { status: 'quarantine' };
      }
      if (claims.length > 1) {
        const conflict = {
          record_id: record?.id ?? null,
          claimants: claims.map((a) => a.name),
          chosen: claims[0].name,
        };
        conflicts.push(conflict);
        return { status: 'claimed', adapter: claims[0], conflict };
      }
      return { status: 'claimed', adapter: claims[0] };
    },
    stats() {
      return { adapters: adapters.length, quarantined, conflicts: conflicts.slice() };
    },
  };
}
