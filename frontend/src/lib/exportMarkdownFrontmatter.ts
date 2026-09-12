import { isLinkableSpeakerName } from './speakerLabels';

export type LinkStyle = 'generic' | 'obsidian';

export interface FrontmatterInput {
  title: string;
  meetingId: string;
  date: Date;
  /** Already deduped, already filtered to identified speakers only. */
  attendees: string[];
  linkStyle: LinkStyle;
}

function yamlString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/[\x00-\x1f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
  return `"${escaped}"`;
}

function isoDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Renders one transcript line's speaker mention, e.g. "**Jordan Alvarez:**".
 * Obsidian style wikilinks the name only when it's a real identified speaker
 * (see isLinkableSpeakerName) — "Speaker 2" and "You" render the same in
 * both styles, since there's no person note to link to.
 */
export function formatSpeakerMention(speaker: string, style: LinkStyle): string {
  const label = style === 'obsidian' && isLinkableSpeakerName(speaker) ? `[[${speaker}]]` : speaker;
  return `**${label}:**`;
}

/**
 * Builds a YAML frontmatter block for a Markdown export. Only used on the
 * .md export path — PDF/DOCX/TXT/JSON/clipboard exports never see this.
 */
export function buildFrontmatter(input: FrontmatterInput): string {
  const lines = ['---'];
  lines.push(`title: ${yamlString(input.title)}`);
  lines.push(`meeting_id: ${yamlString(input.meetingId)}`);
  lines.push(`date: ${isoDate(input.date)}`);
  if (input.attendees.length > 0) {
    lines.push('attendees:');
    for (const name of input.attendees) {
      const value = input.linkStyle === 'obsidian' ? `[[${name}]]` : name;
      lines.push(`  - ${yamlString(value)}`);
    }
  }
  lines.push('tags:');
  lines.push('  - meetily');
  lines.push('---');
  return lines.join('\n');
}
