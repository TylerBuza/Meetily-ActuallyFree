## Description

This PR integrates on-device speaker diarization using the **NVIDIA Nemotron-3 Diarization model** (Sortformer v3 architecture) alongside NVIDIA Parakeet STT, introduces automated sentence-level turn splitting for multi-speaker recognition blocks, adds acoustic bleed filtering for dual-track recordings, provides a dedicated Diarization settings management UI, and resolves critical Windows CUDA 13.3 / MSVC build compatibility issues.

### Reference Links:
- **Nemotron-3 Diarization Model**: [nvidia/Nemotron-3-Diarization on Hugging Face](https://huggingface.co/nvidia/Nemotron-3-Diarization)
- **Technical Blog & Integration Guide**: [Know Who Spoke When: Build Real-Time, Multi-Speaker AI with NVIDIA Nemotron 3 Diarization](https://huggingface.co/blog/nvidia-nemotron-3-diarization)

---

### Beta Status & Reviewer Note:
> [!NOTE]
> **Beta Feature Notice**: Diarization is in early stages and should be considered **Beta**.
> If preferred during review, the new **Diarization settings** panel can be easily relocated under a **Beta** settings tab instead of general settings. Feedback on default detection thresholds and UI placement is very welcome!

---

### Key Changes:

#### 1. NVIDIA Nemotron-3 Diarization Engine (Sortformer v3)
- **On-Device ONNX Runtime Execution**: Implemented the Nemotron-3 Diarization engine (`nemotron3_diar_v3.onnx`) with Mel preprocessor (`nemo128.onnx`), supporting up to 8 concurrent speakers.
- **Sliding FIFO Buffer & Speaker Cache (`spkcache`)**: Implemented sliding-window audio chunk buffering (FIFO max 264 frames) with long-term speaker embedding memory to maintain speaker identity continuity across conversational pauses.
- **Automated Model Manager**: Added automated downloader with progress reporting, integrity checks, and local file verification in `diarization/download.rs`.

#### 2. Sentence-Level Turn Splitting & Chronological Segmentation
- **Sub-Chunk Boundary Splitting**: Solved the issue where sequential speech from multiple speakers within a single STT chunk was lumped into compound labels (`"Speaker 1 + Speaker 2"`). 
- **Database Turn Splitting**: Transcripts are segmented at speaker boundaries into individual chronological turns with accurate audio start/end timestamps and distinct speaker assignments.
- **Simultaneous Overlap vs. Alternation**: Added high-confidence thresholds (minimum 40% duration and 1.5s concurrent overlap) to distinguish genuine simultaneous cross-talk from rapid conversational turn-taking.

#### 3. Dual-Track Acoustic Bleed Filtering
- **Microphone Bleed Suppression**: Dual-track recordings (mic + system loopback) now filter low-volume microphone bleed of remote participant voices, preventing false `"You + Speaker 1"` compound labels during remote speaker turns.
- **Source Track Affinity**: Track hints (user mic vs. remote system audio) are preserved and prioritized during speaker clustering.

#### 4. Diarization Settings Panel (`DiarizationSettings.tsx`)
- **Interactive Management UI**: Added a dedicated Diarization panel in Settings.
- **Model Downloader & Status**: Users can download, verify, and inspect the Nemotron-3 ONNX model status directly from the app.
- **Configurable Parameters**: Configurable sliders for detection sensitivity threshold and maximum speaker count.

#### 5. Windows Build Reliability & CUDA 13.3 GPU Acceleration
- **CUDA 13.3 & MSVC Modern Preprocessor Fix**: Resolved MSVC compiler fatal errors (`C1001` compiler crash and `C1189` CUB C++17 requirement) by properly configuring `--std=c++17`, `/Zc:preprocessor`, and `-DCCCL_IGNORE_DEPRECATED_CPP_DIALECT` across `.cargo/config.toml`, `build-gpu.bat`, `dev-gpu.bat`, and `tauri-auto.js`.
- **Target Architectures**: Configured `CMAKE_CUDA_ARCHITECTURES="75;80;86;89;120"` to support modern NVIDIA hardware (RTX 20, 30, 40, and 50-series Blackwell) while avoiding deprecated Maxwell architectures (`compute_52`) that caused CMake compiler checks to fail under CUDA 13.
- **GPU Auto-Detection**: Corrected release version checking in `auto-detect-gpu.js` to ensure CUDA 13+ environments are properly recognized as GPU-accelerated.

#### 6. Transcription Engine Polish
- Cleaned up transcription engine selection in settings, retranscription dialogs, and audio import to reliably use Parakeet (recommended for live) and Whisper (with vocabulary hints for post-call).

---

## Related Issue
Addresses speaker diarization integration, multi-speaker turn segmentation, Windows CUDA GPU acceleration, and build compatibility with CUDA 13.3.

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
- [x] Tested on Windows 11 with an NVIDIA RTX 5080 (Blackwell architecture, CUDA 13.3).
- [x] Verified full production release build compilation (`build-gpu.bat` / Next.js static export / Tauri NSIS bundle).
- [x] Verified Nemotron-3 model downloading and ONNX Runtime execution.
- [x] Verified turn splitting and speaker attribution on multi-speaker meeting recordings.
- [x] Verified CUDA execution provider correctly active at runtime without CPU fallback warnings.

---

## Checklist
- [x] Code follows project style guidelines.
- [x] Self-reviewed the code changes.
- [x] Added comments for diarization math, FIFO buffer management, and speaker caching.
- [x] Verified TypeScript compilation (`pnpm tsc --noEmit` succeeded with 0 errors).
- [x] Verified Rust compilation (`cargo check --features cuda` and release build succeeded).
- [x] No merge conflicts with base branch.

---

## Additional Notes
- To build the release version on Windows with CUDA acceleration:
  ```cmd
  cd frontend
  build-gpu.bat
  ```
- Output binaries:
  - Portable EXE: `target\release\meetily.exe`
  - Windows Setup Installer: `target\release\bundle\nsis\Meetily - Actually Free_0.2.16_x64-setup.exe`

---

## AI Disclaimer
> [!NOTE]
> **AI Disclaimer**: This feature and pull request were developed with AI assistance, but have been thoroughly and rigorously tested end-to-end on Windows with an active NVIDIA GPU and CUDA environment.
