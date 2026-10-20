// native.mjs — where the macOS native pieces live in the package and the sha256 they are pinned to (plan decision #10).
// The binaries are committed prebuilt (scripts/build-darwin-native.sh is the one deliberate rebuild) and native/pins.json is the
// ONE place their hashes are written; `npm pack` copies both and nothing rebuilds at pack time.
import crypto from 'node:crypto'
import nodeFs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The file name of each native piece, as built, shipped and installed. */
export const NATIVE = Object.freeze({ signHelper: 'asight-sign-helper', procenv: 'procenv', socktable: 'socktable' })

/** The packaged path of a native piece (`NATIVE.*`); `ASIGHT_NATIVE_DIR` names another directory to run them from (a test's stubs: npm test runs no real tool, 0.1 §3). */
export const nativePath = (name, env = process.env) => (env.ASIGHT_NATIVE_DIR ? path.join(env.ASIGHT_NATIVE_DIR, name) : fileURLToPath(new URL(`./native/${name}`, import.meta.url)))

/** { <name>: <sha256 hex> } from native/pins.json. */
export const pins = (fs = nodeFs) => JSON.parse(fs.readFileSync(fileURLToPath(new URL('./native/pins.json', import.meta.url)), 'utf8'))

export const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
