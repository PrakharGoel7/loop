import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getLocalConfig, setLocalConfig, type StudySession } from './state.js';
import { interviewerPrompt } from './interviewer-prompt.js';
import { interviewObjectives } from './objectives.js';
import { getRecordingConfig } from './recordings.js';

const BASE = 'https://tavusapi.com/v2';
const DEFAULT_FACE = 'rc9cff32ceba';

// `auto` uses full expression/tone context for ordinary conversations and
// limits biometric-derived emotion when a conversation is created with policy=eu.
const perception = {
  perception_model: 'raven-1',
  emotion_recognition: 'auto',
  visual_awareness_queries: [
    'Describe the current shopping page and meaningful transitions throughout browsing, product selection, cart, and checkout. Ground descriptions in visible screen content; never infer an action not observed.',
    'Notice repeated switching between available options or controls anywhere in the journey. Describe the observed sequence without assuming the cause. The application measures five-second inactivity; do not infer elapsed time from a single frame.',
    'Look specifically for possible confusion, frustration, or irritation throughout the journey. Relevant facial expressions and visible behaviors may include a furrowed brow, puzzled expression, squinting, head tilting, scratching the head, head shaking, eye rolling, tightened lips, or a tense expression. Consider these cues alongside the current screen activity, especially repeated switching between options or pausing without taking action. Treat them as possible signals, not proof of an emotion. Prompt a timely, neutral question referring to the observed behavior and current task, then ask the shopper to clarify what they are thinking or feeling.',
  ],
  audio_awareness_queries: [
    'Notice statements of uncertainty, irritation, frustration, or difficulty throughout the journey. Preserve the shopper’s own words and distinguish them from a hypothesis based on tone or a sigh. Also notice their explanation of the cause and their suggested resolution.',
  ],
  visual_tool_prompt: 'Use the attached camera check-in vision tool only for a clear new visible cue from the participant camera, such as a head shake, scratching their head, a puzzled-looking expression change, or a sustained pause while choosing. Do not trigger it for ordinary blinking, a static expression, or store screen content. Report what is visible, never an inferred emotion.',
};

const conversationalFlow = {
  turn_detection_model: 'sparrow-2',
  turn_taking_patience: 'medium',
  pal_interruptibility: 'high',
  idle_engagement: 'patient',
};

const greeting = 'Hi, I’m Mira. What kind of clothing item are you looking for today?';

const savedHostedKey = process.env.LOOP_HOSTED === '1' && fs.existsSync(path.join(process.cwd(), 'data/hosted-tavus.json'))
  ? String(JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/hosted-tavus.json'), 'utf8')).apiKey || '') : '';
let apiKey = process.env.TAVUS_API_KEY || savedHostedKey;
let interviewerSynced = false;

class TavusRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function savedPalUnavailable(error: unknown): boolean {
  return error instanceof TavusRequestError && (
    error.status === 404
    || (error.status === 400 && /invalid\s+(?:pal|persona)[_\s-]*id/i.test(error.message))
  );
}

export function tavusReady() {
  return Boolean(apiKey && getLocalConfig().palId);
}

export function getPalId() {
  return getLocalConfig().palId;
}

async function tavusRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  if (!apiKey) throw new Error('Add a Tavus API key in local setup first.');
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'x-api-key': apiKey,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 204 || response.status === 304) return {} as T;
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const reason = typeof data.message === 'string' ? data.message : typeof data.error === 'string' ? data.error : `Tavus returned ${response.status}`;
    throw new TavusRequestError(reason, response.status);
  }
  return data as T;
}

type PalResponse = { pal_id: string };
type ToolResponse = { tool_id: string; name?: string };
type ConversationResponse = { conversation_id: string; conversation_url: string; status: string };
type ObjectivesResponse = { objectives_id: string };

type PatchOperation = { op: 'add'; path: string; value: unknown };

