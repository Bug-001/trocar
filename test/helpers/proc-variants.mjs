// test/helpers/proc-variants.mjs — bend one process seed (test/helpers/proc-seeds.mjs) along the axes an install varies on, keeping what the
// process IS (plan 2026-10-14-d51-name-allowlist G2): every variant has the seed's `harness` and `source`, plus `variant` naming the axis. The
// axes: the install prefix (Homebrew and its Caskroom, npm global, nvm, volta, pnpm, bun, a version-named file under ~/.local/share/<prog>/versions,
// /Applications and ~/Applications; on Windows AppData\Local\Programs, Program Files, scoop, an MSIX WindowsApps package), the editor extension
// directories (.vscode .cursor .vscode-insiders .vscode-oss .windsurf), letter case, `.exe`, ` (deleted)`, directories with spaces and Chinese,
// argv[0] a symlink's name while the exe is the real file, and Windows quotes and slashes. It derives the program file name itself (the last
// segment, or the directory above `versions` for a version-named file), not with the code under test.
//
//   import { variantsOf } from '../helpers/proc-variants.mjs'
//   for (const v of [seed, ...variantsOf(seed)]) …
const VERSION = /^v?\d+(\.\d+)+([-+][0-9a-z.]+)?$/i
const EDITORS = ['.vscode', '.cursor', '.vscode-insiders', '.vscode-oss', '.windsurf']

const winCmd = (argv) => argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')

/** The program file of an exe path: its last segment (no ` (deleted)`), or, for a version-named file, the directory above `versions` / `bin`. */
function programFile(exe, os) {
  const segs = exe.replace(/ \(deleted\)$/, '').split(os === 'win32' ? /[\\/]/ : /\//).filter(Boolean)
  let i = segs.length - 1
  if (!VERSION.test(segs[i])) return segs[i]
  for (i--; i >= 0; i--) if (!VERSION.test(segs[i]) && segs[i] !== 'versions' && segs[i] !== 'bin') return segs[i]
  return segs[segs.length - 1]
}

function prefixesOf(os, file) {
  const prog = file.replace(/\.exe$/i, '')
  if (os === 'win32') {
    const W = String.raw`C:\Users\u`
    return [
      ['programs', `${W}\\AppData\\Local\\Programs\\${prog}`],
      ['program-files', `C:\\Program Files\\${prog}`],
      ['scoop', `${W}\\scoop\\apps\\${prog}\\current`],
      ['windowsapps', String.raw`C:\Program Files\WindowsApps\Vendor.App_1.2.3.0_x64__8wekyb3d8bbwe\app`],
      ['npm-global', `${W}\\AppData\\Roaming\\npm\\node_modules\\@scope\\pkg\\bin`],
      ...EDITORS.map((e) => [`editor:${e}`, `${W}\\${e}\\extensions\\pub.ext-1.2.3-win32-x64\\bin`]),
      ['space-cjk', `${W}\\我的 工具\\a b`],
    ].map(([k, dir]) => [k, `${dir}\\${file}`])
  }
  const H = os === 'darwin' ? '/Users/u' : '/home/u'
  const list = [
    ['homebrew', '/opt/homebrew/bin'],
    ['caskroom', `/opt/homebrew/Caskroom/${prog}/9.9.9`],
    ['npm-global', '/usr/local/lib/node_modules/@scope/pkg/bin'],
    ['nvm', `${H}/.nvm/versions/node/v22.20.0/bin`],
    ['volta', `${H}/.volta/tools/image/packages/pkg/bin`],
    ['pnpm', os === 'darwin' ? `${H}/Library/pnpm` : `${H}/.local/share/pnpm`],
    ['bun', `${H}/.bun/bin`],
    ...EDITORS.map((e) => [`editor:${e}`, `${H}/${e}/extensions/pub.ext-1.2.3-${os}-arm64/bin`]),
    ['space-cjk', `${H}/我的 工具/a b`],
  ]
  if (os === 'darwin') list.push(['applications', `/Applications/${prog}.app/Contents/MacOS`], ['user-applications', `${H}/Applications/${prog}.app/Contents/MacOS`])
  return [...list.map(([k, dir]) => [k, `${dir}/${file}`]), ['versions-file', `${H}/.local/share/${prog}/versions/9.9.9`]]
}

/** The variants of one seed (not the seed itself). */
export function variantsOf(seed) {
  const { os } = seed
  const file = programFile(seed.exe, os)
  const out = []
  const add = (variant, exe, argv) => {
    const v = { ...seed, exe, argv, variant }
    if (seed.cmdline != null) v.cmdline = os === 'win32' ? winCmd(argv) : argv.join(' ')
    out.push(v)
  }
  const withExe = (exe) => [seed.argv[0] === seed.exe ? exe : seed.argv[0], ...seed.argv.slice(1)]
  for (const [k, exe] of prefixesOf(os, file)) add(`prefix:${k}`, exe, withExe(exe))
  // letter case: the file name upper-cased (darwin and Windows compare names ignoring case; the normalizer lower-cases on every OS)
  if (seed.exe.endsWith(file)) {
    const upper = seed.exe.slice(0, seed.exe.length - file.length) + file.toUpperCase()
    if (upper !== seed.exe) add('case', upper, withExe(upper))
  }
  // argv[0] a symlink's name, the exe the real (version-named) file it points at
  if (os !== 'win32' && seed.argv[0] === seed.exe) {
    const H = os === 'darwin' ? '/Users/u' : '/home/u'
    add('symlink-argv0', `${H}/.local/share/${file}/versions/9.9.9`, [`/usr/local/bin/${file}`, ...seed.argv.slice(1)])
  }
  if (os === 'linux') add('deleted', `${seed.exe.replace(/ \(deleted\)$/, '')} (deleted)`, seed.argv)
  if (os === 'win32') {
    if (/\.exe$/i.test(seed.argv[0])) add('argv0-no-exe', seed.exe, [seed.argv[0].replace(/\.exe$/i, ''), ...seed.argv.slice(1)])
    add('forward-slashes', seed.exe, seed.argv.map((a) => a.replace(/\\/g, '/')))
    add('back-slashes', seed.exe, [seed.argv[0], ...seed.argv.slice(1).map((a) => (/^[A-Za-z]:\//.test(a) ? a.replace(/\//g, '\\') : a))])
    add('quoted', seed.exe, seed.argv.map((a) => `"${a}"`))
  }
  return out
}
