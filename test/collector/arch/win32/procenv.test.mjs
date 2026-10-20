// procenv.test.mjs — the helper's `proc-env` verb on the JS side (RFC 4.11 P7's win32 proc readers, W2): one PEB read answers the
// environment entries asked for, the current directory and the creator parent; the readers cache it by pid + start time. The answers
// are fixture text in the C#'s shape (helper.ps1 ProcEnvJson); the real read runs in acceptance L4. Plus the helper-side filter, read statically.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { HELPER_PS1 } from '../../../../src/collector/arch/win32/helper.mjs'
import { parseProcEnv, procReaders } from '../../../../src/collector/arch/win32/procinfo.mjs'

/** UTF-16LE "N=V\0…\0" in base64, as ProcEnvJson writes it. */
const block = (entries) => Buffer.from(entries.map((e) => `${e}\0`).join(''), 'utf16le').toString('base64')
const ok = (pid, over = {}) => ({ pid, ok: true, startedAt: 5000 + pid, cwd: 'C:\\Users\\al\\proj ü', envB64: block(['HTTPS_PROXY=http://127.0.0.1:7890', 'no_proxy=localhost,.corp', 'Https_Proxy=second', 'PATH=C:\\Windows']), ppid: 40, parent: { pid: 40, startedAt: 4000 }, ...over })
function fakeHelper(answers) {
  const calls = []
  return { calls, async call(verb, args, opts) { calls.push({ verb, args, opts }); const a = answers[args.pid]; if (a instanceof Error) throw a; return typeof a === 'function' ? a(args) : a } }
}

test('proc-env parsing: a UTF-16 block (non-ASCII kept, the first of a name wins, the =C: entries skipped), an empty env, an access-denied row', () => {
  const r = parseProcEnv({ ...ok(7), envB64: block(['=C:=C:\\x', 'HTTPS_PROXY=http://ü:1', 'https_proxy=later', 'EMPTY=']) })
  assert.deepEqual([...r.env.values()], [['HTTPS_PROXY', 'http://ü:1'], ['EMPTY', '']])
  assert.deepEqual([r.startedAt, r.cwd, r.ppid, r.parent], [5007, 'C:\\Users\\al\\proj ü', 40, { ppid: 40, startedAt: 4000 }])
  assert.equal(parseProcEnv({ ...ok(8), envB64: '' }).env.size, 0, 'an empty environment is an answer, not a failure')
  assert.equal(parseProcEnv({ pid: 9, ok: false, error: 'access-denied', winError: 5 }), null)
  assert.equal(parseProcEnv({ ...ok(10), parent: null }).parent, null, 'a parent gone or younger than the child (a reused pid) is no creator')
  assert.equal(parseProcEnv(null), null)
})

test('readers: envOf / cwdOf / parentOf come from ONE proc-env per pid + start time; names case-insensitive, keyed as asked', async () => {
  const h = fakeHelper({ 7: ok(7) })
  const rd = procReaders({ helper: h })
  assert.deepEqual(await rd.envOf(7, ['https_proxy', 'NO_PROXY', 'ALL_PROXY'], { startedAt: 5007 }), { https_proxy: 'http://127.0.0.1:7890', NO_PROXY: 'localhost,.corp' })
  assert.equal(await rd.cwdOf(7, { startedAt: 5007 }), 'C:\\Users\\al\\proj ü')
  assert.deepEqual(await rd.parentOf(7, { startedAt: 5007 }), { ppid: 40, startedAt: 4000 })
  assert.deepEqual(await rd.envOf(7, ['NO_PROXY'], { startedAt: 5007 }), { NO_PROXY: 'localhost,.corp' })
  assert.equal(h.calls.length, 1, 'a busy agent costs one read')
  assert.deepEqual(h.calls[0].verb, 'proc-env')
  assert.deepEqual(h.calls[0].args, { pid: 7, names: ['HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY'] }, 'only the named variables are asked for')
  await rd.envOf(7, ['PATH'], { startedAt: 5007 })
  assert.deepEqual(h.calls[1].args.names.sort(), ['ALL_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'PATH'], 'a new name asks again, for the union')
})

test('readers: another life of the pid, an unreadable process and a failed helper are null; a failure is asked again; no start time, no cache', async () => {
  let n = 0
  const h = fakeHelper({ 7: ok(7), 8: { pid: 8, ok: false, error: 'access-denied' }, 9: () => (++n === 1 ? Object.assign(new Error('t'), { code: 'helper-timeout' }) : ok(9)), 10: ok(10) })
  h.call = ((call) => async (verb, args, opts) => { const r = await call.call(h, verb, args, opts); if (r instanceof Error) throw r; return r })(h.call)
  const rd = procReaders({ helper: h })
  assert.equal(await rd.envOf(7, ['PATH'], { startedAt: 1 }), null, 'the pid now holds another process')
  assert.equal(await rd.cwdOf(8, { startedAt: 5008 }), null)
  assert.equal(await rd.parentOf(9, { startedAt: 5009 }), null)
  assert.deepEqual(await rd.parentOf(9, { startedAt: 5009 }), { ppid: 40, startedAt: 4000 }, 'the failed read was not cached')
  await rd.cwdOf(10); await rd.cwdOf(10)
  assert.equal(h.calls.filter((c) => c.args.pid === 10).length, 2, 'a pid alone can be reused: no caching without the start time')
  assert.deepEqual(await rd.envOf(10, []), {})
})

test('helper.ps1 proc-env: same user only, QUERY_LIMITED | VM_READ, the asked names filtered in the helper; ps keeps the user\'s rows of other sessions', () => {
  const ps = fs.readFileSync(HELPER_PS1, 'utf8')
  assert.match(ps, /'proc-env' \{ return \(Verb-ProcEnv \$a\) \}/)
  const body = ps.slice(ps.indexOf('public static string ProcEnvJson'), ps.indexOf('public static string PipeJson'))
  assert.match(body, /OpenProcess\(0x1010, false, pid\)/)
  assert.match(body, /if \(UserOf\(h\) != OwnUser\(\)\) return .*other-user/)
  assert.match(body, /want\.Contains\(e\.Substring\(0, eq\)\)/, 'only the asked entries leave the helper')
  assert.match(body, /pStarted <= started/, 'the parent counts only when it is older than the child')
  const snap = ps.slice(ps.indexOf('public static List<TrocarProc> Snapshot'), ps.indexOf('public static string ProcsJson'))
  const keep = snap.indexOf('if (!all && sid != own && !p.SameUser) continue;')
  assert.ok(keep > 0, 'the session filter keeps a process of the same user in another session')
  assert.ok(snap.indexOf('p.SameUser = UserOf(h) == OwnUser()') < keep, 'the user is known before the filter asks')
  assert.match(ps, /\\"sameUser\\":/, 'each ps row says it')
})
