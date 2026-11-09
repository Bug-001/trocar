// scripts/is-main.mjs — is this module the program node was asked to run? Compared by the real path of both, so a script
// run through a symbolic link (the way a checkout may reach scripts/) still runs; a path that cannot be resolved is not it.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export function isMain(url) {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(url)) } catch { return false }
}
