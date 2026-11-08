// web/src/screens/replay/md-load.ts — the new desk's markdown renderer as a chunk of its own, loaded once the rough page is out (2.3
// §kinds, D71①). → a promise of it being registered; the module system holds the one load.
import { setMarkdown } from '../../../legacy/replay/kinds.mjs'

export const loadMarkdown = () => import('./markdown.mjs').then((m) => { setMarkdown(m.draw) })
