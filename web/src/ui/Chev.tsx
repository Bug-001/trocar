// ui/Chev.tsx — a disclosure's triangle (core/icons.mjs DISC_CHEV); base.css turns it when its trigger is aria-expanded. MenuChev: a menu
// trigger's mark (MENU_CHEV), wrapped so the trigger keeps its text and glyph as one line. A link's 「go there」 is a typed ›, never a chevron (1.5 #5).
import { DISC_CHEV, MENU_CHEV } from '../../legacy/core/icons.mjs'
import { Svg } from './Svg'

export const Chev = () => <Svg html={DISC_CHEV} />
export const MenuChev = () => <span className="chev" aria-hidden="true"><Svg html={MENU_CHEV} /></span>
