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

// fold /api/session composition rows into call_id -> {tools,system,messages,total} char sums.
const SECTIONS = ['tools', 'system', 'messages'];
export function compositionMap(rows) {
  const m = new Map();
  for (const r of rows || []) {
    if (!m.has(r.call_id)) m.set(r.call_id, { tools: 0, system: 0, messages: 0, total: 0 });
    const e = m.get(r.call_id);
    const c = num(r.chars) || 0;
    if (SECTIONS.includes(r.section)) e[r.section] += c; else e.messages += c;
    e.total += c;
  }
  return m;
}

// timeline (1.3): per-call bar, height ~ context chars, STACKED + colored by section
// (tools/system/messages, ≈ by char proportion). Falls back to a cache-tinted bar without comp.
export function renderTimeline(calls, compMap, activeCallId) {
  if (!calls?.length) return '';
  const comp = compMap || new Map();
  const totals = calls.map((c) => (comp.get(c.call_id)?.total) || num(c.total_input) || 0);
  const max = Math.max(1, ...totals);
  return calls.map((c, i) => {
    const H = Math.round(6 + 44 * (totals[i] / max));
    const active = c.call_id === activeCallId ? ' active' : '';
    const e = comp.get(c.call_id);
    let segs;
    if (e && e.total > 0) {
      segs = SECTIONS.map((s) => (e[s] > 0 ? `<div class="tseg tseg-${s}" style="height:${(e[s] / e.total * 100).toFixed(1)}%"></div>` : '')).join('');
    } else {
      const hit = num(c.hit_ratio);
      segs = `<div class="tseg ${hit > 0 ? 'tseg-cached' : 'tseg-fresh'}" style="height:100%"></div>`;
    }
    const badge = c.error ? '<span class="tflag err">⚠</span>' : c.compaction ? '<span class="tflag comp">✂</span>' : '';
    const hit = num(c.hit_ratio);
    const title = `#${num(c.seq)} ${c.model || ''} · ctx ${totals[i]}B · hit ${hit != null ? (hit * 100).toFixed(0) + '%' : '—'}${c.compaction ? ' · ✂compaction' : ''}${c.error ? ' · ⚠error' : ''}`;
    return `<div class="tbar${active}" data-cid="${esc(c.call_id)}" style="height:${H}px" title="${esc(title)}">${segs}${badge}</div>`;
  }).join('');
}

// cache band (1.3): one cell per call, 1:1 under the bars, 3-tier by hit_ratio.
export function renderCacheBand(calls, activeCallId) {
  if (!calls?.length) return '';
  return calls.map((c) => {
    const hit = num(c.hit_ratio);
    const tier = hit == null ? 'none' : hit >= 0.7 ? 'hi' : hit > 0 ? 'mid' : 'lo';
    return `<div class="cband-cell cb-${tier}${c.call_id === activeCallId ? ' active' : ''}" data-cid="${esc(c.call_id)}" title="hit ${hit != null ? (hit * 100).toFixed(0) + '%' : '—'}"></div>`;
  }).join('');
}

// scrub bar (1.4): prev / next / jump-to-latest + playhead N/M label.
export function renderScrub(calls, activeCallId) {
  if (!calls?.length) return '';
  const idx = calls.findIndex((c) => c.call_id === activeCallId);
  const n = idx < 0 ? 0 : idx + 1;
  return `<button class="scrub-btn" data-scrub="prev" title="previous call (←)"${n <= 1 ? ' disabled' : ''}>◄</button>`
    + `<span class="scrub-pos">${n}/${calls.length}</span>`
    + `<button class="scrub-btn" data-scrub="next" title="next call (→)"${n >= calls.length || n === 0 ? ' disabled' : ''}>►</button>`
    + `<button class="scrub-btn" data-scrub="end" title="jump to latest (End)">⇥</button>`;
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
