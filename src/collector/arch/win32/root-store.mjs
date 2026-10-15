// root-store.mjs — the Windows user root store (RFC 4.11 P3): src/off/root-store.mjs's win32 argv (`certutil -user`, the
// CurrentUser\Root store; a machine store is never written), bound here to the runner the collector passes. The argv lives once, in
// that standalone-safe module, which the standalone uninstall imports too.
import { rootStore } from '../../../off/root-store.mjs'

/** userRootStore({ home, run, env, fs }) → { add(rootDer), has(id), remove(id) } on CurrentUser\Root. */
export const userRootStore = ({ home, run = null, env = process.env, fs } = {}) => rootStore({ platform: 'win32', home, run, env, ...(fs ? { fs } : {}) })
