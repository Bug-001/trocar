// commands.mjs — the table of commands, the hidden aliases and the help (RFC 1.6 §2, R10): the one list help prints, src/cli/main.mjs dispatches and test/cli/dispatch.test.mjs (V19) holds equal.
//   COMMANDS         [{ name, section: 'common' | 'data' | 'maintenance', usage, summary, notes?, also?, mutates, needsRoot?, run(argv, ctx) → exit }]. `usage` is one or more lines (each begins
//                    with `asight <name>`, or `sudo asight <name>`); `also` puts more lines of the same command under another section (`raw` is in two). `mutates`: R7 — the per-user commands
//                    that change state refuse root (on off uninstall daemon). `needsRoot`: setup-helper, the only command that must be root. `run` gets the argv after the name and the context
//                    of runCli: { io, env, home, platform, uid, deps }; each takes what it needs from `deps` (0.1 §3): the old bodies `runLegacy`, `setup-helper` `arch`.
//   HIDDEN_ALIASES  [{ argv, to }]: not in help, dispatched like the command they name; what follows the alias is passed on as typed.
//   helpText        the help: three sections; one command when named.
const SECTIONS = Object.freeze([['common', '常用'], ['data', '数据'], ['maintenance', '维护']])
const via = (file, fn) => async (argv, c) => (await import(file))[fn](argv, c)
// `deps.runLegacy(name, argv)` replaces the runner of the old bodies: a test asks which body a command reaches, not what it does (those read and write the machine)
const legacy = (name) => async (argv, c) => ((c && c.deps && c.deps.runLegacy) || (await import('./legacy-commands.mjs')).runLegacyCommand)(name, argv)

/** `asight doctor`; `doctor --only old-ca` is the hidden target of the alias `verify` (the old CA is in the user trust store, and only there). */
async function doctor(argv, c) {
  if (argv.length === 2 && argv[0] === '--only' && argv[1] === 'old-ca') return (await import('./legacy-commands.mjs')).verifyOldCa(c)
  return (await import('./doctor.mjs')).runDoctor(argv, c)
}

async function setupHelper(argv, c) {
  const { runSetupHelper } = await import('../collector/cli.mjs')
  return runSetupHelper(argv, { out: c.io.out, err: c.io.err, ...(c.deps.arch ? { arch: c.deps.arch } : {}) })
}

async function help(argv, c) {
  if (argv.length > 1) { c.io.err('usage: asight help [命令]'); return 2 }
  if (argv.length === 1 && !commandNamed(argv[0])) { c.io.err(`asight help: 没有这个命令 ${argv[0]}\n${helpText(undefined, { platform: c.platform })}`); return 2 }
  c.io.out(helpText(argv[0], { platform: c.platform }))
  return 0
}

