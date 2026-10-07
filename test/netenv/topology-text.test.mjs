// test/netenv/topology-text.test.mjs — the words of the topology (RFC 1.6 §9.2): the compact line of each branch (V41), the hop-per-line detail of `status <harness>`, the way out of asight (V45), a hop that could not
// be read (V42) and the rule that the text is rendered from the topology object and from nothing else (V43). The facts are test/netenv/fixtures/rows.mjs's; nothing here reads the machine.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTopology, renderCompact, renderDetail, verdictText, firstHopAfterAsight, firstHopOff, hopKey } from '../../src/netenv/topology.mjs'
import { ROWS, squash, withoutVpn } from './fixtures/rows.mjs'

for (const row of ROWS) {
  test(`V41 row ${row.n} (text): the compact line of each branch is the chain of the spec's table`, () => {
    assert.deepEqual(renderCompact(buildTopology(row.facts)[row.h]).map(squash), row.compact.map(squash))
  })
}

test('V45: with asight on the path, the first hop after asight is the first hop of the same branch with asight taken out (the route out is unchanged); the rows that say egress-differs are the ones where it is not', () => {
  let seen = 0
  for (const row of ROWS.filter((r) => r.on_path === true && !r.findings.includes('egress-differs'))) {
    const t = buildTopology(row.facts)[row.h]
    for (const b of t.branches) {
      if (!firstHopAfterAsight(t, b)) continue // the kernel is not running: the chain ends at asight, there is no hop after it to compare
      seen++
      assert.equal(hopKey(firstHopAfterAsight(t, b)), hopKey(firstHopOff(t, b)), `row ${row.n} ${b.name}`)
      assert.ok(hopKey(firstHopOff(t, b)))
    }
  }
  assert.ok(seen >= 8, 'it looked at the rows that have asight on the path')
  // Codex with the OS proxy on (row 9): HTTP follows it either way, the WebSocket used to go direct and now goes through the OS proxy
  const t = buildTopology(ROWS.find((r) => r.n === 9).facts).codex, [http, ws] = t.branches
  assert.equal(hopKey(firstHopAfterAsight(t, http)), hopKey(firstHopOff(t, http)))
  assert.notEqual(hopKey(firstHopAfterAsight(t, ws)), hopKey(firstHopOff(t, ws)))
  // and the check can fail: a branch whose upstream is not the route the agent had
  const t2 = buildTopology(ROWS.find((r) => r.n === 2).facts)['claude-code'], b = structuredClone(t2.branches[0])
  b.path = [b.path[0], b.path[1], b.path[3]]
  assert.notEqual(hopKey(firstHopAfterAsight(t2, b)), hopKey(firstHopOff(t2, b)))
})

test('V45: `status <h>` says what a VPN sees only when a VPN product was found and asight is on the path; the line is about the source of the connection, nothing of the VPN\'s rules', () => {
  const row = ROWS.find((r) => r.n === 2)
  const text = (f, h = row.h) => renderDetail(buildTopology(f)[h]).join('\n')
  assert.match(text(row.facts), /你的 VPN 按进程分流时,看到的来源是 asight,不是 claude-code/)
  assert.doesNotMatch(text(withoutVpn(row.facts)), /看到的来源是 asight/)
  const off = ROWS.find((r) => r.n === 4)
  assert.doesNotMatch(text(off.facts), /看到的来源是 asight/, 'asight is not on the path: the line would be untrue')
})

