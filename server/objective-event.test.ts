import assert from 'node:assert/strict';
import { test } from 'node:test';
import { objectiveEvent } from '../shared/objective-event.js';

test('receives nested, top-level and serialized Tavus objective payloads', () => {
  const properties = { objective_name: 'collect_overall_experience', output_variables: { overall_experience_response: 'Good.' } };
  const common = { event_type: 'conversation.objective.completed', conversation_id: 'call1' };
  const expected = { type: 'objective_completed', detail: properties };
  assert.deepEqual(objectiveEvent({ ...common, properties }, 'call1'), expected);
  assert.deepEqual(objectiveEvent({ ...common, ...properties }, 'call1'), expected);
  assert.deepEqual(objectiveEvent(JSON.stringify({ ...common, properties }), 'call1'), expected);
  assert.equal(objectiveEvent({ ...common, event_type: 'conversation.objective.activated', properties }, 'call1')?.type, 'objective_activated');
});

test('ignores unrelated calls, malformed payloads and non-objective events', () => {
  assert.equal(objectiveEvent({ event_type: 'conversation.objective.completed', conversation_id: 'other', objective_name: 'collect_overall_experience' }, 'call1'), null);
  for (const value of [null, 'invalid json', {}, { event_type: 'conversation.objective.completed' }, { event_type: 'conversation.utterance', objective_name: 'collect_overall_experience' }]) {
    assert.equal(objectiveEvent(value, 'call1'), null);
  }
});
