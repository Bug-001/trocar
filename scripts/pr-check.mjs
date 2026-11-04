#!/usr/bin/env node
// scripts/pr-check.mjs — what is about to leave this machine, checked against the rules and against the capture (spec 1.12 §6).
//
//   node scripts/pr-check.mjs --before <time> --title <file> --body <file> [--base <ref>] [--budget <bytes>] [--json]
//   node scripts/pr-check.mjs --issue --before <time> [--title <file>] --body <file> [--base <ref>] [--budget <bytes>] [--json]
//
// The report is {ok, hash, findings: [{rule, where, why}], coverage: {scanned_bytes, total_bytes, from, to}, leaving: {files, commits,
// identity, branch}}. Exit 0 passed, 1 refused, 2 usage error. A finding names a place and a rule, never a value: `where` points into
// `leaving.files` by index, because a path is outbound text too, and `why` is one constant sentence per rule. Captured bytes pass through
// this process to be compared, and nothing of them is printed. There is no override: what cannot be read is a refusal, not an empty result.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { parseTime } from '../src/query/named/index.mjs'
import { SEALED_EXT } from '../src/raw/seal.mjs'
import { normalize, WindowTable } from './lib/text-windows.mjs'

const USAGE = `usage: node scripts/pr-check.mjs --before <time> --title <file> --body <file> [--base <ref>] [--budget <bytes>] [--json]
       node scripts/pr-check.mjs --issue --before <time> [--title <file>] --body <file> [--base <ref>] [--budget <bytes>] [--json]`
const CLI = fileURLToPath(new URL('../bin/trocar.mjs', import.meta.url))
const BUDGET = 2e9
const PAGE = ['--limit', '500'] // 1.6 §4.1: the largest page of a list query
const SHORT_SHA = 10
const MAX_LINES = 400
const MIN_FACT = 4
const BOARD = 'src/web/board/'
const LOCK = /(?:^|\/)package-lock\.json$/
const isUncounted = (file) => file.startsWith('test/fixtures/') || file.startsWith(BOARD) || LOCK.test(file)
const INTEGRITY = /"integrity":\s*"[^"]*"/g
const BLOCKED = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tif', '.tiff', '.heic', '.heif', '.avif', // images, SVG is text
  '.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.pdf', '.zip', '.gz', '.tgz', '.tar', '.bz2', '.xz', '.zst', '.7z', '.rar',
  '.ndjson', SEALED_EXT, '.har', '.pcap', '.pcapng'])
const TOKEN = new RegExp([
  /\bsk-[A-Za-z0-9_-]{20,}/, /\bgh[pos]_[A-Za-z0-9_]{20,}/, /\bxox[a-z]-[A-Za-z0-9-]{10,}/, /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
].map((r) => r.source).join('|'), 'g')
const CREDENTIAL = /(?:authorization|x-api-key)\\*["']?\s*[:=]\s*\\*["']?(?:(?:bearer|basic|token)\s+)?[A-Za-z0-9._~+/=-]{12,}/gi
const LONG_RUN = /[A-Za-z0-9+=_-]{40,}/g // no slash: a URL or file path is not one run, and base64 holds runs this long between its slashes
const isMixed = (run) => /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run)
const SEP = String.raw`(?:\\+/?|/)` // a slash, a run of backslashes, an escaped slash
const HOME_PATH = new RegExp(`${SEP}(?:users|home)${SEP}([^\\s\\\\/"'$<>{}*]+)${SEP}`, 'gi')
const NEUTRAL = new Set(['me', 'you', 'user', 'alice', 'bob', 'test', 'runner', 'someone'])
const NOREPLY = /(?:@users\.noreply\.github\.com|^noreply@github\.com)$/i
const CONTROL = /[\x00-\x08]/g
const RECORD_TS = /^\{"ts":"([^"]+)"/
const NEWLINE = Buffer.from('\n')

const WHY = {
  files: 'This file type does not leave the machine: images, video, PDF, archives, capture formats and binaries.',
  build: 'The built board does not match a rebuild: npm run test:build failed.',
  secrets: 'This has the shape of a credential.',
  identity: 'This names this machine, its user or a home directory.',
  email: 'The commit email is not a GitHub noreply address. Run git config user.email with your noreply address, then git rebase --exec "git commit --amend --no-edit --reset-author" onto the base.',
  'captured-facts': 'This matches a project, session, title, host or segment in your capture.',
  'captured-text': 'At least 60 normalized bytes of this also occur in your capture.',
  lines: `This commit changes more than ${MAX_LINES} lines.`,
  body: 'This commit message has no body.',
  control: 'This holds control bytes.',
  git: 'git could not be read, so what is leaving is not known.',
  capture: 'The capture could not be read, so it was not compared.',
}

