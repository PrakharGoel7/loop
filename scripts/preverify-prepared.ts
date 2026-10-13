import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildInputHash, buildInputs, patchHash, preparedIds, storeHash, type PreparedManifest, type PreparedId, type PreparedVariant } from '../server/prepared-manifest.js';

const root = process.cwd();

function run(command: string, args: string[], cwd: string, timeoutMs = 180_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output = (output + chunk.toString()).slice(-3000); });
    child.stderr.on('data', (chunk: Buffer) => { output = (output + chunk.toString()).slice(-3000); });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Date.now() - started);
      else reject(new Error(`${path.basename(command)} ${args.join(' ')} ${timedOut ? `timed out after ${timeoutMs} ms` : `exited ${code}`}: ${output}`));
    });
  });
}

async function verifyVariant(ids: PreparedId[]) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-preverify-'));
  try {
    for (const entry of buildInputs) fs.cpSync(path.join(root, entry), path.join(sandbox, entry), { recursive: true });
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(sandbox, 'node_modules'), 'dir');
    for (const id of ids) {
      const patch = path.join(root, 'prepared-repairs', `${id}.patch`);
      await run('git', ['apply', '--check', patch], sandbox, 20_000);
      await run('git', ['apply', patch], sandbox, 20_000);
    }
    const typecheckMs = await run(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-b', '--force'], sandbox);
    const buildMs = await run(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build'], sandbox);
    return { storeHash: storeHash(sandbox), typecheckMs, buildMs };
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

async function main() {
  const manifest: PreparedManifest = {
    version: 1,
    verifiedAt: new Date().toISOString(),
    buildInputHash: buildInputHash(root),
    patchHashes: Object.fromEntries(preparedIds.map((id) => [id, patchHash(root, id)])) as PreparedManifest['patchHashes'],
    variants: {} as PreparedManifest['variants'],
  };
  const cases: [PreparedVariant, PreparedId[]][] = [
    ['shortlist', ['shortlist']],
    ['size-guide', ['size-guide']],
    ['shortlist+size-guide', ['shortlist', 'size-guide']],
  ];
  for (const [name, ids] of cases) {
    manifest.variants[name] = await verifyVariant(ids);
    process.stdout.write(`${name}: TypeScript ${manifest.variants[name].typecheckMs} ms, build ${manifest.variants[name].buildMs} ms\n`);
  }
  if (manifest.buildInputHash !== buildInputHash(root)) throw new Error('Site source changed during preverification. Retry after edits settle.');
  const file = path.join(root, 'prepared-repairs', 'manifest.json');
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(temporary, file);
  process.stdout.write(`Prepared revisions verified at ${manifest.verifiedAt}.\n`);
}

await main();
