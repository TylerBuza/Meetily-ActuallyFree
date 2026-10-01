**Meetily has a new look.** This update substantially rebuilds the existing
React/Next.js interface and meeting workspace—from live recording to working
with transcripts, notes, and summaries afterward.

## New interface

- **Meeting workspace:** speaker-colored transcripts and playback alongside
  notes, action items, and AI summaries.
- **Live recording:** refreshed speaker controls and a compact recording bar,
  with the rest of the app available during calls.
- **Navigation and themes:** Midnight, Vanilla, and Charcoal themes, shared
  components, integrated Windows controls, and Ctrl+K search.
- **Organization:** groups, contacts, meeting filters, and multi-meeting export.

![Redesigned meeting workspace with transcript, notes, action items, and summary](https://raw.githubusercontent.com/TylerBuza/Meetily-ActuallyFree/main/docs/images/v0.2.18/meeting-detail.png)

<details>
<summary><strong>More screenshots: live recording and meeting library</strong></summary>

![Live recording with transcript, speaker controls, and recording bar](https://raw.githubusercontent.com/TylerBuza/Meetily-ActuallyFree/main/docs/images/v0.2.18/live-recording.png)

![Meeting library with search, filters, and date-grouped meetings](https://raw.githubusercontent.com/TylerBuza/Meetily-ActuallyFree/main/docs/images/v0.2.18/meeting-workspace.png)

</details>

*Screenshots use demo meetings and simulated recording.*

## Features and fixes

- **Speaker editing and per-app recording:** rename/merge speakers live and
  choose which applications to capture, including multiple apps on Windows.
- **Claude Code CLI summaries:** use your installed `claude` command and sign-in.
- **Optional Labs:** meeting automation, waveform seeking, voice profiles,
  transcript cleanup, Whisper silence guard, and Windows Parakeet GPU support.
- **Clearer recordings and better live coverage:** fix callback-boundary audio
  artifacts ([#40](https://github.com/TylerBuza/Meetily-ActuallyFree/issues/40)),
  retain speech beginnings, and improve system-audio detection. Existing damaged
  audio is not repaired. A **Low audio** advisory helps flag quiet system input.
- **Post-call polish:** restore generated titles while respecting manual names,
  keep the meeting clickable during processing, and simplify Nemotron to
  **Auto-detect & continue**. The original blue wordmark is back too.
- **Reliability:** better capture-start errors, setup checks, and recovery of
  live speaker edits after a WebView reload.

## Thank you to our contributors

This release brings together a huge amount of community work. A heartfelt
thank-you to the original authors as well as those who integrated and tested it:

- **@jayjoe101** — the extensive UI/workspace rebuild and integration in
  [#39](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/39). Thank you for
  the design and implementation work across the app's screens, themes,
  navigation, and meeting tools.
- **@ampersandru** — live speaker editing and VAD improvements in
  [#36](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/36), per-app capture
  in [#37](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/37), and the
  combined features/Labs in [#38](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/38),
  incorporated through #39. Also the original Nemotron work in
  [#34](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/34), retained from
  v0.2.17. Thank you for the sustained recording/speaker improvements and
  follow-up regression reports.
- **@cedstrom / @chris-edstrom** — Claude Code CLI summaries in
  [#28](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/28), included through
  #39. Submitted by @cedstrom, with original commits attributed to @chris-edstrom.
  Thank you for bringing this provider option to the community.
- **@fernandog** — the detailed recordings, measurements, and root-cause analysis
  in [#40](https://github.com/TylerBuza/Meetily-ActuallyFree/issues/40). Thank you
  for an investigation that made reproducing and fixing the audio bug much easier.
- **@TylerBuza** — integration hardening, recording/transcription fixes, UI
  follow-ups, Windows packaging, and release preparation.

Thank you also to everyone testing builds and sharing feedback, and to the
upstream Meetily and open-source model/runtime projects this fork builds on.
