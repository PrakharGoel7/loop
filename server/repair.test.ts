import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StudySession, RepairJob } from './state.js';

// State and repair modules resolve storage from cwd: keep tests wholly separate from live studies.
const appRoot = process.cwd();
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-queue-test-'));
process.chdir(fixture);
const { commandFailureDetail, repairAdmission, canPublishRepair, beginStoreSession, requestRepair, autoPublishRepair, finishStoreSession } = await import('./repair.js');
const { addEvent } = await import('./state.js');

function session(jobs: Partial<RepairJob>[] = []): StudySession {
  return { id: 'test', createdAt: new Date().toISOString(), storeUrl: '', phase: 'shopping', storeLifecycle: 'active', events: [], repair: { status: 'ready', diff: 'patch', jobs: jobs as RepairJob[] } };
}
test('structured worker failures retain the actual error', () => {
  assert.equal(commandFailureDetail(JSON.stringify({ type: 'turn.failed', error: { message: 'rate limit exceeded' } }), 'startup warning'), 'rate limit exceeded');
});
test('two lifetime slots include failed changes and deduplicate suggestions', () => {
  const s = session([{ issue: 'Search is hard', desiredOutcome: 'Clear search', status: 'failed' }]);
  assert.match(repairAdmission(s, { issue: 'search is hard!', desired_outcome: 'Reset term' })!, /already/);
  assert.equal(repairAdmission(s, { issue: 'Different issue', desired_outcome: 'A different change' }), undefined);
  s.repair.jobs!.push({ issue: 'second', desiredOutcome: 'two', status: 'queued' } as RepairJob);
  assert.match(repairAdmission(s, { issue: 'third', desired_outcome: 'three' })!, /two-change/);
  s.firstAttemptCompletedAt = new Date().toISOString();
  assert.match(repairAdmission(s, { issue: 'third', desired_outcome: 'three' })!, /closed/);
});
test('publication requires journey completion and every job verified, in either order', () => {
  const s = session([{ status: 'verified' }]);
  assert.equal(canPublishRepair(s, false), false);
  s.firstAttemptCompletedAt = new Date().toISOString();
  assert.equal(canPublishRepair(s, false), true);
  assert.equal(canPublishRepair(s, true), false);
  s.repair.jobs!.push({ status: 'queued' } as RepairJob);
  assert.equal(canPublishRepair(s, false), false);
  s.repair.jobs![1].status = 'failed';
  assert.equal(canPublishRepair(s, false), false);
  s.repair.jobs![1].status = 'verified';
  assert.equal(canPublishRepair(s, false), true);
  s.storeLifecycle = 'ended';
  assert.equal(canPublishRepair(s, false), false);
});

