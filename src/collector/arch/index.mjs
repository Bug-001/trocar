// arch/index.mjs — the one place a platform is chosen (RFC 4.6 §结构). core never asks which OS it runs on;
// the daemon asks this module once and hands core an object that satisfies the Redirector contract.
export async function loadArch(platform = process.platform) {
  if (platform === 'linux') {
    const [{ createLinuxRedirector }, { createRedirectorClient }, install, unit, { linuxNetFacts }, { osRootsFor }] = await Promise.all([import('./linux/redirector.mjs'), import('./linux/redirector-client.mjs'), import('./linux/install.mjs'), import('./linux/unit.mjs'), import('./linux/netfacts.mjs'), import('../../off/os-roots.mjs')])
    // install: the machine-wide helper (setupHelper / uninstallHelper); the per-user install is src/collector/install.mjs
    // osRoots: the OS roots a combined bundle starts from (4.6 「合并包」) — the first OS PEM bundle of SYSTEM_BUNDLES this machine has (Debian's, Fedora's,
    // openSUSE's, …), read each time it is asked (the daemon's daily rebuild sees a bundle installed since); none → `missing`, which on and the daemon record (D38);
    // asked only through core/tls/roots.mjs bundleRoots, as every arch's osRoots is. Every arch's reader is src/off/os-roots.mjs osRootsFor(<its os>): the one table, `off`'s too (R3)
    // netFacts: this platform's part of the network facts (1.6 §9.7): `status` and `doctor` hand it to src/netenv/facts.mjs
    return { os: 'linux', install, unit, netFacts: linuxNetFacts, osRoots: ({ read } = {}) => osRootsFor('linux')({ read }), createRedirector: ({ env = process.env } = {}) => createLinuxRedirector({ makeClient: () => createRedirectorClient({ env }) }) }
  }
  if (platform === 'win32') {
    // 4.9 §1 (D47's twin, carried): no machine-wide helper (install: null — the per-user one is a PowerShell process, not a root service); no kernel to download, verify or
    // place either — the ENGINE is the only local proxy (its per-group doors), so `on` has no prepare / ensureKernel arms at all (the darwin twin's own rule; the pin, the
    // download and the forwarder went with the kernel). The autostart unit is the scheduled-task module (Task 9(a)); the OS roots are read (windowsRoots through osRootsFor, 4.8 §6.2);
    // netFacts is this platform's part of the network facts (1.6 §9.7, 4.8 §10.1, Task 10): status / doctor / on's adopt reach it through
    // src/netenv/facts.mjs, and it reads the collector dir's files and the resident helper — no second daemon API. createRedirector is the whole Windows collector (wiring.mjs): it needs the collector dir and the daemon's sinks, so only
    // daemon.mjs calls it (loadParts makes no redirector on win32);
    // routing is the proxy-mode routing object 1.6 §9.5's `on` consumes (Task 8(c)): a FACTORY runOnCli builds with its own shell's environment.
    // optIn is 4.8 §2.4's half the CLI and the daemon reach (1.6 §1.7): `forms` (what --opt-in may name), `plan` (the rows of the plan's 「要你点名的」
    // section), `apply` (one named item, ledgered) and `check` (W68: the read-only re-check that the entries are still the ones used — status folds its
    // findings into the same rows). `procs` is the caller's process table (listProcs' rows or the redirector's scan: the check matches them to the forms
    // itself). `record` is what the daemon's 5 s check does with the findings (once per occurrence, only §9.7's netenv failure codes) — on the arch object
    // so the daemon, the one file allowed to wire arch in, stays platform-neutral about it. netFacts (Task 10(a)) is this platform's half of the network
    // facts: topology rows, doctor findings, the §11 plan and the drift checks all draw from it through src/netenv/facts.mjs.
    const [{ createWin32Collector, win32Routing }, unit, { controlEndpoint }, { osRootsFor }, { planOptIns, optinFormsOf, optinItemForms, applyOptIn, checkEntries, recordEntryFindings }, { gatherWin32Facts }] = await Promise.all([import('./win32/wiring.mjs'), import('./win32/autostart.mjs'), import('./win32/control-path.mjs'), import('../../off/os-roots.mjs'), import('./win32/optin.mjs'), import('./win32/netfacts.mjs')])
    const { groupsOf } = await import('./win32/route-plan.mjs')
    const of = (harnesses, ids = null) => groupsOf(harnesses).filter((x) => !ids || ids.includes(x.harness))
    return {
      os: 'win32', install: null, unit,
      controlEndpoint,
      refuseElevated: unit.refuseElevated, nodePreflight: unit.nodePreflight, runSupervisor: unit.runSupervisor,
      osRoots: ({ helper = null } = {}) => osRootsFor('win32')({ helper }),
      createRedirector: (opts = {}) => createWin32Collector(opts),
      routing: win32Routing,
      netFacts: gatherWin32Facts,
      optIn: {
        forms: ({ harnesses: h, ids = null } = {}) => optinFormsOf(of(h, ids)),
        itemForms: ({ harnesses: h, ids = null } = {}) => optinItemForms(of(h, ids)),
        plan: ({ harnesses: h, ids = null, optIn = [], manifest = null, resolve = null } = {}) => planOptIns({ groups: of(h, ids), optIns: optIn, manifest, resolve }),
        apply: ({ harnesses: h, ids = null, ...rest }) => applyOptIn({ ...rest, groups: of(h, ids) }),
        check: ({ harnesses: h, ids = null, procs = [], ...rest }) => checkEntries({ ...rest, groups: of(h, ids), procs }),
        record: recordEntryFindings,
      },
    }
  }
  if (platform === 'darwin') {
    // 4.9 §1 (as D47 rewrote it): no machine-wide helper either (install: null — nothing on darwin needs privilege: ps / lsof / scutil / security are plain CLIs, run on demand);
    // no kernel to download or verify either — the ENGINE is the only local proxy (its per-group doors), so `on` has no prepare / ensureKernel arms at all (the win32 twin keeps
    // its own). The autostart unit is the launchd module (§4); the OS roots are read (darwinRoots through osRootsFor: the keychain-administered anchors + bundled + SystemRootCertificates, 4.9 §6.2);
    // netFacts is darwinNetFacts (1.6 §9.7's archFacts). createRedirector is the whole darwin collector (wiring.mjs) — built lazy (4.9 §1 接线): the
    // daemon's construction (with dir and the sinks) builds everything and starts nothing, loadParts' {env}-only one gets the shell.
    // optIn is 4.9 §2.4's half the CLI and status reach (1.6 §1.7; the flip checklist ④, the win32 twin's shape): `forms` (what --opt-in may name), `plan` (the rows of the plan's
    // 「要你点名的」 section) and `apply` (one named item, ledgered with scope). The check half (the read-only re-check that the entries are still the ones used, W68) is the
    // status-side work of MA4's row — not this arm; the daemon's own opt-in check is guarded by the hook's absence and checks nothing.
    const [{ createDarwinCollector }, unit, { controlEndpoint }, { osRootsFor }, { darwinNetFacts }, { planOptIns, optinFormsOf, optinItemForms, applyOptIn }] = await Promise.all([import('./darwin/wiring.mjs'), import('./darwin/autostart.mjs'), import('./darwin/control-path.mjs'), import('../../off/os-roots.mjs'), import('./darwin/netfacts.mjs'), import('./darwin/optin.mjs')])
    const { groupsOf } = await import('./darwin/route-plan.mjs')
    const of = (harnesses, ids = null) => groupsOf(harnesses).filter((x) => !ids || ids.includes(x.harness))
    return {
      os: 'darwin', install: null, unit,
      controlEndpoint,
      refuseElevated: unit.refuseElevated, nodePreflight: unit.nodePreflight,
      osRoots: () => osRootsFor('darwin')(),
      netFacts: darwinNetFacts,
      createRedirector: (opts = {}) => createDarwinCollector(opts),
      optIn: {
        forms: ({ harnesses: h, ids = null } = {}) => optinFormsOf(of(h, ids)),
        itemForms: ({ harnesses: h, ids = null } = {}) => optinItemForms(of(h, ids)),
        plan: ({ harnesses: h, ids = null, optIn = [], manifest = null } = {}) => planOptIns({ groups: of(h, ids), optIns: optIn, manifest }),
        apply: ({ harnesses: h, ids = null, ...rest }) => applyOptIn({ ...rest, groups: of(h, ids) }),
      },
    }
  }
  throw new Error(`asight collector: ${platform} is not supported yet (Linux first; RFC 4.6 §结构)`)
}
