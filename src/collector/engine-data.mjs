// engine-data.mjs — what the engine samples per call and per flow from the daemon's data, built the one way both daemons build it (Linux's runDaemon and the
// model's runModelDaemon on macOS / Windows): retention (D40, 4.6 §记录「保存级别」) and a harness's WebSocket turn terminators (FlowExtras, Plan 3c §2).
import { createRetention } from '../capture/retention.mjs'
import { endpointClass } from '../capture/envelope.mjs'
import { makeClassifier, harnessIdOfAgent } from '../dissect/traffic.mjs'

/**
 * The engine's `retention(meta, host, method, path)` → {class, level}. The settings file is read at the start of every request (re-checked at most once a
 * second, no restart) and a problem with it is a failure event (flows/, folded) — the call is kept in full meanwhile. The class patterns are the read-side
 * harness table's data (src/dissect), handed in as a function: the core names no harness (D20, 0.1 §5). `failure`: the daemon's recorder (event / write).
 */
export function retentionHook({ file, rows = undefined, failure }) {
  const keep = createRetention({
    file,
    classify: makeClassifier({ endpointClass, rows, onInvalid: (b) => failure.event({ where: 'retention', code: 'pattern-invalid', reason: `a traffic pattern of ${b.harness} is skipped (${b.reason}): ${JSON.stringify(b.entry)}` }) }),
    onFailure: (rec) => failure.event(rec),
    onOk: (rec) => failure.write(rec),
  })
  return (meta, host, method, endpoint) => keep.decide({ harness: harnessIdOfAgent(meta && meta.agent), host, method, endpoint })
}

/** The engine's `describe(meta)` where no tracker knows the process (the model's doors): the descriptor's WebSocket terminators, data only. */
export const wsTerminalHook = (list) => (meta) => {
  const d = list.find((x) => x.name === (meta && meta.agent))
  return d && d.wsTerminal ? { wsTerminal: d.wsTerminal } : {}
}
