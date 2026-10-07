// A runtime config in the shape the proxy software hands the block (4.8 §3.6, W9 W58): the user's nodes and groups, three groups with include-all in its three
// spellings (no filter, an existing filter, an empty one), one without, a rule provider of the user's, and the user's rules. Every value is made up (documentation addresses,
// a placeholder password): the generator and its tests never see a real one. A function, so each test gets its own object to mutate.
export const runtimeFixture = () => ({
  'mixed-port': 7897,
  mode: 'rule',
  'find-process-mode': 'strict',
  'unified-delay': true,
  proxies: [
    { name: 'node-a', type: 'ss', server: '203.0.113.10', port: 8388, cipher: 'aes-128-gcm', password: 'not-a-real-password' },
    { name: 'node-b', type: 'trojan', server: '203.0.113.11', port: 443, password: 'not-a-real-password', sni: 'example.com' },
  ],
  'proxy-groups': [
    { name: 'Proxy', type: 'select', proxies: ['AUTO', 'AUTO-ALL', 'node-a', 'Manual', 'DIRECT'] },
    { name: 'AUTO', type: 'url-test', 'include-all': true, 'exclude-filter': 'IEPL|BGP', url: 'https://example.invalid/ping', interval: 300 },
    { name: 'AUTO-ALL', type: 'url-test', 'include-all-proxies': true, url: 'https://example.invalid/ping', interval: 300 },
    { name: 'AUTO-PROV', type: 'fallback', 'include-all-providers': true, url: 'https://example.invalid/ping', interval: 300 },
    { name: 'Manual', type: 'select', proxies: ['node-a', 'node-b'] },
  ],
  'rule-providers': { 'user-ads': { type: 'http', behavior: 'domain', url: 'https://example.invalid/ads.txt', path: './ruleset/ads.yaml', interval: 86400 } },
  rules: ['DOMAIN-SUFFIX,example.com,Proxy', 'PROCESS-NAME,curl.exe,Manual', 'GEOIP,CN,DIRECT', 'MATCH,Proxy'],
})
