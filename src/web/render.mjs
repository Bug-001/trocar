// src/web/render.mjs — PURE render functions (canonical data -> HTML string). No DOM, no
// fetch, so the render gate drives them under node with REAL store data (AC-1 in render).
// Every function reads CANONICAL fields only (invariant 3 — never provider-native names);
// fidelity is labeled per block (invariant 4). The ★ heart is renderContextWindow, which
// holds the .cblk[data-bi] + #cachebrk anchors.

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const num = (v) => (v == null ? null : Number(v));

// fidelity badge (invariant 4): metadata / opaque / reconstructed / truncated (verbatim = no badge)
export function fidelityBadge(f) {
  if (!f || f === 'verbatim') return '';
  return `<span class="fid fid-${esc(f)}" title="fidelity boundary — not byte-verbatim">${esc(f)}</span>`;
}

// left rail: session selector
export function renderSessions(sessions, activeId) {
  if (!sessions?.length) return `<div class="empty">no sessions — run <code>npm run etl &lt;ndjson&gt;</code></div>`;
  return sessions.map((s) => {
    const label = s.title || (s.cwd ? s.cwd.split('/').pop() : null) || s.session_id.slice(0, 8);
    return `<div class="sess${s.session_id === activeId ? ' active' : ''}" data-sid="${esc(s.session_id)}">
      <div class="sess-title">${esc(label)}</div>
      <div class="sess-meta">${esc(s.harness)} · ${esc(s.provider)} · ${num(s.call_count)} calls</div>
    </div>`;
  }).join('');
}

// top: timeline — one bar per call, height ~ total_input, tint by cache state
export function renderTimeline(calls, activeCallId) {
  if (!calls?.length) return '';
  const max = Math.max(1, ...calls.map((c) => num(c.total_input) || 0));
  return calls.map((c) => {
    const h = Math.round(6 + 44 * ((num(c.total_input) || 0) / max));
    const hit = num(c.hit_ratio);
    const cls = c.error ? 'err' : c.compaction ? 'compact' : (hit != null && hit > 0 ? 'cached' : 'fresh');
    const title = `#${num(c.seq)} ${c.model || ''} · in ${num(c.total_input) ?? '?'} · hit ${hit != null ? (hit * 100).toFixed(0) + '%' : '—'}`;
    return `<div class="tbar ${cls}${c.call_id === activeCallId ? ' active' : ''}" data-cid="${esc(c.call_id)}" style="height:${h}px" title="${esc(title)}"></div>`;
  }).join('');
}

// ★ heart: faithful context replay — verbatim blocks (AC-1). .cblk[data-bi] anchors.
export function renderContextWindow(blocks) {
  if (!blocks?.length) return `<div class="empty">no context blocks for this call</div>`;
  return blocks.map((b, i) => {
    const text = b.text == null ? '' : b.text;
    return `<div class="cblk" data-bi="${i}" data-section="${esc(b.section)}">
      <div class="cblk-h"><span class="cblk-sec">${esc(b.section)}</span>${b.role ? `<span class="cblk-role">${esc(b.role)}</span>` : ''}${fidelityBadge(b.faithfulness)}<span class="cblk-len">${text.length} chars</span></div>
      <pre class="cblk-body">${esc(text)}</pre>
    </div>`;
  }).join('');
}

// cache-break marker (#cachebrk) — canonical divergence_cause + byte offset (structural estimate)
export function cacheBreakMarker(call) {
  if (!call || call.structural_divergence_seq == null) return '';
  const off = call.divergence_byte_offset;
  return `<div class="cachemark" id="cachebrk">
    <span class="cm-kind">${esc(call.break_kind || 'break')}</span>
    <span class="cm-why">${esc(call.divergence_cause || '')}${off != null ? ` @ byte ${num(off)}` : ''}</span>
    <span class="cm-est" title="structural inference, not a provider-declared boundary">结构估计</span>
    ${call.ground_truth_flag ? `<span class="cm-gt">${esc(call.ground_truth_flag)}</span>` : ''}
  </div>`;
}

// cache overlay + usage per call (AC-2) — canonical roles only, no provider-native field names
export function renderCacheOverlay(call) {
  if (!call) return '';
  const cells = [
    ['input', num(call.input_uncached)],
    ['cache read', num(call.cache_read)],
    ['cache write', num(call.cache_write)],
    ['output', num(call.output)],
    ['reasoning', num(call.reasoning)],
  ].filter(([, v]) => v != null);
  const hit = num(call.hit_ratio);
  return `<div class="usage">
    ${cells.map(([k, v]) => `<div class="ucell"><span class="uk">${esc(k)}</span><span class="uv">${v}</span></div>`).join('')}
    <div class="ucell hit"><span class="uk">hit ratio</span><span class="uv">${hit != null ? (hit * 100).toFixed(0) + '%' : '—'}</span></div>
  </div>${cacheBreakMarker(call)}`;
}

// resource lifecycle (2.4)
export function renderResources(resources) {
  if (!resources?.length) return `<div class="empty">no resources in this session</div>`;
  return resources.map((r) => `<div class="res res-${esc(r.kind)}">
    <span class="res-kind">${esc(r.kind)}</span>
    <span class="res-label">${esc(r.label || r.resource_id)}</span>
    <span class="res-ev">${r.events.map((e) => esc(e.event)).join(' → ')}</span>
  </div>`).join('');
}
