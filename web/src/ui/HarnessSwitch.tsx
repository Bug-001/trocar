// web/src/ui/HarnessSwitch.tsx — an agent row's ONE control (1.9 §开关 · D65; 1.5 K-25..K-27): the switch, or Set up while the harness
// lacks install-stage carriers, or nothing (model = core/harness-switch.mjs controlFor). A press plans first and writes only after a yes
// to that very plan (core/control.mjs planConfirm, 4.4 先计划后确认); while a round is out the control ignores presses and sends nothing.
// The receipt of the last round stays under the control; onDone(out) runs after each round (the page re-reads status).
import { useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Button, Switch } from 'react-aria-components'
import { api } from '../../legacy/core/api.mjs'
import { planConfirm } from '../../legacy/core/control.mjs'
import { controlFor, dialogFor, receiptOf } from '../../legacy/core/harness-switch.mjs'
import { harnessKey } from '../../legacy/core/chips.mjs'
import { CTL } from '../../legacy/labels/capture.mjs'
import { useConfirm } from './Confirm'

export type ControlModel = ReturnType<typeof controlFor>
type Outcome = Awaited<ReturnType<typeof planConfirm>> | { outcome: 'failed', status: number, error: string }

export function HarnessSwitch({ model, name, onDone }: { model: ControlModel, name: string, onDone?: (out: Outcome) => void }) {
  const ask = useConfirm()
  const [receipt, setReceipt] = useState<{ bad: boolean, text: string } | null>(null)
  const busy = useRef(false) // set at the press itself: isPending reaches the render only after the press that started the round
  const round = useMutation({
    mutationFn: async ({ kind, cliId, on }: { kind: 'switch' | 'setup', cliId: string, on?: boolean }) => {
      const body = kind === 'setup' ? { harness: cliId } : { harness: cliId, on }
      let out: Outcome
      try {
        out = await planConfirm({ api, verb: kind === 'setup' ? 'setup' : 'harness', body,
          ask: ({ plan, stale }: { plan: unknown, stale: boolean }) => ask(dialogFor({ kind, on, name, plan, stale })) })
      } catch (err) { out = { outcome: 'failed', status: 0, error: String((err as Error)?.message ?? err) } }
      setReceipt(receiptOf(kind, on, out))
      busy.current = false
      try { onDone?.(out) } catch { /* a repaint that throws must not leave the control busy */ }
      return out
    },
  })
  if (!model || !model.kind) return null
  const kind = model.kind as 'switch' | 'setup', cliId = String(model.cliId)
  const press = (on?: boolean) => {
    if (busy.current) return
    busy.current = true
    setReceipt(null)
    round.mutate({ kind, cliId, on })
  }
  const data = { 'data-hctl': kind, 'data-cli': cliId, 'data-h': harnessKey(cliId) }
  return (
    <span className="hctl" aria-busy={round.isPending || undefined}>
      {kind === 'setup'
        ? <Button className="hsetup" {...data} onPress={() => press()}>{CTL.setup}</Button>
        : <Switch className="hswitch" {...data} isSelected={model.on} isReadOnly={round.isPending} aria-label={CTL.switchLabel(name)}
            onChange={(on) => press(on)}><span className="knob" aria-hidden="true" /></Switch>}
      {receipt ? <span className={receipt.bad ? 'hrcpt bad' : 'hrcpt'}>{receipt.text}</span> : null}
    </span>
  )
}
