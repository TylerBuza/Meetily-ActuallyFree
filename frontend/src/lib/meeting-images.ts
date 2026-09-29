export interface MeetingImage {
  id: string;
  path: string;
  audioTime: number;
  createdAt: string;
}

export const MEETING_IMAGES_CHANGED = 'meeting-images-changed';
