// test/rules/helpers/writer.mjs — one writer of the rule file in its own process, for what only separate processes can show (test/rules/file-lock.test.mjs,
// and the shapes that would hang this process if the reader blocked). argv[2] is a JSON job; with none it does nothing, because `node --test` runs every
// file under test/. Prints one JSON line: {read, result}, and `{fn:true}` first when the job stops or dies inside the edit.
import fs from 'node:fs'
import { edit, readRules } from '../../../src/rules/file.mjs'
import { normalizeRule } from '../../../src/rules/validate.mjs'

export const rule = (name) => normalizeRule({ name, match: { harness: 'codex', host: 'a.test' }, do: [{ delay_ms: 1 }], on_error: 'forward' })

const say = (value) => fs.writeSync(1, JSON.stringify(value) + '\n')
const job = process.argv[2] ? JSON.parse(process.argv[2]) : null

if (job) {
  if (job.startAt) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, job.startAt - Date.now()))
  const add = (doc) => {
    if (job.inFn) { say({ fn: true }); process.kill(process.pid, job.inFn) }
    return { ...doc, rules: [...doc.rules, rule(job.name)] }
  }
  const read = job.read ? readRules({ home: job.home }) : undefined
  say({ read, result: edit(add, { home: job.home, op: 'add', onBad: job.onBad }) })
}
