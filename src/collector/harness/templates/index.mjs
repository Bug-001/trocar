// templates/index.mjs — the hook templates of spec 4.11 P9, keyed by the HOST's plugin API (not by harness): which file, which phase writes
// it (`on`: a route entry written and removed by on / off; `install`: written once, inert while the switch file is absent), and whether its
// connections carry X-Trocar-Upstream (the door's header gate, P7, honours that header only from a template that says so), and whether it adds the
// trocar root inside the process and never hands a connection to the door when it could not (`addsRoot`: what lets a cert carrier name it, P11
// rule 4). Data only.
import { readFileSync } from 'node:fs'
import { renderTemplate } from '../../core/proxymode/hooks/render.mjs'

export const TEMPLATES = Object.freeze({
  'opencode-plugin': Object.freeze({ file: 'opencode-plugin.js.tmpl', phase: 'on' }),
  'cordis-plugin': Object.freeze({ file: 'cordis-plugin.mjs.tmpl', phase: 'install', sendsUpstreamHeader: true, addsRoot: true }),
  'pi-extension': Object.freeze({ file: 'pi-extension.js.tmpl', phase: 'install', addsRoot: true }),
})

export const templateUrl = (id) => new URL(`./${TEMPLATES[id].file}`, import.meta.url)

/** renderHook(id, values) → { name, text }: the template filled (render.mjs: a closed set of slots), and the file name it is written under —
 *  trocar-<template file without .tmpl>. What install and on are handed, so they need not import the harness tree (layering rule 5). */
export function renderHook(id, values) {
  return { name: `trocar-${TEMPLATES[id].file.replace(/\.tmpl$/, '')}`, text: renderTemplate(readFileSync(templateUrl(id), 'utf8'), values) }
}
