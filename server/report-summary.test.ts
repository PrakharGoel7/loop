import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildStudySummary, linkableRetryStatement } from './report-summary.js';
import type { StudyEvent, StudySession } from './state.js';

function event(id: string, at: string, type: string, detail: Record<string, unknown> = {}): StudyEvent {
  return { id, at, type, detail };
}

function session(events: StudyEvent[]): StudySession {
  return {
    id: 'example', createdAt: '2026-10-09T10:00:00.000Z', storeUrl: '/shop?session=example',
    goal: 'Find a blue top', phase: 'retest', firstAttemptCompletedAt: '2026-10-09T10:04:00.000Z', events,
    repair: {
      status: 'ready', publishedAt: '2026-10-09T10:05:00.000Z',
      jobs: [{ id: 'color-job', issue: 'Cannot narrow tops by color', evidence: 'Shopper changed searches and said color was hard to find.', desiredOutcome: 'Find the desired color', observedEventIds: ['search'], shopperQuoteEventId: 'baseline-quote', status: 'verified', requestedAt: '2026-10-09T10:03:00.000Z', summary: 'Added a color filter.' }],
    },
    clipsEnabled: true,
    clips: [{ id: 'clip-1', jobId: 'color-job', observedAt: '2026-10-09T10:02:00.000Z', signal: 'Repeated search', evidence: 'Two search attempts', issue: 'Cannot narrow tops by color', status: 'ready' }],
  };
}

test('connects one confirmed issue to exact evidence and keeps sample-note discussion out of retry response', () => {
  const study = session([
    event('search', '2026-10-09T10:02:00.000Z', 'search_submitted', { query: 'blue top' }),
    event('baseline-quote', '2026-10-09T10:02:30.000Z', 'utterance', { role: 'user', speech: 'I want to narrow these by blue.' }),
    event('baseline-checkout', '2026-10-09T10:04:00.000Z', 'checkout_completed'),
    event('retest-open', '2026-10-09T10:06:00.000Z', 'store_opened'),
    event('retest-quote', '2026-10-09T10:06:30.000Z', 'utterance', { role: 'user', speech: 'I can find blue tops now.' }),
    event('sample-lookup', '2026-10-09T10:07:00.000Z', 'sample_issue_lookup'),
    event('sample-answer', '2026-10-09T10:07:30.000Z', 'utterance', { role: 'user', speech: 'No, I did not have that other problem.' }),
  ]);
  study.repair.jobs![0].retryQuoteEventIds = ['retest-quote'];
  const summary = buildStudySummary(study);
  assert.equal(summary.baseline.status, 'checkout_completed');
  assert.equal(summary.revision.status, 'published');
  assert.equal(summary.retry.status, 'started');
  assert.deepEqual(summary.retry.statements.map((item) => item.eventId), ['retest-quote']);
  assert.equal(summary.findings[0].shopperQuote?.eventId, 'baseline-quote');
  assert.deepEqual(summary.findings[0].observedActions.map((item) => item.eventId), ['search']);
  assert.equal(summary.findings[0].clipId, 'clip-1');
  assert.equal(summary.findings[0].retryStatement?.eventId, 'retest-quote');
  assert.equal(summary.findings[0].changeSummary, 'Added a color filter.');
});

test('does not attribute an unrelated retry remark even when there is only one change', () => {
  const study = session([
    event('baseline-checkout', '2026-10-09T10:04:00.000Z', 'checkout_completed'),
    event('retest-open', '2026-10-09T10:06:00.000Z', 'store_opened'),
    event('retest-quote', '2026-10-09T10:06:30.000Z', 'utterance', { role: 'user', speech: 'Okay, I reloaded it.' }),
  ]);
  const summary = buildStudySummary(study);
  assert.equal(summary.retry.statements[0]?.eventId, 'retest-quote');
  assert.equal(summary.findings[0].retryStatement, undefined);
});

test('does not invent friction findings from changes queued before the shopper speaks', () => {
  const study = session([]);
  study.repair.jobs![0].prequeued = true;
  study.repair.jobs![0].shopperQuoteEventId = undefined;
  assert.deepEqual(buildStudySummary(study).findings, []);
  assert.equal(buildStudySummary(study).revision.status, 'published');
  study.repair.jobs![0].confirmedAt = '2026-10-09T10:03:00.000Z';
  assert.equal(buildStudySummary(study).findings.length, 1);
});

test('shows a forced prepared assignment without implying it resolved the issue', () => {
  const study = session([]);
  study.repair.jobs![0].matchQuality = 'forced';
  study.repair.jobs![0].summary = 'Applied the prepared shortlist; this fallback assignment may not resolve the reported issue.';
  const finding = buildStudySummary(study).findings[0];
  assert.equal(finding.matchQuality, 'forced');
  assert.match(finding.changeSummary ?? '', /may not resolve/);
});

