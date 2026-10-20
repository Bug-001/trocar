// test/off/fixtures/seven-homes.mjs — a sandbox HOME in which all seven harness descriptors produce an entry (1.6 V15 / V25), laid out the way
// each harness's own test sets one up (test/collector/harness/*.test.mjs). Exports only; it writes under `home` and nowhere else.
//   claude-code  ~/.claude/settings.json (a JSON key)               codex         ~/.codex/.env (a block; the API key is a test value)
//   hermes       ~/.hermes/.env (a block)                           opencode      ~/.config/opencode/ (trocar adds its plugin file)
//   deepseek-dsh ~/.dsh/cordis.patch.yml, `[]` (a YAML row)         kimi-code     ~/.kimi-code/bin/kimi + ~/.bashrc with the installer's PATH line
//   z-code       ~/.zcode/cli/config.json (a JSON key)
// `env` has the user's own relay CA in NODE_EXTRA_CA_CERTS, so Claude Code and Kimi get an extra-*.pem and Z-Code folds it into its bundle.
import fs from 'node:fs'
import path from 'node:path'
import { createCa } from '../../../src/collector/core/tls/ca.mjs'

export const USER_CA = createCa({ commonName: 'seven-homes relay CA' })

/** → { files: { <harness id>: [the user files trocar changes for it] }, env, corp }. */
export function sevenHomes(home) {
  const put = (rel, text) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f }
  const corp = put('relay-ca.pem', USER_CA.certPem)
  const files = {
    'claude-code': [put('.claude/settings.json', '{\n  "model": "x"\n}\n')],
    codex: [put('.codex/.env', 'OPENAI_API_KEY=sk-test\n')],
    hermes: [put('.hermes/.env', 'OPENAI_API_KEY=sk-test-hermes\n')],
    opencode: [put('.config/opencode/opencode.json', '{}\n')],
    'deepseek-dsh': [put('.dsh/cordis.patch.yml', '[]\n')],
    'kimi-code': [put('.bashrc', '# kimi-code\nexport PATH="$HOME/.kimi-code/bin:$PATH"\nalias ll=\'ls -l\'\n')],
    'z-code': [put('.zcode/cli/config.json', '{\n  "model": "lab/m"\n}\n')],
  }
  put('.kimi-code/bin/kimi', '#!/bin/sh\nexit 0\n'); fs.chmodSync(path.join(home, '.kimi-code/bin/kimi'), 0o755)
  return { files, env: { HOME: home, NODE_EXTRA_CA_CERTS: corp }, corp }
}
