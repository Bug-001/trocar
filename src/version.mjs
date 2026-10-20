// version.mjs — the one place that says which code this is (RFC 1.6 §2, §5.5; D67⑤).
//   codeId()  `<package.json version>+<first 7 of HEAD>` in a git checkout, `<version>` anywhere else.
// `asight --version` prints it, the daemon reports it as `code` on its control channel, and `asight update` compares the two to tell
// whether the daemon runs this code. Files are read, nothing is spawned: git may be absent, and this is asked on a daemon's start path.
// Anything that cannot be read (no `.git`, an unreadable HEAD, a ref nowhere to be found) is the plain version, never a guess.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const read = (file) => { try { return fs.readFileSync(file, 'utf8') } catch { return null } }

/** The directory this code's package.json lives in. */
export const packageRoot = () => path.resolve(fileURLToPath(new URL('..', import.meta.url)))

/** The git directory of the checkout at `root`: `<root>/.git`, or what a `.git` FILE names (a worktree, a submodule); null when there is none. */
export function gitDir(root = packageRoot()) {
  const dot = path.join(root, '.git')
  let st
  try { st = fs.statSync(dot) } catch { return null }
  if (st.isDirectory()) return dot
  const named = /^gitdir:\s*(.+)$/m.exec(read(dot) || '')
  return named ? path.resolve(root, named[1].trim()) : null
}

const SHA = /^[0-9a-f]{40}$/

/** The commit HEAD names in `dir`: a detached HEAD, a loose ref, or one line of packed-refs — in `dir` and, for a worktree, in the common
 *  directory its `commondir` names (a worktree keeps its own HEAD and the branches in the main checkout). null when none of that reads. */
export function headSha(dir) {
  const head = (read(path.join(dir, 'HEAD')) || '').trim()
  if (!head) return null
  const named = /^ref:\s*(\S+)/.exec(head)
  if (!named) return SHA.test(head) ? head : null
  const common = (read(path.join(dir, 'commondir')) || '').trim()
  for (const d of [dir, ...(common ? [path.resolve(dir, common)] : [])]) {
    const loose = (read(path.join(d, named[1])) || '').trim()
    if (SHA.test(loose)) return loose
    const line = (read(path.join(d, 'packed-refs')) || '').split('\n').find((l) => l.endsWith(` ${named[1]}`))
    if (line && SHA.test(line.split(' ')[0])) return line.split(' ')[0]
  }
  return null
}

/** `<version>+<first 7 of a commit>`, the one place that format is composed: `null` / no sha is the plain version. */
export const codeIdOf = (version, sha) => (sha ? `${version}+${String(sha).slice(0, 7)}` : version)

/** This code's version: `0.1.0+1a2b3c4` in a git checkout, `0.1.0` outside one. */
export function codeId(root = packageRoot()) {
  const version = JSON.parse(read(path.join(root, 'package.json')) || '{}').version || '0.0.0'
  const dir = gitDir(root)
  return codeIdOf(version, dir && headSha(dir))
}
