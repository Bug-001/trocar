// test/web/retention-view.test.mjs — the board's 「保存什么」 view and the D40 pieces of the detail panel, in the real board script under a DOM stub
// (RFC 2.6 §D 验收 #7, 4.4 #15 / #16, 1.5 状态矩阵, 3.2 K7 · 不变式 4). Playwright is not installed here, so this is the DOM-level check: what the
// page writes into #timeline / #ledger / #detail, and what a click on a switch sends. The payload is the REAL one: retentionReport() over a store built
// from the D40 fixture records, so the wire contract between the server and the page is pinned end to end.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runEtl } from '../../src/etl/orchestrator.mjs'
import { retentionReport } from '../../src/query/retention.mjs'
import { setRetention } from '../../src/capture/retention.mjs'
import { controlRecordWire } from '../../src/view/control-wire.mjs'
import { freshConn } from '../etl/helpers.mjs'
import { tmpDir } from '../raw/helpers.mjs'
import { El } from '../helpers/frontend.mjs'
import { full, logged, preD40, sized, inference } from '../fixtures/d40-records.mjs'

const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'web', 'index.html')
const NOW = Date.parse('2026-10-07T12:00:00.000Z')
const CODEX = { pid: 7, exe: '/x/codex', agent: 'codex' }

// ── the payload: a real report over a store of hand-built records (new fixtures; nothing captured is read)
async function payload({ control = true, withStore = true, ratio = null } = {}) {
  const home = tmpDir('asight-retview-')
  setRetention({ file: path.join(home, 'retention.json'), logFile: path.join(home, 'logs', 'retention.ndjson'), harness: 'cc', class: 'telemetry', level: 'log', source: 'cli', harnesses: ['cc', 'codex', 'unknown'], now: () => new Date('2026-10-07T11:00:00Z') })
  let conn = null
  if (withStore) {
    conn = await freshConn()
    await runEtl([
      sized(full({ id: 'r1', at: '2026-10-07T11:00:00.000Z', cls: 'telemetry', reqBody: 'x', wire: [1000, 50] }), 1500),
      sized(logged({ id: 'r4', at: '2026-10-07T10:00:00.000Z', cls: 'telemetry', wire: [9000, 21] }), 700),
      sized(preD40({ id: 'r5', at: '2026-10-07T09:00:00.000Z', rawChars: 321 }), 400),
      sized(full({ id: 'r2', at: '2026-09-01T12:00:00.000Z', cls: 'telemetry', reqBody: 'x', wire: [2000, 70] }), 2500),
      sized(inference({ id: 'r6', at: '2026-10-07T08:00:00.000Z', wire: [5000, 3000] }), 5600),
      sized(full({ id: 'r7', at: '2026-10-07T07:00:00.000Z', cls: 'files', proc: CODEX, host: 'chatgpt.com', reqBody: 'x', wire: [100, 4000], headers: { 'user-agent': 'codex_cli_rs/0.1' } }), 4300),
    ], conn)
  }
  const rep = await retentionReport({ home, conn, control, now: NOW })
  if (ratio != null && rep.sizes) { // an estimate needs sealed files to take a ratio from: pin one number, the way the report does
    rep.seal = { ...rep.seal, ratio, files: 2 }
    for (const r of rep.sizes.rows) for (const w of Object.values(r.windows)) w.sealed_estimate_bytes = Math.round(w.stored_bytes * ratio)
    for (const w of Object.values(rep.totals.all)) w.sealed_estimate_bytes = Math.round(w.stored_bytes * ratio)
  }
  return rep
}

