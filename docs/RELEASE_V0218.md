# v0.2.18 — UI overhaul & redesigned meeting workspace

**Meetily has a new look—from recording a call to working with its transcript,
notes, and summary afterward.** This release's headline is a major UI overhaul:
a redesigned recording screen, meeting workspace, navigation, themes, and tools
for organizing your meetings.

**This is a substantial rebuild of the interface and meeting workspace.** The
existing React/Next.js frontend has been extensively reworked across its screens,
navigation, shared components, styling, and interactions, alongside workspace
data-model and native/backend changes. The integrating PR touches **310 files**,
with approximately **29,000 lines added and 17,000 removed** across the redesign
and bundled features. Meetily continues to use React/Next.js for its interface
and Tauri/Rust for its desktop backend.

A huge thank-you to **@jayjoe101** for the extensive redesign in **PR #39**, and
to **@ampersandru** and **@cedstrom / @chris-edstrom** for the speaker, recording,
Labs, and Claude CLI contributions integrated into it. This update exists because
contributors shared a substantial amount of design and implementation work.
The original authors' contributions are detailed below—not just the PR that
brought everything together.

## The headline: a redesigned Meetily

- **A new meeting workspace:** a chat-style transcript with speaker colors and
  playback, alongside your notes, action items, and AI summary.
- **A redesigned recording experience:** live transcript, speaker controls, and
  a compact recording bar, with the rest of the app available during a call.
- **A consistent visual design:** Midnight, Vanilla, and Charcoal themes, shared
  components, refreshed navigation, and integrated Windows window controls.
- **Better organization and navigation:** groups, contacts, action items,
  command-bar search, meeting filters, and multi-meeting export.

## See the new interface

*Screenshots use demo meetings and simulated recording in the browser preview.*

### Transcript, notes, action items, and summary together

![Redesigned meeting workspace with a speaker-colored transcript, notes, action items, and AI summary](https://raw.githubusercontent.com/TylerBuza/Meetily-ActuallyFree/main/docs/images/v0.2.18/meeting-detail.png)

### The redesigned live recording screen

![Live recording preview with transcript, speaker controls, and recording bar](https://raw.githubusercontent.com/TylerBuza/Meetily-ActuallyFree/main/docs/images/v0.2.18/live-recording.png)

### A searchable, organized meeting library

![Meeting library with group and participant filters, search, and date-grouped meetings](https://raw.githubusercontent.com/TylerBuza/Meetily-ActuallyFree/main/docs/images/v0.2.18/meeting-workspace.png)

## More features brought into the new interface

- Live speaker renaming and merging, plus per-app recording with a multi-app
  whitelist on Windows.
- Claude Code CLI summaries using your existing Claude Code installation.
- Optional Labs features: meeting automation, voice profiles, waveform seeking,
  transcript cleanup, stricter Whisper silence handling, and Parakeet GPU support.
- A **Low audio** advisory for quiet system audio. Gain remains under your control.

## Fixes and polish

- **Recording buzz/clicks at capture-block boundaries (#40):** continuous audio
  now keeps its samples intact when callback timing fluctuates. This improves
  newly recorded source tracks and mixed audio, including their previews; it
  does not repair artifacts already present in older files.
- **Missing live speech:** retain the beginning of detected utterances and use
  more sensitive system-audio speech detection. Quiet speech and short replies
  are no longer discarded by fixed loudness/phrase filters.
- **AI-generated meeting titles restored**, with manual names taking priority
  and template placeholders rejected.
- **Post-call processing is nonblocking:** progress appears in a compact bottom
  card so you can interact with the meeting. Speaker choices use a compact,
  centered **Auto-detect & continue** action for Nemotron.
- Restored the single-line blue **Meetily · Actually Free** wordmark.
- More reliable capture-start errors, setup status checks, and recovery of live
  speaker edits after a WebView reload.

Nemotron remains Auto-detect only, with microphone/source provenance preserved.
Live Parakeet and optional post-call Whisper remain independently selectable.

## A huge thank-you to our contributors

Several contributions reached this release through other people's integration
PRs. Being bundled into a larger PR does not make the original work any less
important—we want its authors to receive clear credit alongside the integration
work.

### @jayjoe101 — the redesigned meeting workspace

[PR #39](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/39) is an extensive
redesign: three themes, a consistent component system, the recording experience,
meeting pages, groups, contacts, action items, command-bar search, and multi-meeting
export. It also brings the Claude CLI, per-app recording, and Labs contributions
into the new interface. **Thank you for the enormous amount of design,
implementation, and integration work behind this update.**

### @ampersandru — speaker editing, per-app recording, and Labs

- [PR #36](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/36): in-call
  speaker renaming/merging, faster transcription settings, and VAD/startup fixes.
- [PR #37](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/37): per-app
  audio capture, including the Windows multi-app whitelist.
- [PR #38](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/38): combined
  speaker/capture features, experimental Labs capabilities, and follow-up fixes.
- [PR #34](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/34): the original
  Nemotron diarization contribution, released in v0.2.17 and retained here.

PRs #36 and #37 were consolidated into #38, and that work was incorporated into
#39. **Thank you for the sustained contributions across the recording and speaker
experience, and for continuing to report regressions such as the missing
AI-generated meeting titles.**

### @cedstrom / @chris-edstrom — Claude Code CLI summaries

[PR #28](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/28), submitted by
**@cedstrom** with original commits attributed to **@chris-edstrom**, added the
Claude Code CLI summary provider. It lets people use their existing Claude Code
installation and sign-in for summaries. That original contribution is included
through #39, alongside subsequent compatibility and interface integration.
**Thank you for making another useful summary-provider option available to the
community.**

### @fernandog — exceptionally useful audio-artifact investigation

[Issue #40](https://github.com/TylerBuza/Meetily-ActuallyFree/issues/40) included
recordings, spectrogram measurements, comparisons with upstream, reproduction on
different microphones, and a concrete explanation of the likely callback-timing
problem. That investigation helped us reproduce the sample-loss bug and build
targeted regression coverage. **Thank you for going well beyond a bug report—the
careful measurements made a real difference to the fix.**

### Integration and release work

**@TylerBuza** handled integration hardening, recording/transcription corrections,
UI follow-ups, Windows packaging, and release qualification. Thank you as well
to everyone testing builds and sharing feedback, and to the upstream Meetily
project and open-source model/runtime projects this fork builds on.
