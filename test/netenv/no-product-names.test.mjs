// test/netenv/no-product-names.test.mjs — D43 · D49, invariant 6: trocar does not recognise or show a VPN / proxy product, so the
// code of src/ names none — not in a message, a path, a kind, a constant. Comments may (a reason can cite the product it is about). Static half; the names are the
// products of the D43 / D49 decisions and of write-scan.mjs's PRODUCT_DIR_NAMES (the data directories N15 watches), as whole words, any case.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findIn } from '../helpers/code-text.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const walk = (d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : /\.(mjs|cjs|js|ps1|tmpl)$/.test(e.name) ? [path.join(d, e.name).split(path.sep).join('/')] : [])
const PRODUCTS = ['clash', 'verge', 'mihomo', 'flclash', 'sing-box', 'singbox', 'v2rayn', 'v2ray', 'nekoray', 'hiddify', 'shadowrocket', 'quantumult', 'surge']
const PRODUCT = new RegExp(`(?<![a-z0-9])(${PRODUCTS.join('|')})(?![a-z0-9])`, 'gi')
/** Exemptions, by file (and, inside a file, by the exact text matched), each with its reason. A row that excuses nothing is a finding. */
const EXEMPT = [
  { file: 'src/off/manifest.mjs', text: 'clash', reason: '`legacy-clash-block` is a manifest kind an old install wrote; off must still parse it to list it as left (D57)' },
  { file: 'src/off/undo.mjs', text: 'mihomo', reason: 'the kernel-era uninstall removes the license files it shipped beside its copy (it is kept)' },
]
const excused = (f, text) => EXEMPT.some((x) => x.file === f && (!x.text || x.text === text.toLowerCase()))
export const productFindings = (files, read) => files.flatMap((f) => findIn(read(f), PRODUCT).filter((h) => !excused(f, h.text)).map((h) => `${f}:${h.line} ${h.text}`))

test('the code of src/ names no VPN / proxy product (comments excluded; the rows below exempt)', () => {
  const files = walk('src'), read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
  assert.deepEqual(productFindings(files, read), [], 'trocar does not recognise or show a VPN / proxy product (D43 · D49): say 「你的代理软件」')
  const stale = EXEMPT.filter((x) => !files.includes(x.file) || !findIn(read(x.file), PRODUCT).some((h) => !x.text || h.text.toLowerCase() === x.text))
  assert.deepEqual(stale, [], 'an exemption that excuses nothing any more: delete its row')
})

test('the scan goes red on a seeded name in a string or an identifier, and not on a comment or a longer word', () => {
  const seeded = { 'src/netenv/x.mjs': "// Clash is fine here\nconst msg = '跟着它的 Clash 配置'\nconst v2rayN = 1; const converge = 2 /* mihomo */\nconst dir = 'io.github.clash-verge-rev'" }
  assert.deepEqual(productFindings(Object.keys(seeded), (f) => seeded[f]), ['src/netenv/x.mjs:2 Clash', 'src/netenv/x.mjs:3 v2rayN', 'src/netenv/x.mjs:4 clash', 'src/netenv/x.mjs:4 verge'])
})
