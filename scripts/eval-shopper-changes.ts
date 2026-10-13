import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

type Request = { statement: string; precedingStatements?: string[]; evidence?: string; issue: string; desired_outcome: string; event: { type: string; detail: Record<string, unknown> } };
type Case = { id: string; title: string; checkout: string; requests: Request[]; afterQueueStatements?: string[]; acceptance: string[] };
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const replay = process.argv.includes('--live-replay') || process.env.LOOP_EVAL_LIVE_REPLAY === '1';
const suite = JSON.parse(fs.readFileSync(path.join(appRoot, replay ? 'evals/live-favorites-sizing.json' : 'evals/shopper-changes.json'), 'utf8')) as { scope: string; cases: Case[] };
const copyApp = (destination: string) => {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of ['src', 'shared', 'public', 'index.html', 'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json']) {
    if (fs.existsSync(path.join(appRoot, entry))) fs.cpSync(path.join(appRoot, entry), path.join(destination, entry), { recursive: true });
  }
  fs.symlinkSync(path.join(appRoot, 'node_modules'), path.join(destination, 'node_modules'));
};
const write = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
const seconds = (a?: string, b?: string) => a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 100) / 10 : null;

async function runCase(id: string, runRoot: string) {
  const entry = suite.cases.find((item) => item.id === id)!;
  if (!entry) throw new Error(`Unknown case ${id}`);
  const folder = path.join(runRoot, id); const fixture = path.join(folder, 'baseline');
  copyApp(fixture);
  // A fixture under the app folder must have its own Git root; otherwise git apply
  // can skip paths outside the parent repository's current-directory prefix.
  const init = spawnSync('git', ['init', '-q', fixture], { encoding: 'utf8' });
  if (init.status !== 0) throw new Error(init.stderr);
  process.chdir(fixture);
  // Import after chdir: the production modules bind their storage and publish target to this disposable copy.
  const { beginStoreSession, requestRepair, autoPublishRepair, finishStoreSession } = await import('../server/repair.js');
  const { addEvent, saveSession } = await import('../server/state.js');
  const study = await beginStoreSession('http://localhost');
  study.phase = 'shopping';
  const outcomes: unknown[] = [];
  for (const request of entry.requests) {
    for (const speech of request.precedingStatements ?? []) addEvent(study, 'utterance', { role: 'user', speech });
    addEvent(study, request.event.type, request.event.detail);
    const utterance = addEvent(study, 'utterance', { role: 'user', speech: request.statement });
    const response = requestRepair(study, { issue: request.issue, evidence: request.evidence ?? request.statement, desired_outcome: request.desired_outcome });
    outcomes.push({ utteranceId: utterance.id, recordedAt: utterance.at, response });
  }
  for (const speech of entry.afterQueueStatements ?? []) addEvent(study, 'utterance', { role: 'user', speech });
  const checkout = () => {
    const event = addEvent(study, 'checkout_completed', { source: 'evaluation_fixture' });
    study.firstAttemptCompletedAt = event.at; study.phase = 'first_attempt_done'; saveSession(study);
  };
  // Explicitly simulated checkout timing; do not mix shopper task time into worker execution time.
  if (entry.checkout === 'while-building') checkout();
  const started = Date.now(); let previous = '';
  while (Date.now() - started < 720_000) {
    const state = `${study.repair.status}:${Boolean(study.repair.publishedAt)}`;
    if (state !== previous) { console.log(`${id} ${Math.round((Date.now() - started) / 1000)}s ${state}`); previous = state; }
    if (study.repair.status === 'failed' || study.repair.publishedAt || (entry.checkout === 'after-verification' && study.repair.status === 'ready')) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const heldUntilCheckout = entry.checkout !== 'after-verification' || !study.repair.publishedAt;
  if (entry.checkout === 'after-verification' && study.repair.status === 'ready') { checkout(); await autoPublishRepair(study); }
  if (study.repair.diff) fs.writeFileSync(path.join(folder, 'revision.patch'), study.repair.diff);
  if (study.repair.publishedAt) {
    const site = path.join(folder, 'site'); copyApp(site);
    fs.rmSync(path.join(site, 'src/store'), { recursive: true, force: true });
    fs.cpSync(path.join(fixture, 'src/store'), path.join(site, 'src/store'), { recursive: true });
  }
  const status = study.repair.status; const publishedAt = study.repair.publishedAt;
  const publishedFilesActuallyChanged = Boolean(publishedAt) && JSON.stringify(study.repair.publishedSnapshot) !== JSON.stringify(study.repair.baselineSnapshot);
  const allVerifiedBeforePublication = Boolean(publishedAt) && (study.repair.jobs ?? []).every((job) => job.status === 'verified' && job.finishedAt && Date.parse(job.finishedAt) <= Date.parse(publishedAt!));
  let restoreError: string | undefined;
  try { await finishStoreSession(study); } catch (error) { restoreError = (error as Error).message; }
  const jobs = study.repair.jobs ?? [];
  const diagnostics = jobs.map((job) => {
    const logFolder = path.join(fixture, 'data/worker-logs', study.id);
    const files = fs.existsSync(logFolder) ? fs.readdirSync(logFolder).filter((file) => file.startsWith(job.id)) : [];
    return { jobId: job.id, files: files.map((name) => ({ name, bytes: fs.statSync(path.join(logFolder, name)).size })), stages: ['planning', 'coding', 'correction'].map((stage) => {
      const file = path.join(logFolder, `${job.id}-${stage}.jsonl`);
      const entries = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }) : [];
      const commands = entries.filter((entry) => entry.type === 'item.completed' && entry.item?.type === 'command_execution');
      const mcpCalls = entries.filter((entry) => entry.type === 'item.completed' && entry.item?.type === 'mcp_tool_call').map((entry) => {
        const item = entry.item;
        const outputText = (item.result?.content ?? []).filter((content: { type?: string }) => content.type === 'text').map((content: { text?: string }) => content.text ?? '').join('\n');
        return { server: item.server, tool: item.tool, outputCharacters: outputText.length, serializedResultCharacters: JSON.stringify(item.result ?? '').length, failed: Boolean(item.status === 'failed' || item.error || item.result?.isError), error: item.error, ...(item.status === 'failed' ? { failureText: outputText.slice(0, 500) } : {}) };
      });
      const mcpReadCalls = mcpCalls.filter((call) => ['read_source', 'list_sources', 'search_source', 'review_changes'].includes(call.tool));
      return { stage, mcpCallCount: mcpCalls.length, mcpOutputCharacters: mcpCalls.reduce((sum, call) => sum + call.outputCharacters, 0), mcpReadOutputCharacters: mcpReadCalls.reduce((sum, call) => sum + call.outputCharacters, 0), mcpCalls, commandCount: commands.length, commandOutputCharacters: commands.reduce((total, entry) => total + String(entry.item.aggregated_output ?? '').length, 0), commands: commands.map((entry) => ({ command: entry.item.command, outputCharacters: String(entry.item.aggregated_output ?? '').length, exitCode: entry.item.exit_code })) };
    }) };
  });
  const planningPrompts = jobs.map((job) => {
    const file = path.join(fixture, 'data/worker-logs', study.id, `${job.id}-planning.prompt.txt`);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  });
  const contextChecks = {
    allPlanningPromptsSaved: planningPrompts.length === entry.requests.length && planningPrompts.every(Boolean),
    excludesInjectedObservations: planningPrompts.every((prompt) => !prompt.includes('[Loop observation, not shopper speech]')),
    excludesPostAdmissionRemarks: planningPrompts.every((prompt) => (entry.afterQueueStatements ?? []).every((speech) => !prompt.includes(speech))),
    eachPlanStartsAfterPreviousVerification: jobs.every((job, index) => index === 0 || Boolean(job.timings?.planningStartedAt && jobs[index - 1].timings?.verificationFinishedAt && Date.parse(job.timings.planningStartedAt) >= Date.parse(jobs[index - 1].timings!.verificationFinishedAt))),
    plannerShellCalls: diagnostics.reduce((total, job) => total + (job.stages.find((stage) => stage.stage === 'planning')?.commandCount ?? 0), 0),
  };
  const result = {
    id, title: entry.title, scope: suite.scope, model: study.repair.workerModel, effort: study.repair.workerReasoningEffort,
    workerLocation: process.env.LOOP_WORKER_SSH_HOST ? 'remote' : 'local',
    diagnostics, contextChecks,
    statements: entry.requests.map((request) => request.statement), outcomes, acceptance: entry.acceptance,
    status, publishedAt, publishedFilesActuallyChanged, allVerifiedBeforePublication, heldUntilCheckout, restored: Boolean(study.repair.restoredAt), restoreError,
    totalStatementToPublishSeconds: seconds((outcomes[0] as { recordedAt: string }).recordedAt, publishedAt),
    publicationSeconds: seconds(study.repair.timings?.publicationStartedAt, publishedAt),
    jobs: jobs.map((job, index) => ({ ...job, seconds: {
      recordingToQueue: seconds((outcomes[index] as { recordedAt: string }).recordedAt, job.requestedAt),
      queueWait: seconds(job.requestedAt, job.timings?.workspaceStartedAt),
      workspace: seconds(job.timings?.workspaceStartedAt, job.timings?.workspaceReadyAt),
      planning: seconds(job.timings?.planningStartedAt, job.timings?.planningFinishedAt),
      coding: seconds(job.timings?.codingStartedAt, job.timings?.codingFinishedAt),
      verificationIncludingCorrection: seconds(job.timings?.verificationStartedAt, job.timings?.verificationFinishedAt),
      typescript: seconds(job.timings?.typescriptStartedAt, job.timings?.typescriptFinishedAt),
      build: seconds(job.timings?.buildStartedAt, job.timings?.buildFinishedAt),
      correction: seconds(job.timings?.correctionStartedAt, job.timings?.correctionFinishedAt),
      total: seconds(job.requestedAt, job.finishedAt),
    } })),
    effectiveness: { status: 'pending_browser_review', checks: [] },
  };
  write(path.join(folder, 'result.json'), result);
  console.log(`${id} RESULT ${status} published=${Boolean(publishedAt)} restored=${result.restored} total=${result.totalStatementToPublishSeconds}s`);
}