// ── the page
let seq = 0
async function load({ report, status = 200, control = true, post = null, win = null, session = {} } = {}) {
  const store = {}, hits = [], lastQuery = {}
  const getEl = (id) => store[id] || (store[id] = (() => { const e = El(); let h = null; Object.defineProperty(e, 'onclick', { get: () => h, set: (v) => { h = v } }); return e })())
  // #timeline .lvl / .retwin button: parsed from what the page wrote, with the handlers the page assigned kept so the test can click
  const parseButtons = (html, cls) => [...html.matchAll(new RegExp(`<button\\b([^>]*)>([^<]*)</button>`, 'g'))].filter((m) => (cls === 'retwin' ? /\bdata-win=/ : new RegExp(`class="${cls}\\b`)).test(m[1])).map((m) => {
    const attrs = Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [k.replace(/^data-/, ''), v]))
    return { dataset: attrs, disabled: /\sdisabled(\s|$)/.test(m[1]) || m[1].trim().endsWith('disabled'), text: m[2], onclick: null }
  })
  Object.assign(globalThis, {
    document: { getElementById: getEl, querySelector() { return null }, addEventListener() {}, body: El(), documentElement: El(), createElement() { return El() },
      querySelectorAll(sel) { const m = /^#timeline \.(\w+)(?: button)?$/.exec(sel); if (!m) return []; const cls = m[1]; const list = parseButtons(getEl('timeline').innerHTML, cls); lastQuery[sel] = list; return list } },
    window: { addEventListener() {}, removeEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} } } },
    location: { reload() {}, href: '', search: '' },
    localStorage: { _m: win ? { 'asight.retWin': win } : {}, getItem(k) { return this._m[k] ?? null }, setItem(k, v) { this._m[k] = String(v) }, removeItem() {} },
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, requestAnimationFrame: () => 0, console: { ...console, error() {} },
    fetch: (url, init) => {
      const u = String(url); hits.push({ url: u, init })
      const ans = (s, b) => Promise.resolve({ ok: s >= 200 && s < 300, status: s, json: () => Promise.resolve(b) })
      if (u.startsWith('/api/retention')) return status === 200 ? ans(200, report) : status === 'reject' ? Promise.reject(new Error('connection refused')) : ans(status, { error: 'store trouble' })
      if (u.startsWith('/control/status')) return control ? ans(200, { csrf: 'tok-123' }) : ans(404, {})
      if (u.startsWith('/control/retention')) return post ? post(JSON.parse(init.body), init) : ans(200, { ok: true, changed: [{ harness: 'cc', class: 'telemetry', from: 'log', to: 'full' }] })
      if (u.startsWith('/api/session')) return ans(200, session)
      if (u.startsWith('/api/projects')) return ans(200, { projects: [{ slug: 'P', name: 'P', path: '/p', last_ts: 'T1', sessions: [{ project_slug: 'P', session_id: 'S', title: 'T', calls: 1, probes: 0, last_ts: 'T1' }] }] })
      return ans(200, {})
    },
  })
  const html = fs.readFileSync(INDEX, 'utf8')
  const js = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1]
  const tail = `\n;globalThis.__R__={poll,renderRetentionView,pollRetention,setRetentionLevel,openControlDetail,setCD(v){controlData=v},setSel(v){curSel=v},get retH(){return retH},get retMsg(){return retMsg}};\n//# retview-${++seq}\n`
  await import(`data:text/javascript;base64,${Buffer.from(js + tail).toString('base64')}`)
  await settle()
  return { M: globalThis.__R__, getEl, hits, lastQuery, tl: () => getEl('timeline').innerHTML, led: () => getEl('ledger').innerHTML }
}
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)) }
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ')
// the <td> of one (harness, class) cell, by its switch
const cellOf = (html, h, c) => { const i = html.indexOf(`data-h="${h}" data-c="${c}"`); assert.ok(i > 0, `no switch for ${h} · ${c}`); const s = html.lastIndexOf('<td', i), e = html.indexOf('</td>', i); return html.slice(s, e) }

async function shown(opts) { const t = await load(opts); t.M.setSel('__retention__'); await t.M.pollRetention(true); await settle(); return t }

