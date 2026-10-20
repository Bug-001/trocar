// test/lab/linux/fixtures/mock-proxy-daemon.mjs — a CONNECT proxy for the test rig (test/lab/mock-upstream/proxy.mjs) run as the OPERATOR in its own process, so that the test's `status` (also the operator) can read who owns the
// port it listens on (an unprivileged `ss` shows only the user's own processes). Env: TROCAR_MOCK_PROXY=1, TROCAR_MOCK_TARGET_PORT (the mock upstream every tunnel goes to). Prints `READY {"port":…,"pid":…}`;
// on a line `log` on stdin prints the proxy's prelude log and its peer ports as one JSON line; `END` stops it. Not production.
import readline from 'node:readline'
import { startMockProxy } from '../../mock-upstream/proxy.mjs'
import '../../../helpers/exit-with-parent.mjs' // a daemon of a test ends when the test process is gone (test/helpers/standin.mjs)

if (process.env.TROCAR_MOCK_PROXY === '1') {
  const proxy = await startMockProxy({ kind: 'connect', target: { port: Number(process.env.TROCAR_MOCK_TARGET_PORT) } })
  process.stdout.write(`READY ${JSON.stringify({ port: proxy.port, pid: process.pid })}\n`)
  readline.createInterface({ input: process.stdin }).on('line', async (l) => {
    if (l === 'log') process.stdout.write(`LOG ${JSON.stringify({ log: proxy.log.map(({ in_b64, out_b64, ...rest }) => rest), peers: proxy.peers })}\n`)
    if (l === 'END') { await proxy.close(); process.exit(0) }
  })
}
