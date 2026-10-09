import 'dotenv/config';
import express from 'express';
import { addEvent, createSession, getSession, saveSession, type StudyPhase } from './state.js';
import { configureTavus, createTavusConversation, endTavusConversation, getPalId, tavusReady } from './tavus.js';
import { publishRepair, requestRepair } from './repair.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

const port = Number(process.env.API_PORT || 3001);
const validPhases = new Set<StudyPhase>(['intro', 'shopping', 'first_attempt_done', 'repairing', 'retest', 'done']);

function sessionFromRequest(req: express.Request, res: express.Response) {
  const session = getSession(String(req.params.id));
  if (!session) res.status(404).json({ error: 'Study session not found.' });
  return session;
}

app.get('/api/status', (_req, res) => {
  res.json({ ready: tavusReady(), palId: getPalId(), localOnly: true });
});

app.post('/api/setup', async (req, res) => {
  try {
    const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey : '';
    const faceId = typeof req.body?.faceId === 'string' && req.body.faceId.trim() ? req.body.faceId.trim() : undefined;
    res.json(await configureTavus(apiKey, faceId));
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

app.post('/api/sessions', (req, res) => {
  const origin = typeof req.get('origin') === 'string' ? req.get('origin')! : 'http://localhost:5173';
  const session = createSession(origin);
  res.status(201).json({ id: session.id, storeUrl: session.storeUrl, createdAt: session.createdAt });
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
    conversationId: session.conversationId,
    conversationUrl: session.conversationUrl,
  });
});

app.get('/api/sessions/:id/events', (req, res) => {
  const session = sessionFromRequest(req, res);
  if (!session) return;
  res.json(session.events);
});

app.post('/api/sessions/:id/events', (req, res) => {
  const session = sessionFromRequest(req, res);
  if (!session) return;
  const type = typeof req.body?.type === 'string' ? req.body.type : '';
  if (!type) return res.status(400).json({ error: 'Event type required.' });
  const detail = req.body?.detail && typeof req.body.detail === 'object' && !Array.isArray(req.body.detail) ? req.body.detail : {};
  const event = addEvent(session, type, detail);
  if (session.phase === 'intro' && type !== 'utterance' && type !== 'phase_changed') {
    session.phase = 'shopping';
    saveSession(session);
  }
  res.status(201).json(event);
});

app.post('/api/sessions/:id/phase', async (req, res) => {
  const session = sessionFromRequest(req, res);
  if (!session) return;
  const phase = req.body?.phase as StudyPhase;
  if (!validPhases.has(phase)) return res.status(400).json({ error: 'Unknown study phase.' });
  session.phase = phase;
  addEvent(session, 'phase_changed', { phase });
  if (phase === 'first_attempt_done') {
    try {
      await publishRepair(session);
    } catch (error) {
      session.repair.status = 'failed';
      session.repair.error = (error as Error).message;
      saveSession(session);
    }
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
    saveSession(session);
    res.json(conversation);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

app.post('/api/sessions/:id/conversation/end', async (req, res) => {
  const session = sessionFromRequest(req, res);
  if (!session) return;
  if (!session.conversationId) return res.status(400).json({ error: 'No live Tavus conversation.' });
  try {
    await endTavusConversation(session.conversationId);
    session.phase = 'done';
    addEvent(session, 'phase_changed', { phase: 'done' });
    res.json({ ended: true });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

app.get('/api/sessions/:id/repair', (req, res) => {
  const session = sessionFromRequest(req, res);
  if (!session) return;
  res.json(session.repair);
});

app.post('/api/sessions/:id/tool', (req, res) => {
  const session = sessionFromRequest(req, res);
  if (!session) return;
  const name = String(req.body?.name || '');
  let args: Record<string, unknown> = {};
  try {
    args = typeof req.body?.arguments === 'string' ? JSON.parse(req.body.arguments) : req.body?.arguments || {};
  } catch {
    return res.status(400).json({ status: 'error', output: 'Tool arguments were invalid JSON.' });
  }
  if (name.startsWith('shoppatch_get_store_activity_')) {
    const events = session.events
      .filter((event) => !['phase_changed', 'repair_requested', 'repair_verified', 'repair_published'].includes(event.type))
      .slice(-14)
      .map(({ at, type, detail }) => ({ at, type, detail: JSON.stringify(detail).slice(0, 180) }));
    return res.json({ status: 'success', output: { phase: session.phase, goal: session.goal, events } });
  }
  if (name.startsWith('shoppatch_record_goal_')) {
    const goal = String(args.goal || '').trim().slice(0, 500);
    if (!goal) return res.status(400).json({ status: 'error', output: 'A stated goal is required.' });
    session.goal = goal;
    addEvent(session, 'shopping_goal', { goal });
    return res.json({ status: 'success', output: 'Shopping goal recorded.' });
  }
  if (name.startsWith('shoppatch_start_store_repair_')) {
    try {
      const output = requestRepair(session, {
        issue: String(args.issue || ''),
        evidence: String(args.evidence || ''),
        desired_outcome: String(args.desired_outcome || ''),
      });
      return res.json({ status: 'success', output });
    } catch (error) {
      return res.status(400).json({ status: 'error', output: (error as Error).message });
    }
  }
  res.status(400).json({ status: 'error', output: 'Unknown interviewer tool.' });
});

app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ error: error.message || 'Unexpected server error.' });
});

app.listen(port, '127.0.0.1', () => {
  console.log(`ShopPatch local API listening on http://127.0.0.1:${port}`);
});
