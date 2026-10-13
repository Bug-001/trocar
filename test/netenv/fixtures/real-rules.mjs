// real-rules.mjs — what a REAL mihomo v1.19.32 says when a request is refused, recorded from the Verge-bundled core (loopback, scratch home). Two tests hold to these tables: the
// controller client's test (controller.test.mjs) feeds them to a stub and asserts that none of the core's words is handed on, and N9 (mihomo-adapter-contract.test.mjs, ASIGHT_MIHOMO_BIN) asks the real core
// and gets them. (The recorded rendering of GET /rules went with the read of it: asight never reads the user's rules, 4.8 OPEN 24.)
// What a real core says when a pushed config is refused (the same scratch run). They name the user's own group, node, rule, or echo the start of the config: the adapter must never pass any of it on.
export const RECORDED_REFUSALS = [
  { why: 'a rule names a group that is not there', status: 400, message: 'rules[0] [DOMAIN,x.example,My Private Group] error: proxy [My Private Group] not found' },
  { why: 'a group lists a node that is not there', status: 400, message: "proxy group[0]: Manual: 'Secret Node' not found" },
  { why: 'two groups with one name', status: 400, message: 'ProxyGroup AUTO-ALL: duplicate group name' },
  { why: 'a process rule names a group that is not there', status: 400, message: 'rules[0] [PROCESS-NAME,x.exe,Zzz Group Name] error: proxy [Zzz Group Name] not found' },
  { why: 'a config that is a string: the core echoes its first characters', status: 400, message: 'yaml: unmarshal errors:\n  line 1: cannot unmarshal !!str `this: i...` into config.RawConfig' },
  { why: 'broken yaml', status: 400, message: 'yaml: did not find expected key' },
]
export const RECORDED_FIXED = ['Unauthorized', 'Resource not found'] // the messages of a core that carry nothing of the user's and that this client can provoke (a wrong Bearer; GET /proxies/asight-<gone>): 4.7 N9 sees each once
