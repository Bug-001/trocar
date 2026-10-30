// test/off/no-userinfo.test.mjs — a proxy URL trocar wrote can carry the door's `user:password@` (RFC 1.6 §1.2「不印凭据」). `trocar off` names the
// key and the file of such an entry, never the password: not in the text receipt, not in `--json`, not in the `flows/` lines it writes, and not in the
// standalone copy's output. Undo is not weakened: the manifest keeps what it needs, every entry still comes out, the user's own edits stay.
// Generated over the entry kinds that hold a value (a JSON key, a dotenv block's variable, a line) × the URL forms a password can take.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { applyJsonKey, applyTextEntry } from '../../src/collector/core/trust/journal.mjs'
import { readManifest, saveManifest } from '../../src/off/manifest.mjs'
import { lineComment } from '../../src/off/text-edit.mjs'
import { runOffCli } from '../../src/off/main.mjs'
import { runCli } from '../../src/cli/main.mjs'
import { installedHome, flowEvents } from './fixtures/off-ctx.mjs'
import { VERBS } from '../../src/control/board.mjs'

const PW = 'pw-not-a-real-secret-41f9'
// the door's own form, a password holding an unescaped `@` and `:`, a socks scheme, a user name alone as the token
const URLS = [
  `http://claude-code:settings:${PW}@127.0.0.1:47011`,
  `http://door:${PW}@x@127.0.0.1:47011/`,
  `socks5h://u:${PW}@127.0.0.1:1080`,
  `https://${PW}@127.0.0.1:47011`,
]

// `trocar off` (through the dispatch) or the standalone copy (its own entry)
const off = (argv, { io, s, standalone }) => (standalone ? runOffCli(argv, { io, home: s.home, env: s.sh.env, deps: s.offDeps(), standalone })
  : runCli(['off', ...argv], { io, home: s.home, env: s.sh.env, platform: 'linux', uid: 1000, deps: s.offDeps() }))

const fakeIo = () => {
  const lines = []
  const tty = (t) => Object.assign(new PassThrough(), { isTTY: t })
  return { lines, io: { out: (s) => lines.push(String(s)), err: (s) => lines.push(String(s)), stdin: tty(false), stdout: tty(false), stderr: tty(false) } }
}