if (process.argv[2] === '--case') {
  await runCase(process.argv[3], process.argv[4]);
} else {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runRoot = path.join(appRoot, 'data/evaluations', stamp);
  fs.mkdirSync(runRoot, { recursive: true });
  write(path.join(runRoot, 'suite.json'), suite);
  console.log(`RUN_DIRECTORY=${runRoot}`);
  const repeatsFlag = process.argv.indexOf('--repeats');
  const repetitions = repeatsFlag >= 0 ? Number(process.argv[repeatsFlag + 1]) : replay ? 3 : 1;
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20) throw new Error('repeats must be 1–20');
  const selected = process.argv.slice(2).filter((arg, index, args) => arg !== '--live-replay' && arg !== '--repeats' && args[index - 1] !== '--repeats');
  const cases = selected.length ? suite.cases.filter((entry) => selected.includes(entry.id)) : suite.cases;
  const tasks = Array.from({ length: repetitions }, (_, index) => cases.map((entry) => ({ entry, trial: index + 1, directory: repetitions === 1 ? runRoot : path.join(runRoot, `trial-${index + 1}`) }))).flat();
  const pending = [...tasks];
  // Independent disposable sessions run two at a time. Each session's own queue remains sequential.
  async function runner() {
    while (pending.length) {
      const { entry, trial, directory } = pending.shift()!;
      fs.mkdirSync(directory, { recursive: true });
      await new Promise<void>((resolve) => {
        const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--case', entry.id, directory], { cwd: appRoot, env: { ...process.env, LOOP_EVAL_LIVE_REPLAY: replay ? '1' : '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
        const log = fs.createWriteStream(path.join(directory, `${entry.id}.log`));
        child.stdout.on('data', (chunk) => { process.stdout.write(chunk); log.write(chunk); });
        child.stderr.on('data', (chunk) => log.write(chunk));
        child.on('close', (code) => { log.end(); if (code) console.log(`${entry.id} trial ${trial}: runner exited ${code}; inspect log.`); resolve(); });
        child.on('error', (error) => { console.log(error.message); log.end(); resolve(); });
      });
      if (process.env.LOOP_EVAL_STOP_ON_FAILURE === '1') {
        let result: { status?: string } = {};
        try { result = JSON.parse(fs.readFileSync(path.join(directory, entry.id, 'result.json'), 'utf8')); } catch { /* runner failed */ }
        if (result.status !== 'ready') { console.log('Stopping remaining trials after failure for investigation.'); pending.length = 0; }
      }
    }
  }
  const concurrency = replay ? 1 : 2;
  await Promise.all(Array.from({ length: concurrency }, () => runner()));
  const results = tasks.map(({ entry, trial, directory }) => { try { return { trial, ...JSON.parse(fs.readFileSync(path.join(directory, entry.id, 'result.json'), 'utf8')) }; } catch { return { id: entry.id, trial, status: fs.existsSync(path.join(directory, `${entry.id}.log`)) ? 'runner_failed' : 'not_run' }; } });
  write(path.join(runRoot, 'results.json'), { createdAt: stamp, concurrency, repetitions, results });
  console.log(`Completed ${results.filter((entry) => entry.status !== 'not_run').length} cases; ${results.filter((entry) => entry.status === 'not_run').length} not run. Results: ${runRoot}/results.json`);
}
