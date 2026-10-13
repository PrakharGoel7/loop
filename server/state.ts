import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type StudyPhase = 'intro' | 'shopping' | 'first_attempt_done' | 'repairing' | 'retest' | 'done';

export type StudyEvent = {
  id: string;
  at: string;
  type: string;
  detail: Record<string, unknown>;
};

export type Repair = {
  status: 'idle' | 'queued' | 'planning' | 'running' | 'verifying' | 'ready' | 'failed';
  issue?: string;
  evidence?: string;
  hypothesis?: string;
  summary?: string;
  diff?: string;
  check?: string;
  error?: string;
  jobs?: RepairJob[];
  startedAt?: string;
  finishedAt?: string;
  publishedAt?: string;
  restoredAt?: string;
  hostedCandidateVersion?: string;
  hostedActiveVersion?: string;
  publishedSnapshot?: Record<string, string>;
  baselineSnapshot?: Record<string, string>;
  workerModel?: string;
  workerReasoningEffort?: string;
  cliMetrics?: {
    firstEventAt?: string;
    commandCount: number;
    commandExecutionMs: number;
    inputTokens?: number;
    outputTokens?: number;
  };
  timings?: {
    queueStartedAt?: string;
    workerStartedAt?: string;
    worktreeReadyAt?: string;
    patchStartedAt?: string;
    patchFinishedAt?: string;
    codingStartedAt?: string;
    codingFinishedAt?: string;
    verificationStartedAt?: string;
    verificationFinishedAt?: string;
    publicationStartedAt?: string;
    activationFinishedAt?: string;
    cleanupFinishedAt?: string;
  };
};

export type RepairJob = {
  id: string;
  issue: string;
  evidence: string;
  desiredOutcome: string;
  source?: 'prepared' | 'codex';
  preparedChangeId?: 'shortlist' | 'size-guide';
  matchQuality?: 'related' | 'forced';
  prequeued?: boolean;
  confirmedAt?: string;
  observedEventIds?: string[];
  shopperQuoteEventId?: string;
  shopperStatements?: { eventId: string; at: string; speech: string }[];
  retryQuoteEventIds?: string[];
  plan?: { title: string; change: string; acceptanceCriteria: string[] };
  timings?: Record<string, string>;
  status: 'queued' | 'planning' | 'running' | 'verifying' | 'verified' | 'failed';
  requestedAt: string;
  finishedAt?: string;
  summary?: string;
  check?: string;
  error?: string;
};

export type Recording = {
  status: 'off' | 'pending' | 'ready' | 'failed';
  requestedAt?: string;
  endedAt?: string;
  retrievalStartedAt?: string;
  readyAt?: string;
  error?: string;
  bucket?: string;
  objectKey?: string;
};

export type FrictionClip = {
  id: string;
  jobId?: string;
  observedAt: string;
  signal: string;
  evidence: string;
  status: 'observed' | 'confirmed' | 'uploading' | 'ready' | 'failed' | 'dismissed';
  confirmedAt?: string;
  issue?: string;
  readyAt?: string;
  error?: string;
  mimeType?: string;
};

export type StudySession = {
  id: string;
  createdAt: string;
  storeUrl: string;
  goal?: string;
  phase: StudyPhase;
  firstAttemptCompletedAt?: string;
  conversationId?: string;
  conversationUrl?: string;
  events: StudyEvent[];
  repair: Repair;
  recording?: Recording;
  clipsEnabled?: boolean;
  clips?: FrictionClip[];
  storeLifecycle?: 'active' | 'ended';
};

const dataDir = path.join(process.cwd(), 'data');
const sessionsFile = path.join(dataDir, 'sessions.json');
const configFile = path.join(dataDir, 'local-config.json');

type LocalConfig = { palId?: string; toolIds?: string[]; objectivesId?: string; objectivesHash?: string };

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(dataDir, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
}

const sessions = new Map<string, StudySession>(
  Object.entries(readJson<Record<string, StudySession>>(sessionsFile, {})),
);

let recoveredSessionState = false;
for (const session of sessions.values()) {
  if (!session.firstAttemptCompletedAt) {
    const completion = session.events.find((event) => event.type === 'phase_changed' && event.detail.phase === 'first_attempt_done');
    if (completion) {
      session.firstAttemptCompletedAt = completion.at;
      recoveredSessionState = true;
    }
  }
  if (!['queued', 'planning', 'running', 'verifying'].includes(session.repair.status)) continue;
  session.repair.status = 'failed';
  session.repair.error = 'The local server restarted while the code change was in progress. Retry the repair in a new study session.';
  session.repair.finishedAt = new Date().toISOString();
  for (const job of session.repair.jobs ?? []) {
    if (['queued', 'planning', 'running', 'verifying'].includes(job.status)) {
      job.status = 'failed';
      job.error = session.repair.error;
      job.finishedAt = session.repair.finishedAt;
    }
  }
  recoveredSessionState = true;
}
if (recoveredSessionState) writeJson(sessionsFile, Object.fromEntries(sessions));

let localConfig = readJson<LocalConfig>(configFile, {});

export function getLocalConfig() {
  return localConfig;
}

export function setLocalConfig(next: LocalConfig) {
  localConfig = next;
  writeJson(configFile, localConfig);
}

export function getSession(id: string) {
  return sessions.get(id);
}

export function getSessions() {
  return [...sessions.values()];
}

export function createSession(origin: string) {
  const id = crypto.randomUUID().slice(0, 12);
  const session: StudySession = {
    id,
    createdAt: new Date().toISOString(),
    storeUrl: `${origin.replace(/\/$/, '')}/shop?session=${id}`,
    phase: 'intro',
    events: [],
    repair: { status: 'idle' },
    recording: { status: 'off' },
    clipsEnabled: true,
    clips: [],
  };
  sessions.set(id, session);
  saveSession(session);
  return session;
}

export function saveSession(session: StudySession) {
  sessions.set(session.id, session);
  writeJson(sessionsFile, Object.fromEntries(sessions));
}

export function addEvent(session: StudySession, type: string, detail: Record<string, unknown> = {}) {
  const event: StudyEvent = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    type: type.slice(0, 80),
    detail,
  };
  session.events.push(event);
  saveSession(session);
  return event;
}
