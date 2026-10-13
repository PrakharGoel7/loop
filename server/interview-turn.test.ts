import assert from 'node:assert/strict';
import { test } from 'node:test';
import { objectiveEvent } from '../shared/objective-event.js';
import { awaitingPostJourneyAnswer, debriefFollowupKey, debriefProgress, isShopperUtterance, type InterviewTurnEvent } from '../shared/interview-turn.js';

const checkout = '2026-10-09T10:00:00.000Z';
const utterance = (at: string, role: string, speech: string): InterviewTurnEvent => ({ at, type: 'utterance', detail: { role, speech } });

test('waits for the answer to a question asked after checkout', () => {
  const events = [
    utterance('2026-10-09T09:59:00.000Z', 'pal', 'What size are you considering?'),
    utterance('2026-10-09T10:01:00.000Z', 'pal', 'What information would have helped you choose?'),
  ];
  assert.equal(awaitingPostJourneyAnswer(events, checkout), true);
  events.push(utterance('2026-10-09T10:02:00.000Z', 'user', 'The measurements for each size.'));
  assert.equal(awaitingPostJourneyAnswer(events, checkout), false);
});

test('a new follow-up requires its own answer before retry', () => {
  const events = [
    utterance('2026-10-09T10:01:00.000Z', 'pal', 'What information would have helped?'),
    utterance('2026-10-09T10:02:00.000Z', 'user', 'Measurements.'),
    utterance('2026-10-09T10:03:00.000Z', 'pal', 'How would you use those measurements?'),
  ];
  assert.equal(awaitingPostJourneyAnswer(events, checkout), true);
  events.push(utterance('2026-10-09T10:04:00.000Z', 'user', 'I would compare them to a shirt I own.'));
  assert.equal(awaitingPostJourneyAnswer(events, checkout), false);
});

test('earlier questions and statements do not hold a ready revision', () => {
  assert.equal(awaitingPostJourneyAnswer([
    utterance('2026-10-09T09:59:00.000Z', 'pal', 'What size are you considering?'),
    utterance('2026-10-09T10:01:00.000Z', 'pal', 'I see. Thanks for sharing.'),
  ], checkout), false);
});

const objective = (name: string, type = 'objective_completed', at = '2026-10-09T10:00:03.000Z'): InterviewTurnEvent => ({ at, type, detail: { objective_name: name, output_variables: {} } });
const overall = 'collect_overall_experience';
const knowledge = 'discuss_knowledge_base_concern';

test('objective activation does not imply an answer; completion needs no playback or transcript echo', () => {
  const events = [objective(overall, 'objective_activated')];
  assert.deepEqual(debriefProgress(events, checkout), { overallPrompted: true, overallAnswered: false, knowledgePrompted: false, knowledgeAnswered: false });
  events.push(objective(overall));
  assert.equal(debriefProgress(events, checkout).overallAnswered, true);
  events.push(objective(knowledge, 'objective_activated'));
  assert.equal(debriefProgress(events, checkout).knowledgeAnswered, false);
  events.push(objective(knowledge));
  assert.equal(debriefProgress(events, checkout).knowledgeAnswered, true);
});

test('both objectives are required even when completion callbacks arrive out of order', () => {
  const events = [objective(knowledge)];
  assert.equal(debriefProgress(events, checkout).knowledgeAnswered, false);
  events.push(objective(overall));
  assert.equal(debriefProgress(events, checkout).knowledgeAnswered, true);
});

test('precheckout and undated objective completions cannot complete debrief', () => {
  const events = [objective(overall, 'objective_completed', '2026-10-09T09:59:59.000Z'), objective(knowledge, 'objective_completed', '')];
  assert.equal(debriefProgress(events, checkout).overallAnswered, false);
  assert.equal(debriefProgress(events, checkout).knowledgeAnswered, false);
  assert.equal(debriefProgress([objective(overall)]).overallAnswered, false);
  for (const marker of [
    { at: checkout, type: 'checkout_completed' },
    { at: checkout, type: 'phase_changed', detail: { phase: 'first_attempt_done' } },
  ]) assert.equal(debriefProgress([marker, objective(overall)]).overallAnswered, true);
});

test('scripted playback and transcript markers no longer advance objectives', () => {
  const events: InterviewTurnEvent[] = [
    { at: checkout, type: 'overall_question_prompted' },
    { at: checkout, type: 'app_speech_delivered', detail: { marker: 'overall_question_prompted' } },
    utterance('2026-10-09T10:00:01.000Z', 'pal', 'How was it?'),
    utterance('2026-10-09T10:00:02.000Z', 'user', 'Good.'),
  ];
  assert.equal(debriefProgress(events, checkout).overallAnswered, false);
});

