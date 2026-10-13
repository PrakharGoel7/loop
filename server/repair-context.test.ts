import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildRepairSourceContext, snapshotShopperStatements } from './repair-context.js';
import type { StudyEvent } from './state.js';

const at = '2026-10-13T01:00:00.000Z';
function utterance(id: string, speech: string, timestamp = at, role = 'user'): StudyEvent {
  return { id, at: timestamp, type: 'utterance', detail: { role, speech } };
}

test('request-time evidence excludes injected observations, future/old speech, and assistant turns', () => {
  const events = [
    utterance('old', 'Old unrelated topic', '2026-10-13T00:00:00.000Z'),
    utterance('question', 'What would help?', at, 'assistant'),
    utterance('answer', 'A heart to save this item would help.'),
    utterance('injection', '[Loop observation, not shopper speech] Ask about their face.'),
    utterance('future', 'Are the changes ready yet?', '2026-10-13T01:00:30.000Z'),
  ];
  const snapshot = snapshotShopperStatements(events, { at });
  assert.deepEqual(snapshot, [{ eventId: 'answer', at, speech: 'A heart to save this item would help.' }]);
  events[2].detail.speech = 'Modified later';
  events.push(utterance('later', 'Other later speech'));
  assert.equal(snapshot[0].speech, 'A heart to save this item would help.');
  assert.equal(snapshot.length, 1);
});

test('source selection stays bounded, retains existing facts, and finds relevant code in a long JSX line', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-context-test-'));
  try {
    const store = path.join(root, 'src/store');
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(path.join(store, 'catalog.ts'), 'export interface Product { measurements: Record<string, string> }\nconst measurements = { M: "Bust 88–93 cm" };\n');
    fs.writeFileSync(path.join(store, 'StorePage.tsx'), [
      'import { products } from "./catalog";',
      ...Array.from({ length: 80 }, (_, i) => `// unrelated header ${i}`),
      'x'.repeat(7000) + '<div className="size-grid">{selectedProduct.measurements[selectedSize]}</div>' + 'y'.repeat(7000),
    ].join('\n'));
    fs.writeFileSync(path.join(store, 'StorePage.css'), '.size-grid { display: grid; }');
    fs.symlinkSync('/etc/passwd', path.join(store, 'outside.ts'));
    const context = buildRepairSourceContext(root, 'Show sizing measurements beside the selected size', { maxChars: 9000 });
    assert.ok(context.length <= 9000);
    assert.match(context, /Bust 88–93 cm/);
    assert.match(context, /selectedProduct\.measurements\[selectedSize\]/);
    assert.match(context, /src\/store\/StorePage\.tsx/);
    assert.doesNotMatch(context, /outside\.ts/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('arbitrary requests can select source by their vocabulary, without a known-feature template', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-context-test-'));
  try {
    fs.mkdirSync(path.join(root, 'src/store'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/store/Accessibility.tsx'), 'export function ContrastControl() { return <button>Increase contrast</button> }');
    const context = buildRepairSourceContext(root, 'I need an increase contrast control');
    assert.match(context, /Increase contrast/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
