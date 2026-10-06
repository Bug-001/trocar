// The small inline template the real-mihomo contract test (4.8 W57) and the Windows spike load until Task 5 lands
// `src/netenv/mihomo/rules.mjs` (`buildBlock` / `buildForwarderConfig`): that swap is one commit in Task 5. The names and fields are 4.8 §3.1 / §3.3,
// with the group called `spike`. Plain objects; YAML flow style is JSON, so a config is `JSON.stringify(config)`.
export const G = 'spike'
export const TOKEN = '0123456789abcdef0123456789abcdef' // a dummy ingress token: a fixture value, never a real one
export const REENTER_RULE = (port) => `AND,((DST-PORT,${port}),(IP-CIDR,127.0.0.1/32,no-resolve)),DIRECT`

/**
 * One group's block: the two outbounds, the fallback group probing the re-entry point itself, the select group (PASS first = default off), the rule provider.
 * `reenter` = { port, auth? }: Verge's mixed port, or the form's own listener port (own mihomo); `auth` only for a test listener that needs users.
 */
export function inlineBlock({ g = G, route = 'vb', enginePort, token = TOKEN, reenter, dir = 'asight', interval = 30 }) {
  return {
    proxies: [
      { name: `asight-in-${g}`, type: 'http', server: '127.0.0.1', port: enginePort, username: `${route}.${g}`, password: token },
      { name: `asight-re-${g}`, type: 'http', server: '127.0.0.1', port: reenter.port, ...(reenter.auth || {}) },
    ],
    groups: [
      { name: `asight-fb-${g}`, type: 'fallback', proxies: [`asight-in-${g}`, `asight-re-${g}`], url: `http://127.0.0.1:${reenter.port}/asight-health/${g}`, interval, timeout: 2000, lazy: true },
      { name: `asight-sw-${g}`, type: 'select', proxies: ['PASS', `asight-fb-${g}`] },
    ],
    providers: { [`asight-r-${g}`]: { type: 'file', behavior: 'classical', format: 'text', path: `./${dir}/route-${g}.txt`, payload: ['DOMAIN,asight-off.invalid'] } },
    // the first asight rule (only the probe's own connection to the re-entry point is sent DIRECT), then one RULE-SET per group
    rules: [REENTER_RULE(reenter.port), `RULE-SET,asight-r-${g},asight-sw-${g}`],
    routeFile: (lines) => lines.join('\n') + (lines.length ? '\n' : ''),
  }
}

const base = ({ controller, secret, unifiedDelay }) => ({
  'allow-lan': false, 'bind-address': '127.0.0.1', mode: 'rule', 'log-level': 'debug', ipv6: false,
  'unified-delay': unifiedDelay, 'find-process-mode': 'off',
  'external-controller': `127.0.0.1:${controller}`, secret,
  // no tun, no dns section, no geodata download: a loopback-only run (the geox URLs point at the discard port)
  'geo-auto-update': false, 'geox-url': { geoip: 'http://127.0.0.1:9/g', geosite: 'http://127.0.0.1:9/g', mmdb: 'http://127.0.0.1:9/g', asn: 'http://127.0.0.1:9/g' },
})

/**
 * Shape 1 (4.8 §3.3, Verge-like): the mixed port is both what agents reach and the re-entry point. The agent stand-in has its own `http` listener and is matched by
 * IN-NAME (a process rule on Windows). User rules after the block: a blocked port (REJECT, to show PASS falls through to them) and MATCH,DIRECT.
 */
export function vergeLikeConfig({ ports, secret, token = TOKEN, unifiedDelay = true, interval = 30 }) {
  const b = inlineBlock({ enginePort: ports.engine, token, reenter: { port: ports.mixed }, interval })
  return {
    config: {
      ...base({ controller: ports.controller, secret, unifiedDelay }),
      'mixed-port': ports.mixed,
      listeners: [{ name: 'agent-in', type: 'http', port: ports.agent, listen: '127.0.0.1' }],
      proxies: b.proxies, 'proxy-groups': b.groups, 'rule-providers': b.providers,
      rules: [b.rules[0], b.rules[1], `DST-PORT,${ports.blocked},REJECT`, 'MATCH,DIRECT'],
    },
    routeFile: b.routeFile, route: `./asight/route-${G}.txt`, onLines: ['IN-NAME,agent-in'],
  }
}

/**
 * Shape 2 (own-forwarder-like): a form listener with `rule: in-<g>` sub-rules; its own port is the re-entry point. On Windows the agent is told from the
 * forwarder's own re-entry connection by its image path; here by the listener user (the stand-in listener demands users: `agent` and `re`).
 */
export function forwarderLikeConfig({ ports, secret, token = TOKEN, unifiedDelay = true, interval = 30 }) {
  const b = inlineBlock({ route: 'of', enginePort: ports.engine, token, reenter: { port: ports.form, auth: { username: 're', password: 'rp' } }, interval })
  return {
    config: {
      ...base({ controller: ports.controller, secret, unifiedDelay }),
      listeners: [{ name: `form-${G}`, type: 'mixed', port: ports.form, listen: '127.0.0.1', rule: `in-${G}`, users: [{ username: 'agent', password: 'ap' }, { username: 're', password: 'rp' }] }],
      proxies: [...b.proxies, { name: `asight-up-${G}`, type: 'direct' }], 'proxy-groups': b.groups, 'rule-providers': b.providers,
      'sub-rules': { [`in-${G}`]: [b.rules[0], b.rules[1], `MATCH,asight-up-${G}`] },
      rules: ['MATCH,DIRECT'],
    },
    routeFile: b.routeFile, route: `./asight/route-${G}.txt`, onLines: ['IN-USER,agent'],
  }
}
