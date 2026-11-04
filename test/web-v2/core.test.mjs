// The small pure modules other screens import by name: chips, labels, classes, store.
import test from 'node:test'
import assert from 'node:assert/strict'
import { CHIP, HARNESS_ORDER, harnessKey, harnessName, harnessIcon, harnessRaw, chipFor, UNIDENTIFIED, UNKNOWN_ICON, sanitizeHarnessSvg } from '../../web/legacy/core/chips.mjs'
import { L } from '../../web/legacy/core/labels.mjs'
import * as labelsAgg from '../../web/legacy/core/labels.mjs'
import * as labelsCommon from '../../web/legacy/labels/common.mjs'
import { CLASS_IDS, CLASS_NAME } from '../../web/legacy/core/classes.mjs'
import { createStore, store } from '../../web/legacy/core/store.mjs'
import { parseHash, formatHash } from '../../web/legacy/core/router.mjs'
import * as domMod from '../../web/legacy/core/dom.mjs'
import * as safeMountMod from '../../web/legacy/shell/safemount.mjs'

test('chips: each read-side id (test/web-v2/harness-seam.test.mjs holds them to the server table) has its icon file, aliases folded onto them', () => {
  for (const id of HARNESS_ORDER) { assert.ok(CHIP[id], `CHIP.${id}`); assert.match(CHIP[id].icon, /^[\w-]+\.svg$/) }
  assert.deepEqual(['claude-code', 'deepseek-dsh', 'kimi-code', 'z-code', 'codex', 'mystery'].map(harnessKey), ['cc', 'dsh', 'kimi', 'zcode', 'codex', 'mystery'])
  assert.equal(harnessName('deepseek-dsh'), harnessName('dsh')); assert.equal(harnessIcon('z-code'), harnessIcon('zcode'))
})
test('chips: an unknown or missing harness never borrows another one\'s name or icon', () => {
  assert.equal(harnessName(null), UNIDENTIFIED); assert.equal(harnessName('mystery'), UNIDENTIFIED)
  assert.equal(harnessName('constructor'), UNIDENTIFIED) // not an inherited property
  assert.equal(harnessRaw('mystery'), 'mystery'); assert.equal(harnessRaw(null), null); assert.equal(harnessRaw('cc'), null)
  for (const id of [null, '', 'mystery']) assert.match(harnessIcon(id), /hicon-unknown/, 'the reserved dashed glyph')
  assert.match(harnessIcon('mystery'), /stroke-dasharray/, 'dashed, like no harness\' mark')
  assert.equal(harnessIcon('mystery'), harnessIcon(null), 'one unknown glyph, not one per stranger')
  assert.match(chipFor({ harness: 'mystery' }), /data-hicon="\?"/); assert.ok(chipFor(null).includes(UNIDENTIFIED))
})
test('chips: a known harness icon is an empty 16px box until the loader fills it — never the unknown glyph', () => {
  assert.equal(harnessIcon('cc'), '<span class="hicon" data-hicon="cc" aria-hidden="true"></span>')
  assert.ok(!harnessIcon('cc').includes('dasharray'))
})
test('chips: the chip is the same DOM for every harness — icon + name; entry point and inference are quiet marks', () => {
  const s = chipFor({ harness: 'codex', entrypoint: 'cli', harness_inferred: true, session_synthesized: true })
  assert.ok(s.startsWith(harnessIcon('codex'))); assert.ok(s.includes('<span class="chipname">Codex</span>'))
  for (const id of HARNESS_ORDER) { // same structure: icon span + one name span, only their content differs
    const c = chipFor({ harness: id })
    assert.match(c, /^<span class="hicon"/); assert.equal((c.match(/<span class="chipname">/g) || []).length, 1, id)
  }
})
test('chips: the icon whitelist keeps scripts, handlers, urls and foreign content out, and lets the drawn files through', () => {
  assert.equal(sanitizeHarnessSvg('<svg viewBox="0 0 16 16"><path d="M1 1"/></svg>'), '<path d="M1 1"/>')
  for (const bad of [
    '<svg onload="x()"><path/></svg>',
    '<svg><script>alert(1)</script></svg>',
    '<svg><foreignObject><body/></foreignObject></svg>',
    '<svg><a href="http://x">y</a></svg>',
    '<svg><path style="fill:url(#x)"/></svg>',
    '<svg><image href="x.png"/></svg>',
    '<svg><text>hi</text></svg>',
    'not svg at all',
  ]) assert.equal(sanitizeHarnessSvg(bad), null, bad)
})
test('labels and classes keep their contract', () => {
  assert.equal('PROPOSED_ENDPOINT' in L, false, 'the mock-era proposed-endpoint label is gone')
  for (const c of CLASS_IDS) assert.ok(CLASS_NAME[c], c)
})
test('core/labels.mjs is the aggregator of labels/: every export of labels/common.mjs is read through it, by identity', () => {
  for (const [name, value] of Object.entries(labelsCommon)) assert.equal(labelsAgg[name], value, name)
  assert.ok(Object.keys(labelsCommon).includes('L') && Object.keys(labelsCommon).includes('priceApprox'))
})
test('store: set shallow-merges and notifies once; unsubscribe stops it', () => {
  const s = createStore({ a: 1, b: { x: 1 } }); const seen = []
  const off = s.subscribe((st) => seen.push(st))
  s.set({ a: 2, c: 3 }); assert.deepEqual(s.get(), { a: 2, b: { x: 1 }, c: 3 }); assert.equal(seen.length, 1)
  off(); s.set({ a: 9 }); assert.equal(seen.length, 1)
  assert.deepEqual(Object.keys(store.get()).sort(), ['capH', 'capHErr', 'capHOkAt', 'libraryHash', 'libraryNotice', 'pricing'])
  assert.equal(store.get().libraryHash, '#/sessions'); assert.equal(store.get().libraryNotice, null)
})
test('attrSel escapes a value for a double-quoted attribute selector (one helper, shared by the replay desk)', () => {
  assert.equal(domMod.attrSel('plain-id'), 'plain-id')
  assert.equal(domMod.attrSel('a"b'), 'a\\"b'); assert.equal(domMod.attrSel('a\\b'), 'a\\\\b'); assert.equal(domMod.attrSel(12), '12')
  assert.equal(domMod.attrSel('x"]#y'), 'x\\"]#y') // the quote is what could close the selector early
})
test('store: set with nothing new does not notify (so a poll that writes the same answer repaints nothing)', () => {
  const s = createStore({ a: 1, o: { x: 1 }, n: NaN }); const seen = []
  s.subscribe((st, prev) => seen.push([st, prev]))
  const before = s.get()
  s.set({}); s.set({ a: 1 }); s.set({ n: NaN }); s.set({ a: 1, n: NaN })
  assert.equal(seen.length, 0); assert.equal(s.get(), before) // no new state object either
  s.set({ a: 1, b: 2 }); assert.equal(seen.length, 1) // one changed key among unchanged ones is a change
  assert.equal(seen[0][0].b, 2); assert.equal(seen[0][1].b, undefined); assert.notEqual(seen[0][0], seen[0][1])
  s.set({ o: { x: 1 } }); assert.equal(seen.length, 2) // compared by identity (Object.is), not deeply
  s.set({ u: undefined }); assert.equal(seen.length, 3) // a key that did not exist now exists
  s.set({ u: undefined }); assert.equal(seen.length, 3)
})

