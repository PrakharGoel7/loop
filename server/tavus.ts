import crypto from 'node:crypto';
import { getLocalConfig, setLocalConfig, type StudySession } from './state.js';
import { interviewerPrompt } from './interviewer-prompt.js';

const BASE = 'https://tavusapi.com/v2';
const DEFAULT_FACE = 'rc9cff32ceba';

let apiKey = process.env.TAVUS_API_KEY || '';

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
  if (response.status === 204) return {} as T;
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const reason = typeof data.message === 'string' ? data.message : typeof data.error === 'string' ? data.error : `Tavus returned ${response.status}`;
    throw new Error(reason);
  }
  return data as T;
}

type PalResponse = { pal_id: string };
type ToolResponse = { tool_id: string };
type ConversationResponse = { conversation_id: string; conversation_url: string; status: string };

export async function configureTavus(nextKey: string, faceId = DEFAULT_FACE) {
  const candidate = nextKey.trim();
  if (!candidate) throw new Error('Enter a Tavus API key.');
  apiKey = candidate;

  const existing = getLocalConfig();
  let palId = existing.palId;
  if (palId) {
    try {
      await tavusRequest(`/pals/${palId}`);
    } catch {
      palId = undefined;
    }
  }
  if (!palId) {
    const pal = await tavusRequest<PalResponse>('/pals', 'POST', {
      pal_name: 'Mira | ShopPatch research interviewer',
      pipeline_mode: 'full',
      default_face_id: faceId,
      system_prompt: interviewerPrompt,
      greeting: 'Hi, I’m Mira. I’d like to watch how you shop for clothing today. What kind of item are you looking for?',
      disclosure_type: 'always',
      verbal_disclosure: 'I’m an AI interviewer.',
      layers: {
        perception: {
          perception_model: 'raven-1',
          emotion_recognition: 'limited',
          visual_awareness_queries: [
            'What part of the shared clothing store is visible, and is there a visible error or blocker?',
            'Is the shopper comparing products or revisiting an earlier choice on the shared screen?',
          ],
        },
      },
    });
    palId = pal.pal_id;
    setLocalConfig({ palId });
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
      name: `shoppatch_record_goal_${suffix}`,
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
      name: `shoppatch_get_store_activity_${suffix}`,
      description: 'Read the shopper’s exact recent search, browsing, size, cart, and checkout actions from the sample clothing store. Use when you need evidence for a neutral follow-up or a repair.',
      parameters: { type: 'object', properties: {} },
      origin: 'llm',
      on_call: 'silent',
      on_resolve: 'generate_response',
      delivery: { app_message: true },
    });
    const repairTool = await tavusRequest<ToolResponse>('/tools', 'POST', {
      name: `shoppatch_start_store_repair_${suffix}`,
      description: 'Start an actual source-code repair of the clothing store after shopper friction has been observed and discussed. This is asynchronous. Describe the problem and desired outcome; do not prescribe a hardcoded patch.',
      parameters: {
        type: 'object',
        properties: {
          issue: { type: 'string', description: 'The shopper problem, in plain language. May include multiple related frictions.' },
          evidence: { type: 'string', description: 'What the shopper said and did that supports the issue.' },
          desired_outcome: { type: 'string', description: 'What the shopper needs to be able to understand or do after the change.' },
        },
        required: ['issue', 'evidence', 'desired_outcome'],
      },
      origin: 'llm',
      on_call: 'static_filler',
      static_filler: 'I have enough to try an improvement. I’ll keep talking with you while it’s being built.',
      on_resolve: 'generate_response',
      delivery: { app_message: true },
    });
    toolIds = [goalTool.tool_id, activityTool.tool_id, repairTool.tool_id];
    await tavusRequest(`/pals/${palId}/tools`, 'POST', { tool_ids: toolIds });
    setLocalConfig({ palId, toolIds });
  }
  return { ready: true, palId };
}

export async function createTavusConversation(session: StudySession, testMode = false) {
  const palId = getLocalConfig().palId;
  if (!palId) throw new Error('Configure the Tavus interviewer first.');
  return tavusRequest<ConversationResponse>('/conversations', 'POST', {
    pal_id: palId,
    conversation_name: `ShopPatch study ${session.id}`,
    conversational_context: `This study's store URL is ${session.storeUrl}. The shopper opens it in another window and shares that window. Session ID: ${session.id}. The store has tops, jeans, dresses, jackets, and sweaters. The shopper has not yet told you which item they want. Do not invent observed behavior.`,
    test_mode: testMode,
  });
}

export async function endTavusConversation(conversationId: string) {
  return tavusRequest(`/conversations/${encodeURIComponent(conversationId)}/end`, 'POST');
}
