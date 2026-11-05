// web/src/screens/replay/Sidebar.tsx — the desk's right sidebar (1.2 §回放台布局): React Aria tabs and the collapse button. A tab's panel
// is mounted only while it is the current tab. A collapsed sidebar is the 40 px strip with the expand button alone. `onFold` is
// the frame's (its panel owns the size). `bottom` is the same tabs as the row under the desk (1.2 §窄屏): the panel is up while s.rpOpen,
// which only the controller's toggle moves (Escape goes through it too); pressing a tab raises it, pressing the current tab lowers it,
// and when it falls the focus returns to the current tab. addSidebarTab is the slot a later tab registers in (D80②): without a
// registration there is no such tab.
import { useDeferredValue, useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react'
import { Button, Tab, TabList, TabPanel, Tabs, type Key } from 'react-aria-components'
import { icon } from '../../../legacy/core/icons.mjs'
import * as W from '../../../legacy/labels/replay.mjs'
import { renderResources } from '../../../legacy/replay/resources.mjs'
import { Svg } from '../../ui/Svg'
import { Overview } from './Overview'
import { useDeskVersion } from './useDesk'
import type { DeskView } from './view'

type SideTab = { id: string, label: string, Panel: ComponentType<{ desk: DeskView }> }

// the controller's element, adopted while its tab is current. The drawing waits behind the step move (1.2: 慢的不挡换步)
function Resources({ desk }: { desk: DeskView }) {
  const host = useRef<HTMLDivElement>(null)
  const v = useDeferredValue(useDeskVersion(desk, 'nav'))
  useLayoutEffect(() => {
    host.current!.append(desk.resexp)
    return () => desk.resexp.remove()
  }, [desk])
  useEffect(() => { void v; renderResources(desk.resexp, desk.s) }, [desk, v])
  return <div ref={host} className="sidepane" />
}

const tabs: SideTab[] = [
  { id: 'overview', label: W.TAB_OVERVIEW, Panel: Overview },
  { id: 'resources', label: W.TAB_RESOURCES, Panel: Resources },
]
// → the function that takes the tab out again
export function addSidebarTab(t: SideTab) {
  tabs.push(t)
  return () => { tabs.splice(tabs.indexOf(t), 1) }
}

const TAB_KEY = 'trocar.v2.sidetab'
const readTab = () => { try { return localStorage.getItem(TAB_KEY) } catch { return null } }
const writeTab = (id: string) => { try { localStorage.setItem(TAB_KEY, id) } catch { /* a convenience */ } }

export function Sidebar({ desk, bottom, folded, onFold }: { desk: DeskView, bottom?: boolean, folded?: boolean, onFold?: () => void }) {
  const [tab, setTab] = useState(readTab)
  const current = tabs.some((t) => t.id === tab) ? tab! : tabs[0].id
  const pick = (k: Key) => { setTab(String(k)); writeTab(String(k)) }
  useDeskVersion(desk, 'frame')
  const risen = !!bottom && !!desk.s.rpOpen, rise = () => desk.s.toggleRise()
  const head = useRef<HTMLDivElement>(null), wasUp = useRef(risen)
  const wasCurrent = useRef(false) // read at press start: a mouse press has already selected its tab by the time it ends
  useLayoutEffect(() => {
    if (wasUp.current && !risen) head.current!.querySelector<HTMLElement>('[role=tab][aria-selected=true]')!.focus()
    wasUp.current = risen
  }, [risen])
  const fold = bottom ? <Button className="sidefold" aria-label={risen ? W.LOWER_PANEL : W.RAISE_PANEL} aria-expanded={risen} onPress={rise}><Svg html={icon('chevron-down')} /></Button>
    : onFold ? <Button className="sidefold" aria-label={folded ? W.EXPAND_SIDE : W.COLLAPSE_SIDE} onPress={onFold}><Svg html={icon(folded ? 'rail-out' : 'rail-in')} /></Button> : null
  if (folded) return <div className="deskside folded">{fold}</div>
  return <Tabs className={bottom ? 'deskside bottom' : 'deskside'} selectedKey={current} onSelectionChange={pick}>
    <div ref={head} className="sidehead">
      <TabList className="sidetabs" aria-label={W.SIDE_TABS}>{tabs.map((t) => <Tab key={t.id} id={t.id} className="sidetab"
        onPressStart={() => { wasCurrent.current = t.id === current }} onPress={() => { if (bottom && (wasCurrent.current || !risen)) rise() }}>{t.label}</Tab>)}</TabList>
      {fold}
    </div>
    {bottom && !risen ? null : tabs.map((t) => <TabPanel key={t.id} id={t.id} className="sidepanel"><t.Panel desk={desk} /></TabPanel>)}
  </Tabs>
}
