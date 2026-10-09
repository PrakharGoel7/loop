import { useAppMessage } from '@daily-co/daily-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CVIProvider } from '../components/cvi/components/cvi-provider';
import { Conversation } from '../components/cvi/components/conversation';
import { MagicCanvas } from '../components/cvi/components/magic-canvas';
import { useObservableEvent, useSendAppMessage } from '../components/cvi/hooks/cvi-events-hooks';
import { useLocalScreenshare } from '../components/cvi/hooks/use-local-screenshare';
import './interview.css';

type Session = { id: string; storeUrl: string; conversationId?: string };
type StoreEvent = { id?: string; type: string; detail?: Record<string, unknown> | string; timestamp?: number | string };
type Repair = {
  status: 'idle' | 'queued' | 'running' | 'verifying' | 'ready' | 'failed';
  issue?: string;
  hypothesis?: string;
  summary?: string;
  error?: string;
  publishedAt?: string;
};
type ToolCall = { name?: string; arguments?: string | Record<string, unknown>; tool_call_id?: string };
type SessionPhase = 'intro' | 'shopping' | 'first_attempt_done' | 'repairing' | 'retest' | 'done';

const systemEventTypes = new Set(['utterance', 'phase_changed', 'shopping_goal']);
const isStoreEvent = (event: StoreEvent) => !systemEventTypes.has(event.type) && !event.type.startsWith('repair_');

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const data = await response.json().catch(() => ({})) as T & { error?: string; message?: string; output?: unknown };
  if (!response.ok) throw new Error(data.error || data.message || (typeof data.output === 'string' ? data.output : '') || `Request failed (${response.status})`);
  return data;
}

function readableEvent(event: StoreEvent): string {
  const detail = event.detail;
  const safeKeys = new Set(['query', 'term', 'search', 'searchTerm', 'search_term', 'product', 'productId', 'product_id', 'productName', 'product_name', 'category', 'size', 'color', 'filter', 'sort', 'step', 'count']);
  const text = typeof detail === 'string'
    ? detail.slice(0, 80)
    : detail && typeof detail === 'object'
      ? Object.entries(detail)
        .filter(([key, value]) => value !== null && value !== undefined && safeKeys.has(key))
        .slice(0, 3)
        .map(([key, value]) => `${key.replaceAll('_', ' ')}: ${String(value).slice(0, 60)}`)
        .join(', ')
      : '';
  return `${event.type.replaceAll('_', ' ')}${text ? ` (${text})` : ''}`;
}

function labelForEvent(event: StoreEvent): string {
  const labels: Record<string, string> = {
    store_opened: 'Opened the store',
    home_viewed: 'Viewed the homepage',
    listing_viewed: 'Viewed a collection',
    search_submitted: 'Searched the store',
    category_selected: 'Selected a category',
    sort_changed: 'Changed sort order',
    product_viewed: 'Opened a product',
    size_selected: 'Selected a size',
    add_to_bag_without_size: 'Tried to add without a size',
    added_to_bag: 'Added to bag',
    bag_viewed: 'Opened the bag',
    bag_item_removed: 'Removed an item',
    bag_quantity_changed: 'Changed bag quantity',
    checkout_started: 'Started checkout',
    checkout_completed: 'Finished test checkout',
  };
  return labels[event.type] ?? event.type.replaceAll('_', ' ');
}

function Brand() {
  return <div className="sp-brand"><span className="sp-brand-symbol" aria-hidden="true">✳</span><span>shoppatch<span className="sp-brand-period">.</span></span></div>;
}