const repairToolDescription = 'Queue a live UI repair during the first journey ONLY after the shopper has explained a concrete friction point and answered how they would like it resolved. Include their actual suggestion and supporting words/actions. A background planner scopes a small targeted change; a coding worker starts immediately. At most two distinct changes are accepted in the entire session, including failures. Never invent a remedy, submit duplicates, or call after the first journey ends. No changes are prebuilt or automatically queued.';
const knowledgeBaseToolDescription = 'Consult the attached Tavus Knowledge Base CSV for the row with rank 1. Native Tavus retrieval supplies the concern. After the first journey and the overall-experience answer or decline, naturally ask once whether that concern affected the shopper. Do not call this legacy tool or repeat an answered question. Never invent participant counts or treat the concern as evidence this shopper experienced it.';
const cameraToolDescription = 'Trigger only for a clear new participant-camera cue such as a head shake, scratching the head, furrowed brow, or puzzled-looking expression change. Describe what is visible, never assert an emotion or intent. The application can ground a neutral question in the current shopping task throughout the journey. Do not trigger for ordinary blinking, a static face, repeated frames, or shared-screen content.';
const completionToolDescription = 'Mark the first shopping journey complete only after confirmed checkout or the shopper explicitly confirms they would stop. After completion is confirmed, ask overall experience once, hear and acknowledge the answer or decline, then ask the retrieved knowledge-base concern once. Continue relevant follow-ups while publication is pending; do not end the interview.';
const retestToolDescription = 'After the shopper reloads the published website, link their latest actual statement to the exact published job ID when they discuss that change or explicitly decline to try it. Never use a vague or unrelated statement. The server captures the exact utterance and reports remainingChanges. Acknowledge their response, then ask about any actual published change still missing feedback. There may be one or two arbitrary changes.';
const finishToolDescription = 'After feedback or explicit decline is recorded for every actual published change, thank the shopper and say goodbye, then call this tool to finish the study. If no change was requested or work failed, complete the overall-experience and knowledge-base exchanges and give a truthful closing explanation first. Never call merely because checkout or a Tavus objective completed. The application verifies readiness and may refuse with instructions.';
const repairToolParameters = {
  type: 'object',
  properties: {
    issue: { type: 'string', description: 'The concrete difficulty the shopper confirmed, in plain language.' },
    evidence: { type: 'string', description: 'The shopper’s actual words describing friction AND their suggested resolution, plus supporting observed actions.' },
    desired_outcome: { type: 'string', description: 'The shopper’s own stated suggestion in response to how they would like this resolved. Do not invent a solution.' },
  },
  required: ['issue', 'evidence', 'desired_outcome'],
};

function addConfigOperations(operations: PatchOperation[], path: string, current: unknown, next: Record<string, unknown>) {
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    operations.push({ op: 'add', path, value: next });
    return;
  }
  for (const [key, value] of Object.entries(next)) {
    operations.push({ op: 'add', path: `${path}/${key}`, value });
  }
}

async function ensureInterviewObjectives(): Promise<string> {
  const hash = crypto.createHash('sha256').update(JSON.stringify(interviewObjectives)).digest('hex');
  const config = getLocalConfig();
  if (config.objectivesId && config.objectivesHash === hash) {
    try {
      await tavusRequest(`/objectives/${encodeURIComponent(config.objectivesId)}`);
      return config.objectivesId;
    } catch (error) {
      // Recreate only when the saved set was deleted. Authentication, network,
      // and other API failures must stop setup rather than create duplicates.
      if (!(error instanceof TavusRequestError) || error.status !== 404) throw error;
    }
  }
  const created = await tavusRequest<ObjectivesResponse>('/objectives', 'POST', {
    data: interviewObjectives,
  });
  if (!created.objectives_id) throw new Error('Tavus did not return an objectives ID.');
  setLocalConfig({ ...getLocalConfig(), objectivesId: created.objectives_id, objectivesHash: hash });
  return created.objectives_id;
}