test('injected context, blanks, and non-shopper events do not answer a natural question', () => {
  const events = [utterance('2026-10-09T10:00:01.000Z', 'pal', 'How was it?')];
  for (const event of [
    utterance('2026-10-09T10:00:02.000Z', 'user', ' [Loop context] Changes are building.'),
    utterance('2026-10-09T10:00:03.000Z', 'user', ' '),
    utterance('2026-10-09T10:00:04.000Z', 'pal', 'Take your time.'),
    { type: 'tool_result', detail: { role: 'user', speech: 'Ready.' } },
  ]) { assert.equal(isShopperUtterance(event), false); events.push(event); }
  assert.equal(awaitingPostJourneyAnswer(events, checkout), true);
  events.push(utterance('2026-10-09T10:00:05.000Z', 'user', 'The sizes were unclear.'));
  assert.equal(awaitingPostJourneyAnswer(events, checkout), false);
});

const completedDebrief = (): InterviewTurnEvent[] => [
  objective(overall), objective(knowledge),
  utterance('2026-10-09T10:00:04.000Z', 'user', 'Yes, I lost track of another top.'),
];
const followupState = () => ({
  completedAt: checkout, published: false, pending: true, quiet: true, awaitingAnswer: false,
  now: Date.parse('2026-10-09T10:00:10.000Z'), lastActivityAt: Date.parse('2026-10-09T10:00:04.000Z'), lastKey: '',
});

test('one follow-up per real answer after completed objectives and six quiet seconds', () => {
  const events = completedDebrief();
  const state = followupState();
  assert.equal(debriefFollowupKey(events, { ...state, now: state.now - 1 }), null);
  const key = debriefFollowupKey(events, state);
  assert.ok(key);
  assert.equal(debriefFollowupKey(events, { ...state, lastKey: key, now: state.now + 30_000 }), null);
  events.push(utterance('2026-10-09T10:00:11.000Z', 'pal', 'What would make comparison easier?'));
  events.push(utterance('2026-10-09T10:00:12.000Z', 'user', 'Seeing both items side by side.'));
  const next = debriefFollowupKey(events, { ...state, lastKey: key, now: state.now + 8000, lastActivityAt: state.lastActivityAt + 8000 });
  assert.ok(next);
  assert.notEqual(next, key);
});

test('follow-ups stop at publication or while an answer is outstanding or workers have stopped', () => {
  const events = completedDebrief();
  const state = followupState();
  for (const override of [{ completedAt: undefined }, { published: true }, { pending: false }, { quiet: false }, { awaitingAnswer: true }]) {
    assert.equal(debriefFollowupKey(events, { ...state, ...override }), null);
  }
  assert.equal(debriefFollowupKey(events.filter((event) => event.detail && typeof event.detail === 'object' && event.detail.objective_name !== knowledge), state), null);
  assert.equal(debriefFollowupKey(events, { ...state, completedAt: '2026-10-09T10:00:05.000Z' }), null);
});

test('injected context cannot schedule an extra follow-up', () => {
  const events = completedDebrief();
  const state = followupState();
  const key = debriefFollowupKey(events, state);
  assert.ok(key);
  events.push(utterance('2026-10-09T10:00:09.000Z', 'user', '[Loop] Worker is still building.'));
  assert.equal(debriefFollowupKey(events, { ...state, lastKey: key }), null);
});

test('Tavus nested and top-level completion payloads advance persisted debrief state', () => {
  const events: InterviewTurnEvent[] = [{ at: checkout, type: 'checkout_completed' }];
  for (const payload of [
    { event_type: 'conversation.objective.completed', conversation_id: 'call1', properties: { objective_name: overall, output_variables: { overall_experience_response: 'Good.' } } },
    { event_type: 'conversation.objective.completed', conversation_id: 'call1', objective_name: knowledge, output_variables: { knowledge_base_response: 'No, I did not have that problem.' } },
  ]) {
    const decoded = objectiveEvent(payload, 'call1');
    assert.ok(decoded);
    events.push({ ...decoded, at: '2026-10-09T10:00:05.000Z' });
  }
  assert.deepEqual(debriefProgress(events), { overallPrompted: true, overallAnswered: true, knowledgePrompted: true, knowledgeAnswered: true });
});
