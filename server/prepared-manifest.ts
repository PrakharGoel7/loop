import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const preparedIds = ['shortlist', 'size-guide'] as const;
export type PreparedId = typeof preparedIds[number];
export type PreparedVariant = PreparedId | 'shortlist+size-guide';

export type PreparedManifest = {
  version: 1;
  verifiedAt: string;
  buildInputHash: string;
  patchHashes: Record<PreparedId, string>;
  variants: Record<PreparedVariant, { storeHash: string; typecheckMs: number; buildMs: number }>;
};

export const buildInputs = [
  'src', 'shared', 'public', 'index.html', 'vite.config.ts',
  'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json',
  'package.json', 'pnpm-lock.yaml',
];

function hashPaths(root: string, entries: string[]) {
  const digest = crypto.createHash('sha256');
  const visit = (relative: string) => {
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(absolute).sort()) visit(path.join(relative, child));
      return;
    }
    if (!stat.isFile()) throw new Error(`Unsupported build input: ${relative}`);
    digest.update(relative.split(path.sep).join('/'));
    digest.update('\0');
    digest.update(fs.readFileSync(absolute));
    digest.update('\0');
  };
  for (const entry of entries) visit(entry);
  return digest.digest('hex');
}

export function buildInputHash(root: string) {
  return hashPaths(root, buildInputs);
}

export function storeHash(root: string) {
  return hashPaths(root, ['src/store']);
}

export function patchHash(root: string, id: PreparedId) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'prepared-repairs', `${id}.patch`))).digest('hex');
}

export function variantFor(ids: PreparedId[]): PreparedVariant {
  const unique = new Set(ids);
  if (unique.size === 2) return 'shortlist+size-guide';
  if (unique.has('shortlist')) return 'shortlist';
  if (unique.has('size-guide')) return 'size-guide';
  throw new Error('No prepared revision was selected.');
}

export function loadPreparedManifest(root: string): PreparedManifest {
  const file = path.join(root, 'prepared-repairs', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as PreparedManifest;
  if (manifest.version !== 1 || !manifest.variants?.shortlist || !manifest.variants?.['size-guide'] || !manifest.variants?.['shortlist+size-guide']) {
    throw new Error('The prepared-repair manifest is missing or invalid.');
  }
  return manifest;
}

export function assertPreparedManifestCurrent(root: string, manifest: PreparedManifest) {
  if (manifest.buildInputHash !== buildInputHash(root)) throw new Error('Prepared repairs need preverification after a site source change.');
  for (const id of preparedIds) {
    if (manifest.patchHashes[id] !== patchHash(root, id)) throw new Error(`Prepared ${id} patch changed after preverification.`);
  }
}