for (const [i, url] of URLS.entries()) {
  for (const standalone of [false, true]) {
    test(`off ${standalone ? '(standalone copy) ' : ''}with ${url.split('://')[0]} form #${i}: the receipt (text and --json) and its flows lines name the key, never the password; every entry is still undone`, async () => {
      const s = await installedHome({ names: ['claude-code'] })
      const m = readManifest(s.dir)
      const settings = path.join(s.home, '.claude', 'settings.json')
      const dotenv = path.join(s.home, '.creds-test', '.env'), rc = path.join(s.home, '.creds-test', 'rc')
      fs.mkdirSync(path.dirname(dotenv), { recursive: true })
      fs.writeFileSync(dotenv, 'MINE=1\n'); fs.writeFileSync(rc, '# mine\n')
      const b = { dir: s.dir, manifest: m, harness: 'claude-code', phase: 'on', home: s.home }
      applyJsonKey({ ...b, file: settings, keys: ['env', 'https_proxy'], value: url })
      applyTextEntry({ ...b, file: dotenv, edit: { format: 'dotenv-block', vars: { HTTPS_PROXY: url } } })
      applyTextEntry({ ...b, file: rc, edit: { format: 'line', line: `export HTTPS_PROXY=${url} ${lineComment('routes through trocar')}` } })
      saveManifest(s.dir, m)
      // the user edits each file while on: the undo cannot be byte-identical, so the receipt says what trocar took out (reverted-not-identical)
      const doc = JSON.parse(fs.readFileSync(settings, 'utf8')); doc.mine = true; fs.writeFileSync(settings, JSON.stringify(doc, null, 2) + '\n')
      fs.appendFileSync(dotenv, 'ALSO_MINE=2\n'); fs.appendFileSync(rc, '# also mine\n')
      const before = flowEvents(s.dir).length

      const json = fakeIo()
      assert.equal(await off(['--json'], { io: json.io, s, standalone }), 0, json.lines.join('\n'))
      const receipt = JSON.parse(json.lines.join('\n'))
      assert.ok(receipt.changed.some((c) => c.path === settings), 'the receipt names the file')
      for (const f of [settings, dotenv, rc]) {
        const t = fs.readFileSync(f, 'utf8')
        assert.ok(!t.includes(PW) && !t.includes('HTTPS_PROXY=') && !t.includes('https_proxy'), `${f}: trocar's entry is out`)
        assert.match(t, /mine/i, `${f}: the user's own edit stays`)
      }
      const lines = flowEvents(s.dir).slice(before)
      assert.ok(lines.length > 0, 'off wrote its lines')
      assert.ok(!JSON.stringify(lines).includes(PW), `the flows lines carry no password: ${JSON.stringify(lines)}`)
      assert.ok(!json.lines.join('\n').includes(PW), `--json carries no password: ${json.lines.join('\n')}`)
      // the kept backups' reasons are text for a person, kept in the manifest for every later off: no password there either
      const kept = readManifest(s.dir).kept_backups || []
      assert.ok(kept.length > 0 && !JSON.stringify(kept).includes(PW), `the manifest's kept backups carry no password: ${JSON.stringify(kept)}`)

      // the same off as text, over a second home in the same state
      const t = await installedHome({ names: ['claude-code'] })
      const m2 = readManifest(t.dir), s2 = path.join(t.home, '.claude', 'settings.json')
      applyJsonKey({ dir: t.dir, manifest: m2, harness: 'claude-code', phase: 'on', home: t.home, file: s2, keys: ['env', 'https_proxy'], value: url })
      saveManifest(t.dir, m2)
      const d2 = JSON.parse(fs.readFileSync(s2, 'utf8')); d2.mine = true; fs.writeFileSync(s2, JSON.stringify(d2) + '\n')
      const text = fakeIo()
      assert.equal(await off([], { io: text.io, s: t, standalone }), 0, text.lines.join('\n'))
      assert.ok(!text.lines.join('\n').includes(PW), `the text receipt carries no password: ${text.lines.join('\n')}`)
    })
  }
}

// the board's off (POST /control/harness, on:false) answers with the receipt `--json` prints: planned, confirmed, and no password in either answer
for (const [i, url] of URLS.entries()) {
  test(`the board's off with ${url.split('://')[0]} form #${i}: neither the plan nor the receipt carries the password`, async () => {
    const s = await installedHome({ names: ['claude-code'] })
    const m = readManifest(s.dir), settings = path.join(s.home, '.claude', 'settings.json')
    applyJsonKey({ dir: s.dir, manifest: m, harness: 'claude-code', phase: 'on', home: s.home, file: settings, keys: ['env', 'https_proxy'], value: url })
    saveManifest(s.dir, m)
    const doc = JSON.parse(fs.readFileSync(settings, 'utf8')); doc.mine = true; fs.writeFileSync(settings, JSON.stringify(doc) + '\n')
    const ctx = { home: path.join(s.home, '.trocar'), deps: { ...s.offDeps(), env: s.sh.env } }
    const plan = await VERBS.harness({ harness: 'claude-code', on: false }, ctx)
    assert.equal(plan.status, 409, JSON.stringify(plan.doc))
    assert.ok(!JSON.stringify(plan.doc).includes(PW), `the plan carries no password: ${JSON.stringify(plan.doc)}`)
    const done = await VERBS.harness({ harness: 'claude-code', on: false, confirm: plan.doc.plan_id }, ctx)
    assert.equal(done.status, 200, JSON.stringify(done.doc))
    assert.ok(done.doc.ok !== false && done.doc.kept_backups.length > 0, JSON.stringify(done.doc))
    assert.ok(!JSON.stringify(done.doc).includes(PW), `the receipt carries no password: ${JSON.stringify(done.doc)}`)
    assert.ok(!fs.readFileSync(settings, 'utf8').includes('https_proxy'), "trocar's entry is out")
  })
}
