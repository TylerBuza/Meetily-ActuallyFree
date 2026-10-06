# October PR integration

Work order: #42 recording diagnostics; #44/#45 speaker-label correctness; #31/#35
post-call ownership/cancellation; #22 Linux capture; #38 remaining features;
#27 Markdown export; #10 vocabulary; #8 ROCm; #12 superseded permission probe.

This note tracks source integration and qualification, not a published release.
Starting point: main `162dd7c`, Windows v0.2.20.

## Recording #42

The Windows reporter confirmed a 20-minute recording without microphone dropouts.
The latest Mac screenshot says “Audio channel was closed unexpectedly”. Current
code uses that same fatal error for a five-second system-tap inactivity timeout,
an ended Core Audio stream, and closed pipeline delivery. The screenshot cannot
distinguish these paths. Requested exact build, capture mode, device/model/macOS,
trigger, and redacted logs; physical Mac reproduction remains outstanding.
Core Audio inactivity and stream-end errors now have distinct user-visible error
messages, separate from closed pipeline delivery. This improves diagnosis; it
does not establish or claim a fix for the reporter's new failure.

## Linux capture #22 — blocked

The rebased branch removes Windows `NATIVE_CLEANUPS` bounded teardown, leaves
Windows hardware-test stop call sites synchronous after making stop async, and
returns success after Pulse timeout/panic. Reconnect takes the global manager out
then unconditionally restores it, exposing a concurrent Start/Stop race. Requested
changes and native tests; not integrated into the candidate.

## Remaining #38 — blocked

The new delete-files path checks shared folders by raw string equality before
canonical recursive deletion. Aliases/nested meeting directories are not covered;
file deletion precedes successful database deletion. Requested canonical/shared
ownership and partial-failure tests, retained opt-in/beta voice matching, and a
reproduction for the headset source-attribution report. Only #44/#45 is integrated.

## ROCm #8

Rebased Linux-only SDK discovery and helper feature mapping onto current Windows
toolchain handling. ROCm is an opt-in source-build backend; neither this Windows
machine nor its Ubuntu WSL environment has HIP/ROCm. Parser/syntax checks do not
establish a working AMD GPU build or inference. No installer advertises ROCm.

## Permission probe #12

Author requested not merging. The cited upstream commit changes device monitoring,
not every permission-probe/UI behavior in this PR. Close as superseded/withdrawn,
without claiming the entire proposed feature is already implemented in this fork.

## Speaker labels #44/#45

Integrated contributor commit `1c9f89d` independently of the remaining #38 feature
bundle. All 28 isolated frontend test files, Next production build/type checks,
and 17 native person-repository tests passed. The regression exercises combined
renames, per-line component selection, meeting isolation, and unchanged source,
text, row IDs, and timing. These are synthetic/UI and in-memory SQLite checks.

## Post-call #31/#35

`PostCallJobsContext` now owns the handoff worker above navigation. Pages attach
as views; detached pages are not refreshed, and completion/dirty state is consumed
on return. Jobs are presented serially because native retranscription is global
single-flight. “Keep live transcript” skips enhancement and diarization; Escape
also dismisses the prompt. Active cancellation targets the meeting and retains
ownership until the native step settles. Native diarization is not preemptible:
cancellation during it prevents later steps after it returns, rather than falsely
claiming resources are already free. WebView reload durability is not established
by this frontend owner; app reload/exit remains a separate lifecycle limit.

The native retranscription guard owns the active meeting ID under a mutex.
Optional meeting-scoped cancellation cannot cancel another meeting after a race;
legacy callers without a meeting ID retain global cancellation behavior.

- #38: `330e194`; frontend CI passed, but native feature/hardware claims require
  independent checks. Voice matching must remain opt-in and beta.
- #22: `559f1fd`; rebased, native shutdown and ALSA ownership require review.
- #27/#10/#8 conflict with main and require integration plus targeted checks.
- #12 author recommends superseding with upstream; compare behavior before closing.

## Markdown export #27

Ported the contributor's frontmatter/link-style changes onto the current export
hook rather than restoring the removed legacy speaker dialog. Markdown fetches
all rows once for both attendees and body; other formats retain existing paths.
Combined speakers are split before linking and participant collection, preserving
#44/#45 fixes. Reserved wikilink delimiters remain plain text. Tests moved into
the isolated-test discovery tree. Storage denial falls back to generic style.

## Parakeet vocabulary #10

Ported contributor vocabulary decoding onto current capture/ASR interfaces,
preserving existing source labeling, DirectML tests, UI theme, and scoped
retranscription cancellation. Glossary hints now apply to live, import, and
post-call Parakeet as well as Whisper. Parakeet uses token boosts followed by
edit-distance canonicalization against explicitly configured glossary terms;
this can alter recognized words and is not an accuracy guarantee. Empty glossary
retains the original argmax path. Model-dependent accuracy remains unqualified.

## Verification of the integrated source

- Final Windows CPU native suite: **379 passed, 10 ignored**. No model/audio-dependent
  ignored tests ran during this review. Includes seven vocabulary regressions and
  the new meeting-scoped cancellation test.
- **32/32 isolated frontend test files passed**. Five post-call tests exercise
  navigation, reattachment, completion isolation, skip, Escape, and cancellation.
  Markdown integration tests distinguish `.md` from TXT/clipboard output.
- Next production build and its type validation passed after integration.
- llama-helper CPU build/tests: **2 passed**. Four ROCm parser tests passed using
  the actual parser/test source extracted into a std-only Rust test executable;
  this is not a HIP/ROCm dependency build. Node script syntax and LF-normalized
  Bash syntax checks passed. `.sh` checkout line endings are now pinned to LF.
- Browser preview with synthetic Acme fixture rendered the post-call prompt with
  a Close control; “Keep live transcript” dismissed it. The export dialog showed
  the Markdown link-style selector and all six output choices. This is mocked IPC,
  not an installed-native recording test.
- No new installer, release, physical Mac reproduction, AMD GPU execution, or
  speech-model accuracy qualification is claimed. Existing published v0.2.20 is
  unchanged. PR #22 and the remaining #38 bundle have change requests; #12 is
  closed per the author's withdrawal/supersession recommendation.

## PR38 contributor follow-up (October 6)

Current main `9d19667` is merged into PR38, preserving its app-owned post-call
worker, skip semantics and native-completion cancellation ownership. Feature
history is retained rather than replaying the already ported speaker fixes.
Separate commits address canonical meeting-folder ownership/database-before-file
cleanup, explicit opt-in beta matching, and remote-first mic/system centroid
separation. This is contributor implementation and qualification, not maintainer
approval or a published release.

- 42/42 isolated frontend files, TypeScript checks and final Next production build
  passed, including upstream post-call navigation/skip/cancellation regressions.
- Final Windows CPU native suite: 419 passed, 13 ignored. Deletion fixtures use
  temporary folders/in-memory SQLite, including Windows junction/case aliases and
  injected database/cleanup failures. Capture regressions use synthetic identical
  signals and embeddings; bundled ONNX smoke tests use generated waveform data.
- Ignored audio/model accuracy tests and real Teams/headset reproduction did not
  run. No private recording was deleted or added to Git, no installer was produced,
  and no identity-accuracy or physical headset fix is claimed. See
  `MIC_PLAYBACK_SUPPRESSION.md` for the device reproduction procedure and
  `MEETING_FILE_DELETION.md` for crash/external-filesystem limits.
