# Audio hardware and Windows setup compatibility

## Audio on devices that do not default to float

`audio/devices/discovery.rs` opens the OS permission probe using the endpoint's
actual sample format. A probe that discards all samples has no reason to demand
`f32`: on an integer-only endpoint a failed format negotiation looked like a
denied microphone permission.

`audio/cpal_input.rs` is shared by CPAL recording and the live setup/selection
meters. It passes `f32` through and converts other CPAL 0.15 numeric formats
using a reusable buffer per stream. Unsigned PCM's midpoint is silence, signed
minimum maps to -1, and channel order and callback timestamps are preserved.
This does not imply packed 24-bit support: a host must expose a supported CPAL
format. Windows loopback asks for the endpoint's shared mix before enumerating
alternatives, preserving the configured rate and channel count when available.

## Windows setup

The interactive universal setup accepts `/BACKEND=cpu`, `/BACKEND=vulkan`, or
`/BACKEND=cuda` as its sole argument; without an override selection remains
automatic. CPU is useful when troubleshooting a driver. NSIS still checks GPU
capabilities. Only the recognized backend value is passed to the inner engine.

The universal engine extracts a bundled executable and backend variants. It
renames the selected variant over `meetily.exe` on the same volume in one
operation. A sharing failure preserves the bundled executable and stops setup
before recording backend success. The outer UI reads the error for that
installation. Start/desktop shortcuts are written after activation so the
shell can resolve the final executable's icon. This ordering is a precaution;
the cause of the reported generic icon on another PC has not been confirmed.

## Focused verification

- `cargo test --locked -p meetily --lib --no-default-features audio::` includes
  synthetic interleaved PCM checks: centering, signed endpoints, a shorter next
  buffer and an empty callback.
- `cargo test --locked -p meetily --lib --no-default-features physical_loopback_selects_the_windows_mix_format -- --ignored --nocapture`
  checks a real default render endpoint's rate/channels/format without recording.
  On the development Windows machine this returned 48 kHz stereo `f32`.
- `frontend/scripts/test-windows-backend-install.ps1` compiles a disposable NSIS
  fixture with the production selection hook and runs it on synthetic files.
  A writable target activates the selected file; a target held without delete
  sharing must survive intact, exit unsuccessfully and not write a new marker.
- The Windows CPU audio suite passed 156 tests (five opt-in tests skipped);
  the real mix-format check above then passed separately. The NSIS fixture
  passed both writable and locked cases.
- An MSVC-built outer setup was exercised against a synthetic engine that only
  recorded arguments. `--verify-payload` exited without opening setup, including
  when invoked via PowerShell `Start-Process`. Interactive automatic, CPU,
  Vulkan and CUDA choices reached that engine with the expected arguments.
  This did not install or run any inference backend. Verify actual Windows
  release assets separately with the normal universal payload verifier.

Physical integer-only USB input, multichannel AV receivers, Bluetooth profile
transitions, older processors, and AMD/Intel GPU inference need separate testing.
