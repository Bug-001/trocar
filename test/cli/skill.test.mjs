// test/cli/skill.test.mjs — `trocar skill` (RFC 1.6 §5.6, 1.12 AN1-AN4, D81①): the skills that ship with trocar, listed and printed byte for byte.
// Every run is the real command in a real process under a sandbox HOME; the expected values are the files under skills/ themselves.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpDir } from '../helpers/tmp.mjs'
import { snapshot } from '../query/raw-home.mjs'
import { productFiles, REPO } from '../helpers/package-files.mjs'

const BIN = path.join(REPO, 'bin/trocar.mjs')
const SKILLS = path.join(REPO, 'skills')
const names = fs.readdirSync(SKILLS).sort()
const fileOf = (name) => fs.readFileSync(path.join(SKILLS, name, 'SKILL.md'))
const trocar = (home, ...argv) => spawnSync(process.execPath, [BIN, ...argv], { env: { ...process.env, HOME: home, USERPROFILE: home } })

test('AN1: `skill --json` lists every skill under skills/, its name the directory and its description the one the front matter gives', () => {
  const r = trocar(tmpDir(), 'skill', '--json')
  assert.equal(r.status, 0)
  assert.equal(r.stderr.length, 0)
  const doc = JSON.parse(r.stdout)
  assert.deepEqual(Object.keys(doc).sort(), ['command', 'ok', 'schema', 'skills'])
  assert.deepEqual([doc.schema, doc.command, doc.ok], [2, 'skill', true])
  assert.deepEqual(doc.skills.map((s) => s.name), names)
  for (const s of doc.skills) {
    assert.deepEqual(Object.keys(s).sort(), ['description', 'name'])
    assert.ok(s.description.length > 0 && s.description.length <= 1024, s.name)
    assert.ok(fileOf(s.name).includes(`\ndescription: ${s.description}\n`), s.name)
  }
})

test('AN2: `skill <name>` prints the file byte for byte, and `--json` carries the same text', () => {
  const home = tmpDir()
  for (const name of names) {
    const printed = trocar(home, 'skill', name)
    assert.equal(printed.status, 0, name)
    assert.ok(printed.stdout.equals(fileOf(name)), `${name}: stdout is the file`)
    const r = trocar(home, 'skill', name, '--json')
    assert.equal(r.status, 0, name)
    const doc = JSON.parse(r.stdout)
    assert.deepEqual(Object.keys(doc).sort(), ['command', 'description', 'name', 'ok', 'schema', 'text'])
    assert.deepEqual([doc.schema, doc.command, doc.ok, doc.name], [2, 'skill', true, name])
    assert.ok(fileOf(name).includes(`\ndescription: ${doc.description}\n`), name)
    assert.equal(doc.text, fileOf(name).toString('utf8'), name)
  }
})

test('AN3: a name that is not a skill, or two names, is exit 2 and `usage`; no run of `skill` leaves anything in HOME', () => {
  const home = tmpDir()
  fs.writeFileSync(path.join(home, 'kept'), 'x')
  const before = snapshot(home)
  for (const bad of [['no-such-skill'], ['../../README.md'], [`${names[0]}/SKILL.md`], [names[0].toUpperCase()], [names[0], names[1]]]) {
    const text = trocar(home, 'skill', ...bad)
    assert.equal(text.status, 2, bad.join(' '))
    assert.equal(text.stdout.length, 0, bad.join(' '))
    assert.ok(text.stderr.length > 0, bad.join(' '))
    const r = trocar(home, 'skill', ...bad, '--json')
    assert.equal(r.status, 2, bad.join(' '))
    assert.equal(r.stderr.length, 0, bad.join(' '))
    const doc = JSON.parse(r.stdout)
    assert.deepEqual([doc.schema, doc.command, doc.ok, doc.error.code], [2, 'skill', false, 'usage'], bad.join(' '))
  }
  for (const good of [[], ['--json'], [names[0]], [names[0], '--json']]) assert.equal(trocar(home, 'skill', ...good).status, 0, good.join(' '))
  assert.deepEqual(snapshot(home), before)
})

test('AN4: the package ships every skill', () => {
  const shipped = new Set(productFiles())
  for (const name of names) assert.ok(shipped.has(`skills/${name}/SKILL.md`), name)
})