// ── a screen whose mount() throws leaves nothing behind ──────────────────────────────────────────────────────────────
test('safeMount: a throwing mount clears the screen, drops its keys and the screen says why (escaped, as an alert)', () => {
  const calls = []
  const el = { innerHTML: '', replaceChildren: () => calls.push('clear') }
  const out = safeMountMod.safeMount({ mount() { throw new Error('boom <b>x</b>') } }, el, { c: 1 }, { clearKeys: () => calls.push('keys') })
  assert.equal(out, null)
  assert.deepEqual(calls, ['clear', 'keys'])
  assert.match(el.innerHTML, /role="alert"/); assert.ok(el.innerHTML.includes('boom')); assert.ok(!el.innerHTML.includes('<b>x'), 'the reason is escaped')
})
test('safeMount: a mount that throws something that is not an Error, or a module with no mount, still says something', () => {
  for (const mod of [{ mount() { throw 'plain string' } }, {}, { mount: 5 }]) {
    const el = { innerHTML: '', replaceChildren() {} }
    const out = safeMountMod.safeMount(mod, el, {}, { clearKeys() {} })
    assert.equal(out, null); assert.ok(el.innerHTML.length > 0 && /role="alert"/.test(el.innerHTML))
  }
})
test('safeMount: a good mount returns the instance and touches nothing', () => {
  const calls = [], inst = { update() {}, unmount() {} }
  const got = safeMountMod.safeMount({ mount: (el, ctx) => { calls.push(['mount', el.id, ctx.n]); return inst } }, { id: 'e', replaceChildren: () => calls.push('clear') }, { n: 1 },
    { clearKeys: () => calls.push('keys') })
  assert.equal(got, inst); assert.deepEqual(calls, [['mount', 'e', 1]])
})

