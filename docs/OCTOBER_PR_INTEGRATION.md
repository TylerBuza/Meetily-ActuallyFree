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

- #38: `330e194`; frontend CI passed, but native feature/hardware claims require
  independent checks. Voice matching must remain opt-in and beta.
- #22: `559f1fd`; rebased, native shutdown and ALSA ownership require review.
- #27/#10/#8 conflict with main and require integration plus targeted checks.
- #12 author recommends superseding with upstream; compare behavior before closing.
