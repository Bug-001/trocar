// test/netenv/topology-text.test.mjs — the words of the topology (RFC 1.6 §9.2): the compact line of each branch (V41), the hop-per-line detail of `status <harness>`, the way out of trocar (V45), a hop that could not
// be read (V42) and the rule that the text is rendered from the topology object and from nothing else (V43). The facts are test/netenv/fixtures/rows.mjs's; nothing here reads the machine.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTopology, renderCompact, renderDetail, verdictText, firstHopAfterTrocar, firstHopOff, hopKey } from '../../src/netenv/topology.mjs'
import { ROWS, squash, withoutVpn } from './fixtures/rows.mjs'

for (const row of ROWS) {
  test(`V41 row ${row.n} (text): the compact line of each branch is the chain of the spec's table`, () => {
    assert.deepEqual(renderCompact(buildTopology(row.facts)[row.h]).map(squash), row.compact.map(squash))
  })
}

test('V45: with trocar on the path, the first hop after trocar is the first hop of the same branch with trocar taken out (the route out is unchanged); the rows that say egress-differs are the ones where it is not', () => {
  let seen = 0
  for (const row of ROWS.filter((r) => r.on_path === true && !r.findings.includes('egress-differs'))) {
    const t = buildTopology(row.facts)[row.h]
    for (const b of t.branches) {
      if (!firstHopAfterTrocar(t, b)) continue // the kernel is not running: the chain ends at trocar, there is no hop after it to compare
      seen++
      assert.equal(hopKey(firstHopAfterTrocar(t, b)), hopKey(firstHopOff(t, b)), `row ${row.n} ${b.name}`)
      assert.ok(hopKey(firstHopOff(t, b)))
    }
  }
  assert.ok(seen >= 8, 'it looked at the rows that have trocar on the path')
  // Codex with the OS proxy on (row 9): HTTP follows it either way, the WebSocket used to go direct and now goes through the OS proxy
  const t = buildTopology(ROWS.find((r) => r.n === 9).facts).codex, [http, ws] = t.branches
  assert.equal(hopKey(firstHopAfterTrocar(t, http)), hopKey(firstHopOff(t, http)))
  assert.notEqual(hopKey(firstHopAfterTrocar(t, ws)), hopKey(firstHopOff(t, ws)))
  // and the check can fail: a branch whose upstream is not the route the agent had
  const t2 = buildTopology(ROWS.find((r) => r.n === 2).facts)['claude-code'], b = structuredClone(t2.branches[0])
  b.path = [b.path[0], b.path[1], b.path[3]]
  assert.notEqual(hopKey(firstHopAfterTrocar(t2, b)), hopKey(firstHopOff(t2, b)))
})

test('V45/D49: `status <h>` says what a per-process VPN / proxy sees whenever trocar is on the path, product found or not; the line is about the source of the connection, nothing of the VPN\'s rules', () => {
  const row = ROWS.find((r) => r.n === 2)
  const text = (f, h = row.h) => renderDetail(buildTopology(f)[h]).join('\n')
  const line = '  If your VPN or proxy routes by process, it sees trocar, not claude-code.'
  assert.ok(text(row.facts).split('\n').includes(line))
  assert.ok(text(withoutVpn(row.facts)).split('\n').includes(line), 'no product to find: the line is the same')
  assert.ok(text(ROWS.find((r) => r.n === 1).facts).split('\n').includes(line), 'and with no proxy at all')
  const off = ROWS.find((r) => r.n === 4)
  assert.doesNotMatch(text(off.facts), /it sees trocar/, 'trocar is not on the path: the line would be untrue')
})

