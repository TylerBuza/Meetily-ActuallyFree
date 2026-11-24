# Meetily – Actually Free 0.2.24 for Windows

- Finished meetings now list each participant once, including people on later transcript pages. Overlapping speech still shows both names on the affected transcript line.
- USB and other integer-format microphones use their native format for permission checks, meters and recording. Computer audio starts with the Windows playback device's configured mix format.
- Improved timing when capture drops a short audio packet or resamples a 16 or 44.1 kHz source. Stop preserves the resampler's final audio and the recording duration, including trailing silence but excluding pauses. The reported long-call drift is still being investigated.
- Improved recovery of interrupted recordings. Recovery keeps incomplete source checkpoints and orders chunks correctly in long recordings.
- Ignoring a background mic utility such as Logitech G HUB now allows a running Teams app to prompt again. Process-only detection does not start recording automatically.
- Windows setup activates the selected executable before writing shortcuts and reports a locked executable instead of claiming success. Run setup with `/BACKEND=cpu` to troubleshoot GPU drivers.
- New Parakeet downloads use pinned model revisions. Existing meetings, models and settings use the same storage locations.

For a new installation, download the **universal setup**. Existing installations use the signed **universal updater**. CPU, Vulkan and CUDA variants are included. The Windows executables are not Authenticode-signed.

Thanks to the contributors and reporters, including Simone Scarduzio for the resampler and recording-duration work.
