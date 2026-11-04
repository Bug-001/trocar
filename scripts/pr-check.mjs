#!/usr/bin/env node
// scripts/pr-check.mjs — what is about to leave this machine, checked against the rules and against the capture (spec 1.12 §6).
//
//   node scripts/pr-check.mjs --before <time> --title <file> --body <file> [--base <ref>] [--accept-partial] [--cli <path>] [--json]
//   node scripts/pr-check.mjs --issue --before <time> [--title <file>] --body <file> [--base <ref>] [--accept-partial] [--cli <path>] [--json]
//
// The report is {ok, hash, findings: [{rule, where, why}], accepted: [{rule, where, why}], coverage: {scanned_bytes, opaque_bytes, after_bytes,
// total_bytes, from, to}, leaving: {files, commits, identity, branch}}. Exit 0 passed, 1 refused, 2 usage error. A finding names a place and a rule, never a value: `where` points into
// `leaving.files` by index, because a path is outbound text too, and `why` is one constant sentence per rule. Captured bytes pass through
// this process to be compared, and nothing of them is printed. What cannot be read is a refusal, not an empty result. For the capture that
// is a `partial` finding, the one rule --accept-partial moves to `accepted`, and the hash holds what it let through. The capture is read
// through the installed trocar, or the one --cli names: its reads go by the daemon and may write the derived layer, never the raw records.
import { isUtf8 } from 'node:buffer'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { parseTime } from '../src/query/named/index.mjs'
import { SEALED_EXT } from '../src/raw/seal.mjs'
import { foldedRuns, isHex, longRuns, opened } from './lib/encoded-text.mjs'
import { textsBehind } from './lib/record-text.mjs'
import { normalize, WindowTable } from './lib/text-windows.mjs'
import { callOf, findCli } from './lib/trocar-cli.mjs'

const USAGE = `usage: node scripts/pr-check.mjs --before <time> --title <file> --body <file> [--base <ref>] [--accept-partial] [--cli <path>] [--json]
       node scripts/pr-check.mjs --issue --before <time> [--title <file>] --body <file> [--base <ref>] [--accept-partial] [--cli <path>] [--json]`
const CLONE = fileURLToPath(new URL('..', import.meta.url))
const PAGE = ['--limit', '500'] // 1.6 §4.1: the largest page of a list query
const SHORT_SHA = 10
const MAX_LINES = 400
const MIN_FACT = 4
const GIT_BINARY_PEEK = 8000 // how far git looks for a NUL to call a file binary
const MAX_WORK_MS = 7 * 86_400_000 // a --before further back than this leaves the recent capture out, whatever the reason
const BOARD = 'src/web/board/'
const BOARD_INPUT = 'web/'
const LOCK = /(?:^|\/)package-lock\.json$/
const isUncounted = (file) => file.startsWith('test/fixtures/') || file.startsWith(BOARD) || LOCK.test(file)
const INTEGRITY = /"integrity":\s*"[^"]*"/g
const BLOCKED = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tif', '.tiff', '.heic', '.heif', '.avif', // images, SVG is text
  '.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.pdf', '.zip', '.gz', '.tgz', '.tar', '.bz2', '.xz', '.zst', '.7z', '.rar',
  '.ndjson', SEALED_EXT, '.har', '.pcap', '.pcapng'])
