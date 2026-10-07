// noproxy.mjs (src/netenv) — which of a harness's API hosts a NO_PROXY list names (4.6 「eBPF 模式下的网络拓扑」: the proxy keys read from an environment are `*_PROXY` and `NO_PROXY`). The usual reading of the
// variable (curl, Go, Node): `*` is every host; an entry is the host itself or a domain the host ends with, written bare, with a leading dot or as `*.domain`; a port on an entry is ignored; an address range
// (`10.0.0.0/8`) is not a host name. Pure. Whether a given agent honours NO_PROXY at all is not measured: the caller says so (topology.mjs), this only reads the list.

/** → the hosts of `hosts` the list `list` (the value of NO_PROXY / no_proxy; commas or spaces) covers, in the order given. */
export function noProxyNames(list, hosts) {
  const entries = String(list ?? '').toLowerCase().split(/[\s,]+/).filter(Boolean)
  if (!entries.length) return []
  return hosts.filter((host) => {
    const h = String(host).toLowerCase()
    return entries.some((e) => {
      if (e === '*') return true
      const name = e.replace(/:\d+$/, '').replace(/^\*?\./, '')
      return !!name && !name.includes('/') && (h === name || h.endsWith(`.${name}`))
    })
  })
}
