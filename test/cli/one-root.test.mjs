// CM40 · V125 (RFC 4.11 §3 ㉔; 1.6 §3.2, §3.6): one trocar root per user. A root the user's store holds that the install record does not list
// (the record was deleted) is never joined by a second one: install refuses before it writes anything — HOME byte for byte, the store unchanged,
// error.code stray-root, the root's fingerprint named — and so does its dry run. uninstall then takes every trocar root out, record or not, and
// the custody's key with them. A plain install; install is not refused. macOS and Windows alike: the injected store and custody, never an OS tool.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { modelWorld } from '../helpers/model-world.mjs'
import { runInstallCli } from '../../src/cli/install.mjs'
import { runUninstall } from '../../src/cli/uninstall.mjs'
import { ERROR_CODES } from '../../src/cli/json.mjs'
import { manifestPath } from '../../src/off/manifest.mjs'
import { recordingExec } from './fixtures/on-ctx.mjs'

const fakeIo = () => { const out = [], err = []; return { out: (s) => out.push(s), err: (s) => err.push(s), stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: {}, text: () => [...out, ...err].join('\n'), json: () => JSON.parse(out.join('\n')) } }
const tree = (root) => { const out = {}; const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); const st = fs.lstatSync(p); if (st.isDirectory()) { out[p] = 'dir'; walk(p) } else out[p] = fs.readFileSync(p).toString('base64') } }; walk(root); return out }

