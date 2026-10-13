import { useEffect, useState } from 'react'
import type { StudySummary } from '../../shared/report-summary'
import './report.css'

type LooseRecord = Record<string, unknown>

type ReportEvent = {
  id: string
  type: string
  at: string | null
  detail: string
  text: string | null
  phase: 'before' | 'after' | null
  source: 'observed' | 'said' | 'system'
}

type LoadedReport = {
  events: ReportEvent[]
  clips: LooseRecord[]
  summary: StudySummary | null
}

const asRecord = (value: unknown): LooseRecord | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as LooseRecord : null

const asString = (value: unknown): string | null => {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

const fromKeys = (record: LooseRecord | null, keys: string[]): string | null => {
  if (!record) return null
  for (const key of keys) {
    const value = asString(record[key])
    if (value) return value
  }
  return null
}

const eventArray = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value
  const record = asRecord(value)
  for (const key of ['events', 'items', 'data']) {
    if (Array.isArray(record?.[key])) return record[key] as unknown[]
  }
  return []
}

const presentValue = (value: unknown): string | null => {
  const direct = asString(value)
  if (direct) return direct
  if (Array.isArray(value)) return value.map(presentValue).filter(Boolean).join(', ') || null
  return null
}

const eventDetail = (type: string, payload: LooseRecord, record: LooseRecord): string => {
  if (type === 'utterance') {
    const speech = fromKeys(payload, ['speech', 'text'])
    const role = fromKeys(payload, ['role', 'speaker'])
    if (speech) return `${role === 'pal' ? 'Interviewer' : 'Participant'}: “${speech}”`
  }
  if (type === 'phase_changed') {
    const phase = fromKeys(payload, ['phase'])
    if (phase === 'first_attempt_done') return 'First attempt finished'
    if (phase === 'retest') return 'Revised site ready for a retry'
    if (phase === 'done') return 'Interview finished'
    if (phase) return `Interview moved to ${phase.replace(/_/g, ' ')}`
  }
  const issue = fromKeys(payload, ['issue'])
  const signal = fromKeys(payload, ['signal'])
  if (type === 'shopping_goal') return `Shopping task: ${fromKeys(payload, ['goal']) ?? 'recorded'}`
  if (type === 'friction_signal_observed') return `Possible obstacle noticed${signal ? `: ${signal}` : ''}`
  if (type === 'friction_confirmed') return `Friction confirmed${issue ? `: ${issue}` : ''}`
  if (type === 'friction_clip_ready') return 'Short friction clip ready'
  if (type === 'repair_requested') return payload.prequeued ? 'Prepared site change queued for the first journey' : `Code change requested${issue ? `: ${issue}` : ''}`
  if (type === 'repair_issue_confirmed') return `Shopper issue linked to a prepared change${issue ? `: ${issue}` : ''}`
  if (type === 'repair_verified') return `Code change verified${issue ? `: ${issue}` : ''}`
  if (type === 'repair_queue_finished') return 'Prepared site changes finished'
  if (type === 'repair_published') return 'Verified site changes published'
  if (type === 'repair_reverted') return 'Original website restored'
  if (type === 'retest_feedback_linked') return 'Shopper feedback linked to a site change'
  if (type === 'store_opened') return 'Opened the sample website'
  const explicit = fromKeys(payload, ['summary', 'description', 'label', 'detail', 'message'])
    ?? fromKeys(record, ['summary', 'description', 'label', 'detail'])
  if (explicit) return explicit
  const search = fromKeys(payload, ['query', 'search', 'term', 'searchTerm'])
  if (search) return `Searched for “${search}”`
  const name = fromKeys(payload, ['productName', 'product_name', 'product', 'itemName', 'item'])
  const size = fromKeys(payload, ['size', 'selectedSize'])
  const color = fromKeys(payload, ['color', 'selectedColor'])
  const category = fromKeys(payload, ['category'])
  const path = fromKeys(payload, ['path', 'pathname', 'url'])
  if (type.includes('size') && size) return `Selected size ${size}${name ? ` for ${name}` : ''}`
  if (type.includes('color') && color) return `Selected ${color}${name ? ` for ${name}` : ''}`
  if (type.includes('product') && name) return `${type.includes('view') ? 'Viewed' : 'Selected'} ${name}`
  if (type.includes('category') && category) return `Opened ${category}`
  if (type.includes('page') && path) return `Visited ${path}`
  const metadata = Object.entries(payload)
    .filter(([key, value]) => !['id', 'timestamp', 'createdAt', 'created_at', 'sessionId'].includes(key) && presentValue(value))
    .slice(0, 2)
    .map(([key, value]) => `${key.replace(/_/g, ' ')}: ${presentValue(value)}`)
  return metadata.length ? metadata.join(' · ') : type.replace(/[._-]/g, ' ')
}

