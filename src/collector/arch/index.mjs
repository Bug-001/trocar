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
  throw new Error(`asight collector: ${platform} is not supported yet (Linux first; RFC 4.6 §结构)`)
}
