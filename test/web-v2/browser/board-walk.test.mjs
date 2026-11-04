// test/web-v2/browser/board-walk.test.mjs — scripts/board-walk.mjs (1.12 §5) in a child process against the real face on a temp HOME:
// AN12 walks every screen and keeps the token out of what it writes; AN13 reports a seeded dead control and counts what the cap left out.
// Asserted on walk.json's fields, the exit code and the files, never on words. Browser suite only (`npm run test:browser`).
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { launchChrome, probe } from './harness.mjs'
import { boardHome, serveBoard } from '../real-face.mjs'
import { tmpDir } from '../../helpers/tmp.mjs'
import { SCREEN_NAME } from '../../../web/legacy/labels/shell.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason
const SCRIPT = fileURLToPath(new URL('../../../scripts/board-walk.mjs', import.meta.url))
const BOARD = fileURLToPath(new URL('../../../src/web/board/', import.meta.url))

const address = (face) => `${face.base}/#t=${encodeURIComponent(face.token)}`

// async, never spawnSync: the face this walks is served by this process's event loop
const walk = (home, board, out) => new Promise((done) => {
  execFile(process.execPath, [SCRIPT, '--board', board, '--out', out], { env: { ...process.env, HOME: home.userHome, USERPROFILE: home.userHome } },
    (e, stdout, stderr) => {
      const file = path.join(out, 'walk.json')
      done({ code: e ? e.code : 0, stdout, stderr, doc: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { screens: [] } })
    })
})

// the board's build with `html` at the top of its <body>, served on a demo home; → what the walk answers and the number of `selector`
// matches a fresh page of `hash` holds
async function seeded(html, hash, selector, boardFile) {
  const dir = path.join(tmpDir('trocar-walk-board-'), 'board')
  fs.cpSync(BOARD, dir, { recursive: true })
  const index = path.join(dir, 'index.html')
  fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace(/<body[^>]*>/, (m) => m + html))
  const was = process.env.TROCAR_BOARD_DIR
  process.env.TROCAR_BOARD_DIR = dir
  const home = boardHome()
  const face = await serveBoard(home)
  if (was === undefined) delete process.env.TROCAR_BOARD_DIR
  else process.env.TROCAR_BOARD_DIR = was
  try {
    const tmp = tmpDir('trocar-walk-')
    const board = path.join(tmp, 'board')
    fs.writeFileSync(board, boardFile(address(face)))
    const r = await walk(home, board, path.join(tmp, 'out'))
    const browser = await launchChrome(gate.chromium)
    try {
      const page = await (await browser.newContext()).newPage()
      await page.goto(address(face), { waitUntil: 'load' })
      await page.evaluate((h) => { location.hash = h }, hash)
      await page.waitForTimeout(2000)
      return { ...r, controls: await page.locator(selector).count() }
    } finally { await browser.close() }
  } finally { await face.close() }
}

test('AN12 every screen of the board is walked, one item and one PNG each, and no written file holds the token', { skip }, async () => {
  const home = boardHome({ bytes: 2e5 })
  const face = await serveBoard(home)
  try {
    const tmp = tmpDir('trocar-walk-')
    const board = path.join(tmp, 'board'), out = path.join(tmp, 'out')
    fs.writeFileSync(board, `${address(face)}\n`)
    const r = await walk(home, board, out)
    assert.deepEqual(r.doc.screens.map((s) => s.screen).sort(), Object.keys(SCREEN_NAME).sort())
    for (const s of r.doc.screens) {
      assert.ok(s.shot && fs.existsSync(path.join(out, s.shot)), s.screen)
      assert.deepEqual(s.errors.page, [], s.screen)
    }
    assert.ok(!`${r.stdout}${r.stderr}`.includes(face.token))
    for (const f of fs.readdirSync(out, { recursive: true })) {
      const file = path.join(out, f)
      if (fs.statSync(file).isFile()) assert.ok(!fs.readFileSync(file).includes(face.token), f)
    }
  } finally { await face.close() }
})

test('AN13 a seeded dead control is reported and exits 1; past the cap the rest is counted in skipped', { skip }, async () => {
  const dead = '<button aria-expanded="false" aria-label="seeded-dead" style="position:fixed;left:0;bottom:0;z-index:2147483647">x</button>' +
    '<div role="separator" tabindex="0" aria-label="seeded-split" style="position:fixed;left:40px;bottom:0;width:8px;height:40px;z-index:2147483647"></div>'
  const one = await seeded(dead, '#/settings/appearance', '[aria-expanded], summary', (url) => JSON.stringify({ url }))
  const walked = one.doc.screens.find((s) => s.screen === 'settings-appearance')
  assert.equal(one.code, 1)
  assert.equal(one.doc.ok, false)
  assert.ok(walked.dead.some((d) => d.name === 'seeded-dead'))
  assert.ok(walked.dead.some((d) => d.role === 'separator' && d.name === 'seeded-split'))

  const many = Array.from({ length: 50 }, (_, i) => `<button aria-expanded="false" style="width:9px;height:9px;padding:0">${i}</button>`).join('')
  const crowd = await seeded(`<div style="position:fixed;left:0;right:0;bottom:0;display:flex;flex-wrap:wrap;z-index:2147483647">${many}</div>`,
    '#/settings/appearance', '[aria-expanded], summary', (url) => `${url}\n`)
  const counted = crowd.doc.screens.find((s) => s.screen === 'settings-appearance')
  assert.ok(counted.skipped.expand > 0)
  assert.equal(counted.did.expand + counted.skipped.expand, crowd.controls)
})
