// root-store.mjs — the macOS user root store (RFC 4.11 P3): src/off/root-store.mjs's darwin argv (the login keychain, `security
// add-trusted-cert -r trustRoot` with no `-p`), bound here to the runner the collector passes. The argv and the keychain path live
// once, in that standalone-safe module, which the standalone uninstall imports too.
import { rootStore } from '../../../off/root-store.mjs'

/** userRootStore({ home, run, env, fs }) → { add(rootDer), has(id), remove(id) } on the user's login keychain. */
export const userRootStore = ({ home, run = null, env = process.env, fs } = {}) => rootStore({ platform: 'darwin', home, run, env, ...(fs ? { fs } : {}) })
