import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchInterviewPresence } from '../src/interview/interview-presence.js';

for (const event of ['pagehide', 'popstate']) {
  test(`${event} ends once, but switching tabs does not`, () => {
    const events = new EventTarget();
    const requests: string[] = []; const beacons: string[] = [];
    let heartbeat = () => {}; let departures = 0;
    const watch = watchInterviewPresence('study', () => departures++, {
      events, every: fn => { heartbeat = fn; return 1; }, clear: () => {},
      beacon: url => { beacons.push(url); return true; },
      request: async url => { requests.push(url); return new Response(); },
    });
    events.dispatchEvent(new Event('visibilitychange'));
    heartbeat();
    assert.equal(departures, 0);
    assert.equal(requests.length, 2);
    events.dispatchEvent(new Event(event));
    events.dispatchEvent(new Event('pagehide'));
    heartbeat();
    assert.equal(departures, 1);
    assert.deepEqual(beacons, ['/api/sessions/study/conversation/end']);
    assert.equal(requests.length, 2);
    watch.stop();
  });
}
test('failed beacon uses keepalive, while StrictMode cleanup alone does not end', () => {
  const events = new EventTarget(); const requests: RequestInit[] = [];
  let cleared = false;
  const watch = watchInterviewPresence('study', () => {}, {
    events, every: () => 1, clear: () => { cleared = true; }, beacon: () => false,
    request: async (_url, options) => { requests.push(options); return new Response(); },
  });
  watch.stop();
  events.dispatchEvent(new Event('pagehide'));
  assert.equal(requests.length, 1);
  assert.equal(cleared, true);
  watch.depart();
  assert.equal(requests[1].keepalive, true);
});
