// test/view/analyzer-facts.test.mjs — the analyzer's facts seam (RFC 4.3 §3 · §4): everything createAnalyzer reads of a record
// or block comes from blockFacts / callFacts, which the context projection persists (index/ctx, invariant 2: a deletable projection).
//   (a) the facts survive a JSON round trip, generated over block kinds;
//   (b) moving the reads changed no document: assembleSession over generated sessions equals, serialised, what the code before the
//       seam produced (that commit's src/ is taken from git into a temp dir and run beside this one).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { blockFacts, admitted } from '../../src/view/analyze.mjs'
import { assembleSession } from '../../src/view/assemble.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from '../query/big-session.mjs'
import { threadSession, record, replyOf } from '../helpers/cc-threads.mjs'

// the last commit before the facts seam: its fold is the expected one
const BEFORE = '1e323709edaae2b4cc30aae2af167e28d4c16ad5'
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// ── generated axes ─────────────────────────────────────────────────────────
const R = '<system-reminder>', RC = '</system-reminder>'
const TEXTS = ['', '   ', 'plain words', '  lead and trail \n', `${R}only a reminder${RC}`, `ask ${R}x${RC} more`, `before ${R}never closed`,
  `tail${RC} after close`, `a${RC}b ${R}c`, 'Base directory for this skill: /h/.claude/skills/pdf\nbody', `${R}see CLAUDE.md and MEMORY.md${RC}`,
  'see **https://example.com/a,** and http://localhost:8080/x and https://nohost', 'read src/a.mjs then src/a.mjs, b.json, response.json() and Node.js',
  'x'.repeat(250) + ' ' + 'y '.repeat(150), 'src/p.mjs '.repeat(500), Array.from({ length: 600 }, (_, i) => `d/f${i}.ts`).join('\n'),
  `<system-${R}x${RC}reminder> trick`, 'continued from a previous conversation', '<analysis>thinking</analysis>']
const INPUTS = [['Read', { file_path: '/w/a.mjs', offset: 10, limit: 20 }], ['Read', { file_path: '/w/b.mjs' }], ['Write', { file_path: '/w/c.md', content: 'x' }],
  ['Edit', { file_path: 'rel/d.ts' }], ['Bash', { command: 'cat /w/e.txt | head -5 && sed -n 1,9p /w/f.py' }], ['Glob', { pattern: '**/*.mjs' }],
  ['Grep', { pattern: 'foo', path: 'src' }], ['WebFetch', { url: 'https://example.com' }], ['WebSearch', { query: 'node streams' }],
  ['Skill', { skill: 'plugin:pdf' }], ['Agent', { description: 'scan', subagent_type: 'general', prompt: 'subagent task: count files in the repo please' }],
  ['mcp__fs__read', { x: 1 }], ['Other', undefined]]
const RESULTS = ['file a', ['src/x.mjs', 'src/x.mjs'].join('\n'), [{ type: 'text', text: 'one src/y.mjs' }, { type: 'image', source: { media_type: 'image/png' } }],
  { weird: true }, null, undefined]
function blocksOfAxes() {
  const out = TEXTS.map((text) => ({ type: 'text', text }))
  INPUTS.forEach(([name, input], i) => out.push({ type: 'tool_use', id: `tu_${i}`, name, input }))
  RESULTS.forEach((content, i) => out.push({ type: 'tool_result', tool_use_id: `tu_${i}`, content, ...(i % 2 ? { is_error: true } : {}) }))
  out.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }, { type: 'document', title: 'spec', source: { type: 'text' } },
    { type: 'thinking', thinking: 'hmm', signature: 's' }, { type: 'server_tool_use', id: 'st', name: 'web_search', input: {} }, { type: 'mystery', value: 3 })
  return out
}

