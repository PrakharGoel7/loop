import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Storage } from '@google-cloud/storage';

export const hostedStoreEnabled = () => process.env.LOOP_HOSTED === '1';
const dataRoot = () => path.join(process.cwd(), 'data', 'store-versions');
const validId = (value: string) => { if (!/^[a-zA-Z0-9-]+$/.test(value)) throw new Error('Invalid store version identifier.'); return value; };
export const versionAssetBase = (sessionId: string, version: string) => `/store-versions/${validId(sessionId)}/${validId(version)}/`;
const versionRoot = (sessionId: string, version: string) => path.join(dataRoot(), validId(sessionId), validId(version));
const storage = () => { const bucket = process.env.LOOP_STORE_BUCKET; if (!bucket) throw new Error('LOOP_STORE_BUCKET is required for hosted publication.'); return new Storage().bucket(bucket); };

// Validate the exact build, rejecting links and broken script/style references before upload.
export function inspectStoreBuild(root: string) {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join('/'));
      else throw new Error('Store artifacts must contain only regular files.');
    }
  };
  visit(root);
  if (!files.includes('index.html')) throw new Error('Store build has no index.html.');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map((match) => match[1]).filter((value) => /\.(?:js|css)(?:\?|$)/.test(value));
  if (!refs.some((value) => /\.js(?:\?|$)/.test(value))) throw new Error('Store build has no script entry.');
  for (const ref of refs) {
    const relative = ref.replace(/^\/store-versions\/[^/]+\/[^/]+\//, '').replace(/^\//, '').split('?')[0];
    if (!files.includes(relative)) throw new Error(`Store build references missing artifact: ${relative}`);
  }
  return files;
}

export async function stageStoreVersion(sessionId: string, version: string, distRoot: string) {
  const files = inspectStoreBuild(distRoot);
  const root = versionRoot(sessionId, version);
  fs.mkdirSync(path.dirname(root), { recursive: true });
  fs.cpSync(distRoot, root, { recursive: true });
  const bucket = storage();
  const prefix = `studies/${validId(sessionId)}/versions/${validId(version)}/`;
  // Bounded upload concurrency keeps publication from consuming worker resources.
  for (let start = 0; start < files.length; start += 8) {
    await Promise.all(files.slice(start, start + 8).map((file) => bucket.upload(path.join(root, file), { destination: prefix + file, resumable: false, metadata: { cacheControl: 'private, max-age=31536000, immutable' } })));
  }
  const [uploaded] = await bucket.file(prefix + 'index.html').download();
  const local = fs.readFileSync(path.join(root, 'index.html'));
  if (!crypto.timingSafeEqual(crypto.createHash('sha256').update(uploaded).digest(), crypto.createHash('sha256').update(local).digest())) throw new Error('Uploaded store entry failed integrity verification.');
  fs.writeFileSync(path.join(root, '.ready'), new Date().toISOString());
  return version;
}

export function activateStoreVersion(sessionId: string, version: string) {
  const root = versionRoot(sessionId, version);
  if (!fs.existsSync(path.join(root, '.ready'))) throw new Error('Store version has not finished upload and load verification.');
  const pointer = path.join(dataRoot(), validId(sessionId), 'active.json');
  const previous = resolveStoreVersion(sessionId);
  const temporary = pointer + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify({ version: validId(version), previous, activatedAt: new Date().toISOString() }));
  fs.renameSync(temporary, pointer);
}

export function resolveStoreVersion(sessionId: string): string | undefined {
  const pointer = path.join(dataRoot(), validId(sessionId), 'active.json');
  if (!fs.existsSync(pointer)) return undefined;
  return validId(JSON.parse(fs.readFileSync(pointer, 'utf8')).version);
}
export function resetStoreVersion(sessionId: string) { fs.rmSync(path.join(dataRoot(), validId(sessionId), 'active.json'), { force: true }); }

export async function readStoreVersionAsset(sessionId: string, version: string, relative: string): Promise<Buffer> {
  if (!relative || relative.startsWith('/') || relative.split(/[\\/]/).some((part) => part === '..' || part.startsWith('.'))) throw new Error('Invalid store asset path.');
  const root = versionRoot(sessionId, version);
  const local = path.join(root, relative);
  if (fs.existsSync(local) && fs.statSync(local).isFile()) return fs.readFileSync(local);
  const [data] = await storage().file(`studies/${validId(sessionId)}/versions/${validId(version)}/${relative}`).download();
  return data;
}
