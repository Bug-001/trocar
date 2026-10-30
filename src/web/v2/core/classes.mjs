// core/classes.mjs — the closed set of seven traffic classes (D40): ids and display names only. Which class a request
// belongs to, and how that was decided, is the server's answer; the front end never classifies.
export const CLASS_IDS = ['llm', 'token-count', 'session-sync', 'telemetry', 'files', 'account', 'other']
export const CLASS_NAME = { llm: 'model call', 'token-count': 'token count', 'session-sync': 'session sync', telemetry: 'telemetry', files: 'files', account: 'account', other: 'other' }
// the word an agent's `other` reads as while /api/retention's unmatched holds all three pattern-only classes
// (session-sync · files · account) for it: its traffic cannot be split further, it is not "recognised as something else" (1.10)
export const UNCLASSIFIED = 'unclassified'
// the D40 fallback class: whatever no rule of the other six matched (it has no rules of its own)
export const FALLBACK_CLASS = 'other'
// one plain sentence per class: what kind of traffic it is (the storage page's row popover, 1.11)
export const CLASS_DESC = {
  llm: 'Calls that send a prompt to a model and stream back its reply.',
  'token-count': 'Requests that ask how many tokens a prompt would use, without running the model.',
  'session-sync': 'Uploads and downloads that keep an agent\'s sessions or history in step with a service.',
  telemetry: 'Usage, error and performance reports an agent sends about itself.',
  files: 'Files an agent uploads or downloads, such as attachments.',
  account: 'Sign-in, account, plan and settings requests.',
  other: 'Everything that no rule of the other classes matched.',
}