function Setup({ onReady, initialError }: { onReady: () => void; initialError?: string }) {
  const [key, setKey] = useState('');
  const [faceId, setFaceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api('/api/setup', { method: 'POST', body: JSON.stringify({ apiKey: key.trim(), ...(faceId.trim() ? { faceId: faceId.trim() } : {}) }) });
      setKey('');
      onReady();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not connect to Tavus.');
    } finally {
      setBusy(false);
    }
  };

  return <div className="sp-shell">
    <header className="sp-topbar"><Brand /><span className="sp-topbar-right">LIVE RESEARCH, REAL REVISIONS <span className="sp-topbar-dot" /></span></header>
    <main className="sp-setup-grid">
      <section className="sp-setup-story">
        <span className="sp-eyebrow"><span className="sp-eyebrow-line" /> THE EXPERIENCE LAB</span>
        <h1>Watch the moment<br /><em>shopping gets stuck.</em></h1>
        <p>An AI researcher talks with a shopper, watches their journey, and turns an observed obstacle into a working site change during the same session.</p>
        <div className="sp-story-steps">
          <div><span>01</span><b>Observe</b><small>A real shopping task, shared live</small></div>
          <div><span>02</span><b>Understand</b><small>Follow-up questions at the right moment</small></div>
          <div><span>03</span><b>Improve</b><small>A code change the shopper can try again</small></div>
        </div>
      </section>
      <section className="sp-setup-card" aria-label="Connect Tavus">
        <div className="sp-card-icon" aria-hidden="true">↗</div>
        <span className="sp-overline">BEFORE WE BEGIN</span>
        <h2>Connect your Tavus workspace</h2>
        <p>Your API key is sent to the local server to create the interviewer. It is never placed in the store or front-end bundle.</p>
        <form onSubmit={submit}>
          <label htmlFor="sp-api-key">Tavus API key</label>
          <input id="sp-api-key" type="password" autoComplete="off" placeholder="Enter your key" value={key} onChange={(event) => setKey(event.target.value)} required />
          <label htmlFor="sp-face-id">Face ID <span className="sp-optional">OPTIONAL</span></label>
          <input id="sp-face-id" type="text" autoComplete="off" placeholder="Use a Tavus default face" value={faceId} onChange={(event) => setFaceId(event.target.value)} />
          {(error || initialError) && <p className="sp-error" role="alert">{error || initialError}</p>}
          <button type="submit" className="sp-primary" disabled={busy || !key.trim()}>{busy ? 'Connecting…' : 'Connect Tavus'} <span aria-hidden="true">↗</span></button>
        </form>
        <small>Camera and microphone permission are requested when you start a session.</small>
      </section>
    </main>
  </div>;
}

function Launch({ onStart, busy, error }: { onStart: () => void; busy: boolean; error: string }) {
  return <div className="sp-shell">
    <header className="sp-topbar"><Brand /><span className="sp-topbar-right">THE EXPERIENCE LAB <span className="sp-topbar-dot" /></span></header>
    <main className="sp-launch">
      <div className="sp-launch-photo" role="img" aria-label="Clothing research studio" />
      <div className="sp-launch-content">
        <span className="sp-eyebrow"><span className="sp-eyebrow-line" /> A LIVE SHOPPING STUDY</span>
        <h1>One shopper.<br />One friction point.<br /><em>One better experience.</em></h1>
        <p>Meet your interviewer, shop a sample clothing store while sharing your screen, then try an updated version shaped by what happened.</p>
        <div className="sp-launch-meta"><div><strong>5</strong><span>clothing categories</span></div><div><strong>1</strong><span>live interview</span></div><div><strong>∞</strong><span>possible insights</span></div></div>
        {error && <p className="sp-error" role="alert">{error}</p>}
        <button className="sp-primary sp-start" type="button" onClick={onStart} disabled={busy}>{busy ? 'Preparing your interviewer…' : 'Begin the interview'} <span aria-hidden="true">↗</span></button>
        <small>The Tavus conversation starts when you click. A test checkout never charges you.</small>
      </div>
    </main>
  </div>;
}