test('2.6 #7 — the table: one row per harness, one column per class, the level of each cell as a switch, and the numbers of its (harness, class)', async () => {
  const rep = await payload()
  const t = await shown({ report: rep })
  const html = t.tl()
  for (const c of rep.classes) assert.ok(new RegExp(`<th>${c}</th>`).test(html), `a column for ${c}`)
  for (const h of rep.harnesses) assert.ok(html.includes(`<th>${h}</th>`), `a row for ${h}`)
  assert.deepEqual(rep.harnesses.sort(), ['cc', 'codex'], 'the harnesses are the ones the data and the settings name, not a list in the page')
  // cc · telemetry was set to log in the payload's settings: its switch says 只记日志 and offers 全部
  const ct = cellOf(html, 'cc', 'telemetry')
  assert.match(ct, /class="lvl log"[^>]*data-to="full"[^>]*>只记日志</)
  assert.match(text(ct), /3 条/, 'cc · telemetry: the full and the log calls of the window — the pre-D40 one is on its own row')
  assert.match(text(ct), /已存 · stored: 全部 2 条 · 只记日志 1 条/, 'a change reaches only the calls after it: a cell holding both says how many are kept each way, not just the switch\'s word')
  assert.doesNotMatch(text(cellOf(html, 'cc', 'llm')), /已存 · stored/, 'a cell whose calls were all kept as its switch says needs no split')
  // by-hand numbers: full r1+r2 (1000+2000 req, 50+70 resp) all window → 2 calls; the log row's 1 call is added to the cell
  assert.match(text(cellOf(html, 'codex', 'files')), /1 条 · 线上 4\.0 KiB|1 条 · 线上 4\.1 KiB/, 'codex · files: 100 + 4000 bytes on the wire')
  assert.match(cellOf(html, 'cc', 'llm'), /class="lvl full"[^>]*data-to="log"[^>]*>全部</)
  assert.match(text(cellOf(html, 'cc', 'llm')), /1 条 · 线上 7\.8 KiB/, '5000 + 3000')
  assert.match(html, /<th>合计 · total<\/th>/, 'a totals row and a totals column')
  assert.match(html, /改动只影响之后开始的调用;已存的数据不删/, 'what a change does and does not do is said on the page')
})

test('2.6 #7 / 4.1 #9 — pre-D40 records are a row of their own: 「D40 之前 · 只存了长度」, the request length they kept, the response size 「未记录」 (never a 0)', async () => {
  const t = await shown({ report: await payload() })
  const html = t.tl()
  const row = html.slice(html.indexOf('<tr class="legacy">'), html.indexOf('</tr>', html.indexOf('<tr class="legacy">')))
  assert.match(row, /D40 之前 · 只存了长度/)
  assert.match(text(row), /1 条 · 请求 321 B/)
  assert.match(text(row), /响应体 未记录/)
  assert.doesNotMatch(text(row), /响应体 0 B|线上 0 B/)
  // the legacy call is not in the cell of the harness/class it would have been, or the cell would count it twice
  assert.doesNotMatch(text(cellOf(html, 'cc', 'telemetry')), /321 B/)
})

test('2.6 #7 — an empty or missing store shows 「需要先跑 asight etl」 in the cells, not a table of zeros', async () => {
  const t = await shown({ report: await payload({ withStore: false }) })
  const html = t.tl()
  assert.match(cellOf(html, 'cc', 'telemetry'), /需要先跑 asight etl/)
  assert.doesNotMatch(text(cellOf(html, 'cc', 'telemetry')), /\b0 条|0 B/, 'no zero stands in for "unknown"')
  assert.match(html, /there is no analytics store|需要先跑 asight etl/)
  assert.match(t.led(), /需要先跑 asight etl/)
  assert.ok(!html.includes('class="legacy"'), 'no legacy row without sizes')
  // the switches still work from the settings alone: levels do not need the store
  assert.match(cellOf(html, 'cc', 'telemetry'), /class="lvl log"/)
})

