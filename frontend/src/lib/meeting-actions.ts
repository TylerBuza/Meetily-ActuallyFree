/**
 * Meeting operations shared by the sidebar, the library, and the meeting
 * page, so each behaves (and reports) the same way everywhere.
 */
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import Analytics from '@/lib/analytics';
import { announceChange, setMeetingsGroup } from '@/lib/workspace-api';
import { tNow } from '@/i18n/translate';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function renameMeeting(meetingId: string, title: string): Promise<boolean> {
  const next = title.trim();
  if (!next) {
    toast.error(tNow('feedback.meetingNeedsTitle'));
    return false;
  }
  try {
    await invoke('api_save_meeting_title', { meetingId, title: next });
    announceChange('meetings', { meetingId });
    return true;
  } catch (error) {
    toast.error(tNow('feedback.couldNotRenameMeeting'), { description: message(error) });
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
    const count = meetingIds.length;
    const movedTo = groupName != null
      ? tNow(count === 1 ? 'feedback.singleMeetingMovedToGroup' : 'feedback.meetingsMovedToGroup', {
          count,
          group: groupName,
        })
      : count === 1
        ? tNow('feedback.singleMeetingMovedToGroupDefault')
        : tNow('feedback.meetingsMovedToGroupDefault', { count });
    toast.success(
      groupId
        ? movedTo
        : count === 1
          ? tNow('feedback.singleMeetingRemovedFromGroup')
          : tNow('feedback.meetingsRemovedFromGroup', { count }),
    );
    return true;
  } catch (error) {
    toast.error(tNow('feedback.couldNotMoveMeetings'), { description: message(error) });
    return false;
  }
}

export async function deleteMeetings(meetingIds: string[]): Promise<number> {
  let deleted = 0;
  for (const meetingId of meetingIds) {
    try {
      await invoke('api_delete_meeting', { meetingId });
      Analytics.trackMeetingDeleted(meetingId);
      deleted += 1;
    } catch (error) {
      console.error('Failed to delete meeting', meetingId, error);
    }
  }
  if (deleted > 0) {
    announceChange('meetings', { meetingIds });
    announceChange('groups');
    announceChange('actions');
    toast.success(deleted === 1 ? tNow('feedback.meetingDeleted') : tNow('feedback.meetingsDeleted', { count: deleted }));
  }
  if (deleted < meetingIds.length) {
    const failed = meetingIds.length - deleted;
    toast.error(
      failed === 1
        ? tNow('feedback.couldNotDeleteMeeting', { count: failed })
        : tNow('feedback.couldNotDeleteMeetings', { count: failed }),
    );
  }
  return deleted;
}
