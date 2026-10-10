// Runtime files in the shape Clash Verge writes them (serde_yaml: block style, lists at the key's own indent), as stand-ins for the user's VPN (4.7 §3.2, 4.8 W57): the nodes and groups, a
// rule provider of the user's, the user's rules. Every value is made up (documentation addresses, a placeholder password): the reader and its tests never see a real one.

/** A Verge runtime file with the user's own things in it: what verge-world.mjs (the sandbox Verge) puts in `clash-verge.yaml` and what the read-only adapter reads its few fields from. */
export const runtimeText = () => `mixed-port: 7897
mode: rule
find-process-mode: strict
unified-delay: true
proxies:
- name: node-a
  type: ss
  server: 203.0.113.10
  port: 8388
  cipher: aes-128-gcm
  password: not-a-real-password
- name: node-b
  type: trojan
  server: 203.0.113.11
  port: 443
  password: not-a-real-password
  sni: example.com
proxy-groups:
- name: Proxy
  type: select
  proxies:
  - AUTO
  - AUTO-ALL
  - node-a
  - Manual
  - DIRECT
- name: AUTO
  type: url-test
  include-all: true
  exclude-filter: IEPL|BGP
  url: https://example.invalid/ping
  interval: 300
- name: AUTO-ALL
  type: url-test
  include-all-proxies: true
  url: https://example.invalid/ping
  interval: 300
- name: AUTO-PROV
  type: fallback
  include-all-providers: true
  url: https://example.invalid/ping
  interval: 300
- name: Manual
  type: select
  proxies:
  - node-a
  - node-b
rule-providers:
  user-ads:
    type: http
    behavior: domain
    url: https://example.invalid/ads.txt
    path: ./ruleset/ads.yaml
    interval: 86400
rules:
- DOMAIN-SUFFIX,example.com,Proxy
- PROCESS-NAME,curl.exe,Manual
- GEOIP,CN,DIRECT
- MATCH,Proxy
`

/**
 * A runtime file the real core can load on a Mac loopback run (the W57 read test): serde_yaml's block style as above, but the nodes are `http` outbounds at the discard port (nothing is
 * dialled: select groups run no health check), the controller is the test's own, and there is no tun, no dns and no geodata download. It holds nothing of the user's.
 */
export const loopbackRuntimeText = ({ mixed, controller, secret }) => `mixed-port: ${mixed}
mode: rule
bind-address: 127.0.0.1
allow-lan: false
log-level: warning
ipv6: false
external-controller: 127.0.0.1:${controller}
secret: ${secret}
geo-auto-update: false
geox-url:
  geoip: http://127.0.0.1:9/g
  geosite: http://127.0.0.1:9/g
  mmdb: http://127.0.0.1:9/g
  asn: http://127.0.0.1:9/g
proxies:
- name: node-a
  type: http
  server: 127.0.0.1
  port: 9
- name: node-b
  type: http
  server: 127.0.0.1
  port: 9
proxy-groups:
- name: AUTO-ALL
  type: select
  include-all-proxies: true
- name: AUTO
  type: select
  include-all: true
  exclude-filter: IEPL|BGP
- name: Manual
  type: select
  proxies:
  - node-a
  - node-b
rules:
- MATCH,DIRECT
`
