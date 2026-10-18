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
    // src/netenv/facts.mjs, and it reads the resident helper — no second daemon API. No createRedirector: the daemon runs the collector model on win32
    // (runModelDaemon, doorPartsFor in model-backends.mjs), as on darwin.
    // No opt-in half: the collector model (4.11) has no item the user names and none that needs an administrator (D57, CM25).
    const [unit, { controlEndpoint }, { osRootsFor }, { gatherWin32Facts }] = await Promise.all([import('./win32/autostart.mjs'), import('./win32/control-path.mjs'), import('../../off/os-roots.mjs'), import('./win32/netfacts.mjs')])
    return {
      os: 'win32', install: null, unit,
      controlEndpoint,
      refuseElevated: unit.refuseElevated, nodePreflight: unit.nodePreflight, runSupervisor: unit.runSupervisor,
      osRoots: ({ helper = null } = {}) => osRootsFor('win32')({ helper }),
      netFacts: gatherWin32Facts,
    }
  }
  if (platform === 'darwin') {
    // 4.9 §1 (as D47 rewrote it): no machine-wide helper either (install: null — nothing on darwin needs privilege: ps / scutil / security are plain CLIs, run on demand);
    // no kernel to download or verify either — the ENGINE is the only local proxy (its per-group doors), so `on` has no prepare / ensureKernel arms at all (the win32 twin keeps
    // its own). The autostart unit is the launchd module (§4); the OS roots are read (darwinRoots through osRootsFor: the keychain-administered anchors + bundled + SystemRootCertificates, 4.9 §6.2);
    // netFacts is darwinNetFacts (1.6 §9.7's archFacts). No createRedirector: the daemon runs the collector model (runModelDaemon).
    // No opt-in half: the collector model (4.11) has no item the user names and none that needs an administrator (CM25).
    const [unit, { controlEndpoint }, { osRootsFor }, { darwinNetFacts }] = await Promise.all([import('./darwin/autostart.mjs'), import('./darwin/control-path.mjs'), import('../../off/os-roots.mjs'), import('./darwin/netfacts.mjs')])
    return {
      os: 'darwin', install: null, unit,
      controlEndpoint,
      refuseElevated: unit.refuseElevated, nodePreflight: unit.nodePreflight,
      osRoots: () => osRootsFor('darwin')(),
      netFacts: darwinNetFacts,
    }
  }
  throw new Error(`asight collector: ${platform} is not supported yet (Linux first; RFC 4.6 §结构)`)
}