export const COMMANDS = Object.freeze([
  { name: 'on', section: 'common', mutates: true, run: via('./on.mjs', 'runOnCli'),
    usage: 'asight on [harness…] [--dry-run] [--yes] [--no-autostart | --no-unit] [--json]',
    summary: '开始采集。只接代理,不写证书;还没跑过 asight install 时拒绝(cert-not-installed)。',
    notes: ['--dry-run  只打印将要做的,什么都不写', '--yes  不在终端里时代替确认(没有它,不在终端里只打印计划、退出 2)', '--no-autostart  装单元但不 enable,本次只 start', '--no-unit  不装自启单元(测试用;平台自启机制见回执)', 'on 不重启任何 agent、桌面程序或在跑的采集;要重启的进程在回执里列出'] },
  { name: 'install', section: 'common', mutates: true, run: via('./install.mjs', 'runInstallCli'),
    usage: 'asight install [--dry-run] [--yes] [--json]',
    summary: '一次性装好证书(D55):生成本机的根、装成用户级根证书、放 harness 自己读的证书载体。先打印计划、等确认。',
    notes: ['--dry-run  只打印计划', '--yes  不在终端里时代替确认(没有它,不在终端里只打印计划、退出 2)', '退出码:0 全部装好 · 1 部分或失败 · 2 用法错误,或不在终端又没有 --yes'] },
  { name: 'off', section: 'common', mutates: true, run: via('../off/main.mjs', 'runOffCli'),
    usage: 'asight off [harness…] [--now] [--dry-run] [--yes] [--json]',
    summary: '撤掉 asight 对这些 agent 的全部影响;asight 自己坏了也能用(~/.asight/bin/asight-off)。',
    notes: ['不带名字:全部 harness,并让守护进程排空后退出、停用自启', '--now  不等在途连接,立即切断', '--yes  只在清单丢失、按标记撤销时用', '--remove-ca  照收,没有作用:off 不动旧采集留在机器上的东西(按 README 手动清理)'] },
  { name: 'status', section: 'common', mutates: false, run: via('./status.mjs', 'runStatusCli'),
    usage: 'asight status [harness…] [--json] [--failures]',
    summary: '每个 agent 有没有被采集、为什么;守护进程、助手、仍经 asight 的连接、最近 24 h 的失败、每个 agent 的数据路径。',
    notes: ['退出码:0 都在被采集 · 1 有的没有 · 3 读不到、无法判定', '不带名字是一屏摘要(失败只印条数与最新一条);点名 harness 看它的明细;--failures 印完整失败墙'] },
  { name: 'uninstall', section: 'common', mutates: true, run: via('./uninstall.mjs', 'runUninstallCli'),
    usage: 'asight uninstall [--purge-data] [--dry-run] [--yes] [--json]',
    summary: '撤 install 装的一切(根、证书载体、清单、备份、单元),根的密钥最后删。macOS / Windows 上采集还开着或还有持有者时拒绝(先 asight off);Linux 先做 off 的全部。采集数据留着,--purge-data 才删(要确认)。' },
  { name: 'doctor', section: 'common', mutates: false, run: doctor,
    usage: 'asight doctor [harness…] [--source <ndjson|dir>] [--json]',
    summary: '自检:是否真在抓、抓得对不对、凭据没漏、没弱化全机 TLS、采集文件仅属主可读;核对 asight-off 副本。',
    notes: ['退出码:0 · 1 采集文件可被他人读取 · 3 无法判定(零条记录不是通过)'] },
  { name: 'serve', section: 'data', mutates: false, run: legacy('serve'),
    usage: 'asight serve [--port 9800] [--db <path>] [--source <ndjson|dir>] [--control]',
    summary: '只读看板(只绑环回);不带 --source 读默认的采集目录。' },
  { name: 'etl', section: 'data', mutates: false, run: legacy('etl'),
    usage: 'asight etl <ndjson|sealed|dir> [--db <path>] [--rebuild]',
    summary: '把采集装进 DuckDB(派生层,可由原始文件重建)。' },
  { name: 'shard', section: 'data', mutates: false, run: legacy('shard'),
    usage: 'asight shard [<ndjson>] [--out <dir>] [--watch] [--interval <s>] [--rebuild-meta | --resplit]',
    summary: '把采集流按 session 分片(ETL 的第一步:看板与封存读的都是分片目录)。' },
  { name: 'keep', section: 'data', mutates: true, run: via('./keep.mjs', 'runKeepCli'),
    usage: 'asight keep [<harness|all> <class|all> <full|log>] [--db <store>] [--json]',
    summary: '每个 harness × 流量类别存多少:不带参数显示设置与各类占的大小;三个词是设置(full = 体逐字存,log = 只记头与大小)。不需要守护进程;只管之后开始的调用,已存的不动。',
    notes: ['类别:llm · token-count · session-sync · telemetry · files · account · other', 'harness 接受 on / off / status 用的名字(claude-code、claude、dsh …)和设置文件自己的名字(cc …);显示时印设置文件自己的名字', '--db <store>  从另一个分析库读大小;--json  把同一份报告(看板的 /api/retention)印成 JSON',
      '写 ~/.asight/retention.json,不改任何 agent 的文件;off / uninstall 不碰它(留着,下次 on 照旧)'] },
  { name: 'raw', section: 'data', mutates: false, run: legacy('raw'),
    usage: 'asight raw export <session-id|file.sealed> [--sessions <dir>] [--out <dir|file>]\nasight raw journal [--tail <n>]',
    summary: '封存文件还原成 NDJSON;封存、校验、比对的拒绝、失败与删除的记录。',
    also: [{ section: 'maintenance', usage: 'asight raw seal <closed-shard> [--sessions <dir>]\nasight raw seal --legacy <file|dir> [--dry-run] [--delete-original] [--quiet <s>]\nasight raw verify <sealed|dir> [--against <original>]\nasight raw compare <dir> [--list]',
      summary: '原始层封存(D35):无损重编码成 .sealed,字节核对通过才删原件。' }] },
  { name: 'setup-helper', section: 'maintenance', mutates: false, needsRoot: true, run: setupHelper,
    usage: 'sudo asight setup-helper [--binary <path>] [--remove]',
    summary: '唯一要 sudo 的命令:本机一次,给能力助手(eBPF)加能力位、放进 root 所有的路径。Linux。' },
  { name: 'daemon', section: 'maintenance', mutates: true, run: via('./daemon.mjs', 'runDaemonCli'),
    usage: 'asight daemon [--supervise]',
    summary: '前台跑守护进程;自启单元(Linux systemd · macOS LaunchAgent · Windows 计划任务)跑的就是它。',
    notes: ['--supervise  只在 Windows:计划任务起的监管父进程,拉起真守护进程、非零退出就重拉;不用手敲'] },
  { name: 'help', section: 'maintenance', mutates: false, run: help,
    usage: 'asight help [命令] · --help · -h · --version · -v',
    summary: '`asight help <命令>` 或 `asight <命令> --help` 看一个命令。' },
])

