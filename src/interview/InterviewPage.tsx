import { watchInterviewPresence } from './interview-presence';
import { objectiveEvent } from '../../shared/objective-event';
import { useAppMessage, useAudioTrack, useDailyEvent, useLocalSessionId, useMeetingState, useScreenVideoTrack, useVideoTrack } from '@daily-co/daily-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CVIProvider } from '../components/cvi/components/cvi-provider';
import { Conversation } from '../components/cvi/components/conversation';
import { MagicCanvas } from '../components/cvi/components/magic-canvas';
import { useObservableEvent, useSendAppMessage } from '../components/cvi/hooks/cvi-events-hooks';
import { useLocalScreenshare } from '../components/cvi/hooks/use-local-screenshare';
import { useReplicaIDs } from '../components/cvi/hooks/use-replica-ids';
import { FrictionRecorder, type ClipMoment } from './friction-recorder';
import { awaitingPostJourneyAnswer, debriefProgress, debriefFollowupKey, isShopperUtterance } from '../../shared/interview-turn';
import './interview.css';

type Session = { id: string; storeUrl: string; conversationId?: string; clipsEnabled?: boolean };
type StoreEvent = { id?: string; at?: string; type: string; detail?: Record<string, unknown> | string; timestamp?: number | string };
type Repair = {
  status: 'idle' | 'planning' | 'queued' | 'running' | 'verifying' | 'ready' | 'failed';
  issue?: string;
  hypothesis?: string;
  summary?: string;
  error?: string;
  publishedAt?: string;
  jobs?: { id: string; issue: string; desiredOutcome?: string; plan?: { title: string; change: string; acceptanceCriteria: string[] }; status: 'planning' | 'queued' | 'running' | 'verifying' | 'verified' | 'failed' }[];
};
type ToolCall = { name?: string; arguments?: string | Record<string, unknown>; tool_call_id?: string };
type SessionPhase = 'intro' | 'shopping' | 'first_attempt_done' | 'repairing' | 'retest' | 'done';
type SessionSnapshot = { phase: SessionPhase; firstAttemptCompletedAt?: string };
const ACTIVE_SESSION_KEY = 'loop-active-study';
const PROBE_COOLDOWN_MS = 18_000;
const systemEventTypes = new Set(['utterance', 'phase_changed', 'shopping_goal', 'sample_issue_lookup', 'sample_question_prompted', 'overall_question_prompted', 'interviewer_probe_asked', 'call_diagnostic', 'objective_activated', 'objective_completed', 'debrief_started', 'app_speech_delivered', 'app_speech_failed', 'debrief_followup_requested']);
const isStoreEvent = (event: StoreEvent) => !systemEventTypes.has(event.type) && !event.type.startsWith('repair_');

type Probe = { kind: 'idle' | 'choices' | 'step'; event: StoreEvent };