async function world(os) {
  const w = await modelWorld({ os })
  const custody = { kind: w.custody.kind, exists: () => w.custody.exists(), create: (a) => w.custody.create(a), issueIntermediate: (a) => w.custody.issueIntermediate(a), removes: 0, remove: (id) => { custody.removes++; return w.custody.remove(id) } }
  const install = async (argv) => {
    const io = fakeIo()
    const exit = await runInstallCli(argv, { io, env: w.env, home: w.home, platform: os, deps: { getuid: () => 501, unit: null, backends: { custody, rootStore: w.store, installHelper: null, dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, owns: w.owns } })
    return { exit, io }
  }
  const uninstall = () => runUninstall({ home: w.home, env: w.env, yes: true, deps: { platform: os, exec: recordingExec().run, custody, rootStore: w.store, procs: async () => [], sleep: async () => {}, drainMs: 0, getuid: () => 501 } })
  return { ...w, custody, install, uninstall }
}

for (const os of ['darwin', 'win32']) {
  test(`CM40 · V125 ${os}: install, the record deleted, install again → refused before any write; uninstall then leaves no trocar root and no key`, async () => {
    const w = await world(os)
    const first = await w.install(['--yes', '--json'])
    assert.equal(first.exit, 0, first.io.text())
    const fp = first.io.json().fp256
    assert.deepEqual([...w.store.held], [fp])
    fs.rmSync(manifestPath(w.dir))
    const before = tree(w.home), held = [...w.store.held]
    for (const argv of [['--yes', '--json'], ['--dry-run', '--json']]) {
      const again = await w.install(argv)
      const doc = again.io.json()
      assert.deepEqual([again.exit, doc.ok, doc.error && doc.error.code], [1, false, 'stray-root'], `${argv.join(' ')}: ${again.io.text()}`)
      assert.ok(ERROR_CODES.includes(doc.error.code))
      assert.ok(doc.error.message.includes(fp), `the root is named: ${doc.error.message}`)
      assert.deepEqual(tree(w.home), before, `${argv.join(' ')}: not one byte under HOME changed`)
      assert.deepEqual([...w.store.held], held, `${argv.join(' ')}: the store is unchanged`)
    }
    assert.equal(w.custody.exists(), true, 'the key the first install made is still there')
    const { receipt, exit } = await w.uninstall()
    assert.equal(exit, 0, JSON.stringify(receipt.problems))
    assert.deepEqual(w.store.list(), { roots: [] }, 'no trocar root is left in the store')
    assert.equal(w.custody.exists(), false, 'and no key in the custody')
    assert.ok(w.custody.removes >= 1)
    assert.ok(receipt.changed.some((c) => c.change.includes(fp)), `the root is listed in the receipt: ${JSON.stringify(receipt.changed)}`)
  })

  test(`CM40 ${os}: a store root the record lists is no stray — install; install is not refused, and makes no second root`, async () => {
    const w = await world(os)
    assert.equal((await w.install(['--yes', '--json'])).exit, 0)
    const again = await w.install(['--yes', '--json'])
    assert.equal(again.exit, 0, again.io.text())
    assert.equal(w.store.list().roots.length, 1)
  })

  test(`CM40 ${os}: a store that cannot be listed is not "no root": install refuses, nothing written`, async () => {
    const w = await world(os)
    w.store.list = () => ({ error: 'certutil -user -store failed (exit 5)' })
    const r = await w.install(['--yes', '--json'])
    assert.deepEqual([r.exit, r.io.json().error.code], [1, 'unreadable'], r.io.text())
    assert.ok(!fs.existsSync(path.join(w.home, '.trocar')), 'nothing under ~/.trocar')
    assert.equal(w.custody.exists(), false, 'no key made')
  })
}

// 1.6 §1.4 / §3.6: the plan is the receipt the run gives, in the future tense — the stray roots and the key included (the confirmation is given to it)
const storeRows = (r, fp) => ({ changed: r.changed.filter((c) => c.change.includes(fp)).map((c) => [c.path, c.change]), key: r.removed.filter((p) => /:\?$/.test(p)) })
const flowCodes = (dir) => { const d = path.join(dir, 'flows'); return fs.existsSync(d) ? fs.readdirSync(d).flatMap((n) => fs.readFileSync(path.join(d, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))).filter((e) => e.event === 'failure').map((e) => e.code) : [] }
async function strayWorld(os) {
  const w = await world(os)
  const first = await w.install(['--yes', '--json'])
  assert.equal(first.exit, 0, first.io.text())
  fs.rmSync(manifestPath(w.dir))
  return { w, fp: first.io.json().fp256 }
}

for (const os of ['darwin', 'win32']) {
  test(`CM40 · V125 ${os}: uninstall --dry-run lists the stray root and the key exactly as the real run then does them`, async () => {
    const { w, fp } = await strayWorld(os)
    const dry = await runUninstall({ home: w.home, env: w.env, dryRun: true, deps: { platform: os, exec: recordingExec().run, custody: w.custody, rootStore: w.store, procs: async () => [], getuid: () => 501 } })
    assert.equal(dry.exit, 0)
    assert.deepEqual([...w.store.held], [fp], 'the dry run took nothing out')
    assert.equal(w.custody.removes, 0)
    const planned = storeRows(dry.receipt, fp)
    assert.equal(planned.changed.length, 1, JSON.stringify(dry.receipt.changed))
    assert.ok(dry.receipt.planned.some((p) => p.change.includes(fp)), 'the JSON plan names it too')
    const real = await w.uninstall()
    assert.equal(real.exit, 0, JSON.stringify(real.receipt.problems))
    assert.deepEqual(planned, storeRows(real.receipt, fp))
  })

  test(`CM40 ${os}: uninstall --dry-run with a store that cannot be listed says so, never a silent plan`, async () => {
    const { w } = await strayWorld(os)
    const clean = await runUninstall({ home: w.home, env: w.env, dryRun: true, deps: { platform: os, exec: recordingExec().run, custody: w.custody, rootStore: { ...w.store, list: () => ({ roots: [] }) }, procs: async () => [], getuid: () => 501 } })
    const broken = await runUninstall({ home: w.home, env: w.env, dryRun: true, deps: { platform: os, exec: recordingExec().run, custody: w.custody, rootStore: { ...w.store, list: () => ({ error: 'exit 5' }) }, procs: async () => [], getuid: () => 501 } })
    assert.equal(broken.exit, 0)
    assert.ok(broken.receipt.notes.length > clean.receipt.notes.length, JSON.stringify(broken.receipt.notes))
  })

  // D38: every way the sweep can fail is a left row, the root in still_trusting, a failure line in flows/, exit 1 — and the key stays while a root does
  const failures = {
    'remove answers not ok': (s) => ({ remove: () => ({ ok: false, reason: 'the OS prompt was declined' }) }),
    'remove throws': (s) => ({ remove: () => { throw new Error('spawn failed') } }),
    'still listed after remove': (s) => ({ remove: () => ({ ok: true }) }),
    'the second list fails': (s) => { let n = 0; const list = s.list; return { list: () => (n++ ? { error: 'exit 5' } : list()) } },
  }
  for (const [name, patch] of Object.entries(failures)) {
    test(`CM40 ${os}: the sweep's root not out (${name}) → exit 1, still_trusting, root-not-removed, the key kept`, async () => {
      const { w, fp } = await strayWorld(os)
      Object.assign(w.store, patch(w.store))
      const { receipt, exit } = await w.uninstall()
      assert.equal(exit, 1)
      assert.ok(receipt.still_trusting.some((s) => s.fp256 === fp || s.command), JSON.stringify(receipt.still_trusting))
      assert.ok(receipt.left.length >= 1)
      assert.ok(flowCodes(w.dir).includes('root-not-removed'), JSON.stringify(flowCodes(w.dir)))
      assert.equal(w.custody.removes, 0, 'no root went, so the key stays')
      assert.equal(w.custody.exists(), true)
    })
  }

  test(`CM40 ${os}: the sweep's first list fails → exit 1, a left row, entry-not-undone, the key kept`, async () => {
    const { w } = await strayWorld(os)
    w.store.list = () => ({ error: 'exit 5' })
    const { receipt, exit } = await w.uninstall()
    assert.equal(exit, 1)
    assert.ok(receipt.left.length >= 1)
    assert.ok(flowCodes(w.dir).includes('entry-not-undone'), JSON.stringify(flowCodes(w.dir)))
    assert.equal(w.custody.removes, 0)
  })

  test(`CM40 ${os}: the root out but the custody unavailable → exit 1, the key a left row, entry-not-undone`, async () => {
    const { w } = await strayWorld(os)
    w.custody.remove = () => 'unavailable'
    const { receipt, exit } = await w.uninstall()
    assert.equal(exit, 1)
    assert.deepEqual(w.store.list(), { roots: [] }, 'the root went')
    assert.ok(receipt.left.some((l) => /:\?$/.test(l.path)), JSON.stringify(receipt.left))
    assert.ok(flowCodes(w.dir).includes('entry-not-undone'))
    assert.deepEqual(receipt.still_trusting, [])
  })
}
