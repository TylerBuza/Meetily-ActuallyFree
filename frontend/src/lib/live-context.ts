/**
 * What Ask AI reads during a live call: transcript lines with timestamps, so
 * answers can cite moments like [12:34], trimmed to a character budget.
 * Recent talk matters most, but lines that share words with the question are
 * kept even when they are older. Unit tested in tests/lib/live-context.test.ts.
 */

export interface LiveLine {
  id: string;
  /** Seconds from the start of the recording. */
  time: number;
  speaker?: string | null;
  text: string;
}

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'been', 'before', 'being', 'could', 'did', 'does', 'doing', 'from', 'have', 'having',
  'into', 'just', 'last', 'like', 'make', 'many', 'more', 'most', 'much', 'only', 'other', 'over', 'said', 'same', 'says',
  'should', 'some', 'such', 'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'thing', 'things', 'this',
  'those', 'very', 'want', 'were', 'what', 'when', 'where', 'which', 'while', 'will', 'with', 'would', 'your', 'minutes',
  'meeting', 'call', 'summarize', 'summary', 'tell', 'explain',
]);

/** Words worth searching the transcript for. */
export function questionKeywords(question: string): string[] {
  return [
    ...new Set(
      question
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word.length >= 4 && !STOP_WORDS.has(word)),
    ),
  ];
}

/** "4:05", "12:34", "1:02:03": the form Ask AI cites. */
export function stamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function buildLiveContext(
  lines: LiveLine[],
  question: string,
  budget = 12_000,
  label: (speaker: string) => string = (speaker) => speaker,
): string {
  const formatted = lines.map(
    (line) => `[${stamp(line.time)}] ${line.speaker?.trim() ? `${label(line.speaker.trim())}: ` : ''}${line.text.trim()}`,
  );
  const total = formatted.reduce((sum, text) => sum + text.length + 1, 0);
  if (total <= budget) return formatted.join('\n');

  const kept = new Set<number>();
  let used = 0;
  const take = (index: number): boolean => {
    if (index < 0 || index >= formatted.length || kept.has(index)) return true;
    const cost = formatted[index].length + 1;
    if (used + cost > budget) return false;
    kept.add(index);
    used += cost;
    return true;
  };

  // Lines that match the question, newest first, with a neighbour either side.
  const words = questionKeywords(question);
  if (words.length > 0) {
    const matchBudget = budget * 0.4;
    for (let index = lines.length - 1; index >= 0 && used < matchBudget; index--) {
      const text = lines[index].text.toLowerCase();
      if (words.some((word) => text.includes(word))) {
        take(index - 1);
        take(index);
        take(index + 1);
      }
    }
  }

  // Then the most recent talk, until the budget runs out.
  for (let index = lines.length - 1; index >= 0; index--) {
    if (!take(index)) break;
  }

  const out: string[] = [];
  let previous = -1;
  for (const index of [...kept].sort((a, b) => a - b)) {
    if (index > previous + 1) out.push('…');
    out.push(formatted[index]);
    previous = index;
  }
  return out.join('\n');
}

/** The transcript line closest to a cited time, for jumping to it. */
export function lineAt(lines: LiveLine[], seconds: number): LiveLine | null {
  let best: LiveLine | null = null;
  for (const line of lines) {
    if (line.time <= seconds + 0.5) best = line;
    else break;
  }
  return best ?? lines[0] ?? null;
}
