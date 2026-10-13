import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { addEvent, saveSession, type StudySession } from './state.js';

const execFileAsync = promisify(execFile);
const recordingsDir = path.join(process.cwd(), 'data', 'recordings');
const activeDownloads = new Set<string>();
const RETRY_MS = 15_000;
const MAX_WAIT_MS = 30 * 60_000;
const KEY_TEMPLATE = 'loop/{conversation_id}.mp4';

type GcsConfig = {
  provider: 'gcs';
  bucket_name: string;
  project_id: string;
  workload_identity_provider: string;
  service_account_email: string;
  key_template: string;
};

export function getRecordingConfig(): GcsConfig | null {
  const projectId = (process.env.LOOP_GCS_PROJECT_ID || process.env.SHOPPATCH_GCS_PROJECT_ID)?.trim();
  const bucket = (process.env.LOOP_GCS_BUCKET || process.env.SHOPPATCH_GCS_BUCKET)?.trim();
  const provider = (process.env.LOOP_GCS_WORKLOAD_IDENTITY_PROVIDER || process.env.SHOPPATCH_GCS_WORKLOAD_IDENTITY_PROVIDER)?.trim();
  const serviceAccount = (process.env.LOOP_GCS_SERVICE_ACCOUNT_EMAIL || process.env.SHOPPATCH_GCS_SERVICE_ACCOUNT_EMAIL)?.trim();
  if (!projectId || !bucket || !provider || !serviceAccount) return null;
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId)) throw new Error('Invalid GCS project ID.');
  if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket)) throw new Error('Invalid GCS bucket name.');
  if (!/^projects\/\d+\/locations\/global\/workloadIdentityPools\/[a-z0-9-]+\/providers\/[a-z0-9-]+$/.test(provider)) throw new Error('Invalid GCS Workload Identity Provider.');
  if (!/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(serviceAccount)) throw new Error('Invalid GCS service account email.');
  return {
    provider: 'gcs',
    bucket_name: bucket,
    project_id: projectId,
    workload_identity_provider: provider,
    service_account_email: serviceAccount,
    key_template: KEY_TEMPLATE,
  };
}

export function recordingFile(session: StudySession) {
  return path.join(recordingsDir, `${session.id}.mp4`);
}

export function requestSessionRecording(session: StudySession) {
  const config = getRecordingConfig();
  if (!config) throw new Error('Recording storage is not configured. Add the GCS settings to the local server before starting a recorded interview.');
  session.recording = {
    status: 'pending',
    requestedAt: new Date().toISOString(),
    bucket: config.bucket_name,
  };
  saveSession(session);
  return config;
}

export function attachRecordingDestination(session: StudySession) {
  if (session.recording?.status !== 'pending' || !session.conversationId) return;
  if (!/^[a-zA-Z0-9_-]+$/.test(session.conversationId)) throw new Error('Tavus returned an invalid conversation ID.');
  session.recording.objectKey = KEY_TEMPLATE.replace('{conversation_id}', session.conversationId);
  saveSession(session);
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function missingObject(message: string) {
  return /matched no objects|not found|No URLs matched|404|does not exist/i.test(message);
}

async function copyFromGcs(session: StudySession) {
  const recording = session.recording;
  if (!recording?.bucket || !recording.objectKey) throw new Error('The recorded conversation has no GCS destination.');
  const source = `gs://${recording.bucket}/${recording.objectKey}`;
  const destination = recordingFile(session);
  const temporary = `${destination}.${process.pid}.partial`;
  fs.mkdirSync(recordingsDir, { recursive: true });
  try {
    await execFileAsync('gcloud', ['--quiet', 'storage', 'cp', source, temporary], {
      timeout: 5 * 60_000,
      maxBuffer: 1024 * 1024,
    });
    if (fs.statSync(temporary).size === 0) throw new Error('GCS returned an empty recording.');
    fs.renameSync(temporary, destination);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

export function ensureRecordingRetrieval(session: StudySession) {
  const recording = session.recording;
  if (!recording || recording.status !== 'pending' || !recording.endedAt || !recording.objectKey || activeDownloads.has(session.id)) return;
  activeDownloads.add(session.id);
  void (async () => {
    const deadline = Date.parse(recording.retrievalStartedAt || recording.endedAt!) + MAX_WAIT_MS;
    try {
      while (Date.now() < deadline) {
        if (fs.existsSync(recordingFile(session))) {
          recording.status = 'ready';
          recording.readyAt ||= new Date().toISOString();
          saveSession(session);
          return;
        }
        try {
          await copyFromGcs(session);
          recording.status = 'ready';
          recording.readyAt = new Date().toISOString();
          recording.error = undefined;
          addEvent(session, 'recording_ready', { at: recording.readyAt });
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
          const detail = `${message} ${stderr}`;
          if (!missingObject(detail)) throw new Error(`Could not retrieve the recording from GCS: ${detail.slice(0, 500)}`);
        }
        await wait(RETRY_MS);
      }
      throw new Error('The recording has not appeared in GCS after 30 minutes. Check Tavus recording delivery and the GCS writer permissions.');
    } catch (error) {
      recording.status = 'failed';
      recording.error = (error as Error).message.slice(0, 700);
      addEvent(session, 'recording_failed', { error: recording.error });
    } finally {
      activeDownloads.delete(session.id);
    }
  })();
}

export function finishSessionRecording(session: StudySession) {
  if (session.recording?.status !== 'pending') return;
  session.recording.endedAt ||= new Date().toISOString();
  session.recording.retrievalStartedAt ||= new Date().toISOString();
  saveSession(session);
  ensureRecordingRetrieval(session);
}

export function retrySessionRecording(session: StudySession) {
  if (!session.recording?.objectKey || !session.recording.endedAt) throw new Error('This session has no completed recording to check.');
  if (session.recording.status !== 'failed') throw new Error('Recording retrieval is not in a failed state.');
  session.recording.status = 'pending';
  session.recording.error = undefined;
  session.recording.retrievalStartedAt = new Date().toISOString();
  saveSession(session);
  ensureRecordingRetrieval(session);
}
