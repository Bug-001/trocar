// scripts/lib/trocar-cli.mjs — how a script finds the trocar CLI and calls it (spec 1.12 §4): the one on PATH, or the one named.
// Windows reaches `trocar.cmd` only through a shell, and a session id comes from the capture, so what a shell would read never gets there.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'

const WIN = process.platform === 'win32'
const PLAIN = /^[\w.:+=@/\\-]+$/

/** findCli(given) → {file, lead, shell}, or null when there is no such CLI. `given` is a path: `.mjs` and `.js` run with node, the rest directly. */
export function findCli(given) {
  if (given !== undefined) {
    if (!fs.existsSync(given)) return null
    return /\.m?js$/.test(given) ? { file: process.execPath, lead: [given], shell: false } : { file: given, lead: [], shell: WIN }
  }
  return spawnSync('trocar', ['--version'], { stdio: 'ignore', shell: WIN }).status === 0 ? { file: 'trocar', lead: [], shell: WIN } : null
}

/** callOf(cli, args) → [file, argv, {shell}], what to spawn. Throws on an argument a shell would read as more than a word. */
export function callOf(cli, args) {
  if (cli.shell && !args.every((a) => PLAIN.test(a))) throw new Error('an argument is not safe to hand to a shell')
  return [cli.file, [...cli.lead, ...args], { shell: cli.shell }]
}
