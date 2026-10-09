import { useEffect, useMemo, useState } from 'react'
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
  raw: LooseRecord
}

type LoadedReport = {
  session: LooseRecord | null
  events: ReportEvent[]
  repair: LooseRecord | null
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

const unwrap = (value: unknown, key: string): LooseRecord | null => {
  const record = asRecord(value)
  return asRecord(record?.[key]) ?? record
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
    if (speech) return `${role === 'pal' ? 'PAL' : 'Participant'}: “${speech}”`
  }
  if (type === 'phase_changed') {
    const phase = fromKeys(payload, ['phase'])
    if (phase) return `Interview moved to ${phase.replace(/_/g, ' ')}`
  }
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
  if (type.includes('cart') && name) return `${type.includes('remove') ? 'Removed' : 'Added'} ${name}${type.includes('remove') ? ' from' : ' to'} cart`

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
    : /repair|build|deploy|patch|agent|interview|phase_changed/.test(type) || agentRole
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
    raw: record,
  }
}

const formatTime = (value: string | null): string => {
  if (!value) return 'Time unavailable'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

const formatDate = (value: string | null): string => {
  if (!value) return 'Session date unavailable'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}

async function fetchJson(path: string): Promise<unknown> {
  const response = await fetch(path, { cache: 'no-store' })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return response.json()
}

const sourceLabel = (source: ReportEvent['source']) =>
  source === 'said' ? 'Participant said' : source === 'observed' ? 'Observed on site' : 'System event'

function Icon({ name, size = 18 }: { name: 'arrow' | 'refresh' | 'check' | 'clock' | 'quote' | 'code' | 'search' | 'activity' | 'external' | 'spark' | 'alert'; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const }
  const paths = {
    arrow: <><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></>,
    refresh: <><path d="M20 11a8 8 0 1 0-2.4 6"/><path d="M20 4v7h-7"/></>,
    check: <><path d="m4 12 5 5L20 6"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    quote: <><path d="M10 11H5V6h7v7l-4 5H5l3-5H5"/><path d="M20 11h-5V6h7v7l-4 5h-3l3-5h-3"/></>,
    code: <><path d="m8 8-4 4 4 4"/><path d="m16 8 4 4-4 4"/><path d="m14 5-4 14"/></>,
    search: <><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 5 5"/></>,
    activity: <><path d="M3 12h4l3-7 4 14 3-7h4"/></>,
    external: <><path d="M14 4h6v6"/><path d="m20 4-9 9"/><path d="M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5"/></>,
    spark: <><path d="m12 3 1.7 6.3L20 11l-6.3 1.7L12 19l-1.7-6.3L4 11l6.3-1.7L12 3Z"/><path d="m19 18 .5 1.5L21 20l-1.5.5L19 22l-.5-1.5L17 20l1.5-.5L19 18Z"/></>,
    alert: <><circle cx="12" cy="12" r="9"/><path d="M12 7v6"/><path d="M12 17h.01"/></>,
  }
  return <svg {...common}>{paths[name]}</svg>
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="rp-empty"><span className="rp-empty-icon"><Icon name="clock" size={20}/></span><strong>{title}</strong><p>{detail}</p></div>
}

function DiffView({ diff }: { diff: string }) {
  return <pre className="rp-diff"><code>{diff.split('\n').map((line, index) => <span key={index} className={line.startsWith('+') && !line.startsWith('+++') ? 'rp-add' : line.startsWith('-') && !line.startsWith('---') ? 'rp-remove' : line.startsWith('@@') ? 'rp-hunk' : ''}>{line || ' '}{'\n'}</span>)}</code></pre>
}

export default function ReportPage() {
  const sessionId = new URLSearchParams(window.location.search).get('session')?.trim() ?? ''
  const [data, setData] = useState<LoadedReport>({ session: null, events: [], repair: null })
  const [loading, setLoading] = useState(Boolean(sessionId))
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const [showAllEvents, setShowAllEvents] = useState(false)
  const [activeTab, setActiveTab] = useState<'evidence' | 'repair'>('evidence')

  useEffect(() => {
    if (!sessionId) return
    let active = true
    const load = async () => {
      try {
        const encoded = encodeURIComponent(sessionId)
        const [sessionResponse, eventsResponse, repairResponse] = await Promise.all([
          fetchJson(`/api/sessions/${encoded}`),
          fetchJson(`/api/sessions/${encoded}/events`),
          fetchJson(`/api/sessions/${encoded}/repair`),
        ])
        if (!active) return
        const events = eventArray(eventsResponse).map(normalizeEvent).filter((event): event is ReportEvent => !!event)
        events.sort((a, b) => (a.at ? new Date(a.at).getTime() : 0) - (b.at ? new Date(b.at).getTime() : 0))
        let interviewPhase: ReportEvent['phase'] = 'before'
        for (const event of events) {
          if (event.type === 'phase_changed') {
            interviewPhase = event.phase ?? interviewPhase
          } else if (!event.phase) {
            event.phase = interviewPhase
          }
        }
        setData({ session: unwrap(sessionResponse, 'session'), events, repair: unwrap(repairResponse, 'repair') })
        setUpdatedAt(new Date())
        setError(null)
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : 'Unable to load this report')
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    const timer = window.setInterval(() => { void load() }, 4000)
    return () => { active = false; window.clearInterval(timer) }
  }, [sessionId])

  const { session, events, repair } = data
  const directQuotes = useMemo(() => events.filter(event => event.source === 'said' && event.text), [events])
  const observedEvents = useMemo(() => events.filter(event => event.source === 'observed'), [events])
  const searchEvents = useMemo(() => observedEvents.filter(event => /search/.test(`${event.type} ${event.detail}`.toLowerCase())), [observedEvents])
  const sizeEvents = useMemo(() => observedEvents.filter(event => /size/.test(`${event.type} ${event.detail}`.toLowerCase())), [observedEvents])
  const afterQuotes = directQuotes.filter(event => event.phase === 'after')
  const beforeQuotes = directQuotes.filter(event => event.phase !== 'after')
  const recentEvents = showAllEvents ? events : events.slice(-8)

  const goal = fromKeys(session, ['goal', 'shoppingGoal', 'shopping_goal', 'task', 'productGoal', 'product_goal', 'product', 'productType', 'product_type'])
  const storeUrl = fromKeys(session, ['storeUrl', 'store_url'])
  const status = fromKeys(session, ['status', 'phase', 'state']) ?? 'In progress'
  const createdAt = fromKeys(session, ['createdAt', 'created_at', 'startedAt', 'started_at'])
  const repairStatus = fromKeys(repair, ['status', 'state', 'phase'])
  const hasRepair = !!repair && repairStatus !== 'idle'
  const repairDescription = fromKeys(repair, ['summary', 'description', 'intent', 'prompt', 'issue'])
  const repairHypothesis = fromKeys(repair, ['hypothesis'])
  const publishedAt = fromKeys(repair, ['publishedAt', 'published_at'])
  const diff = fromKeys(repair, ['diff', 'patch', 'codeDiff', 'code_diff'])
  const check = asRecord(repair?.check)
  const buildStatus = fromKeys(repair, ['buildStatus', 'build_status', 'verificationStatus', 'verification_status', 'testStatus', 'test_status'])
    ?? fromKeys(check, ['status', 'result'])
    ?? (typeof check?.ok === 'boolean' ? (check.ok ? 'passed' : 'failed') : null)
    ?? asString(repair?.check)
  const buildOutput = fromKeys(repair, ['buildOutput', 'build_output', 'buildLog', 'build_log', 'testOutput', 'test_output'])
    ?? fromKeys(check, ['output', 'log', 'stdout', 'details'])
  const previewUrl = fromKeys(repair, ['previewUrl', 'preview_url', 'url'])
  const failure = fromKeys(repair, ['error', 'failure', 'failureReason', 'failure_reason'])
  const statusIsPassed = !!(buildStatus && /pass|success|complete/i.test(buildStatus))
  const repairComplete = !!(repairStatus && /complete|success|deployed|ready/i.test(repairStatus))

  return <div className="rp">
    <header className="rp-topbar">
      <a className="rp-brand" href="/" aria-label="ShopPatch home"><span className="rp-brand-mark"><Icon name="spark" size={16}/></span><span>shop<span className="rp-brand-em">patch</span><sup>®</sup></span></a>
      <div className="rp-topbar-right"><span className="rp-topbar-label">RESEARCH WORKSPACE</span><span className="rp-topbar-divider"/><span className="rp-avatar">SP</span></div>
    </header>

    <main className="rp-main">
      <div className="rp-breadcrumb"><a href="/">Workspace</a><span>/</span><span>Interview report</span></div>
      <div className="rp-heading-row">
        <div><div className="rp-eyebrow"><span className="rp-eyebrow-line"/> FIELD NOTES <span className="rp-eyebrow-number">/ 01</span></div><h1>Shopping interview<span className="rp-heading-dot">.</span></h1><p className="rp-subtitle">A traceable record of what the shopper did, what they said, and what changed.</p></div>
        <div className="rp-heading-actions"><span className="rp-live"><span className="rp-live-dot"/> {loading ? 'CONNECTING' : error ? 'CONNECTION ISSUE' : 'LIVE UPDATING'}</span><button type="button" className="rp-refresh" onClick={() => window.location.reload()}><Icon name="refresh" size={15}/> Refresh</button></div>
      </div>

      {!sessionId ? <section className="rp-panel rp-callout"><Icon name="alert"/><div><h2>No session selected</h2><p>Open a report with <code>?session=YOUR_SESSION_ID</code> to see its interview evidence.</p></div></section> : <>
        {error && <div className="rp-error"><Icon name="alert" size={17}/> Could not refresh report: {error}. Showing the latest available data.</div>}
        <section className="rp-session-bar" aria-label="Session summary">
          <div className="rp-session-title"><span className="rp-session-kicker">SESSION</span><strong>{sessionId}</strong></div>
          <div className="rp-session-meta"><span><Icon name="clock" size={15}/> {formatDate(createdAt)}</span><span className="rp-session-separator"/><span className="rp-status"><span/> {status}</span></div>
        </section>

        <div className="rp-metrics">
          <div className="rp-metric"><div className="rp-metric-top"><span>OBSERVED ACTIONS</span><Icon name="activity" size={17}/></div><strong>{observedEvents.length}</strong><small>Recorded by the sample store</small></div>
          <div className="rp-metric"><div className="rp-metric-top"><span>PARTICIPANT STATEMENTS</span><Icon name="quote" size={17}/></div><strong>{directQuotes.length}</strong><small>Directly captured in this session</small></div>
          <div className="rp-metric"><div className="rp-metric-top"><span>LIVE REPAIR</span><Icon name="code" size={17}/></div><strong className="rp-metric-status">{hasRepair && repairStatus ? repairStatus.replace(/_/g, ' ') : 'Not started'}</strong><small>{hasRepair ? (buildStatus ?? 'Awaiting build result') : 'No code change requested yet'}</small></div>
        </div>

        <div className="rp-tabbar" role="tablist" aria-label="Report sections"><button type="button" role="tab" aria-selected={activeTab === 'evidence'} className={activeTab === 'evidence' ? 'is-active' : ''} onClick={() => setActiveTab('evidence')}>Interview evidence <span>{events.length}</span></button><button type="button" role="tab" aria-selected={activeTab === 'repair'} className={activeTab === 'repair' ? 'is-active' : ''} onClick={() => setActiveTab('repair')}>Repair & retest <span>{hasRepair ? '01' : '00'}</span></button></div>

        {activeTab === 'evidence' ? <div className="rp-grid">
          <div className="rp-main-column">
            <section className="rp-panel rp-brief"><div className="rp-section-top"><span className="rp-section-number">01 / RESEARCH TASK</span><span className="rp-source-chip">SESSION SETUP</span></div><h2>What the shopper came to do</h2><p>{goal ?? 'The shopping goal has not been recorded yet. It will appear here when the interview begins.'}</p>{storeUrl && <a className="rp-store-link" href={storeUrl} target="_blank" rel="noopener noreferrer">Open session store <Icon name="external" size={14}/></a>}</section>

            <section className="rp-panel rp-trace"><div className="rp-section-top"><span className="rp-section-number">02 / BEHAVIOR TRACE</span><span className="rp-source-chip"><span className="rp-chip-dot"/> LIVE DATA</span></div><div className="rp-section-heading"><div><h2>Activity, in sequence</h2><p>Store actions and interview moments, shown as recorded.</p></div><span className="rp-count">{events.length} events</span></div>
              {events.length ? <><div className="rp-timeline">{recentEvents.map((event, index) => <div className="rp-timeline-item" key={`${event.id}-${index}`}><div className={`rp-timeline-marker ${event.source}`}><Icon name={event.source === 'said' ? 'quote' : event.source === 'system' ? 'code' : 'activity'} size={13}/></div><div className="rp-timeline-body"><div className="rp-timeline-top"><span className={`rp-source-tag ${event.source}`}>{sourceLabel(event.source)}</span>{event.phase && <span className="rp-phase-tag">{event.phase === 'before' ? 'BASELINE' : 'RETEST'}</span>}<time>{formatTime(event.at)}</time></div><strong>{event.source === 'said' && event.text ? `“${event.text}”` : event.detail}</strong><small>{event.type.replace(/[._-]/g, ' ')}</small></div></div>)}</div>{events.length > 8 && <button className="rp-text-button" type="button" onClick={() => setShowAllEvents(value => !value)}>{showAllEvents ? 'Show recent activity' : `Show all ${events.length} events`} <Icon name="arrow" size={14}/></button>}</> : <EmptyState title="Waiting for the first action" detail="Searches, product views, size selections, and interview events will appear here as the session runs."/>}
            </section>
          </div>
          <aside className="rp-side-column">
            <section className="rp-panel rp-signal"><div className="rp-section-top"><span className="rp-section-number">OBSERVED SIGNALS</span><Icon name="search" size={17}/></div><h2>What happened on site</h2><p className="rp-helper">Counts from instrumented store events. These do not explain shopper intent on their own.</p><div className="rp-signal-row"><div><strong>Searches</strong><span>Search actions recorded</span></div><b>{searchEvents.length}</b></div><div className="rp-signal-row"><div><strong>Size selections</strong><span>Size interactions recorded</span></div><b>{sizeEvents.length}</b></div></section>
            <section className="rp-panel rp-quotes"><div className="rp-section-top"><span className="rp-section-number">PARTICIPANT VOICE</span><Icon name="quote" size={17}/></div><h2>In their own words</h2><p className="rp-helper">Direct statements only. The interviewer’s interpretation belongs elsewhere.</p>{directQuotes.length ? <div className="rp-quote-list">{directQuotes.slice(-3).map((event, index) => <blockquote key={`${event.id}-${index}`}><span>“</span><p>{event.text}</p><footer>{event.phase === 'after' ? 'AFTER REPAIR' : 'INTERVIEW'} · {formatTime(event.at)}</footer></blockquote>)}</div> : <div className="rp-side-empty">No participant statements have been captured yet.</div>}</section>
          </aside>
        </div> : <div className="rp-grid">
          <div className="rp-main-column">
            <section className="rp-panel rp-repair"><div className="rp-section-top"><span className="rp-section-number">03 / CODE CHANGE</span><span className={`rp-repair-badge ${repairComplete ? 'complete' : ''}`}>{hasRepair && repairStatus ? repairStatus.replace(/_/g, ' ') : 'NOT STARTED'}</span></div><h2>From friction to working code</h2><p className="rp-helper">The patch and build result appear only when a repair job actually produces them.</p>
              {!hasRepair ? <EmptyState title="No repair has been run" detail="Once the interviewer starts a repair, its progress and verified output will appear here."/> : <><div className="rp-repair-intent"><span>REPAIR RECORD</span><p>{repairDescription ?? 'A repair was started. No summary was recorded.'}</p></div>{repairHypothesis && <div className="rp-hypothesis"><span>AGENT HYPOTHESIS</span><p>{repairHypothesis}</p></div>}<div className="rp-build-row"><div className={`rp-build-icon ${statusIsPassed ? 'pass' : ''}`}><Icon name={statusIsPassed ? 'check' : 'clock'} size={19}/></div><div><strong>Build & verification</strong><p>{buildStatus ? buildStatus.replace(/_/g, ' ') : 'No build result reported yet'}</p></div></div>{failure && <div className="rp-error rp-inline-error"><Icon name="alert" size={17}/>{failure}</div>}{diff ? <div className="rp-diff-wrap"><div className="rp-code-header"><span><Icon name="code" size={15}/> Actual source diff</span><span>READ ONLY</span></div><DiffView diff={diff}/></div> : <div className="rp-pending-diff">The code diff will appear when the worker reports a patch.</div>}{buildOutput && <details className="rp-build-log"><summary>Build output</summary><pre>{buildOutput}</pre></details>}{publishedAt && <div className="rp-published"><Icon name="check" size={15}/> Published to the session store at {formatTime(publishedAt)}</div>}{previewUrl && <a className="rp-preview-link" href={previewUrl} target="_blank" rel="noopener noreferrer">Open repaired preview <Icon name="external" size={15}/></a>}</>}
            </section>
          </div>
          <aside className="rp-side-column">
            <section className="rp-panel rp-feedback"><div className="rp-section-top"><span className="rp-section-number">04 / RETEST FEEDBACK</span><Icon name="refresh" size={17}/></div><h2>Participant response</h2><p className="rp-helper">These are direct statements, not a measured conversion result. Read them with the full timeline for context.</p><div className="rp-feedback-block"><span className="rp-feedback-label">LATEST BASELINE STATEMENT</span>{beforeQuotes.length ? <blockquote>“{beforeQuotes[beforeQuotes.length - 1].text}”</blockquote> : <p>No baseline statement recorded.</p>}</div><div className="rp-feedback-connector"><span/><Icon name="arrow" size={16}/><span/></div><div className="rp-feedback-block after"><span className="rp-feedback-label">LATEST RETEST STATEMENT</span>{afterQuotes.length ? <blockquote>“{afterQuotes[afterQuotes.length - 1].text}”</blockquote> : <p>Waiting for the shopper to try the updated site and respond.</p>}</div></section>
          </aside>
        </div>}

        <footer className="rp-footer"><span>SHOPPATCH / INTERVIEW RECORD</span><span>{updatedAt ? `Last synced ${updatedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}` : 'Waiting for session data'}</span></footer>
      </>}
    </main>
  </div>
}