function parse(argv) {
  let values
  try {
    ({ values } = parseArgs({ args: argv, options: { before: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, base: { type: 'string' },
      budget: { type: 'string' }, issue: { type: 'boolean' }, json: { type: 'boolean' } } }))
    if (!values.before || !values.body || !(values.title || values.issue)) return null
    const budget = values.budget === undefined ? BUDGET : Number(values.budget)
    if (!Number.isSafeInteger(budget) || budget < 0) return null
    return { ...values, budget, before: parseTime(values.before), base: values.base ?? 'origin/main',
      title: values.title && fs.readFileSync(values.title), body: fs.readFileSync(values.body) }
  } catch {
    return null
  }
}

const normalized = (bytes) => Buffer.from(normalize(bytes).buffer)
const wordOf = (text) => normalized(Buffer.from(text))

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, maxBuffer: Infinity, stdio: ['ignore', 'pipe', 'ignore'] })
  if (r.status !== 0) throw new Error('git')
  return r.stdout
}

/** `git show --numstat -z`: {path, lines, binary} per file; a rename is an empty name followed by the old one and the new one. */
function numstat(out) {
  const fields = out.toString().split('\0')
  const files = []
  for (let i = 0; i + 1 < fields.length; i++) {
    const [added, deleted, name] = fields[i].split('\t')
    if (!name) i += 2
    files.push({ path: name || fields[i], binary: added === '-', lines: (Number(added) || 0) + (Number(deleted) || 0) })
  }
  return files
}

/** `git show --unified=0`, one entry per file in numstat's order: the added lines, the line each has in the new file, and whether the file went away. */
function patches(out) {
  const files = []
  let file = null, inHunk = false, line = 0
  for (let at = 0; at < out.length;) {
    const nl = out.indexOf(10, at), end = nl < 0 ? out.length : nl
    const row = out.subarray(at, end)
    at = end + 1
    if (row.subarray(0, 11).toString() === 'diff --git ') {
      files.push(file = { added: [], lines: [], gone: false })
      inHunk = false
    } else if (row[0] === 0x40) { // @@ -a,b +c,d @@
      inHunk = true
      line = Number(/\+(\d+)/.exec(row.toString('latin1'))[1])
    } else if (inHunk && row[0] === 0x2b) {
      file.added.push(row.subarray(1))
      file.lines.push(line++)
    } else if (!inHunk && file && row.subarray(0, 12).toString() === 'deleted file') {
      file.gone = true
    }
  }
  return files
}

/** Everything `base..HEAD` takes out, into `out`. A merge brings its message and author only: its diff is its parents' commits. */
function readGit(cwd, base, out) {
  out.leaving.branch = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').toString().trim()
  out.sources.push({ where: 'branch', kind: 'branch', bytes: Buffer.from(out.leaving.branch) })
  const index = new Map()
  for (const sha of git(cwd, 'rev-list', '--reverse', `${base}..HEAD`).toString().split('\n').filter(Boolean)) {
    const short = sha.slice(0, SHORT_SHA)
    const [parents, authorName, authorEmail, committerName, committerEmail, message] = git(cwd, 'log', '-1', '--format=%P%x00%an%x00%ae%x00%cn%x00%ce%x00%B', sha).toString().split('\0')
    const people = [`${authorName} <${authorEmail}>`, `${committerName} <${committerEmail}>`]
    for (const person of people) if (!out.leaving.identity.includes(person)) out.leaving.identity.push(person)
    out.leaving.commits.push({ sha: short, subject: message.split('\n')[0] })
    out.sources.push({ where: `${short}:message`, kind: 'message', bytes: Buffer.from(message) })
    // the noreply address is a public login, judged by the email rule; the names are what the identity words read
    out.sources.push({ where: `${short}:author`, kind: 'author', bytes: Buffer.from(people.join('\n')), norm: wordOf(`${authorName}\n${committerName}`) })
    const commit = { short, message, merge: parents.includes(' '), emails: [authorEmail, committerEmail], lines: 0, changed: [] }
    out.commits.push(commit)
    if (commit.merge) continue
    const stats = numstat(git(cwd, 'show', '--format=', '--numstat', '-z', '-M', sha))
    const diffs = patches(git(cwd, 'show', '--format=', '--unified=0', '--no-color', '--no-ext-diff', '--no-textconv', '-M', sha))
    if (stats.length !== diffs.length) throw new Error('git')
    stats.forEach((stat, i) => {
      if (!isUncounted(stat.path)) commit.lines += stat.lines
      if (diffs[i].gone) return
      if (!index.has(stat.path)) index.set(stat.path, out.leaving.files.push(stat.path) - 1)
      const where = `${short}:file#${index.get(stat.path)}`
      commit.changed.push({ ...stat, where })
      out.sources.push({ where, kind: 'path', bytes: Buffer.from(stat.path) })
      out.sources.push({ where, kind: 'added', path: stat.path, lines: diffs[i].lines, bytes: Buffer.concat(diffs[i].added.flatMap((row) => [row, NEWLINE])) })
    })
  }
}

