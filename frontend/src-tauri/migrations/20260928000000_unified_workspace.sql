-- Groups: a user-chosen color, what the group represents, a note, and an
-- optional user-defined schedule (JSON: weekdays, time, cadence).
ALTER TABLE groups ADD COLUMN color TEXT;
ALTER TABLE groups ADD COLUMN kind TEXT;
ALTER TABLE groups ADD COLUMN description TEXT;
ALTER TABLE groups ADD COLUMN schedule TEXT;

-- People: contact details, and whether the user curated this contact. Curated
-- contacts survive losing their last speaker link; generated ones are pruned.
ALTER TABLE people ADD COLUMN email TEXT;
ALTER TABLE people ADD COLUMN company TEXT;
ALTER TABLE people ADD COLUMN role TEXT;
ALTER TABLE people ADD COLUMN phone TEXT;
ALTER TABLE people ADD COLUMN is_manual INTEGER NOT NULL DEFAULT 0 CHECK (is_manual IN (0, 1));
UPDATE people SET is_manual = 1 WHERE notes IS NOT NULL AND length(trim(notes)) > 0;

-- Summaries: whether the user edited the generated text since it was produced,
-- so regeneration can ask before replacing those edits.
ALTER TABLE summary_processes ADD COLUMN user_edited INTEGER NOT NULL DEFAULT 0 CHECK (user_edited IN (0, 1));

-- Meetings: fingerprint of the summary text action items were last read from.
ALTER TABLE meetings ADD COLUMN action_items_source TEXT;

-- Action items always belong to the meeting they came from. Person, group, and
-- home views are read-only projections of these rows.
CREATE TABLE action_items (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL,
    text TEXT NOT NULL CHECK (length(trim(text)) > 0),
    owner_label TEXT,
    person_id TEXT,
    due_text TEXT,
    done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
    done_at TEXT,
    source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('ai', 'user')),
    edited INTEGER NOT NULL DEFAULT 0 CHECK (edited IN (0, 1)),
    audio_time REAL,
    transcript_id TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
    FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE SET NULL
);

CREATE INDEX idx_action_items_meeting ON action_items(meeting_id, position);
CREATE INDEX idx_action_items_person ON action_items(person_id);
CREATE INDEX idx_action_items_open ON action_items(done, created_at);
