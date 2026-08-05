# Privacy Policy — Meetily — Actually Free

**Short version: your data stays on your machine, and this app collects nothing.**

## What we collect

**Nothing.** Meetily — Actually Free has **no analytics, no telemetry, and no phone-home
behavior** of any kind. There is no account, no sign-in, and no usage tracking. The app
does not send your audio, transcripts, summaries, or usage data to us or anyone else.

## Where your data lives

- **Audio recordings, transcripts, summaries, and settings** are stored **locally** on your
  device (a SQLite database and files in your app data directory).
- **API keys** you enter (if you choose to use a cloud AI or transcription provider) are
  stored locally and used only to talk directly to that provider.

## When data leaves your machine

Only if **you** choose a cloud provider:

- If you select a **cloud AI provider** (Claude, OpenAI, Groq, OpenRouter, or a custom
  endpoint), the transcript text you summarize is sent **directly to that provider** using
  **your** key, subject to **their** privacy policy and data-retention terms.
- If you select a **cloud transcription provider**, your audio is sent to that provider.

Using the **built-in local model**, **local Whisper/Parakeet**, and **Ollama** keeps
everything **100% offline** — nothing leaves your device.

## Your control

Delete a meeting in the app and its data is removed locally. Uninstalling the app and
deleting its data directory removes everything.

## Contact

This is an open-source project. For questions or issues, open an issue on the repository.
