// screens/settings/AppearanceScreen.tsx — 设置 · 外观 (1.11 §外观 · §组件状态): the three-way theme choice. Switching is one attribute
// on <html> plus one localStorage key (theme.mjs setTheme), never a re-render of any other screen (1.5 「主题切换瞬时」). The choice
// starts from what <html data-theme> is now; a storage that throws still switches this page and says the choice cannot be kept.
// No server read: the head carries only the screen's name.
import { useState } from 'react'
import { ToggleButton, ToggleButtonGroup, type Key } from 'react-aria-components'
import { SCREEN_NAME } from '../../../legacy/labels/shell.mjs'
import * as W from '../../../legacy/labels/settings.mjs'
import { PageHead } from '../../ui/PageHead'
import type { ScreenProps } from '../../ScreenOutlet'
import { setTheme as setThemeJs, themeChoice as themeChoiceJs } from './theme.mjs'

type Choice = 'system' | 'light' | 'dark'
const setTheme = setThemeJs as (choice: Choice) => { stored: boolean }
const themeChoice = themeChoiceJs as () => Choice
const CHOICES: Array<[Choice, string]> = [['system', W.THEME_SYSTEM], ['light', W.THEME_LIGHT], ['dark', W.THEME_DARK]]

export default function AppearanceScreen(_props: ScreenProps) {
  const [choice, setChoice] = useState<Choice>(() => themeChoice())
  const [stored, setStored] = useState(true)
  const pick = (keys: Set<Key>) => {
    const v = [...keys][0] as Choice | undefined
    if (!v) return
    setStored(setTheme(v).stored) // the choice applied either way; only its persistence is in question
    setChoice(v)
  }
  return (
    <div className="page">
      <PageHead name={SCREEN_NAME['settings-appearance']} />
      <div className="scard theme-card"><h2>{W.CARD_THEME}</h2>
        <ToggleButtonGroup className="seg live" aria-label={W.CARD_THEME} selectionMode="single" disallowEmptySelection
          selectedKeys={[choice]} onSelectionChange={pick}>
          {CHOICES.map(([v, label]) => (
            <ToggleButton key={v} id={v} data-theme-choice={v} className={({ isSelected }) => (isSelected ? 'on' : '')}>{label}</ToggleButton>
          ))}
        </ToggleButtonGroup>
        <div className="themewarn" hidden={stored}>{W.THEME_UNSTORABLE}</div>
      </div>
    </div>
  )
}
