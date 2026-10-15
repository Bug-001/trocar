// templates/index.mjs — the hook templates of spec 4.11 P9, keyed by the HOST's plugin API (not by harness): which file, which phase writes
// it (`on`: a route entry written and removed by on / off; `install`: written once, inert while the switch file is absent), and whether its
// connections carry X-Asight-Upstream (the door's header gate, P7, honours that header only from a template that says so). Data only.
export const TEMPLATES = Object.freeze({
  'opencode-plugin': Object.freeze({ file: 'opencode-plugin.js.tmpl', phase: 'on' }),
  'cordis-plugin': Object.freeze({ file: 'cordis-plugin.mjs.tmpl', phase: 'install', sendsUpstreamHeader: true }),
})

export const templateUrl = (id) => new URL(`./${TEMPLATES[id].file}`, import.meta.url)