/** The whole outbound text, source by source, in a form that changes when any of its bytes does. */
function hashOf(sources) {
  const hash = createHash('sha256')
  for (const s of sources) hash.update(`${s.kind}\0${s.where}\0${s.bytes.length}\0`).update(s.bytes)
  return hash.digest('hex')
}

/** `where`, narrowed to the line of the new file a match at `index` sits on, when the source knows its lines. */
function placeOf(source, text, index) {
  if (!source.lines) return source.where
  let row = 0
  for (let at = text.indexOf('\n'); at >= 0 && at < index; at = text.indexOf('\n', at + 1)) row++
  return source.lines[row] === undefined ? source.where : `${source.where}:${source.lines[row]}`
}

function checkFiles(commits, cwd, add) {
  let board = null
  for (const commit of commits) {
    for (const file of commit.changed) {
      if (file.path.startsWith(BOARD)) board ??= file.where
      else if (file.binary || BLOCKED.has(file.path.slice(file.path.lastIndexOf('.')).toLowerCase())) add('files', file.where)
    }
  }
  if (board && spawnSync('npm', ['run', 'test:build'], { cwd, stdio: 'ignore', shell: process.platform === 'win32' }).status !== 0) add('files', board, WHY.build)
}

function checkShape(commits, sources, add) {
  for (const commit of commits) {
    if (commit.lines > MAX_LINES) add('shape', commit.short, WHY.lines)
    if (commit.merge) continue
    const paragraphs = commit.message.trim().split(/\n\s*\n/).slice(1)
    const trailers = paragraphs.at(-1)?.split('\n').every((row) => /^[A-Za-z][A-Za-z0-9-]*: /.test(row))
    if (paragraphs.length - (trailers ? 1 : 0) < 1) add('shape', `${commit.short}:message`, WHY.body)
  }
  for (const source of sources) {
    if (source.kind !== 'added' && source.kind !== 'message') continue
    const text = source.bytes.toString()
    for (const match of text.matchAll(CONTROL)) add('shape', placeOf(source, text, match.index), WHY.control)
  }
}

function checkSecrets(sources, add) {
  for (const source of sources) {
    const text = source.bytes.toString()
    const hit = (match) => { if (!match[0].includes('FAKE')) add('secrets', placeOf(source, text, match.index)) }
    for (const match of text.matchAll(TOKEN)) hit(match)
    for (const match of text.matchAll(CREDENTIAL)) hit(match)
    if (source.path?.startsWith(BOARD)) continue
    const runs = source.path && LOCK.test(source.path) ? text.replace(INTEGRITY, '') : text
    for (const match of runs.matchAll(LONG_RUN)) if (isMixed(match[0])) hit(match)
  }
}

