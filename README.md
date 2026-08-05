<div align="center">
    <h1>Meetily — Actually Free</h1>
    <p><b>A privacy-first AI meeting assistant that's genuinely free.</b><br/>
    Every feature unlocked. No paywall. No license keys. No telemetry. Runs on your machine.</p>
    <img src="https://img.shields.io/badge/Price-%240%20forever-brightgreen" alt="Free forever">
    <img src="https://img.shields.io/badge/Telemetry-none-blue" alt="No telemetry">
    <img src="https://img.shields.io/badge/Runs-100%25%20local-8a2be2" alt="Local">
    <img src="https://img.shields.io/badge/GPU-NVIDIA%20CUDA-76b900" alt="CUDA">
    <img src="https://img.shields.io/badge/OS-Windows-white" alt="Windows">
</div>

---

## Why this exists

Meeting-assistant apps love to record you, transcribe you, and then put the useful parts
behind a subscription — while quietly shipping your usage off to their servers.

**Meetily — Actually Free** is the opposite of that. It's a self-built desktop app that
records and transcribes your meetings **entirely on your own machine**, summarizes them
with the AI of *your* choice, and never asks you to pay or sign in. If a capability can be
run locally or with your own API key, it should just be **free** — so here, it is.

### Goals

- **$0, forever.** No paid tiers, no "Pro" upsell, no locked features.
- **Private by default.** Audio and transcripts stay on your device. **All telemetry is removed** — nothing phones home.
- **Your AI, your rules.** Fully local (bundled model or Ollama), or bring your own key for any cloud provider.
- **Actually useful.** A real live assistant, search across your history, and clean exports — not a demo.

---

## Features

**Capture & transcribe**
- 🎙️ Real-time recording with professional audio mixing (mic + system audio)
- 🗣️ **Speaker labels** — your mic is tagged as **You (your name)**, other participants separately
- 🧠 **Every transcription model** — Whisper (small → large-v3, turbo, compressed), Parakeet (Lightning / Compact / Precise), or any Hugging Face model
- ⚡ **NVIDIA CUDA GPU acceleration** on Windows

**Summarize with any AI**
- 💻 Fully offline: bundled local model or **Ollama** — no keys, no cloud
- ☁️ Bring your own key: **Claude, GPT-4/OpenAI, Groq, OpenRouter**
- 🔌 Custom OpenAI-compatible endpoint: **vLLM, remote Ollama, Text-Generation-WebUI**, etc.
- 🧩 **Custom summary templates** — build and reuse your own

**The assistant**
- ✨ **Live AI Assistant** — ask questions mid-meeting, grounded in the live transcript
- 🎭 **Persona presets** + a **custom-context notes** box injected into every prompt
- 🔔 **Auto-suggest** answers the moment a question is asked, with **follow-up chips**
- 🗣️ **"Say it naturally"** — rewrite an answer to sound good spoken aloud
- 🔎 **RAG across past meetings** — semantic search over your history (local embeddings)

**Own your data**
- 📄 Export summaries to **PDF, DOCX, Markdown, TXT, JSON**
- 🌙 **Dark mode** (deep slate-blue theme)
- 🗄️ Everything stored locally in a SQLite database you control

---

## Build & run (Windows, NVIDIA GPU)

**Prerequisites:** Rust, Visual Studio 2022 Build Tools (C++ workload), CMake, LLVM,
Node + pnpm, and the CUDA Toolkit. The exact build environment is captured in
`frontend/build-cuda-env.bat`.

```bash
cd frontend
pnpm install

# GPU (NVIDIA) build — compiles the llama-helper sidecar + the app with CUDA:
build-cuda-env.bat libhelper

# Result:
#   target/release/meetily.exe   (run it directly; CUDA DLLs sit beside it)
```

For a portable **CPU build** that runs on any machine (no NVIDIA required), build without
the `cuda` feature. On first launch, pick a transcription model and let it download.

---

## Privacy & consent

This is a **consensual** assistant: it records and transcribes on **your** machine for
**your** notes. It does **not** hide from other participants and is **not** a stealth or
"undetectable" tool. Record responsibly and let people know when a meeting is being
recorded, per the laws and norms where you are.

---

## License

Released under the **MIT License** — see [`LICENSE.md`](LICENSE.md). Built on open-source,
MIT-licensed foundations and open components (whisper.cpp, llama.cpp, Parakeet/ONNX,
pyannote models, ffmpeg). You are free to use, modify, and redistribute.
