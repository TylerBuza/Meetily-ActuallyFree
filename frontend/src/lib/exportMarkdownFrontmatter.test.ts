import { describe, expect, test } from 'bun:test';
import { buildFrontmatter, formatSpeakerMention } from './exportMarkdownFrontmatter';

describe('formatSpeakerMention', () => {
  test('generic style never adds wikilinks', () => {
    expect(formatSpeakerMention('Jordan Alvarez', 'generic')).toBe('**Jordan Alvarez:**');
    expect(formatSpeakerMention('Speaker 2', 'generic')).toBe('**Speaker 2:**');
  });

  test('obsidian style wikilinks only identified names', () => {
    expect(formatSpeakerMention('Jordan Alvarez', 'obsidian')).toBe('**[[Jordan Alvarez]]:**');
  });

  test('obsidian style leaves generated and placeholder labels plain', () => {
    expect(formatSpeakerMention('Speaker 2', 'obsidian')).toBe('**Speaker 2:**');
    expect(formatSpeakerMention('You', 'obsidian')).toBe('**You:**');
  });
});

describe('buildFrontmatter', () => {
  const baseInput = {
    title: 'Weekly Sync',
    meetingId: 'mtg-123',
    date: new Date(2026, 8, 11, 14, 30), // local time, not UTC — matches how isoDate reads a Date
    attendees: [] as string[],
    linkStyle: 'generic' as const,
  };

  test('always includes title, meeting_id, date, and tags', () => {
    const fm = buildFrontmatter(baseInput);
    expect(fm).toContain('title: "Weekly Sync"');
    expect(fm).toContain('meeting_id: "mtg-123"');
    expect(fm).toContain('date: 2026-09-11');
    expect(fm).toContain('tags:\n  - meetily');
    expect(fm.startsWith('---\n')).toBe(true);
    expect(fm.endsWith('\n---')).toBe(true);
  });

  test('omits the attendees key entirely when there are none', () => {
    const fm = buildFrontmatter(baseInput);
    expect(fm).not.toContain('attendees');
  });

  test('generic style lists attendees as plain quoted strings', () => {
    const fm = buildFrontmatter({ ...baseInput, attendees: ['Jordan Alvarez', 'Sam Lee'] });
    expect(fm).toContain('attendees:\n  - "Jordan Alvarez"\n  - "Sam Lee"');
  });

  test('obsidian style wikilinks every attendee', () => {
    const fm = buildFrontmatter({ ...baseInput, attendees: ['Jordan Alvarez'], linkStyle: 'obsidian' });
    expect(fm).toContain('  - "[[Jordan Alvarez]]"');
  });

  test('escapes double quotes and backslashes in the title', () => {
    const fm = buildFrontmatter({ ...baseInput, title: 'Review "Q3" plan \\ notes' });
    expect(fm).toContain('title: "Review \\"Q3\\" plan \\\\ notes"');
  });

  test('escapes newlines so a title cannot break out of the frontmatter block', () => {
    const fm = buildFrontmatter({ ...baseInput, title: 'Q3 Review\n---\ninjected: true' });
    const delimiterCount = fm.split('\n').filter((line) => line === '---').length;
    expect(delimiterCount).toBe(2);
    expect(fm).toContain('title: "Q3 Review\\n---\\ninjected: true"');
  });
});
