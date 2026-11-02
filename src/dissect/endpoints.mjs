// src/dissect/endpoints.mjs — THE one table of "which path is inference, which is a token count, which wire a path names"
// (RFC 4.1 `is_llm_call` 判据). The capture side (envelope / engine / ws recorder / class table) and the read side (wire
// registry, dissectors, board, query rows) all read it, so the two cannot drift (一个外部事实只写一处). This is endpoint
// recognition, NOT provider parsing (that lives in the 3.1 adapters / D25 dissectors). Leaf module: imports nothing.
//
// A row's `path` is a regex source matched as `^(?:path)` against the path with its querystring removed. Suffix rules, so
// relay prefixes count too (RFC 4.6 §记录: `/anthropic/v1/messages` is still an inference request). Order matters: the first
// matching row wins, so the token-count row comes first (`/v1/messages/count_tokens` is a ruler, not inference, 3.2).
// `wire` is the wire format the path names on its own, or null when the path names none the board dissects (Gemini, D37 ⑥).
export const ENDPOINTS = Object.freeze([
  { path: '.*count_tokens.*', class: 'token-count', wire: null },
  { path: '.*/v1/messages$', class: 'llm', wire: 'anthropic' },            // Anthropic Messages (incl. relay prefixes)
  { path: '.*/responses$', class: 'llm', wire: 'openai-responses' },       // OpenAI Responses (Codex)
  { path: '.*/chat/completions$', class: 'llm', wire: 'openai-chat' },     // OpenAI / DeepSeek Chat Completions
  { path: '.*:streamGenerateContent.*', class: 'llm', wire: null },        // Gemini
  { path: '.*:generateContent.*', class: 'llm', wire: null },
].map((r) => Object.freeze(r)))
const MATCHERS = ENDPOINTS.map((r) => [new RegExp(`^(?:${r.path})`), r])

/** The path an endpoint names: its querystring removed. */
export const pathOf = (endpoint) => String(endpoint || '').split('?')[0]
/** The first row whose path matches, or null. */
export function endpointOf(endpoint) {
  const p = pathOf(endpoint)
  for (const [re, row] of MATCHERS) if (re.test(p)) return row
  return null
}
/** 'llm' | 'token-count' | null — what the endpoint says by itself. */
export const endpointClass = (endpoint) => endpointOf(endpoint)?.class ?? null
/** is_llm_call — whether this endpoint is a real model-inference call. */
export const isLlmCall = (endpoint) => endpointClass(endpoint) === 'llm'

// The class table (src/classes/table.mjs, D60③) ships these as its `llm` / `token-count` rules.
const pathsOf = (cls) => Object.freeze(ENDPOINTS.filter((r) => r.class === cls).map((r) => r.path))
export const LLM_ENDPOINT_PATHS = pathsOf('llm')
export const TOKEN_COUNT_ENDPOINT_PATHS = pathsOf('token-count')
