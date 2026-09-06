import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { completeSummaryMarkdown, InsightTabs } from './InsightTabs';

describe('complete summary rendering', () => {
  test('preserves multilingual headings, nested lists, tables, and fenced code', () => {
    const markdown = '# Reuni\u00e3o\n\n## Decis\u00f5es\n\n- Primeiro\n  - Segundo\n\n| Campo | Valor |\n| --- | --- |\n| Extra | Preservado |\n\n```text\n## Not a section\n```\n\n## \u969c\u5bb3\n\nSem perdas.';
    expect(completeSummaryMarkdown({ markdown })).toBe(markdown);
    const html = renderToStaticMarkup(<InsightTabs aiSummary={{ markdown }} transcripts={[]} />);
    expect(html).toContain('Decis\u00f5es');
    expect(html).toContain('<table>');
    expect(html).toContain('Preservado');
    expect(html).toContain('## Not a section');
    expect(html).toContain('\u969c\u5bb3');
    expect(html).toContain('Sem perdas.');
  });

  test('preserves every legacy section in its declared order without hidden cache', () => {
    const summary = {
      _section_order: ['second', 'first'],
      first: { title: 'Custom heading', blocks: [{ content: 'First' }] },
      second: { title: 'Decisions', blocks: Array.from({ length: 6 }, (_, i) => ({ content: `Decision ${i}` })) },
      english_cache: { blocks: [{ content: 'Hidden cache' }] },
    };
    const markdown = completeSummaryMarkdown(summary);
    expect(markdown.indexOf('Decisions')).toBeLessThan(markdown.indexOf('Custom heading'));
    expect(markdown).toContain('Decision 5');
    expect(markdown).not.toContain('Hidden cache');
  });
});
