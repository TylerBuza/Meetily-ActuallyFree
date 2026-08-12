CREATE TABLE people (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
    normalized_name TEXT NOT NULL UNIQUE CHECK (length(normalized_name) > 0),
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE person_speakers (
    person_id TEXT NOT NULL,
    meeting_id TEXT NOT NULL,
    speaker_label TEXT NOT NULL,
    PRIMARY KEY (person_id, meeting_id, speaker_label),
    UNIQUE (meeting_id, speaker_label),
    FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

CREATE INDEX idx_person_speakers_person_id ON person_speakers(person_id);
CREATE INDEX idx_person_speakers_meeting_id ON person_speakers(meeting_id);
CREATE INDEX idx_people_display_name ON people(display_name);

-- A custom label is an identity claim. Equal lower(trim(name)) values across
-- meetings therefore seed one durable profile; capture and generated labels do not.
INSERT INTO people (id, display_name, normalized_name, notes, created_at, updated_at)
SELECT
    'person-' || lower(hex(randomblob(16))),
    min(trim(t.speaker)),
    lower(trim(t.speaker)),
    NULL,
    datetime('now'),
    datetime('now')
FROM transcripts t
JOIN meetings m ON m.id = t.meeting_id
WHERE t.speaker IS NOT NULL
  AND length(trim(t.speaker)) > 0
  AND lower(trim(t.speaker)) NOT IN (
      'you', 'guest', 'mic', 'microphone', 'system', 'system audio', 'speaker'
  )
  AND lower(substr(trim(t.speaker), 1, 8)) <> 'speaker '
  AND instr(trim(t.speaker), ' + ') = 0
GROUP BY lower(trim(t.speaker));

INSERT OR IGNORE INTO person_speakers (person_id, meeting_id, speaker_label)
SELECT DISTINCT p.id, t.meeting_id, t.speaker
FROM transcripts t
JOIN meetings m ON m.id = t.meeting_id
JOIN people p ON p.normalized_name = lower(trim(t.speaker))
WHERE t.speaker IS NOT NULL
  AND length(trim(t.speaker)) > 0
  AND lower(trim(t.speaker)) NOT IN (
      'you', 'guest', 'mic', 'microphone', 'system', 'system audio', 'speaker'
  )
  AND lower(substr(trim(t.speaker), 1, 8)) <> 'speaker '
  AND instr(trim(t.speaker), ' + ') = 0;
