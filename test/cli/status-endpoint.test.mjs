// test/cli/status-endpoint.test.mjs — the REAL seam between `trocar status` and the daemon (the platform-seam rule: the 2026-10-11 incident): a real
// control server at the endpoint the platform's own writer gives (darwin: arch/darwin/control-path.mjs controlEndpoint → control.json + a socket + a token;
// Linux: $XDG_RUNTIME_DIR/trocar/collector.sock; win32: control.json naming a pipe), and gatherStatus with NO injected request and NO socket path — it
// must find the daemon through controlEndpointFor alone. No per-call-site fallback: with the resolver broken, darwin finds nothing (XDG_RUNTIME_DIR
// is unset there, as on a real Mac), so a re-added Linux fallback cannot hide it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { gatherStatus } from '../../src/cli/status.mjs'
import { startControlServer } from '../../src/collector/core/control.mjs'
import { controlEndpoint as darwinEndpoint } from '../../src/collector/arch/darwin/control-path.mjs'
import { controlEndpoint as win32Endpoint } from '../../src/collector/arch/win32/control-path.mjs'
import { collectorDir } from '../../src/off/paths.mjs'

const REPLY = { pid: 4242, doors: {}, harnesses: {} }

/** The world each platform's daemon leaves, built by that platform's own endpoint writer. → { env, sock, token } */
const SHAPES = {
  linux: (home, dir) => { const run = path.join(home, 'r'); return { env: { HOME: home, XDG_RUNTIME_DIR: run }, sock: path.join(run, 'trocar', 'collector.sock'), token: null } },
  darwin: (home, dir) => { const ep = darwinEndpoint({ dir }); return { env: { HOME: home }, sock: ep.path, token: ep.token } },
  win32: (home, dir) => { const ep = win32Endpoint({ dir }); return { env: { HOME: home }, sock: ep.path, token: ep.token } },
}

for (const platform of Object.keys(SHAPES)) {
  // dirs are one letter: a unix socket path is at most 104 bytes on darwin; darwin's socket sits in $TMPDIR itself, its real place (the runner's per-run TMPDIR)
  // a named pipe is served only by Windows itself: off Windows the win32 shape is still resolved (and only the pipe is asked), it just cannot answer
  const serve = platform !== 'win32' || process.platform === 'win32'
  test(`status finds a real ${platform} daemon through controlEndpointFor alone (no injected request or socket path)`, async () => {
    const home = tmpDir('a-'), dir = collectorDir(home)
    fs.mkdirSync(dir, { recursive: true })
    const { env, sock, token } = SHAPES[platform](home, dir)
    const server = serve ? await startControlServer({ socketPath: sock, token, routes: { 'GET /status': async () => REPLY } }) : null
    try {
      const f = await gatherStatus({ home, env, deps: { platform, procs: async () => [] } })
      if (serve) {
        assert.equal(f.daemon.state, 'running', f.daemon.reason)
        assert.equal(f.daemon.socket, sock)
        assert.equal(f.daemon.reply.pid, REPLY.pid)
      } else {
        assert.equal(f.daemon.state, 'not-running', f.daemon.reason)
        assert.equal(f.daemon.socket, null)
      }
    } finally { if (server) await server.close() }
  })
}
