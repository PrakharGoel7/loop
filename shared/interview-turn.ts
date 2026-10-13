export type InterviewTurnEvent = {
  at?: string;
  type: string;
  detail?: Record<string, unknown> | string;
};

function speaker(event: InterviewTurnEvent): string {
  return event.detail && typeof event.detail === 'object' ? String(event.detail.role ?? '') : '';
}

function speech(event: InterviewTurnEvent): string {
  return event.detail && typeof event.detail === 'object' ? String(event.detail.speech ?? '') : '';
}

export function isShopperUtterance(event: InterviewTurnEvent): boolean {
  return event.type === 'utterance' && speaker(event) === 'user' && Boolean(speech(event).trim()) && !speech(event).trimStart().startsWith('[Loop');
}

export function debriefFollowupKey(events: InterviewTurnEvent[], state: { completedAt?: string; published: boolean; pending: boolean; quiet: boolean; awaitingAnswer: boolean; now: number; lastActivityAt: number; lastKey: string }): string | null {
  if (!state.completedAt || state.published || !state.pending || !state.quiet || state.awaitingAnswer || state.now - state.lastActivityAt < 6000 || !debriefProgress(events, state.completedAt).knowledgeAnswered) return null;
  const answer = events.findLast(isShopperUtterance);
  if (!answer || !Number.isFinite(Date.parse(answer.at || '')) || !Number.isFinite(Date.parse(state.completedAt)) || Date.parse(answer.at || '') < Date.parse(state.completedAt)) return null;
  const key = `${answer.at}:${speech(answer)}`;
  return key === state.lastKey ? null : key;
}

/** A question asked after the first journey must get a shopper turn before the retry. */
export function awaitingPostJourneyAnswer(events: InterviewTurnEvent[], firstAttemptCompletedAt?: string): boolean {
  if (!firstAttemptCompletedAt) return false;
  const completedAt = Date.parse(firstAttemptCompletedAt);
  if (!Number.isFinite(completedAt)) return false;
  const lastQuestionIndex = events.findLastIndex((event) =>
    (event.type === 'utterance' && speaker(event) === 'pal' && speech(event).includes('?')) && Date.parse(event.at || '') >= completedAt,
  );
  if (lastQuestionIndex < 0) return false;
  return !events.some((event, index) => index > lastQuestionIndex && isShopperUtterance(event));
}

/** Tavus objective completion, rather than playback callbacks, records answered stages. */
export function debriefProgress(events: InterviewTurnEvent[], firstAttemptCompletedAt?: string) {
  const checkout = firstAttemptCompletedAt || events.find((event) =>
    event.type === 'checkout_completed' || (event.type === 'phase_changed' && typeof event.detail === 'object' && event.detail?.phase === 'first_attempt_done'),
  )?.at;
  const boundary = Date.parse(checkout || '');
  const stage = (name: string) => {
    const matching = events.filter((event) => Number.isFinite(boundary) && Date.parse(event.at || '') >= boundary && typeof event.detail === 'object' && event.detail?.objective_name === name);
    const answered = matching.some((event) => event.type === 'objective_completed');
    return { prompted: answered || matching.some((event) => event.type === 'objective_activated'), answered };
  };
  const overall = stage('collect_overall_experience');
  const knowledge = stage('discuss_knowledge_base_concern');
  // Completion callbacks can arrive out of order; the configured objective chain
  // controls conversational order, while both completions are required for retry.
  return { overallPrompted: overall.prompted, overallAnswered: overall.answered, knowledgePrompted: knowledge.prompted, knowledgeAnswered: overall.answered && knowledge.answered };
}
