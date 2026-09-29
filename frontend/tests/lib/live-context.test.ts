// Run with: node --test tests/lib/live-context.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLiveContext, lineAt, questionKeywords, stamp, type LiveLine } from '../../src/lib/live-context.ts';

const line = (index: number, text: string, speaker = 'Speaker 1'): LiveLine => ({ id: `l${index}`, time: index * 10, speaker, text });

describe('stamp', () => {
  test('matches the citation format', () => {
    assert.equal(stamp(5), '0:05');
    assert.equal(stamp(754), '12:34');
    assert.equal(stamp(3723), '1:02:03');
  });
});

describe('questionKeywords', () => {
  test('keeps meaningful words only', () => {
    assert.deepEqual(questionKeywords('What did Priya say about the budget?'), ['priya', 'budget']);
  });
});

describe('buildLiveContext', () => {
  test('returns everything when it fits, with timestamps and speakers', () => {
    const context = buildLiveContext([line(0, 'Hello there', 'You'), line(1, 'Hi')], 'anything', 1000, (s) => (s === 'You' ? 'Jay (you)' : s));
    assert.equal(context, '[0:00] Jay (you): Hello there\n[0:10] Speaker 1: Hi');
  });

  test('keeps recent talk and older lines that match the question', () => {
    const lines = Array.from({ length: 200 }, (_, index) => line(index, `filler sentence number ${index} with padding text`));
    lines[12] = line(12, 'The budget for the pilot is forty thousand');
    const context = buildLiveContext(lines, 'What was the budget?', 1200);
    assert.ok(context.length <= 1200 + 20, `context too long: ${context.length}`);
    assert.match(context, /budget for the pilot/);
    assert.match(context, /number 199 /);
    assert.doesNotMatch(context, /number 100 /);
    assert.match(context, /…/);
  });

  test('without a match it is just the most recent lines', () => {
    const lines = Array.from({ length: 100 }, (_, index) => line(index, `sentence ${index} goes on for a little while`));
    const context = buildLiveContext(lines, 'summarize', 500);
    const first = context.split('\n').find((entry) => entry !== '…')!;
    assert.match(context, /sentence 99 /);
    assert.ok(!context.includes('sentence 0 '), 'oldest line should be dropped');
    assert.match(first, /^\[\d+:\d{2}\]/);
  });
});

describe('lineAt', () => {
  test('finds the line being spoken at a time', () => {
    const lines = [line(0, 'a'), line(1, 'b'), line(2, 'c')];
    assert.equal(lineAt(lines, 14)?.id, 'l1');
    assert.equal(lineAt(lines, 0)?.id, 'l0');
    assert.equal(lineAt(lines, 999)?.id, 'l2');
    assert.equal(lineAt([], 5), null);
  });
});
