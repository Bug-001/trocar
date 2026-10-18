// engine-data.mjs — what the engine samples per call and per flow from the daemon's data, built the one way both daemons build it (Linux's runDaemon and the
// model's runModelDaemon on macOS / Windows): the traffic class and its keep level (D60③, 4.6 §记录「保存级别」) and a harness's WebSocket turn terminators (FlowExtras, Plan 3c §2).
import { createClassSource } from '../classes/source.mjs'

/**
 * The engine's `retention(meta, host, method, path)` → {class, level}. The class table (~/.asight/classes.json, else the builtin one) is read at the start of
 * every call (re-checked at most once a second, no restart) and a problem with it is a failure event (flows/, folded) — the builtin table applies meanwhile.
 * The class and its level are sampled together, so an in-flight call keeps what it started with. The core names no harness (D20, 0.1 §5): the harness of a
 * call is the agent's descriptor name, the same name the class table and `asight classes --harness` use. `failure`: the daemon's recorder (event / write).
 */
export function classesHook({ home, failure }) {
  const src = createClassSource({ home, onFailure: (rec) => failure.event(rec), onOk: (rec) => failure.write(rec) })
  return (meta, host, method, endpoint) => {
    const cls = src.classOf({ host, path: endpoint, harness: (meta && meta.agent) || null })
    return { class: cls, level: src.keepOf(cls) }
  }
}

/** The engine's `describe(meta)` where no tracker knows the process (the model's doors): the descriptor's WebSocket terminators, data only. */
export const wsTerminalHook = (list) => (meta) => {
  const d = list.find((x) => x.name === (meta && meta.agent))
  return d && d.wsTerminal ? { wsTerminal: d.wsTerminal } : {}
}
