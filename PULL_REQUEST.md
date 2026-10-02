## Description

This PR introduces end-to-end speaker diarization support using NVIDIA Parakeet + Nemotron-3 (Sortformer architecture), interactive word-level timestamping with click-to-seek audio playback and karaoke-style active word highlighting, an interactive post-meeting speaker renaming modal with live audio snippet playback, resilient SQLite database migrations, and critical fixes for Windows CUDA GPU builds and WebView2 UI initialization.

### Reference Links:
- **Nemotron-3 Diarization Model**: [nvidia/Nemotron-3-Diarization on Hugging Face](https://huggingface.co/nvidia/Nemotron-3-Diarization)
- **Official Announcement & Technical Blog**: [Know Who Spoke When: Build Real-Time, Multi-Speaker AI with NVIDIA Nemotron 3 Diarization](https://huggingface.co/blog/nvidia-nemotron-3-diarization)

---

### Beta Status & Reviewer Note:
> [!NOTE]
> **Beta Feature Notice**: This diarization implementation is in early stages and should be considered **Beta**.
> If preferred during review, the new **Diarization settings** panel can be easily relocated under the **Beta** settings tab instead of general settings. Feedback on UI placement and default thresholds is very welcome!

---

### Key Changes:

#### 1. NVIDIA Parakeet + Nemotron-3 Diarization Engine
- **Turn Splitting & Segmentation**: Added sentence-level speaker boundary detection for conversations where participants speak sequentially or interrupt each other within the same STT recognition chunk. Large transcript blocks are automatically segmented into distinct chronological turns instead of being lumped into compound labels.
- **Acoustic Bleed Filtering**: Dual-track recordings now filter low-volume microphone bleed of remote participant voices, preventing false `"You + Speaker 1"` compound attributions on guest turns.
- **Word-Level Alignment**: Implemented timestamp alignment between Parakeet CTC token timings and Nemotron-3 speaker activity segments.
- **Sliding FIFO Buffer & Speaker Cache (`spkcache`)**: Implemented sliding-window audio chunk buffering with long-term speaker embedding memory to maintain consistent speaker identities across conversational pauses.
- **Native Tauri Commands**: Added backend commands for audio feature extraction, speaker diarization inference, and per-speaker WAV snippet extraction.

#### 2. Word-Level Timestamps & Click-to-Seek Playback (Labs)
- **Click-to-Seek Playback**: Users can click any word in the transcript to jump audio playback directly to that exact moment in the recording.
- **Karaoke Active Word Highlighting**: During audio playback, words illuminate in real-time with smooth $O(\log N)$ binary search tracking and inter-word grace periods to eliminate flickering.
- **Dual-Engine Precision (Parakeet & Whisper)**:
  - Extracted from Parakeet ONNX CTC token timings for real-time live capture and re-transcription.
  - Extracted from Whisper token timestamps with duration scaling safety nets and audio boundary clamping for full accuracy across `large-v3-turbo` and other Whisper models.
- **Persistence & Migration**: Word timings (`wordID`, `text`, `startTime`, `endTime`) are saved in SQLite (`transcripts.words`) and exported in `transcripts.json`. Word timings survive speaker re-labeling and offline diarization passes.
- **Labs Toggle**: Configurable under Settings -> Labs -> Word-level Timestamps (`wordTimestamps`).

#### 3. Speaker Renaming Modal with Live Audio Preview
- **Interactive Modal (`SpeakerRenameModal.tsx`)**: Easily accessed via the "Rename Speakers" button in the meeting details view.
- **Live Audio Playback**: Users can listen to a short audio snippet for any detected speaker directly inside the modal to accurately verify identity before renaming.
- **Global Transcript Updating**: Renaming updates all corresponding turns across the entire meeting transcript, updating both the SQLite database and client-side virtualized transcript view instantly.

#### 4. SQLite Database Resilience & Self-Healing Migrations
- Added self-healing schema migration logic in `database/manager.rs` to handle legacy schemas, missing columns, or orphaned transcript entries gracefully without app crashes.
- Added database methods for cascading speaker rename updates across meetings and transcripts.

#### 5. Windows Build Reliability & CUDA 13+ GPU Acceleration
- **CUDA 13.x & MSVC Preprocessor Fix**: Resolved MSVC C1001 compiler crashes during ONNX / CCCL compilation under CUDA 13.3 by configuring `/Zc:preprocessor` and `-DCCCL_IGNORE_MSVC_TRADITIONAL_PREPROCESSOR_WARNING` across Cargo `.cargo/config.toml`, `build-gpu.bat`, and `tauri-auto.js`.
- **GPU Auto-Detection**: Fixed a version-checking bug in `scripts/auto-detect-gpu.js` that previously forced fallback to CPU builds on CUDA 13+ environments.
- **Hardware Support**: Tested and validated on modern NVIDIA hardware (including RTX 50-series Blackwell architecture) with native ONNX Runtime CUDA Execution Provider.

#### 6. Windows WebView2 Startup & UI Responsiveness Fixes
- **WebView2 Race Condition Fix**: Created `check-or-start-dev.js` and `"dev:ready"` pre-warming script to ensure Next.js has completed compiling the root route before Tauri attaches the WebView2 window.
- **Process Cleanup**: Updated `dev-gpu.bat` and `build-gpu.bat` to terminate orphaned `msedgewebview2.exe` background processes that previously locked the `EBWebView` cache directory.
- **Window Activation & Focus**: Added explicit window focus flags in `tauri.conf.json`, startup focus triggers in `lib.rs`, and a client-side pointer-events recovery watchdog in `app/layout.tsx`.

#### 7. YouTube URL Transcription & Synchronized Video Playback
- **Automated Ingestion via yt-dlp**: Seamlessly fetches, verifies, and executes `yt-dlp` to download high-quality MP4 video and audio.
- **Unified Pipeline**: Automatically kicks off offline transcription (Parakeet / Whisper), speaker diarization, word-level alignment, and LLM summary generation.
- **Synchronized Video Player**: Embedded video player in Meeting Details with collapsible preview. Video playback is tightly bound to word-level timestamps: words highlight in real-time karaoke mode as video plays, and clicking any word seeks the video player directly.
- **Import Dialog Preview**: Dedicated "YouTube Video" tab in the Import Audio modal featuring URL validation, live video metadata preview (title, channel, duration, thumbnail), model selection, and real-time download/transcription progress bar.

#### 8. Full Transcript Translation (LLM-Powered)
- **Multi-Language Post-Translation**: Translates meeting transcripts into target languages (Spanish, French, German, Italian, Portuguese, Japanese, Korean, Chinese, Russian, and more) via local sidecar LLMs or configured API providers.
- **Bilingual & Side-by-Side Viewing Modes**: View transcripts in Original, Translated, or Bilingual format (showing both source language and translation below each speaker segment).
- **Persistent Storage**: Saved in `<meeting_folder>/translations/<lang>.json` with fast cache retrieval.
- **Click-to-Seek Intact**: Even in translated or bilingual mode, original word-level timestamps and click-to-seek audio/video sync remain fully operational.

#### 9. Watch Folders (Automated Background Ingestion)
- **Automated Directory Monitoring**: Background directory watcher monitors user-designated folders every 5 seconds.
- **Write Stability Verification**: Multi-tick size and timestamp stability checks ensure files have completed writing or copying before triggering import.
- **Automated Pipeline**: Dropped audio/video files automatically enter transcription, speaker diarization, and summary generation.
- **Labs Management UI**: Monitored folders list with master toggle and directory picker dialog under Settings -> Labs.

---

## Related Issue
Addresses speaker diarization integration, speaker identification workflows, Windows CUDA GPU acceleration, and Windows WebView2 UI responsiveness.

---

## Type of Change
- [x] Bug fix (non-breaking change which fixes an issue)
- [x] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [x] Performance improvement
- [x] Code refactoring
- [ ] Documentation update

---

## Testing
- [x] Manual testing performed on Windows 11 with NVIDIA CUDA acceleration (RTX 5080, CUDA 13.3).
- [x] Verified full production release build compilation (`build-gpu.bat` / Next.js export / Tauri NSIS bundle).
- [x] Verified word-level timestamp extraction and click-to-seek playback for both Parakeet and Whisper models.
- [x] Verified karaoke-style active word highlighting responsiveness during playback.
- [x] Verified word timing persistence in SQLite and `transcripts.json`.
- [x] Verified Parakeet + Nemotron-3 word-level alignment and speaker assignment.
- [x] Verified speaker renaming modal with live WAV playback and transcript persistence.
- [x] Verified dev server pre-warming and eliminated blank/frozen UI state on launch.
- [x] Verified SQLite database migration and self-healing with existing user databases.
- [x] Verified GPU execution provider correctly active at runtime without fallback warning banner.
- [x] Verified YouTube video download, metadata extraction, and transcription pipeline via yt-dlp.
- [x] Verified Meeting Details video player sync: active word highlighting follows video playback, and clicking words seeks the video player.
- [x] Verified LLM transcript translation in Original, Translated, and Bilingual display modes with persistent disk cache.
- [x] Verified background Watch Folders detection, write stability verification, and automated transcription trigger.
- [x] Verified complete backend and frontend test suites pass (393 Rust unit tests + 30 isolated frontend suites).

---

## Checklist
- [x] Code follows project style guidelines.
- [x] Self-reviewed the code changes.
- [x] Added comments for complex diarization math, FIFO buffer management, and window lifecycle logic.
- [x] Verified local TypeScript compilation (`next build` static export succeeded with 0 errors).
- [x] Verified Rust compilation (`cargo check --features cuda` and release build succeeded).
- [x] No merge conflicts with base branch.

---

## Additional Notes
- To build the release version on Windows with CUDA acceleration:
  ```cmd
  cd frontend
  build-gpu.bat
  ```
- Binary outputs:
  - Portable EXE: `target\release\meetily.exe`
  - Windows Installer: `target\release\bundle\nsis\meetily_*_x64-setup.exe`

---

## AI Disclaimer
> [!NOTE]
> **AI Disclaimer**: This feature and pull request were developed with AI assistance, but have been thoroughly and rigorously tested end-to-end by myself on Windows with an active NVIDIA GPU and CUDA environment.
