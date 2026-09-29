CREATE TABLE groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    normalized_name TEXT NOT NULL UNIQUE CHECK (length(normalized_name) > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

ALTER TABLE meetings ADD COLUMN group_id TEXT;

CREATE INDEX idx_meetings_group_id ON meetings(group_id);
CREATE INDEX idx_groups_name ON groups(name);
