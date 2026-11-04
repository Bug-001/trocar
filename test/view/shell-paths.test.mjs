// test/view/shell-paths.test.mjs — 2.4 保真边界 item 6, the fold half: one resolved shell read names the ledger entry and the block's
// `file::` key. Claude Code shaped records go through the named queries (extraction → persisted facts → reduction → documents).
import test from 'node:test'
import assert from 'node:assert/strict'
import { homeWith, query } from '../helpers/session-doc.mjs'

const T = Date.parse('2026-10-21T08:00:00Z')
const TOOLS = ['Read', 'Bash'].map((name) => ({ name, description: name, input_schema: { type: 'object', properties: {} } }))
const use = (id, name, input) => ({ type: 'tool_use', id, name, input })
const answer = (id) => ({ type: 'tool_result', tool_use_id: id, content: 'bytes' })
const bash = (id, command) => use(id, 'Bash', { command })

// One lane: each tool use a call that issues it in its reply, the next call answering it.
function lane(uses, { exe = '/opt/bin/claude' } = {}) {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'Go on' }] }], recs = []
  const call = (i, content) => {
    const at = new Date(T + i * 1000).toISOString()
    recs.push({ ts_request: at, ts: at, id: `r${i}`, endpoint: '/v1/messages', host: 'api.anthropic.com', proc: { pid: 1, exe, agent: 'claude-code' },
      req_headers: { host: 'api.anthropic.com', 'content-type': 'application/json', 'user-agent': 'claude-cli/2.0.0 (external, cli)', 'x-claude-code-session-id': 'S' },
      req_body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 32000, system: [{ type: 'text', text: 'You are a coding agent.' }], tools: TOOLS, messages }),
      resp: { status: 200, kind: 'json', body: { id: `msg_${i}`, model: 'claude-opus-4-8', stop_reason: 'tool_use', content, usage: { input_tokens: 1, output_tokens: 1 } } } })
  }
  uses.forEach((u, i) => {
    call(i, [u])
    messages.push({ role: 'assistant', content: [u] }, { role: 'user', content: [answer(u.id)] })
  })
  call(uses.length, [{ type: 'text', text: 'done' }])
  return recs
}

// the file entries of the lane's ledger and the tool uses' keys, by tool use id
async function read(recs) {
  const home = homeWith(recs), { lanes } = await query(home, 'session', { id: 'S' })
  const doc = await query(home, 'lane', { id: 'S', lane: lanes.find((l) => l.kind === 'main').lane })
  const uses = doc.defs.filter((d) => d.kind === 'tool_use')
  return { files: doc.resources.filter((r) => r.kind === 'file'), uses, doc }
}
const keyOf = (r) => `${r.kind}::${r.label}`
const keysOf = (uses) => [...new Set(uses.map((d) => d.resKey))] // a tool use is a block of the reply and of the next request

const spellings = (file, dir, name, root) => [
  `P=${file}; cat $P`,
  `export P=${file}; head -n 3 "$P"`,
  `cd ${dir} && cat ${name}`,
  `for f in ${file}; do cat $f; done`,
  `cat ~/${root}`,
  `cat $HOME/${root}`,
]

for (const home of ['/Users/u', '/home/u']) {
  test(`every spelling of a file under ${home} is one entry, a Read of it too, and that entry's key is every block's`, async () => {
    const file = `${home}/p/a.txt`, cmds = spellings(file, `${home}/p`, 'a.txt', 'p/a.txt')
    const { files, uses } = await read(lane([...cmds.map((c, i) => bash(`t${i}`, c)), use('tr', 'Read', { file_path: file })], { exe: `${home}/.local/bin/claude` }))
    assert.deepEqual(files.map((r) => [r.label, r.runtime]), [[file, undefined]])
    assert.deepEqual(keysOf(uses), [keyOf(files[0])])
  })
}

for (const exe of ['/opt/bin/claude', '/nix/store/x-claude/bin/claude', 'C:\\Program Files\\claude\\claude.exe'])
  test(`a home not told by ${exe}: ~ and $HOME are one entry, the path as ~ spells it`, async () => {
    const { files, uses } = await read(lane([bash('t0', 'cat ~/p/a.txt'), bash('t1', 'cat $HOME/p/a.txt')], { exe }))
    assert.deepEqual(files.map((r) => r.label), ['~/p/a.txt'])
    assert.deepEqual(keysOf(uses), [keyOf(files[0])])
  })

