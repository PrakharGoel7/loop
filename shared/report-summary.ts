export type SummaryQuote = { eventId: string; at: string; text: string };
export type SummaryAction = { eventId: string; at: string; label: string };
export type SummaryFinding = {
  jobId: string;
  issue: string;
  interviewerEvidence: string;
  observedActions: SummaryAction[];
  shopperQuote?: SummaryQuote;
  clipId?: string;
  clipStatus?: 'observed' | 'confirmed' | 'uploading' | 'ready' | 'failed' | 'dismissed';
  repairStatus: 'queued' | 'planning' | 'running' | 'verifying' | 'verified' | 'failed';
  matchQuality?: 'related' | 'forced';
  changeSummary?: string;
  published: boolean;
  retryStatement?: SummaryQuote;
};

export type StudySummary = {
  goal?: string;
  sessionPhase: 'intro' | 'shopping' | 'first_attempt_done' | 'repairing' | 'retest' | 'done';
  baseline: { status: 'shopping' | 'finished_without_checkout' | 'checkout_completed'; at?: string };
  revision: { status: 'none' | 'in_progress' | 'failed' | 'not_published' | 'published'; verified: number; failed: number; publishedAt?: string };
  retry: { status: 'not_available' | 'waiting' | 'started' | 'checkout_completed'; at?: string; statements: SummaryQuote[] };
  findings: SummaryFinding[];
};