test('2.6 #7 — every number says where it comes from: the per-class ones are 「as of the last asight etl」, the disk total is live, once-sealed sizes are 估计', async () => {
  const rep = await payload({ ratio: 0.25 })
  const t = await shown({ report: rep })
  const html = t.tl(), led = t.led()
  assert.match(text(cellOf(html, 'cc', 'llm')), /封存后 ≈1\.4 KiB 估计/, '5600 stored × 0.25')
  assert.match(html, /估计/)
  assert.match(html, /one global number, so only an <b>估计<\/b> for any one class/)
  assert.match(led, /按类数字截至 2026-10-07 11:00:00（?\(?上次|截至 2026-10-07 11:00:00/)
  assert.match(led, /as of the last ETL, not live/)
  assert.match(text(led), /~\/\.asight 盘上占用/)
  assert.match(led, /lstat file sizes, live/)
  assert.match(led, /封存比 · seal ratio 0\.250 over 2 sealed file\(s\) — 估计 only/)
  // and without sealed files there is no estimate, and the page says that instead of inventing a ratio
  const none = await shown({ report: await payload() })
  assert.doesNotMatch(none.tl(), /封存后 ≈/)
  assert.match(none.led(), /没有可读的封存文件 · no readable sealed file: no once-sealed estimate/)
})

test('2.6 #7 — the 24 h / 7 d / all window buttons change the numbers, and the choice is remembered (localStorage, in try/catch)', async () => {
  const t = await shown({ report: await payload() })
  const all = text(cellOf(t.tl(), 'cc', 'telemetry'))
  assert.match(t.tl(), /<button data-win="all" class="on">/)
  const btns = t.lastQuery['#timeline .retwin button']
  assert.deepEqual(btns.map((b) => b.dataset.win), ['24h', '7d', 'all'])
  btns.find((b) => b.dataset.win === '24h').onclick()
  const day = text(cellOf(t.tl(), 'cc', 'telemetry'))
  assert.notEqual(day, all, 'the 24 h numbers are not the all-time ones: r2 (September) has left the window')
  assert.match(t.tl(), /<button data-win="24h" class="on">/)
  assert.equal(globalThis.localStorage.getItem('asight.retWin'), '24h')
  // a reload starts on the remembered window
  const again = await shown({ report: await payload(), win: '7d' })
  assert.match(again.tl(), /<button data-win="7d" class="on">/)
})

test('2.6 #7 — without the control plane the switches are greyed, and the page shows the command to run instead (the opt-in control plane is D26)', async () => {
  const t = await shown({ report: await payload({ control: false }) })
  const html = t.tl()
  assert.match(cellOf(html, 'cc', 'llm'), /<button[^>]*class="lvl full"[^>]*disabled/)
  assert.match(cellOf(html, 'cc', 'llm'), /asight keep cc llm log/, 'the command for the click that cannot be made, on the cell')
  assert.match(html, /控制面没开 · the control plane is off/)
  assert.match(html, /asight serve --control/)
  const btn = t.lastQuery['#timeline .lvl'].find((b) => b.dataset.h === 'cc' && b.dataset.c === 'llm')
  assert.equal(btn.disabled, true)
  t.hits.length = 0
  if (btn.onclick) btn.onclick() // a click on it does nothing
  await settle()
  assert.equal(t.hits.filter((h) => h.url.startsWith('/control/')).length, 0)
})

test('2.6 #7 / D26 — a click reads the CSRF token, then POSTs the cell to /control/retention with the token in x-asight-csrf; the page re-reads and says what changed and what did not', async () => {
  let posted = null
  const t = await shown({ report: await payload(), post: (body, init) => { posted = { body, headers: init.headers, method: init.method }; return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, changed: [{ harness: 'cc', class: 'llm', from: 'full', to: 'log' }] }) }) } })
  const btn = t.lastQuery['#timeline .lvl'].find((b) => b.dataset.h === 'cc' && b.dataset.c === 'llm')
  assert.equal(btn.dataset.to, 'log')
  t.hits.length = 0
  btn.onclick()
  await settle()
  assert.deepEqual(t.hits.map((h) => h.url.split('?')[0]).slice(0, 2), ['/control/status', '/control/retention'], 'the token first, then the write')
  assert.equal(posted.method, 'POST')
  assert.equal(posted.headers['x-asight-csrf'], 'tok-123')
  assert.deepEqual(posted.body, { harness: 'cc', class: 'llm', level: 'log' })
  assert.ok(t.hits.some((h) => h.url.startsWith('/api/retention')), 'then the table is read again: it shows what the server holds, not what the click assumed')
  assert.match(text(t.tl()), /cc · llm: 全部 → 只记日志 — applies to the calls that start from now on/)
  assert.match(text(t.tl()), /what is already stored is not changed/)
})

