import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: node --import tsx scripts/summarize-live-replay.ts <run directory>');
const run = JSON.parse(fs.readFileSync(path.join(root, 'results.json'), 'utf8'));
const format = (value: unknown) => typeof value === 'number' ? `${value.toFixed(1)}s` : '—';
const lines = ['Loop Favorites → sizing repeated replay', '='.repeat(40), '',
  `Trials: ${run.repetitions}; cross-session concurrency: ${run.concurrency}.`,
  'Exact recorded statements and tool arguments, compressed admission timing.',
  'Real planner/coder/checks/publish; no Tavus speech recognition, perception or tool-selection measurement.', '',
  'Trial | Published | Restored | Statement→publish | Browser outcome',
];
const completed: number[] = [];
for (const result of run.results) {
  const caseRoot = path.join(root, ...(run.repetitions > 1 ? [`trial-${result.trial}`] : []), result.id);
  let review: { status?: string } = {};
  try { review = JSON.parse(fs.readFileSync(path.join(caseRoot, 'review.json'), 'utf8')); } catch { /* explicitly not tested */ }
  const published = Boolean(result.publishedAt && result.publishedFilesActuallyChanged && result.allVerifiedBeforePublication);
  lines.push(`${result.trial} | ${published} | ${result.restored ?? false} | ${format(result.totalStatementToPublishSeconds)} | ${review.status ?? 'NOT TESTED'}`);
  lines.push(`  Context checks: ${JSON.stringify(result.contextChecks ?? {})}`);
  if (published && typeof result.totalStatementToPublishSeconds === 'number') completed.push(result.totalStatementToPublishSeconds);
  for (const [index, job] of (result.jobs ?? []).entries()) {
    lines.push(`  ${index + 1}. ${job.title ?? job.issue}: ${job.status}; plan ${format(job.seconds.planning)}, code ${format(job.seconds.coding)}, verify ${format(job.seconds.verificationIncludingCorrection)}, total ${format(job.seconds.total)}`);
    lines.push(`     TypeScript ${format(job.seconds.typescript)}, build ${format(job.seconds.build)}`);
    if (job.error) lines.push(`     Error: ${String(job.error).slice(0, 300)}`);
    const diagnostics = result.diagnostics?.find((entry: { jobId: string }) => entry.jobId === job.id);
    for (const stage of diagnostics?.stages ?? []) lines.push(`     ${stage.stage}: ${stage.commandCount} shell calls, ${stage.commandOutputCharacters} shell output characters; ${stage.mcpCallCount ?? 0} MCP calls, ${stage.mcpOutputCharacters ?? 0} MCP output characters (${stage.mcpReadOutputCharacters ?? 0} from reading/review)` );
  }
}
completed.sort((a, b) => a - b);
const median = completed.length ? (completed[Math.floor((completed.length - 1) / 2)] + completed[Math.ceil((completed.length - 1) / 2)]) / 2 : undefined;
lines.push('', `Published: ${completed.length}/${run.results.length}.`, `Successful-trial median: ${format(median)}; slowest: ${format(completed.at(-1))}.`,
  'Failed trials are counted above, not dropped from the success denominator.',
  'Three trials are a small sample, not a dependable tail-latency estimate.', '',
  'Prior live run: Favorites planning 56s, coding 85s, verification 24s (~167s total); sizing planning timed out at 60s. Neither change published.',
  'Comparison is directional: replay uses current baseline and compressed event timing; machine/model load may differ.');
fs.writeFileSync(path.join(root, 'report.txt'), `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
