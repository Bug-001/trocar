// test/collector/arch/win32/off-parity.test.mjs — on Windows, `off` / daemon-less `status` and the daemon judge the same process the same way (RFC 4.6
// §识别进程 "两边对同一进程给出同一个串", 4.8 W76 "one rule"; the platform-seam rule: one Windows command-line splitter, src/off/winargv.mjs). Each case's RAW
// command line goes once through `off`'s whole-table reader (`listProcs({ platform: 'win32', exec })`, the one Get-CimInstance answer faked) and once
// through the collector's targeted-ask row (`factsOfRow`); the registry must give both the same verdict, `off`'s own manifest judge (matchHarness over
// the liveness snapshot) the same harness, and that harness must be the seed's. Review R12 / R2 / R19: a quoted exe path with a space used to split
// into `"C:\Program` + `Files\…"` on the `off` side, so anchored patterns (codex's `^--codex-run-as-…` exclusion, node's entry) read a different string.
import test from 'node:test'
import assert from 'node:assert/strict'
import { listProcs } from '../../../../src/off/proc.mjs'
import { matchHarness } from '../../../helpers/one-harness.mjs'
import { factsOfRow } from '../../../../src/collector/arch/win32/procinfo.mjs'
import { createRegistry, livenessOf } from '../../../../src/collector/core/registry.mjs'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import { SEEDS } from '../../../helpers/proc-seeds.mjs'

const ALL = await loadHarnesses()
const REG = createRegistry(ALL)
const LIVENESS = Object.fromEntries(ALL.map((d) => [d.name, livenessOf(d)]))
const W = String.raw`C:\Users\u`
const PF = String.raw`C:\Program Files`
const MSIX = String.raw`C:\Program Files\WindowsApps\OpenAI.Codex_26.1002.0.0_x64__2p2nqsd0c76g0\app\resources\codex.exe`
const NODE = String.raw`C:\Program Files\nodejs\node.exe`

// raw command lines the seeds do not hold: a quoted exe with a space, and anchored exclusions / entries behind it (review R12 / R19)
const EXTRA = [
  { exe: MSIX, cmdline: `"${MSIX}" --codex-run-as-apply-patch foo`, harness: null, source: 'review R12 (codex helper behind a quoted Program Files path: the ^-anchored exclusion)' },
  { exe: MSIX, cmdline: `"${MSIX}" app-server`, harness: 'codex', source: 'review R12 (the same exe, the agent)' },
  { exe: String.raw`C:\Users\John Smith\.codex\codex.exe`, cmdline: String.raw`"C:\Users\John Smith\.codex\codex.exe" --codex-run-as-arg0-exec-helper x`, harness: null, source: 'review R12 (a user folder with a space)' },
  { exe: NODE, cmdline: `"${NODE}" --no-warnings "${W}\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"`, harness: 'deepseek-dsh', source: 'review R19 (a spaced node path, a node flag, then the entry)' },
  { exe: NODE, cmdline: `"${NODE}" C:\\tools\\wrapper.js ${W}\\AppData\\Roaming\\npm\\dsh`, harness: null, source: 'review R2 (a wrapper naming dsh only later is not dsh)' },
  { exe: `${PF}\\OpenCode\\resources\\opencode-cli.exe`, cmdline: `"${PF}\\OpenCode\\resources\\opencode-cli.exe" serve`, harness: 'opencode', source: 'review R12 (opencode-cli behind a quoted path)' },
]

test('win32: off / status (listProcs over the raw command line) and the daemon (factsOfRow) give every seed the same verdict, and it is the seed\'s harness', async () => {
  const cases = [...SEEDS.filter((s) => s.os === 'win32'), ...EXTRA]
  assert.ok(cases.some((c) => /^"[^"]* [^"]*"/.test(c.cmdline)), 'at least one quoted exe path with a space')
  const rows = cases.map((c, i) => ({ p: 1000 + i, pp: 1, n: c.exe.split('\\').pop(), x: c.exe, s: 1_740_000_000_000, c: c.cmdline }))
  const exec = (file) => ({ status: file === 'powershell' ? 0 : 1, stdout: JSON.stringify(rows), stderr: '' })
  const off = await listProcs({ platform: 'win32', exec })
  assert.equal(off.length, cases.length)
  for (const [i, c] of cases.entries()) {
    const daemon = factsOfRow({ pid: rows[i].p, ppid: 1, name: rows[i].n, exe: c.exe, cmdline: c.cmdline, startedAt: rows[i].s, cmdlineState: 'ok' })
    const why = `${c.cmdline} (${c.source})`
    assert.deepEqual(off[i].argv, daemon.argv, `one argv for one process: ${why}`)
    const a = REG.match(off[i]), b = REG.match(daemon)
    assert.deepEqual([a.agent, a.reason, a.harness ?? null], [b.agent, b.reason, b.harness ?? null], `the same registry verdict on both sides: ${why}`)
    assert.equal(b.agent, c.harness, `the seed's harness: ${why}`)
    assert.equal(matchHarness(LIVENESS, off[i]), c.harness, `off's own judge (the manifest's liveness identity) agrees: ${why}`)
  }
})
