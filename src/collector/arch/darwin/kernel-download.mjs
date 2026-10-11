// kernel-download.mjs — the one place the CLI goes online: download the pinned kernel with the system curl, check BOTH digests, unpack, cache (RFC 4.8 §8 D44's darwin half, 4.9 §8; acceptance W27 ⑦'s new shape, W75 keeps the pin honest).
//
// This is the darwin port of `arch/win32/kernel-download.mjs` — a near-verbatim copy (4.9's convention for the forwarder's files), with the one delta of 4.9 §8: the official darwin release is a
// `.gz` single binary, not a `.zip`, so the unpack is `node:zlib`'s streamed gunzip (no `tar` exec — nothing but curl is ever exec'd here). Everything else is carried as it is: the system curl with
// `-fsSL --retry 2 -o` (it honours the operator's own HTTPS_PROXY / https_proxy / ALL_PROXY environment and follows the redirects itself), the security boundary at the digest checks — the archive's
// sha256 and size, then the unpacked binary's — never at curl's exit code, the clean refusal with zero leftovers and one `forwarder-download-failed` event on any mismatch (D38), the started / ok
// events of a successful download (the command line in the started one, V50-style), and the VERIFIED archive cached at `<cacheDir>/<asset.name>` (0700, the collector dir's `kernel-archive/`) so a
// later `on` needs no network and an offline machine gets its kernel by the operator dropping the very same file there by hand.
//
// This file's import discipline is W27 ⑦'s second scan: ONLY node:child_process, node:zlib, node:fs, node:path, node:crypto and node:util (0.1 §6 item 11) — no http, https, net, tls, dns, no fetch.
// Every function takes what it touches (`fs`, `hash`, the `execFile`, the event sink) so a test on any OS runs it against a temp directory and a fake curl that never reaches a network.

import nodeFs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile as nodeExecFile } from 'node:child_process'
import { createGunzip } from 'node:zlib'

const LICENSE_URL = new URL('../../../../LICENSE-mihomo.txt', import.meta.url) // the licence text travels beside the kernel (GPL-3.0-only aggregation); the repo ships it and `--pin`'s W75 holds it to the pin's licenseFile.sha256

const isFile = (fs, p) => { try { return fs.statSync(p).isFile() } catch { return false } }
const same = (got, want) => got.sha256 === want.sha256 && (want.size == null || got.size === want.size)

/** The sha256 and the size of a file, streamed (the archive and the binary are tens of megabytes). */
export function hashFile(file, { fs = nodeFs } = {}) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    let size = 0
    const s = fs.createReadStream(file)
    s.on('data', (d) => { h.update(d); size += d.length })
    s.on('error', reject)
    s.on('end', () => resolve({ size, sha256: h.digest('hex') }))
  })
}

/** The SOURCE-mihomo.txt that is placed beside the kernel (what it is, where its source is, under which licence) — the pin's own words, no file of the repo read. */
export const sourceText = ({ pin, arch }) => `asight-forwarder is mihomo ${pin.version} (${pin.assets[arch].variant}), as its authors build it, renamed.\nSource code: ${pin.source}\nLicense: ${pin.license} (LICENSE-mihomo.txt)\n`

/** The LICENSE-mihomo.txt that is placed beside the kernel: the repo's own copy of the GPL-3.0 text, read by URL (no node:url here: fs reads a file: URL as it is). Null when it cannot be read —
 * the kernel itself was digest-checked, and a licence text that cannot be read is no reason to leave the kernel unplaced (the receipt says what was placed). */
export function licenseText({ fs = nodeFs } = {}) {
  try { return fs.readFileSync(LICENSE_URL) } catch { return null }
}