const TOKEN = new RegExp([
  /\bsk-[A-Za-z0-9_-]{20,}/, /\b[sr]k_live_[A-Za-z0-9_]{16,}/, /\bgh[oprsu]_[A-Za-z0-9_]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{30,}/, /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bAIza[A-Za-z0-9_-]{35,}/, /\bhf_[A-Za-z0-9_]{30,}/, /\bnpm_[A-Za-z0-9_]{30,}/, /\bxox[a-z]-[A-Za-z0-9-]{10,}/, /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/,
].map((r) => r.source).join('|'), 'g')
const VALUE = '[A-Za-z0-9._~+/=-]{12,}'
const ASSIGNED = String.raw`\\*["']?\s*[:=]\s*\\*["']?`
const CREDENTIAL = new RegExp(`(?:authorization|x-api-key|x-goog-api-key)${ASSIGNED}(?:(?:bearer|basic|token)\\s+)?${VALUE}`, 'gi')
// these names sit next to code and prose as well, and a digit in the value is what tells `password: config.userPassword` from a password
const VALUED = new RegExp(`(?:(?:(?:set-)?cookie|api[_-]?key|password)${ASSIGNED}|\\bbearer\\s+)(?=[^\\s"']*\\d)${VALUE}`, 'gi')
const LINE_BREAK = /[ \t]*\r?\n[ \t]*/g
const isFake = (value) => /(?:^|[^A-Za-z0-9])FAKE(?:[^A-Za-z0-9]|$)/.test(value) // standing alone: run into a token it is part of the token
// what makes an SVG more than vector: anything of another kind inside it, or a reference to anything but itself
const SVG_EMBED = /data:|<(?:[\w-]+:)?(?:image|feimage|img)\b|\bsrc\s*=|url\(\s*(?!["']?#)|href\s*=\s*["'](?!#)/i
// a pointer passes as text, and what `git lfs push` sends with it is never read here
const LFS_POINTER = /^(?:version https:\/\/git-lfs\.github\.com\/spec\/|oid sha256:[0-9a-f]{64}$)/m
const LFS_FILTER = /\bfilter=lfs\b/
const GITATTRIBUTES = /(?:^|\/)\.gitattributes$/
const LONG_RUN = /[A-Za-z0-9+=_-]{40,}/g // no slash: a URL or file path is not one run, and base64 holds runs this long between its slashes
const isMixed = (run) => /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run)
const SEP = String.raw`(?:\\+/?|/)` // a slash, a run of backslashes, an escaped slash
const HOME_NAME = String.raw`[^\s\\/"'$<>{}*,;:()[\]]+`
// only a separator closes a name with a space in it: anywhere else the space is the sentence going on
const HOME_PATH = new RegExp(`${SEP}(?:Users|home)${SEP}(${HOME_NAME}(?: ${HOME_NAME})?(?=${SEP})|${HOME_NAME}(?=$|[\\s"',;:()[\\]]))`, 'g')
const GAP = '[\\t\\r\\n ]*' // a URL parser drops tabs and newlines, and a data: URI survives the rest
const spaced = (word) => [...word].join(GAP)
// a bitmap, or anything in base64: SVG as text is text. Up to a quote, a bracket or a space, where the address ends, so that only the same image is already public, whatever else its line holds
const DATA_IMAGE = new RegExp(`${spaced('data:')}${GAP}(?:${spaced('image')}${GAP}(?!${SEP}${GAP}${spaced('svg')}(?![^,\\s]*;${GAP}${spaced('base64')}))${SEP}|;${GAP}[^,\\r\\n]*?${spaced('base64')})[\\w.~:/?#@!$&*+,;=%\\\\-]*`, 'gi')
const HAS_PAYLOAD = /,./ // past the comma: without it this is only how a URI starts, and that is public everywhere
const ENTITY = /&(?:#(\d+)|#x([0-9a-f]+)|(colon|sol|tab|newline));?/gi
const NAMED = { colon: ':', sol: '/', tab: '\t', newline: '\n' }
const POSTED_IMAGE = /!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])?|<(?:img|video)\b[^>]*>?|github\.com\/user-attachments\/\S*/gi
const NEUTRAL = new Set(['me', 'you', 'user', 'alice', 'bob', 'test', 'runner', 'someone'])
const NOREPLY = /^(?:(?:\d+\+)?[a-z0-9-]+@users\.noreply\.github\.com|noreply@github\.com)$/i // the second is the committer of a web edit
const CONTROL = /[\x00-\x08]/g
const TEXT_KINDS = new Set(['added', 'message', 'header', 'title', 'body'])
const CONTROL_KINDS = new Set(['added', 'message', 'path', 'title', 'body'])
const RECORD_TS = /^\{"ts":"([^"]+)"/
const DIFF_HEADER = 'diff --git '
const NEWLINE = Buffer.from('\n')
const STANDARD_HEADER = /^(?:tree|parent|author|committer|encoding) .*\n/gm
const SIGNATURE = /^gpgsig(?:-sha256)? .*\n(?: .*\n)*/gm
const PERSON = (role) => new RegExp(`^${role} (.*) <(.*)> \\d+ [+-]\\d+$`, 'm')
const ALNUM = String.raw`[\p{L}\p{N}]`
const isAlnum = (char) => char !== undefined && new RegExp(ALNUM, 'u').test(char)
// the row of .github/pull_request_template.md the hash is written on: it cannot hold its own hash, and holds nothing else or it counts.
// What it holds is left out of the hash, so main refuses any value but the hash: it is no way out for 32 unjudged bytes, and no mistaken paste.
const HASH_ROW = /^- Written by an agent: the `hash` from `node scripts\/pr-check\.mjs`:[ \t]*(?:(`?)([0-9a-f]{64})\1[ \t]*)?\r?$/gm

const WHY = {
  files: 'This file type does not leave the machine: images, video, PDF, archives, capture formats and binaries.',
  image: 'This holds an image in its text: a data URI anywhere, or a Markdown image, an img or video tag or an uploaded attachment in a title, a body or a comment.',
  build: 'The built board does not match a rebuild: web/ or src/web/board/ differs from HEAD in the working tree, or npm run test:build failed.',
  foreign: 'The built board changed in a clone that is not this script\'s, and nothing from another clone is run here: rebuild it in isolation.',
  secrets: 'This has the shape of a credential.',
  identity: 'This names this machine, its user or a home directory.',
  email: 'The commit email is not a GitHub noreply address. Run git config user.email with your noreply address, then git rebase --exec "git commit --amend --no-edit --reset-author" onto the base.',
  'captured-facts': 'This matches a project, session, title, host or segment in your capture.',
  'captured-text': 'At least 60 normalized bytes of this also occur in your capture.',
  lines: `This commit changes more than ${MAX_LINES} lines.`,
  body: 'This commit message has no body.',
  control: 'This holds control bytes.',
  hash: 'The hash line holds a value this run did not print: leave it empty, or write the hash this run printed.',
  encoding: 'This is not valid UTF-8, so it cannot be compared: write it as UTF-8.',
  merge: 'This is a merge commit, and a branch goes out without them: rebase it onto the base.',
  git: 'git could not be read, so what is leaving is not known.',
  base: 'No remote main holds the commit this branch stands on, or nothing is past it: fetch the project\'s main, then rebase the branch onto it.',
  query: 'trocar query could not read the capture, so it was not compared.',
  title: 'A session title could not be read yet, so it was not compared.',
  raw: 'A segment of the capture could not be read to its end, so the rest of it was not compared.',
  opaque: 'Some records could not be opened, so what is behind them was not compared: opaque_bytes counts them.',
  nothing: 'The capture holds records and none of them was compared: all of them are at or past --before, or could not be read.',
  early: 'This --before is over a week old and records after it were skipped: after_bytes counts them.',
}

function parse(argv) {
  let values
  try {
    ({ values } = parseArgs({ args: argv, options: { before: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, base: { type: 'string' },
      'accept-partial': { type: 'boolean' }, cli: { type: 'string' }, issue: { type: 'boolean' }, json: { type: 'boolean' } } }))
    if (!values.before || !values.body || !(values.title || values.issue)) return null
    const cli = findCli(values.cli)
    if (!cli) return null
    return { ...values, cli, before: parseTime(values.before), base: values.base ?? 'origin/main',
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
    const columns = fields[i].split('\t')
    const [added, deleted] = columns, name = columns.slice(2).join('\t')
    if (!name) i += 2
    files.push({ path: name || fields[i], binary: added === '-', lines: (Number(added) || 0) + (Number(deleted) || 0) })
  }
  return files
}

/** `git show --unified=0`, one entry per file: the added lines, the line each has in the new file, and whether the file went away. A file
 *  that became a link or the reverse is printed as a deletion and a creation under one header, and is one entry that did not go away,
 *  whichever comes first. */
function patches(out) {
  const files = []
  let file = null, header = null, inHunk = false, line = 0
  for (let at = 0; at < out.length;) {
    const nl = out.indexOf(10, at), end = nl < 0 ? out.length : nl
    const row = out.subarray(at, end)
    at = end + 1
    if (row.subarray(0, DIFF_HEADER.length).toString('latin1') === DIFF_HEADER) {
      const split = header?.equals(row)
      if (!split) files.push(file = { added: [], lines: [], gone: false, split: false })
      else Object.assign(file, { gone: false, split: true })
      header = row
      inHunk = false
    } else if (row[0] === 0x40) { // @@ -a,b +c,d @@
      inHunk = true
      line = Number(/\+(\d+)/.exec(row.toString('latin1'))[1])
    } else if (inHunk) {
      if (row[0] !== 0x2b) continue // not in the new file: a removed line, or `\ No newline`
      file.added.push(row.subarray(1))
      file.lines.push(line++)
    } else if (file && row.subarray(0, 12).toString() === 'deleted file') {
      file.gone = !file.split
    }
  }
  return files
}

/** What one commit brings, or what lies between two, {stats, diffs} file by file. */
function brought(cwd, ...revs) {
  const read = (...args) => git(cwd, ...(revs.length === 1 ? ['show', '--format='] : ['diff']), '-M', '--no-relative', ...args, ...revs)
  const diffs = patches(read('--unified=0', '--no-color', '--no-ext-diff', '--no-textconv'))
  const stats = numstat(read('--numstat', '-z'))
  if (stats.length !== diffs.length) throw new Error('git')
  return { stats, diffs }
}

/** Whether a text of the base holds `word` as a word: its pieces in order, punctuation between them, nothing alphanumeric touching it. */
function asWord(word) {
  const pieces = word.match(new RegExp(`${ALNUM}+`, 'gu')).map((piece) => piece.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&'))
  const pattern = new RegExp(`(?<!${ALNUM})${pieces.join(`[^\\p{L}\\p{N}]*`)}(?!${ALNUM})`, 'iu')
  return (text) => pattern.test(text)
}

/** Whether a text of the base holds these very bytes, and no longer run of the same letters. */
const asIs = (bytes) => (text) => {
  for (let at = text.indexOf(bytes); at >= 0; at = text.indexOf(bytes, at + 1)) {
    if (!isAlnum(text[at + bytes.length])) return true
  }
  return false
}

const addedOf = (diff) => Buffer.concat(diff.added.flatMap((row) => [row, NEWLINE]))

/** A commit as it is stored: every byte is in here, whatever `git log` would print of it. */
function commitObject(cwd, sha) {
  const raw = git(cwd, 'cat-file', 'commit', sha)
  const split = raw.indexOf('\n\n')
  const head = raw.subarray(0, split + 1).toString()
  const person = (role) => {
    const [, name, email] = PERSON(role).exec(head)
    return { name, email }
  }
  return { message: raw.subarray(split + 2), author: person('author'), committer: person('committer'), merge: head.match(/^parent /gm)?.length > 1,
    signature: head.match(SIGNATURE)?.join('') ?? '', extra: head.replace(SIGNATURE, '').replace(STANDARD_HEADER, '') }
}

/** Everything `base..HEAD` takes out, into `out`. */
function readGit(cwd, base, out) {
  out.leaving.branch = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').toString().trim()
  out.sources.push({ where: 'branch', kind: 'branch', bytes: Buffer.from(out.leaving.branch) })
  const index = new Map()
  const indexOf = (path) => {
    if (!index.has(path)) index.set(path, out.leaving.files.push(path) - 1)
    return index.get(path)
  }
  for (const sha of git(cwd, 'rev-list', '--reverse', `${base}..HEAD`).toString().split('\n').filter(Boolean)) {
    const short = sha.slice(0, SHORT_SHA)
    const { message: bytes, author, committer, merge, signature, extra } = commitObject(cwd, sha)
    const message = bytes.toString()
    const people = [author, committer].map(({ name, email }) => `${name} <${email}>`)
    for (const person of people) if (!out.leaving.identity.includes(person)) out.leaving.identity.push(person)
    out.leaving.commits.push({ sha: short, subject: message.split('\n')[0] })
    out.sources.push({ where: `${short}:message`, kind: 'message', bytes })
    if (extra) out.sources.push({ where: `${short}:message`, kind: 'header', bytes: Buffer.from(extra) })
    if (signature) out.sources.push({ where: `${short}:message`, kind: 'signature', bytes: Buffer.from(signature) })
    // the noreply address is a public login, judged by the email rule, so the identity words read only the names; a captured fact in it still leaks
    const names = `${author.name}\n${committer.name}`, locals = [author, committer].map(({ email }) => email.split('@')[0]).join('\n')
    out.sources.push({ where: `${short}:author`, kind: 'author', bytes: Buffer.from(people.join('\n')), names: wordOf(names), norm: wordOf(`${names}\n${locals}`) })
    const commit = { sha, short, message, merge, emails: [author.email, committer.email], lines: 0, changed: [] }
    out.commits.push(commit)
    if (commit.merge) continue // the shape rule refuses it whole, so its diff is not read
    const { stats, diffs } = brought(cwd, sha)
    stats.forEach((stat, i) => {
      if (!isUncounted(stat.path)) commit.lines += stat.lines
      if (diffs[i].gone) return
      const where = `${short}:file#${indexOf(stat.path)}`
      const added = addedOf(diffs[i])
      commit.changed.push({ ...stat, where, added })
      out.sources.push({ where, kind: 'path', bytes: Buffer.from(stat.path) })
      out.sources.push({ where, kind: 'added', path: stat.path, lines: diffs[i].lines, bytes: added })
    })
  }
  if (out.commits.length < 2) return
  // a window does not cross sources, and what two commits each bring half of sits whole in the tree they leave
  const { stats, diffs } = brought(cwd, base, 'HEAD')
  stats.forEach((stat, i) => {
    if (!diffs[i].gone) out.sources.push({ where: `tree:file#${indexOf(stat.path)}`, kind: 'added', path: stat.path, lines: diffs[i].lines, bytes: addedOf(diffs[i]) })
  })
}

