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

export async function deleteMeetings(meetingIds: string[], deleteLocalFiles = false): Promise<number> {
  let deleted = 0;
  let cleanupFailed = false;
  for (const meetingId of meetingIds) {
    try {
      const result = await invoke<{warning?: string | null}>('api_delete_meeting', { meetingId, deleteLocalFiles });
      if (result?.warning) { cleanupFailed = true; toast.warning(result.warning); }
      Analytics.trackMeetingDeleted(meetingId);
      deleted += 1;
    } catch (error) {
      console.error('Failed to delete meeting', meetingId, error);
      toast.error(String(error));
    }
  }
  if (deleted > 0) {
    announceChange('meetings', { meetingIds });
    announceChange('groups');
    announceChange('actions');
    toast.success(cleanupFailed ? 'Meeting removed; review the file cleanup warning' : deleteLocalFiles
      ? (deleted === 1 ? 'Meeting and local files deleted' : `${deleted} meetings and local files deleted`)
      : (deleted === 1 ? 'Meeting removed from Meetily; files kept' : `${deleted} meetings removed from Meetily; files kept`));
  }
  if (deleted < meetingIds.length) {
    const failed = meetingIds.length - deleted;
    toast.error(`Could not delete ${failed} meeting${failed === 1 ? '' : 's'}`);
  }
  return deleted;
}
