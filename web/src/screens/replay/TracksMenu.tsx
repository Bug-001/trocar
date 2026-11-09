// web/src/screens/replay/TracksMenu.tsx — the Tracks menu (2.1 ⑥, 1.2 §窄屏): what the track-name gutter offers while it is folded away,
// the problem pager and the rails' toggles. Only the CSS media query in desk-frame.css shows the button. The layer goes into desk.root:
// the scope's cell would clip it and body would outlive the desk. Its items exist only while it is open (D64: nothing on a step move).
import { memo, useEffect, useReducer, useState } from 'react'
import { Button, Header, Menu, MenuItem, MenuSection, MenuTrigger, Popover, type Selection } from 'react-aria-components'
import { icon } from '../../../legacy/core/icons.mjs'
import { flipRail } from '../../../legacy/replay/rails.mjs'
import { problemGo } from '../../../legacy/replay/timeline.mjs'
import * as W from '../../../legacy/labels/replay.mjs'
import { MenuChev } from '../../ui/Chev'
import { Svg } from '../../ui/Svg'
import { tracksModel } from './models.mjs'
import { useDeskVersion } from './useDesk'
import type { DeskView } from './view'

function Items({ desk }: { desk: DeskView }) {
  const s = desk.s
  useDeskVersion(desk, 'cur')
  useDeskVersion(desk, 'problems')
  const [, tick] = useReducer((n: number) => n + 1, 0)
  const m = tracksModel(s)
  const flip = (keys: Selection) => {
    for (const r of m.rails) if (r.open !== (keys === 'all' || keys.has(r.id))) flipRail(s, r.id)
    s.drawRails()
    tick()
  }
  return <Menu aria-label={W.TRACKS_MENU}>
    {m.pager ? <MenuSection>
      <Header>{m.pager.name}</Header>
      <MenuItem id="prev" isDisabled={!m.pager.prev} onAction={() => problemGo(s, -1)}>{W.PROBLEM_PREV}</MenuItem>
      <MenuItem id="next" isDisabled={!m.pager.next} onAction={() => problemGo(s, 1)}>{W.PROBLEM_NEXT}</MenuItem>
    </MenuSection> : null}
    {m.rails.length ? <MenuSection selectionMode="multiple" selectedKeys={m.rails.filter((r) => r.open).map((r) => r.id)} onSelectionChange={flip}>
      {m.rails.map((r) => <MenuItem key={r.id} id={r.id} textValue={r.name} shouldCloseOnSelect={false}>
        {({ isSelected }) => <><span className="trackstick">{isSelected ? <Svg html={icon('check')} /> : null}</span><span className="tracksname">{r.name}</span></>}
      </MenuItem>)}
    </MenuSection> : null}
  </Menu>
}

export const TracksMenu = memo(function TracksMenu({ desk }: { desk: DeskView }) {
  const [open, setOpen] = useState(false)
  useEffect(() => () => setOpen(false), []) // a hidden <Activity> tears this down: the layer leaves with the desk (1.2 §键盘 层随屏走)
  return <MenuTrigger isOpen={open} onOpenChange={setOpen}>
    <Button className="popbtn tracksbtn">{W.TRACKS_MENU} <MenuChev /></Button>
    <Popover className="pop menu" placement="bottom start" UNSTABLE_portalContainer={desk.root}>{open ? <Items desk={desk} /> : null}</Popover>
  </MenuTrigger>
})