/** The whole outbound text, source by source, in a form that changes when any of its bytes does, and the terms it was judged on: what the
 *  user agrees to is this comparison, so a run that read less or let more through is another one. after_bytes and total_bytes only grow. */
function hashOf(sources, { base, before, accepting, accepted, coverage }) {
  const passed = accepted.map((f) => [f.rule, f.where, f.why].join('\0')).sort()
  const hash = createHash('sha256').update(`${JSON.stringify([base, before, accepting, passed, coverage.scanned_bytes, coverage.opaque_bytes])}\0`)
  for (const s of sources) {
    const bytes = s.kind === 'body' ? Buffer.from(s.bytes.toString('latin1').replace(HASH_ROW, ''), 'latin1') : s.bytes
    hash.update(`${s.kind}\0${s.where}\0${bytes.length}\0`).update(bytes)
  }
  return hash.digest('hex')
}

/** `where`, narrowed to the line of the new file a match at `index` sits on, when the source knows its lines. */
function placeOf(source, text, index) {
  if (!source.lines) return source.where
  let row = 0
  for (let at = text.indexOf('\n'); at >= 0 && at < index; at = text.indexOf('\n', at + 1)) row++
  return source.lines[row] === undefined ? source.where : `${source.where}:${source.lines[row]}`
}

