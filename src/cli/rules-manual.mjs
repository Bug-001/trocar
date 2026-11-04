// rules-manual.mjs — `trocar help rules`, the one text a person or an agent needs to write, try, list and remove a rule (RFC 1.6 §4.4, 5.1). Loaded only
// when that help is asked for. The table of actions and positions and every limit come from the rule system itself, so they cannot drift from what `rules add` does.
import { ACTION_POSITIONS, PLACES, LIMITS, DEFAULT_MAX_DELAY_MS } from '../rules/validate.mjs'
import { COMMAND_INDENT } from '../off/receipt.mjs'
import { WIDTH, wrap, size } from './text.mjs'

const GAP = 2
const seconds = (ms) => `${ms / 1000} seconds`

/** One row of cells, each folded in its own column; `widths` is every column but the last, which takes what is left of the line. */
function table(widths, rows) {
  const last = WIDTH - GAP - widths.reduce((n, w) => n + w + GAP, 0), all = [...widths, last]
  return rows.flatMap((row) => {
    const cells = row.map((cell, i) => wrap(cell, all[i]))
    const height = Math.max(...cells.map((lines) => lines.length))
    return Array.from({ length: height }, (_, line) => `${' '.repeat(GAP)}${cells.map((c, i) => (c[line] ?? '').padEnd(all[i])).join(' '.repeat(GAP))}`.trimEnd())
  })
}

// A JSON value on one line, spaced the way a person writes it.
function inline(value) {
  if (Array.isArray(value)) return `[ ${value.map(inline).join(', ')} ]`
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  return `{ ${Object.entries(value).map(([key, v]) => `${JSON.stringify(key)}: ${inline(v)}`).join(', ')} }`
}

const ACTION_WIDTH = 7
/** An action: what it does, then its forms on lines of their own under the sentence. */
const action = (name, sentence, ...forms) => [...table([ACTION_WIDTH], [[name, sentence]]), ...forms.map((form) => ' '.repeat(GAP + ACTION_WIDTH + GAP) + inline(form))]

const placeName = (place) => (place === 'response-whole' ? 'whole' : place)
function positions() {
  const head = ['', ...PLACES.map(placeName)]
  const rows = Object.entries(ACTION_POSITIONS).map(([kind, places]) => [kind, ...PLACES.map((place) => (places.includes(place) ? 'yes' : 'no'))])
  return table([ACTION_WIDTH, ...PLACES.slice(0, -1).map((place) => Math.max(placeName(place).length, 3))], [head, ...rows])
}

const paragraph = (text) => [...wrap(text), '']
const steps = (...items) => items.flatMap(([text, ...commands]) => [...wrap(text), ...commands.map((c) => COMMAND_INDENT + c), ''])
const section = (title, ...lines) => [title, ...lines.flat(), '']
const bullets = (...items) => items.flatMap((text) => wrap(text, WIDTH - GAP).map((line, i) => (i ? '  ' : '- ') + line))

const EXAMPLES = [
  ['Swap a word in the newest user message of one process, five times at most.', `{
  "name": "swap-alpha",
  "note": "does the model notice the word changed?",
  "on": "request",
  "match": { "harness": "claude-code", "pid": 4242, "class": "llm" },
  "do": [
    {
      "replace": "ALPHA",
      "with": "BRAVO",
      "literal": true,
      "blocks": { "role": "user", "newest": 1 }
    }
  ],
  "on_error": "forward",
  "limit": { "times": 5 }
}`],
  ['Answer three model calls with a rate limit. The model never sees them.', `{
  "name": "rate-limit-three",
  "match": { "harness": "kimi", "pid": 4242, "class": "llm" },
  "do": [
    {
      "reply": {
        "status": 429,
        "headers": { "retry-after": "1" },
        "body": "{\\"error\\":\\"slow down\\"}"
      }
    }
  ],
  "on_error": "forward",
  "limit": { "times": 3 }
}`],
  ['Hand each answer of one process to a script, whole, and cut the connection if the script fails.', `{
  "name": "rewrite-by-service",
  "on": "response",
  "whole": true,
  "match": { "pid": 4242, "host": "api.openai.com", "class": "llm" },
  "do": [ { "script": "/Users/me/rules/surgery.mjs" } ],
  "on_error": "drop"
}`],
]

const indented = (text) => text.split('\n').map((line) => COMMAND_INDENT + line)