test('2.6 #7 — a refused change says why in the page and changes nothing there: no silent success', async () => {
  const t = await shown({ report: await payload(), post: () => Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ error: 'retention.json cannot be parsed (Unexpected token); fix or remove it first, nothing was changed' }) }) })
  const btn = t.lastQuery['#timeline .lvl'].find((b) => b.dataset.h === 'cc' && b.dataset.c === 'llm')
  btn.onclick(); await settle()
  assert.match(text(t.tl()), /could not change cc · llm: retention\.json cannot be parsed .* nothing was changed/)
  assert.match(t.tl(), /class="retmsg err"/)
  assert.match(cellOf(t.tl(), 'cc', 'llm'), /class="lvl full"/, 'the switch still shows what the server holds')
  // control plane off at click time (the page was loaded when it was on): the 404 is said, not swallowed
  const off = await shown({ report: await payload(), control: false })
  await off.M.setRetentionLevel('cc', 'llm', 'log')
  assert.match(text(off.tl()), /could not change cc · llm: the control plane is off \(HTTP 404\)/)
})

test('1.5 — a settings file with a problem is a banner that says both capture paths keep everything; a payload that cannot be read is an error, not an empty table', async () => {
  const rep = await payload()
  rep.settings = { ...rep.settings, ok: false, problems: [{ reason: 'levels.cc.llm: "partial" is not full or log' }] }
  const t = await shown({ report: rep })
  assert.match(text(t.tl()), /设置文件读不出 .* levels\.cc\.llm: "partial" is not full or log .* keep everything in full/)
  const bad = await load({ report: null, status: 500 })
  bad.M.setSel('__retention__'); bad.M.renderRetentionView(); await settle(); await bad.M.pollRetention(true)
  assert.match(text(bad.tl()), /保存什么 could not be read — store trouble/)
  assert.doesNotMatch(bad.tl(), /<table/)
  const down = await load({ report: null, status: 'reject' }); down.M.setSel('__retention__'); down.M.renderRetentionView(); await settle(); await down.M.pollRetention(true)
  assert.match(text(down.tl()), /could not be read — connection refused/)
})

test('2.6 #7 — the ledger lists the recent changes (who changed what, from the log) and the disk groups', async () => {
  const t = await shown({ report: await payload() })
  assert.match(text(t.led()), /最近的修改 · recent changes 1/)
  assert.match(text(t.led()), /cc · telemetry 全部 → 只记日志/)
  assert.match(t.led(), /cli/, 'the source of the change is shown')
  for (const g of ['采集文件 · captures', '封存文件 · sealed', 'DuckDB', '日志 · logs']) assert.ok(t.led().includes(g), g)
})

test('the session list offers 「保存什么」 next to control and capture health, and choosing it renders the view (it is not a session)', async () => {
  const t = await load({ report: await payload() })
  t.M.setSel('__retention__')
  await t.M.poll(); await settle()
  assert.match(t.getEl('fileSel').innerHTML, /<option value="__retention__">保存什么 · what is kept<\/option>/)
  assert.match(t.tl(), /<th>cc<\/th>/)
  assert.match(t.getEl('agentChip').textContent, /保存什么/)
})

