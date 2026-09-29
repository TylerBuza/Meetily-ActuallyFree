// Run with: node --test tests/lib/summary-markdown.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { blocksToMarkdown, completeSummaryMarkdown, parseSummaryData } from '../../src/lib/summary-markdown.ts';
import { extractActionItems } from '../../src/lib/action-items.ts';

const text = (value: string) => [{ type: 'text', text: value, styles: {} }];

describe('blocksToMarkdown', () => {
  test('writes headings, lists and quotes', () => {
    const markdown = blocksToMarkdown([
      { type: 'heading', props: { level: 2 }, content: text('Summary') },
      { type: 'paragraph', content: text('We agreed on the pilot.') },
      { type: 'bulletListItem', content: text('First'), children: [{ type: 'bulletListItem', content: text('Nested') }] },
      { type: 'quote', content: text('Ship it') },
    ]);
    assert.equal(markdown, '## Summary\nWe agreed on the pilot.\n- First\n  - Nested\n> Ship it');
  });

  test('keeps tables, so action tables stored as blocks can be read', () => {
    const blocks = [
      { type: 'heading', props: { level: 2 }, content: text('Action items') },
      {
        type: 'table',
        content: {
          type: 'tableContent',
          rows: [
            { cells: [{ type: 'tableCell', content: text('Owner') }, { type: 'tableCell', content: text('Task') }] },
            { cells: [{ type: 'tableCell', content: text('Priya Shah') }, { type: 'tableCell', content: text('Send the terms') }] },
            // Older BlockNote versions store cells as bare inline content.
            { cells: [text('You'), text('Book a | check-in')] },
          ],
        },
      },
    ];
    const markdown = blocksToMarkdown(blocks);
    assert.equal(
      markdown,
      '## Action items\n| Owner | Task |\n| --- | --- |\n| Priya Shah | Send the terms |\n| You | Book a \\| check-in |',
    );
    const result = extractActionItems(markdown);
    assert.equal(result.hadActionSection, true);
    assert.deepEqual(
      result.drafts.map((draft) => [draft.ownerLabel, draft.text]),
      [
        ['Priya Shah', 'Send the terms'],
        ['You', 'Book a | check-in'],
      ],
    );
  });
});

describe('completeSummaryMarkdown', () => {
  test('prefers stored markdown over blocks', () => {
    assert.equal(completeSummaryMarkdown({ markdown: '# A', summary_json: [{ type: 'paragraph', content: text('B') }] }), '# A');
  });

  test('flattens legacy titled sections in order', () => {
    const markdown = completeSummaryMarkdown({
      _section_order: ['decisions', 'summary'],
      summary: { title: 'Summary', blocks: [{ content: 'Short' }] },
      decisions: { title: 'Decisions', blocks: [{ content: 'Go' }] },
    });
    assert.equal(markdown, '## Decisions\n\nGo\n\n## Summary\n\nShort');
  });
});

describe('parseSummaryData', () => {
  test('decodes double-encoded JSON and wraps plain text', () => {
    assert.deepEqual(parseSummaryData('{"markdown":"# Hi"}'), { markdown: '# Hi' });
    assert.deepEqual(parseSummaryData('Just text'), { markdown: 'Just text' });
    assert.equal(parseSummaryData(null), null);
  });
});