async function ensureCompletionTool(palId: string) {
  const toolIds = getLocalConfig().toolIds || [];
  if (toolIds.length >= 4) {
    // Attaching an already attached tool is idempotent, so this also repairs a
    // PAL whose completion tool was detached after local setup.
    await tavusRequest(`/pals/${palId}/tools`, 'POST', { tool_ids: [toolIds[3]] });
    return;
  }
  if (toolIds.length < 3) throw new Error('Configure the interviewer tools before updating the PAL.');
  const suffix = crypto.randomBytes(4).toString('hex');
  const completionTool = await tavusRequest<ToolResponse>('/tools', 'POST', {
    name: `loop_finish_first_attempt_${suffix}`,
    description: completionToolDescription,
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why the first attempt ended, based on the shopper’s words or confirmed checkout.' },
      },
      required: ['reason'],
    },
    origin: 'llm',
    on_call: 'silent',
    on_resolve: 'add_to_context',
    delivery: { app_message: true },
  });
  const nextToolIds = [...toolIds, completionTool.tool_id];
  await tavusRequest(`/pals/${palId}/tools`, 'POST', { tool_ids: [completionTool.tool_id] });
  setLocalConfig({ ...getLocalConfig(), palId, toolIds: nextToolIds });
}

async function ensureCameraCueTool(palId: string) {
  const toolIds = getLocalConfig().toolIds || [];
  if (toolIds.length >= 5) {
    await tavusRequest(`/pals/${palId}/tools`, 'POST', { tool_ids: [toolIds[4]] });
    return;
  }
  if (toolIds.length < 4) throw new Error('Configure the interviewer tools before adding camera cues.');
  const suffix = crypto.randomBytes(4).toString('hex');
  const cueTool = await tavusRequest<ToolResponse>('/tools', 'POST', {
    name: `loop_camera_check_in_${suffix}`,
    description: cameraToolDescription,
    parameters: {
      type: 'object',
      properties: {
        cue: { type: 'string', description: 'A short description of the visible participant-camera movement or expression change. Never name an emotion.' },
      },
      required: ['cue'],
    },
    origin: 'vision',
    delivery: { app_message: true },
  });
  await tavusRequest(`/pals/${palId}/tools`, 'POST', { tool_ids: [cueTool.tool_id] });
  setLocalConfig({ ...getLocalConfig(), palId, toolIds: [...toolIds, cueTool.tool_id] });
}

async function ensureKnowledgeBaseTool(palId: string) {
  const toolIds = getLocalConfig().toolIds || [];
  if (toolIds.length >= 6) {
    await tavusRequest(`/pals/${palId}/tools`, 'POST', { tool_ids: [toolIds[5]] });
    return;
  }
  if (toolIds.length < 5) throw new Error('Configure the interviewer tools before adding sample research lookup.');
  const suffix = crypto.randomBytes(4).toString('hex');
  const lookupTool = await tavusRequest<ToolResponse>('/tools', 'POST', {
    name: `loop_get_most_common_sample_issue_${suffix}`,
    description: knowledgeBaseToolDescription,
    parameters: { type: 'object', properties: {} },
    origin: 'llm',
    on_call: 'silent',
    on_resolve: 'add_to_context',
    delivery: { app_message: true },
  });
  await tavusRequest(`/pals/${palId}/tools`, 'POST', { tool_ids: [lookupTool.tool_id] });
  setLocalConfig({ ...getLocalConfig(), palId, toolIds: [...toolIds, lookupTool.tool_id] });
}

async function ensureRetestFeedbackTool(palId: string) {
  const toolIds = getLocalConfig().toolIds || [];
  if (toolIds.length >= 7) {
    await tavusRequest(`/pals/${palId}/tools`, 'POST', { tool_ids: [toolIds[6]] });
    return;
  }
  if (toolIds.length < 6) throw new Error('Configure the interviewer tools before adding retest feedback linking.');
  const suffix = crypto.randomBytes(4).toString('hex');
  const tool = await tavusRequest<ToolResponse>('/tools', 'POST', {
    name: `loop_record_retest_feedback_${suffix}`,
    description: retestToolDescription,
    parameters: {
      type: 'object',
      properties: { job_id: { type: 'string', description: 'The exact job ID of the published change the shopper just discussed.' } },
      required: ['job_id'],
    },
    origin: 'llm',
    on_call: 'silent',
    on_resolve: 'generate_response',
    delivery: { app_message: true },
  });
  await tavusRequest(`/pals/${palId}/tools`, 'POST', { tool_ids: [tool.tool_id] });
  setLocalConfig({ ...getLocalConfig(), palId, toolIds: [...toolIds, tool.tool_id] });
}

