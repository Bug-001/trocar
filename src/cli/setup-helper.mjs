// setup-helper.mjs — `sudo asight setup-helper [--remove] [--binary <path>]` (RFC 1.6 §5.3, D36): the Linux capability helper, the one command
// that needs root. Whether the caller is root, and whether this platform needs the helper at all, is answered by the dispatch before anything
// is read (src/cli/main.mjs); this is the step that installs or removes it. `deps.arch` replaces the platform's own installer (0.1 §3).
export async function run(argv, { io, deps = {} }) {
  const { runSetupHelper } = await import('../collector/cli.mjs')
  return runSetupHelper(argv, { out: io.out, err: io.err, ...(deps.arch ? { arch: deps.arch } : {}) })
}
