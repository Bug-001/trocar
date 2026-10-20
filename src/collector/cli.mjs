// cli.mjs — `trocar setup-helper`, the machine-wide half of the Linux helper (sudo, once; RFC 4.6 §控制面, §安装清单与卸载, D36). The commands themselves are
// src/cli/commands.mjs's table (1.6 §2). Exit codes: 0 ok · 1 the step failed · 2 usage.
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
    const i = argv.indexOf('--binary')
    const r = A.install.setupHelper({ binarySrc: i >= 0 ? argv[i + 1] : path.join(packageRoot, 'src', 'collector', 'arch', 'linux', 'trocar-redirector') })
    out(`installed ${r.bin} (${r.getcap})${r.swept && r.swept.length ? `\nremoved ${r.swept.length} copy(ies) an interrupted setup-helper had staged: ${r.swept.join(', ')}` : ''}`)
    return 0
  } catch (e) { err(`trocar setup-helper: ${(e && e.message) || e}`); return 1 }
}
