// screens/library/LibraryTools.tsx — the library's controls (1.8 §工具行 · §页头): the search box, the agent / project / sort menus
// (React Aria: role menu, menuitemcheckbox / menuitemradio, their own keys), the active-filter chips, 清除筛选, the head's time-window
// control and the title column's ⓘ. Each one reads the filters it is handed and writes one exact params patch; nothing here keeps a
// copy of the route, except the search box's draft while it has focus (the route never rewrites the box someone is typing in).
import { useState, type Ref } from 'react'
import { Button, Menu, MenuItem, MenuTrigger, Popover, ToggleButton, ToggleButtonGroup, type Key, type Selection } from 'react-aria-components'
import { harnessName, harnessRaw } from '../../../legacy/core/chips.mjs'
import * as W from '../../../legacy/labels/library.mjs'
import { HarnessIcon } from '../../ui/HarnessIcon'
import { InfoButton } from '../../ui/InfoButton'
import { agentMenuModel, projectMenuModel, agentLabel, hasFilters } from './model.mjs'
import type { Session } from './useSessions'

type Filters = { q: string, h: string[], project: string, window: string, sort: string }
type SetParams = (patch: Record<string, string | null>) => void
const ALL = '*all' // the project menu's 「All projects」 item (a slug never starts with *)
const first = (k: Selection) => (k === 'all' ? null : [...k][0] as string | undefined) ?? null
const keys = (k: Selection, all: Key[]) => (k === 'all' ? all : [...k]).map(String)
const Chev = () => <span className="chev" aria-hidden="true">▾</span>

function PopMenu<T extends { id: string }>({ label, trigger, items, mode, selected, onChange, item }: {
  label: string, trigger: string, items: T[], mode: 'single' | 'multiple', selected: string[], onChange: (k: Selection) => void,
  item: (x: T) => { text: string, title?: string, body: React.ReactNode },
}) {
  return (
    <MenuTrigger>
      <Button className="popbtn" aria-label={label}>{trigger} <Chev /></Button>
      <Popover className="pop menu" placement="bottom start">
        <Menu aria-label={label} items={items} selectionMode={mode} selectedKeys={selected} onSelectionChange={onChange} disallowEmptySelection={mode === 'single'}>
          {(x) => { const it = item(x); return <MenuItem id={x.id} textValue={it.text}><span title={it.title}>{it.body}</span></MenuItem> }}
        </Menu>
      </Popover>
    </MenuTrigger>
  )
}

export function LibraryTools({ f, all, set, onClear, inputRef }: { f: Filters, all: Session[], set: SetParams, onClear: () => void, inputRef: Ref<HTMLInputElement> }) {
  const [draft, setDraft] = useState<string | null>(null) // non-null while the box has focus
  const agents = (agentMenuModel(all, f) as Array<{ id: string }>)
  const projects = [{ id: ALL, name: W.ALL_PROJECTS, path: '' },
    ...(projectMenuModel(all, f.project) as Array<{ slug: string, name: string, path: string }>).map((p) => ({ ...p, id: p.slug }))]
  const sorts = Object.entries(W.SORTS).map(([id, name]) => ({ id, name }))
  const projName = (all.find((s) => s.project_slug === f.project) as { project_name?: string } | undefined)?.project_name || f.project
  return (
    <div className="libtools" role="search">
      <input ref={inputRef} id="libq" type="search" placeholder={W.SEARCH_PLAIN} aria-label="Search sessions" autoComplete="off" spellCheck={false}
        value={draft ?? f.q} onFocus={() => setDraft(f.q)} onBlur={() => setDraft(null)}
        onChange={(e) => { setDraft(e.target.value); set({ q: e.target.value || null }) }} />
      <PopMenu label={W.AGENT_MENU} trigger={W.AGENT_MENU} items={agents} mode="multiple" selected={f.h}
        onChange={(k) => set({ h: keys(k, agents.map((a) => a.id)).join(',') || null })}
        item={(a) => {
          const raw = a.id !== '-' ? harnessRaw(a.id) : null
          return { text: agentLabel(a.id), body: <><HarnessIcon id={a.id} /><span className="miname">{harnessName(a.id === '-' ? null : a.id)}</span>{raw ? <span className="miraw">{raw}</span> : null}</> }
        }} />
      <PopMenu label={W.PROJECT_MENU} trigger={W.PROJECT_MENU} items={projects} mode="single" selected={[f.project || ALL]}
        onChange={(k) => { const p = first(k); set({ project: p && p !== ALL ? p : null }) }}
        item={(p) => ({ text: p.name, title: p.path || undefined, body: p.name })} />
      <PopMenu label={W.SORT_MENU} trigger={`${W.SORT_MENU}: ${W.SORTS[f.sort as keyof typeof W.SORTS]}`} items={sorts} mode="single" selected={[f.sort]}
        onChange={(k) => set({ sort: first(k) === 'calls' ? 'calls' : null })}
        item={(s) => ({ text: s.name, body: s.name })} />
      <span className="fchips">
        {f.h.map((id) => <button key={id} type="button" className="fchip" onClick={() => set({ h: f.h.filter((x) => x !== id).join(',') || null })}>{`${W.activeAgentChip(agentLabel(id))} ×`}</button>)}
        {f.project ? <button type="button" className="fchip" onClick={() => set({ project: null })}>{`${W.activeProjectChip(projName)} ×`}</button> : null}
      </span>
      <button type="button" id="libclear" className="ghostbtn" disabled={!hasFilters(f)} onClick={onClear}>{W.CLEAR_FILTERS}</button>
    </div>
  )
}

// the head's time-window control (1.2 §页头 scope): one choice, never none
export function WindowSeg({ value, set }: { value: string, set: SetParams }) {
  return (
    <ToggleButtonGroup className="seg" aria-label="Time window" selectionMode="single" disallowEmptySelection selectedKeys={[value]}
      onSelectionChange={(k) => { const w = first(k); if (w) set({ window: w === 'all' ? null : w }) }}>
      {Object.entries(W.WINDOWS).map(([id, label]) => (
        <ToggleButton key={id} id={id} className={({ isSelected }) => (isSelected ? 'on' : '')}>{label as string}</ToggleButton>
      ))}
    </ToggleButtonGroup>
  )
}

// the title column's ⓘ: where a title comes from, on the shared 1.2 §弹出层 popover
const TITLE_I = 'Where the title comes from'
export const TitleInfo = () => <InfoButton label={TITLE_I} title={TITLE_I} body={W.COL_SESSION_TIP} />