/** execFile to a promise: the callback's error (ENOENT, a non-zero exit, a kill) is an answer, never a throw — a download that fails is `forwarder-download-failed`, not a crash of `on`. */
const runExec = (execFile, cmd, args, opts) => new Promise((resolve) => {
  execFile(cmd, args, { maxBuffer: 1 << 20, ...opts }, (error, stdout, stderr) => resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') }))
})

/** One curl run. → `{ ok: true }` · `{ ok: false, absent: true }` (ENOENT: no curl on this machine) · `{ ok: false, code, err }` (a non-zero exit, or a kill: `code` is the exit code or the signal's errno, `err` what curl said). */
async function runCurl(execFile, args, { env, timeoutMs }) {
  const { error, stderr } = await runExec(execFile, 'curl', args, { env, timeout: timeoutMs })
  if (!error) return { ok: true }
  if (error.code === 'ENOENT') return { ok: false, absent: true }
  return { ok: false, code: typeof error.code === 'number' ? error.code : error.signal || 1, err: String(stderr || error.message || '').trim() }
}

/** Unpack the checked archive in the work directory and check the binary inside it: the `.gz` holds ONE file, so the streamed gunzip writes it straight to `work/unpacked` (mode 0755 — the binary
 * must run; the copy into `kernel/` that follows preserves the mode) and the result is checked against the pin's `exe`. → the binary's path. Throws on a gunzip that failed or a binary whose digest
 * or size is not the pin's (the message names the digests). */
async function unpack({ asset, archive, work, fs, hash }) {
  const out = path.join(work, 'unpacked')
  await new Promise((resolve, reject) => {
    const fail = (e) => reject(new Error(`${asset.name} will not gunzip (${String((e && e.message) || e)})`)) // zlib's own words are true but say nothing of WHAT failed: name the archive
    const w = fs.createWriteStream(out, { mode: 0o755 })
    w.on('error', fail)
    w.on('finish', () => resolve())
    const gun = createGunzip()
    gun.on('error', fail)
    fs.createReadStream(archive).on('error', fail).pipe(gun).pipe(w)
  })
  const got = await hash(out)
  if (!same(got, asset.exe)) throw new Error(`${asset.name}: the binary inside is not the pinned one (sha256 ${got.sha256}, ${got.size} bytes; the pin's is ${asset.exe.sha256}, ${asset.exe.size} bytes)`)
  return out
}

/**
 * acquireKernel({ asset, cacheDir, fs, hash, execFile, env, event }) — the run location holds nothing the pin recognises, so: the cache first, the network only when the cache cannot satisfy the pin
 * either (D44 ③'s order). `asset` is the pin's own entry for this architecture (forwarder.mjs's ensureBinary resolves it and answers `unsupported-arch` / `not-pinned` before this is ever asked);
 * `cacheDir` is the collector dir's `kernel-archive/`; `event` is the sink the download's three records go to (the wiring's `on` hands it flows/, D38); `execFile` is node's own by default and a
 * test's recorder otherwise (darwin's unpack is zlib, so the ONLY thing it ever runs is curl); `env` is the shell `on` runs in (curl reads the operator's own proxy variables from it, D44 ②).
 * → `{ from: 'cache', work, exe }`          the cache holds the pinned archive: unpacked and binary-checked in a work directory under the cache dir — NO network, NO events (nothing happened an
 *                                             operator must be told); the work directory is the CALLER's to remove once the binary is placed
 * → `{ from: 'download', work, exe, cache }` one curl fetched the pinned archive (the started and ok events are written), the VERIFIED archive is cached at `<cacheDir>/<asset.name>` (0700), the
 *                                             checked binary waits in the work directory — the caller's to remove once it is placed
 * → `{ failed: { reason } }`                  any step failed — curl absent (`no-curl`'s text), curl's exit, a digest that is not the pin's, a gunzip that could not run: the `forwarder-download-failed`
 *                                             event is ALREADY written with the reason, and nothing is left anywhere (the work directory is removed, the cache is not touched).
 */
export async function acquireKernel({ asset, cacheDir, fs = nodeFs, hash = (f) => hashFile(f, { fs }), execFile = nodeExecFile, env = process.env, event = () => {}, timeoutMs = 600_000 } = {}) {
  const fail = (reason) => { event({ event: 'failure', where: 'forwarder', code: 'forwarder-download-failed', reason }); return { failed: { reason } } }
  const cacheArchive = path.join(cacheDir, asset.name)
  const mkWork = () => { fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 }); return fs.mkdtempSync(path.join(cacheDir, 'work-')) }
  // the cache first: an archive whose digest satisfies the pin is as good as a download, and needs no network (an offline machine's kernel is the operator dropping this very file here)
  if (isFile(fs, cacheArchive)) {
    try {
      if (same(await hash(cacheArchive), asset)) {
        const work = mkWork()
        try { return { from: 'cache', work, exe: await unpack({ asset, archive: cacheArchive, work, fs, hash }) } }
        catch (e) { fs.rmSync(work, { recursive: true, force: true }) /* an archive that checks but will not unpack cannot help: fall through to the download, which fails its own way if the pin is at fault */ }
      }
    } catch { /* an unreadable cache entry is no cache entry */ }
  }
  // the download — the CLI's one online step (1.6 R8's single exception)
  const pre = await runCurl(execFile, ['--version'], { env, timeoutMs: 10_000 })
  if (!pre.ok) return fail(pre.absent ? 'curl is not on this machine (the download needs the system curl; macOS and Windows 10 1803+ carry one)' : `curl --version failed (${pre.code}${pre.err ? `: ${pre.err.slice(0, 200)}` : ''})`)
  const work = mkWork()
  try {
    const out = path.join(work, asset.name)
    const args = ['-fsSL', '--retry', '2', '-o', out, asset.url]
    event({ event: 'forwarder-download-started', where: 'forwarder', url: asset.url, size: asset.size, sha256: asset.sha256, command: ['curl', ...args].join(' ') })
    const dl = await runCurl(execFile, args, { env, timeoutMs })
    if (!dl.ok) throw new Error(`curl exited ${dl.code}${dl.err ? `: ${dl.err.slice(0, 200)}` : ''}`)
    const got = await hash(out)
    if (!same(got, asset)) throw new Error(`${asset.name}: the download is not the pinned archive (sha256 ${got.sha256}, ${got.size} bytes; the pin's is ${asset.sha256}, ${asset.size} bytes)`)
    const exe = await unpack({ asset, archive: out, work, fs, hash })
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 })
    fs.renameSync(out, cacheArchive) // the VERIFIED archive is the cache now (a same-volume rename under the collector dir: atomic — a half-written cache entry cannot exist)
    event({ event: 'forwarder-download-ok', where: 'forwarder', url: asset.url, archive_sha256: asset.sha256, exe_sha256: asset.exe.sha256, cache: cacheArchive })
    return { from: 'download', work, exe, cache: cacheArchive }
  } catch (e) {
    fs.rmSync(work, { recursive: true, force: true })
    return fail(String((e && e.message) || e))
  }
}