test('renderDetail (§3.5): the Routes block, a chain to a line, the path with trocar taken out and how to change the proxy; renderCompact adds the HTTP / WebSocket words only when there are two branches', () => {
  const row = ROWS.find((r) => r.n === 2)
  const lines = renderDetail(buildTopology(row.facts)['claude-code'])
  assert.equal(lines[0], '  Routes')
  assert.ok(lines.some((l) => /^ +pid 4121/.test(l)), lines.join('\n')) // its branch is drawn from that process (1.6 A.1)
  assert.ok(lines.join('\n').includes('claude (pid 4121) -> trocar :47123 -> mihomo :7890 (pid 777) -> internet'))
  assert.ok(lines.some((l) => /^ +without trocar +claude \(pid 4121\) -> mihomo :7890 \(pid 777\) -> internet$/.test(l)), lines.join('\n'))
  assert.match(lines.at(-1), /^ {2}To change the proxy: edit claude-code's own settings/)
  const two = renderCompact(buildTopology(ROWS.find((r) => r.n === 22).facts).codex)
  assert.deepEqual(two.map((l) => l.split(' ')[0]), ['HTTP', 'WebSocket'])
  assert.equal(renderCompact(buildTopology(row.facts)['claude-code'])[0].startsWith('claude (pid 4121)'), true)
  assert.equal(verdictText({ on_path: true, captured: true, reason: null }), "on trocar's path: yes · captured: yes")
  assert.equal(verdictText({ on_path: false, captured: false, reason: 'desired-off' }), "on trocar's path: no · captured: no (desired-off)")
  assert.equal(verdictText({ on_path: null, captured: null, reason: null }), "on trocar's path: unknown · captured: unknown")
})

test('V42 (text): a hop that could not be read says `unknown: <reason>` in the compact line and in the detail, and no hop says "none"', () => {
  for (const [n, h, reason] of [[21, 'hermes', 'owner not known'], [22, 'codex', 'a PAC script trocar does not run']]) { // the reason in words, never the code (D58③)
    const t = buildTopology(ROWS.find((r) => r.n === n).facts)[h]
    for (const text of [renderCompact(t).join('\n'), renderDetail(t).join('\n')]) {
      assert.match(text, new RegExp(`unknown: ${reason}`), `row ${n}`)
      assert.doesNotMatch(text, /(^|\s)(none|无)(\s|$)/)
    }
  }
})

test('V42 (text): a proxy hop always has its port — a hop named by its process too, in the compact line and the detail (the pid after it) — and a hop already named host:port says the port once', () => {
  const script = buildTopology(ROWS.find((r) => r.n === 24).facts)['claude-code']
  assert.match(renderCompact(script)[0], /\[CONNECT passed on as it is\] node :38743 -> internet$/)
  assert.ok(renderDetail(script).join('\n').includes('node :38743 (pid 898)'), renderDetail(script).join('\n'))
  const unreadable = buildTopology(ROWS.find((r) => r.n === 21).facts).hermes
  assert.ok(renderCompact(unreadable)[0].includes('127.0.0.1:7891 (unknown'), 'named by its address: the port is not said twice')
  assert.ok(!renderCompact(unreadable)[0].includes('7891:7891') && !/:7891 :7891/.test(renderCompact(unreadable)[0]))
})

test('V43 (text): every hop of the compact line is a node of the object it was drawn from', () => {
  for (const row of ROWS) {
    const t = buildTopology(row.facts)[row.h]
    const seen = [], ways = t.branches.filter((b) => !seen.includes(b.path.join()) && seen.push(b.path.join())) // branches that take the same path are one line
    assert.equal(renderCompact(t).length, ways.length, `row ${row.n}: one line for each way`)
    ways.forEach((b, i) => {
      const hops = renderCompact(t)[i].replace(/^(HTTP|WebSocket) /, '').split(' -> ').map((x) => x.replace(/^\[[^\]]*\] /, ''))
      const path = b.path.filter((id, k) => !(k && t.nodes.find((x) => x.id === id).trocar && t.nodes.find((x) => x.id === b.path[k - 1]).trocar)) // trocar's door and engine are one hop (D47)
      assert.equal(hops.length, path.length, `row ${row.n}: one hop for each node`)
      hops.forEach((hop, k) => { const n = t.nodes.find((x) => x.id === path[k]); assert.ok(n.unknown && n.kind === 'egress' ? hop === 'unknown' : hop.includes(n.kind === 'egress' ? 'internet' : n.name), `row ${row.n}: ${hop} ~ ${n.name}`) })
    })
  }
})

test('renderDetail in proxy mode: the way out says HTTP and WebSocket apart when they differ, the entry says who wrote it, the notes come after the processes, and the per-process VPN line is there once', () => {
  const t = buildTopology(ROWS.find((r) => r.n === 9).facts).codex
  const lines = renderDetail(t)
  assert.equal(lines[0], '  Routes')
  assert.equal(lines.filter((l) => /^ +pid 5530/.test(l)).length, 1, 'HTTP and WebSocket take the same path with trocar: one row')
  assert.ok(lines.join('\n').includes('codex app-server (pid 5530) -> trocar :17992 -> verge-mihomo.exe :7897 (pid 11800) -> internet'))
  assert.ok(lines.some((l) => /^ +without trocar \(HTTP\)/.test(l)), 'the way out differs per branch: HTTP is said apart')
  assert.ok(lines.join('\n').includes('codex app-server (pid 5530) -> verge-mihomo.exe :7897 (pid 11800) -> internet'))
  assert.equal(lines.filter((l) => /it sees trocar/.test(l)).length, 1)
  assert.match(lines.at(-1), /^ {2}To change the proxy: edit codex's own settings, then run: trocar on codex/)
  const off = renderDetail(buildTopology(ROWS.find((r) => r.n === 14).facts).codex)
  assert.ok(off.includes('    note: 1 process(es) are still connected through trocar, forwarded only; trocar exits once they do'), off.join('\n'))
  assert.ok(off.some((l) => /it sees trocar/.test(l)), 'the kernel still forwards for the agent that is connected: a VPN still sees trocar')
})
