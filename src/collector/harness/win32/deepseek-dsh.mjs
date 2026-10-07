// win32/deepseek-dsh.mjs — DeepSeek dsh on Windows (RFC 4.8 §2.3 · §3.5 · §6.1; lab L1–L3, T0): data and the trust injection. Two forms, one entry group: `deepseek-dsh.cli` (node.exe running
// dsh's bin script) and `deepseek-dsh.desktop` (DeepSeek Harness.exe) both read %USERPROFILE%\.dsh\.env (or $DSH_HOME), so they share one group, one port, one listener. dsh accepts a
// proxy variable from the HOME .env (not a CA or TLS one, which it refuses to start on), and dsh configured with SOCKS silently goes direct [E19], so the entry is always http://.
// The CLI is `node.exe`, which is every Node program of the machine: it is told by its command line (…\@deepseek-ai\dsh), has no process rule in the kernel and is judged by the engine
// by pid on the group's port (4.8 §3.5). The desktop app's own image is unique, so it has a name rule as well as its path.
// Trust (§6.1): the plugin file asight-ca.mjs beside cordis.patch.yml and one sentinel row in that patch file, in the form lab L1 measured and [T0] re-measured (relative path, the row loaded
// the plugin): `- insert: [{id: asight-ca, name: ./asight-ca.mjs}]`. The plugin (plugins/win32/dsh.mjs) adds nothing on Node < 22.19 or under --use-openssl-ca.
import path from 'node:path'
import { expandHome } from '../../core/config-read.mjs'
import { lineComment } from '../../../off/text-edit.mjs'
import { renderPlugin } from '../_plugins.mjs'
import { fwd } from './_paths.mjs'

const raw = String.raw
const MIN_NODE = '22.19.0' // tls.setDefaultCACertificates
const dshHome = (ctx) => expandHome(ctx.env.get('DSH_HOME'), ctx.home) || path.join(ctx.home, '.dsh')

function inject(ctx) {
  const dir = dshHome(ctx)
  return {
    owned: [{ path: path.join(dir, 'asight-ca.mjs'), role: 'plugin', data: renderPlugin('win32/dsh.mjs', { caFile: fwd(ctx.caPem), markerDir: fwd(path.join(ctx.collectorDir, 'run', 'trust')) }) }],
    entries: [{ kind: 'text', format: 'yaml-list', path: path.join(dir, 'cordis.patch.yml'), line: `- insert: [{id: asight-ca, name: ./asight-ca.mjs}] ${lineComment("loads asight's CA trust plugin")}`, semantic: 'append' }],
    notes: [{ code: 'harness-note', text: `a dsh on Node older than ${MIN_NODE}, or started with --use-openssl-ca, does not add the asight CA and is not captured` }],
  }
}

export default {
  groups: [{
    g: 'deepseek-dsh.env',
    proxyEntry: { kind: 'file', format: 'dotenv-block', files: (ctx) => [path.join(dshHome(ctx), '.env')], block: { urlVar: 'HTTPS_PROXY', fixed: {} } },
    auth: true,
    followsSystemProxy: { http: false, ws: false },
  }],
  forms: [
    { id: 'deepseek-dsh.cli', g: 'deepseek-dsh.env', match: { image: 'node.exe', cmdline: [raw`@deepseek-ai\\dsh`] }, nameRule: false, processRules: false, supported: true },
    // %LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe
    { id: 'deepseek-dsh.desktop', g: 'deepseek-dsh.env', match: { image: 'DeepSeek Harness.exe', path: [raw`\\Programs\\DeepSeek Harness\\DeepSeek Harness\.exe`], reportUnknownPath: true }, nameRule: true, processRules: true, supported: true },
  ],
  inject,
  proxy: {
    env: ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'],
    files: [{ path: '%USERPROFILE%\\.dsh\\.env', key: 'HTTPS_PROXY', format: 'dotenv' }],
    systemProxy: { http: false, ws: false },
    schemes: ['http'],
    unsupported: { socks5: 'silent-direct' }, // dsh with a SOCKS proxy goes direct without a word [E19]
    branches: ['all'],
    measured: { win32: 'lab' },
    restart: { hint: 'dsh reads its .env at start (the desktop app on a hot reload): restart it', processes: ['node.exe', 'DeepSeek Harness.exe'] },
  },
}
