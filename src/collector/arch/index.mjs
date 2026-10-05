// arch/index.mjs — the one place a platform is chosen (RFC 4.6 §结构). core never asks which OS it runs on;
// the daemon asks this module once and hands core an object that satisfies the Redirector contract.
export async function loadArch(platform = process.platform) {
  if (platform === 'linux') {
    const [{ createLinuxRedirector }, { createRedirectorClient }, install] = await Promise.all([import('./linux/redirector.mjs'), import('./linux/redirector-client.mjs'), import('./linux/install.mjs')])
    // install: only its machine-wide half (setupHelper / uninstallHelper) is used; the per-user half is src/collector/install.mjs
    return { os: 'linux', install, createRedirector: ({ env = process.env } = {}) => createLinuxRedirector({ makeClient: () => createRedirectorClient({ env }) }) }
  }
  throw new Error(`asight collector: ${platform} is not supported yet (Linux first; RFC 4.6 §结构)`)
}
