// src/web/app.mjs — DOM wiring. Fetches the Phase-2 canonical endpoints, renders, handles
// clicks. ZERO provider logic and zero provider-native field names here — all data is the
// server's provider-neutral canonical JSON (invariant 3). Vanilla ES module (D18a).
import {
  renderSessions, renderTimeline, renderContextWindow, renderCacheOverlay, renderResources,
} from './render.mjs';

const $ = (id) => document.getElementById(id);
const api = (p) => fetch(p, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))));

const state = { sessions: [], sid: null, calls: [], cid: null };

async function boot() {
  state.sessions = await api('/api/sessions');
  $('sessions').innerHTML = renderSessions(state.sessions, null);
  if (state.sessions.length) {
    const top = state.sessions.slice().sort((a, b) => b.call_count - a.call_count)[0];
    await selectSession(top.session_id);
  }
}

async function selectSession(sid) {
  state.sid = sid; state.cid = null;
  $('sessions').innerHTML = renderSessions(state.sessions, sid);
  const data = await api(`/api/session/${encodeURIComponent(sid)}`);
  state.calls = data.calls;
  $('timeline').innerHTML = renderTimeline(state.calls, null);
  $('resources').innerHTML = renderResources(data.resources);
  const first = state.calls.find((c) => c.class !== 'control') || state.calls[0];
  if (first) await selectCall(first.call_id);
  else { $('context').innerHTML = ''; $('overlay').innerHTML = ''; }
}

async function selectCall(cid) {
  state.cid = cid;
  $('timeline').innerHTML = renderTimeline(state.calls, cid);
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

document.addEventListener('click', (e) => {
  const s = e.target.closest && e.target.closest('.sess');
  if (s) { selectSession(s.dataset.sid); return; }
  const t = e.target.closest && e.target.closest('.tbar');
  if (t) { selectCall(t.dataset.cid); return; }
});

boot().catch((e) => { $('sessions').innerHTML = `<div class="empty">failed to load: ${e.message}</div>`; });
