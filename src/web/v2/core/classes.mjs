// core/classes.mjs — the closed set of seven traffic classes (D40): ids and display names only. Which class a request
// belongs to, and how that was decided, is the server's answer; the front end never classifies.
export const CLASS_IDS = ['llm', 'token-count', 'session-sync', 'telemetry', 'files', 'account', 'other']
export const CLASS_NAME = { llm: 'model call', 'token-count': 'token count', 'session-sync': 'session sync', telemetry: 'telemetry', files: 'files', account: 'account', other: 'other' }
// the word an agent's `other` reads as while /api/retention's unmatched holds all three pattern-only classes
// (session-sync · files · account) for it: its traffic cannot be split further, it is not "recognised as something else" (1.10)
export const UNCLASSIFIED = 'unclassified'
