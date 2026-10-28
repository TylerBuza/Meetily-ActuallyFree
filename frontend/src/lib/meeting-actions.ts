/**
 * Meeting operations shared by the sidebar, the library, and the meeting
 * page, so each behaves (and reports) the same way everywhere.
 */
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import Analytics from '@/lib/analytics';
import { announceChange, setMeetingsGroup } from '@/lib/workspace-api';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function renameMeeting(meetingId: string, title: string): Promise<boolean> {
  const next = title.trim();
  if (!next) {
    toast.error('A meeting needs a title');
    return false;
  }
  try {
    await invoke('api_save_meeting_title', { meetingId, title: next });
    announceChange('meetings', { meetingId });
    return true;
  } catch (error) {
    toast.error('Could not rename the meeting', { description: message(error) });
    return false;
  }
}

export async function moveMeetingsToGroup(
  meetingIds: string[],
  groupId: string | null,
  groupName?: string,
): Promise<boolean> {
  if (meetingIds.length === 0) return false;
  try {
    await setMeetingsGroup(meetingIds, groupId);
    announceChange('meetings', { meetingIds });
    announceChange('groups');
    const count = meetingIds.length === 1 ? 'Meeting' : `${meetingIds.length} meetings`;
    toast.success(groupId ? `${count} moved to ${groupName ?? 'the group'}` : `${count} removed from its group`);
    return true;
  } catch (error) {
    toast.error('Could not move the meetings', { description: message(error) });
    return false;
  }
}

/** What `api_delete_meeting` reports about the meeting's audio folder. */
interface DeleteMeetingResult {
  audio_trashed?: boolean;
  /** Set when the meeting had an audio folder that was left in place. */
  audio_kept_reason?: string | null;
}

export async function deleteMeetings(meetingIds: string[]): Promise<number> {
  let deleted = 0;
  const kept: string[] = [];
  for (const meetingId of meetingIds) {
    try {
      const result = await invoke<DeleteMeetingResult | null>('api_delete_meeting', { meetingId });
      Analytics.trackMeetingDeleted(meetingId);
      deleted += 1;
      if (result?.audio_kept_reason) kept.push(result.audio_kept_reason);
    } catch (error) {
      console.error('Failed to delete meeting', meetingId, error);
    }
  }
  if (deleted > 0) {
    announceChange('meetings', { meetingIds });
    announceChange('groups');
    announceChange('actions');
    toast.success(deleted === 1 ? 'Meeting deleted' : `${deleted} meetings deleted`);
  }
  if (kept.length > 0) {
    // The confirm dialog says the audio goes to the Trash; say so when it did not.
    const reasons = [...new Set(kept)].join('; ');
    toast.warning(
      kept.length === 1
        ? "The meeting's audio was kept"
        : `Audio for ${kept.length} meetings was kept`,
      { description: `Not moved to the Trash because ${reasons}.` },
    );
  }
  if (deleted < meetingIds.length) {
    const failed = meetingIds.length - deleted;
    toast.error(`Could not delete ${failed} meeting${failed === 1 ? '' : 's'}`);
  }
  return deleted;
}