test('a Windows home joins ~ and $HOME the same way', async () => {
  const { files, uses } = await read(lane([bash('t0', 'cat ~/p/a.txt'), bash('t1', 'cat $HOME/p/a.txt')], { exe: 'C:\\Users\\u\\bin\\claude.exe' }))
  assert.equal(files.length, 1)
  assert.ok(files[0].label.startsWith('C:\\Users\\u'), files[0].label)
  assert.deepEqual(keysOf(uses), [keyOf(files[0])])
})

for (const [command, word, runtime] of [
  ['cat $(git rev-parse --show-toplevel)/a.txt', '$(git rev-parse --show-toplevel)/a.txt', 'output'],
  ['while read f; do cat $f; done < list.txt', '$f', 'read'],
  ['cat $EARLIER/a.txt', '$EARLIER/a.txt', 'earlier'],
  ['cat src/a.txt', 'src/a.txt', 'cwd'],
])
  test(`a read the run settles keeps the command's word: ${runtime}`, async () => {
    const { files, uses } = await read(lane([bash('t0', command)]))
    assert.deepEqual(files.map((r) => [r.label, r.runtime]), [[word, runtime]])
    assert.deepEqual(keysOf(uses), [`file::${word}`])
  })

// 2.4 #11, several files in one block. The names are out of order on purpose: the ledger sorts by key, a block keeps the command's order.
const FILES = ['/w/p/z.txt', '/w/p/a.txt', '/w/p/m.txt', '/w/p/c.txt']
const READS = {
  cat: (f) => `cat ${f.join(' ')}`,
  head: (f) => `head -n 3 ${f.join(' ')}`,
  'a cat each': (f) => f.map((x) => `cat ${x}`).join('; '),
  for: (f) => `for f in ${f.join(' ')}; do cat $f; done`,
  grep: (f) => `grep x ${f.join(' ')}`,
}
// every position's attributes with the block there, the lists rebuilt from the steps' ops (3.5 §会话读)
function placed(doc) {
  const out = []
  let list = []
  for (const s of doc.steps) {
    list = s.ops.flatMap((o) => (o[0] === 0 ? list.slice(o[1], o[1] + o[2]) : o.slice(1)))
    for (const [at, a] of Object.entries(s.attrs)) out.push([list[at], a])
  }
  return out
}
for (const [how, spell] of Object.entries(READS))
  for (const n of [2, 3, 4])
    test(`a block reading ${n} files by ${how} carries every key, the size stays one total`, async () => {
      const files = FILES.slice(0, n), keys = files.map((f) => `file::${f}`)
      const { files: entries, uses, doc } = await read(lane([bash('t0', spell(files))]))
      assert.deepEqual(entries.map(keyOf).sort(), [...keys].sort())
      for (const d of uses) {
        assert.deepEqual(d.resKeys, keys)
        assert.equal(d.resKey, keys[0])
      }
      const [result, ...others] = doc.defs.filter((d) => d.kind === 'tool_result')
      assert.equal(others.length, 0)
      assert.equal(typeof result.chars, 'number')
      assert.equal(typeof result.bytes, 'number')
      assert.ok(!('resKey' in result) && !('resKeys' in result))
      assert.deepEqual(placed(doc).filter(([bid]) => bid === result.bid).map(([, a]) => a.resKeys), [keys])
    })

for (const command of ['cat /w/p/a.txt', 'head -n 3 /w/p/a.txt', 'cat /w/p/a.txt /w/p/a.txt', 'cat /w/p/a.txt; cat /w/p/a.txt', 'P=/w/p/a.txt; cat $P /w/p/a.txt'])
  test(`one file read by ${command} has one key and no resKeys`, async () => {
    const { uses, doc } = await read(lane([bash('t0', command)]))
    assert.deepEqual(keysOf(uses), ['file::/w/p/a.txt'])
    assert.ok(!doc.defs.some((d) => 'resKeys' in d))
    assert.ok(!placed(doc).some(([, a]) => 'resKeys' in a))
  })
