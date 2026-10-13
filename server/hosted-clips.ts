import { Storage } from '@google-cloud/storage';
import fs from 'node:fs';
import path from 'node:path';
const objectName = (sessionId: string, clipId: string) => `clips/${sessionId}/${clipId}.mp4`;
export async function uploadHostedClip(sessionId: string, clipId: string, file: string) {
  const bucket = process.env.LOOP_CLIPS_BUCKET;
  if (process.env.LOOP_HOSTED !== '1' || !bucket) return;
  await new Storage().bucket(bucket).upload(file, { destination: objectName(sessionId, clipId), resumable: false, metadata: { contentType: 'video/mp4', cacheControl: 'private, no-store' } });
}
export async function ensureHostedClip(sessionId: string, clipId: string, file: string) {
  const bucket = process.env.LOOP_CLIPS_BUCKET;
  if (fs.existsSync(file) || process.env.LOOP_HOSTED !== '1' || !bucket) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await new Storage().bucket(bucket).file(objectName(sessionId, clipId)).download({ destination: file });
}
