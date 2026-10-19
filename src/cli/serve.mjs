// serve.mjs — `asight serve [--port <port>]` (RFC 1.6 §4.3): the board, read only, on the loopback address. It reads the default capture
// location — there is no flag for another database, source or control plane any more (the board answers the same queries `asight query`
// does, D59). `deps.createServer` replaces the server (0.1 §3).
import path from 'node:path'
import { asightHome, serveSource } from '../paths.mjs'
import { EXIT } from './schema.mjs'

export const DEFAULT_PORT = 9800

/** → the exit code: 0 when it was stopped, 1 when it could not listen. Never returns while it is serving. */
export async function run(argv, { io, args, deps = {} }) {
  const port = args.flags.port === undefined ? DEFAULT_PORT : Number(args.flags.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) { io.err(`asight serve: '${args.flags.port}' is not a port number.`); return EXIT.usage }
  const createServer = deps.createServer || (await import('../server.mjs')).createServer
  const { server } = await createServer({ sourcePath: serveSource(), sessionsRoot: path.join(asightHome(), 'sessions') })
  return new Promise((resolve) => {
    server.on('error', (e) => { io.err(`asight serve: ${e.code === 'EADDRINUSE' ? `port ${port} is already in use. Run: asight serve --port ${port + 1}` : e.message}`); resolve(EXIT.incomplete) })
    server.on('close', () => resolve(EXIT.ok))
    server.listen(port, '127.0.0.1', () => io.out(`asight is serving the board at http://127.0.0.1:${port}`))
  })
}