const SCRIPT = `export default async function (message) {
  if (typeof message.text !== 'string') return
  const answer = await fetch('http://127.0.0.1:8099/rewrite', {
    method: 'POST',
    body: message.text,
  })
  console.log('rewrote', message.path)
  return { body: await answer.text(), headers: { 'x-rewritten': 'yes' } }
}`

/** The manual, as `trocar help rules` prints it after the options and exit codes. */
export function rulesManual() {
  return [
    ...paragraph('A hold on your own harness stops you at your next model call. Match by pid so a rule touches only the process under test. trocar rules off works from any terminal.'),
    ...paragraph('A rule says where trocar acts, when, and what it does there. trocar changes traffic only by the rules you wrote down, and a rule changes nothing until it is turned on.'),
    ...section('The way through',
      steps(
        ['Write the rule in a file and add it. It is added switched off. - reads the rule from standard input; --dry-run checks it and writes nothing.', 'trocar rules add rule.json'],
        ['Try it on what was captured. Nothing is sent and the rule file does not change, so this is safe on a rule that is off.', 'trocar rules test swap-alpha --last 20'],
        ['Turn it on. rules enable refuses every rule until the collector can run them, and this version cannot yet: it says so and turns nothing on.', 'trocar rules enable swap-alpha'],
        ['See your rules and what each one did. The last one is the same as JSON, for a program.', 'trocar rules', 'trocar rules swap-alpha', 'trocar query rules'],
        ['Remove it.', 'trocar rules rm swap-alpha'],
        ['Stop every rule at once, whatever state anything else is in.', 'trocar rules off'],
      ),
      wrap('A later version adds sending a captured request again to try a rule on the model itself, and answering a hold by hand.')),
    ...section('Trying a rule',
      wrap('trocar rules test runs on captured records. By default it takes the newest 20 that the rule\'s harness, host and class conditions pick.'),
      table([18], [
        ['--ref <record>', 'names a record; give it again for more'],
        ['--last <n>', 'the newest n records, at most 500'],
        ['--with-live', 'runs the rules that are on first, in file order, and this one after them'],
        ['--as-sent', 'a request rule reads the bytes as they went on the wire, not what the agent sent'],
        ['--run-script', 'runs a script rule. Without it the record is marked untested, because a script can reach the network'],
      ]),
      wrap(`Each record has ${seconds(2000)} at most, and the output says how long each rule took. A rule over the max delay will time out once it is on.`)),
    ...section('A rule',
      wrap('A rule file holds one JSON object with these keys.'),
      table([9], [
        ['name', 'Its id: lowercase letters, digits and -. add, test, enable, disable, rm, off and max-delay are taken.'],
        ['note', 'Optional, for your later self.'],
        ['on', 'Where it acts: request (the default), response, ws-client (a WebSocket message from the agent) or ws-server (one to the agent).'],
        ['whole', 'Only on response: wait for the whole response, then act. Without it an SSE response goes event by event, and any other waits for the max delay at most.'],
        ['match', 'When it acts: every condition has to hold.'],
        ['do', `What it does: 1 to ${LIMITS.list} actions, in order.`],
        ['on_error', 'Required. What happens when it cannot do its work or runs out of time: forward sends the bytes on, drop cuts the connection. Both leave a record.'],
        ['limit', 'Optional. times stops it after that many changes, until stops it at that time (like 2026-11-05T12:00:00Z). Both count from the last rules enable. A request, a response or a WebSocket message is one change, however many places it touches.'],
      ])),
    ...section('Conditions',
      wrap('Every key is a plain HTTP field, so a rule can reach model calls, telemetry, session sync, uploads and account requests alike. On a response, host, path, method and class are those of its request; on WebSocket, those of the handshake.'),
      table([11], [
        ['harness', `A harness name, a list of at most ${LIMITS.list}, or "any".`],
        ['pid', 'Only this process. If it goes away the rule stops and says why, so a reused pid never reaches another agent.'],
        ['host', 'The host.'],
        ['path', 'The path.'],
        ['method', 'The method.'],
        ['class', 'The kind of traffic: llm, token-count, session-sync, telemetry, files, account, other, or one you added with trocar classes.'],
        ['header', 'An object of header names and conditions: the request\'s, the response\'s on a response rule, the handshake\'s on WebSocket.'],
        ['req_header', 'The same over the headers of the request. On a response rule only.'],
        ['body', 'A condition on the text: the uncompressed request or response, the SSE event, or the WebSocket message.'],
        ['blocks', 'A block selector. Holds when the context has one such block. Model calls only, on request and ws-client.'],
        ['status', 'The status code. Response rules only.'],
        ['event_index', 'Which SSE event, or which WebSocket message on the connection, from 0. Not on request rules. On a response that is not SSE it never holds.'],
      ]),
      '',
      wrap('To reach one session only, match the session header of the harness, like x-claude-code-session-id: under header on a request rule, under req_header on a response rule.')),
    ...section('Writing a condition',
      table([24], [
        ['"POST"', 'equal to this'],
        ['"/v1/messages*"', 'starts with this'],
        ['"*.anthropic.com"', 'ends with this'],
        ['"*telemetry*"', 'contains this'],
        ['["a", "b"]', 'any of these'],
        ['{ "not": "a" }', 'not this'],
        ['{ "re": "^/v[0-9]+/" }', `a regex, at most ${LIMITS.regexBytes} bytes. It runs with the u flag`],
      ]),
      '',
      wrap(`* counts only at the two ends. A string under body is a literal, the text it must contain, and * is a plain star there. A regex, or a literal over ${LIMITS.literalBytes} bytes, runs in a rule process and costs one more round trip.`)),
    ...section('Block selectors',
      wrap('Blocks are the parts of a model call, oldest first, the same on every provider. A selector picks those that fit all its keys.'),
      table([11], [
        ['section', 'system, tools or messages'],
        ['kind', 'system, tool, text, image, tool_use, server_tool_use, tool_result, thinking or json'],
        ['role', 'user, assistant, system or tool'],
        ['name', 'the tool\'s name'],
        ['text', 'the block has this text'],
        ['min_bytes', 'at least this long'],
        ['max_bytes', 'at most this long'],
        ['newest', 'only the newest n of what the other keys picked'],
        ['skip_newest', 'leaves out the newest n, before newest counts'],
      ])),
    ...section('What rules add refuses',
      wrap('It exits 2 and writes nothing unless:'),
      bullets(
        'the rule has harness or pid. To reach everything write "any": leaving it out never means all.',
        'a rule that reads the body also has host, path or class. Reading the body means a body or blocks condition, or a replace, json, blocks or script action.',
        'a rule with on_error drop has host. To reach every host write "*".',
        `a script rule matches without reading the body: no body, no blocks, no regex, no literal over ${LIMITS.literalBytes} bytes. The script decides that and returns nothing to change nothing.`,
      )),
    ...section('Actions',
      wrap('Ten of them. hold, drop and reply come last in do, and do has one script at most.'),
      action('replace', 'Changes text in a UTF-8 body. The text is a regex with the u flag, and with may use $1, $& and $<name>; literal takes both as plain text. By default in is text: it looks in the decoded JSON strings and writes back correct JSON. in body works on the raw bytes.',
        { replace: 'ALPHA', with: 'BRAVO', literal: true },
        { replace: 'v(\\d+)', with: 'w$1', in: 'body' },
        { replace: 'ALPHA', with: 'BRAVO', blocks: { role: 'user' } }),
      action('header', 'Sets or removes a header. content-length, transfer-encoding, connection and upgrade cannot be touched.',
        { header: 'x-trace', set: 'on' },
        { header: 'x-trace', remove: true }),
      action('json', 'Sets, adds or removes one node, by JSON pointer.',
        { json: '/model', set: 'other-model' },
        { json: '/messages/-', add: { role: 'user', content: 'hi' } },
        { json: '/tools/3', remove: true }),
      action('blocks', 'Changes the blocks a selector picks: one of remove, truncate to that many bytes, set_text, or append_text.',
        { blocks: { kind: 'thinking' }, remove: true },
        { blocks: { kind: 'tool_result' }, truncate: 4000 },
        { blocks: { role: 'user', newest: 1 }, set_text: 'hello' },
        { blocks: { section: 'system' }, append_text: 'Be brief.' }),
      action('script', 'Hands the message to your ES module, by absolute path. See Scripts.',
        { script: '/Users/me/rules/surgery.mjs' }),
      action('hold', `Keeps the message until release_after_ms, which is required, from 1 to ${LIMITS.releaseAfterMs}, then goes by on_error: forward sends what it holds, drop cuts the connection.`,
        { hold: true, release_after_ms: 60000 }),
      action('drop', 'Cuts the connection.', { drop: true }),
      action('delay', `Waits, up to ${LIMITS.delayMs} ms. It does not count against the max delay. On SSE each matching event waits and the ones behind it wait too, so use event_index to stop a stream at one place.`,
        { delay_ms: 3000 }),
      action('reply', 'Answers for the upstream, which never gets the request. status runs from 200 to 599; headers and body are optional. trocar works out the length, so do not write it.',
        { reply: { status: 429, body: 'slow down' } }),
      action('inject', 'Puts this raw SSE event or WebSocket message in front of the matching one. event_index 0 is the start of the stream; a body condition on the last event, like message_stop, is the end.',
        { inject: 'data: {"note":"from trocar"}\n\n' })),
    ...section('Actions and positions',
      positions(),
      '',
      wrap('whole is on response with whole set to true. A replace with blocks counts as blocks.'),
      bullets(
        'header on a response changes the response headers only.',
        'json on a response needs a JSON body, or a data: line that is JSON.',
        'hold on a response needs whole. On ws-server it holds a whole turn of the reply.',
        'drop on a response cannot take back what was already sent.',
        'inject on a response works on SSE only.',
      )),
    ...section('What a rule makes the agent wait for',
      table([24, 21], [
        ['Rule', 'Holds back', 'The agent waits'],
        ['no rule could apply', 'nothing', 'nothing you can measure'],
        ['reads or changes headers only', 'the request headers', 'microseconds'],
        ['delay', 'nothing: reading stops for that long', 'the time written'],
        ['reads the request body', `the whole request, up to ${size(LIMITS.bodyBytes)}`, 'for the agent to finish writing it, then about 0.1 to 4 ms'],
        ['reply, hold, a drop that reads the body', `the whole request, up to ${size(LIMITS.bodyBytes)}`, 'for the agent to finish writing it'],
        ['a response that is SSE, event by event', 'events in the queue', 'under a microsecond with a literal, 30 to 70 with a regex, per event'],
        ['a response that is not SSE', 'what has arrived', 'the max delay at most; if it is not complete by then, it passes unchanged'],
        ['whole, or a hold on a response', `the whole response, up to ${size(LIMITS.bodyBytes)}`, 'all of the answer, up to 10 minutes: the agent gets no byte before the end and may time out'],
      ]),
      '',
      wrap(`The max delay is how long a rule may keep one request, event or message: ${DEFAULT_MAX_DELAY_MS} ms unless you set it, from 1 to ${LIMITS.maxDelayMs}. It is also the most a broken rule can cost an agent. Past it the rule counts as failed, its changes are thrown away, and on_error decides.`),
      `${COMMAND_INDENT}trocar rules max-delay 500`),
    ...section('Scripts',
      wrap('A script is an ES module whose default export is a function, sync or async. It gets the message and returns the new body, as a string or bytes; or `{ body, headers }` to change either; or nothing to change nothing. A header set to `null` is removed.'),
      '',
      table([9], [
        ['on', 'the position'],
        ['harness', 'the harness'],
        ['pid', 'the process id'],
        ['method', 'the method'],
        ['host', 'the host'],
        ['path', 'the path'],
        ['status', 'the status code, on a response'],
        ['headers', 'a list of [name, value]; the value of a credential header is blank'],
        ['bytes', 'the body as bytes, so binary bodies can be changed too'],
        ['text', 'the body as text, when it is UTF-8'],
      ]),
      '',
      indented(SCRIPT),
      '',
      bullets(
        'It cannot start a process or write a file. To use another program go over HTTP with fetch, to a service you started on this machine.',
        'console.log is seen only in rules test.',
        'It can import only files inside its own directory. A node_modules in a parent directory and a link that leaves the directory are refused, and the error does not name the path.',
        'If you change the script file, run rules enable again; until then the rule is not live. Files it imports are not checked for changes.',
      )),
    ...section('Before you rely on a rule',
      bullets(
        'replace reaches every string of the body, the model name and signature fields included. Narrow it with blocks.',
        'A text rule on the OpenAI Responses API has to write whole. Without it the deltas stay as they were and the final text changes, so what the agent shows and what it stores differ.',
        'A compressed request body is sent as plain text after a change, without its content-encoding. Our tests cannot confirm that an upstream takes plain text in place of zstd.',
        'How long a hold can really wait also depends on the agent\'s own client timeout.',
        'When several rules match, changes run in file order; then any drop wins, then reply, then hold.',
      )),
    ...section('Examples',
      EXAMPLES.flatMap(([text, rule]) => [...wrap(text), ...indented(rule), ''])),
  ].join('\n').trimEnd()
}
