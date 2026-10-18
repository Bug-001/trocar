// direct-start.mjs — the environment of a collector daemon this run starts itself (`unit.start()`, the `asight on --no-autostart` run), shared by
// every arch (RFC 1.6 §3.3; 4.9 §4, 4.8 §7): the shell's environment without the variables that change what the daemon trusts or whom it dials
// (Node's CA, TLS and proxy switches, OpenSSL's CA file and directory, the `*_PROXY` family, in any case), so a daemon started by hand trusts and
// dials exactly as the one a login entry would start. What is not in this list stays: the user-level variables a login job carries too (`CODEX_HOME`,
// `PATH`, `HOME`, `TMPDIR` — the control socket lives under it).
// One list in one place: three archs had their own copy of it.
const TRUST_AND_PROXY = /^(NODE_EXTRA_CA_CERTS|NODE_OPTIONS|NODE_USE_SYSTEM_CA|NODE_USE_ENV_PROXY|NODE_TLS_REJECT_UNAUTHORIZED|SSL_CERT_FILE|SSL_CERT_DIR|(HTTPS?|ALL|NO|FTP|WSS?)_PROXY)$/i

export function directStartEnv(env = process.env) {
  const out = {}
  for (const [k, v] of Object.entries(env)) if (!TRUST_AND_PROXY.test(k)) out[k] = v
  return out
}