test('live queue plans, edits, builds, publishes only after checkout, and restores an uncommitted baseline', { timeout: 40_000 }, async () => {
  fs.mkdirSync(path.join(fixture, 'src/store'), { recursive: true });
  const original = 'export const greeting: string = "original local baseline";\n';
  fs.writeFileSync(path.join(fixture, 'src/store/example.ts'), original);
  fs.writeFileSync(path.join(fixture, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(fixture, 'index.html'), '<div>test</div><script type="module" src="/src/store/example.ts"></script>');
  fs.writeFileSync(path.join(fixture, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noEmit: true, skipLibCheck: true, types: [], target: 'es2023' }, include: ['src'] }));
  fs.symlinkSync(path.join(appRoot, 'node_modules'), path.join(fixture, 'node_modules'));
  const executable = path.join(fixture, 'fake-codex.cjs');
  fs.writeFileSync(executable, `#!${process.execPath}\nconst fs=require('fs');const path=require('path');const args=process.argv;const output=args[args.indexOf('-o')+1];process.stdin.resume();process.stdin.on('end',()=>{if(output.includes('planning'))fs.writeFileSync(output,JSON.stringify({title:'A useful small change',change:'Add a typed value',acceptanceCriteria:['A new value exists']}));else {fs.appendFileSync('src/store/example.ts','export const change'+Date.now()+' = true;\\n');fs.writeFileSync(output,'Added a small UI improvement.');}});\n`, { mode: 0o755 });
  process.env.LOOP_CODEX_BIN = executable;
  const s = await beginStoreSession('http://localhost');
  assert.equal(s.repair.jobs?.length ?? 0, 0, 'No fixes are prequeued');
  addEvent(s, 'utterance', { role: 'user', speech: 'I would like a clearer button.' });
  requestRepair(s, { issue: 'Button unclear', evidence: 'Shopper said button unclear', desired_outcome: 'Clarify the button' });
  requestRepair(s, { issue: 'Second issue', evidence: 'Shopper statement', desired_outcome: 'A second small change' });
  assert.equal(s.repair.jobs!.length, 2);
  assert.equal(requestRepair(s, { issue: 'Third', evidence: 'test', desired_outcome: 'Third change' }).status, 'not_queued');
  const deadline = Date.now() + 30_000;
  while (['queued', 'planning', 'running', 'verifying'].includes(s.repair.status) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(s.repair.status, 'ready', JSON.stringify(s.repair.jobs));
  assert.ok(s.repair.jobs!.every((job) => job.plan && job.timings?.planningFinishedAt && job.timings?.verificationFinishedAt));
  assert.equal(fs.readFileSync(path.join(fixture, 'src/store/example.ts'), 'utf8'), original);
  assert.equal(s.repair.publishedAt, undefined);
  const [first, second] = s.repair.jobs!;
  assert.ok(second.timings!.planningStartedAt >= first.timings!.verificationFinishedAt, 'Second planning waits for successful verification of first change');
  assert.ok(second.timings!.codingStartedAt >= first.timings!.verificationFinishedAt, 'Code edits remain sequential');
  assert.ok(first.timings!.typescriptStartedAt && first.timings!.typescriptFinishedAt && first.timings!.buildFinishedAt);
  assert.deepEqual(first.shopperStatements?.map((item) => item.speech), ['I would like a clearer button.']);
  s.firstAttemptCompletedAt = new Date().toISOString();
  assert.equal(await autoPublishRepair(s), true);
  assert.notEqual(fs.readFileSync(path.join(fixture, 'src/store/example.ts'), 'utf8'), original);
  assert.equal(await finishStoreSession(s), true);
  assert.equal(fs.readFileSync(path.join(fixture, 'src/store/example.ts'), 'utf8'), original);
  // Ending stops the active planner and prevents the queued planner from starting.
  const successfulAgent = fs.readFileSync(executable);
  fs.writeFileSync(executable, `#!${process.execPath}\nprocess.stdin.resume();setTimeout(()=>{},15000);\n`, { mode: 0o755 });
  const cancelled = await beginStoreSession('http://localhost');
  addEvent(cancelled, 'utterance', { role: 'user', speech: 'Please make these controls clearer.' });
  requestRepair(cancelled, { issue: 'One', evidence: 'One', desired_outcome: 'First control' });
  requestRepair(cancelled, { issue: 'Two', evidence: 'Two', desired_outcome: 'Second control' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await finishStoreSession(cancelled);
  const stopDeadline = Date.now() + 4000;
  while (!cancelled.repair.finishedAt && Date.now() < stopDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(cancelled.repair.finishedAt, 'All planner processes stopped promptly');
  assert.ok(cancelled.repair.jobs!.every((job) => job.status === 'failed'));
  assert.equal(cancelled.repair.publishedAt, undefined);
  assert.equal(cancelled.repair.jobs![1].timings?.planningStartedAt, undefined);
  fs.writeFileSync(executable, successfulAgent);
  fs.unlinkSync(path.join(fixture, 'node_modules'));
  fs.mkdirSync(path.join(fixture, 'node_modules/typescript/bin'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'node_modules/typescript/bin/tsc'), 'setTimeout(()=>{},15000);');
  const duringCheck = await beginStoreSession('http://localhost');
  addEvent(duringCheck, 'utterance', { role: 'user', speech: 'Clarify the control.' });
  requestRepair(duringCheck, { issue: 'Control', evidence: 'Control', desired_outcome: 'Clarify it' });
  const checkDeadline = Date.now() + 4000;
  while (!duringCheck.repair.jobs![0].timings?.typescriptStartedAt && Date.now() < checkDeadline) await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(duringCheck.repair.jobs![0].timings?.typescriptStartedAt);
  await finishStoreSession(duringCheck);
  const finishedDeadline = Date.now() + 4000;
  while (!duringCheck.repair.finishedAt && Date.now() < finishedDeadline) await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(duringCheck.repair.finishedAt);
  assert.equal(duringCheck.repair.jobs![0].timings?.correctionStartedAt, undefined, 'Ending verification must not launch correction');

  process.chdir(appRoot);
  fs.rmSync(fixture, { recursive: true, force: true });
});
