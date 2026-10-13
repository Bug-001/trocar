// test/collector/arch/win32/identity-real.test.mjs — the win32 third of the real-OS identity contract (0.1 §3 约定 2 / 3 / 10, G7).
// The darwin and linux halves run with `npm test` on their own machines (test/collector/arch/{darwin,linux}/identity-real.test.mjs
// over test/helpers/real-procs.mjs); a Windows process table is read only on a Windows test machine, so here the gap is a skip with
// its reason — never a green it did not earn.
import test from 'node:test'

test('win32: the real Get-CimInstance process table goes through the same identity table', { skip: 'the real win32 contract runs on a Windows test machine only' }, () => {})