// ── modal focus trap ─────────────────────────────────────────────────────────────────────────────────────────────────
test('trapTab: Tab on the last control wraps to the first, Shift+Tab on the first wraps to the last', () => {
  const [a, b, c] = ['a', 'b', 'c']
  assert.equal(domMod.trapTab([a, b, c], c, false), a); assert.equal(domMod.trapTab([a, b, c], a, true), c)
  assert.equal(domMod.trapTab([a, b, c], b, false), null); assert.equal(domMod.trapTab([a, b, c], b, true), null) // the browser moves it
  assert.equal(domMod.trapTab([a], a, false), a); assert.equal(domMod.trapTab([a], a, true), a)
})
test('trapTab: focus that is outside the dialog is pulled back in', () => {
  assert.equal(domMod.trapTab(['a', 'b'], 'outside', false), 'a'); assert.equal(domMod.trapTab(['a', 'b'], 'outside', true), 'b')
  assert.equal(domMod.trapTab(['a', 'b'], null, false), 'a')
  assert.equal(domMod.trapTab([], 'x', false), null) // nothing to trap
})


// 1.2 #12: arrows typed into a control or inside a list box / menu never reach the screen; Escape always does (fake targets)
test('keys: isTyping holds for form controls, editable content and a target inside role=listbox / role=menu; Escape still passes', async () => {
  const { isTyping } = await import('../../web/legacy/core/keys.mjs')
  const inRole = (role) => ({ tagName: 'LI', closest: (sel) => (sel.includes(`role=${role}`) || sel.includes(`role="${role}"`) ? {} : null) })
  const plain = { tagName: 'DIV', closest: () => null }
  const typing = [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { tagName: 'DIV', isContentEditable: true }, inRole('listbox'), inRole('menu')]
  for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
    for (const target of typing) assert.equal(isTyping({ key, target }), true, `${key} on ${target.tagName}`)
    assert.equal(isTyping({ key, target: plain }), false)
  }
  for (const target of typing) assert.equal(isTyping({ key: 'Escape', target }), false, 'Escape reaches the screen handler')
})

test('techDetailsHtml: every pair is exactly one key cell and one value cell, values escaped in text mode, copy lines never start with a bare separator', async () => {
  const { techDetailsHtml } = await import('../../web/legacy/core/ui.mjs')
  const pairs = [['pid', 4242], ['', 'continuation'], [null, 'more'], ['body', '<b>x</b>'], ['path', '/a/'.repeat(4000)]]
  const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  for (const html of [false, true]) {
    const out = techDetailsHtml(pairs, { html })
    const body = out.match(/<div class="tech">([\s\S]*?)<\/div>/)[1]
    const cells = (body.match(/<span class="k"/g) || []).length + (body.match(/<span class="v"/g) || []).length
    assert.equal(cells, 2 * pairs.length, `html:${html}`)
    assert.equal(/<\/span>([^<]+)<span/.test(body), false, `html:${html} stray text between cells`)
    if (!html) {
      assert.equal(body.includes('<b>'), false)
      const copy = unesc(out.match(/data-copy="([^"]*)"/)[1])
      assert.equal(copy.split('\n').some((l) => l.startsWith(': ')), false)
    }
  }
})

// 1.2 §键盘「层随屏走」: a popover or menu pinned open on a screen closes when that screen's signal aborts (main.mjs aborts it on unmount);
// a document stand-in carries the listeners installUi adds and one trigger + layer pair per kind
test('1.2 layers go with their screen: a pinned popover and a pinned menu close when their screen\'s signal aborts', async () => {
  const { installUi } = await import('../../web/legacy/core/ui.mjs')
  const on = {}
  const layers = {}
  const doc = { addEventListener(t, f) { (on[t] ||= []).push(f) }, getElementById: (id) => layers[id] || null, getSelection: () => null }
  installUi(doc)
  for (const kind of ['pop', 'menu']) {
    const layer = layers[kind] = { hidden: true, contains: () => false }
    const attrs = {}
    const btn = { dataset: { [kind]: kind }, setAttribute(k, v) { attrs[k] = v }, dispatchEvent() {}, focus() {} }
    btn.closest = (sel) => (sel === '[data-pop],[data-menu]' ? btn : null)
    const ac = new AbortController()
    domMod.setScreenSignal(ac.signal)
    for (const f of on.click) f({ target: btn, detail: 1, preventDefault() {}, stopImmediatePropagation() {} })
    assert.equal(layer.hidden, false, `${kind}: pinned open`)
    assert.equal(attrs['aria-expanded'], 'true')
    ac.abort()
    assert.equal(layer.hidden, true, `${kind}: closed with its screen`)
    assert.equal(attrs['aria-expanded'], 'false')
    domMod.setScreenSignal(null)
  }
})
