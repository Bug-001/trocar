// test/helpers/rm-tree.cjs — remove a directory tree, mode-000 entries included. CommonJS because test/helpers/leak-guard.cjs
// (a `--require` preload, the only kind the test runner's own process loads) needs it and cannot import ES modules.
'use strict'
const fs = require('node:fs')
const path = require('node:path')

/** Removes `dir` and everything in it; a test that chmod'ed something to 000 and left it that way does not stop it. Never throws. */
function removeTree(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); return } catch { /* a mode-000 entry: open it up, then again */ }
  openUp(dir)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* what is left is for the leak check to name */ }
}

function openUp(p) {
  try {
    const st = fs.lstatSync(p)
    if (st.isSymbolicLink()) return
    fs.chmodSync(p, st.isDirectory() ? 0o700 : 0o600)
    if (st.isDirectory()) for (const name of fs.readdirSync(p)) openUp(path.join(p, name))
  } catch { /* gone, or not ours to open */ }
}

module.exports = { removeTree }
