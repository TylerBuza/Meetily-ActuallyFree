import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeSummary, shortTopicLabel } from '../../src/lib/summary-buckets.ts';

test('All meetings reads Key Topics from saved Markdown and JSON summaries', () => {
  const markdown = '## Summary\nThe team agreed on the launch.\n## Key Topics\n- Launch date\n- Budget';
  const expected = ['Launch date', 'Budget'];
  assert.deepEqual(normalizeSummary(markdown).topics, expected);
  assert.deepEqual(normalizeSummary(JSON.stringify({ markdown })).topics, expected);
  assert.deepEqual(normalizeSummary(JSON.stringify(JSON.stringify({ markdown }))).topics, expected);
  assert.deepEqual(normalizeSummary({
    Overview: { title: 'Summary', blocks: [{ content: 'The team agreed on the launch.' }] },
    KeyTopics: { title: 'Key Topics', blocks: expected.map(content => ({ content })) },
  }).topics, expected);
});

test('All meetings topic chips show only short labels from explained topic bullets', () => {
  assert.equal(shortTopicLabel('**Personal Roasts:** Scarlett teased Chris about his outfit.'), 'Personal Roasts');
  assert.equal(shortTopicLabel('- **Pop Culture References**: The pair discussed a film.'), 'Pop Culture References');
  assert.equal(shortTopicLabel('Dynamic: The conversation stayed playful.'), 'Dynamic');
});
