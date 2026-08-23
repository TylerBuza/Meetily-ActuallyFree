ALTER TABLE transcript_settings ADD COLUMN whisperVocabulary TEXT;

CREATE TABLE IF NOT EXISTS meeting_whisper_vocabulary (
    meeting_id TEXT PRIMARY KEY,
    vocabulary TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);