async function ensureFinishInterviewTool(palId: string) {
  const toolIds = getLocalConfig().toolIds || [];
  let toolId = toolIds[7];
  if (toolId) {
    await tavusRequest(`/tools/${encodeURIComponent(toolId)}`, 'PATCH', {
      description: finishToolDescription,
      on_call: 'silent',
      on_resolve: 'add_to_context',
    });
  } else {
    if (toolIds.length < 7) throw new Error('Configure the interviewer tools before adding interview completion.');
    const tool = await tavusRequest<ToolResponse>('/tools', 'POST', {
      name: `loop_finish_interview_${crypto.randomBytes(4).toString('hex')}`,
      description: finishToolDescription,
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string', description: 'Why the interview is ready to finish, including completion of per-change feedback or the no-change/failure outcome.' } },
        required: ['reason'],
      },
      origin: 'llm',
      on_call: 'silent',
      on_resolve: 'add_to_context',
      delivery: { app_message: true },
    });
    toolId = tool.tool_id;
    setLocalConfig({ ...getLocalConfig(), palId, toolIds: [...toolIds, toolId] });
  }
  await tavusRequest(`/pals/${palId}/tools`, 'POST', { tool_ids: [toolId] });
}

async function ensureLoopToolNames() {
  for (const toolId of getLocalConfig().toolIds || []) {
    const path = `/tools/${encodeURIComponent(toolId)}`;
    const tool = await tavusRequest<ToolResponse>(path);
    if (!tool.name?.startsWith('shoppatch_')) continue;
    await tavusRequest(path, 'PATCH', { name: `loop_${tool.name.slice('shoppatch_'.length)}` });
  }
}

export async function updateTavusInterviewer(): Promise<{ ready: true; palId: string }> {
  const palId = getLocalConfig().palId;
  if (!palId) throw new Error('Configure the Tavus interviewer first.');
  const repairToolId = getLocalConfig().toolIds?.[2];
  if (repairToolId) await tavusRequest(`/tools/${encodeURIComponent(repairToolId)}`, 'PATCH', {
    description: repairToolDescription,
    parameters: repairToolParameters,
    on_call: 'static_filler',
    on_resolve: 'add_to_context',
    static_filler: 'I see. Thanks for explaining that. Please keep going as you normally would.',
  });
  const knowledgeBaseToolId = getLocalConfig().toolIds?.[5];
  if (knowledgeBaseToolId) await tavusRequest(`/tools/${encodeURIComponent(knowledgeBaseToolId)}`, 'PATCH', {
    description: knowledgeBaseToolDescription,
    on_resolve: 'add_to_context',
  });
  const completionToolId = getLocalConfig().toolIds?.[3];
  if (completionToolId) await tavusRequest(`/tools/${encodeURIComponent(completionToolId)}`, 'PATCH', {
    description: completionToolDescription,
    on_resolve: 'add_to_context',
  });
  await ensureCompletionTool(palId);
  await ensureCameraCueTool(palId);
  const cameraToolId = getLocalConfig().toolIds?.[4];
  if (cameraToolId) await tavusRequest(`/tools/${encodeURIComponent(cameraToolId)}`, 'PATCH', {
    description: cameraToolDescription,
  });
  await ensureKnowledgeBaseTool(palId);
  await ensureRetestFeedbackTool(palId);
  await ensureFinishInterviewTool(palId);
  const retestToolId = getLocalConfig().toolIds?.[6];
  if (retestToolId) await tavusRequest(`/tools/${encodeURIComponent(retestToolId)}`, 'PATCH', {
    description: retestToolDescription,
    on_resolve: 'generate_response',
  });
  await ensureLoopToolNames();

  const current = await tavusRequest<Record<string, unknown>>(`/pals/${encodeURIComponent(palId)}`);
  const objectivesId = await ensureInterviewObjectives();
  const layers = current.layers && typeof current.layers === 'object' && !Array.isArray(current.layers)
    ? current.layers as Record<string, unknown>
    : null;
  const operations: PatchOperation[] = [
    { op: 'add', path: '/pal_name', value: 'Mira | Loop research interviewer' },
    { op: 'add', path: '/system_prompt', value: interviewerPrompt },
    { op: 'add', path: '/greeting', value: greeting },
    { op: 'add', path: '/disclosure_type', value: 'off' },
    { op: 'add', path: '/objectives_id', value: objectivesId },
  ];
  if (!layers) {
    operations.push({ op: 'add', path: '/layers', value: { perception, conversational_flow: conversationalFlow } });
  } else {
    addConfigOperations(operations, '/layers/perception', layers.perception, perception);
    addConfigOperations(operations, '/layers/conversational_flow', layers.conversational_flow, conversationalFlow);
  }
  await tavusRequest(`/pals/${encodeURIComponent(palId)}`, 'PATCH', operations);
  interviewerSynced = true;
  return { ready: true, palId };
}

