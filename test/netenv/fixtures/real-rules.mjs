// real-rules.mjs — rules as a config spells them, and as GET /rules of a REAL mihomo v1.19.32 renders them, recorded from the Verge-bundled core (loopback, scratch home).
// Two tests hold to this one table: the fake core (fixtures/fake-core.mjs) answers these exact strings, and W57 (mihomo-contract.test.mjs, ASIGHT_MIHOMO_BIN) asks the real core and gets them. A fake that
// echoed the config's spelling hid, once, that the adapter looked for `(PROCESS-NAME,` where the core says `(ProcessName,`. `G` stands for the user's group.
export const RECORDED_RULES = [
  { rule: 'PROCESS-NAME,plain.exe,G', type: 'ProcessName', payload: 'plain.exe' },
  { rule: 'PROCESS-PATH,C:\\Apps\\p.exe,G', type: 'ProcessPath', payload: 'C:\\Apps\\p.exe' },
  { rule: 'PROCESS-NAME-REGEX,^re.*,G', type: 'ProcessNameRegex', payload: '^re.*' },
  { rule: 'AND,((PROCESS-NAME,claude.exe),(DOMAIN,x.example)),G', type: 'AND', payload: '((ProcessName,claude.exe) && (Domain,x.example))' },
  { rule: 'OR,((PROCESS-NAME,codex.exe),(DST-PORT,443)),G', type: 'OR', payload: '((ProcessName,codex.exe) || (DstPort,443))' },
  { rule: 'NOT,((PROCESS-NAME,kimi.exe)),G', type: 'NOT', payload: '(!(ProcessName,kimi.exe))' },
  { rule: 'AND,((NOT,((PROCESS-NAME,deep.exe))),(DOMAIN,y.example)),G', type: 'AND', payload: '((NOT,(!(ProcessName,deep.exe))) && (Domain,y.example))' },
  { rule: 'AND,((PROCESS-NAME-REGEX,^(claude|codex)\\.exe$),(DOMAIN,x.example)),G', type: 'AND', payload: '((ProcessNameRegex,^(claude|codex)\\.exe$) && (Domain,x.example))' },
  { rule: 'OR,((PROCESS-PATH,C:\\Apps\\p.exe),(DST-PORT,443)),G', type: 'OR', payload: '((ProcessPath,C:\\Apps\\p.exe) || (DstPort,443))' },
  { rule: 'MATCH,DIRECT', type: 'Match', payload: '' },
]
// What a real core says when a pushed config is refused (the same scratch run). They name the user's own group, node, rule, or echo the start of the config: the adapter must never pass any of it on.
export const RECORDED_REFUSALS = [
  { why: 'a rule names a group that is not there', status: 400, message: 'rules[0] [DOMAIN,x.example,My Private Group] error: proxy [My Private Group] not found' },
  { why: 'a group lists a node that is not there', status: 400, message: "proxy group[0]: Manual: 'Secret Node' not found" },
  { why: 'two groups with one name', status: 400, message: 'ProxyGroup AUTO-ALL: duplicate group name' },
  { why: 'a process rule names a group that is not there', status: 400, message: 'rules[0] [PROCESS-NAME,x.exe,Zzz Group Name] error: proxy [Zzz Group Name] not found' },
  { why: 'a config that is a string: the core echoes its first characters', status: 400, message: 'yaml: unmarshal errors:\n  line 1: cannot unmarshal !!str `this: i...` into config.RawConfig' },
  { why: 'broken yaml', status: 400, message: 'yaml: did not find expected key' },
]
export const RECORDED_FIXED = ['Unauthorized', 'Body invalid', 'Resource not found', 'Selector update error: proxy not exist'] // the messages of a core that carry nothing of the user's
// The forms the table's process rules name, and what processRulesNaming says of the table (in the table's order, MATCH aside): the fake core's test and the real core's both assert this.
export const RECORDED_FORMS = [
  { id: 'plain', imageNames: ['plain.exe'], imagePaths: [] }, { id: 'apps', imageNames: [], imagePaths: [String.raw`C:\Apps\p.exe`] }, { id: 'rex', imageNames: ['rex.exe'], imagePaths: [] },
  { id: 'claude', imageNames: ['claude.exe'], imagePaths: [] }, { id: 'codex', imageNames: ['codex.exe'], imagePaths: [] }, { id: 'kimi', imageNames: ['kimi.exe'], imagePaths: [] }, { id: 'deep', imageNames: ['deep.exe'], imagePaths: [] },
  { id: 'nobody', imageNames: ['nobody.exe'], imagePaths: [] },
]
export const RECORDED_NAMING = [
  ['ProcessName', ['plain']], ['ProcessPath', ['apps']], ['ProcessNameRegex', ['rex']],
  ['AND', ['claude']], ['OR', ['codex']], ['NOT', ['kimi']], ['AND', ['deep']], ['AND', ['claude', 'codex']], ['OR', ['apps']],
]
