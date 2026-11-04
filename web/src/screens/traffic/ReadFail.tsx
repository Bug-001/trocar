// screens/traffic/ReadFail.tsx — a read that failed (1.5 K-29): one line naming what and the cause class, 「Retry」, and the server's
// status and reason only inside the technical details, closed until the reader opens them. `fail` is model.mjs failOf().
import { Button } from 'react-aria-components'
import { RETRY } from '../../../legacy/labels/traffic.mjs'
import { TechDetails, type TechValue } from '../../ui/TechDetails'

export type Fail = { line: string, pairs: Array<[string, TechValue]>, copy: string }

export function ReadFail({ fail, onRetry, cls = 'tstate' }: { fail: Fail, onRetry: () => void, cls?: string }) {
  return (
    <div className={cls}>
      <p>{fail.line}</p>
      <Button className="tbtn" onPress={onRetry}>{RETRY}</Button>
      <TechDetails pairs={fail.pairs} copy={fail.copy} />
    </div>
  )
}