export async function configureTavus(nextKey: string, faceId = DEFAULT_FACE) {
  const candidate = nextKey.trim();
  if (!candidate) throw new Error('Enter a Tavus API key.');
  const previousKey = apiKey;
  apiKey = candidate;
  interviewerSynced = false;
  try {

  const existing = getLocalConfig();
  let palId = existing.palId;
  if (palId) {
    try {
      await tavusRequest(`/pals/${palId}`);
    } catch (error) {
      if (!savedPalUnavailable(error)) throw error;
      palId = undefined;
    }
  }
  if (!palId) {
    const pal = await tavusRequest<PalResponse>('/pals', 'POST', {
      pal_name: 'Mira | Loop research interviewer',
      pipeline_mode: 'full',
      default_face_id: faceId,
      system_prompt: interviewerPrompt,
      greeting,
      disclosure_type: 'off',
      layers: {
        perception,
        conversational_flow: conversationalFlow,
      },
    });
    palId = pal.pal_id;
    setLocalConfig({ palId, toolIds: undefined, objectivesId: undefined, objectivesHash: undefined });
  }

  await tavusRequest(`/pals/${palId}/skills/magic_canvas`, 'PUT', {
    config: {
      usage_guidance: 'After the shopper states their clothing goal, show a text card with a Markdown link to the exact store URL in conversational context. Keep the link visible while they open the store and share their screen. Use a short question card only when an explicit choice would help; avoid charts or unrelated cards.',
      components: {
        calendar: { enabled: false },
        scheduling_embed: { enabled: false },
        chart: { enabled: false },
        image: { enabled: false },
        input: { enabled: false },
      },
    },
  });

  let toolIds = getLocalConfig().toolIds || [];
  if (toolIds.length < 3) {
    const suffix = crypto.randomBytes(4).toString('hex');
    const goalTool = await tavusRequest<ToolResponse>('/tools', 'POST', {
      name: `loop_record_goal_${suffix}`,
      description: 'Record what clothing item the shopper says they want and any purchase criteria. Call after the shopper states their goal. Do not infer a goal from clicks alone.',
      parameters: {
        type: 'object',
        properties: { goal: { type: 'string', description: 'The shopper’s stated clothing goal in one sentence.' } },
        required: ['goal'],
      },
      origin: 'llm',
      on_call: 'silent',
      on_resolve: 'add_to_context',
      delivery: { app_message: true },
    });
    const activityTool = await tavusRequest<ToolResponse>('/tools', 'POST', {
      name: `loop_get_store_activity_${suffix}`,
      description: 'Read the shopper’s exact recent search, browsing, option, cart, and checkout actions from the sample clothing store. Use when you need evidence for a neutral follow-up or a repair.',
      parameters: { type: 'object', properties: {} },
      origin: 'llm',
      on_call: 'silent',
      on_resolve: 'generate_response',
      delivery: { app_message: true },
    });
    const repairTool = await tavusRequest<ToolResponse>('/tools', 'POST', {
      name: `loop_start_store_repair_${suffix}`,
      description: repairToolDescription,
      parameters: repairToolParameters,
      origin: 'llm',
      on_call: 'static_filler',
      on_resolve: 'add_to_context',
      static_filler: 'I see. Thanks for explaining that. Please keep going as you normally would.',
      delivery: { app_message: true },
    });
    toolIds = [goalTool.tool_id, activityTool.tool_id, repairTool.tool_id];
    await tavusRequest(`/pals/${palId}/tools`, 'POST', { tool_ids: toolIds });
    setLocalConfig({ ...getLocalConfig(), palId, toolIds });
  }
  await updateTavusInterviewer();
  return { ready: true, palId };
  } catch (error) {
    apiKey = previousKey;
    throw error;
  }
}

