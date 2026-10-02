-- Migration: Add words column to transcripts table for word-level timestamps & playback sync
-- Stored as JSON array: [{"wordID": "uuid", "text": "word", "startTime": 12340, "endTime": 12680}]
ALTER TABLE transcripts ADD COLUMN words TEXT;
