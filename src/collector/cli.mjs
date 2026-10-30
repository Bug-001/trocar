// cli.mjs — `trocar setup-helper`, the machine-wide half of the Linux helper (sudo, once; RFC 4.6 §控制面, §安装清单与卸载, D36). The commands themselves are
// src/cli/commands.mjs's table (1.6 §2). Exit codes: 0 ok · 1 the step failed · 2 usage.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// Every file `on` will write or change, printed before it writes any (4.6): src/cli/receipt.mjs holds the words, this is where the
// collector's callers have always found it.
export { formatPlan } from '../cli/receipt.mjs'

const loadDaemon = () => import('./daemon.mjs')

export async function runSetupHelper(argv, { arch = null, out = (s) => console.log(s), err = (s) => console.error(s), packageRoot = PACKAGE_ROOT } = {}) {
  try {
    const A = arch || (await (await loadDaemon()).loadArch())
    if (argv.includes('--remove')) {
      const r = A.install.uninstallHelper()
      out(`Removed the kernel helper ${A.install.DEFAULTS.helperBin}.${r.warnings.length ? `\nWarning: ${r.warnings.join('; ')}` : ''}`)
      return 0
    }
    const i = argv.indexOf('--binary'), dir = path.join(packageRoot, 'src', 'collector', 'arch', 'linux')
    const binarySrc = i >= 0 ? argv[i + 1] : path.join(dir, 'trocar-redirector')
    if (!binarySrc || !fs.existsSync(binarySrc)) { // a fresh checkout: the helper is built from source first (README · Install)
      err(i >= 0 ? `trocar setup-helper: --binary ${binarySrc ? `${binarySrc} is not a file` : 'needs the path of a helper you built'}.`
        : `trocar setup-helper: the helper is not built in this checkout yet.\nBuild it once as yourself, not as root (it needs clang, make, bpftool and\nthe libbpf, libelf and zlib development files):\n  make -C ${dir}\nThen run sudo trocar setup-helper again. To install a helper you built\nelsewhere, pass --binary and its path.`)
      return 1
    }
    const r = A.install.setupHelper({ binarySrc })
    out(`installed ${r.bin} (${r.getcap})${r.swept && r.swept.length ? `\nremoved ${r.swept.length} copy(ies) an interrupted setup-helper had staged: ${r.swept.join(', ')}` : ''}`)
    return 0
  } catch (e) { err(`trocar setup-helper: ${(e && e.message) || e}`); return 1 }
}
