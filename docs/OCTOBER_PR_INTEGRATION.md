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

## Pending review

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
