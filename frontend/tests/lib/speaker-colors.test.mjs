import assert from 'node:assert/strict';
import { test } from 'node:test';
import { colorForName } from '../../src/lib/group-colors.ts';
import {
  speakerColor,
  speakerColorIndexMap,
  speakerColorValue,
  speakerDot,
  speakerKey,
} from '../../src/utils/speakerUtils.ts';

test('renaming speakers retains distinct meeting colors in the transcript and sidebar', () => {
  const before = speakerColorIndexMap(['You', 'Speaker 1', 'Speaker 2', 'Speaker 3']);
  const after = speakerColorIndexMap(['Andrew (You)', 'Dr. Andrea Love', 'AI Guy', 'Guy']);
  assert.equal(new Set(after.values()).size, 3);
  assert.deepEqual([...after.values()], [...before.values()]);
  for (const name of ['Dr. Andrea Love', 'AI Guy', 'Guy']) {
    const index = after.get(speakerKey(name));
    assert.ok(speakerDot(name, index).startsWith('bg-'));
    assert.ok(speakerColor(name, index).startsWith('text-'));
  }
  // The user keeps the theme accent however their label is written.
  assert.equal(speakerDot('Andrew (You)'), 'bg-af-accent');
});

test('unnamed voices get distinct colours in the order they first spoke', () => {
  const slots = speakerColorIndexMap(['Speaker 2', 'You', 'Speaker 1', 'Speaker 3']);
  const dots = ['Speaker 2', 'Speaker 1', 'Speaker 3'].map((label) => speakerDot(label, slots.get(speakerKey(label))));
  assert.equal(new Set(dots).size, 3);
});

test('a named person is drawn in their avatar colour, whatever their slot', () => {
  const color = colorForName('Tom Becker');
  for (const slot of [0, 3, undefined]) {
    assert.equal(speakerDot('Tom Becker', slot), `bg-[var(--af-c-${color})]`);
    assert.equal(speakerColor('Tom Becker', slot), `text-[var(--af-c-${color})]`);
    assert.equal(speakerColorValue('Tom Becker', slot), `var(--af-c-${color})`);
  }
  assert.equal(speakerColorValue('You'), 'var(--af-accent)');
});
