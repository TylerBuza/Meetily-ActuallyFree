# Privacy Policy — Meetily — Actually Free

**Short version: your data stays on your machine unless you explicitly choose to
send it to a cloud provider or submit a crash report.**

## What we collect

Meetily — Actually Free has **no automatic analytics, telemetry, or phone-home
behavior**. There is no account, no sign-in, and no usage tracking. The app does not
automatically send your audio, transcripts, summaries, crash reports, or usage data to
us or anyone else.

## Where your data lives

- **Audio recordings, transcripts, summaries, and settings** are stored **locally** on your
  device (a SQLite database and files in your app data directory).
- **API keys** you enter (if you choose to use a cloud AI or transcription provider) are
  stored locally and used only to talk directly to that provider.

## When data leaves your machine

Data leaves your machine only when **you** explicitly choose an action that sends it:

- If you select a **cloud AI provider** (Claude, OpenAI, Groq, OpenRouter, or a custom
  endpoint), the transcript text you summarize is sent **directly to that provider** using
  **your** key, subject to **their** privacy policy and data-retention terms.
- If you select a **cloud transcription provider**, your audio is sent to that provider.

If Meetily detects that the previous session ended unexpectedly, it can create a
redacted crash-report ZIP at your request. The report excludes recordings, transcripts,
summaries, meeting names, the database, settings, credentials, usernames, hostnames,
and device names. It contains crash type/time, app version and backend, OS family and
major version, architecture, bucketed CPU core count, rounded memory size, and a
source-relative panic file/line location with a location fingerprint when available.
Choosing **Send Report** saves the ZIP locally and opens a public
GitHub issue. Opening GitHub sends normal request data to GitHub. The ZIP remains local
until you select it as an attachment; GitHub uploads attachments before issue submission.

Using the **built-in local model**, **local Whisper/Parakeet**, and **Ollama** keeps
everything **100% offline** — nothing leaves your device.

## Your control

Delete a meeting in the app and its data is removed locally. Uninstalling the app and
deleting its data directory removes everything.

## Contact

This is an open-source project. For questions or issues, open an issue on the repository.
