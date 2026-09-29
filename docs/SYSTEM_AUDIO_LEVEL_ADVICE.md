# System audio level advice

System gain is applied in `audio/pipeline.rs` before the source meter, VAD,
transcription, and saved tracks. There is no universal Windows volume percentage
or amplitude that guarantees transcription. VAD thresholds are model speech
probabilities, not digital amplitude thresholds.

`frontend/src/lib/system-audio-level.ts` owns an advisory heuristic using existing
native post-gain RMS/peak events. `LiveAudioVisualizer.tsx` owns its lifecycle and
displays Low audio on live system meters in the recorder and minibar. The existing
limiter warning becomes a visible Too loud badge and takes precedence. Device
preview meters do not run this recording-only check or multiply gain twice.

Five seconds of consecutive nonzero samples with RMS between -80 and -45 dBFS
and peaks below -30 dBFS triggers the advice. Silence, stronger audio, invalid
samples, an event gap over 300 ms or a lifecycle reset clears accumulation.
No callbacks clears displayed advice after one second. Pause, source changes
and unmount clean up the timer. Microphone input is excluded.

These are advisory heuristics, not calibrated ASR minimums. Quiet background noise
can qualify, so the text says "If someone is speaking" and points to System volume
in the redesigned recorder's Output settings. Short quiet utterances may not
trigger advice. Gain, VAD and recordings are never modified automatically.
Tests cover timing, recovery, silence, invalid values, missing events and reset.
The component lifecycle test also verifies source filtering, no-event expiration,
limiter priority and pause cleanup. Run `tests/audio-levels` separately from
other Bun groups because it mocks the Tauri event module.
Real-call threshold calibration remains open.
