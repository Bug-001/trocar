// test/off/marker-words.test.mjs — 4.6「标记的字」: a marker is its fixed sentinel part plus the commands it names. For every format primitive that
// carries a marker (a dotenv block at the top or the end, a PEM block, a text line, a YAML row) and for the words a released build wrote as well as
// the words this build writes: install / on find the entry and write nothing, a manifest that does not list it still refuses a second copy, undo
// gives back the user's bytes, and the marker undo (no manifest) does too. JSON keys carry no marker (JSON has no comments) and trocar writes no TOML.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { applyTextEntry, newManifest, sha256 } from '../../src/collector/core/trust/journal.mjs'
import { undoEntry } from '../../src/off/journal.mjs'
import { planByMarker, undoByMarker } from '../../src/off/marker.mjs'
import { lineComment } from '../../src/off/text-edit.mjs'
import { commandNamed } from '../../src/cli/commands.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

// what tag v0.1.0 (npm trocar-cli 0.0.1) named in every marker: `trocar collector install` / `trocar collector uninstall`, whatever the phase
const RELEASED = (s) => s.replace(/`trocar (?:install|on)`/g, '`trocar collector install`').replace(/`trocar (?:uninstall|off)`/g, '`trocar collector uninstall`')
const WORDS = { released: RELEASED, current: (s) => s }
const PEM = (b) => `-----BEGIN CERTIFICATE-----\n${b}\n-----END CERTIFICATE-----\n`

const PRIMITIVES = [
  { name: 'dotenv block (top)', file: '.codex/.env', user: 'OPENAI_API_KEY=sk-1\n', phase: 'install', edit: (h) => ({ format: 'dotenv-block', vars: { SSL_CERT_FILE: `${h}/.trocar/collector/ca/combined-codex.pem` } }), marker: 'codex' },
  { name: 'dotenv block (end)', file: '.hermes/.env', user: 'K=1\r\nHTTPS_PROXY=http://corp:8080\r\n', phase: 'on', edit: () => ({ format: 'dotenv-block', vars: { HTTPS_PROXY: 'http://127.0.0.1:17991' }, at: 'end' }) },
  { name: 'pem block', file: 'corp.pem', user: PEM('USER'), phase: 'install', edit: () => ({ format: 'pem-block', pem: PEM('TROCAR') }) },
  { name: 'text line', file: '.zshrc', user: 'export A=1\n', phase: 'install', edit: (h) => ({ format: 'line', line: `export PATH="${h}/.trocar/collector/bin:$PATH" ${lineComment('runs kimi through its trocar launch shim')}` }), marker: 'kimi-code' },
  { name: 'yaml row', file: '.dsh/cordis.patch.yml', user: '- set: {a: 1}\n', phase: 'install', edit: (h) => ({ format: 'yaml-list', line: `- insert: [{ name: "${h}/.trocar/collector/plugins/dsh/index.js" }] ${lineComment("loads trocar's CA trust plugin")}` }), marker: 'deepseek-dsh' },
]

// one entry as the build with `words` wrote it: the file and the manifest record both hold those words (a manifest a released build left)
function placed(p, words) {
  const home = tmpDir('trocar-mw-')
  const dir = path.join(home, '.trocar', 'collector')
  const file = path.join(home, p.file)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, p.user)
  const manifest = newManifest()
  const e = applyTextEntry({ dir, manifest, harness: 'h', phase: p.phase, file, edit: p.edit(home), home })
  const text = WORDS[words](fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, text)
  Object.assign(e, { ops: e.ops.map((o) => ({ ...o, inserted: WORDS[words](o.inserted) })), post_sha256: sha256(Buffer.from(text)), ...(e.line ? { line: WORDS[words](e.line) } : {}) })
  return { home, dir, file, manifest, entry: e, text }
}

for (const p of PRIMITIVES) {
  for (const words of Object.keys(WORDS)) {
    test(`marker words · ${p.name} · ${words} words: install and on find the entry and write nothing; undo gives back the user's bytes`, () => {
      const x = placed(p, words)
      const again = applyTextEntry({ dir: x.dir, manifest: x.manifest, harness: 'h', phase: p.phase, file: x.file, edit: p.edit(x.home), home: x.home })
      assert.equal(again, null, 'already there: nothing applied')
      assert.equal(fs.readFileSync(x.file, 'utf8'), x.text, 'the file is byte for byte what it was')
      assert.equal(x.manifest.entries.length, 1, 'no second record')
      assert.throws(() => applyTextEntry({ dir: x.dir, manifest: newManifest(), harness: 'h', phase: p.phase, file: x.file, edit: p.edit(x.home), home: x.home }), /already holds trocar's text/, 'a manifest that does not list it never adds a second copy')
      assert.equal(fs.readFileSync(x.file, 'utf8'), x.text)
      const u = undoEntry(x.entry)
      assert.ok(['restored', 'reverted', 'reverted-not-identical'].includes(u.result) || u.result.startsWith('restored'), JSON.stringify(u))
      assert.equal(fs.readFileSync(x.file, 'utf8'), p.user, "undo: the user's bytes")
    })
    if (p.marker) test(`marker words · ${p.name} · ${words} words: the marker undo (no manifest) takes it out byte for byte`, () => {
      const x = placed(p, words)
      const plan = planByMarker({ home: x.home, ids: [p.marker], env: { HOME: x.home }, platform: 'linux' }).filter((i) => i.path === x.file)
      assert.equal(plan.length, 1, JSON.stringify(plan))
      const [r] = undoByMarker(plan, { home: x.home })
      assert.ok(!/^left|error/.test(r.result), JSON.stringify(r))
      assert.equal(fs.readFileSync(x.file, 'utf8'), p.user)
    })
  }
}

test('marker words: every command a freshly written marker names is a command of trocar (D58: the words are true)', () => {
  for (const p of PRIMITIVES) {
    const x = placed(p, 'current')
    const named = [...x.text.matchAll(/`trocar ([a-z-]+)`/g)].map((m) => m[1])
    assert.ok(named.length > 0, `${p.name}: the marker names its command`)
    for (const n of named) assert.ok(commandNamed(n) && !commandNamed(n).hidden, `${p.name}: trocar ${n} is a command`)
  }
})
