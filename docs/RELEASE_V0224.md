# Meetily – Actually Free 0.2.24 for Windows

- Finished meetings now list each participant once, including people on later transcript pages. Overlapping speech still shows both names on the affected transcript line.
- USB and other integer-format microphones use their native format for permission checks, meters and recording. Computer audio starts with the Windows playback device's configured mix format.
- Improved timing when capture drops a short audio packet or resamples a 16 or 44.1 kHz source. Stop preserves the resampler's final audio and the recording duration, including trailing silence but excluding pauses. The reported long-call drift is still being investigated.
- Improved recovery of interrupted recordings. Recovery keeps incomplete source checkpoints and orders chunks correctly in long recordings.
- Ignoring a background mic utility such as Logitech G HUB now allows a running Teams app to prompt again. Process-only detection does not start recording automatically.
- Windows setup activates the selected executable before writing shortcuts and reports a locked executable instead of claiming success. Run setup with `/BACKEND=cpu` to troubleshoot GPU drivers.
- New Parakeet downloads use pinned model revisions. Existing meetings, models and settings use the same storage locations.

For a new installation, download the **universal setup**. Existing installations use the signed **universal updater**. CPU, Vulkan and CUDA variants are included. The Windows executables are not Authenticode-signed.

### Thanks

- @fernandog measured the stepwise drift between the microphone and system tracks in [#73](https://github.com/TylerBuza/Meetily-ActuallyFree/issues/73). Those measurements helped us test the timing fixes; confirmation on the affected setup is still open.
- @sscarduzio contributed the [recording-duration fix](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/58) and the [fix that keeps the last samples when stopping a non-48 kHz recording](https://github.com/TylerBuza/Meetily-ActuallyFree/pull/59).
- @slappa81 reported that Logitech G HUB could prevent Teams detection even when the utility was on the ignore list ([#76](https://github.com/TylerBuza/Meetily-ActuallyFree/issues/76)).

### From upstream Meetily

Thanks to @safvanatzack for [upstream #805](https://github.com/Zackriya-Solutions/meetily/pull/805), merged into [Meetily v0.5.0](https://github.com/Zackriya-Solutions/meetily/releases/tag/v0.5.0). We adapted its Parakeet download changes: new downloads use pinned Hugging Face revisions, and the fork keeps its v3 fallback mirror.