function eventTime(event: StoreEvent): number {
  const parsed = Date.parse(event.at || '');
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function eventField(event: StoreEvent, key: string): string {
  return event.detail && typeof event.detail === 'object' ? String(event.detail[key] ?? '') : '';
}

function detectProbe(all: StoreEvent[], fresh: StoreEvent[]): Probe | null {
  const choiceFields: Record<string, string> = { size_selected: 'size', sort_changed: 'sort', category_selected: 'category', color_selected: 'color' };
  const choice = fresh.findLast((event) => choiceFields[event.type]);
  if (choice) {
    const history = all.filter((event) => event.type === choice.type && Date.now() - eventTime(event) < 45_000 && eventField(event, 'productId') === eventField(choice, 'productId'));
    const switches = history.reduce((count, event, index) => count + Number(index > 0 && eventField(event, choiceFields[choice.type]) !== eventField(history[index - 1], choiceFields[choice.type])), 0);
    if (switches >= 2) return { kind: 'choices', event: choice };
  }
  const idle = fresh.findLast((event) => event.type === 'page_idle');
  if (idle) return { kind: 'idle', event: idle };
  const step = fresh.findLast((event) => ['product_viewed', 'category_selected', 'search_submitted', 'size_selected', 'color_selected', 'sort_changed', 'added_to_bag', 'bag_viewed', 'checkout_started', 'listing_viewed'].includes(event.type));
  return step ? { kind: 'step', event: step } : null;
}

function probeIsStale(probe: Probe, events: StoreEvent[]): boolean {
  return Date.now() - eventTime(probe.event) > 25_000 || events.some((event) => isStoreEvent(event) && eventTime(event) > eventTime(probe.event) && ['product_viewed', 'category_selected', 'home_viewed', 'bag_viewed', 'checkout_started', 'checkout_completed'].includes(event.type));
}

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
  const safeKeys = new Set(['query', 'term', 'search', 'searchTerm', 'search_term', 'product', 'productId', 'product_id', 'productName', 'product_name', 'category', 'size', 'color', 'filter', 'sort', 'step', 'count', 'seconds', 'view', 'page']);
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

function Brand() {
  return <div className="sp-brand"><span className="sp-brand-symbol" aria-hidden="true">✳</span><span>loop<span className="sp-brand-period">.</span></span></div>;
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
        <span className="sp-eyebrow"><span className="sp-eyebrow-line" /> LIVE WEBSITE RESEARCH</span>
        <h1>Watch users get stuck.<br /><em>Fix what they find.</em></h1>
        <p>Loop brings interviewing and iteration into one session: an AI researcher watches someone use a website, asks about friction as it happens, and turns a confirmed issue into a change they can try immediately.</p>
        <div className="sp-story-steps">
          <div><span>01</span><b>Observe</b><small>A real task, shared live</small></div>
          <div><span>02</span><b>Understand</b><small>Questions in the moment</small></div>
          <div><span>03</span><b>Improve</b><small>A code change tested in the same call</small></div>
        </div>
      </section>
      <section className="sp-setup-card" aria-label="Connect Tavus">
        <div className="sp-card-icon" aria-hidden="true">↗</div>
        <span className="sp-overline">BEFORE WE BEGIN</span>
        <h2>Connect your Tavus workspace</h2>
        <p>Your API key is sent to the local server to create the interviewer. It is never placed in the demo website or front-end bundle.</p>
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
    <header className="sp-topbar"><Brand /><span className="sp-topbar-right">LIVE WEBSITE RESEARCH <span className="sp-topbar-dot" /></span></header>
    <main className="sp-launch">
      <div className="sp-launch-visual" role="img" aria-label="Illustration of a live website study, interviewer question, and verified site revision">
        <div className="sp-visual-heading"><span><i /> LIVE WEBSITE STUDY</span><small>OBSERVE → REVISE → RETEST</small></div>
        <div className="sp-visual-browser">
          <div className="sp-visual-browser-bar"><span className="sp-visual-dots"><i /><i /><i /></span><span className="sp-visual-address">example-website.com</span><span className="sp-visual-browser-mark">↗</span></div>
          <div className="sp-visual-site"><div className="sp-visual-site-nav"><b>YOUR WEBSITE</b><span>Explore&nbsp;&nbsp;&nbsp; Products&nbsp;&nbsp;&nbsp; About</span></div><div className="sp-visual-site-body"><div className="sp-visual-site-copy"><small>A REAL USER TASK</small><span className="sp-visual-line is-title" /><span className="sp-visual-line" /><span className="sp-visual-line is-short" /><span className="sp-visual-site-button" /></div><div className="sp-visual-site-art"><span /><span /><span /></div></div></div>
        </div>
        <div className="sp-visual-question"><span className="sp-visual-avatar">✳</span><div><small>MIRA · INTERVIEWER</small><p>What were you expecting to happen there?</p></div></div>
        <div className="sp-visual-update"><span>↗</span><div><small>CHANGE VERIFIED</small><strong>Ready for a fresh look</strong></div></div>
        <div className="sp-launch-demo-tag"><span>CURRENT DEMO</span><strong>Clothing storefront</strong></div>
      </div>
      <div className="sp-launch-content">
        <span className="sp-eyebrow"><span className="sp-eyebrow-line" /> USER TESTING, WITH A LIVE REVISION</span>
        <h1>See the friction.<br />Change the site.<br /><em>Test it again.</em></h1>
        <p>Loop combines live user interviewing with on-the-spot website changes. It observes a real task, probes a confirmed obstacle, and publishes a verified revision for the same person to retry. This demo uses a clothing store.</p>
        <div className="sp-launch-meta"><div><strong>01</strong><span>observe the task</span></div><div><strong>02</strong><span>make a real change</span></div><div><strong>03</strong><span>retest together</span></div></div>
        {error && <p className="sp-error" role="alert">{error}</p>}
        <button className="sp-primary sp-start" type="button" onClick={onStart} disabled={busy}>{busy ? 'Preparing your interviewer…' : 'Try the clothing store demo'} <span aria-hidden="true">↗</span></button>
        <small>Mira is an AI interviewer. She may use facial and vocal cues, and your shared screen, to guide her questions. Short clips of confirmed friction are saved automatically to the live report; the full call is not stored. Checkout is simulated.</small>
      </div>
    </main>
  </div>;
}

function Room({ session, conversationUrl, onLeave }: { session: Session; conversationUrl: string; onLeave: () => void }) {
  const [events, setEvents] = useState<StoreEvent[]>([]);
  const [phase, setPhase] = useState<SessionPhase>('intro');
  const [error, setError] = useState('');
  const [dismissedPrompts, setDismissedPrompts] = useState<string[]>([]);
  const [openedStoreFromCall, setOpenedStoreFromCall] = useState(false);
  const sendAppMessage = useSendAppMessage();
  const sendRawAppMessage = useAppMessage();
  const meetingState = useMeetingState();
  const { isScreenSharing, onToggleScreenshare } = useLocalScreenshare();
  const localId = useLocalSessionId();
  const replicaId = useReplicaIDs()[0];
  const screenTrack = useScreenVideoTrack(localId).track;
  const shopperTrack = useVideoTrack(localId).track;
  const palTrack = useVideoTrack(replicaId).track;
  const shopperAudio = useAudioTrack(localId).track;
  const palAudio = useAudioTrack(replicaId).track;
  const frictionRecorder = useRef<FrictionRecorder | null>(null);
  const seenEventCount = useRef(0);
  const pendingStoreEvents = useRef<StoreEvent[]>([]);
  const lastRepairStatus = useRef('idle:unpublished');
  const lastContextAt = useRef(0);
  const processedToolCalls = useRef(new Set<string>());
  const pendingContexts = useRef<string[]>([]);
  const retryInvited = useRef(false);
  const screenAcknowledged = useRef(false);
  const debriefStarted = useRef(false);
  const debriefContextProvided = useRef(false);
  const processedObjectives = useRef(new Set<string>());
  const lastFollowupKey = useRef('');
  const responsePendingUntil = useRef(0);
  const followupAttempts = useRef(new Map<string, number>());
  const outstandingFollowup = useRef(false);
  const pendingGeneratedPrompt = useRef<{ text: string; at: number } | null>(null);
  const finishRequestedAt = useRef(0);
  const finishing = useRef(false);
  const publishing = useRef(false);
  const failureNotified = useRef(false);
  const pendingProbe = useRef<Probe | null>(null);
  const lastProbeAt = useRef(0);
  const latestEvents = useRef<StoreEvent[]>([]);
  const speakers = useRef({ user: false, pal: false });
  const lastSpeechAt = useRef(0);
  const lastUserUtteranceAt = useRef(0);
  const lastPalQuestionAt = useRef(0);
  const phaseRef = useRef<SessionPhase>('intro');
  const storeUrl = useMemo(() => new URL(session.storeUrl, window.location.origin).toString(), [session.storeUrl]);

  const recordCallDiagnostic = useCallback((stage: string, detail = '') => {
    void api(`/api/sessions/${session.id}/events`, {
      method: 'POST',
      body: JSON.stringify({ type: 'call_diagnostic', detail: { stage, message: detail.slice(0, 300) } }),
    }).catch(() => undefined);
  }, [session.id]);
  useDailyEvent('local-screen-share-started', useCallback(() => recordCallDiagnostic('screen_share_started'), [recordCallDiagnostic]));
  useDailyEvent('local-screen-share-stopped', useCallback(() => recordCallDiagnostic('screen_share_stopped'), [recordCallDiagnostic]));
  useDailyEvent('local-screen-share-canceled', useCallback(() => recordCallDiagnostic('screen_share_canceled'), [recordCallDiagnostic]));
  useDailyEvent('nonfatal-error', useCallback((event) => recordCallDiagnostic('daily_nonfatal_error', `${event.type}: ${event.errorMsg}`), [recordCallDiagnostic]));
  useDailyEvent('error', useCallback((event) => recordCallDiagnostic('daily_error', `${event.error?.type ?? 'unknown'}: ${event.errorMsg}`), [recordCallDiagnostic]));

  useEffect(() => {
    if (!session.clipsEnabled || meetingState !== 'joined-meeting' || frictionRecorder.current) return;
    try { frictionRecorder.current = new FrictionRecorder(session.id, setError); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Clip capture is unavailable in this browser.'); }
  }, [meetingState, session.clipsEnabled, session.id]);

  useEffect(() => {
    frictionRecorder.current?.setTracks({ screen: screenTrack, pal: palTrack, shopper: shopperTrack, palAudio, shopperAudio });
  }, [screenTrack, palTrack, shopperTrack, palAudio, shopperAudio]);

  useEffect(() => () => { void frictionRecorder.current?.finish(); }, []);

  const observeMoment = useCallback((signal: string, evidence: string) => {
    if (!session.clipsEnabled) return;
    void api<ClipMoment>(`/api/sessions/${session.id}/clips/observe`, { method: 'POST', body: JSON.stringify({ signal, evidence }) })
      .then((clip) => frictionRecorder.current?.updateMoments([clip]))
      .catch(() => undefined);
  }, [session.id, session.clipsEnabled]);

  const appendContext = useCallback((context: string) => {
    if (meetingState !== 'joined-meeting') {
      pendingContexts.current.push(context);
      return;
    }
    sendAppMessage({ message_type: 'conversation', event_type: 'conversation.append_llm_context', conversation_id: session.conversationId!, properties: { context } });
  }, [meetingState, sendAppMessage, session.conversationId]);

  useEffect(() => {
    if (meetingState !== 'joined-meeting') return;
    for (const context of pendingContexts.current.splice(0)) appendContext(context);
  }, [meetingState, appendContext]);

  useObservableEvent<ToolCall>(useCallback((event) => {
    const objective = objectiveEvent(event, session.conversationId!);
    if (objective) {
      const key = `${objective.type}:${objective.detail.objective_name}`;
      if (processedObjectives.current.has(key)) return;
      processedObjectives.current.add(key);
      void api(`/api/sessions/${session.id}/events`, { method: 'POST', body: JSON.stringify(objective) }).catch(() => processedObjectives.current.delete(key));
      return;
    }
    if (event.event_type === 'conversation.started_speaking') {
      if (event.properties.role === 'user') speakers.current.user = true;
      else speakers.current.pal = true;
      return;
    }
    if (event.event_type === 'conversation.stopped_speaking') {
      if (event.properties.role === 'user') speakers.current.user = false;
      else speakers.current.pal = false;
      lastSpeechAt.current = Date.now();
      return;
    }
    if (event.event_type === 'conversation.utterance') {
      const { role, speech, user_audio_analysis, user_visual_analysis } = event.properties;
      if (role === 'replica' || !speech?.trim()) return;
      if (role === 'pal') {
        responsePendingUntil.current = 0;
        if (outstandingFollowup.current) {
          if (outstandingFollowup.current && !speech.includes('?')) lastFollowupKey.current = '';
          outstandingFollowup.current = false;
        }
        if (speech.includes('?')) lastPalQuestionAt.current = Date.now();
      }
      if (role === 'user' && !speech.trimStart().startsWith('[Loop')) lastUserUtteranceAt.current = Date.now();
      void api(`/api/sessions/${session.id}/events`, {
        method: 'POST',
        body: JSON.stringify({ type: 'utterance', detail: { role, speech, ...(user_audio_analysis ? { user_audio_analysis } : {}), ...(user_visual_analysis ? { user_visual_analysis } : {}) }, timestamp: event.timestamp ? event.timestamp * 1000 : Date.now() }),
      }).catch(() => {});
      return;
    }
    if (event.event_type === 'conversation.perception_tool_call') {
      const { name, modality, arguments: rawArguments } = event.properties;
      if (modality !== 'vision' || !/^(loop|shoppatch)_camera_check_in_/.test(name)) return;
      let args: unknown = rawArguments;
      if (typeof rawArguments === 'string') {
        try { args = JSON.parse(rawArguments); } catch { return; }
      }
      if (!args || typeof args !== 'object' || typeof (args as { cue?: unknown }).cue !== 'string' || !(args as { cue: string }).cue.trim()) return;
      if (!['shopping', 'repairing'].includes(phaseRef.current)) return;
      pendingGeneratedPrompt.current = { at: Date.now(), text: `Visible camera cue: ${String((args as { cue: string }).cue).slice(0, 300)}. At the next appropriate pause, briefly reference what you actually observed and ask one neutral question about what the shopper is thinking or feeling. Do not assert an emotion. If this overlaps a question already asked, wait for the answer instead.` };
      observeMoment('Camera cue', `Visible cue: ${String((args as { cue: string }).cue).slice(0, 300)}. This does not establish emotion or difficulty.`);
      return;
    }
    if (event.event_type !== 'conversation.tool_call') return;
    const tool = event.properties;
    if (!tool?.name || !tool.tool_call_id || tool.name.startsWith('canvas_')) return;
    if (processedToolCalls.current.has(tool.tool_call_id)) return;
    processedToolCalls.current.add(tool.tool_call_id);
    void api<{ output?: unknown; status?: string; endInterview?: boolean }>(`/api/sessions/${session.id}/tool`, {
      method: 'POST',
      body: JSON.stringify({ name: tool.name, arguments: tool.arguments ?? '{}', tool_call_id: tool.tool_call_id }),
    }).then((result) => {
      if (result.endInterview) finishRequestedAt.current = Date.now();
      sendRawAppMessage({ message_type: 'conversation', event_type: 'conversation.tool_result', conversation_id: event.conversation_id, properties: { tool_call_id: tool.tool_call_id, output: result.output ?? '', status: result.status === 'error' ? 'error' : 'success' } }, '*');
    }).catch((cause) => {
      sendRawAppMessage({ message_type: 'conversation', event_type: 'conversation.tool_result', conversation_id: event.conversation_id, properties: { tool_call_id: tool.tool_call_id, output: cause instanceof Error ? cause.message : 'Tool failed', status: 'error' } }, '*');
      setError(cause instanceof Error ? cause.message : 'A tool call failed.');
    });
  }, [session.id, sendRawAppMessage, observeMoment]));

  const leaveWithClips = useCallback(async () => {
    if (frictionRecorder.current) {
      const latest = await api<ClipMoment[]>(`/api/sessions/${session.id}/clips`).catch(() => []);
      frictionRecorder.current.updateMoments(latest);
      await frictionRecorder.current.finish();
    }
    onLeave();
  }, [session.id, onLeave]);


  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const poll = async () => {
      if (inFlight || cancelled) return;
      inFlight = true;
      try {
        const [nextEvents, nextRepair, nextSession, nextClips] = await Promise.all([
          api<StoreEvent[]>(`/api/sessions/${session.id}/events`),
          api<Repair>(`/api/sessions/${session.id}/repair`),
          api<SessionSnapshot>(`/api/sessions/${session.id}`),
          session.clipsEnabled ? api<ClipMoment[]>(`/api/sessions/${session.id}/clips`) : Promise.resolve([]),
        ]);
        if (cancelled) return;
        frictionRecorder.current?.updateMoments(nextClips);
        setEvents(nextEvents);
        latestEvents.current = nextEvents;
        phaseRef.current = nextSession.phase;
        setPhase(nextSession.phase);
        if (nextSession.phase === 'retest') retryInvited.current = true;
        for (const event of nextEvents) {
          if (event.type !== 'utterance') continue;
          if (eventField(event, 'role') === 'pal' && eventField(event, 'speech').includes('?')) lastPalQuestionAt.current = Math.max(lastPalQuestionAt.current, eventTime(event));
          if (isShopperUtterance(event)) lastUserUtteranceAt.current = Math.max(lastUserUtteranceAt.current, eventTime(event));
        }
        const fresh = nextEvents.slice(seenEventCount.current).filter(isStoreEvent);
        seenEventCount.current = nextEvents.length;
        pendingStoreEvents.current.push(...fresh);
        if (pendingStoreEvents.current.length && Date.now() - lastContextAt.current > 2500) {
          const recent = pendingStoreEvents.current.splice(0).slice(-8).map(readableEvent).join('; ');
          appendContext(`Live website events: ${recent}. Use these precise observations together with camera, voice, and screen perception. A pause or repeated choice is only a cue: ask what the shopper is thinking or feeling, never diagnose emotion. When they identify friction, acknowledge it and ask how they would resolve it. Submit their suggestion through the repair tool during the first journey only; at most two changes total. Do not interrupt their answer or ask about every click.`);
          lastContextAt.current = Date.now();
        }
        if (outstandingFollowup.current && responsePendingUntil.current > 0 && Date.now() >= responsePendingUntil.current) {
          outstandingFollowup.current = false;
          lastFollowupKey.current = '';
        }
        const quiet = meetingState === 'joined-meeting' && Date.now() >= responsePendingUntil.current && !speakers.current.user && !speakers.current.pal && Date.now() - lastSpeechAt.current > 1800;
        if (quiet && isScreenSharing && screenTrack?.readyState === 'live' && !screenAcknowledged.current && !nextSession.firstAttemptCompletedAt) {
          screenAcknowledged.current = true;
          responsePendingUntil.current = Date.now() + 15000;
          sendAppMessage({ message_type: 'conversation', event_type: 'conversation.respond', conversation_id: session.conversationId!, properties: { text: '[Loop screen-share event, not shopper speech] The shopper has started sharing a live screen track. Briefly acknowledge that their screen share is coming through and invite them to think aloud. Do not repeat this if you have already acknowledged it. Do not invent details on the screen.' } });
          return;
        }
        const unanswered = lastPalQuestionAt.current > lastUserUtteranceAt.current || awaitingPostJourneyAnswer(nextEvents, '1970-01-01T00:00:00.000Z');
        const cameraCue = pendingGeneratedPrompt.current;
        if (cameraCue && (Date.now() - cameraCue.at > 15_000 || fresh.some((event) => eventTime(event) >= cameraCue.at && ['product_viewed', 'category_selected', 'listing_viewed', 'home_viewed', 'bag_viewed', 'checkout_started', 'checkout_completed'].includes(event.type)))) pendingGeneratedPrompt.current = null;
        if (['shopping', 'repairing'].includes(nextSession.phase) && !nextSession.firstAttemptCompletedAt) {
          const candidate = detectProbe(nextEvents, fresh);
          if (candidate) pendingProbe.current = candidate;
          if (pendingProbe.current && probeIsStale(pendingProbe.current, nextEvents)) pendingProbe.current = null;
          if (quiet && !unanswered && Date.now() - Math.max(lastProbeAt.current, lastPalQuestionAt.current) > PROBE_COOLDOWN_MS && (pendingProbe.current || pendingGeneratedPrompt.current)) {
            const probe = pendingProbe.current;
            const instruction = pendingGeneratedPrompt.current?.text || `Observed website ${probe!.kind === 'choices' ? 'repeated switching between options' : probe!.kind === 'idle' ? 'inactivity for at least five seconds on the current page' : 'meaningful step'}: ${readableEvent(probe!.event)}. Briefly reference this exact action and ask ONE neutral question about what the shopper is thinking or feeling. Do not assume confusion. If they mention an obstacle, acknowledge it and ask how it could be resolved.`;
            if (probe) observeMoment(`Website ${probe.kind}`, readableEvent(probe.event));
            pendingProbe.current = null;
            pendingGeneratedPrompt.current = null;
            lastProbeAt.current = Date.now();
            sendAppMessage({ message_type: 'conversation', event_type: 'conversation.respond', conversation_id: session.conversationId!, properties: { text: `[Loop observation, not shopper speech] ${instruction}` } });
          }
        } else { pendingProbe.current = null; pendingGeneratedPrompt.current = null; }
        const progress = debriefProgress(nextEvents, nextSession.firstAttemptCompletedAt);
        if (nextSession.firstAttemptCompletedAt && !debriefContextProvided.current) {
          debriefContextProvided.current = true;
          appendContext(`First journey is complete. After the overall-experience answer, consult the attached Tavus knowledge-base CSV and ask once about the rank 1 past-user concern A short answer or decline counts. Do not repeat questions already answered. Publication is ${nextRepair.publishedAt ? 'confirmed' : 'pending'}; finish both debrief exchanges before retry.`);
        }
        if (nextSession.firstAttemptCompletedAt && !debriefStarted.current && !nextEvents.some((event) => event.type === 'debrief_started') && nextSession.phase !== 'done' && nextSession.phase !== 'retest' && quiet && !unanswered) {
          debriefStarted.current = true;
          const acknowledgement = 'Thanks for completing that journey! This was a simulated purchase, so no real order or payment was made. How was your overall experience?';
          appendContext(`The first journey is complete. The application is delivering this exact acknowledgement and overall-experience question through speech: ${JSON.stringify(acknowledgement)} Wait for the shopper's answer; do not repeat the question. Treat their next answer as overall-experience feedback, acknowledge it, then continue with the retrieved knowledge-base concern.`);
          responsePendingUntil.current = Date.now() + 15000;
          lastPalQuestionAt.current = Date.now();
          sendAppMessage({ message_type: 'conversation', event_type: 'conversation.echo', conversation_id: session.conversationId!, properties: { modality: 'text', text: acknowledgement } });
          void api(`/api/sessions/${session.id}/events`, { method: 'POST', body: JSON.stringify({ type: 'debrief_started', detail: { source: 'tavus_knowledge_base' } }) }).catch(() => undefined);
          return;
        }
        const repairKey = `${nextRepair.status}:${nextRepair.publishedAt || ''}:${progress.overallAnswered}:${progress.knowledgeAnswered}:${nextRepair.jobs?.map((job) => job.status).join(',')}`;
        if (repairKey !== lastRepairStatus.current) {
          lastRepairStatus.current = repairKey;
          appendContext(`Internal repair state: ${nextRepair.status}; published: ${Boolean(nextRepair.publishedAt)}. Changes: ${JSON.stringify(nextRepair.jobs?.map((job) => ({ id: job.id, title: job.plan?.title || job.issue, status: job.status })) || [])}. ${nextSession.firstAttemptCompletedAt ? progress.knowledgeAnswered ? nextRepair.publishedAt ? 'Publication is confirmed. Acknowledge the current answer and finish any question underway; wait for the application retry transition. Do not start a new follow-up.' : 'The overall and knowledge-base questions have been answered. Ask relevant follow-ups one at a time about this shopper’s experience while work remains pending. Never imply publication before confirmation.' : 'You lead the debrief: overall experience first, then the retrieved knowledge-base concern, each with room for an answer. Acknowledge answers and continue naturally. Do not repeat answered questions while waiting for objective evaluation.' : 'Continue observing the first journey. Confirm friction and ask for a proposed resolution before requesting a change.'} Do not mention internal workers or tell the shopper you are filling time.`);
        }
        const awaitingAnswer = awaitingPostJourneyAnswer(nextEvents, nextSession.firstAttemptCompletedAt) || unanswered;
        const debriefDone = progress.overallAnswered && progress.knowledgeAnswered;
        if (nextSession.phase !== 'done' && nextSession.phase !== 'retest' && nextSession.firstAttemptCompletedAt && debriefDone && nextRepair.publishedAt && !awaitingAnswer && quiet && !retryInvited.current && !publishing.current) {
          publishing.current = true;
          try {
            await api(`/api/sessions/${session.id}/phase`, { method: 'POST', body: JSON.stringify({ phase: 'retest' }) });
            if (cancelled) return;
            retryInvited.current = true;
            setPhase('retest');
            appendContext(`The verified revision is published and the debrief objectives are complete. The application has now entered retry. Invite the shopper to reload and explore the changes once. Published changes and job IDs for record_retest_feedback: ${JSON.stringify(nextRepair.jobs?.filter((job) => job.status === 'verified').map((job) => ({ id: job.id, change: job.plan?.change || job.desiredOutcome || job.issue })))}. Ask the shopper to explore each change, acknowledge their actual feedback, record it against the corresponding job ID, and ask specifically about any published change still without feedback. After all published changes receive feedback, thank them, say goodbye, then call loop_finish_interview.`);
            responsePendingUntil.current = Date.now() + 15000;
            sendAppMessage({ message_type: 'conversation', event_type: 'conversation.respond', conversation_id: session.conversationId!, properties: { text: '[Loop retry transition, not shopper speech] The updated site is published and the debrief is complete. Invite the shopper to reload, explore the changes, and give feedback. Do not repeat the invitation if you already gave it.' } });
          } catch (cause) { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not start the retry.'); }
          finally { publishing.current = false; }
        }
        const followupKey = debriefFollowupKey(nextEvents, {
          completedAt: nextSession.firstAttemptCompletedAt, published: Boolean(nextRepair.publishedAt),
          pending: nextSession.phase !== 'done' && nextSession.phase !== 'retest' && nextRepair.status !== 'failed' && Boolean(nextRepair.jobs?.some((job) => job.status !== 'failed')),
          quiet, awaitingAnswer, now: Date.now(), lastActivityAt: Math.max(lastSpeechAt.current, lastUserUtteranceAt.current, lastPalQuestionAt.current), lastKey: lastFollowupKey.current,
        });
        if (followupKey && (followupAttempts.current.get(followupKey) || 0) < 2) {
          followupAttempts.current.set(followupKey, (followupAttempts.current.get(followupKey) || 0) + 1);
          outstandingFollowup.current = true;
          lastFollowupKey.current = followupKey;
          responsePendingUntil.current = Date.now() + 30000;
          sendAppMessage({ message_type: 'conversation', event_type: 'conversation.respond', conversation_id: session.conversationId!, properties: { text: '[Loop debrief continuation, not shopper speech] Publication is still pending. Briefly acknowledge the shopper’s latest answer if you have not already, then ask ONE new, relevant follow-up about their shopping experience grounded in what they said. Do not repeat an answered question, mention workers or waiting, or request another change. Let them finish answering. If a newer context confirms publication, do not start another question; let the application invite retry.' } });
          void api(`/api/sessions/${session.id}/events`, { method: 'POST', body: JSON.stringify({ type: 'debrief_followup_requested', detail: { answerKey: followupKey } }) }).catch(() => undefined);
        }
        const jobs = nextRepair.jobs || [];
        const noUpdate = !nextRepair.publishedAt && (jobs.length === 0 || (nextRepair.status === 'failed' && jobs.every((job) => ['verified', 'failed'].includes(job.status))));
        if (nextSession.firstAttemptCompletedAt && debriefDone && noUpdate && !awaitingAnswer && quiet && !failureNotified.current) {
          failureNotified.current = true;
          appendContext(`The debrief is complete. ${jobs.length ? 'The requested update could not be published; be candid that there is no revised website to retry.' : 'No website change was requested, so there is no retry.'} Acknowledge their feedback, thank them and say goodbye, then call loop_finish_interview. Do not keep asking questions.`);
          sendAppMessage({ message_type: 'conversation', event_type: 'conversation.respond', conversation_id: session.conversationId!, properties: { text: '[Loop session state] Please wrap up according to the latest completion context.' } });
        }
        if (finishRequestedAt.current && quiet && Date.now() - finishRequestedAt.current > 4000 && !finishing.current) {
          finishing.current = true;
          try { await leaveWithClips(); }
          catch (cause) { finishing.current = false; setError(cause instanceof Error ? cause.message : 'Could not finish saving interview clips.'); }
        }

      } catch { /* The next poll retries while a local server restarts. */ }
      finally { inFlight = false; }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 3200);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [session.id, session.clipsEnabled, appendContext, observeMoment, sendAppMessage, session.conversationId, leaveWithClips, meetingState, isScreenSharing, screenTrack]);


  const openStore = () => {
    setOpenedStoreFromCall(true);
    window.open(storeUrl, '_blank', 'noopener,noreferrer');
  };

  const storeOpened = openedStoreFromCall || events.some((event) => event.type === 'store_opened');
  const activePrompt = meetingState === 'joined-meeting'
    ? phase === 'retest' && !dismissedPrompts.includes('retry')
      ? 'retry'
      : ['intro', 'shopping'].includes(phase)
        ? storeOpened && !isScreenSharing && !dismissedPrompts.includes('share')
          ? 'share'
          : null
        : null
    : null;
  const dismissPrompt = (prompt: string) => setDismissedPrompts((current) => [...current, prompt]);

  return <div className="sp-shell sp-room-shell">
    <header className="sp-topbar sp-call-topbar"><Brand /><div className="sp-call-topbar-actions"><span className="sp-session-indicator"><span className="sp-live-dot" /> Live call <span className="sp-session-id">{session.id.slice(0, 8)}</span></span><a href={`/report?session=${encodeURIComponent(session.id)}`} target="_blank" rel="noopener noreferrer">Live report ↗</a></div></header>
    <main className="sp-room sp-room-call">
      <section className="sp-call-stage" aria-label="Video interview with Mira">
        <div className="sp-call-frame"><Conversation conversationUrl={conversationUrl} onLeave={() => { void leaveWithClips(); }} onCallDiagnostic={recordCallDiagnostic} /></div>
        {activePrompt && <aside className="sp-call-prompt" role="status" aria-live="polite">
          <button className="sp-call-prompt-close" type="button" onClick={() => dismissPrompt(activePrompt)} aria-label="Dismiss suggestion">×</button>
          <span className="sp-call-prompt-label">FROM MIRA</span>
          <h2>{activePrompt === 'retry' ? 'Try the revised store' : 'Share the store window'}</h2>
          <p>{activePrompt === 'retry' ? 'Reload the store tab, or open it again, and retry the parts that felt difficult. Tell Mira what feels different.' : 'Choose the store window in your browser’s sharing picker so Mira can follow along. Both faces should float when sharing begins; use Float faces in the call controls if your browser needs a click.'}</p>
          <div className="sp-call-prompt-actions"><button type="button" onClick={activePrompt === 'share' ? onToggleScreenshare : openStore}>{activePrompt === 'retry' ? 'Open revised store ↗' : 'Share screen'}</button></div>
        </aside>}
      </section>
      <div className="sp-call-utility"><span><span className="sp-call-pulse" /> {isScreenSharing ? 'Sharing your screen with Mira' : 'Talk naturally with Mira'}</span><div><button type="button" onClick={openStore}>Open store ↗</button><button type="button" onClick={onToggleScreenshare}>{isScreenSharing ? 'Stop sharing' : 'Share screen'}</button></div></div>
      {error && <p className="sp-error" role="alert">{error}</p>}
    </main>
    <MagicCanvas />
  </div>;
}

export default function InterviewPage() {
  const [ready, setReady] = useState<boolean | null>(null);
  const [canConfigure, setCanConfigure] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [session, setSession] = useState<Session | null>(null);
  const [conversationUrl, setConversationUrl] = useState('');
  const [ended, setEnded] = useState(false);
  const [ending, setEnding] = useState(false);
  const [endError, setEndError] = useState('');
  const endingRef = useRef(false);
  const departureTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(departureTimer.current);
    if (!session?.id || ended || ending) return;
    const presence = watchInterviewPresence(session.id, () => {
      if (window.localStorage.getItem(ACTIVE_SESSION_KEY) === session.id) window.localStorage.removeItem(ACTIVE_SESSION_KEY);
    });
    return () => {
      presence.stop();
      // React StrictMode's immediate remount cancels this deferred route departure.
      departureTimer.current = window.setTimeout(presence.depart, 0);
    };
  }, [session?.id, ended, ending]);


  useEffect(() => {
    void api<{ ready: boolean; canConfigure?: boolean }>('/api/status').then(async (status) => {
      setCanConfigure(status.canConfigure !== false);
      if (!status.ready) { setReady(false); return; }
      const activeId = window.localStorage.getItem(ACTIVE_SESSION_KEY);
      if (!activeId) { setReady(true); return; }
      const active = await api<Session & SessionSnapshot & { conversationUrl?: string }>(`/api/sessions/${encodeURIComponent(activeId)}`).catch(() => null);
      if (!active || active.phase === 'done' || !active.conversationUrl) {
        window.localStorage.removeItem(ACTIVE_SESSION_KEY);
        setReady(true);
        return;
      }
      setSession({ id: active.id, storeUrl: active.storeUrl, conversationId: active.conversationId, clipsEnabled: active.clipsEnabled });
      setConversationUrl(active.conversationUrl);
      setReady(true);
    }).catch(() => { setReady(false); setError('The server is not available. Please try reloading shortly.'); });
  }, []);

  const start = async () => {
    setBusy(true);
    setError('');
    let created: Session | null = null;
    try {
      created = await api<Session>('/api/sessions', { method: 'POST' });
      const conversation = await api<{ conversation_id: string; conversation_url: string }>(`/api/sessions/${created.id}/conversation`, { method: 'POST' });
      window.localStorage.setItem(ACTIVE_SESSION_KEY, created.id);
      setSession({ ...created, conversationId: conversation.conversation_id, clipsEnabled: true });
      setConversationUrl(conversation.conversation_url);
      setEnded(false);
      setEnding(false);
      setEndError('');
    } catch (cause) {
      if (created) await api(`/api/sessions/${created.id}/conversation/end`, { method: 'POST' }).catch(() => {});
      setError(cause instanceof Error ? cause.message : 'Could not start the interview.');
    } finally {
      setBusy(false);
    }
  };

  const endSession = async () => {
    if (!session || endingRef.current) return;
    endingRef.current = true;
    setEnding(true);
    setEndError('');
    try {
      await api(`/api/sessions/${session.id}/conversation/end`, { method: 'POST' });
      window.localStorage.removeItem(ACTIVE_SESSION_KEY);
      setEnded(true);
    } catch (cause) {
      setEndError(cause instanceof Error ? cause.message : 'Could not finish restoring the store.');
    } finally {
      endingRef.current = false;
      setEnding(false);
    }
  };

  if (ready === null) return <div className="sp-loading"><Brand /><span>Preparing the experience lab…</span></div>;
  if (!ready && !canConfigure) return <div className="sp-loading"><Brand /><p>The demo owner is finishing setup. Please try again shortly.</p><button onClick={() => window.location.reload()}>Refresh</button></div>;
  if (!ready) return <Setup initialError={error} onReady={() => { setReady(true); setError(''); }} />;
  if (ending || endError) return <div className="sp-shell"><header className="sp-topbar"><Brand /></header><main className="sp-end"><span className="sp-eyebrow"><span className="sp-eyebrow-line" /> WRAPPING UP</span><h1>{endError ? 'Store reset needs attention.' : <>Restoring the<br /><em>original store.</em></>}</h1><p>{endError || 'The temporary site revision is being removed before the next session.'}</p>{endError && <button type="button" className="sp-primary sp-end-report" onClick={() => { void endSession(); }}>Retry store reset <span>↗</span></button>}</main></div>;
  if (ended) return <div className="sp-shell"><header className="sp-topbar"><Brand /></header><main className="sp-end"><span className="sp-eyebrow"><span className="sp-eyebrow-line" /> SESSION COMPLETE</span><h1>Thank you for<br /><em>thinking aloud.</em></h1><p>Your shopping journey and your response to the revision are saved to this study.{session?.clipsEnabled ? ' Confirmed friction clips appear in the report as soon as they are prepared.' : ''}</p>{session && <a className="sp-primary sp-end-report" href={`/report?session=${encodeURIComponent(session.id)}`}>View study report <span>↗</span></a>}<button type="button" className="sp-end-again" onClick={() => { setSession(null); setConversationUrl(''); setEnded(false); }}>Start another interview</button></main></div>;
  if (!session || !conversationUrl) return <Launch onStart={() => { void start(); }} busy={busy} error={error} />;
  return <CVIProvider><Room session={session} conversationUrl={conversationUrl} onLeave={() => { void endSession(); }} /></CVIProvider>;
}
