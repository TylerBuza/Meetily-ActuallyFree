-- Images are stored beside each recording; the folder key also works while a
-- live recording has not yet been inserted into the meetings table.
CREATE TABLE meeting_images (
    id TEXT PRIMARY KEY,
    folder_path TEXT NOT NULL,
    file_name TEXT NOT NULL,
    audio_time REAL NOT NULL CHECK (audio_time >= 0),
    created_at TEXT NOT NULL,
    UNIQUE(folder_path, file_name)
);

CREATE INDEX idx_meeting_images_folder_time ON meeting_images(folder_path, audio_time);