/** The command called `name`, or undefined. */
export const commandNamed = (name) => COMMANDS.find((c) => c.name === name)

// What each old way of writing a command is now (1.6 §2 「隐藏别名」): not in help, dispatched like the command it names. `verify` is the item of `doctor` that was `verify`.
export const HIDDEN_ALIASES = Object.freeze([
  { argv: ['collector', 'install'], to: ['install'] },
  { argv: ['collector', 'on'], to: ['on'] },
  { argv: ['collector', 'off'], to: ['off'] },
  { argv: ['collector', 'status'], to: ['status'] },
  { argv: ['collector', 'uninstall'], to: ['uninstall'] },
  { argv: ['collector', 'start'], to: ['daemon'] },
  { argv: ['verify'], to: ['doctor', '--only', 'old-ca'] },
])

/** `argv` with a hidden alias at its head replaced by what it names; the rest follows as typed → { argv, alias } (`alias` is null when none matched). */
export function resolveAlias(argv) {
  const hit = HIDDEN_ALIASES.filter((a) => a.argv.every((w, i) => argv[i] === w)).sort((a, b) => b.argv.length - a.argv.length)[0]
  return hit ? { argv: [...hit.to, ...argv.slice(hit.argv.length)], alias: hit } : { argv, alias: null }
}

// one wording for every platform: linux / win32 / darwin have the per-process collector; a platform without one is refused by loadArch in `on` / `daemon`
const generation = (platform) => `本平台(${platform}):on / off 驱动按进程采集器(Linux 4.6 · Windows 4.8 · macOS 4.9);还没有采集器的平台由 on / daemon 自己报「not supported yet」。`
const lines = (usage, summary) => [...usage.split('\n').map((l) => `  ${l}`), `      ${summary}`]

/** The help: `helpText()` is the three sections (the first screen says on, off and status, and that they drive the per-process collector on `platform`); `helpText('off')` is that one command. */
export function helpText(cmd, { platform = process.platform } = {}) {
  if (cmd !== undefined) {
    const c = commandNamed(cmd)
    if (!c) throw new RangeError(`no command named ${cmd}`)
    return [...c.usage.split('\n'), ...(c.also || []).flatMap((a) => a.usage.split('\n')), '', c.summary, ...(c.notes || []).map((n) => `  ${n}`)].join('\n')
  }
  const out = ['asight — 看 agent 真正发给大模型的每一比特:透明采集、逐字存原始 bytes、回放与拆解', '',
    '开 asight on · 关 asight off · 状态 asight status', generation(platform), '']
  for (const [id, title] of SECTIONS) {
    out.push(title)
    for (const c of COMMANDS) {
      if (c.section === id) out.push(...lines(c.usage, c.summary))
      for (const a of c.also || []) if (a.section === id) out.push(...lines(a.usage, a.summary))
    }
    out.push('')
  }
  out.push('asight help <命令> 看一个命令;--version 看版本。')
  return out.join('\n')
}