function isBlocked(file, read) {
  const ext = file.path.slice(file.path.lastIndexOf('.')).toLowerCase()
  const added = file.added.toString()
  if (file.binary || BLOCKED.has(ext) || LFS_POINTER.test(added) || (GITATTRIBUTES.test(file.path) && LFS_FILTER.test(added))) return true
  return ext === '.svg' && spelled({ bytes: read() }).some((text) => SVG_EMBED.test(text)) // whole: a rename brings no added lines
}

/** The object `rev` names, empty when it names none. */
const answer = (cwd, ...args) => spawnSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).stdout.toString().trim()
const revOf = (cwd, rev) => answer(cwd, 'rev-parse', '--verify', '--quiet', rev)
const isAncestor = (cwd, older, newer) => spawnSync('git', ['merge-base', '--is-ancestor', older, newer], { cwd, stdio: 'ignore' }).status === 0

const undoEntities = (text) => text.replace(ENTITY, (all, decimal, hex, name) => {
  if (name) return NAMED[name.toLowerCase()]
  const cp = decimal ? Number(decimal) : parseInt(hex, 16)
  return cp <= 0x10ffff ? String.fromCodePoint(cp) : all
})

/** %HH runs, as §6.2 reads them: bytes that are not UTF-8 are no escape. */
const undoPercent = (text) => text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
  const bytes = Buffer.from(run.replaceAll('%', ''), 'hex')
  return isUtf8(bytes) ? bytes.toString() : run
})