type KnowledgeDocument = { document_id: string; status: string; error_message?: string };

// Upload only the ranked demo CSV. Tavus performs retrieval during conversations.
export async function ensureTavusKnowledge(): Promise<KnowledgeDocument> {
  const file = path.join(process.cwd(), 'data/tavus-knowledge.json');
  const csv = fs.readFileSync(path.join(process.cwd(), 'knowledge-base/past-user-issues.csv'));
  const hash = crypto.createHash('sha256').update(csv).digest('hex');
  const account = crypto.createHash('sha256').update(apiKey).digest('hex');
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  if (saved?.hash === hash && saved?.account === account) {
    return tavusRequest<KnowledgeDocument>(`/documents/${encodeURIComponent(saved.documentId)}`);
  }
  const origin = process.env.LOOP_PUBLIC_ORIGIN;
  if (!origin) throw new Error('Set LOOP_PUBLIC_ORIGIN to the hosted CSV source before configuring Tavus knowledge.');
  const created = await tavusRequest<KnowledgeDocument>('/documents', 'POST', {
    document_name: 'Loop past-user issues (synthetic demo dataset)',
    document_url: `${origin}/knowledge-base/past-user-issues.csv`,
    tags: ['loop-past-user-issues'],
  });
  if (!created.document_id) throw new Error('Tavus did not return a knowledge document ID.');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ documentId: created.document_id, hash, account }), { mode: 0o600 });
  return created;
}

export async function createTavusConversation(session: StudySession, testMode = false) {
  const palId = getLocalConfig().palId;
  if (!palId) throw new Error('Configure the Tavus interviewer first.');
  if (!interviewerSynced) await updateTavusInterviewer();
  const knowledge = process.env.LOOP_DISABLE_TAVUS_KNOWLEDGE === '1' ? null : await ensureTavusKnowledge();
  if (knowledge && knowledge.status !== 'ready') throw new Error(knowledge.status === 'error' ? `Tavus knowledge processing failed: ${knowledge.error_message || 'unknown error'}` : 'Tavus is processing the knowledge-base CSV. Please try again once processing finishes.');
  const recordingStorage = session.recording?.status === 'pending' ? getRecordingConfig() : null;
  if (session.recording?.status === 'pending' && !recordingStorage) throw new Error('Recording storage is not configured.');
  return tavusRequest<ConversationResponse>('/conversations', 'POST', {
    pal_id: palId,
    conversation_name: `Loop study ${session.id}`,
    // Use Tavus's default (quality). The speed strategy stalled voice turns in live diagnostics.
    ...(knowledge ? { document_ids: [knowledge.document_id] } : {}),
    conversational_context: `This study's store URL is ${session.storeUrl}. The shopper opens it in another window and shares that window. Session ID: ${session.id}. The store has tops, jeans, dresses, jackets, and sweaters. The shopper has not yet told you which item they want. Do not invent observed behavior.`,
    test_mode: testMode,
    properties: { ...(process.env.LOOP_HOSTED === '1' ? { max_call_duration: 900 } : {}), ...(recordingStorage ? { auto_start_recording: true, recording_storage: recordingStorage } : {}) },
  });
}

export async function endTavusConversation(conversationId: string) {
  return tavusRequest(`/conversations/${encodeURIComponent(conversationId)}/end`, 'POST');
}
