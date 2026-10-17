// wrapper.mjs (arch/darwin) — the macOS half of the 4.11 P8 install-folder wrapper: the /bin/dash script rendered from wrapper.dash.tmpl.
// Core's placeWrapper (core/proxymode/hooks/wrapper.mjs) gets `renderWrapper` from here; macOS compiles nothing.
import fs from 'node:fs'
import { renderTemplate } from '../../core/proxymode/hooks/render.mjs'

const WRAPPER_TEMPLATE = new URL('./wrapper.dash.tmpl', import.meta.url)

// A shell word: single-quoted, a ' inside closed, escaped and reopened; a list is its words separated by spaces.
const word = (s) => `'${String(s).replace(/'/g, "'\\''")}'`
export const shellEncode = (v) => (Array.isArray(v) ? v.map(word).join(' ') : word(v))

/** The wrapper's bytes for { REAL, SWITCH, CA_FILE, CERT_VAR, PROXY_ENV, PROXY_NAMES }. */
export const renderWrapper = (values) => renderTemplate(fs.readFileSync(WRAPPER_TEMPLATE, 'utf8'), values, shellEncode)
