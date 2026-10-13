import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleFollowUpComplete } from './knowledge-base.js';
import type { StudySession } from './state.js';

function study(available: boolean): StudySession {
  return {
    id: 'sample-flow', createdAt: '2026-10-09T10:00:00.000Z', storeUrl: '/shop?session=sample-flow',
    phase: 'first_attempt_done', firstAttemptCompletedAt: '2026-10-09T10:01:00.000Z', repair: { status: 'ready' },
    events: [
      { id: 'lookup', at: '2026-10-09T10:01:01.000Z', type: 'sample_issue_lookup', detail: { available } },
    ],
  };
}

test('holds the legacy follow-up completion gate until the sample question has been prompted and answered', () => {
  const session = study(true);
  assert.equal(sampleFollowUpComplete(session), false);
  session.events.push({ id: 'prompt', at: '2026-10-09T10:01:02.000Z', type: 'sample_question_prompted', detail: { questionAsked: true } });
  assert.equal(sampleFollowUpComplete(session), false);
  session.events.push({ id: 'answer', at: '2026-10-09T10:01:03.000Z', type: 'utterance', detail: { role: 'user', speech: 'Yes, I had that problem.' } });
  assert.equal(sampleFollowUpComplete(session), true);
});

test('holds the legacy follow-up completion gate for the answer to the latest post-journey follow-up', () => {
  const session = study(true);
  session.events.push({ id: 'prompt', at: '2026-10-09T10:01:02.000Z', type: 'sample_question_prompted', detail: { questionAsked: true } });
  session.events.push({ id: 'answer', at: '2026-10-09T10:01:03.000Z', type: 'utterance', detail: { role: 'user', speech: 'No, color search was fine for me.' } });
  session.events.push({ id: 'follow-up', at: '2026-10-09T10:01:04.000Z', type: 'utterance', detail: { role: 'pal', speech: 'How did you narrow down the colors you wanted?' } });
  assert.equal(sampleFollowUpComplete(session), false);
  session.events.push({ id: 'follow-up-answer', at: '2026-10-09T10:01:05.000Z', type: 'utterance', detail: { role: 'user', speech: 'I looked through the product photos.' } });
  assert.equal(sampleFollowUpComplete(session), true);
});

test('skips the answer gate only when sample notes have no issue', () => {
  const session = study(false);
  assert.equal(sampleFollowUpComplete(session), false);
  session.events.push({ id: 'prompt', at: '2026-10-09T10:01:02.000Z', type: 'sample_question_prompted', detail: { questionAsked: false } });
  assert.equal(sampleFollowUpComplete(session), true);
});
