// core/first.mjs — the first read of a cold replay open, sent before the module graph has loaded (1.2 #24, D71①). index.html runs it
// as an async module ahead of main.mjs: on a replay route it takes the kept token (http.mjs bootToken(), the one reader) and sends the head
// read the desk's first open makes (`/api/d/head`, same URL, hold:false) through http.mjs early(); the desk's get() of that URL takes its answer.
// Any other route, a `#t=` boot and a `#/session/<id>` link do nothing here.
import { configure, bootToken, early } from './http.mjs'
import { parseHash } from './router.mjs'

const hash = location.hash || ''
const route = parseHash(hash)
if (route.screen === 'replay' && !hash.startsWith('#t=')) {
  configure({ token: bootToken() })
  early('/api/d/head', { id: route.id }, { hold: false })
}
