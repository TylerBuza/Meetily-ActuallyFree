ALTER TABLE meetings
ADD COLUMN title_is_manual INTEGER NOT NULL DEFAULT 1
CHECK (title_is_manual IN (0, 1));

-- Preserve unknown legacy titles, but keep recognizable app-generated titles
-- eligible for the first AI-generated meeting name after upgrade.
UPDATE meetings
SET title_is_manual = 0
WHERE title IN ('+ New Call', 'New Meeting')
   OR title GLOB 'Meeting [0-9][0-9]_[0-9][0-9]_[0-9][0-9]_[0-9][0-9]_[0-9][0-9]_[0-9][0-9]'
   OR title GLOB 'Meeting [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]_[0-9][0-9]-[0-9][0-9]-[0-9][0-9]';
