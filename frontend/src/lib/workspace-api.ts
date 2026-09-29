/**
 * Typed wrappers for the workspace commands that tie meetings, groups,
 * contacts, notes and action items together. Screens import from here instead
 * of calling `invoke` with ad-hoc shapes, so the Rust structs have one mirror.
 */
import { invoke } from '@tauri-apps/api/core';
import type { GroupSchedule } from '@/lib/schedule';
import { readPendingGroup, writePendingGroup } from '@/lib/groups';

// ---- Groups ---------------------------------------------------------------

export type GroupKind = 'recurring' | 'customer' | 'team' | 'project' | 'other';

export interface GroupSummary {
  id: string;
  name: string;
  color?: string | null;
  kind?: GroupKind | null;
  description?: string | null;
  schedule?: GroupSchedule | null;
  meetingCount: number;
  lastMeetingAt?: string;
  lastMeetingId?: string;
  lastMeetingTitle?: string;
  createdAt: string;
}

export interface GroupMember {
  personId: string;
  displayName: string;
  meetingCount: number;
}

export interface GroupMeetingRow {
  meetingId: string;
  title: string;
  createdAt: string;
  durationSeconds?: number;
  present: string[];
}

export interface GroupDetail extends GroupSummary {
  frequent: GroupMember[];
  rare: GroupMember[];
  meetings: GroupMeetingRow[];
}

export interface GroupInput {
  name: string;
  color?: string | null;
  kind?: GroupKind | null;
  description?: string | null;
  schedule?: GroupSchedule | null;
}

export const GROUP_KINDS: Array<{ id: GroupKind; label: string; hint: string }> = [
  { id: 'recurring', label: 'Recurring meeting', hint: 'Standups, 1:1s, weekly syncs' },
  { id: 'customer', label: 'Customer', hint: 'Every call with one account' },
  { id: 'team', label: 'Team', hint: 'A team you meet with' },
  { id: 'project', label: 'Project', hint: 'Meetings about one piece of work' },
  { id: 'other', label: 'Other', hint: 'Anything else' },
];

/** Short label for a group's kind; nothing for 'other'. */
export function kindLabel(kind?: string | null): string | null {
  if (!kind || kind === 'other') return null;
  return GROUP_KINDS.find((entry) => entry.id === kind)?.label ?? null;
}

export const listGroups = () => invoke<GroupSummary[]>('api_list_groups');
export const getGroup = (groupId: string, query?: string) =>
  invoke<GroupDetail>('api_get_group', { groupId, query: query?.trim() || null });
export const createGroup = (input: GroupInput) =>
  invoke<GroupSummary>('api_create_group', {
    name: input.name,
    color: input.color ?? null,
    kind: input.kind ?? null,
    description: input.description ?? null,
    schedule: input.schedule ?? null,
  });
export const updateGroup = (groupId: string, input: GroupInput) =>
  invoke<GroupSummary>('api_update_group', {
    groupId,
    name: input.name,
    color: input.color ?? null,
    kind: input.kind ?? null,
    description: input.description ?? null,
    schedule: input.schedule ?? null,
  });
export const deleteGroup = async (groupId: string) => {
  await invoke<void>('api_delete_group', { groupId });
  // A recording can't be filed into a group that no longer exists.
  if (readPendingGroup()?.id === groupId) writePendingGroup(null);
};
export const getMeetingGroup = (meetingId: string) =>
  invoke<GroupSummary | null>('api_get_meeting_group', { meetingId });
export const setMeetingGroup = (meetingId: string, groupId: string | null) =>
  invoke<void>('api_set_meeting_group', { meetingId, groupId });
export const setMeetingsGroup = (meetingIds: string[], groupId: string | null) =>
  invoke<number>('api_set_meetings_group', { meetingIds, groupId });

// ---- People ---------------------------------------------------------------

export interface GroupRef {
  id: string;
  name: string;
  color?: string | null;
  meetingCount?: number;
}

export interface ContactRow {
  id: string;
  displayName: string;
  email?: string | null;
  company?: string | null;
  role?: string | null;
  phone?: string | null;
  meetingCount: number;
  lastSeenAt?: string;
  groups: GroupRef[];
}

export interface PersonInput {
  displayName: string;
  email?: string | null;
  company?: string | null;
  role?: string | null;
  phone?: string | null;
}

export const listPeople = () => invoke<ContactRow[]>('api_list_people');
export const createPerson = (input: PersonInput) =>
  invoke<ContactRow>('api_create_person', {
    displayName: input.displayName,
    email: input.email ?? null,
    company: input.company ?? null,
    role: input.role ?? null,
    phone: input.phone ?? null,
  });
