// src/web/app.mjs — DOM wiring. Fetches the Phase-2 canonical endpoints, renders, handles
// clicks + keyboard scrub. ZERO provider logic / provider-native field names (invariant 3).
import {
  renderSessions, compositionMap, renderTimeline, renderCacheBand, renderScrub,
  renderContextWindow, renderCacheOverlay, renderResources,
} from './render.mjs';

const $ = (id) => document.getElementById(id);
const api = (p) => fetch(p, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))));

const state = { sessions: [], sid: null, calls: [], comp: new Map(), cid: null };

async function boot() {
  state.sessions = await api('/api/sessions');
  $('sessions').innerHTML = renderSessions(state.sessions, null);
  if (state.sessions.length) {
    const top = state.sessions.slice().sort((a, b) => b.call_count - a.call_count)[0];
    await selectSession(top.session_id);
  }
}

// repaint the timeline lane (bars + cache band + scrub) for the current playhead.
function paintTimeline() {
  $('timeline').innerHTML = renderTimeline(state.calls, state.comp, state.cid);
  $('cacheband').innerHTML = renderCacheBand(state.calls, state.cid);
  $('scrub').innerHTML = renderScrub(state.calls, state.cid);
}

async function selectSession(sid) {
  state.sid = sid; state.cid = null;
  $('sessions').innerHTML = renderSessions(state.sessions, sid);
  const data = await api(`/api/session/${encodeURIComponent(sid)}`);
  state.calls = data.calls;
  state.comp = compositionMap(data.composition);
  $('resources').innerHTML = renderResources(data.resources);
  paintTimeline();
  const first = state.calls.find((c) => c.class !== 'control') || state.calls[0];
  if (first) await selectCall(first.call_id);
  else { $('context').innerHTML = ''; $('overlay').innerHTML = ''; }
}

async function selectCall(cid) {
  state.cid = cid;
  paintTimeline();
  const call = state.calls.find((c) => c.call_id === cid);
  $('overlay').innerHTML = renderCacheOverlay(call);
  try {
    const ctx = await api(`/api/call/${encodeURIComponent(cid)}/context`);
    $('context').innerHTML = renderContextWindow(ctx.blocks);
    $('ctxhead').textContent = `call ${cid} · ${ctx.blocks.length} blocks` + (ctx.source_resolved ? '' : ' · source not resolved');
  } catch {
    $('context').innerHTML = '<div class="empty">no context (control / error call)</div>';
    $('ctxhead').textContent = `call ${cid}`;
  }
}

// step the playhead ±1 or to an edge ('end' / 'home').
function step(where) {
  if (!state.calls.length) return;
  const idx = state.calls.findIndex((c) => c.call_id === state.cid);
  let n = idx < 0 ? 0 : idx;
  if (where === 'prev') n = Math.max(0, idx - 1);
  else if (where === 'next') n = Math.min(state.calls.length - 1, idx + 1);
  else if (where === 'end') n = state.calls.length - 1;
  else if (where === 'home') n = 0;
  selectCall(state.calls[n].call_id);
}

document.addEventListener('click', (e) => {
  const close = (sel) => e.target.closest && e.target.closest(sel);
  const s = close('.sess'); if (s) return void selectSession(s.dataset.sid);
  const b = close('.scrub-btn'); if (b && !b.disabled) return void step(b.dataset.scrub);
  const t = close('.tbar'); if (t) return void selectCall(t.dataset.cid);
  const cb = close('.cband-cell'); if (cb) return void selectCall(cb.dataset.cid);
});

document.addEventListener('keydown', (e) => {
  if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  const k = { ArrowLeft: 'prev', ArrowRight: 'next', Home: 'home', End: 'end' }[e.key];
  if (k) { e.preventDefault(); step(k); }
});

boot().catch((e) => { $('sessions').innerHTML = `<div class="empty">failed to load: ${e.message}</div>`; });