function Room({ session, conversationUrl, onLeave }: { session: Session; conversationUrl: string; onLeave: () => void }) {
  const [events, setEvents] = useState<StoreEvent[]>([]);
  const [repair, setRepair] = useState<Repair>({ status: 'idle' });
  const [phase, setPhase] = useState<SessionPhase>('intro');
  const [phaseBusy, setPhaseBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const sendAppMessage = useSendAppMessage();
  const sendRawAppMessage = useAppMessage();
  const { isScreenSharing, onToggleScreenshare } = useLocalScreenshare();
  const seenEventCount = useRef(0);
  const pendingStoreEvents = useRef<StoreEvent[]>([]);
  const lastRepairStatus = useRef('idle:unpublished');
  const lastContextAt = useRef(0);
  const processedToolCalls = useRef(new Set<string>());
  const phaseRef = useRef<SessionPhase>('intro');
  const storeUrl = useMemo(() => new URL(session.storeUrl, window.location.origin).toString(), [session.storeUrl]);

  useEffect(() => { phaseRef.current = phase; }, [phase]);

  const appendContext = useCallback((context: string) => {
    sendAppMessage({ message_type: 'conversation', event_type: 'conversation.append_llm_context', conversation_id: session.conversationId!, properties: { context } });
  }, [sendAppMessage, session.conversationId]);

  const respond = useCallback((text: string) => {
    sendAppMessage({ message_type: 'conversation', event_type: 'conversation.respond', conversation_id: session.conversationId!, properties: { text } });
  }, [sendAppMessage, session.conversationId]);

  useObservableEvent<ToolCall>(useCallback((event) => {
    if (event.event_type === 'conversation.utterance') {
      const { role, speech, user_audio_analysis, user_visual_analysis } = event.properties;
      if (role === 'replica' || !speech?.trim()) return;
      void api(`/api/sessions/${session.id}/events`, {
        method: 'POST',
        body: JSON.stringify({ type: 'utterance', detail: { role, speech, ...(user_audio_analysis ? { user_audio_analysis } : {}), ...(user_visual_analysis ? { user_visual_analysis } : {}) }, timestamp: event.timestamp ? event.timestamp * 1000 : Date.now() }),
      }).catch(() => {});
      return;
    }
    if (event.event_type !== 'conversation.tool_call') return;
    const tool = event.properties;
    if (!tool?.name || !tool.tool_call_id || tool.name.startsWith('canvas_')) return;
    if (processedToolCalls.current.has(tool.tool_call_id)) return;
    processedToolCalls.current.add(tool.tool_call_id);
    void api<{ output?: unknown; status?: string }>(`/api/sessions/${session.id}/tool`, {
      method: 'POST',
      body: JSON.stringify({ name: tool.name, arguments: tool.arguments ?? '{}', tool_call_id: tool.tool_call_id }),
    }).then((result) => {
      sendRawAppMessage({ message_type: 'conversation', event_type: 'conversation.tool_result', conversation_id: event.conversation_id, properties: { tool_call_id: tool.tool_call_id, output: result.output ?? '', status: result.status === 'error' ? 'error' : 'success' } }, '*');
    }).catch((cause) => {
      sendRawAppMessage({ message_type: 'conversation', event_type: 'conversation.tool_result', conversation_id: event.conversation_id, properties: { tool_call_id: tool.tool_call_id, output: cause instanceof Error ? cause.message : 'Tool failed', status: 'error' } }, '*');
      setError(cause instanceof Error ? cause.message : 'A tool call failed.');
    });
  }, [session.id, sendRawAppMessage]));

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const [nextEvents, nextRepair] = await Promise.all([
          api<StoreEvent[]>(`/api/sessions/${session.id}/events`),
          api<Repair>(`/api/sessions/${session.id}/repair`),
        ]);
        if (cancelled) return;
        setEvents(nextEvents);
        setRepair(nextRepair);
        const fresh = nextEvents.slice(seenEventCount.current).filter(isStoreEvent);
        seenEventCount.current = nextEvents.length;
        if (fresh.length && phaseRef.current === 'intro') {
          phaseRef.current = 'shopping';
          setPhase('shopping');
          void api(`/api/sessions/${session.id}/phase`, { method: 'POST', body: JSON.stringify({ phase: 'shopping' }) }).catch(() => {});
        }
        pendingStoreEvents.current.push(...fresh);
        if (pendingStoreEvents.current.length && Date.now() - lastContextAt.current > 2500) {
          const recent = pendingStoreEvents.current.slice(-7).map(readableEvent).join('; ').slice(0, 750);
          appendContext(`Live store activity (exact site events, separate from your visual screen perception): ${recent}. Use this as evidence to ask a short, neutral follow-up only when helpful. Do not assume difficulty solely from a click.`);
          lastContextAt.current = Date.now();
          pendingStoreEvents.current = [];
        }
        const repairKey = `${nextRepair.status}:${nextRepair.publishedAt ? 'published' : 'unpublished'}`;
        if (repairKey !== lastRepairStatus.current) {
          lastRepairStatus.current = repairKey;
          if (nextRepair.status === 'ready' && nextRepair.publishedAt) {
            phaseRef.current = 'retest';
            setPhase('retest');
            appendContext(`A real code change has passed verification and is live for this shopper. Change summary: ${nextRepair.summary || 'See repair result'}. Invite the shopper to reload the store and retry the part that caused difficulty. Ask what they notice before explaining the change.`);
            respond('The verified store update is now ready. Please invite me to reload and try again.');
          } else if (nextRepair.status === 'failed') {
            appendContext(`The proposed store change did not pass verification: ${nextRepair.error || 'unknown error'}. Tell the shopper plainly that the update is not ready; do not claim the store was changed.`);
            respond('The store update could not be verified. Please let me know honestly.');
          }
        }
      } catch { /* The next poll retries while a local server restarts. */ }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 3200);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [session.id, appendContext, respond]);

  const markPhase = async (next: SessionPhase) => {
    setPhaseBusy(true);
    setError('');
    try {
      await api(`/api/sessions/${session.id}/phase`, { method: 'POST', body: JSON.stringify({ phase: next }) });
      phaseRef.current = next;
      setPhase(next);
      if (next === 'shopping') {
        appendContext(`The shopper opened the sample store: ${storeUrl}. They should share the store window with you while attempting to find and buy an item. Give them room to think aloud.`);
      } else if (next === 'first_attempt_done') {
        appendContext('The shopper marked their first shopping attempt complete. Ask open-ended questions about what they expected, what was difficult, and how they made choices. When you have a confirmed issue, use your repair tool to make a real code change.');
        respond('I have finished my first attempt. Please ask me what happened before making a change.');
      } else if (next === 'done') {
        appendContext('The shopper marked the retest complete. Ask for a comparison of the original and revised experience and close the interview.');
        respond('I have finished trying the updated store. Please ask for my comparison.');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update the session.');
    } finally {
      setPhaseBusy(false);
    }
  };

  const openStore = () => {
    window.open(storeUrl, '_blank', 'noopener,noreferrer');
    if (phase === 'intro') void markPhase('shopping');
  };

  const copyStore = async () => {
    await navigator.clipboard.writeText(storeUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2200);
  };

  const storeActions = events.filter(isStoreEvent);
  const repairActive = ['queued', 'running', 'verifying'].includes(repair.status);

  return <div className="sp-shell sp-room-shell">
    <header className="sp-topbar"><Brand /><span className="sp-session-indicator"><span className="sp-live-dot" /> LIVE SESSION <span className="sp-session-id">{session.id.slice(0, 8)}</span></span></header>
    <main className="sp-room">
      <section className="sp-room-primary">
        <div className="sp-room-heading"><div><span className="sp-overline">THE INTERVIEW</span><h1>Find the friction.</h1></div><span className="sp-room-tag">SHOPPER STUDY / 01</span></div>
        <div className="sp-call-frame"><Conversation conversationUrl={conversationUrl} onLeave={onLeave} /></div>
        <div className="sp-call-caption"><span className="sp-call-pulse" /> Your interviewer is here. Talk naturally and share the store window when you shop.</div>
      </section>
      <aside className="sp-room-aside">
        <div className="sp-aside-head"><span className="sp-overline">YOUR STUDY</span><h2>From observation<br />to iteration.</h2></div>
        <div className="sp-flow">
          <div className={`sp-flow-item ${phase === 'intro' || phase === 'shopping' ? 'is-current' : ''}`}><span className="sp-flow-num">01</span><div><b>Shop the store</b><p>Choose any item you’d actually consider buying. Think aloud as you compare options.</p></div></div>
          <div className={`sp-flow-item ${phase === 'first_attempt_done' || phase === 'repairing' ? 'is-current' : ''}`}><span className="sp-flow-num">02</span><div><b>Tell us what happened</b><p>Your interviewer will ask about the moments that slowed you down.</p></div></div>
          <div className={`sp-flow-item ${phase === 'retest' || phase === 'done' ? 'is-current' : ''}`}><span className="sp-flow-num">03</span><div><b>Try the revision</b><p>Reload the store after a verified change and share your first impression.</p></div></div>
        </div>
        <div className="sp-store-card">
          <div className="sp-store-card-top"><span className="sp-overline">SAMPLE CLOTHING STORE</span><span className="sp-external" aria-hidden="true">↗</span></div>
          <p>Find a piece you like. The checkout is a simulation—no payment needed.</p>
          <div className="sp-store-actions"><button type="button" className="sp-open-store" onClick={openStore}>Open the store <span aria-hidden="true">↗</span></button><button type="button" className="sp-copy-store" onClick={() => { void copyStore(); }} aria-label="Copy store link">{copied ? 'Copied' : 'Copy link'}</button></div>
        </div>
        <div className="sp-share-card"><div><b>{isScreenSharing ? 'Your screen is shared' : 'Share your store window'}</b><p>{isScreenSharing ? 'Your interviewer can now follow along.' : 'Choose the store window so your interviewer can watch your journey.'}</p></div><button type="button" onClick={onToggleScreenshare}>{isScreenSharing ? 'Stop sharing' : 'Share screen'}</button></div>
        {phase === 'shopping' && <button className="sp-milestone" type="button" onClick={() => { void markPhase('first_attempt_done'); }} disabled={phaseBusy}>Finished your first attempt? <span>Continue →</span></button>}
        {(phase === 'retest' || phase === 'done') && <button className="sp-milestone" type="button" onClick={() => { void markPhase('done'); }} disabled={phaseBusy || phase === 'done'}>{phase === 'done' ? 'Retest complete' : 'Finished trying the revision?'} <span>{phase === 'done' ? '✓' : 'Continue →'}</span></button>}
        {repair.status !== 'idle' && <div className={`sp-repair-status ${repair.status === 'failed' ? 'is-error' : ''}`}><span className="sp-overline">THE LIVE REVISION</span><b>{repair.status === 'ready' && repair.publishedAt ? 'Updated store is ready' : repair.status === 'failed' ? 'Revision needs attention' : repair.status === 'verifying' || repair.status === 'ready' ? 'Checking the change' : repairActive ? 'Making a real site change' : 'Revision queued'}</b><p>{repair.status === 'ready' && repair.publishedAt ? 'Reload the store, then try again.' : repair.status === 'failed' ? (repair.error || 'The update did not pass its checks.') : 'Your interviewer is turning a confirmed issue into a working improvement.'}</p></div>}
        <div className="sp-activity"><div className="sp-activity-title"><span className="sp-overline">ACTIVITY</span><span>{storeActions.length} signals</span></div>{storeActions.length ? <div className="sp-activity-list">{storeActions.slice(-4).reverse().map((item, index) => <div key={`${item.id || item.timestamp || item.type}-${index}`}><span className="sp-activity-dot" /><span>{labelForEvent(item)}</span></div>)}</div> : <p>Store interactions appear here as your shopper explores.</p>}</div>
        {error && <p className="sp-error" role="alert">{error}</p>}
      </aside>
    </main>
    <MagicCanvas />
  </div>;
}

