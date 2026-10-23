// core/first.mjs — the first read of a cold replay open, sent before the module graph has loaded (1.2 #24, D71①). index.html runs it
// as an async module ahead of main.mjs: on a replay route it takes the tab's token from sessionStorage and sends the very `session`
// read the desk's first open makes (same URL, default hold) through http.mjs early(); the desk's get() of that URL takes its answer.
// Any other route, a `#t=` boot and a `#/session/<id>` link do nothing here.
import { configure, bootToken, early } from './http.mjs'
import { parseHash } from './router.mjs'

const hash = location.hash || ''
const route = parseHash(hash)
if (route.screen === 'replay' && !hash.startsWith('#t=')) {
  configure({ token: bootToken() })
  early('/api/session', { id: route.id })
}
