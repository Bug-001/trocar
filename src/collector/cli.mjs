// cli.mjs — `trocar setup-helper`, the machine-wide half of the Linux helper (sudo, once; RFC 4.6 §控制面, §安装清单与卸载, D36). The commands themselves are
// src/cli/commands.mjs's table (1.6 §2). Exit codes: 0 ok · 1 the step failed · 2 usage.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { shellArg, wrap } from '../cli/text.mjs'
import { COMMAND_INDENT } from '../off/receipt.mjs'

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
      out(`Removed the capability helper ${A.install.DEFAULTS.helperBin}.${r.warnings.length ? `\nWarning: ${r.warnings.join('; ')}` : ''}`)
      return 0
    }
    const i = argv.indexOf('--binary'), dir = path.join(packageRoot, 'src', 'collector', 'arch', 'linux')
    const binarySrc = i >= 0 ? argv[i + 1] : path.join(dir, 'trocar-redirector')
    if (!binarySrc || !fs.existsSync(binarySrc)) { // a fresh checkout: the helper is built from source first (README · Install)
      err(i >= 0 ? `trocar setup-helper: --binary ${binarySrc ? `${binarySrc} is not a file` : 'needs the path of a helper you built'}.`
        : `trocar setup-helper: the helper is not built yet. Build it as yourself first:\n${COMMAND_INDENT}make -C ${shellArg(dir)}`)
      return 1
    }
    const r = A.install.setupHelper({ binarySrc })
    const swept = r.swept && r.swept.length ? [`Also removed ${r.swept.length === 1 ? 'a staged copy' : `${r.swept.length} staged copies`} an interrupted setup-helper left:`] : []
    out([...[`Installed the capability helper ${r.bin} with the capabilities ${r.caps}.`, ...swept].flatMap((l) => wrap(l)), ...(swept.length ? r.swept.map((n) => `  ${path.join(path.dirname(r.bin), n)}`) : [])].join('\n')) // 80 columns, a path never broken, a label's paths one a line two in (1.6 §1.1⑥)
    return 0
  } catch (e) { err(`trocar setup-helper: ${(e && e.message) || e}`); return 1 }
}
