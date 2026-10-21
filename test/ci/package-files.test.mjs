// package-files.test.mjs — what the product package carries (test/helpers/package-files.mjs reads it from package.json's `files`).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { productFiles, REPO } from '../helpers/package-files.mjs'
import { NATIVE } from '../../src/collector/arch/darwin/native.mjs'

test('CM34: the package carries the prebuilt macOS native binaries and builds nothing at pack time (plan decision #10)', () => {
  const product = new Set(productFiles())
  for (const f of [...Object.values(NATIVE), 'pins.json']) assert.ok(product.has(`src/collector/arch/darwin/native/${f}`), `${f} is packed`)
  const scripts = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).scripts || {}
  for (const hook of ['prepack', 'prepare', 'prepublish', 'prepublishOnly', 'postpack', 'preinstall', 'install', 'postinstall']) assert.equal(scripts[hook], undefined, `package.json has no ${hook} script`)
})
