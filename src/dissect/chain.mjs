// src/dissect/chain.mjs — the step every cross-record context shares (3.1:60, D37 ②): a call that names its
// predecessor's reply (OpenAI WebSocket previous_response_id, Anthropic Message Threads previous_message_id) ran
// with the predecessor's whole stitched context, then the predecessor's reply, then its own delta.
//   head = { plan: { segments, contextState, missing }, outputSegs } | null (the predecessor is not in the capture)
// → { segments, contextState, missing }: 'reconstructed' when the whole chain is in the capture, else 'partial' with
// what is missing. A segment is { rec, field, path, item }: where the item's bytes sit, so each block stays verbatim.
// Leaf module.
export function extendChain(head, own, missingWhenAbsent) {
  if (!head) return { segments: own, contextState: 'partial', missing: missingWhenAbsent };
  return {
    segments: [...head.plan.segments, ...head.outputSegs, ...own],
    contextState: head.plan.contextState === 'partial' ? 'partial' : 'reconstructed',
    missing: head.plan.missing || null,
  };
}