/** A source's text as it stands and, when they differ, with its \uXXXX undone, then its HTML entities, then its percent escapes. */
function spelled(source) {
  const raw = source.bytes.toString()
  const decoded = raw.replace(/\\+u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  const unescaped = undoEntities(decoded)
  return [...new Set([raw, decoded, unescaped, undoPercent(unescaped)])]
}

/** An image riding in text. A Markdown image in a committed file points into the repository; in a pull request's text it loads from anywhere. */
function checkImages(sources, hold, add) {
  for (const source of sources) {
    const posted = source.kind === 'title' || source.kind === 'body'
    for (const text of spelled(source)) {
      const keep = (match) => hold(match[0], 'files', placeOf(source, text, match.index), { exact: true, why: WHY.image })
      for (const match of text.matchAll(DATA_IMAGE)) {
        if (HAS_PAYLOAD.test(match[0])) keep(match)
        else add('files', placeOf(source, text, match.index), WHY.image)
      }
      if (posted) for (const match of text.matchAll(POSTED_IMAGE)) keep(match)
    }
  }
}

function checkFiles(commits, cwd, add) {
  let board = null
  for (const commit of commits) {
    for (const file of commit.changed) {
      const inBoard = file.path.startsWith(BOARD)
      if (inBoard) board ??= file.where
      // what HEAD holds of the board is the build, judged below; what only an earlier commit holds would ride along in the history
      const blob = () => git(cwd, 'cat-file', 'blob', `${commit.sha}:${file.path}`)
      if (isBlocked(file, blob) && !(inBoard && revOf(cwd, `${commit.sha}:${file.path}`) === revOf(cwd, `HEAD:${file.path}`))) add('files', file.where)
    }
  }
  if (!board) return
  // someone else's branch: its package.json is its code, and this machine holds the capture (§1)
  if (fs.realpathSync(git(cwd, 'rev-parse', '--show-toplevel').toString().trim()) !== fs.realpathSync(CLONE)) add('files', board, WHY.foreign)
  // test:build compares the working tree, so it says nothing of HEAD unless the two are the same
  else if (git(cwd, 'status', '--porcelain', '--untracked-files=all', '--ignored=matching', '--', BOARD_INPUT, BOARD).length > 0) add('files', board, WHY.build)
  else if (spawnSync('npm', ['run', 'test:build'], { cwd, stdio: 'ignore', shell: process.platform === 'win32' }).status !== 0) add('files', board, WHY.build)
}

function checkShape(commits, sources, add) {
  for (const commit of commits) {
    if (commit.merge) add('shape', commit.short, WHY.merge)
    if (commit.lines > MAX_LINES) add('shape', commit.short, WHY.lines)
    const paragraphs = commit.message.trim().split(/\n\s*\n/).slice(1)
    const trailers = paragraphs.at(-1)?.split('\n').every((row) => /^[A-Za-z][A-Za-z0-9-]*: /.test(row))
    if (paragraphs.length - (trailers ? 1 : 0) < 1) add('shape', `${commit.short}:message`, WHY.body)
  }
  for (const source of sources) {
    if (TEXT_KINDS.has(source.kind) && !isUtf8(source.bytes)) add('shape', source.where, WHY.encoding)
    if (!CONTROL_KINDS.has(source.kind)) continue
    const text = source.bytes.toString()
    for (const match of text.matchAll(CONTROL)) add('shape', placeOf(source, text, match.index), WHY.control)
  }
}

/** A source's text for the rules on long runs, none for the built board, and the lock's integrity lines are hashes and nothing else. */
function runnable(source) {
  if (source.path?.startsWith(BOARD) || source.kind === 'signature') return null
  const text = source.bytes.toString()
  return source.path && LOCK.test(source.path) ? text.replace(INTEGRITY, '') : text
}

function checkSecrets(sources, add) {
  for (const source of sources) {
    for (const text of spelled(source)) {
      const hit = (match) => { if (!isFake(match[0])) add('secrets', placeOf(source, text, match.index)) }
      for (const pattern of [TOKEN, CREDENTIAL, VALUED]) for (const match of text.matchAll(pattern)) hit(match)
      for (const match of text.replace(LINE_BREAK, '').matchAll(TOKEN)) if (!isFake(match[0])) add('secrets', source.where)
    }
    const text = runnable(source)
    for (const match of text?.matchAll(LONG_RUN) ?? []) if (isMixed(match[0]) && !isFake(match[0])) add('secrets', placeOf(source, text, match.index))
  }
}

/** What a source says in another alphabet joins the sources, to be compared by what it says. A folded block that says nothing readable is
 *  what a file looks like when it is carried as text, and hex is left out of that: a list of hashes opens to noise too. */
function openEncoded(sources, add) {
  for (const source of [...sources]) {
    const text = TEXT_KINDS.has(source.kind) ? runnable(source) : null
    if (text === null) continue
    const open = (run) => {
      const bytes = opened(run)
      if (bytes) sources.push({ where: source.where, kind: 'decoded', bytes })
      return bytes
    }
    longRuns(text).forEach(open)
    for (const { index, run } of foldedRuns(text)) {
      if (!open(run) && !isHex(run) && !isFake(run)) add('secrets', placeOf(source, text, index))
    }
  }
}

function checkIdentity(out, cwd, hold, add) {
  const host = os.hostname()
  const names = [os.userInfo().username, host, host.split('.')[0], process.env.USER, process.env.LOGNAME, process.env.USERNAME, process.env.COMPUTERNAME]
  const gitConfig = (key) => answer(cwd, 'config', '--get', key)
  const gitName = gitConfig('user.name')
  const own = wordOf(gitName || '')
  for (const name of [...names, gitName, gitConfig('user.email')].filter(Boolean)) {
    const word = wordOf(name)
    if (word.length === 0) continue
    for (const source of out.sources) {
      if (source.kind === 'author' && word.equals(own)) continue
      if ((source.names ?? source.norm).includes(word)) hold(name, 'identity', source.where)
    }
  }
  for (const source of out.sources) {
    for (const text of spelled(source)) {
      for (const match of text.matchAll(HOME_PATH)) {
        if (!NEUTRAL.has(match[1].toLowerCase())) hold(match[0], 'identity', placeOf(source, text, match.index))
      }
    }
  }
  for (const commit of out.commits) if (!commit.emails.every((email) => NOREPLY.test(email))) add('identity', `${commit.short}:author`, WHY.email)
}

/** What `trocar` answered, as a document. A query that read only part of the capture still answers, with `ok: false`: its rows are used and
 *  the rest is a `partial` finding, so that one bad record does not take the whole comparison with it. No document at all throws. */
function ask(cli, add, ...args) {
  const [file, argv, options] = callOf(cli, ['query', ...args])
  const r = spawnSync(file, argv, { ...options, maxBuffer: Infinity, stdio: ['ignore', 'pipe', 'ignore'] })
  let doc = null
  try { doc = JSON.parse(r.stdout) } catch { /* no document is the failure below */ }
  if (doc === null || typeof doc !== 'object') throw new Error('capture')
  if (r.status !== 0 || doc.ok !== true) add('partial', 'capture', WHY.query)
  return doc
}

function allPages(cli, add, name, key) {
  const rows = []
  for (let after = null; ;) {
    const doc = ask(cli, add, name, ...PAGE, ...(after === null ? [] : ['--after', String(after)]))
    rows.push(...(doc[key] ?? []))
    if (doc.next == null || doc.next === after) return rows
    after = doc.next
  }
}

/** A row's title. The list says `pending` for one it has not read, and the CLI read here is the installed one, of whatever version: the head
 *  answers then, and a title neither gives is a `partial` finding, as it is content this could not compare. */
function titleOf(cli, add, row) {
  if (row.title_source !== 'pending') return row.title
  let meta = null
  try { ({ meta } = ask(cli, add, 'session', '--id', row.session_id, '--head')) } catch { /* no document: below */ }
  if (!meta || meta.title_source === 'pending') add('partial', 'capture', WHY.title)
  return meta?.title
}

/** The capture's facts as words; a segment's name also covers every `<segment>:<n>` record id. */
function checkFacts(cli, segments, sources, add, hold) {
  const facts = [...allPages(cli, add, 'sessions', 'sessions').flatMap((s) => [s.project_path, s.project_slug, s.session_id, titleOf(cli, add, s)]),
    ...allPages(cli, add, 'traffic', 'hosts').map((h) => h.host), ...segments.map((s) => s.segment)]
  const words = new Map()
  for (const fact of facts) {
    if (typeof fact !== 'string') continue
    const word = wordOf(fact)
    if (word.toString().length >= MIN_FACT) words.set(word.toString('latin1'), { word, fact })
  }
  for (const { word, fact } of words.values()) {
    for (const source of sources) if (source.norm.includes(word)) hold(fact, 'captured-facts', source.where)
  }
}

/** §6.3: what `base` already tracks is public. One pass over its blobs takes their windows out of `table` and their words out of `held`.
 *  A word is judged on a text blob's own bytes: normalized, a short name is in everything, and letters in a binary mean nothing. */
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
    if (held.size === 0 || blob.subarray(0, GIT_BINARY_PEEK).includes(0)) continue
    const text = blob.toString()
    for (const [key, entry] of held) if (entry.isIn(text)) held.delete(key)
  }
}

