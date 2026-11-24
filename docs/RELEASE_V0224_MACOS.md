# Meetily 0.2.24 — Apple Silicon preview

For Apple Silicon Macs on macOS 14.2 or later. This is an ad-hoc-signed, non-notarized preview; Windows remains on its own update channel.

- Correct participant counts on first opening a finished meeting, including overlapping speakers and longer transcripts.
- Better handling of integer audio formats, resampler tails, saved recording duration and checkpoint recovery.
- A failed chosen-app tap no longer falls back to recording every application. Choose one app and start playing audio in it before recording. Helpers and apps that start playing later are not automatically followed in this preview.
- New Parakeet downloads use pinned revisions. Existing meetings, models and settings retain their storage locations.

The candidate workflow checks native compilation, packaging and launch. A CI launch does not qualify microphone permissions, capture isolation on every app, or a physical macOS 14.2 recording. Feedback on those cases is welcome.