test('keeps the sample question between first checkout and retry out of retry feedback', () => {
  const study = session([
    event('baseline-checkout', '2026-10-09T10:04:00.000Z', 'checkout_completed'),
    event('sample-lookup', '2026-10-09T10:04:10.000Z', 'sample_issue_lookup', { available: true }),
    event('sample-question', '2026-10-09T10:04:20.000Z', 'utterance', { role: 'pal', speech: 'In our sample research notes, shoppers mentioned color search. Did that come up for you?' }),
    event('sample-answer', '2026-10-09T10:04:30.000Z', 'utterance', { role: 'user', speech: 'No, I was looking for fit information.' }),
    event('retest-open', '2026-10-09T10:06:00.000Z', 'store_opened'),
    event('retest-quote', '2026-10-09T10:06:30.000Z', 'utterance', { role: 'user', speech: 'The fit information is much clearer now.' }),
  ]);
  study.repair.jobs![0].retryQuoteEventIds = ['retest-quote'];
  const summary = buildStudySummary(study);
  assert.deepEqual(summary.retry.statements.map((item) => item.eventId), ['retest-quote']);
  assert.equal(summary.findings[0].retryStatement?.eventId, 'retest-quote');
});

test('keeps older sample-research answers out of retry feedback and shortens worker notes', () => {
  const study = session([
    event('baseline-checkout', '2026-10-09T10:04:00.000Z', 'checkout_completed'),
    event('retest-open', '2026-10-09T10:06:00.000Z', 'store_opened'),
    event('retest-quote', '2026-10-09T10:06:30.000Z', 'utterance', { role: 'user', speech: 'This is easier.' }),
    event('pal-sample', '2026-10-09T10:07:00.000Z', 'utterance', { role: 'pal', speech: 'A common concern past users have mentioned is finding clothing by color.' }),
    event('sample-answer', '2026-10-09T10:07:30.000Z', 'utterance', { role: 'user', speech: 'No, not really.' }),
  ]);
  study.repair.jobs![0].summary = 'Added a color filter.\n- Works on mobile.\nNo build was run.';
  const summary = buildStudySummary(study);
  assert.deepEqual(summary.retry.statements.map((item) => item.eventId), ['retest-quote']);
  assert.equal(summary.findings[0].changeSummary, 'Added a color filter.');
});

test('does not attribute a shared retry statement to either of two changes', () => {
  const study = session([
    event('baseline-checkout', '2026-10-09T10:04:00.000Z', 'checkout_completed'),
    event('retest-open', '2026-10-09T10:06:00.000Z', 'store_opened'),
    event('retest-quote', '2026-10-09T10:06:30.000Z', 'utterance', { role: 'user', speech: 'This feels easier.' }),
  ]);
  study.repair.jobs!.push({ id: 'size-job', issue: 'Sizing needs measurements', evidence: 'Shopper asked for measurements.', desiredOutcome: 'Choose a size', status: 'verified', requestedAt: '2026-10-09T10:03:30.000Z', summary: 'Added measurements.' });
  const summary = buildStudySummary(study);
  assert.equal(summary.retry.statements.length, 1);
  assert.ok(summary.findings.every((finding) => finding.retryStatement === undefined));
  study.repair.jobs![1].retryQuoteEventIds = ['retest-quote'];
  const linked = buildStudySummary(study);
  assert.equal(linked.findings[0].retryStatement, undefined);
  assert.equal(linked.findings[1].retryStatement?.eventId, 'retest-quote');
});

test('only permits linking an actual recent statement after reloading and before sample research', () => {
  const now = Date.now();
  const iso = (offset: number) => new Date(now + offset).toISOString();
  const study = session([
    event('before', iso(-30_000), 'utterance', { role: 'user', speech: 'Before the reload' }),
    event('retest-open', iso(-20_000), 'store_opened'),
    event('after', iso(-10_000), 'utterance', { role: 'user', speech: 'The filter is easier to use.' }),
  ]);
  study.repair.publishedAt = iso(-25_000);
  assert.equal(linkableRetryStatement(study, 'color-job')?.id, 'after');
  assert.equal(linkableRetryStatement(study, 'unknown'), undefined);
  study.events.push(event('sample', iso(-5_000), 'sample_issue_lookup'));
  assert.equal(linkableRetryStatement(study, 'color-job'), undefined);
});

test('reports no published revision when every job failed', () => {
  const study = session([event('baseline-checkout', '2026-10-09T10:04:00.000Z', 'checkout_completed')]);
  study.phase = 'done';
  study.repair.publishedAt = undefined;
  study.repair.status = 'failed';
  study.repair.jobs![0].status = 'failed';
  const summary = buildStudySummary(study);
  assert.equal(summary.revision.status, 'failed');
  assert.equal(summary.retry.status, 'not_available');
  assert.equal(summary.findings[0].published, false);
  assert.equal(summary.findings[0].changeSummary, undefined);
});

test('marks a verified change as unpublished when the study ended before publication', () => {
  const study = session([event('baseline-checkout', '2026-10-09T10:04:00.000Z', 'checkout_completed')]);
  study.phase = 'done';
  study.repair.publishedAt = undefined;
  study.repair.status = 'ready';
  const summary = buildStudySummary(study);
  assert.equal(summary.revision.status, 'not_published');
  assert.equal(summary.findings[0].published, false);
  assert.equal(summary.retry.status, 'not_available');
});
