import { ensureHostedClip } from './hosted-clips.js';
import { resolveStoreVersion, readStoreVersionAsset } from './store-versions.js';
import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { installHostedAccess, isHosted, isAdmin, claimSession, requireSessionOwner } from './hosted-access.js';
import { addEvent, getSession, getSessions, saveSession, type StudyPhase } from './state.js';
import { configureTavus, createTavusConversation, endTavusConversation, getPalId, tavusReady } from './tavus.js';
import { autoPublishRepair, beginStoreSession, finishStoreSession, publishRepair, requestRepair } from './repair.js';
import { attachRecordingDestination, ensureRecordingRetrieval, finishSessionRecording, getRecordingConfig, recordingFile, retrySessionRecording } from './recordings.js';
import { clipFile, confirmFriction, dismissUnconfirmed, finishClipUpload, markClipFailure, observeFriction, recoverInterruptedClips, uploadClipSegment } from './clips.js';
import { buildStudySummary, linkableRetryStatement } from './report-summary.js';
import { awaitingPostJourneyAnswer, debriefProgress } from '../shared/interview-turn.js';

const app = express();
app.disable('x-powered-by');
if (isHosted()) app.set('trust proxy', 'loopback');
installHostedAccess(app);
app.use(express.json({ limit: '64kb' }));

const port = Number(process.env.API_PORT || 3001);
const presenceStartedAt = Date.now();
const interviewHeartbeats = new Map<string, number>();
const endingStudies = new Map<string, Promise<{ ended: boolean; restored: boolean; tavusEndWarning?: string }>>();
const validPhases = new Set<StudyPhase>(['intro', 'shopping', 'first_attempt_done', 'repairing', 'retest', 'done']);

async function finishFirstAttempt(session: NonNullable<ReturnType<typeof getSession>>, source: string) {
  if (session.phase === 'retest' || session.phase === 'done') return;
  if (!session.firstAttemptCompletedAt) {
    session.firstAttemptCompletedAt = new Date().toISOString();
    saveSession(session);
  }
  if (session.phase !== 'first_attempt_done') {
    session.phase = 'first_attempt_done';
    addEvent(session, 'phase_changed', { phase: 'first_attempt_done', source });
  }
  await autoPublishRepair(session);
}

function sessionFromRequest(req: express.Request, res: express.Response) {
  if (!requireSessionOwner(req, res, String(req.params.id))) return;
  const session = getSession(String(req.params.id));
  if (!session) res.status(404).json({ error: 'Study session not found.' });
  return session;
}

app.get('/api/status', (req, res) => {
  res.json({ ready: tavusReady(), palId: getPalId(), localOnly: !isHosted(), canConfigure: isAdmin(req), clipsAvailable: true, legacyRecordingAvailable: Boolean(getRecordingConfig()) });
});

