// core/titles.mjs — the title rule (1.8 §标题规则), one for every screen that names a session (the list, the overview, the replay head,
// 1.2 §会话头): `title` as it is; `title_source: 'unread'` says the read failed; `null` is 没有采到提问; any other value, or none (an
// answer stored by an earlier release says 'pending'), is a title not read yet, not a fact about the session.
import { UNTITLED, PROMPT_UNREAD, TITLE_PENDING } from '../labels/common.mjs'

export const titleCase = (s) => (s.title != null ? 'title' : s.title_source === 'unread' ? 'unread' : s.title_source === null ? 'none' : 'pending')
export const titleText = (s) => ({ title: () => String(s.title), unread: () => PROMPT_UNREAD, none: () => UNTITLED, pending: () => TITLE_PENDING })[titleCase(s)]()