const normalizeEvent = (value: unknown, index: number): ReportEvent | null => {
  const record = asRecord(value)
  if (!record) return null
  const payload = asRecord(record.payload) ?? asRecord(record.detail) ?? asRecord(record.data) ?? asRecord(record.metadata) ?? {}
  const type = (fromKeys(record, ['type', 'event', 'eventType', 'kind']) ?? 'activity').toLowerCase()
  const at = fromKeys(record, ['createdAt', 'created_at', 'timestamp', 'at', 'time'])
    ?? fromKeys(payload, ['createdAt', 'created_at', 'timestamp'])
  const text = fromKeys(payload, ['quote', 'speech', 'text', 'transcript', 'utterance', 'content'])
    ?? fromKeys(record, ['quote', 'speech', 'text', 'transcript', 'utterance', 'content'])
  const role = (fromKeys(payload, ['role', 'speaker', 'source']) ?? fromKeys(record, ['role', 'speaker', 'source']) ?? '').toLowerCase()
  const quoteLike = /quote|transcript|utterance|feedback|participant|shopper|user_message/.test(type)
  const participantRole = /user|participant|shopper|customer/.test(role)
  const agentRole = /assistant|agent|pal|system/.test(role)
  const source: ReportEvent['source'] = text && (participantRole || (quoteLike && !agentRole))
    ? 'said'
    : /repair|build|deploy|patch|agent|interview|recording|phase_changed|shopping_goal|friction_|sample_issue_lookup|sample_question_prompted|retest_feedback_linked/.test(type) || agentRole
      ? 'system'
      : 'observed'
  const phaseValue = (fromKeys(payload, ['phase', 'stage']) ?? fromKeys(record, ['phase', 'stage']) ?? '').toLowerCase()
  const phase = /after|retest|post|variant|patched/.test(phaseValue) || /retest|post_repair|after/.test(type)
    ? 'after'
    : /before|baseline|initial/.test(phaseValue) || /baseline|before/.test(type)
      ? 'before'
      : null
  return {
    id: fromKeys(record, ['id', 'eventId']) ?? `event-${index}`,
    type,
    at,
    detail: eventDetail(type, payload, record),
    text: source === 'said' ? text : null,
    phase,
    source,
  }
}

