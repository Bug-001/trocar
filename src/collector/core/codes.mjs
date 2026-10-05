// codes.mjs — the event names and asight-named codes the collector writes into flows/ (D38: a capture failure is
// never silent; coordinator 2026-10-06: every failure goes to ~/.asight/collector/flows/, events are
// `{ts, event, where?, code?, reason, …}`, written by core/events.mjs appendEvent). One place on this branch, so the
// set moves as one piece into src/health/codes.mjs at integration. `code` is machine-readable and closed; a Node errno
// goes into `code` as it is; free text only into `reason`. Trust reasons a single harness defines (its descriptor's
// `trust.hints` keys) are that harness's codes and live in its file: core names no harness (4.6 §结构).

// Event kinds.
export const EVENT = Object.freeze({
  failure: 'failure',
  agentUntrusted: 'agent-untrusted', // one per pid and reason; code = the resolver's reason
  agentTrusted: 'agent-trusted', // a pid recorded untrusted that is now trusted
  agentExit: 'agent-exit', // a pid recorded untrusted that exited
  installNote: 'install-note',
  uninstallNote: 'uninstall-note',
})

// Generic trust reasons (core/trust/confirm.mjs, core/tracker.mjs) with the one line status and flows/ say about them.
export const TRUST_REASON = Object.freeze({
  'var-missing': 'no asight trust entry is in effect for this process',
  'env-frozen': 'this long-lived process started before the trust entry existed; restart it once',
  'config-after-start': 'the trust entry was written after this process started; restart it once',
  'start-time-unknown': 'the start time of this process could not be read, so it is not known whether it started after the trust entry; restart it once',
  'file-unreadable': 'the CA file named by the trust entry cannot be read',
  'ca-not-in-file': 'the CA file in effect does not hold the asight CA',
  'replace-without-ca': 'a setting that replaces the trusted roots names a bundle without the asight CA',
  shadowed: 'a higher-precedence CA setting without the asight CA hides the asight entry',
  'verify-disabled': 'the agent turned TLS verification off for a route; asight does not decrypt it',
  'marker-stale': 'the trust plugin marker belongs to an earlier process with the same pid',
  'marker-pending': 'waiting for the trust plugin of this process to report that it added the asight CA',
  'no-marker': 'the trust plugin did not report adding the asight CA for this process, and no known reason explains why (plugin file missing, or the process predates it)',
  'config-unreadable': 'a configuration file of this agent exists but cannot be read',
})

// asight-named failure / note codes (`code` of failure, install-note and uninstall-note events).
export const CODE = Object.freeze({
  configUnreadable: 'config-unreadable', // a config file the resolver needs exists but cannot be read (errno in reason)
  configUnparsable: 'config-unparsable', // … or does not parse
  shimNotOnPath: 'shim-not-on-path', // a launch shim was not installed, or is not what `kimi` resolves to
  certNotMerged: 'cert-not-merged', // a block of a user CA file that is not a CERTIFICATE block was left out
  sourceUnreadable: 'source-unreadable', // a user CA file named in the agent's config could not be read
  relativePath: 'relative-path', // a user CA path that is relative was not carried over
  entryNotUndone: 'entry-not-undone', // uninstall could not take asight's text out of a file
  notIdentical: 'reverted-not-identical', // asight's text is out, the file was edited since install
  alreadyRestored: 'already-restored',
  stillTrusting: 'still-trusting', // a live process keeps trusting asight until it restarts / re-reads
  bundleKept: 'bundle-kept', // a combined bundle kept (without the asight CA) for processes that loaded it
  residue: 'residue-not-removed', // files an agent wrote because of asight's plugin; reported, never deleted
  harnessNote: 'harness-note', // anything else a descriptor's inject() says the user should know
  unitNotEnabled: 'unit-not-enabled', // the autostart unit is written but the OS service manager refused to enable it
})

export const trustReasonText = (code) => TRUST_REASON[code] || null