// one Claude Code session over the axes: a main lane growing turn by turn, a subagent, a monitor, aux utilities, a compaction, failures
const SYSTEM = [{ type: 'text', text: 'You are Claude Code.' }]
const TOOLS = [{ name: 'Read', input_schema: {} }, { name: 'mcp__github__issues', input_schema: {} }, { name: 'mcp__x', input_schema: {} }]
function axesSession() {
  const recs = []
  let t = Date.parse('2026-10-21T00:00:00Z'), k = 0
  const ts = () => new Date((t += 1000)).toISOString()
  const json = (content, extra = {}) => ({ status: 200, kind: 'json', body: { content, usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 100 * k }, stop_reason: 'end_turn', ...extra } })
  const call = (body, resp, headers) => recs.push(record(`r${String(++k).padStart(3, '0')}`, ts(), { model: 'claude-opus-x', max_tokens: 1000, ...body }, resp, headers))
  const blocks = blocksOfAxes()
  const msgs = []
  // each turn: a user message of a few axis blocks (string content now and then), the reply as an assistant message
  for (let i = 0; i < blocks.length; i += 3) {
    const part = blocks.slice(i, i + 3)
    const user = i % 9 === 6 ? { role: 'user', content: TEXTS[(i / 3) % TEXTS.length] } : { role: 'user', content: part.filter((b) => b.type !== 'tool_use') }
    const said = part.filter((b) => b.type === 'tool_use')
    msgs.push(user)
    const reply = [{ type: 'text', text: TEXTS[(i / 3 + 4) % TEXTS.length] || 'ok' }, ...said]
    call({ system: SYSTEM, tools: TOOLS, messages: [...msgs] }, i % 2 ? replyOf(`m${i}`, reply) : json(reply, i % 4 ? {} : { content: [{ type: 'thinking', thinking: 'deep\n thought' }, ...reply] }))
    msgs.push({ role: 'assistant', content: reply })
    if (i === 12) call({ system: [{ type: 'text', text: 'You are a security monitor.' }], messages: [{ role: 'user', content: '<transcript>x</transcript>' }] }, json([{ type: 'text', text: '<block>no</block>' }]))
    if (i === 15) call({ system: SYSTEM, messages: [{ role: 'user', content: 'quota' }], max_tokens: 1 }, json([{ type: 'text', text: '' }]))
    if (i === 18) call({ system: SYSTEM, messages: [{ role: 'user', content: 'give a 2-4 word lowercase label for this job' }] }, json([{ type: 'text', text: 'fix tests' }]))
    if (i === 21) call({ system: [{ type: 'text', text: 'cc_is_subagent=true' }], tools: TOOLS, messages: [{ role: 'user', content: [{ type: 'text', text: `${R}r${RC}subagent task: count files in the repo please` }, ...part] }] }, json([{ type: 'text', text: 'two src/z.mjs' }]))
    if (i === 24) call({ system: SYSTEM, messages: [...msgs] }, { status: 529, kind: 'json', body: { error: { message: 'overloaded' } } })
  }
  // reminders that open in one text block and close in a later one, the join's whitespace on either side or none
  const said = (...xs) => ({ role: 'user', content: xs.map((text) => ({ type: 'text', text })) })
  msgs.push(said(`one${R}open`, 'mid', `two${RC} three`), { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    said(`four ${R}`, `${RC}five`, ` ${R}never`), { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, said(`${R}a`, 'b', `c${RC}`, '  '))
  call({ system: SYSTEM, tools: TOOLS, messages: [...msgs] }, json([{ type: 'text', text: 'ok' }]))
  // a compaction: CC's preamble on a much shorter context, then a summarising reply, then a request that never parsed
  call({ system: SYSTEM, tools: TOOLS, messages: [{ role: 'user', content: 'This session is being continued from a previous conversation. src/q.mjs' }] }, json([{ type: 'text', text: '<analysis>a</analysis> summary' }]))
  recs.push({ ...record(`r${String(++k).padStart(3, '0')}`, ts(), {}, json([])), req_body: '{"model":"claude-opus-x","messages":[{"ro' })
  return recs
}

function bigRecords(wire) {
  const home = tmpDir('trocar-facts-big-')
  const s = bigSession({ home, wire, growth: 1_200, subEvery: 3, subLanes: 2, compactAt: 12_000, preamble: 'Shared workflow notes in src/wf.mjs.' })
  s.append(40)
  return fs.readFileSync(s.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}
const threadRecords = () => { const t = threadSession(); return [t.M0, t.S0, t.M1, t.S1, t.A, t.M2] }

// ── (a) ─────────────────────────────────────────────────────────────────────
// the board's own reading of a stored body (v0 shape: `.request` parsed, its counts beside it), a stitched context left out
function v0(r) {
  let body
  try { body = JSON.parse(r.req_body) } catch { return r }
  const messages = Array.isArray(body.messages) ? body.messages : []
  return { ...r, request: { ...body, messages, message_count: messages.length, tool_count: (body.tools || []).length } }
}
const roundTrips = (x, what) => assert.deepStrictEqual(JSON.parse(JSON.stringify(x)), x, `${what} does not survive JSON`)

test('(a) blockFacts survive a JSON round trip, over every block kind and call shape', () => {
  for (const b of blocksOfAxes()) roundTrips(blockFacts(b), `blockFacts of ${b.type}`)
  const recs = [...axesSession(), ...bigRecords('http'), ...bigRecords('threads'), ...threadRecords()]
  for (const r of recs) {
    const h = admitted(v0(r))
    for (const m of h.request.messages) for (const b of Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }]) roundTrips(blockFacts(b), `a block of ${r.id}`)
  }
})

// ── (b) ─────────────────────────────────────────────────────────────────────
async function beforeFold() {
  const dir = tmpDir('trocar-facts-before-')
  const tar = execFileSync('git', ['-C', REPO, 'archive', '--format=tar', BEFORE, 'src'], { maxBuffer: 256 * 1048576 })
  execFileSync('tar', ['-x', '-C', dir], { input: tar })
  return import(pathToFileURL(path.join(dir, 'src/view/assemble.mjs')).href)
}
const doc = (fn, recs) => JSON.stringify(fn(structuredClone(recs)))

test('(b) the session document is the one the fold gave before the seam, on generated sessions', async () => {
  const before = await beforeFold()
  const cases = { axes: axesSession(), threads: threadRecords(), ...Object.fromEntries(['http', 'threads', 'ws', 'chat'].map((w) => [`big-${w}`, bigRecords(w)])) }
  for (const [name, recs] of Object.entries(cases)) {
    const want = doc(before.assembleSession, recs), got = doc(assembleSession, recs)
    if (got === want) continue
    let i = 0
    while (got[i] === want[i]) i++
    assert.fail(`${name}: documents differ at ${i}\n  before …${want.slice(Math.max(0, i - 200), i + 200)}\n  now    …${got.slice(Math.max(0, i - 200), i + 200)}`)
  }
})
