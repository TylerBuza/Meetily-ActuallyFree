# feat: NVIDIA Nemotron-3 Diarization Engine, Sentence-Level Turn Splitting, and Windows CUDA 13.3 Support

## Description

This PR enhances **Meetily-ActuallyFree**'s on-device speaker diarization capabilities by introducing the **NVIDIA Nemotron-3 Diarization model** (Sortformer v3 architecture) alongside the pre-existing Pyannote engine. It also adds sentence-level chronological speaker turn splitting to eliminate compound speaker labels, adds acoustic bleed filtering for dual-track recordings, enhances the Diarization Settings UI with model switching and fine-tuning controls, and resolves build and runtime compatibility issues for Windows with CUDA 13.3 and Visual Studio 18.

### References & Background:
- **Nemotron-3 Diarization Model**: [nvidia/Nemotron-3-Diarization on Hugging Face](https://huggingface.co/nvidia/Nemotron-3-Diarization)
- **Technical Overview**: [Know Who Spoke When: Build Real-Time, Multi-Speaker AI with NVIDIA Nemotron 3 Diarization](https://huggingface.co/blog/nvidia-nemotron-3-diarization)

---

### Key Changes:

#### 1. NVIDIA Nemotron-3 Diarization Engine (Sortformer v3)
- **On-Device ONNX Runtime Execution**: Added `nemotron.rs` implementing NVIDIA Sortformer v3 (`nemotron3_diar_v3.onnx` + Mel preprocessor `nemo128.onnx`), supporting up to 8 concurrent speakers fully offline.
- **Long-Meeting Streaming Chunking (Arbitrary Meeting Length)**: Solved Sortformer's 5,000-frame (~420s) positional encoding limitation by streaming audio in 24.0-second sliding windows (~285 frames per chunk), cascading speaker embeddings and FIFO state across chunks to support arbitrarily long meetings (e.g., 40+ minutes) without ONNX Reshape errors.
- **DirectML & CUDA GPU Acceleration**: Packaged Microsoft's official DirectML ONNX Runtime (`Microsoft.ML.OnnxRuntime.DirectML` + `DirectML.dll`) and configured prioritized execution providers (`CUDA -> DirectML -> CPU fallback`), enabling instant GPU offloading across modern NVIDIA, AMD, and Intel GPUs.
- **Sliding FIFO Buffer & Speaker Cache (`spkcache`)**: Implemented sliding-window chunk buffering (264 frames FIFO) with long-term speaker embedding caching to maintain speaker identity continuity across conversational pauses.
- **Dual-Engine Architecture**: Integrated Nemotron-3 alongside the existing Pyannote (`segmentation-3.0`) pipeline in `diarization/mod.rs` and `diarization/online.rs`, allowing users to switch between engines seamlessly.
- **Model Downloader**: Added download and integrity verification support for Nemotron-3 assets in `diarization/download.rs`.

#### 2. Sentence-Level Turn Splitting & Chronological Segmentation
- **Sub-Chunk Transition Detection**: Solved the issue where sequential speech from multiple speakers within a single STT chunk was lumped into compound labels (e.g. `"Speaker 1 + Speaker 2"`).
- **Database Turn Segmentation**: Uses sentence-boundary chunking (`split_sentences_into_chunks`) to segment transcripts into separate chronological turns with accurate audio start/end timestamps and distinct speaker assignments.
- **True Overlap vs. Alternation**: Added confidence thresholds (minimum 40% duration and 1.5s concurrent overlap) so compound labels are only applied when speakers genuinely talk simultaneously.

#### 3. Dual-Track Acoustic Bleed Filtering
- **Microphone Bleed Suppression**: Dual-track recordings (microphone + system loopback) now filter out low-volume microphone bleed of remote participant voices, preventing false `"You + Speaker 1"` attributions during remote speaker turns.
- **Source Track Affinity**: Track hints (user mic vs. remote audio) are preserved and prioritized during speaker clustering.

#### 4. Diarization Settings UI Updates (`DiarizationSettings.tsx`)
- **Engine Selector**: Users can switch between **Pyannote (Bundled / Lightweight)** and **NVIDIA Nemotron-3 (Sortformer v3)**.
- **Nemotron-3 Model Downloader**: Download progress bar and status indicator for Nemotron-3 ONNX assets.
- **Fine-Tuning Controls**: Interactive sliders for Nemotron-3 Max Speakers (2 to 8) and Speech Detection Threshold (0.10 to 0.90).
- **Model Directory Launcher**: Added "Open in Explorer" button to view and manage downloaded ONNX models.
- **Dark Mode / Theming Polish**: Updated layout and styling with `var(--af-*)` theme tokens and dark mode colors.

#### 5. Windows CUDA 13.3 & Visual Studio 18 GPU Build Compatibility
- **MSVC Modern Preprocessor**: Configured `/Zc:preprocessor`, `--std=c++17`, `-DCCCL_IGNORE_DEPRECATED_CPP_DIALECT`, and `-DCCCL_IGNORE_MSVC_TRADITIONAL_PREPROCESSOR_WARNING` across `.cargo/config.toml`, `build-gpu.bat`, `dev-gpu.bat`, and `tauri-auto.js` to fix MSVC fatal compiler errors (`C1001` and `C1189`).
- **Target Architectures**: Configured `CMAKE_CUDA_ARCHITECTURES="75;80;86;89;120"` to support modern NVIDIA GPUs (RTX 20, 30, 40, and 50-series Blackwell) while removing deprecated architectures (`compute_52`) that cause CMake failures on CUDA 13.
- **Environment Detection**: Added detection for Visual Studio 18 Build Tools and updated CUDA release detection in `auto-detect-gpu.js` to prevent accidental CPU fallback on CUDA 13+.

#### 6. UI Polish & Application Resilience
- **Transcript Settings**: Refined `TranscriptSettings.tsx`, `ParakeetModelManager.tsx`, and `WhisperModelManager.tsx` with clean responsive cards, dark mode styling, and robust model loading fallbacks.
- **Startup Safety Watchdog**: Added a safety timer in `layout.tsx` to prevent blank startup screens if an invoke times out, and converted crash reporting into a non-blocking overlay.

---

## Related Issue
Enhances offline speaker diarization, resolves multi-speaker turn segmentation, and fixes Windows CUDA 13.3 compilation.

---

## Type of Change
- [x] New feature (non-breaking change which adds functionality)
- [x] Bug fix (non-breaking change which fixes an issue)
- [x] Performance improvement
- [x] Code refactoring

---

## Testing
- [x] Tested on Windows 11 with NVIDIA RTX 5080 (Blackwell architecture, CUDA 13.3).
- [x] Verified full production release build compilation (`build-gpu.bat` / Next.js static export / Tauri NSIS bundle).
- [x] Verified Nemotron-3 model downloading, SHA-256 verification, and ONNX Runtime execution.
- [x] Verified switching between Pyannote and Nemotron-3 engines in Settings.
- [x] Verified sentence-level turn splitting on multi-speaker meeting recordings.
- [x] Verified CUDA execution provider correctly active at runtime without CPU fallback warnings.
- [x] Verified TypeScript compilation (`pnpm tsc --noEmit` passed with 0 errors).

---

## Checklist
- [x] Code follows project style guidelines.
- [x] Self-reviewed the code changes against `TylerBuza/Meetily-ActuallyFree:main`.
- [x] Added comments for diarization math, FIFO buffer management, and speaker caching.
- [x] Verified TypeScript compilation (`pnpm tsc --noEmit` succeeded with 0 errors).
- [x] Verified Rust compilation (`cargo check --features cuda` and release build succeeded).
- [x] No merge conflicts with base branch.

---

## AI Disclaimer
> [!NOTE]
> **AI Disclaimer**: This feature and pull request were developed with AI assistance, and thoroughly tested end-to-end on Windows with an active NVIDIA GPU and CUDA environment.
