import type { FrictionClip, RepairJob, StudyEvent, StudySession } from './state.js';
import type { StudySummary, SummaryQuote } from '../shared/report-summary.js';

const observableActions = new Set([
  'search_submitted', 'category_selected', 'sort_changed', 'listing_viewed', 'product_viewed',
  'page_idle', 'size_selected', 'add_to_bag_without_size', 'added_to_bag', 'bag_viewed', 'checkout_started',
]);

function time(value: string | undefined) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function quote(event: StudyEvent | undefined): SummaryQuote | undefined {
  const speech = event?.type === 'utterance' && event.detail.role === 'user' ? text(event.detail.speech) : undefined;
  return event && speech ? { eventId: event.id, at: event.at, text: speech } : undefined;
}

function actionLabel(event: StudyEvent): string {
  const name = text(event.detail.productName);
  const query = text(event.detail.query);
  const size = text(event.detail.size);
  const category = text(event.detail.category);
  if (event.type === 'search_submitted' && query) return `Searched for “${query}”`;
  if (event.type === 'size_selected' && size) return `Selected size ${size}${name ? ` for ${name}` : ''}`;
  if (event.type === 'product_viewed' && name) return `Viewed ${name}`;
  if (event.type === 'category_selected' && category) return `Selected ${category}`;
  if (event.type === 'add_to_bag_without_size') return 'Tried to add an item without choosing a size';
  return event.type.replaceAll('_', ' ');
}

function briefChange(summary: string | undefined): string | undefined {
  const firstLine = summary?.split('\n').map((line) => line.trim()).find((line) => line && !/^[-*]\s/.test(line));
  if (!firstLine) return undefined;
  const firstSentence = firstLine.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? firstLine;
  const clean = firstSentence.replaceAll('`', '').replace(/\s+in src\/store(?=[:.]|$)/, '').replace(/[:\s]+$/, '').trim();
  const compact = clean.length > 280 ? `${clean.slice(0, 277).trimEnd()}…` : clean;
  return /[.!?…]$/.test(compact) ? compact : `${compact}.`;
}

function nearbyEvidence(session: StudySession, job: RepairJob) {
  const evidenceAt = job.confirmedAt ?? job.requestedAt;
  const windowStart = time(evidenceAt) - 180_000;
  const nearby = session.events.filter((event) => time(event.at) >= windowStart && time(event.at) <= time(evidenceAt));
  const observedIds = job.observedEventIds ?? nearby.filter((event) => observableActions.has(event.type)).slice(-4).map((event) => event.id);
  const observedActions = observedIds
    .map((id) => session.events.find((event) => event.id === id))
    .filter((event): event is StudyEvent => Boolean(event && observableActions.has(event.type)))
    .map((event) => ({ eventId: event.id, at: event.at, label: actionLabel(event) }));
  const shopperEvent = job.shopperQuoteEventId
    ? session.events.find((event) => event.id === job.shopperQuoteEventId)
    : nearby.findLast((event) => Boolean(quote(event)));
  return { observedActions, shopperQuote: quote(shopperEvent) };
}

function linkedClip(session: StudySession, job: RepairJob): FrictionClip | undefined {
  const exact = session.clips?.find((clip) => clip.jobId === job.id);
  if (exact) return exact;
  const legacyMatches = session.clips?.filter((clip) => !clip.jobId && clip.issue?.toLowerCase() === job.issue.toLowerCase()) ?? [];
  return legacyMatches.length === 1 ? legacyMatches[0] : undefined;
}

export function linkableRetryStatement(session: StudySession, jobId: string): StudyEvent | undefined {
  const publishedAt = session.repair.publishedAt;
  const job = session.repair.jobs?.find((item) => item.id === jobId && item.status === 'verified');
  if (!publishedAt || !job) return undefined;
  const retryOpen = session.events.find((event) => event.type === 'store_opened' && time(event.at) > time(publishedAt));
  if (!retryOpen) return undefined;
  const sampleFollowUp = session.events.find((event) => event.type === 'sample_issue_lookup' && time(event.at) > time(retryOpen.at));
  if (sampleFollowUp) return undefined;
  return session.events.findLast((event) => {
    const age = Date.now() - time(event.at);
    return Boolean(quote(event)) && time(event.at) > time(retryOpen.at) && age >= 0 && age < 120_000;
  });
}

export function buildStudySummary(session: StudySession): StudySummary {
  const events = session.events;
  const publishedAt = session.repair.publishedAt;
  const firstCheckout = events.find((event) => event.type === 'checkout_completed' && (!publishedAt || time(event.at) <= time(publishedAt)));
  const baseline = firstCheckout
    ? { status: 'checkout_completed' as const, at: firstCheckout.at }
    : session.firstAttemptCompletedAt
      ? { status: 'finished_without_checkout' as const, at: session.firstAttemptCompletedAt }
      : { status: 'shopping' as const };

  const jobs = session.repair.jobs ?? [];
  const verified = jobs.filter((job) => job.status === 'verified').length;
  const failed = jobs.filter((job) => job.status === 'failed').length;
  const revisionStatus: StudySummary['revision']['status'] = publishedAt ? 'published' : !jobs.length ? 'none' : session.repair.status === 'failed' ? 'failed' : session.phase === 'done' ? 'not_published' : 'in_progress';
  const retryOpen = publishedAt ? events.find((event) => event.type === 'store_opened' && time(event.at) > time(publishedAt)) : undefined;
  const retryCheckout = retryOpen ? events.find((event) => event.type === 'checkout_completed' && time(event.at) > time(retryOpen.at)) : undefined;
  const sampleFollowUp = retryOpen ? events.find((event) => time(event.at) > time(retryOpen.at) && (
    event.type === 'sample_issue_lookup'
    || (event.type === 'utterance' && event.detail.role === 'pal' && /sample research notes|common concern past users have mentioned/i.test(String(event.detail.speech || '')))
  )) : undefined;
  const retryStatements = retryOpen
    ? events.filter((event) => time(event.at) > time(retryOpen.at) && (!sampleFollowUp || time(event.at) < time(sampleFollowUp.at))).map(quote).filter((item): item is SummaryQuote => Boolean(item))
    : [];
  const retryStatus: StudySummary['retry']['status'] = !publishedAt ? 'not_available' : !retryOpen ? 'waiting' : retryCheckout ? 'checkout_completed' : 'started';
  return {
    goal: session.goal,
    sessionPhase: session.phase,
    baseline,
    revision: { status: revisionStatus, verified, failed, publishedAt },
    retry: { status: retryStatus, at: retryOpen?.at, statements: retryStatements },
    findings: jobs.filter((job) => !job.prequeued || job.confirmedAt).map((job) => {
      const evidence = nearbyEvidence(session, job);
      const clip = linkedClip(session, job);
      return {
        jobId: job.id,
        issue: job.issue,
        interviewerEvidence: job.evidence,
        ...evidence,
        clipId: clip?.id,
        clipStatus: clip?.status,
        repairStatus: job.status,
        matchQuality: job.matchQuality,
        changeSummary: job.status === 'failed' ? undefined : briefChange(job.summary),
        published: Boolean(publishedAt && job.status === 'verified'),
        retryStatement: job.retryQuoteEventIds?.map((id) => quote(events.find((event) => event.id === id))).find(Boolean),
      };
    }),
  };
}