app.post('/api/setup', async (req, res) => {
  try {
    const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey : '';
    const faceId = typeof req.body?.faceId === 'string' && req.body.faceId.trim() ? req.body.faceId.trim() : undefined;
    const result = await configureTavus(apiKey, faceId);
    if (isHosted()) {
      fs.mkdirSync(path.join(process.cwd(), 'data'), { recursive: true });
      const file = path.join(process.cwd(), 'data/hosted-tavus.json');
      fs.writeFileSync(file + '.tmp', JSON.stringify({ apiKey }), { mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
    }
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

app.post('/api/sessions', async (req, res) => {
  try {
    const origin = process.env.LOOP_PUBLIC_ORIGIN || (typeof req.get('origin') === 'string' ? req.get('origin')! : 'http://localhost:5173');
    const session = await beginStoreSession(origin);
    claimSession(req, session.id);
    session.clipsEnabled = true;
    session.clips = [];
    saveSession(session);
    res.status(201).json({ id: session.id, storeUrl: session.storeUrl, createdAt: session.createdAt });
  } catch (error) {
    res.status(409).json({ error: (error as Error).message });
  }
});

app.get('/api/sessions/:id', (req, res) => {
  const session = sessionFromRequest(req, res);
  if (!session) return;
  res.json({
    id: session.id,
    createdAt: session.createdAt,
    storeUrl: session.storeUrl,
    goal: session.goal,
    phase: session.phase,
    firstAttemptCompletedAt: session.firstAttemptCompletedAt,
    conversationId: session.conversationId,
    conversationUrl: session.conversationUrl,
    recording: session.recording ?? { status: 'off' },
    clipsEnabled: Boolean(session.clipsEnabled),
  });
});

app.get('/api/sessions/:id/events', (req, res) => {
  const session = sessionFromRequest(req, res);
  if (!session) return;
  res.json(session.events);
});

app.post('/api/sessions/:id/events', async (req, res) => {
  const session = sessionFromRequest(req, res);
  if (!session) return;
  const type = typeof req.body?.type === 'string' ? req.body.type : '';
  if (!type) return res.status(400).json({ error: 'Event type required.' });
  const detail = req.body?.detail && typeof req.body.detail === 'object' && !Array.isArray(req.body.detail) ? { ...req.body.detail } : {};
  if (type === 'utterance') detail.phase = session.phase;
  const event = addEvent(session, type, detail);
  if (session.phase === 'intro' && ['store_opened', 'listing_viewed', 'product_viewed'].includes(type)) {
    session.phase = 'shopping';
    saveSession(session);
  }
  if (type === 'checkout_completed') {
    try {
      await finishFirstAttempt(session, 'checkout_completed');
    } catch (error) {
      session.repair.status = 'failed';
      session.repair.error = (error as Error).message.slice(0, 500);
      addEvent(session, 'repair_failed', { error: session.repair.error });
    }
  }
  res.status(201).json(event);
});

app.post('/api/sessions/:id/phase', async (req, res) => {
  const session = sessionFromRequest(req, res);
  if (!session) return;
  const phase = req.body?.phase as StudyPhase;
  if (!validPhases.has(phase)) return res.status(400).json({ error: 'Unknown study phase.' });
  if (phase === 'retest' && (!session.repair.publishedAt || !session.firstAttemptCompletedAt || !debriefProgress(session.events, session.firstAttemptCompletedAt).knowledgeAnswered || awaitingPostJourneyAnswer(session.events, session.firstAttemptCompletedAt))) {
    return res.status(409).json({ error: 'Retry waits for publication, both debrief objectives, and the current shopper answer.' });
  }
  if (phase === 'first_attempt_done') {
    try {
      await finishFirstAttempt(session, 'session_control');
    } catch (error) {
      session.repair.status = 'failed';
      session.repair.error = (error as Error).message;
      saveSession(session);
    }
  } else {
    session.phase = phase;
    addEvent(session, 'phase_changed', { phase });
  }
  res.json({ phase: session.phase, repair: session.repair });
});

app.post('/api/sessions/:id/conversation', async (req, res) => {
  const session = sessionFromRequest(req, res);
  if (!session) return;
  if (session.conversationId && session.conversationUrl) {
    return res.json({ conversation_id: session.conversationId, conversation_url: session.conversationUrl });
  }
  try {
    const conversation = await createTavusConversation(session, Boolean(req.body?.testMode));
    session.conversationId = conversation.conversation_id;
    session.conversationUrl = conversation.conversation_url;
    attachRecordingDestination(session);
    saveSession(session);
    res.json(conversation);
  } catch (error) {
    // A failed call setup must not reserve the only local storefront indefinitely.
    await finishStoreSession(session).catch(() => undefined);
    if (session.recording?.status === 'pending') {
      session.recording.status = 'failed';
      session.recording.error = 'The recorded conversation could not be created.';
      saveSession(session);
    }
    res.status(400).json({ error: (error as Error).message });
  }
});

function endStudy(session: NonNullable<ReturnType<typeof getSession>>) {
  const pending = endingStudies.get(session.id);
  if (pending) return pending;
  const work = (async () => {
    let tavusEndWarning: string | undefined;
    if (session.conversationId && tavusReady() && session.phase !== 'done') {
      try { await endTavusConversation(session.conversationId); }
      catch (error) { tavusEndWarning = (error as Error).message.slice(0, 300); }
    }
    const restored = await finishStoreSession(session);
    if (session.conversationId) finishSessionRecording(session);
    dismissUnconfirmed(session);
    interviewHeartbeats.delete(session.id);
    return { ended: true, restored, ...(tavusEndWarning ? { tavusEndWarning } : {}) };
  })();
  endingStudies.set(session.id, work);
  void work.finally(() => endingStudies.delete(session.id)).catch(() => undefined);
  return work;
}

app.post('/api/sessions/:id/heartbeat', (req, res) => {
  const session = sessionFromRequest(req, res);
  if (!session) return;
  if (session.storeLifecycle !== 'active' || session.phase === 'done') {
    res.status(410).json({ error: 'This study has ended.' }); return;
  }
  interviewHeartbeats.set(session.id, Date.now());
  res.sendStatus(204);
});

app.post('/api/sessions/:id/conversation/end', async (req, res) => {
  const session = sessionFromRequest(req, res);
  if (!session) return;
  try { res.json(await endStudy(session)); }
  catch (error) { res.status(500).json({ error: (error as Error).message }); }
});

app.get('/api/sessions/:id/clips', (req, res) => {
  const session = sessionFromRequest(req, res);
  if (!session) return;
  dismissUnconfirmed(session);
  res.json((session.clips ?? []).map((clip) => ({ ...clip, url: clip.status === 'ready' ? `/api/sessions/${session.id}/clips/${clip.id}/file` : undefined })));
});

app.post('/api/sessions/:id/clips/observe', (req, res) => {
  const session = sessionFromRequest(req, res);
  if (!session) return;
  try {
    const signal = String(req.body?.signal || '').trim();
    const evidence = String(req.body?.evidence || '').trim();
    if (!signal || !evidence) return res.status(400).json({ error: 'A specific observed signal and evidence are required.' });
    res.status(201).json(observeFriction(session, signal, evidence));
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

app.post('/api/sessions/:id/clips/:clipId/segments/:index', express.raw({ type: ['video/webm', 'video/mp4'], limit: '8mb' }), (req, res) => {
  const session = sessionFromRequest(req, res);
  if (!session) return;
  try {
    const count = uploadClipSegment(session, String(req.params.clipId), Number(req.params.index), req.body as Buffer, String(req.get('content-type') || '').split(';')[0]);
    res.json({ received: count });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

app.post('/api/sessions/:id/clips/:clipId/finish', async (req, res) => {
  const session = sessionFromRequest(req, res);
  if (!session) return;
  try { res.json(await finishClipUpload(session, String(req.params.clipId))); }
  catch (error) { res.status(500).json({ error: (error as Error).message }); }
});

app.post('/api/sessions/:id/clips/:clipId/fail', (req, res) => {
  const session = sessionFromRequest(req, res);
  if (!session) return;
  try { markClipFailure(session, String(req.params.clipId), String(req.body?.error || 'The browser could not save this clip.')); res.json({ failed: true }); }
  catch (error) { res.status(400).json({ error: (error as Error).message }); }
});

app.get('/api/sessions/:id/clips/:clipId/file', async (req, res) => {
  const session = sessionFromRequest(req, res);
  if (!session) return;
  const clip = session.clips?.find((item) => item.id === req.params.clipId);
  if (!clip || clip.status !== 'ready') return res.status(404).json({ error: 'Clip not ready.' });
  const file = clipFile(session, clip);
  await ensureHostedClip(session.id, clip.id, file);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Clip file is missing.' });
  res.type('video/mp4').sendFile(file);
});

app.get('/api/sessions/:id/recording', (req, res) => {
  const session = sessionFromRequest(req, res);
  if (!session) return;
  ensureRecordingRetrieval(session);
  const recording = session.recording ?? { status: 'off' };
  res.json({ status: recording.status, requestedAt: recording.requestedAt, endedAt: recording.endedAt, readyAt: recording.readyAt, error: recording.error, url: recording.status === 'ready' ? `/api/sessions/${session.id}/recording/file` : undefined });
});

app.get('/api/sessions/:id/recording/file', (req, res) => {
  const session = sessionFromRequest(req, res);
  if (!session) return;
  const file = recordingFile(session);
  if (session.recording?.status !== 'ready' || !fs.existsSync(file)) return res.status(404).json({ error: 'Recording is not ready yet.' });
  res.type('video/mp4').sendFile(file);
});

app.post('/api/sessions/:id/recording/retry', (req, res) => {
  const session = sessionFromRequest(req, res);
  if (!session) return;
  try {
    retrySessionRecording(session);
    res.json({ status: 'pending' });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

app.get('/api/sessions/:id/repair', (req, res) => {
  const session = sessionFromRequest(req, res);
  if (!session) return;
  res.json(session.repair);
});

app.post('/api/sessions/:id/repair/publish', async (req, res) => {
  const session = sessionFromRequest(req, res);
  if (!session) return;
  if (session.repair.publishedAt) return res.json({ published: true, repair: session.repair });
  try {
    const published = await publishRepair(session);
    if (!published) return res.status(409).json({ error: 'The verified repair batch is not ready to publish.' });
    res.json({ published: true, repair: session.repair });
  } catch (error) {
    session.repair.status = 'failed';
    session.repair.error = (error as Error).message.slice(0, 500);
    addEvent(session, 'repair_failed', { error: session.repair.error });
    res.status(500).json({ error: session.repair.error });
  }
});

app.get('/api/sessions/:id/summary', (req, res) => {
  const session = sessionFromRequest(req, res);
  if (!session) return;
  res.json(buildStudySummary(session));
});

app.post('/api/sessions/:id/tool', async (req, res) => {
  const session = sessionFromRequest(req, res);
  if (!session) return;
  const name = String(req.body?.name || '').replace(/^shoppatch_/, 'loop_');
  let args: Record<string, unknown> = {};
  try {
    args = typeof req.body?.arguments === 'string' ? JSON.parse(req.body.arguments) : req.body?.arguments || {};
  } catch {
    return res.status(400).json({ status: 'error', output: 'Tool arguments were invalid JSON.' });
  }
  if (name.startsWith('loop_get_store_activity_')) {
    const events = session.events
      .filter((event) => !['phase_changed', 'repair_requested', 'repair_verified', 'repair_published'].includes(event.type))
      .slice(-14)
      .map(({ at, type, detail }) => ({ at, type, detail: JSON.stringify(detail).slice(0, 180) }));
    return res.json({ status: 'success', output: { phase: session.phase, goal: session.goal, events } });
  }
  if (name.startsWith('loop_get_most_common_sample_issue_')) {
    return res.json({ status: 'success', output: { available: false, message: 'Consult the attached Tavus knowledge-base document for rank 1, the most common past-user concern. Ask about it after the overall-experience answer. This legacy tool does not perform retrieval.' } });
  }
  if (name.startsWith('loop_record_goal_')) {
    const goal = String(args.goal || '').trim().slice(0, 500);
    if (!goal) return res.status(400).json({ status: 'error', output: 'A stated goal is required.' });
    session.goal = goal;
    addEvent(session, 'shopping_goal', { goal });
    return res.json({ status: 'success', output: 'Shopping goal recorded.' });
  }
  if (name.startsWith('loop_finish_first_attempt_')) {
    const reason = String(args.reason || 'The shopper confirmed the first attempt is complete.').trim().slice(0, 500);
    try {
      await finishFirstAttempt(session, `pal_tool: ${reason}`);
      return res.json({ status: 'success', output: { phase: session.phase, repair_status: session.repair.status, concern_question: 'Ask overall experience once, acknowledge the answer or decline, then ask about the retrieved past-user concern once. Leave room for each answer, then continue relevant follow-ups while publication is pending.' } });
    } catch (error) {
      session.repair.status = 'failed';
      session.repair.error = (error as Error).message.slice(0, 500);
      addEvent(session, 'repair_failed', { error: session.repair.error });
      return res.status(500).json({ status: 'error', output: session.repair.error });
    }
  }
  if (name.startsWith('loop_record_retest_feedback_')) {
    const jobId = String(args.job_id || '').trim();
    const statement = linkableRetryStatement(session, jobId);
    if (!statement) return res.status(400).json({ status: 'error', output: 'No recent shopper statement can be linked to that published change after the retry.' });
    const job = session.repair.jobs?.find((item) => item.id === jobId);
    if (!job) return res.status(400).json({ status: 'error', output: 'Published change not found.' });
    job.retryQuoteEventIds ??= [];
    if (!job.retryQuoteEventIds.includes(statement.id)) {
      job.retryQuoteEventIds.push(statement.id);
      addEvent(session, 'retest_feedback_linked', { jobId, quoteEventId: statement.id });
    }
    const remainingChanges = (session.repair.jobs ?? [])
      .filter((item) => item.status === 'verified' && !item.retryQuoteEventIds?.length)
      .map((item) => ({ jobId: item.id, change: item.plan?.change || item.summary || item.desiredOutcome }));
    return res.json({
      status: 'success',
      output: {
        linked: true,
        jobId,
        quoteEventId: statement.id,
        shopperFeedback: String(statement.detail.speech ?? '').slice(0, 1000),
        remainingChanges,
        nextStep: remainingChanges.length
          ? 'Acknowledge what the shopper just said in one short sentence. Then invite them to try the remaining change and ask what they think of it. Do not end the interview yet.'
          : 'Acknowledge what the shopper just said. All published changes have feedback; thank them, say goodbye, then call loop_finish_interview.',
      },
    });
  }
  if (name.startsWith('loop_finish_interview_')) {
    const debrief = debriefProgress(session.events, session.firstAttemptCompletedAt);
    const jobs = session.repair.jobs ?? [];
    const busy = jobs.some((job) => ['queued', 'planning', 'running', 'verifying'].includes(job.status));
    const remainingChanges = session.repair.publishedAt ? jobs.filter((job) => job.status === 'verified' && !job.retryQuoteEventIds?.length).map((job) => ({ jobId: job.id, change: job.plan?.change || job.desiredOutcome })) : [];
    if (!session.firstAttemptCompletedAt || !debrief.knowledgeAnswered || awaitingPostJourneyAnswer(session.events, session.firstAttemptCompletedAt) || busy || remainingChanges.length || (jobs.length && session.repair.status !== 'failed' && !session.repair.publishedAt)) {
      return res.json({ status: 'success', output: { canFinish: false, remainingChanges, message: 'Finish the first journey, overall and knowledge-base answers, and feedback on every published change before wrapping up. If work is pending, continue relevant followups without claiming it finished.' } });
    }
    addEvent(session, 'interview_wrap_up', { reason: String(args.reason || '').slice(0, 500) });
    return res.json({ status: 'success', endInterview: true, output: { canFinish: true, message: 'The interview will end after your goodbye finishes.' } });
  }
  if (name.startsWith('loop_start_store_repair_')) {
    try {
      const output = requestRepair(session, {
        issue: String(args.issue || ''),
        evidence: String(args.evidence || ''),
        desired_outcome: String(args.desired_outcome || ''),
      });
      if (output.confirmedJobId) {
        confirmFriction(session, String(args.issue || ''), String(args.evidence || ''), output.confirmedJobId);
      }
      return res.json({ status: 'success', output });
    } catch (error) {
      return res.status(400).json({ status: 'error', output: (error as Error).message });
    }
  }
  res.status(400).json({ status: 'error', output: 'Unknown interviewer tool.' });
});

if (isHosted()) {
  const dist = path.join(process.cwd(), 'dist');
  app.get('/shop', async (req, res) => {
    const id = typeof req.query.session === 'string' ? req.query.session : '';
    if (!id || !requireSessionOwner(req, res, id)) { if (!id) res.status(400).send('Open the store from your interview.'); return; }
    const session = getSession(id);
    if (!session) { res.status(404).send('Study not found.'); return; }
    const version = resolveStoreVersion(id);
    res.setHeader('Cache-Control', 'private, no-store');
    if (version) res.type('html').send(await readStoreVersionAsset(id, version, 'index.html'));
    else res.sendFile(path.join(dist, 'index.html'));
  });
  app.get('/store-versions/:session/:version/{*asset}', async (req, res) => {
    const id = String(req.params.session);
    if (!requireSessionOwner(req, res, id)) return;
    const parts = req.params.asset;
    const relative = Array.isArray(parts) ? parts.join('/') : String(parts);
    const body = await readStoreVersionAsset(id, String(req.params.version), relative);
    res.type(path.extname(relative)).setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.send(body);
  });
  app.use('/assets', express.static(path.join(dist, 'assets'), { immutable: true, maxAge: '1y' }));
  app.get(['/', '/report'], (req, res) => {
    if (req.path === '/report' && !requireSessionOwner(req, res, String(req.query.session || ''))) return;
    res.sendFile(path.join(dist, 'index.html'));
  });
}

app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ error: error.message || 'Unexpected server error.' });
});

recoverInterruptedClips();
// Tab-close notifications are best effort; lost clients expire even after a crash.
setInterval(() => {
  for (const session of getSessions()) {
    const lastSeen = interviewHeartbeats.get(session.id) ?? Math.max(presenceStartedAt, Date.parse(session.createdAt));
    if (session.storeLifecycle !== 'active' || Date.now() - lastSeen < 120000 || endingStudies.has(session.id)) continue;
    void endStudy(session).catch(() => console.error('Could not expire abandoned study', session.id));
  }
}, 15000).unref();

app.listen(port, process.env.API_HOST || '127.0.0.1', () => {
  console.log(`Loop local API listening on http://127.0.0.1:${port}`);
});