const formatTime = (value: string | null): string => {
  if (!value) return 'Time unavailable'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

async function fetchJson(path: string): Promise<unknown> {
  const response = await fetch(path, { cache: 'no-store' })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return response.json()
}

const sourceLabel = (source: ReportEvent['source']) =>
  source === 'said' ? 'Participant said' : source === 'observed' ? 'Observed on site' : 'System event'

function Icon({ name, size = 18 }: { name: 'arrow' | 'refresh' | 'clock' | 'quote' | 'code' | 'activity' | 'spark' | 'alert'; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const }
  const paths = {
    arrow: <><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></>,
    refresh: <><path d="M20 11a8 8 0 1 0-2.4 6"/><path d="M20 4v7h-7"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    quote: <><path d="M10 11H5V6h7v7l-4 5H5l3-5H5"/><path d="M20 11h-5V6h7v7l-4 5h-3l3-5h-3"/></>,
    code: <><path d="m8 8-4 4 4 4"/><path d="m16 8 4 4-4 4"/><path d="m14 5-4 14"/></>,
    activity: <><path d="M3 12h4l3-7 4 14 3-7h4"/></>,
    spark: <><path d="m12 3 1.7 6.3L20 11l-6.3 1.7L12 19l-1.7-6.3L4 11l6.3-1.7L12 3Z"/><path d="m19 18 .5 1.5L21 20l-1.5.5L19 22l-.5-1.5L17 20l1.5-.5L19 18Z"/></>,
    alert: <><circle cx="12" cy="12" r="9"/><path d="M12 7v6"/><path d="M12 17h.01"/></>,
  }
  return <svg {...common}>{paths[name]}</svg>
}

export default function ReportPage() {
  const sessionId = new URLSearchParams(window.location.search).get('session')?.trim() ?? ''
  const [data, setData] = useState<LoadedReport>({ events: [], clips: [], summary: null })
  const [loading, setLoading] = useState(Boolean(sessionId))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!sessionId) return
    let active = true
    const load = async () => {
      try {
        const encoded = encodeURIComponent(sessionId)
        const [eventsResponse, clipsResponse, summaryResponse] = await Promise.all([
          fetchJson(`/api/sessions/${encoded}/events`),
          fetchJson(`/api/sessions/${encoded}/clips`),
          fetchJson(`/api/sessions/${encoded}/summary`),
        ])
        if (!active) return
        const events = eventArray(eventsResponse).map(normalizeEvent).filter((event): event is ReportEvent => Boolean(event))
        events.sort((a, b) => (a.at ? Date.parse(a.at) : 0) - (b.at ? Date.parse(b.at) : 0))
        const summary = summaryResponse as StudySummary
        const publicationTime = Date.parse(summary.revision.publishedAt ?? '')
        let interviewPhase: ReportEvent['phase'] = 'before'
        for (const event of events) {
          if (event.type === 'phase_changed') interviewPhase = event.phase ?? interviewPhase
          else if (event.type === 'repair_published') interviewPhase = 'after'
          else if (!event.phase) event.phase = Number.isFinite(publicationTime) && event.at && Date.parse(event.at) > publicationTime ? 'after' : interviewPhase
        }
        setData({ events, clips: eventArray(clipsResponse).map(asRecord).filter((clip): clip is LooseRecord => Boolean(clip)), summary })
        setError(null)
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : 'Unable to load this report')
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    const timer = window.setInterval(() => { void load() }, 2000)
    return () => { active = false; window.clearInterval(timer) }
  }, [sessionId])

  const { events, clips, summary } = data

  return <div className="rp">
    <header className="rp-topbar">
      <a className="rp-brand" href="/" aria-label="Loop home"><span className="rp-brand-mark"><Icon name="spark" size={16}/></span><span>loop<span className="rp-brand-em">.</span></span></a>
      <div className="rp-topbar-right"><span className="rp-topbar-label">RESEARCH WORKSPACE</span><span className="rp-topbar-divider"/><span className="rp-avatar">SP</span></div>
    </header>

    <main className="rp-main">
      <div className="rp-breadcrumb"><a href="/">Workspace</a><span>/</span><span>Interview report</span></div>
      <div className="rp-heading-row">
        <div><div className="rp-eyebrow"><span className="rp-eyebrow-line"/> SESSION REPORT <span className="rp-eyebrow-number">/ {sessionId || '—'}</span></div><h1>What got in the way<span className="rp-heading-dot">.</span></h1><p className="rp-subtitle">The moment, the proposed change, and the participant’s response—followed by the full timeline.</p></div>
        <div className="rp-heading-actions"><span className="rp-live"><span className="rp-live-dot"/> {loading ? 'CONNECTING' : error ? 'CONNECTION ISSUE' : summary?.sessionPhase === 'done' ? 'SESSION COMPLETE' : 'LIVE UPDATING'}</span><button type="button" className="rp-refresh" onClick={() => window.location.reload()}><Icon name="refresh" size={15}/> Refresh</button></div>
      </div>

      {!sessionId ? <div className="rp-error"><Icon name="alert" size={17}/> Open a report with a session ID to see its interview evidence.</div> : <>
        {error && <div className="rp-error"><Icon name="alert" size={17}/> Could not refresh report: {error}. Showing the latest available data.</div>}

        <section className="rp-panel rp-frictions" aria-label="Friction points">
          <div className="rp-section-top"><span className="rp-section-number">01 / FRICTION POINTS</span><span className="rp-source-chip">{summary?.findings.length ?? 0} CONFIRMED</span></div>
          <h2>Friction points</h2>
          {summary?.findings.length ? <div className="rp-friction-list">{summary.findings.map((finding, index) => {
            const clip = clips.find((item) => fromKeys(item, ['id']) === finding.clipId)
            const clipUrl = fromKeys(clip ?? null, ['url'])
            const clipStatus = fromKeys(clip ?? null, ['status']) ?? finding.clipStatus
            const fix = finding.repairStatus === 'failed'
              ? 'The prepared change did not pass verification and was not published.'
              : finding.repairStatus === 'verified' && !finding.published
                ? `${finding.changeSummary ?? 'The prepared change passed verification.'} ${summary.sessionPhase === 'done' ? 'The study ended before it was published to the store.' : 'It is waiting for publication.'}`
                : finding.changeSummary ?? 'The prepared change is in progress.'
            const publicationLabel = finding.published ? 'Published' : summary.sessionPhase === 'done' || finding.repairStatus === 'failed' ? 'Not published' : finding.repairStatus === 'verified' ? 'Verified' : 'In progress'
            return <article className="rp-friction-card" key={finding.jobId}>
              <div className="rp-friction-header"><span>{String(index + 1).padStart(2, '0')}</span><h3>{finding.issue}</h3><em>{publicationLabel}</em></div>
              <div className="rp-friction-grid">
                <div className="rp-friction-video"><span className="rp-friction-label">MOMENT OF FRICTION</span>{clipStatus === 'ready' && clipUrl ? <video controls preload="metadata" src={clipUrl} aria-label={`Friction clip: ${finding.issue}`}>Your browser cannot play this clip.</video> : <div className="rp-friction-video-placeholder"><Icon name="clock" size={22}/><p>{clipStatus === 'confirmed' || clipStatus === 'uploading' ? 'Clip being prepared. This report updates automatically.' : clipStatus === 'failed' ? fromKeys(clip ?? null, ['error']) ?? 'The clip could not be saved.' : 'No clip was captured for this point.'}</p></div>}</div>
                <div className="rp-friction-details">
                  <div className="rp-friction-quote"><span className="rp-friction-label">PARTICIPANT QUOTE</span>{finding.shopperQuote ? <><blockquote>“{finding.shopperQuote.text}”</blockquote><a href={`#report-event-${finding.shopperQuote.eventId}`}>View in timeline <Icon name="arrow" size={12}/></a></> : <p>No direct participant quote was captured for this point.</p>}</div>
                  <div className="rp-friction-fix"><span className="rp-friction-label">{finding.matchQuality === 'forced' ? 'PREPARED CHANGE' : 'FIX'}</span><p>{fix}</p></div>
                  <div className="rp-friction-revised"><span className="rp-friction-label">REVISED QUOTE</span>{finding.retryStatement ? <><blockquote>“{finding.retryStatement.text}”</blockquote><a href={`#report-event-${finding.retryStatement.eventId}`}>View in timeline <Icon name="arrow" size={12}/></a></> : <p>{finding.published ? 'No quote about this specific change was recorded after the retry.' : summary.sessionPhase === 'done' ? 'No revision was published in this study.' : 'Waiting for the participant to try the revised site.'}</p>}</div>
                </div>
              </div>
            </article>
          })}</div> : <div className="rp-friction-empty">{loading ? 'Loading friction points…' : 'Confirmed friction points will appear here during the interview.'}</div>}
        </section>

        <section className="rp-panel rp-timeline-section" aria-label="Timeline">
          <div className="rp-section-top"><span className="rp-section-number">02 / TIMELINE</span><span className="rp-source-chip">{events.length} EVENTS</span></div>
          <h2>Timeline</h2>
          <p className="rp-helper">Website actions, participant statements, and interview events in the order they happened.</p>
          {events.length ? <div className="rp-timeline">{events.map((event, index) => <div className="rp-timeline-item" id={`report-event-${event.id}`} key={`${event.id}-${index}`}><div className={`rp-timeline-marker ${event.source}`}><Icon name={event.source === 'said' ? 'quote' : event.source === 'system' ? 'code' : 'activity'} size={13}/></div><div className="rp-timeline-body"><div className="rp-timeline-top"><span className={`rp-source-tag ${event.source}`}>{sourceLabel(event.source)}</span>{event.phase && <span className="rp-phase-tag">{event.phase === 'before' ? 'FIRST TRY' : 'RETRY'}</span>}<time>{formatTime(event.at)}</time></div><strong>{event.source === 'said' && event.text ? `“${event.text}”` : event.detail}</strong><small>{event.type.replace(/[._-]/g, ' ')}</small></div></div>)}</div> : <div className="rp-friction-empty">Waiting for the first recorded event.</div>}
        </section>
      </>}
    </main>
  </div>
}
