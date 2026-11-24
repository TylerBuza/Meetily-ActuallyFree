# Meetily 0.2.24 — Apple Silicon preview

For Apple Silicon Macs on macOS 14.2 or later. This is an ad-hoc-signed, non-notarized preview; Windows remains on its own update channel.

- Correct participant counts on first opening a finished meeting, including overlapping speakers and longer transcripts.
- Better handling of integer audio formats, resampler tails, saved recording duration and checkpoint recovery.
- A failed chosen-app tap no longer falls back to recording every application. Choose one app and start playing audio in it before recording. Helpers and apps that start playing later are not automatically followed in this preview.
- New Parakeet downloads use pinned revisions. Existing meetings, models and settings retain their storage locations.

The candidate workflow checks native compilation, packaging and launch. A CI launch does not qualify microphone permissions, capture isolation on every app, or a physical macOS 14.2 recording. Feedback on those cases is welcome.

### Thanks

- @sscarduzio identified the chosen-app capture problem in [#52](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/52) and contributed the [recording-duration](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/58) and [resampler-tail](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/59) fixes. This preview takes the capture-isolation fix from #52; it still supports one chosen app at a time.
- @bikram990 tested earlier Mac previews and confirmed the misleading permission banner was gone in [#42](https://github.com/TylerBuza/Meetily-ActuallyFree/issues/42). @fernandog’s [track-drift measurements](https://github.com/TylerBuza/Meetily-ActuallyFree/issues/73) helped guide work on shared audio timing.

### From upstream Meetily

We adapted two changes merged into [Meetily v0.5.0](https://github.com/Zackriya-Solutions/meetily/releases/tag/v0.5.0): @safvanatzack’s [Parakeet download fix (#805)](https://github.com/Zackriya-Solutions/meetily/pull/805) and @sujithatzackriya’s [release-build fix (#915)](https://github.com/Zackriya-Solutions/meetily/pull/915). The Apple Silicon summary helper now builds without an unnecessary OpenSSL dependency.
