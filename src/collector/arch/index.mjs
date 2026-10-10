// arch/index.mjs — the one place a platform is chosen (RFC 4.6 §结构). core never asks which OS it runs on;
// the daemon asks this module once and hands core an object that satisfies the Redirector contract.
export async function loadArch(platform = process.platform) {
  if (platform === 'linux') {
    const [{ createLinuxRedirector }, { createRedirectorClient }, install, unit, { linuxNetFacts }] = await Promise.all([import('./linux/redirector.mjs'), import('./linux/redirector-client.mjs'), import('./linux/install.mjs'), import('./linux/unit.mjs'), import('./linux/netfacts.mjs')])
    // install: the machine-wide helper (setupHelper / uninstallHelper); the per-user install is src/collector/install.mjs
    // osRootsFile: the OS trust bundle a combined bundle starts from (4.6 「合并包」; Debian / Ubuntu layout)
    // netFacts: this platform's part of the network facts (1.6 §9.7): `status` and `doctor` hand it to src/netenv/facts.mjs
    return { os: 'linux', install, unit, netFacts: linuxNetFacts, osRootsFile: '/etc/ssl/certs/ca-certificates.crt', createRedirector: ({ env = process.env } = {}) => createLinuxRedirector({ makeClient: () => createRedirectorClient({ env }) }) }
  }
  if (platform === 'win32') {
    // 4.8 §1: no machine-wide helper (install: null — the per-user one is a PowerShell process, not a root service); the autostart unit is
    // the scheduled-task module (Task 9(a)); the OS roots are read (not a file: windowsRoots, 4.8 §6.2), so osRootsFile stays away; netFacts
    // is Task 10's. createRedirector is the whole Windows collector (wiring.mjs): it needs the collector dir and the daemon's sinks, so only
    // daemon.mjs calls it (loadParts makes no redirector on win32); prepare is the read-only hook `asight on` calls before it writes (W27 ⑥, W74);
    // routing is the proxy-mode routing object 1.6 §9.5's `on` consumes (Task 8(c)): a FACTORY runOnCli builds with its own shell's environment.
    // optIn is 4.8 §2.4's half the CLI and the daemon reach (1.6 §1.7): `forms` (what --opt-in may name), `plan` (the rows of the plan's 「要你点名的」
    // section), `apply` (one named item, ledgered) and `check` (W68: the read-only re-check that the entries are still the ones used — status folds its
    // findings into the same rows). `procs` is the caller's process table (listProcs' rows or the redirector's scan: the check matches them to the forms
    // itself). `record` is what the daemon's 5 s check does with the findings (once per occurrence, only §9.7's netenv failure codes) — on the arch object
    // so the daemon, the one file allowed to wire arch in, stays platform-neutral about it.
    const [{ createWin32Collector, prepare, win32Routing }, unit, { controlEndpoint }, { windowsRoots }, { planOptIns, optinFormsOf, applyOptIn, checkEntries, recordEntryFindings }] = await Promise.all([import('./win32/wiring.mjs'), import('./win32/autostart.mjs'), import('./win32/control-path.mjs'), import('./win32/roots.mjs'), import('./win32/optin.mjs')])
    const { groupsOf } = await import('./win32/route-plan.mjs')
    const of = (harnesses, ids = null) => groupsOf(harnesses).filter((x) => !ids || ids.includes(x.harness))
    return {
      os: 'win32', install: null, unit,
      controlEndpoint,
      refuseElevated: unit.refuseElevated, nodePreflight: unit.nodePreflight, runSupervisor: unit.runSupervisor,
      osRoots: ({ helper = null } = {}) => windowsRoots({ helper }),
      createRedirector: (opts = {}) => createWin32Collector(opts),
      prepare,
      routing: win32Routing,
      optIn: {
        forms: ({ harnesses: h, ids = null } = {}) => optinFormsOf(of(h, ids)),
        plan: ({ harnesses: h, ids = null, optIn = [], manifest = null, resolve = null } = {}) => planOptIns({ groups: of(h, ids), optIns: optIn, manifest, resolve }),
        apply: ({ harnesses: h, ids = null, ...rest }) => applyOptIn({ ...rest, groups: of(h, ids) }),
        check: ({ harnesses: h, ids = null, procs = [], ...rest }) => checkEntries({ ...rest, groups: of(h, ids), procs }),
        record: recordEntryFindings,
      },
    }
  }
  throw new Error(`asight collector: ${platform} is not supported yet (Linux first; RFC 4.6 §结构)`)
}
