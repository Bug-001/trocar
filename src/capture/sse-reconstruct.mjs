// sse-reconstruct.mjs — rebuild the assistant message from Anthropic's streamed events.
// Fidelity boundary: the resp is a RECONSTRUCTION, not the original frames (RFC 4.1 line 37);
// pass keepRaw=true to also retain raw_sse. Ported verbatim from the v0 prototype;
// the keepRaw flag replaces the demo's module-level KEEP_RAW_SSE global.
export function makeSseReconstructor(keepRaw = false) {
  const blocks = []
  const raw = []
  let messageMeta = null, stopReason = null, usage = {}, errorObj = null, pending = ''
  let unparsed = 0 // D38 L-5: a `data:` line that is not JSON is counted (and kept with keepRaw), never dropped unsaid

  function handleEvent(data) {
    let evt
    try { evt = JSON.parse(data) } catch { unparsed++; if (keepRaw) raw.push({ unparsed: data }); return }
    if (keepRaw) raw.push(evt)
    switch (evt.type) {
      case 'message_start': {
        const m = evt.message || {}
        messageMeta = { id: m.id, model: m.model, role: m.role }
        if (m.usage) usage = { ...usage, ...m.usage }
        break
      }
      case 'content_block_start': {
        const b = evt.content_block || {}
        blocks[evt.index] = {
          type: b.type,
          ...(b.type === 'text' ? { text: b.text || '' } : {}),
          ...(b.type === 'tool_use' || b.type === 'server_tool_use'
            ? { id: b.id, name: b.name, _json: '', input: undefined } : {}),
          ...(b.type === 'thinking' ? { thinking: b.thinking || '', signature: '' } : {}),
          ...(b.type === 'redacted_thinking' ? { data: b.data || '' } : {}),
        }
        break
      }
      case 'content_block_delta': {
        const blk = blocks[evt.index]; const d = evt.delta || {}
        if (!blk) break
        if (d.type === 'text_delta') blk.text += d.text || ''
        else if (d.type === 'input_json_delta') blk._json += d.partial_json || ''
        else if (d.type === 'thinking_delta') blk.thinking += d.thinking || ''
        else if (d.type === 'signature_delta') blk.signature += d.signature || ''
        break
      }
      case 'content_block_stop': {
        const blk = blocks[evt.index]
        if (blk && typeof blk._json === 'string') {
          try { blk.input = blk._json ? JSON.parse(blk._json) : {} }
          catch { blk.input = { _unparsed: blk._json } }
          delete blk._json
        }
        break
      }
      case 'message_delta': {
        if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason
        if (evt.usage) usage = { ...usage, ...evt.usage }
        break
      }
      case 'error': { errorObj = evt.error || evt; break }
      default: break
    }
  }

  return {
    push(chunk) {
      pending += chunk.toString('utf8')
      let idx
      while ((idx = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, idx).replace(/\r$/, '')
        pending = pending.slice(idx + 1)
        if (line.startsWith('data:')) {
          const data = line.slice(5).trimStart()
          if (data && data !== '[DONE]') handleEvent(data)
        }
      }
    },
    finish() {
      const content = blocks.filter(Boolean).map((b) => { const { _json, ...rest } = b; return rest })
      const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('')
      const toolCalls = content.filter((b) => b.type === 'tool_use' || b.type === 'server_tool_use')
        .map((b) => ({ id: b.id, name: b.name, input: b.input }))
      const thinking = content.filter((b) => b.type === 'thinking').map((b) => b.thinking).join('')
      return {
        message: messageMeta, stop_reason: stopReason, usage, content_blocks: content,
        text, thinking: thinking || undefined, tool_calls: toolCalls,
        ...(errorObj ? { error: errorObj } : {}),
        ...(keepRaw ? { raw_sse: raw } : {}),
        ...(unparsed ? { unparsed_events: unparsed } : {}),
      }
    },
  }
}
