// test/collector/arch/win32/on-elevated.test.mjs — `on`'s entry gates, at the CLI level: W25's elevated refusal (R7, 4.8 §7) and the Node floor
// (W24's `nodePreflight` cell). `trocar on` asks the arch's refuseElevated and nodePreflight at its entry and refuses BEFORE its first write — turnOn
// (on's only writer) is never asked, the netenv probe and the adoption read never run under the elevated shell or the old Node. The elevated refusal
// writes one failure record (the §12 table's where 'start': that code lives there whichever command asked) only where a collector directory exists, and
// the receipt carries the reason either way; the Node refusal is the receipt alone (no closed-set code, and nothing of trocar's may exist yet). A token
// that cannot be read is not a refusal (R11): the unknown case is said and the on proceeds. The questions themselves (the helper's `token` verb, the
// self-start, the token shapes, the version parsing) are autostart.test.mjs's; this file holds only the CLI wiring.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runOnCli } from '../../../../src/cli/on.mjs'
import { validateReceipt, newReceipt } from '../../../../src/cli/schema.mjs'
import { checkRecord } from '../../../../src/health/codes.mjs'
import { fakeIo, fakeDaemon, snapshot, onCtx } from '../../../cli/fixtures/on-ctx.mjs'
import { tmpDir } from '../../../helpers/tmp.mjs'

/** The parts of a win32 arch carrying only the entry gates asked — everything else on would ask for stays absent, so a path past the refusal fails loudly. */
const partsWith = (arch) => ({ os: 'win32', harnesses: [{ name: 'claude-code' }], scan: async () => [], match: () => ({ agent: null }), arch })
const injectInstall = (reached) => ({ turnOn: async (o) => { reached.push(o.ids); return { receipt: { ...newReceipt('on'), ok: true, harnesses: o.ids, notes: [] }, exit: 0 } } })

test('W25 (command level): on refuses an elevated token before its first write — the receipt, one failure record where flows exist, exit 1, the HOME otherwise byte for byte, turnOn never asked', async () => {
  const home = tmpDir('trocar-w32-on-r7-')
  fs.mkdirSync(path.join(home, '.trocar', 'collector', 'flows'), { recursive: true }) // an installed world: the record has a flows/ to land in
  const before = snapshot(home)
  const asked = []
  const reached = []
  const io = fakeIo({ tty: false })
  const refuse = async (o) => { asked.push(Object.keys(o)); return { code: 'elevated-token', reason: '用你自己的账号跑,不要「以管理员身份运行」,也不要用 SYSTEM(R7:trocar 不以提升的令牌运行;这个令牌是高完整性级别)', token: { elevated: true, system: false, integrity: 'high' } } }
  const ctx = onCtx(home, io, { deps: { parts: partsWith({ nodePreflight: () => ({ ok: true, have: 'v22.0.0', min: 20 }), refuseElevated: refuse }), install: injectInstall(reached), request: fakeDaemon().request, netFactsDeps: async () => ({ harnesses: [], archFacts: () => ({ routing: 'proxy' }) }) } })
  assert.equal(await runOnCli(['--yes', '--json'], ctx), 1, io.text())
  const doc = io.json()
  assert.deepEqual(validateReceipt(doc), [], 'the receipt is a receipt')
  assert.equal(doc.ok, false)
  assert.match(doc.notes.join('\n'), /不要「以管理员身份运行」/, 'the receipt says why in the arch\'s own words')
  assert.deepEqual(asked, [['env', 'onUnknown']], 'the arch question was asked with the shell environment and a sink for the unknown case')
  assert.deepEqual(reached, [], 'turnOn — on\'s only writer — was never asked')
  // the record: exactly one new file in flows/, nothing else anywhere in the HOME
  const after = snapshot(home)
  const added = Object.keys(after).filter((k) => !(k in before))
  assert.equal(added.length, 1, `exactly one thing was added: ${added.join(', ')}`)
  assert.match(added[0], /^\.trocar\/collector\/flows\//, 'it is the failure record')
  const rec = fs.readFileSync(path.join(home, added[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.event === 'failure')
  assert.deepEqual([rec.event, rec.where, rec.code], ['failure', 'start', 'elevated-token'], 'the §12 table\'s where for this code')
  assert.match(rec.reason, /管理员身份运行/)
  assert.deepEqual(checkRecord(rec), [], 'the closed sets accept it')
  for (const k of Object.keys(before)) assert.equal(after[k], before[k], `${k} is byte for byte as it was`)
})

test('the Node floor (W24, 4.8 §7): nodePreflight\'s no refuses `on` before its first write with its doctor line — turnOn never asked, the HOME byte for byte, no record anywhere', async () => {
  const home = tmpDir('trocar-w32-on-node-')
  const before = snapshot(home)
  const reached = []
  const io = fakeIo({ tty: false })
  const ctx = onCtx(home, io, { deps: { parts: partsWith({ nodePreflight: () => ({ ok: false, have: '18.19.0', min: 20, doctor: 'Node 18.19.0 太旧:trocar 在 Windows 上要 Node ≥ 20(守护进程每次登录都由这个 Node 拉起,更老的版本起不来)。升级 Node 之后再 trocar on' }) }), install: injectInstall(reached), request: fakeDaemon().request, netFactsDeps: async () => ({ harnesses: [], archFacts: () => ({ routing: 'proxy' }) }) } })
  assert.equal(await runOnCli(['--yes', '--json'], ctx), 1, io.text())
  const doc = io.json()
  assert.deepEqual(validateReceipt(doc), [], 'the receipt is a receipt')
  assert.equal(doc.ok, false)
  assert.deepEqual(reached, [], 'turnOn was never asked')
  assert.deepEqual(snapshot(home), before, 'nothing was written anywhere in the HOME — the receipt is the record')
})