function checkIdentity(out, cwd, hold, add) {
  const host = os.hostname()
  const names = [os.userInfo().username, host, host.split('.')[0], process.env.USER, process.env.LOGNAME, process.env.USERNAME, process.env.COMPUTERNAME]
  const gitName = spawnSync('git', ['config', '--get', 'user.name'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).stdout?.toString().trim()
  const own = wordOf(gitName || '')
  for (const word of [...names.filter(Boolean).map(wordOf), own]) {
    if (word.length === 0) continue
    for (const source of out.sources) {
      if (source.kind === 'author' && word.equals(own)) continue
      if (source.norm.includes(word)) hold(word, 'identity', source.where)
    }
  }
  for (const source of out.sources) {
    const raw = source.bytes.toString()
    const decoded = raw.replace(/\\+u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    for (const text of raw === decoded ? [raw] : [raw, decoded]) {
      for (const match of text.matchAll(HOME_PATH)) {
        if (!NEUTRAL.has(match[1].toLowerCase())) hold(wordOf(match[0]), 'identity', placeOf(source, text, match.index))
      }
    }
  }
  for (const commit of out.commits) if (!commit.emails.every((email) => NOREPLY.test(email))) add('identity', `${commit.short}:author`, WHY.email)
}

/** What `trocar` answered, as a document; a query that could not read the capture says so with `ok: false`. */
function ask(...args) {
  const r = spawnSync(process.execPath, [CLI, 'query', ...args], { maxBuffer: Infinity, stdio: ['ignore', 'pipe', 'ignore'] })
  let doc = null
  try { doc = JSON.parse(r.stdout) } catch { /* no document is the failure below */ }
  if (r.status !== 0 || doc?.ok !== true) throw new Error('capture')
  return doc
}

function allPages(name, key) {
  const rows = []
  for (let after = null; ;) {
    const doc = ask(name, ...PAGE, ...(after === null ? [] : ['--after', String(after)]))
    rows.push(...doc[key])
    if (doc.next == null || doc.next === after) return rows
    after = doc.next
  }
}

/** The capture's facts as words; a segment's name also covers every `<segment>:<n>` record id. Returns the segments for the text pass. */
function checkFacts(sources, hold) {
  const segments = ask('segments').segments
  const facts = [...allPages('sessions', 'sessions').flatMap((s) => [s.project_path, s.project_slug, s.session_id, s.title]),
    ...allPages('traffic', 'hosts').map((h) => h.host), ...segments.map((s) => s.segment)]
  const words = new Map()
  for (const fact of facts) {
    if (typeof fact !== 'string') continue
    const word = wordOf(fact)
    if (word.toString().length >= MIN_FACT) words.set(word.toString('latin1'), word)
  }
  for (const word of words.values()) {
    for (const source of sources) if (source.norm.includes(word)) hold(word, 'captured-facts', source.where)
  }
  return segments
}

/** §6.3: what `base` already tracks is public. One pass over its blobs takes their windows out of `table` and their words out of `held`. */
function subtractBase(cwd, base, table, held) {
  const ids = git(cwd, 'ls-tree', '-r', '-z', base).toString().split('\0').filter((e) => e.split(' ')[1] === 'blob').map((e) => e.split(' ')[2].split('\t')[0])
  const r = spawnSync('git', ['cat-file', '--batch'], { cwd, input: ids.map((id) => `${id}\n`).join(''), maxBuffer: Infinity, stdio: ['pipe', 'pipe', 'ignore'] })
  if (r.status !== 0) throw new Error('git')
  for (let at = 0; at < r.stdout.length;) {
    const nl = r.stdout.indexOf(10, at) // <id> blob <size>
    const size = Number(r.stdout.subarray(at, nl).toString('latin1').split(' ')[2])
    const blob = r.stdout.subarray(nl + 1, nl + 1 + size)
    at = nl + size + 2
    table.scan(blob, (slot) => table.drop(slot))
    if (held.size === 0) continue
    const text = normalized(blob)
    for (const [key, entry] of held) if (text.includes(entry.word)) held.delete(key)
  }
}

/** Streams each segment through `table`, newest first, until the budget or the table runs out. Returns the coverage. */
async function compareCapture(segments, { before, budget }, table, add) {
  const wanted = segments.filter((s) => !s.from || Date.parse(s.from) < before).sort((a, b) => b.segment.localeCompare(a.segment))
  const coverage = { scanned_bytes: 0, total_bytes: wanted.reduce((n, s) => n + s.bytes, 0), from: null, to: null }
  const spent = () => coverage.scanned_bytes >= budget || table.size === 0
  const take = (line, ending) => {
    coverage.scanned_bytes += line.length + ending
    const ts = RECORD_TS.exec(line.subarray(0, 64).toString('latin1'))?.[1]
    const time = Date.parse(ts)
    if (time >= before) return
    table.scan(line, (slot) => { add('captured-text', table.whereOf(slot)); table.drop(slot) })
    if (Number.isNaN(time)) return
    if (coverage.from === null || time < Date.parse(coverage.from)) coverage.from = ts
    if (coverage.to === null || time > Date.parse(coverage.to)) coverage.to = ts
  }
  for (const segment of wanted) {
    if (spent()) break
    const kid = spawn(process.execPath, [CLI, 'raw', segment.segment], { stdio: ['ignore', 'pipe', 'ignore'] })
    const exit = new Promise((resolve) => { kid.on('close', resolve); kid.on('error', () => resolve(-1)) })
    let parts = []
    for await (const chunk of kid.stdout) {
      let at = 0
      for (let nl = chunk.indexOf(10); nl >= 0 && !spent(); nl = chunk.indexOf(10, at)) {
        parts.push(chunk.subarray(at, nl))
        take(parts.length === 1 ? parts[0] : Buffer.concat(parts), 1)
        parts = []
        at = nl + 1
      }
      if (spent()) break
      if (at < chunk.length) parts.push(chunk.subarray(at))
    }
    if (spent()) {
      kid.kill()
      await exit
      break
    }
    if (parts.length > 0) take(Buffer.concat(parts), 0)
    if (await exit !== 0) add('unreadable', 'capture', WHY.capture)
  }
  return coverage
}

function print(doc) {
  const lines = [`pr-check: ${doc.ok ? 'passed' : `refused, ${doc.findings.length} finding${doc.findings.length === 1 ? '' : 's'}`}`]
  for (const f of doc.findings) lines.push(`  ${f.rule}  ${f.where}  ${f.why}`)
  const { scanned_bytes: scanned, total_bytes: total, from, to } = doc.coverage
  lines.push(`hash ${doc.hash}`, `capture compared: ${scanned} of ${total} bytes${from ? `, ${from} to ${to}` : ''}`)
  if (doc.leaving.branch) lines.push(`branch ${doc.leaving.branch}`)
  for (const person of doc.leaving.identity) lines.push(`identity ${person}`)
  for (const commit of doc.leaving.commits) lines.push(`commit ${commit.sha} ${commit.subject}`)
  doc.leaving.files.forEach((file, i) => lines.push(`file #${i} ${file}`))
  process.stdout.write(`${lines.join('\n')}\n`)
}

async function main() {
  const options = parse(process.argv.slice(2))
  if (!options) {
    process.stderr.write(`${USAGE}\n`)
    process.exitCode = 2
    return
  }
  const cwd = process.cwd()
  const found = new Map()
  const add = (rule, where, why = WHY[rule]) => found.set(`${rule}\0${where}\0${why}`, { rule, where, why })
  const held = new Map() // word → the hits that wait for §6.3: a word `base` already holds is public
  const hold = (word, rule, where) => {
    const key = word.toString('latin1')
    if (!held.has(key)) held.set(key, { word, hits: [] })
    held.get(key).hits.push({ rule, where })
  }
  const out = { sources: [], commits: [], leaving: { files: [], commits: [], identity: [], branch: null } }
  if (!options.issue) {
    try { readGit(cwd, options.base, out) } catch { add('unreadable', 'git', WHY.git) }
  }
  if (options.title) out.sources.push({ where: 'title', kind: 'title', bytes: options.title })
  out.sources.push({ where: 'body', kind: 'body', bytes: options.body })
  for (const source of out.sources) source.norm ??= normalized(source.bytes)

  checkFiles(out.commits, cwd, add)
  checkShape(out.commits, out.sources, add)
  checkSecrets(out.sources, add)
  checkIdentity(out, cwd, hold, add)
  let segments = []
  try { segments = checkFacts(out.sources, hold) } catch { add('unreadable', 'capture', WHY.capture) }

  const table = new WindowTable(out.sources)
  const hasBase = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${options.base}^{commit}`], { cwd, stdio: 'ignore' }).status === 0
  if (hasBase) {
    try { subtractBase(cwd, options.base, table, held) } catch { add('unreadable', 'git', WHY.git) }
  }
  for (const { hits } of held.values()) for (const hit of hits) add(hit.rule, hit.where)
  const coverage = await compareCapture(segments, options, table, add)

  const findings = [...found.values()]
  const doc = { ok: findings.length === 0, hash: hashOf(out.sources), findings, coverage, leaving: out.leaving }
  if (options.json) process.stdout.write(`${JSON.stringify(doc)}\n`)
  else print(doc)
  process.exitCode = doc.ok ? 0 : 1
}

await main()
