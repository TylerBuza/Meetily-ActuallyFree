/**
 * Sample library for the browser preview (see ./index.ts). Dates are relative
 * to the moment the preview loads so dashboards always look current.
 */

const DAY = 86_400_000;

export interface PreviewMeeting {
  id: string;
  title: string;
  created_at: string;
  duration_seconds: number;
  group_id: string | null;
  folder_path: string;
}

export interface PreviewGroup {
  id: string;
  name: string;
  color: string;
  kind: string;
  description?: string | null;
  schedule?: { weekdays: number[]; time: string; cadence: 'weekly' | 'biweekly' } | null;
}

export interface PreviewPerson {
  id: string;
  displayName: string;
  email?: string | null;
  company?: string | null;
  role?: string | null;
  phone?: string | null;
  notes?: string | null;
}

export interface PreviewTranscript {
  id: string;
  text: string;
  timestamp: string;
  audio_start_time: number;
  audio_end_time: number;
  duration: number;
  speaker?: string;
  confidence?: number;
}

function at(daysAgo: number, hour: number, minute = 0): string {
  const date = new Date(Date.now() - daysAgo * DAY);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

/** Days back to the most recent `weekday` (0 = Sunday), counting today. */
function lastWeekday(weekday: number): number {
  const today = new Date().getDay();
  return (today - weekday + 7) % 7;
}

export const groups: PreviewGroup[] = [
  {
    id: 'group-standup',
    name: 'Weekly Standup',
    color: 'blue',
    kind: 'recurring',
    description: 'Engineering sync. Blockers first.',
    schedule: null,
  },
  { id: 'group-acme', name: 'Acme Corp', color: 'orange', kind: 'customer', description: 'Enterprise pilot.', schedule: null },
  { id: 'group-design', name: 'Design Team', color: 'violet', kind: 'team', description: null, schedule: null },
];

export const people: PreviewPerson[] = [
  { id: 'person-priya', displayName: 'Priya Shah', role: 'Product Manager', company: 'Meetily', email: 'priya@example.com' },
  { id: 'person-marcus', displayName: 'Marcus Lee', role: 'Staff Engineer', company: 'Meetily' },
  { id: 'person-elena', displayName: 'Elena García', role: 'Design Lead', company: 'Meetily' },
  { id: 'person-tom', displayName: 'Tom Becker', role: 'IT Director', company: 'Acme Corp', email: 'tom.becker@acme.test' },
  { id: 'person-sam', displayName: 'Sam Rivera', role: 'Procurement', company: 'Acme Corp' },
];

const thursday = lastWeekday(4);

export const meetings: PreviewMeeting[] = [
  { id: 'meeting-standup-0', title: `Weekly Standup — ${short(at(thursday, 12))}`, created_at: at(thursday, 12, 2), duration_seconds: 1_140, group_id: 'group-standup', folder_path: '/preview/standup-0' },
  { id: 'meeting-acme-review', title: 'Acme pilot security review', created_at: at(0, 9, 30), duration_seconds: 2_710, group_id: 'group-acme', folder_path: '/preview/acme-review' },
  { id: 'meeting-roadmap', title: 'Q4 roadmap planning', created_at: at(1, 15, 5), duration_seconds: 3_420, group_id: null, folder_path: '/preview/roadmap' },
  { id: 'meeting-design-crit', title: 'Onboarding flow critique', created_at: at(2, 11, 0), duration_seconds: 1_980, group_id: 'group-design', folder_path: '/preview/design-crit' },
  { id: 'meeting-standup-1', title: `Weekly Standup — ${short(at(thursday + 7, 12))}`, created_at: at(thursday + 7, 12, 1), duration_seconds: 1_260, group_id: 'group-standup', folder_path: '/preview/standup-1' },
  { id: 'meeting-untitled', title: `Meeting · ${long(at(9, 16, 40))}`, created_at: at(9, 16, 40), duration_seconds: 640, group_id: null, folder_path: '/preview/untitled' },
  { id: 'meeting-acme-kickoff', title: 'Acme pilot kickoff', created_at: at(11, 10, 0), duration_seconds: 3_060, group_id: 'group-acme', folder_path: '/preview/acme-kickoff' },
  { id: 'meeting-standup-2', title: `Weekly Standup — ${short(at(thursday + 14, 12))}`, created_at: at(thursday + 14, 12, 3), duration_seconds: 1_080, group_id: 'group-standup', folder_path: '/preview/standup-2' },
  { id: 'meeting-1on1', title: '1:1 with Priya', created_at: at(16, 14, 0), duration_seconds: 1_800, group_id: null, folder_path: '/preview/1on1' },
  { id: 'meeting-standup-3', title: `Weekly Standup — ${short(at(thursday + 21, 12))}`, created_at: at(thursday + 21, 12, 0), duration_seconds: 1_320, group_id: 'group-standup', folder_path: '/preview/standup-3' },
  { id: 'meeting-standup-4', title: `Weekly Standup — ${short(at(thursday + 28, 12))}`, created_at: at(thursday + 28, 12, 4), duration_seconds: 1_200, group_id: 'group-standup', folder_path: '/preview/standup-4' },
  { id: 'meeting-design-sync', title: 'Design system sync', created_at: at(34, 13, 30), duration_seconds: 2_400, group_id: 'group-design', folder_path: '/preview/design-sync' },
];

function short(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function long(iso: string): string {
  const date = new Date(iso);
  const day = date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day} · ${time}`;
}

/** Which people spoke in which meeting, as the speaker label they carry there. */
export const speakerLinks: Array<{ personId: string; meetingId: string; label: string }> = [
  { personId: 'person-priya', meetingId: 'meeting-acme-review', label: 'Priya Shah' },
  { personId: 'person-tom', meetingId: 'meeting-acme-review', label: 'Tom Becker' },
  { personId: 'person-sam', meetingId: 'meeting-acme-review', label: 'Sam Rivera' },
  { personId: 'person-priya', meetingId: 'meeting-roadmap', label: 'Priya Shah' },
  { personId: 'person-marcus', meetingId: 'meeting-roadmap', label: 'Marcus Lee' },
  { personId: 'person-elena', meetingId: 'meeting-design-crit', label: 'Elena García' },
  { personId: 'person-priya', meetingId: 'meeting-design-crit', label: 'Priya Shah' },
  { personId: 'person-tom', meetingId: 'meeting-acme-kickoff', label: 'Tom Becker' },
  { personId: 'person-priya', meetingId: 'meeting-1on1', label: 'Priya Shah' },
  { personId: 'person-elena', meetingId: 'meeting-design-sync', label: 'Elena García' },
  ...[0, 1, 2, 3, 4].flatMap((index) => [
    { personId: 'person-marcus', meetingId: `meeting-standup-${index}`, label: 'Marcus Lee' },
    ...(index % 2 === 0 ? [{ personId: 'person-priya', meetingId: `meeting-standup-${index}`, label: 'Priya Shah' }] : []),
    ...(index === 3 ? [{ personId: 'person-elena', meetingId: `meeting-standup-${index}`, label: 'Elena García' }] : []),
  ]),
];

const ACME_REVIEW_LINES: Array<[string, string]> = [
  ['You', 'Thanks for making time, everyone. The goal today is to close out the open items from the security questionnaire.'],
  ['Tom Becker', 'Appreciate it. Our main concern is still where the audio ends up. Legal wants it in writing that nothing leaves the laptop.'],
  ['You', 'That part is simple. Recording, transcription and summaries all run locally. Nothing is uploaded unless someone picks a cloud model on purpose.'],
  ['Sam Rivera', 'Can we disable the cloud providers for the whole pilot group?'],
  ['Priya Shah', 'Yes. We can ship a config that only shows local models. I can have that ready by Friday.'],
  ['Tom Becker', 'Good. The second item was SSO. Is that a blocker for the pilot?'],
  ['You', 'Not for the pilot. It is a desktop app with no accounts, so there is nothing to sign in to.'],
  ['Sam Rivera', 'Then the only procurement question left is the support agreement.'],
  ['Priya Shah', 'I will send over the draft support terms after this call.'],
  ['Tom Becker', 'Let us target the pilot start for the first week of next month. Twenty seats to begin with.'],
  ['You', 'That works. I will set up a check-in two weeks after launch to review feedback.'],
  ['Sam Rivera', 'One more thing: we need a data retention statement for the recordings folder.'],
  ['You', 'Recordings stay in a folder you choose. You can delete them any time. I will write that up in the rollout doc.'],
  ['Tom Becker', 'Perfect. I think that covers it from our side.'],
  ['Priya Shah', 'Great. I will circulate notes and the action items by end of day.'],
];

const ROADMAP_LINES: Array<[string, string]> = [
  ['Priya Shah', 'Let us start with the three themes for Q4: speed, reliability, and making the app feel like one product.'],
  ['Marcus Lee', 'On speed, the biggest win is still loading long transcripts. Pagination helped but search needs to jump to the right line.'],
  ['You', 'Agreed. Search should land you on the exact moment, and ideally play the audio from there.'],
  ['Priya Shah', 'That ties into the audio player work. Marcus, can you scope that this week?'],
  ['Marcus Lee', 'Yes. I will have an estimate by Wednesday.'],
  ['You', 'For reliability, the post-call pipeline still fails silently when the model is missing.'],
  ['Marcus Lee', 'We should surface that in the meeting header instead of a toast that disappears.'],
  ['Priya Shah', 'Decision: errors that block a meeting get a persistent banner, not a toast.'],
  ['You', 'I will take the design for the banner and share it Thursday.'],
  ['Priya Shah', 'Last topic, groups. Customers want to see every meeting with one account in one place.'],
  ['Marcus Lee', 'Groups with colors in the sidebar would cover most of that.'],
  ['You', 'Let us plan the groups work for the second half of the quarter.'],
];

function linesFor(meetingId: string): Array<[string, string]> {
  if (meetingId === 'meeting-acme-review') return ACME_REVIEW_LINES;
  if (meetingId === 'meeting-roadmap') return ROADMAP_LINES;
  const speakers = speakerLinks.filter((link) => link.meetingId === meetingId).map((link) => link.label);
  const other = speakers[0] ?? 'Speaker 1';
  return [
    ['You', 'Quick round of updates. What is everyone working on?'],
    [other, 'I finished the review of last week’s changes and I am moving on to the release checklist.'],
    ['You', 'Any blockers?'],
    [other, 'Only waiting on test data from the platform team.'],
    ['You', 'I will follow up with them today.'],
    [speakers[1] ?? other, 'I can help with that if needed.'],
  ];
}

export function transcriptsFor(meetingId: string): PreviewTranscript[] {
  let cursor = 4;
  return linesFor(meetingId).map(([speaker, text], index) => {
    const duration = Math.max(3, Math.round(text.split(' ').length / 2.6));
    const start = cursor;
    cursor += duration + 1.5;
    return {
      id: `${meetingId}-t${index}`,
      text,
      speaker,
      timestamp: new Date(Date.now()).toISOString(),
      audio_start_time: start,
      audio_end_time: start + duration,
      duration,
      confidence: 0.92,
    };
  });
}

export function summaryFor(meetingId: string): string | null {
  if (meetingId === 'meeting-untitled') return null;
  if (meetingId === 'meeting-acme-review') {
    return [
      '## Summary',
      'The team closed the remaining items from Acme’s security questionnaire. Acme confirmed that local-only processing satisfies their legal requirement, SSO is not required for the pilot, and the pilot will start with twenty seats in the first week of next month.',
      '',
      '## Key decisions',
      '- Pilot ships with cloud providers hidden; only local models are available.',
      '- SSO is out of scope for the pilot.',
      '- Pilot starts the first week of next month with 20 seats.',
      '',
      '## Action items',
      '| Owner | Task | Due |',
      '| --- | --- | --- |',
      '| Priya Shah | Prepare a local-models-only configuration for the pilot group | Friday |',
      '| Priya Shah | Send draft support terms to Acme | Today |',
      '| You | Write the data retention statement in the rollout doc | Next week |',
      '| You | Schedule a feedback check-in two weeks after launch | |',
      '',
      '## Open questions',
      '- Who at Acme signs off on the support agreement?',
    ].join('\n');
  }
  if (meetingId === 'meeting-roadmap') {
    return [
      '## Summary',
      'Q4 planning centred on three themes: speed, reliability, and making the app feel like one product.',
      '',
      '## Decisions',
      '- Errors that block a meeting get a persistent banner instead of a toast.',
      '- Groups work is planned for the second half of the quarter.',
      '',
      '## Action items',
      '- Marcus Lee: scope the audio player work and share an estimate by Wednesday',
      '- You: design the persistent error banner and share it Thursday',
    ].join('\n');
  }
  return [
    '## Summary',
    'Round of updates. Release checklist is in progress; the only blocker is test data from the platform team.',
    '',
    '## Action items',
    '- You: follow up with the platform team about test data today',
  ].join('\n');
}