test('invariant 3 — the view names no host, endpoint or provider: harnesses and classes come from the payload', () => {
  const html = fs.readFileSync(INDEX, 'utf8')
  const a = html.indexOf('// ── D40 保存什么'), b = html.indexOf('// ── D38 capture health')
  assert.ok(a > 0 && b > a, 'the retention block is where the test looks for it')
  const block = html.slice(a, b)
  assert.doesNotMatch(block, /anthropic|openai|deepseek|moonshot|chatgpt|claude\.ai|codex|\bcc\b'|'cc'|dsh/i)
})

// ── the detail panel, over what /api/control ships (controlRecordWire is the server half)
const ctlOf = (rec) => controlRecordWire(rec)
async function detail(rec) {
  const t = await load({ report: await payload() })
  t.M.setCD({ other: [ctlOf(rec)] })
  t.M.openControlDetail('other', 0)
  return t.getEl('detail').innerHTML
}

test('2.6 #5 — a verbatim non-LLM request body is shown as stored, unfoldable, with its wire size; nothing is called 非逐字 or 「not decoded」', async () => {
  const body = '{"events":[{"name":"tengu_start","note":"héllo"}]}'
  const html = await detail(full({ id: 'a', reqBody: body, wire: [Buffer.byteLength(body), 12] }))
  assert.ok(html.includes(body.replace(/"/g, '&quot;')) || html.includes(body), 'the body text is in the panel')
  assert.match(html, /request body · \d+ bytes/)
  assert.doesNotMatch(html, /非逐字|only the length|只存了长度|not decoded|isn't decoded/)
})

test('2.6 #5 — a binary body is shown as a hex dump with its size; a non-LLM SSE reply as its raw text; JSON replies are marked as stored', async () => {
  const bin = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x41])
  let html = await detail(full({ id: 'b', reqBody: null, reqB64: bin.toString('base64'), wire: [bin.length, 3], cls: 'files' }))
  assert.match(html, /二进制 · 7 字节 · 逐字存为 base64/)
  assert.match(html, /50 4b 03 04 ff 00 41/)
  const sse = 'event: ping\ndata: {"t":1}\n\n'
  html = await detail(full({ id: 's', cls: 'session-sync', resp: { status: 200, kind: 'sse', raw: sse, text: '', tool_calls: [] }, wire: [5, sse.length] }))
  assert.match(html, /event: ping/)
  assert.match(html, /response body/)
  html = await detail(full({ id: 'j' }))
  assert.match(html, /response body \(JSON, as stored\)/)
})

test('2.6 #5 — a body cut for display says how much is shown of how much there is, and where the rest is', async () => {
  const big = 'a'.repeat((1 << 20) + 500)
  const html = await detail(full({ id: 'big', reqBody: big, wire: [big.length, 0] }))
  assert.match(html, /已截断显示 · showing the first .* of .* chars/)
  assert.match(html, /the rest is intact in the source record/)
})

test('H4 — a request cut at the cap or never finished is shown as a prefix: 已截断 / 不完整, how much of how much is stored, and no 「逐字」 tag on it', async () => {
  let html = await detail(full({ id: 'c', endpoint: '/api/oauth/file_upload', cls: 'files', reqBody: 'x'.repeat(2000), wire: [100000000, 5], extra: { req_truncated: true, req_body_bytes: 2000 } }))
  assert.match(html, /已截断 · request cut at the cap/, 'the label')
  assert.match(html, /<b>已截断 · cut at the cap<\/b> · only the first 2\.0k of 100000k bytes is stored/)
  assert.match(html, /⟨前缀,不是完整的体 · prefix only/)
  assert.doesNotMatch(html, /⟨逐字/, 'the unfold tag does not call a prefix verbatim')
  html = await detail(full({ id: 'p', reqBody: 'y'.repeat(2000), wire: [2000, 5], extra: { req_partial: 'aborted' } }))
  assert.match(html, /不完整 · request never finished/)
  assert.match(html, /<b>不完整 · never finished<\/b> · only the first 2\.0k of 2\.0k bytes is stored/)
  assert.doesNotMatch(html, /⟨逐字/)
  html = await detail(full({ id: 'b', reqBody: null, reqB64: Buffer.alloc(64, 1).toString('base64'), wire: [5000, 5], extra: { req_truncated: true, req_body_bytes: 64 } }))
  assert.match(html, /二进制 · 前缀,不是完整的体/)
  assert.doesNotMatch(html, /逐字存为 base64/)
  // the complete body keeps its tag
  html = await detail(full({ id: 'ok', reqBody: 'z'.repeat(2000), wire: [2000, 5] }))
  assert.match(html, /⟨逐字 · /)
})

test('L1 — a pre-D40 GET with no body shows an empty body, not 「只存了长度 … this is not an empty body」', async () => {
  const html = await detail({ ...preD40({ id: 'g', rawChars: 0 }), method: 'GET' })
  assert.match(html, /request body: \(empty\)/)
  assert.doesNotMatch(html, /本条采于 D40 之前|not an empty body|length only/)
})

test('4.1 #9 — the host the bytes went to and the request\'s Host header are both shown, and a mismatch is flagged (a behaviour signal)', async () => {
  let html = await detail(full({ id: 'h1', host: 'api.example.test', headers: { 'user-agent': 'x', host: 'api.example.test:443' } }))
  assert.match(html, /host <b>api\.example\.test<\/b> · Host header <b>api\.example\.test:443<\/b>/)
  assert.doesNotMatch(html, /host ≠ Host/, 'same host, with or without the port: no flag')
  html = await detail(full({ id: 'h2', host: 'api.example.test', headers: { 'user-agent': 'x', host: 'other.example.test' } }))
  assert.match(html, /host ≠ Host/)
  html = await detail(preD40({ id: 'h3' }))
  assert.doesNotMatch(html, /host ≠ Host/, 'a pre-D40 record has no host field: nothing to compare, no false flag')
})

test('4.1 #9 / 不变式 4 — a pre-D40 record says 「本条采于 D40 之前,只存了长度」; a log-level one says 「只记日志」 and why; neither is an empty body', async () => {
  let html = await detail(preD40({ id: 'o', rawChars: 4321 }))
  assert.match(html, /本条采于 D40 之前,只存了长度/)
  assert.match(html, /非逐字 · 只存了长度 · length only · 4321 bytes/)
  assert.match(html, /this is not an empty body/)
  html = await detail(logged({ id: 'l', wire: [900, 12] }))
  assert.match(html, /只记日志/)
  assert.match(html, /length only/)
  assert.doesNotMatch(html, /本条采于 D40 之前/, 'a log-level call is not mislabelled as old')
})

test('3.2 K7 — a session whose calls were kept as log lines shows the count, the setting that did it and the newest ones; it is not 「no calls」', async () => {
  const session = {
    records: [], analyzed: { steps: [], lanes: [], stats: { calls: 0 }, unknown: null }, probes: { count: 0, series: [] }, meta: { session_id: 'S', harness: 'cc' }, truncated: null,
    logged: { count: 3, labels: ['只记日志 · you set llm to a log line (保存什么)'], items: [{ ts: '2026-10-06T00:00:00Z', endpoint: '/v1/messages', status: 200, request_bytes: 5000, response_bytes: 300 }] },
  }
  const t = await load({ report: await payload(), session })
  await t.M.poll(); await settle()
  const bar = t.getEl('loggedbar').innerHTML
  assert.match(bar, /只记日志 · <b>3<\/b> calls of this session were kept as a log line only/)
  assert.match(bar, /you set llm to a log line/)
  assert.match(bar, /This is not "no calls"/)
  assert.match(bar, /\/v1\/messages · 200/)
})