export default function InterviewPage() {
  const [ready, setReady] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [session, setSession] = useState<Session | null>(null);
  const [conversationUrl, setConversationUrl] = useState('');
  const [ended, setEnded] = useState(false);

  useEffect(() => {
    void api<{ ready: boolean }>('/api/status').then((status) => setReady(status.ready)).catch(() => { setReady(false); setError('Local server is not available. Start the server, then reload.'); });
  }, []);

  const start = async () => {
    setBusy(true);
    setError('');
    try {
      const created = await api<Session>('/api/sessions', { method: 'POST' });
      const conversation = await api<{ conversation_id: string; conversation_url: string }>(`/api/sessions/${created.id}/conversation`, { method: 'POST' });
      setSession({ ...created, conversationId: conversation.conversation_id });
      setConversationUrl(conversation.conversation_url);
      setEnded(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start the interview.');
    } finally {
      setBusy(false);
    }
  };

  if (ready === null) return <div className="sp-loading"><Brand /><span>Preparing the experience lab…</span></div>;
  if (!ready) return <Setup initialError={error} onReady={() => { setReady(true); setError(''); }} />;
  if (ended) return <div className="sp-shell"><header className="sp-topbar"><Brand /></header><main className="sp-end"><span className="sp-eyebrow"><span className="sp-eyebrow-line" /> SESSION COMPLETE</span><h1>Thank you for<br /><em>thinking aloud.</em></h1><p>Your shopping journey and your response to the revision are saved to this local session.</p>{session && <a className="sp-primary sp-end-report" href={`/report?session=${encodeURIComponent(session.id)}`}>View study report <span>↗</span></a>}<button type="button" className="sp-end-again" onClick={() => { setSession(null); setConversationUrl(''); setEnded(false); }}>Start another interview</button></main></div>;
  if (!session || !conversationUrl) return <Launch onStart={() => { void start(); }} busy={busy} error={error} />;
  return <CVIProvider><Room session={session} conversationUrl={conversationUrl} onLeave={() => {
    setEnded(true);
    void api(`/api/sessions/${session.id}/conversation/end`, { method: 'POST' }).catch(() => {});
  }} /></CVIProvider>;
}