export const updatePerson = (personId: string, input: PersonInput) =>
  invoke<ContactRow>('api_update_person', {
    personId,
    displayName: input.displayName,
    email: input.email ?? null,
    company: input.company ?? null,
    role: input.role ?? null,
    phone: input.phone ?? null,
  });
export const mergePeople = (sourceId: string, targetId: string) =>
  invoke<ContactRow>('api_merge_people', { sourceId, targetId });
export const deletePerson = (personId: string) => invoke<void>('api_delete_person', { personId });
export const updatePersonNotes = (personId: string, notes: string) =>
  invoke<void>('api_update_person_notes', { personId, notes });

// ---- Action items -----------------------------------------------------------

export interface ActionItem {
  id: string;
  meetingId: string;
  meetingTitle: string;
  meetingCreatedAt: string;
  groupId?: string | null;
  text: string;
  ownerLabel?: string | null;
  personId?: string | null;
  personName?: string | null;
  dueText?: string | null;
  done: boolean;
  doneAt?: string | null;
  source: 'ai' | 'user';
  edited: boolean;
  audioTime?: number | null;
  transcriptId?: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface ActionItemDraft {
  text: string;
  ownerLabel?: string | null;
  dueText?: string | null;
  audioTime?: number | null;
  transcriptId?: string | null;
}

export interface ActionItemFilter {
  meetingId?: string;
  personId?: string;
  groupId?: string;
  openOnly?: boolean;
  limit?: number;
}

export const listActionItems = (filter: ActionItemFilter = {}) =>
  invoke<ActionItem[]>('api_list_action_items', {
    meetingId: filter.meetingId ?? null,
    personId: filter.personId ?? null,
    groupId: filter.groupId ?? null,
    openOnly: filter.openOnly ?? false,
    limit: filter.limit ?? null,
  });
export const createActionItem = (meetingId: string, draft: ActionItemDraft & { personId?: string | null }) =>
  invoke<ActionItem>('api_create_action_item', {
    meetingId,
    text: draft.text,
    ownerLabel: draft.ownerLabel ?? null,
    personId: draft.personId ?? null,
    dueText: draft.dueText ?? null,
    audioTime: draft.audioTime ?? null,
    transcriptId: draft.transcriptId ?? null,
  });
export const updateActionItem = (item: Pick<ActionItem, 'id' | 'text' | 'done'> & Partial<ActionItem>) =>
  invoke<ActionItem>('api_update_action_item', {
    id: item.id,
    text: item.text,
    ownerLabel: item.ownerLabel ?? null,
    personId: item.personId ?? null,
    dueText: item.dueText ?? null,
    done: item.done,
  });
export const deleteActionItem = (id: string) => invoke<void>('api_delete_action_item', { id });
export const syncAiActionItems = (meetingId: string, items: ActionItemDraft[], sourceFingerprint: string) =>
  invoke<ActionItem[]>('api_sync_ai_action_items', { meetingId, items, sourceFingerprint });
export const listUnsyncedActionMeetings = () => invoke<string[]>('api_list_unsynced_action_meetings');

// ---- Meeting notes, audio, and Q&A ---------------------------------------------

export interface MeetingNotes {
  markdown?: string | null;
  json?: unknown[] | null;
  updatedAt: string;
}

export const getMeetingNotes = (meetingId: string) =>
  invoke<MeetingNotes | null>('api_get_meeting_notes', { meetingId });
export const saveMeetingNotes = (meetingId: string, markdown: string | null, json: unknown[] | null) =>
  invoke<void>('api_save_meeting_notes', { meetingId, markdown, json });

export interface MeetingAudio {
  path: string | null;
  micPath: string | null;
  systemPath: string | null;
}

export const getMeetingAudio = (meetingId: string) => invoke<MeetingAudio>('api_get_meeting_audio', { meetingId });

export interface AskTurn {
  question: string;
  answer: string;
}

export const askMeeting = (meetingId: string, question: string, history: AskTurn[] = []) =>
  invoke<string>('api_ask_meeting', { meetingId, question, history });

// ---- Cross-view refresh ---------------------------------------------------------

/**
 * Screens that show the same records (a meeting's group in the sidebar and
 * in its header, an action item on the meeting and the person page) listen
 * for these so a change in one place shows up everywhere without a reload.
 */
export type WorkspaceChange = 'groups' | 'people' | 'actions' | 'meetings' | 'notes';

const CHANGE_EVENT = 'af-workspace-change';

export function announceChange(kind: WorkspaceChange, detail?: Record<string, unknown>) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { kind, ...detail } }));
}

export function onWorkspaceChange(
  kinds: WorkspaceChange[],
  handler: (detail: { kind: WorkspaceChange } & Record<string, unknown>) => void,
): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent).detail as { kind: WorkspaceChange } & Record<string, unknown>;
    if (kinds.includes(detail.kind)) handler(detail);
  };
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}
