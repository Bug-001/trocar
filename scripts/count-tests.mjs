#!/usr/bin/env node
// scripts/count-tests.mjs — CI's check that every Node version ran every test.
//
//   node scripts/count-tests.mjs read <test-output> <os> <node>   → one JSON line {os, node, tests, pass, fail, ...} on stdout
//   node scripts/count-tests.mjs compare <dir>                    → reads every *.json `read` wrote, exits 1 unless each OS agrees
//                                                                   on the number of tests across its Node versions
//
// Why: a run that drops test results does not fail — `--test-force-exit` on Node 20 reported 1903 to 1924 of 1936 tests, all
// "0 fail" (see test/helpers/flush-exit.mjs). The same suite on the same OS runs the same tests on Node 20 and 22, so a count
// that differs between the two is a run that lost some. (.github/workflows/ci.yml: each matrix job writes its count, the
// `counts-agree` job compares them.)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const KEYS = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']

/** The runner's summary lines (`# tests 1940` in TAP, `ℹ tests 1940` in spec) → {tests, pass, fail, cancelled, skipped, todo}. */
export function parseCounts(output) {
  const counts = {}
  for (const key of KEYS) {
    const all = [...output.matchAll(new RegExp(`^(?:#|ℹ) ${key} (\\d+)\\s*$`, 'gm'))]
    if (all.length === 0) throw new Error(`no "${key}" summary line in the test output — the run did not finish, or the reporter has no summary`)
    counts[key] = Number(all.at(-1)[1]) // the root summary is the last one
  }
  return counts
}

/** entries: [{os, node, tests, ...}] → {ok, lines, problems}. Every OS needs ≥ 2 Node versions, and all must have run the same number of tests. */
export function compareCounts(entries) {
  const byOs = new Map()
  for (const e of entries) byOs.set(e.os, [...(byOs.get(e.os) ?? []), e])
  const lines = [], problems = []
  if (byOs.size === 0) problems.push('no counts to compare')
  for (const [os, list] of [...byOs].sort(([a], [b]) => a.localeCompare(b))) {
    list.sort((a, b) => Number(a.node) - Number(b.node))
    lines.push(`${os}: ${list.map((e) => `Node ${e.node} ran ${e.tests} tests (${e.pass} pass, ${e.fail} fail, ${e.skipped} skipped)`).join('; ')}`)
    if (list.length < 2) problems.push(`${os}: only Node ${list[0].node} reported a count — there is nothing to compare it with`)
    else if (new Set(list.map((e) => e.tests)).size > 1) problems.push(`${os}: ${list.map((e) => `Node ${e.node} ran ${e.tests}`).join(', ')} tests — a run is dropping results`)
  }
  return { ok: problems.length === 0, lines, problems }
}

function main(argv) {
  const [cmd, a, os, node] = argv
  if (cmd === 'read' && a && os && node) {
    process.stdout.write(JSON.stringify({ os, node, ...parseCounts(fs.readFileSync(a, 'utf8')) }) + '\n')
    return 0
  }
  if (cmd === 'compare' && a) {
    const entries = fs.readdirSync(a).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(a, f), 'utf8')))
    const { ok, lines, problems } = compareCounts(entries)
    const text = [...lines, ...problems.map((p) => `MISMATCH ${p}`)].join('\n') + '\n'
    process.stdout.write(text)
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### Test counts per OS and Node version\n\n```\n' + text + '```\n')
    return ok ? 0 : 1
  }
  process.stderr.write('usage: count-tests.mjs read <test-output> <os> <node> | compare <dir>\n')
  return 2
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) process.exitCode = main(process.argv.slice(2))
