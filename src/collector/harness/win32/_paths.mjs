// _paths.mjs — Windows locations the harness data under win32/ share (RFC 4.8 §2.3, §6.1). Helpers only: not a harness (the loader reads win32/<name>.mjs for the harnesses it
// finds, nothing else). `ctx` is the one the install gives a descriptor: { home, env: Map }; a missing %APPDATA% is derived from the home, so a sandbox HOME laid out like
// %USERPROFILE% works the same as the real one.
import path from 'node:path'

export const appData = (ctx) => ctx.env.get('APPDATA') || path.join(ctx.home, 'AppData', 'Roaming')
