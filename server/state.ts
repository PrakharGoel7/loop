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
  status: 'idle' | 'queued' | 'running' | 'verifying' | 'ready' | 'failed';
  issue?: string;
  evidence?: string;
  hypothesis?: string;
  summary?: string;
  diff?: string;
  check?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  publishedAt?: string;
};

export type StudySession = {
  id: string;
  createdAt: string;
  storeUrl: string;
  goal?: string;
  phase: StudyPhase;
  conversationId?: string;
  conversationUrl?: string;
  events: StudyEvent[];
  repair: Repair;
};

const dataDir = path.join(process.cwd(), 'data');
const sessionsFile = path.join(dataDir, 'sessions.json');
const configFile = path.join(dataDir, 'local-config.json');

type LocalConfig = { palId?: string; toolIds?: string[] };

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

export function createSession(origin: string) {
  const id = crypto.randomUUID().slice(0, 12);
  const session: StudySession = {
    id,
    createdAt: new Date().toISOString(),
    storeUrl: `${origin.replace(/\/$/, '')}/shop?session=${id}`,
    phase: 'intro',
    events: [],
    repair: { status: 'idle' },
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