/** Streams every segment that can hold a record before `before` through `table`, to its end whatever the table holds by then: a record
 *  left unread is a `partial` finding, so the walk does not stop early. Returns the coverage. */
async function compareCapture(segments, { before, cli }, table, add) {
  const wanted = segments.filter((s) => !s.from || Date.parse(s.from) < before)
  const bytesOf = (list) => list.reduce((n, s) => n + s.bytes, 0)
  const coverage = { scanned_bytes: 0, opaque_bytes: 0, after_bytes: bytesOf(segments) - bytesOf(wanted), total_bytes: bytesOf(wanted), from: null, to: null }
  const hit = (slot) => { add('captured-text', table.whereOf(slot)); table.drop(slot) }
  let read = 0
  const take = (line, ending) => {
    read += line.length + 1 // a half line too: a sealed segment's size counts a newline per record
    const ts = RECORD_TS.exec(line.subarray(0, 64).toString('latin1'))?.[1]
    const time = Date.parse(ts)
    if (time >= before) {
      coverage.after_bytes += line.length + ending
      return
    }
    table.scan(line, hit)
    let behind = { texts: [], opaque: true }
    // not JSON: nothing can be opened, and a half line at a segment's end is no record to open (§4), so only its text above is compared
    try { behind = textsBehind(JSON.parse(line)) } catch { behind.opaque = ending > 0 }
    for (const text of behind.texts) table.scan(text, hit)
    coverage[behind.opaque ? 'opaque_bytes' : 'scanned_bytes'] += line.length + ending
    if (Number.isNaN(time)) return
    if (coverage.from === null || time < Date.parse(coverage.from)) coverage.from = ts
    if (coverage.to === null || time > Date.parse(coverage.to)) coverage.to = ts
  }
  for (const segment of wanted) {
    read = 0
    let call
    try { call = callOf(cli, ['raw', segment.segment]) } catch { add('partial', 'capture', WHY.raw); continue }
    const kid = spawn(call[0], call[1], { ...call[2], stdio: ['ignore', 'pipe', 'ignore'] })
    const exit = new Promise((resolve) => { kid.on('close', resolve); kid.on('error', () => resolve(-1)) })
    let parts = []
    for await (const chunk of kid.stdout) {
      let at = 0
      for (let nl = chunk.indexOf(10); nl >= 0; nl = chunk.indexOf(10, at)) {
        parts.push(chunk.subarray(at, nl))
        take(parts.length === 1 ? parts[0] : Buffer.concat(parts), 1)
        parts = []
        at = nl + 1
      }
      if (at < chunk.length) parts.push(chunk.subarray(at))
    }
    if (parts.length > 0) take(Buffer.concat(parts), 0)
    if (await exit !== 0 || (segment.state !== 'writing' && read < segment.bytes)) add('partial', 'capture', WHY.raw)
  }
  if (coverage.opaque_bytes > 0) add('partial', 'capture', WHY.opaque)
  if (coverage.scanned_bytes + coverage.opaque_bytes === 0 && segments.some((s) => s.records > 0)) add('partial', 'capture', WHY.nothing)
  else if (coverage.after_bytes > 0 && before < Date.now() - MAX_WORK_MS) add('partial', 'capture', WHY.early)
  return coverage
}

