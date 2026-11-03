// screens/capture/ServiceRow.tsx — the capture service row, the first row of the table and never empty (1.9 §采集服务行, D38②): the
// verdict's sentence (a link to the capture log when it is failing and the log has entries), the agent-less conditions with since T,
// the daemon's own state while failing, the log link, the logout line; the expansion is the technical details and the diagnostics copy.
import { TechDetails } from '../../ui/TechDetails'
import { CopyButton } from '../../ui/CopyButton'
import { CapRow, Gut, Lead, techPairs, type Pair } from './AgentRow'

export type ServiceModel = {
  id: string, gut: string | null, lead: { text: string, cls: string, toLog: boolean }, conds: string[], failing: string | null,
  logLink: boolean, lingerStop: string | null, tech: Pair[], copy: string, diag: string,
}

const LOG = '#/capture/log'

export function ServiceRow({ svc, open, onOpen }: { svc: ServiceModel, open: boolean, onOpen: (open: boolean) => void }) {
  const lead = <Lead text={svc.lead.text} cls={svc.lead.cls} />
  return (
    <CapRow id={svc.id} caprow="cap-svc" open={open} onOpen={onOpen} label={<span className="nmt">Capture service</span>}
      gut={<Gut gut={svc.gut} />}
      rest={<>
        <span className="des" />
        <span className={`stt stt-${svc.lead.cls}`}>
          <p className="lead">{svc.lead.toLog ? <a href={LOG}>{lead}</a> : lead}</p>
          {svc.conds.map((c, i) => <p key={i}>{c}</p>)}
          {svc.failing ? <p>{svc.failing}</p> : null}
        </span>
        <span className="last">{svc.logLink ? <a href={LOG}>capture log ›</a> : null}{svc.lingerStop ? <p>{svc.lingerStop}</p> : null}</span>
        <span className="ctl" />
      </>}>
      <TechDetails pairs={techPairs(svc.tech)} copy={svc.copy} />
      <div className="capcopy"><CopyButton text={svc.diag} label="Copy diagnostics" /></div>
    </CapRow>
  )
}
