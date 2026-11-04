// describe.mjs (src/rules) — what can be said about one rule from the rule alone (RFC 1.6 C.5, 5.1 §三档开销): its sentence, its hash, its tier, what it
// buffers and whether resend takes it. Reads a rule that passed checkRule, so every key has its form.
import { createHash } from 'node:crypto'
import { LIMITS } from './closed.mjs'
import { FAST_LITERAL, exactValues, parseCondition, tierOf } from './conditions.mjs'
import { actionKind, conditionsOf, normalizeRule, readsBody } from './validate.mjs'

const has = Object.hasOwn
const MODIFY = new Set(['replace', 'header', 'json', 'blocks', 'script'])
const QUOTE_CHARS = 40
const quote = (text) => JSON.stringify(text.length > QUOTE_CHARS ? `${text.slice(0, QUOTE_CHARS)}...` : text)

const SUBJECT = { request: 'requests', response: 'responses', 'ws-client': 'WebSocket client messages', 'ws-server': 'WebSocket server messages' }
const SAYS = {
  replace: (a) => `replace ${quote(a.replace)} with ${quote(a.with)}`,
  header: (a) => (has(a, 'remove') ? `remove header ${a.header}` : `set header ${a.header}`),
  json: (a) => `${has(a, 'set') ? 'set' : has(a, 'add') ? 'add' : 'remove'} ${a.json}`,
  blocks: (a) => `${has(a, 'remove') ? 'remove' : has(a, 'truncate') ? 'truncate' : 'rewrite'} matching blocks`,
  script: (a) => `run ${a.script}`,
  hold: (a) => `hold it for up to ${a.release_after_ms} ms`,
  drop: () => 'drop it',
  delay: (a) => `delay it ${a.delay_ms} ms`,
  reply: (a) => `answer with status ${a.reply.status}`,
  inject: () => 'insert an event',
}

/** One English sentence: where the rule acts and what it does, so nobody has to read the rule. */
export function summaryOf(written) {
  const { on, match, do: actions } = normalizeRule(written)
  const agents = match.harness === 'any' ? 'any agent' : match.harness.join(', ')
  const host = !has(match, 'host') ? 'any host' : typeof match.host === 'string' ? match.host : 'matching hosts'
  const others = Object.keys(match).filter((key) => key !== 'harness' && key !== 'host')
  const when = others.length ? `, where ${others.join(', ')} also match` : ''
  return `On ${SUBJECT[on]} between ${agents} and ${host}${when}: ${actions.map((a) => SAYS[actionKind(a)](a)).join(', then ')}.`
}

/** The sha256 of the rule as written, without what `rules enable` writes into it. */
export function ruleSha256(rule) {
  const { armed: _armed, armed_at: _at, script_entry_sha256: _script, ...written } = rule
  return createHash('sha256').update(JSON.stringify(written)).digest('hex')
}

function conditionTier(match) {
  let tier = has(match, 'blocks') ? 2 : has(match, 'pid') ? 1 : 0
  for (const { key, value } of conditionsOf(match)) {
    const node = parseCondition(value, { key })
    if (key !== 'host' || !exactValues(node)) tier = Math.max(tier, tierOf(node, { key }))
  }
  return tier
}

// The fast path of 5.1's table: a literal that needs no escaping, because it works on the raw body or holds only the characters no JSON writes another way.
const escapeFree = (text) => text === '' || FAST_LITERAL.test(text)
function replaceTier(action) {
  if (action.literal !== true || has(action, 'blocks') || Buffer.byteLength(action.replace) > LIMITS.literalBytes) return 2
  return action.in === 'body' || (escapeFree(action.replace) && escapeFree(action.with)) ? 1 : 2
}
const ACTION_TIER = { replace: replaceTier, json: () => 2, blocks: () => 2, script: () => 2 }
const actionTier = (action) => ACTION_TIER[actionKind(action)]?.(action) ?? 0

/** 0, 1 or 2: the tier of the rule's costliest condition or action (5.1 §三档开销). */
export function tierOfRule(written) {
  const { match, do: actions } = normalizeRule(written)
  return Math.max(conditionTier(match), ...actions.map(actionTier))
}

/** What the rule makes the gate gather before it can act: a value of BUFFERS. An injected event and `event_index` stand at a place in the events, so
 *  neither is a rule that only looks at the head. */
export function buffersOf(written) {
  const rule = normalizeRule(written), kinds = rule.do.map(actionKind)
  if (rule.on.startsWith('ws-')) return 'message'
  if (rule.on === 'response') {
    if (rule.whole === true) return 'response'
    return readsBody(rule) || kinds.includes('inject') || has(rule.match, 'event_index') ? 'stream' : 'none'
  }
  return readsBody(rule) || kinds.includes('reply') || kinds.includes('hold') ? 'request' : 'none'
}

/** Does `resend --rule` take this rule: on a request, every action a modification. */
export function resendOk(written) {
  const rule = normalizeRule(written)
  return rule.on === 'request' && rule.do.every((a) => MODIFY.has(actionKind(a)))
}
