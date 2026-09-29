-- Summaries used to rename a meeting after the first heading of its notes, and
-- small models often left the template's "<Add Title here>" in that heading.
-- Those automatic titles go back to a recognizable default, which the app shows
-- with the meeting's day and time. Titles the user typed are not touched.
UPDATE meetings
SET title = 'Meeting ' || strftime('%Y-%m-%d_%H-%M-%S', created_at)
WHERE title_is_manual = 0
  AND lower(trim(title, ' <>')) = 'add title here'
  AND strftime('%Y-%m-%d_%H-%M-%S', created_at) IS NOT NULL;

UPDATE transcript_chunks
SET meeting_name = (SELECT title FROM meetings WHERE meetings.id = transcript_chunks.meeting_id)
WHERE lower(trim(meeting_name, ' <>')) = 'add title here'
  AND meeting_id IN (SELECT id FROM meetings);