test('renderDetail: the header, a hop to a line with the edge words, the way out, the processes that go another way and how to change the proxy; renderCompact adds the HTTP / WebSocket words only when there are two branches', () => {
  const row = ROWS.find((r) => r.n === 2)
  const lines = renderDetail(buildTopology(row.facts)['claude-code'], { now: Date.parse('2026-10-07T10:02:24.000Z') })
  assert.equal(lines[0], 'claude-code · 开 · 驱动模式(eBPF) · 被采集: 是')
  assert.deepEqual(lines.slice(1, 6), [
    '新连接的路 · 12 秒前探测  在路径上 · 是',
    '  claude pid 4121 · 2.1.291',
    '  → [eBPF · link 17] asight 引擎 pid 4012 · 127.0.0.1:47123 · 解密',
    '  → [CONNECT 原样转] mihomo 1.19.32 :7890 · pid 777 · 规则模式',
    '  → 出口(mihomo 选)',
  ])
  assert.ok(lines.includes('关掉 asight 时的路: claude 4121 → [HTTPS_PROXY] mihomo :7890 → 出口(mihomo 选)'))
  assert.match(lines.at(-1), /^要换代理: 照常改 claude-code 的设置/)
  const two = renderCompact(buildTopology(ROWS.find((r) => r.n === 22).facts).codex)
  assert.deepEqual(two.map((l) => l.split(' ')[0]), ['HTTP', 'WebSocket'])
  assert.equal(renderCompact(buildTopology(row.facts)['claude-code'])[0].startsWith('claude 4121'), true)
  assert.equal(verdictText({ on_path: true, captured: true, reason: null }), '在路径上 · 是')
  assert.equal(verdictText({ on_path: false, captured: false, reason: 'desired-off' }), '不在 · 否 · desired-off')
  assert.equal(verdictText({ on_path: null, captured: null, reason: null }), '在不在路径上不知道 · 不知道')
})

test('V42 (text): a hop that could not be read says 「不知道 · <reason>」 in the compact line and in the detail, and no hop says 「无」', () => {
  for (const [n, h, reason] of [[21, 'hermes', 'owner-unreadable'], [22, 'codex', 'pac']]) {
    const t = buildTopology(ROWS.find((r) => r.n === n).facts)[h]
    for (const text of [renderCompact(t).join('\n'), renderDetail(t).join('\n')]) {
      assert.match(text, new RegExp(`不知道 · ${reason}`), `row ${n}`)
      assert.doesNotMatch(text, /(^|\s)无(\s|$)/)
    }
  }
})

test('V43 (text): every hop of the compact line is a node of the object it was drawn from', () => {
  for (const row of ROWS) {
    const t = buildTopology(row.facts)[row.h]
    const seen = [], ways = t.branches.filter((b) => !seen.includes(b.path.join()) && seen.push(b.path.join())) // branches that take the same path are one line
    assert.equal(renderCompact(t).length, ways.length, `row ${row.n}: one line for each way`)
    ways.forEach((b, i) => {
      const hops = renderCompact(t)[i].replace(/^(HTTP|WebSocket) /, '').split(' → ').map((x) => x.replace(/^\[[^\]]*\] /, ''))
      assert.equal(hops.length, b.path.length, `row ${row.n}: one hop for each node`)
      hops.forEach((hop, k) => { const n = t.nodes.find((x) => x.id === b.path[k]); assert.ok(n.unknown && n.kind === 'egress' ? hop === '?' : hop.includes(n.kind === 'egress' ? '出口' : n.name), `row ${row.n}: ${hop} ~ ${n.name}`) })
    })
  }
})

test('renderDetail in proxy mode: the way out says HTTP and WebSocket apart when they differ, the entry says who wrote it, the notes come after the processes, and the VPN line is there once', () => {
  const t = buildTopology(ROWS.find((r) => r.n === 9).facts).codex
  const lines = renderDetail(t)
  assert.equal(lines[0], 'codex · 开 · 代理模式 · 被采集: 是')
  assert.equal(lines.filter((l) => l.startsWith('新连接的路')).length, 1, 'HTTP and WebSocket take the same path with asight: one block')
  assert.ok(lines.includes('  → [.env HTTPS_PROXY · asight 写的] asight 自带内核 :17992'))
  assert.ok(lines.includes('关掉 asight 时的路: HTTP codex app-server 5530 → [系统代理] Clash Verge Rev :7897 → 出口(Clash Verge Rev 选) · WebSocket codex app-server 5530 → chatgpt.com:443(直连)'))
  assert.equal(lines.filter((l) => /看到的来源是 asight/.test(l)).length, 1)
  assert.match(lines.at(-1), /^要换代理: 照常改 codex 的设置,再跑 asight on codex/)
  const off = renderDetail(buildTopology(ROWS.find((r) => r.n === 14).facts).codex)
  assert.ok(off.includes('说明: 还有 1 个 agent 连着 asight 的内核,重启它们之后 asight 就完全退出'))
  assert.equal(off[0], 'codex · 关 · 代理模式 · 被采集: 否(desired-off)')
  assert.ok(off.some((l) => /看到的来源是 asight/.test(l)), 'the kernel still forwards for the agent that is connected: a VPN still sees asight')
})
