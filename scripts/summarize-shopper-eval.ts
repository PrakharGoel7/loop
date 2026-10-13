import fs from 'node:fs';
import path from 'node:path';
const directory = path.resolve(process.argv[2] || '');
if (!process.argv[2] || fs.existsSync(path.join(directory, 'INVALIDATED.json'))) throw new Error('Provide a valid, non-invalidated evaluation directory.');
const batch = JSON.parse(fs.readFileSync(path.join(directory, 'results.json'), 'utf8'));
const rows = batch.results.map((row: any) => {
  const result = JSON.parse(fs.readFileSync(path.join(directory, row.id, 'result.json'), 'utf8'));
  const reviewPath = path.join(directory, row.id, 'review.json');
  return { ...result, effectiveness: fs.existsSync(reviewPath) ? JSON.parse(fs.readFileSync(reviewPath, 'utf8')) : { status: 'NOT TESTED', checks: [] } };
});
const fmt = (n: unknown) => typeof n === 'number' ? `${n.toFixed(1)}s` : '—';
const total = (row: any, name: string) => row.jobs.reduce((sum: number, job: any) => sum + (job.seconds[name] || 0), 0);
const header = ['Case', 'Plan', 'Code', 'Verify/correct', 'Statement → published', 'Published files changed', 'Effectiveness'];
const values: string[][] = rows.map((row: any) => [row.title, fmt(total(row, 'planning')), fmt(total(row, 'coding')), fmt(total(row, 'verificationIncludingCorrection')), fmt(row.totalStatementToPublishSeconds), row.publishedFilesActuallyChanged ? 'YES' : 'NO', row.effectiveness.status]);
const widths = header.map((name, index) => Math.max(name.length, ...values.map((row: string[]) => row[index].length)));
const table = [header, ...values].map(row => row.map((value, i) => value.padEnd(widths[i])).join(' | ')).join('\n');
const lines = [
 'LOOP — SHOPPER CHANGE EVALUATION',
 'Run: ' + batch.createdAt,
 'One trial per case; two independent sessions run concurrently. Each session has a sequential worker queue.',
 'Model: gpt-5.6-luna, low reasoning. Synthetic recorded statements and simulated Mira tool arguments; no live Tavus/audio/perception measurement.',
 'Effectiveness means the requested UI behavior worked in browser review; it is not evidence of real shopper satisfaction or improved conversion.',
 '', table, '',
 ...rows.flatMap((row: any) => [
  row.title.toUpperCase(),
  'Statements: ' + row.statements.map((text: string) => `“${text}”`).join(' / '),
  ...row.jobs.flatMap((job: any, index: number) => [
    `  Job ${index + 1}: ${job.plan?.title || 'No plan'}`,
    `  Plan: ${job.plan?.change || job.error || 'Unavailable'}`,
    `  Timings: queue ${fmt(job.seconds.queueWait)}; setup ${fmt(job.seconds.workspace)}; planning ${fmt(job.seconds.planning)}; coding ${fmt(job.seconds.coding)}; verification/correction ${fmt(job.seconds.verificationIncludingCorrection)}.`,
  ]),
  `  Publication: ${fmt(row.publicationSeconds)}; all jobs verified before publication: ${row.allVerifiedBeforePublication}; checkout gate respected: ${row.heldUntilCheckout}; baseline restored: ${row.restored}.`,
  '  Functional review: ' + row.effectiveness.status,
  ...row.effectiveness.checks.map((check: any) => `    ${check.pass ? 'PASS' : 'FAIL'} — ${check.description}`),
  ...(row.effectiveness.notes ? ['  Notes: ' + row.effectiveness.notes] : []),
  '',
 ]),
 'Saved artifacts: each case folder contains result.json, revision.patch, full statement/event evidence and worker logs under baseline/data/, and the published website under site/.',
 'Rerun: node --import tsx scripts/eval-shopper-changes.ts [optional case IDs]',
];
fs.writeFileSync(path.join(directory, 'report.txt'), lines.join('\n') + '\n');
fs.writeFileSync(path.join(directory, 'reviewed-results.json'), JSON.stringify({ ...batch, results: rows }, null, 2));
console.log(lines.slice(0, 8).join('\n'));