function print(doc) {
  const lines = [`pr-check: ${doc.ok ? 'passed' : `refused, ${doc.findings.length} finding${doc.findings.length === 1 ? '' : 's'}`}`]
  for (const f of doc.findings) lines.push(`  ${f.rule}  ${f.where}  ${f.why}`)
  for (const f of doc.accepted) lines.push(`  accepted ${f.rule}  ${f.where}  ${f.why}`)
  const { scanned_bytes: scanned, opaque_bytes: opaque, after_bytes: after, total_bytes: total, from, to } = doc.coverage
  lines.push(`hash ${doc.hash}`, `capture compared: ${scanned} of ${total} bytes, ${opaque} not opened, ${after} at or past --before${from ? `, ${from} to ${to}` : ''}`)
  if (doc.leaving.branch) lines.push(`branch ${doc.leaving.branch}`)
  for (const person of doc.leaving.identity) lines.push(`identity ${person}`)
  for (const commit of doc.leaving.commits) lines.push(`commit ${commit.sha} ${commit.subject}`)
  doc.leaving.files.forEach((file, i) => lines.push(`file #${i} ${file}`))
  process.stdout.write(`${lines.join('\n')}\n`)
}

async function main() {
  process.env.GIT_NO_REPLACE_OBJECTS = '1' // a replacement is local: what is pushed is the object it hides
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
  const hold = (text, rule, where, { exact = false, why } = {}) => {
    const key = `${exact}\0${text}`
    if (!held.has(key)) held.set(key, { isIn: exact ? asIs(text) : asWord(text), hits: [] })
    held.get(key).hits.push({ rule, where, why })
  }
  const out = { sources: [], commits: [], leaving: { files: [], commits: [], identity: [], branch: null } }
  const given = revOf(cwd, `${options.base}^{commit}`)
  const base = given && answer(cwd, 'merge-base', given, 'HEAD') // the fork point, as one commit from here on: a ref could move between reads
  const mains = answer(cwd, 'for-each-ref', '--format=%(objectname)', 'refs/remotes/*/main').split('\n').filter(Boolean)
  // what comes before the base is not judged and its tree exempts what comes after, so it has to be out already
  const isPublic = base && mains.some((main) => isAncestor(cwd, base, main))
  if (!options.issue) {
    try {
      if (!given && mains.length > 0) throw new Error('git')
      if (base) readGit(cwd, base, out)
      if (out.commits.length === 0 || !isPublic) add('base', 'git', WHY.base)
    } catch { add('unreadable', 'git', WHY.git) }
  }
  if (options.title) out.sources.push({ where: 'title', kind: 'title', bytes: options.title })
  out.sources.push({ where: 'body', kind: 'body', bytes: options.body })
  openEncoded(out.sources, add)
  for (const source of out.sources) source.norm ??= normalized(source.bytes)

  checkFiles(out.commits, cwd, add)
  checkImages(out.sources, hold, add)
  checkShape(out.commits, out.sources, add)
  checkSecrets(out.sources, add)
  checkIdentity(out, cwd, hold, add)
  let segments = []
  try {
    segments = ask(options.cli, add, 'segments').segments ?? []
    checkFacts(options.cli, segments, out.sources, add, hold)
  } catch { add('partial', 'capture', WHY.query) }

  const table = new WindowTable(out.sources)
  if (isPublic) {
    try { subtractBase(cwd, base, table, held) } catch { add('unreadable', 'git', WHY.git) }
  }
  for (const { hits } of held.values()) for (const hit of hits) add(hit.rule, hit.where, hit.why)
  const coverage = await compareCapture(segments, options, table, add)

  const accepting = options['accept-partial'] === true
  const isAccepted = (f) => accepting && f.rule === 'partial'
  const accepted = [...found.values()].filter(isAccepted)
  const hash = hashOf(out.sources, { base, before: options.before, accepting, accepted, coverage })
  for (const row of options.body.toString('latin1').matchAll(HASH_ROW)) if (row[2] && row[2] !== hash) add('shape', 'body', WHY.hash)
  const findings = [...found.values()].filter((f) => !isAccepted(f))
  const doc = { ok: findings.length === 0, hash, findings, accepted, coverage, leaving: out.leaving }
  if (options.json) process.stdout.write(`${JSON.stringify(doc)}\n`)
  else print(doc)
  process.exitCode = doc.ok ? 0 : 1
}

await main()
