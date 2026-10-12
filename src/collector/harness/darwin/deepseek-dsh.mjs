// darwin/deepseek-dsh.mjs — DeepSeek dsh on macOS (RFC 4.9 §2.3; the entry group, the dedicated port and the plugin trust are 4.8 §2.3 · §3.5 · §6.1): data, no behaviour but the
//   trust injection — the darwin twin of win32/deepseek-dsh.mjs, inferred everywhere until MA4. One form, one entry group: `deepseek-dsh.cli` is `node` running dsh's entry script
//   (the command line holds …/bin/dsh — the global npm symlink — or …/@deepseek-ai/dsh/lib/bin.js, the two shapes measured on Linux, 4.6's identity row) and it reads
//   ~/.dsh/.env (or $DSH_HOME), so the one form owns one group, one port and one listener. dsh accepts a proxy variable from the HOME .env (not a CA or TLS one, which it refuses
//   to start on), and dsh configured with SOCKS silently goes direct [E19], so the entry is always http://.
// `node` is every Node program of the machine: no PROCESS-NAME, and no process rule at all — the group's port is the dedicated port of 4.8 §3.5 and the engine judges by pid
//   (dsh's own subprocess runner and PTC children never read the .env, so they never reach the kernel through it; a pid that is not this form's, or none at all, is passed
//   through). The DESKTOP app is measured (on a macOS test machine, dmg 0.2.0-rc.2): it is NOT the CLI's twin — its dsh core READS ~/.dsh/.env (the real home,
//   NSHomeDirectory) but a launcher key there (DEEPSEEK_BASE_URL) is FATAL to it ("only the launching environment may set"), and a proxy key there is IGNORED by the
//   app's Chromium network service (measured: the Helper went direct with HTTPS_PROXY in .env). Its steering door is Chromium's --proxy-server at a credential-less
//   launcher — Claude Desktop's §6.4 shape — so the desktop is its OWN group with a launcher entry, never the CLI's .env group; the family is the bundle's main binary
//   and its Helpers (the network utility Helper owns the sockets, measured), and whether it follows the system proxy is unmeasured. The tui / web / acp modes of the CLI
//   loading the plugin before their first TLS connection is unmeasured too (4.6 lab ⑤ measured headless, on Linux only), which the restart hint carries.
// Trust (§6.1): the plugin and one sentinel row in $DSH_HOME/cordis.patch.yml, the Linux descriptor's `inject` layout — the plugin lives in asight's own directory
//   ~/.asight/collector/plugins/dsh/ and the row names it by its absolute path (the Windows twin moved the plugin beside the patch file with a relative name; that was its lab's
//   shape, not macOS's). The rendered plugin is the DARWIN twin (plugins/darwin/dsh.mjs, the win32 twin's shape): darwin has no /proc, so the platform-free plugin's marker
//   half — its start time from /proc/self/stat — cannot run here, and the twin answers it with performance.timeOrigin instead. It adds nothing on Node < 22.19 or under
//   --use-openssl-ca.
import path from 'node:path'
import { expandHome } from '../../core/config-read.mjs'
import { renderPlugin } from '../_plugins.mjs'
import linux from '../deepseek-dsh.mjs'

const raw = String.raw
const dshHome = (ctx) => expandHome(ctx.env.get('DSH_HOME'), ctx.home) || path.join(ctx.home, '.dsh')

function inject(ctx) {
  const base = linux.inject(ctx)
  const [plugin, manifest] = base.owned
  return { ...base, owned: [{ ...plugin, data: renderPlugin('darwin/dsh.mjs', { caFile: ctx.caPem, markerDir: path.join(ctx.collectorDir, 'run', 'trust') }) }, manifest] }
}

export default {
  groups: [{
    g: 'deepseek-dsh.env',
    proxyEntry: { kind: 'file', format: 'dotenv-block', files: (ctx) => [path.join(dshHome(ctx), '.env')], block: { urlVar: 'HTTPS_PROXY', fixed: {} } }, // the .env the trust patch row's home also owns; the proxy block is its own entry there (4.8 §2.3)
    auth: true,
    followsSystemProxy: { http: false, ws: false },
  }, {
    // the desktop app's own door (measured 2026-10-12): the CLI's .env is NOT it — a launcher key in ~/.dsh/.env is fatal to the desktop's dsh core and a proxy key there is
    // ignored by its Chromium network service; the launcher's --proxy-server is what steers, so this group's listener carries no credentials (4.9 §6.4's shape)
    g: 'deepseek-dsh.desktop',
    proxyEntry: { kind: 'launcher' },
    auth: false,
    followsSystemProxy: { http: 'unknown', ws: 'unknown' }, // the Helper went direct with no system proxy set; whether it FOLLOWS one is unmeasured
    optIn: [{ item: 'desktop-launcher', scope: 'user', impact: 'ONLY DeepSeek Harness instances started through the launcher are steered (a desktop that is already running is untouched): it starts the app with Chromium\'s proxy switch pointing at a loopback-only listener with no password, and the engine still judges every process' }],
  }],
  forms: [
    // the agent is node with dsh's entry script in its command line: …/bin/dsh (the global symlink) or …/@deepseek-ai/dsh/lib/bin.js (npm); no path of its own — node is not
    // unique — so the form has no process rule and the engine judges it by pid on the group's dedicated port (4.8 §3.5)
    { id: 'deepseek-dsh.cli', g: 'deepseek-dsh.env', match: { image: 'node', cmdline: [raw`@deepseek-ai\/dsh`, raw`\/bin\/dsh`] }, nameRule: false, processRules: false, supported: true },
    // the dmg app's family, measured 2026-10-12: the bundle's main binary and its Chromium Helpers — the network utility Helper owns the sockets (lsof, live); a Helper of
    // another app's bundle is not this form (the paths stay inside DeepSeek Harness.app)
    { id: 'deepseek-dsh.desktop', g: 'deepseek-dsh.desktop', match: { image: ['DeepSeek Harness', 'DeepSeek Harness Helper', 'DeepSeek Harness Helper (Renderer)', 'DeepSeek Harness Helper (GPU)'], path: [raw`\/DeepSeek Harness\.app\/Contents\/MacOS\/DeepSeek Harness`, raw`\/DeepSeek Harness\.app\/Contents\/Frameworks\/DeepSeek Harness Helper[^/]*\.app\/Contents\/MacOS\/DeepSeek Harness Helper[^/]*`] }, nameRule: false, processRules: true, supported: true },
  ],
  inject,
  proxy: {
    env: ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'],
    files: [{ path: '~/.dsh/.env', key: 'HTTPS_PROXY', format: 'dotenv' }],
    systemProxy: { http: false, ws: false },
    schemes: ['http'],
    unsupported: { socks5: 'silent-direct' }, // dsh with a SOCKS proxy goes direct without a word [E19]
    branches: ['all'],
    measured: { darwin: 'inferred' },
    restart: { hint: 'dsh reads its .env at start: restart it (the desktop app restarts through its launcher; the tui / web / acp modes are not yet measured on macOS)', processes: ['node', 'DeepSeek Harness'] },
  },
}
