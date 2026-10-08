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
    // daemon.mjs calls it (loadParts makes no redirector on win32); prepare is the read-only hook `asight on` calls before it writes (W27 ⑥, W74).
    const [{ createWin32Collector, prepare }, unit, { controlEndpoint }, { windowsRoots }] = await Promise.all([import('./win32/wiring.mjs'), import('./win32/autostart.mjs'), import('./win32/control-path.mjs'), import('./win32/roots.mjs')])
    return {
      os: 'win32', install: null, unit,
      controlEndpoint,
      refuseElevated: unit.refuseElevated, nodePreflight: unit.nodePreflight, runSupervisor: unit.runSupervisor,
      osRoots: ({ helper = null } = {}) => windowsRoots({ helper }),
      createRedirector: (opts = {}) => createWin32Collector(opts),
      prepare,
    }
  }
  if (platform === 'darwin') {
    // 4.9 §1: no machine-wide helper either (install: null — nothing on darwin needs privilege: ps / lsof / scutil / security are plain CLIs, run on demand); the autostart unit is
    // the launchd module (§4); the OS roots are read (darwinRoots: the keychain-administered anchors + bundled + SystemRootCertificates, 4.9 §6.2), so osRootsFile stays away;
    // netFacts is darwinNetFacts (1.6 §9.7's archFacts). createRedirector is the whole darwin collector (wiring.mjs) — built lazy (4.9 §1 接线): the daemon's construction (with
    // dir and the sinks) builds everything and starts nothing, loadParts' {env}-only one gets the shell; prepare is the read-only hook `asight on` calls before it writes.
    const [{ createDarwinCollector, prepare }, unit, { controlEndpoint }, { darwinRoots }, { darwinNetFacts }] = await Promise.all([import('./darwin/wiring.mjs'), import('./darwin/autostart.mjs'), import('./darwin/control-path.mjs'), import('./darwin/roots.mjs'), import('./darwin/netfacts.mjs')])
    return {
      os: 'darwin', install: null, unit,
      controlEndpoint,
      refuseElevated: unit.refuseElevated, nodePreflight: unit.nodePreflight,
      osRoots: () => darwinRoots(),
      netFacts: darwinNetFacts,
      createRedirector: (opts = {}) => createDarwinCollector(opts),
      prepare,
    }
  }
  throw new Error(`asight collector: ${platform} is not supported yet (Linux first; RFC 4.6 §结构)`)
}
