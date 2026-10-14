// forms.mjs — this arch's entry gate and proxy entry value (RFC 4.8 §2.4 · §3, carried by 4.9 §2.4; acceptance W23). Nothing in it is darwin's own: the one copy is
// core/entry-forms.mjs, re-exported here so the arch's callers keep one place to import from.
export { entryGate, proxyUrl, proxyEntries } from '../../core/entry-forms.mjs'
