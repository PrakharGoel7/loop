import { uploadHostedClip } from './hosted-clips.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { addEvent, getSessions, saveSession, type FrictionClip, type StudySession } from './state.js';

const clipsDir = path.join(process.cwd(), 'data', 'clips');
const uploads = new Map<string, { directory: string; count: number; bytes: number; mimeType: string }>();

export function recoverInterruptedClips() {
  for (const session of getSessions()) {
    let changed = false;
    for (const clip of session.clips ?? []) {
      if (clip.status !== 'uploading') continue;
      if (fs.existsSync(clipFile(session, clip))) {
        clip.status = 'ready';
        clip.readyAt ||= new Date().toISOString();
      } else {
        clip.status = 'failed';
        clip.error = 'The local server restarted during clip preparation. The interview notes are still available.';
      }
      changed = true;
    }
    if (changed) saveSession(session);
  }
}

export function clipFile(session: StudySession, clip: FrictionClip) {
  return path.join(clipsDir, `${session.id}-${clip.id}.mp4`);
}

export function observeFriction(session: StudySession, signal: string, evidence: string) {
  if (!session.clipsEnabled || session.phase === 'done') throw new Error('Friction clips are not enabled for this live session.');
  const clips = session.clips ?? (session.clips = []);
  const recent = clips.findLast((clip) => clip.status === 'observed' && Date.now() - Date.parse(clip.observedAt) < 45_000);
  if (recent) return recent;
  if (clips.length >= 8) throw new Error('This study has reached its clip limit.');
  const clip: FrictionClip = {
    id: crypto.randomUUID(),
    observedAt: new Date().toISOString(),
    signal: signal.slice(0, 80),
    evidence: evidence.slice(0, 500),
    status: 'observed',
  };
  clips.push(clip);
  addEvent(session, 'friction_signal_observed', { clipId: clip.id, signal: clip.signal, evidence: clip.evidence });
  return clip;
}

export function confirmFriction(session: StudySession, issue: string, evidence: string, jobId?: string) {
  if (!session.clipsEnabled) return;
  const clips = session.clips ?? (session.clips = []);
  const clip = clips.findLast((item) => item.status === 'observed' && Date.now() - Date.parse(item.observedAt) < 45_000)
    ?? observeFriction(session, 'Interview follow-up', evidence);
  clip.status = 'confirmed';
  clip.confirmedAt = new Date().toISOString();
  clip.issue = issue.slice(0, 500);
  clip.jobId = jobId;
  saveSession(session);
  addEvent(session, 'friction_confirmed', { clipId: clip.id, jobId, issue: clip.issue, evidence: evidence.slice(0, 500) });
  return clip;
}

export function dismissUnconfirmed(session: StudySession) {
  let changed = false;
  for (const clip of session.clips ?? []) {
    if (clip.status === 'observed' && Date.now() - Date.parse(clip.observedAt) > 90_000) {
      clip.status = 'dismissed';
      changed = true;
    }
  }
  if (changed) saveSession(session);
}

function findClip(session: StudySession, id: string) {
  const clip = session.clips?.find((item) => item.id === id);
  if (!clip) throw new Error('Friction moment not found.');
  return clip;
}

export function uploadClipSegment(session: StudySession, id: string, index: number, data: Buffer, mimeType: string) {
  const clip = findClip(session, id);
  if (!session.clipsEnabled || !['confirmed', 'uploading'].includes(clip.status)) throw new Error('This moment has not been confirmed for saving.');
  if (!Number.isInteger(index) || index < 0 || index > 29 || !data.length || data.length > 8_000_000) throw new Error('Invalid clip segment.');
  if (!['video/webm', 'video/mp4'].includes(mimeType)) throw new Error('Unsupported recording format.');
  const key = `${session.id}:${id}`;
  let upload = uploads.get(key);
  if (!upload) {
    upload = { directory: fs.mkdtempSync(path.join(os.tmpdir(), 'loop-clip-')), count: 0, bytes: 0, mimeType };
    uploads.set(key, upload);
  }
  if (index !== upload.count || mimeType !== upload.mimeType || upload.bytes + data.length > 50_000_000) throw new Error('Clip segments are out of sequence or exceed the size limit.');
  fs.writeFileSync(path.join(upload.directory, `${String(index).padStart(3, '0')}.${mimeType === 'video/mp4' ? 'mp4' : 'webm'}`), data);
  upload.count += 1;
  upload.bytes += data.length;
  clip.status = 'uploading';
  saveSession(session);
  return upload.count;
}

async function ffmpeg(args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (part: Buffer) => { stderr = `${stderr}${part.toString()}`.slice(-3000); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Could not prepare the clip: ${stderr.slice(-500)}`)));
  });
}

export async function finishClipUpload(session: StudySession, id: string) {
  const clip = findClip(session, id);
  const key = `${session.id}:${id}`;
  const upload = uploads.get(key);
  if (!upload || upload.count < 1 || clip.status !== 'uploading') throw new Error('No complete clip upload is available.');
  const extension = upload.mimeType === 'video/mp4' ? 'mp4' : 'webm';
  const files = Array.from({ length: upload.count }, (_, index) => path.join(upload.directory, `${String(index).padStart(3, '0')}.${extension}`));
  const list = path.join(upload.directory, 'segments.txt');
  fs.writeFileSync(list, files.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join('\n'));
  fs.mkdirSync(clipsDir, { recursive: true });
  const temporary = `${clipFile(session, clip)}.tmp.mp4`;
  try {
    await ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '29', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', temporary]);
    if (!fs.existsSync(temporary) || fs.statSync(temporary).size < 1000) throw new Error('The clip encoder returned an empty video.');
    fs.renameSync(temporary, clipFile(session, clip));
    await uploadHostedClip(session.id, clip.id, clipFile(session, clip));
    clip.status = 'ready';
    clip.readyAt = new Date().toISOString();
    clip.mimeType = 'video/mp4';
    clip.error = undefined;
    addEvent(session, 'friction_clip_ready', { clipId: id, at: clip.readyAt });
    return clip;
  } catch (error) {
    clip.status = 'failed';
    clip.error = (error as Error).message.slice(0, 500);
    addEvent(session, 'friction_clip_failed', { clipId: id, error: clip.error });
    throw error;
  } finally {
    uploads.delete(key);
    fs.rmSync(upload.directory, { recursive: true, force: true });
    fs.rmSync(temporary, { force: true });
  }
}

export function markClipFailure(session: StudySession, id: string, reason: string) {
  const clip = findClip(session, id);
  if (clip.status === 'ready') return;
  clip.status = 'failed';
  clip.error = reason.slice(0, 500);
  addEvent(session, 'friction_clip_failed', { clipId: id, error: clip.error });
}
