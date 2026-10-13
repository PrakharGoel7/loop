/** Real planner + coder smoke test; never modifies the demo store or its studies. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const appRoot = process.cwd();
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-live-smoke-'));
for (const entry of ['src', 'shared', 'public', 'index.html', 'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json']) {
  if (fs.existsSync(path.join(appRoot, entry))) fs.cpSync(path.join(appRoot, entry), path.join(fixture, entry), { recursive: true });
}
fs.symlinkSync(path.join(appRoot, 'node_modules'), path.join(fixture, 'node_modules'));
process.chdir(fixture);
const { beginStoreSession, requestRepair, finishStoreSession } = await import('../server/repair.js');
const { addEvent } = await import('../server/state.js');
const study = await beginStoreSession('http://localhost');
console.log(`Disposable test: ${fixture}`);
addEvent(study, 'utterance', { role: 'user', speech: 'When a search finds nothing, I have to erase the text manually. I would like a clear-search button next to the search field.' });
requestRepair(study, { issue: 'Clearing a search takes manual deletion', evidence: 'Shopper requested a clear-search control', desired_outcome: 'Add a clear-search button beside the search input that clears the query and displays all products in the current category.' });
// Exercise worker-finished-last publication: checkout happened while the worker runs.
study.firstAttemptCompletedAt = new Date().toISOString();
study.phase = 'first_attempt_done';
const started = Date.now();
let previous = '';
while (Date.now() - started < 600_000) {
  const status = `${study.repair.status}:${Boolean(study.repair.publishedAt)}`;
  if (status !== previous) { console.log(`${Math.round((Date.now() - started) / 1000)}s ${status}`); previous = status; }
  if (study.repair.status === 'failed' || study.repair.publishedAt) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
console.log(JSON.stringify({ status: study.repair.status, publishedAt: study.repair.publishedAt, jobs: study.repair.jobs }, null, 2));
assert.equal(study.repair.status, 'ready');
assert.ok(study.repair.publishedAt);
await finishStoreSession(study);
assert.ok(study.repair.restoredAt);
console.log('PASS: real plan, code, build, automatic publication after checkout, restoration.');
process.chdir(appRoot);
// Retain the disposable study's worker logs and patch for review; no media or secrets are copied.
