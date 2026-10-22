# October 22 macOS stability integration

## Scope and ownership

- #56: portable built-in microphone classification and Ogg fixture generation.
- #46: disable Core Audio tap auto-start so startup silence yields callbacks.
  The stream's five-second inactivity path emits one warning per stall and keeps
  microphone capture running. Arrival resumes the existing tap; stream end and
  sample-rate changes remain terminal. Both recording start commands install the
  warning callback; state cleanup releases it. No engine substitution is added.
- #53: pure recording-start error formatter handles strings, Error instances,
  serialized errors, and backend-specific unknown failures.
- #47: runtime-resolved read-only private TCC query distinguishes authorization
  from audible capture. A two-second short-lived same-binary query avoids TCC's
  per-process cache; it exits before app/logging startup. Missing API falls back
  to the existing audible probe. We additionally recheck cached grants and ensure
  an explicit denial invalidates session proof. No permissions are auto-granted.
- #42's separate live Nemotron error: mel transpose now explicitly produces
  standard contiguous `(batch, time, features)` storage before ORT receives a
  borrowed tensor. `ndarray::to_owned()` alone preserves transposed strides.
  A synthetic regression verifies the old layout, shorter live windows, and every
  feature's time/band ordering. This changes layout, not signal values or labels.

Contributor commits retain their authorship. #50's app identity/storage migration,
#52's per-app redesign, and the larger capture/echo/deletion PRs are not included.
Data paths, database migrations, saved recording formats, and model activation
contracts are unchanged. Windows release publication remains on hold.

## Qualification

- 34 isolated frontend test files passed after integration, including permission
  revocation and recording-error coverage.
- Next production build/type validation passed. Windows CPU native suite passed
  **382 tests, 10 ignored**, including the warning-state, permission-code mapping,
  and mel-layout regression. No ignored model/audio tests ran. A fresh Cargo target
  directory was required because the old local build cache had missing source files.
- Candidate CI now runs the complete native library suite serially, then checks
  the packaged permission-helper entry point with a five-second timeout.
- Release version is 0.2.22, selected after checking published v0.2.21-macos.
  A build is not publication; completed CI/publication results will be recorded.
- Contributor physical tests are reported in #46/#47; they are not independent
  tests on the original reporter's Mac. This host is Windows. Physical Mac capture,
  Bluetooth/multi-output routing, macOS 14.2 runtime behavior, and real-model live
  Nemotron accuracy require separate confirmation. No private fixtures are added.

## Publication blocker

Resolved: the owner re-enabled workflows from GitHub's fork-workflow pause page.
Candidate `39810916314` built source `f59fedb08a54566d2502658bd130bece1e743fef`
and passed **374 native tests, 8 ignored**, the packaged permission helper (status
2/not determined on the runner), and bundle validation. The Nemotron layout test
passed. Publication and public-download smoke verification follow separately.
The blocker details below are historical.

Source `1f7c563` is pushed to main and `fix/mac-oct22`. The Mac candidate dispatch
failed with HTTP 422, **“Actions has been disabled for this repository.”** The
repository Actions permission API nevertheless reports `enabled: true` and all
three Mac workflows are active. This is not a passing or queued Mac build.
No 0.2.22 tag, DMG, or release has been published. v0.2.21-macos remains the
current Mac preview; Windows v0.2.20 remains Latest.

After the GitHub restriction is cleared, dispatch `build-macos.yml` on main,
require its full native suite and packaged helper/bundle checks to pass, then
publish that exact candidate with `preview=true`. Run the public-DMG smoke test
and update the README and issue #42 with the verified release. Keep #46/#47/#53/
#56 open pending Mac qualification; their source changes are already incorporated.
