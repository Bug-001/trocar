// test/helpers/package-files.mjs — the one reading of what the product package ships: package.json, its lockfile when there is one,
// and every file under package.json's `files`. Product knowledge, so it lives with the product.
import fs from 'node:fs'
import path from 'node:path'
import { REPO } from './imports.mjs'

const walk = (root, rel) => {
  const abs = path.join(root, rel)
  if (!fs.statSync(abs).isDirectory()) return [rel]
  return fs.readdirSync(abs).sort().flatMap((n) => walk(root, `${rel}/${n}`))
}

/** The product as `npm pack` ships it, as paths relative to `root` (sorted within each `files` entry). */
export function productFiles(root = REPO) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  return ['package.json', ...['package-lock.json'].filter((f) => fs.existsSync(path.join(root, f))), ...(pkg.files || []).flatMap((f) => walk(root, f.replace(/\/$/, '')))]
}

export { REPO }
