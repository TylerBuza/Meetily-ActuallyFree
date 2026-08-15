# macOS Apple Silicon Release Runbook

This runbook is the operational source of truth for the separate macOS release.
Read `ARCHITECTURE.md` section 9 first for the design constraints behind these
steps.

## Release Shape

| Property | Value |
| --- | --- |
| Supported hardware | Apple Silicon (`aarch64-apple-darwin`) |
| Minimum OS | macOS 14.2 Sonoma |
| Public tag | `vX.Y.Z-macos` |
| GitHub Latest | No; Windows `vX.Y.Z` stays Latest |
| Updater manifest | None; macOS must not modify Windows `latest.json` |
| Default signing | Ad-hoc `codesign`, not notarized |
| Candidate workflow | `build-macos.yml` |
| Publication workflow | `publish-macos.yml` |
| Public artifact test | `smoke-test-macos-release.yml` |

The macOS release is intentionally independent from the Windows setup/updater
pair. Never upload the DMG to the Windows release through a generic workflow,
mark the macOS-only release Latest, or point `latest.json` at a DMG.

## Source Invariants

Before building, verify all four minimum-version declarations still say 14.2:

- `frontend/src-tauri/.cargo/config.toml`
- `frontend/src-tauri/tauri.macos.conf.json`
- `.github/workflows/build-macos.yml`
- `README.md`

Also preserve these invariants:

- `Info.plist` contains microphone and Audio Capture usage descriptions.
- `entitlements.plist` contains only entitlements the app actually uses.
- Core data uses `~/Library/Application Support/Meetily`, Tauri plugin stores
  use `~/Library/Application Support/com.meetily.ai`, and neither writes in the
  app bundle. Recordings use Movies or the configured root.
- The macOS backend list exposes Core Audio only.
- The updater provider, onboarding update choice, tray, and About do not invoke
  Tauri updater checks on macOS.
- `audio.mp4`, `mic.mp4`, and `system.mp4` remain MP4 files; FFmpeg concat-list
  paths must escape apostrophes.

## Local Checks

Run the checks available on the development machine before consuming a macOS
runner:

```powershell
Set-Location frontend
pnpm run build
.\build-cuda-env.bat check
.\build-cuda-env.bat test concat_paths_escape_apostrophes
.\build-cuda-env.bat test meeting_
```

Then validate workflow syntax from the repository root:

```powershell
npx --yes yaml-lint `
  ".github/workflows/build-macos.yml" `
  ".github/workflows/publish-macos.yml" `
  ".github/workflows/smoke-test-macos-release.yml"
git diff --check
```

Windows checks do not compile the `#[cfg(target_os = "macos")]` capture code.
The candidate workflow is the required native compile and package gate.

## Candidate Build

The build workflow is candidate-only and cannot publish. Capture its returned
run URL and derive the run ID used for promotion:

```powershell
$runUrl = gh workflow run "build-macos.yml" `
  --repo "TylerBuza/Meetily-ActuallyFree" `
  --ref "main" `
  -f "sign-and-notarize=false"
$runId = ($runUrl.TrimEnd('/') -split '/')[-1]
```

Watch that exact candidate:

```powershell
gh run watch $runId `
  --repo "TylerBuza/Meetily-ActuallyFree" `
  --exit-status
```

Do not publish unless `Verify Apple Silicon bundle` and artifact upload both
pass. The uploaded artifact contains the DMG, checksum, first/second-launch
logs, and `macos-build-metadata.json`, which binds it to the run ID and commit.
The workflow verifies:

1. The app, FFmpeg, and `llama-helper` are ARM64.
2. The packaged minimum system version is 14.2.
3. Required plist strings and the expected entitlement set are present.
4. Diarization models, templates, icons, and sidecars are bundled.
5. FFmpeg performs a generated-audio encode and decode operation.
6. `llama-helper` starts, answers its health endpoint, and shuts down.
7. The app survives a fresh first launch and writes SQLite/onboarding state.
8. Runtime data appears in Application Support, not inside the app bundle.
9. The installed app still passes strict signature verification after launch.
10. The same installed app reopens its existing database without fatal logs.
11. The app still passes strict signature verification after the second launch.

Download the candidate artifact from the Actions run when a physical Mac is
available. CI launch success does not replace the physical checklist below.

## Publishing

`publish-macos.yml` downloads the candidate by run ID and publishes those exact
bytes. It verifies that the source workflow succeeded, the metadata run ID and
commit agree with GitHub, the run came from the production workflow path on
`main`, and the checksum matches the DMG. It refuses an existing release or bare
tag, atomically reserves the tag at the candidate commit, verifies the final tag
target, and does not rebuild from `main`.

The publisher deliberately does not auto-delete on failure: cleanup after an
ambiguous network/API failure could delete a release created by another actor.
A failed run after tag reservation can leave a bare candidate tag. Inspect its
target before deleting it and retrying or restoring the previous release.

For a new version, promote the successful candidate:

```powershell
$publishUrl = gh workflow run "publish-macos.yml" `
  --repo "TylerBuza/Meetily-ActuallyFree" `
  --ref "main" `
  -f "candidate-run-id=$runId"
$publishId = ($publishUrl.TrimEnd('/') -split '/')[-1]
gh run watch $publishId `
  --repo "TylerBuza/Meetily-ActuallyFree" `
  --exit-status
```

The publisher refuses to overwrite an existing release. Replacing a tag is
destructive and should happen only after the candidate passes and replacement is
explicitly intended. Before deletion, download the old assets and preserve its
target and release notes so rollback does not depend on GitHub retaining them:

```powershell
$backup = Join-Path $env:TEMP `
  ("meetily-old-macos-release-" + [guid]::NewGuid().ToString("N"))
$utf8 = New-Object System.Text.UTF8Encoding($false)
New-Item -ItemType Directory $backup | Out-Null
gh release download "vX.Y.Z-macos" `
  --repo "TylerBuza/Meetily-ActuallyFree" `
  --dir $backup
if ($LASTEXITCODE -ne 0) { throw "Failed to download the existing release" }
$release = gh release view "vX.Y.Z-macos" `
  --repo "TylerBuza/Meetily-ActuallyFree" `
  --json name,body,url `
  | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "Failed to read the existing release" }
$releaseJson = $release | ConvertTo-Json -Depth 10
[IO.File]::WriteAllText(
  (Join-Path $backup "release.json"), $releaseJson, $utf8)
$oldTarget = gh api `
  "repos/TylerBuza/Meetily-ActuallyFree/git/ref/tags/vX.Y.Z-macos" `
  --jq .object.sha
if ($LASTEXITCODE -ne 0) { throw "Failed to resolve the existing tag" }
[IO.File]::WriteAllText(
  (Join-Path $backup "target.txt"), $oldTarget, $utf8)
$oldDmg = @(Get-ChildItem $backup -Filter "*.dmg" -File)
$oldSum = Join-Path $backup "SHA256SUMS-macos.txt"
if ($oldDmg.Count -ne 1 -or !(Test-Path -LiteralPath $oldSum)) {
  throw "The release backup is incomplete; refusing to delete"
}
gh release delete "vX.Y.Z-macos" `
  --repo "TylerBuza/Meetily-ActuallyFree" `
  --cleanup-tag `
  --yes
```

Then dispatch `publish-macos.yml` with the already successful `$runId`. If
promotion fails after deletion, recreate the old release from the preserved
target, body, DMG, and checksum before further work:

```powershell
$release = Get-Content (Join-Path $backup "release.json") | ConvertFrom-Json
[IO.File]::WriteAllText(
  (Join-Path $backup "release-notes.md"), $release.body, $utf8)
$oldTarget = Get-Content (Join-Path $backup "target.txt")
$oldDmg = (Get-ChildItem $backup -Filter "*.dmg" -File).FullName
$oldSum = Join-Path $backup "SHA256SUMS-macos.txt"
$expectedCandidate = gh api `
  "repos/TylerBuza/Meetily-ActuallyFree/actions/runs/$runId" `
  --jq .head_sha
if ($LASTEXITCODE -ne 0) { throw "Failed to resolve the candidate commit" }
$partialTarget = gh api `
  "repos/TylerBuza/Meetily-ActuallyFree/git/ref/tags/vX.Y.Z-macos" `
  --jq .object.sha 2>$null
if ($LASTEXITCODE -eq 0) {
  if ($partialTarget -ne $expectedCandidate) {
    throw "The partial tag is not owned by this candidate; stop and inspect"
  }
  gh release delete "vX.Y.Z-macos" `
    --repo "TylerBuza/Meetily-ActuallyFree" `
    --cleanup-tag `
    --yes
  gh api --method DELETE `
    "repos/TylerBuza/Meetily-ActuallyFree/git/refs/tags/vX.Y.Z-macos" `
    2>$null
}
gh release create "vX.Y.Z-macos" $oldDmg $oldSum `
  --repo "TylerBuza/Meetily-ActuallyFree" `
  --target $oldTarget `
  --title $release.name `
  --notes-file (Join-Path $backup "release-notes.md") `
  --latest=false
```

After successful promotion, confirm that:

- `vX.Y.Z-macos` targets the intended commit.
- The DMG and `SHA256SUMS-macos.txt` are present.
- The release is not marked Latest.
- Windows `vX.Y.Z` and `latest.json` are unchanged.

## Public Artifact Verification

Run the independent smoke test after every publication:

```powershell
$smokeUrl = gh workflow run "smoke-test-macos-release.yml" `
  --repo "TylerBuza/Meetily-ActuallyFree" `
  --ref "main" `
  -f "release-tag=vX.Y.Z-macos"
$smokeId = ($smokeUrl.TrimEnd('/') -split '/')[-1]
gh run watch $smokeId `
  --repo "TylerBuza/Meetily-ActuallyFree" `
  --exit-status
```

This workflow downloads from the public GitHub release. It does not trust the
candidate job's local files, so it detects an incorrect upload, stale asset, or
release/tag mismatch.

## Optional Notarization

Set `sign-and-notarize=true` only when all required secrets are configured in
these formats:

- `APPLE_CERTIFICATE`: base64-encoded PKCS#12 (`.p12`) containing the Developer
  ID Application certificate and its private key.
- `APPLE_CERTIFICATE_PASSWORD`: password used to export that `.p12`.
- `APPLE_ID`: Apple developer account email used by the notary service.
- `APPLE_PASSWORD`: app-specific password for that Apple ID, not its normal
  interactive login password.
- `APPLE_TEAM_ID`: the Apple Developer team identifier for the certificate.

The candidate workflow imports the certificate into a temporary keychain and
requires a `Developer ID Application` signing identity before it builds.

Ad-hoc signing makes bundle-integrity tests meaningful but does not satisfy
Gatekeeper notarization. Release notes and README must continue warning users
about Control-click and Open until the notarized path succeeds.

## Physical Apple Silicon Checklist

Run these checks on a real M1-or-newer Mac before calling the release fully
qualified:

1. Install the DMG into Applications and complete first-run Gatekeeper flow.
2. Confirm microphone permission prompts and a live microphone meter.
3. Play continuous audible media while running the up-to-five-second system-audio
   probe; verify permission grant and a successful meter.
4. Deny Audio Capture, retry, grant it in System Settings, and retest.
5. Change the default output between speakers, headphones, and Bluetooth where
   available; confirm the global tap follows the current default route.
6. Record mic-only, system-only, and simultaneous speech.
7. Pause, resume, minimize to the compact bar, and stop from main, minibar, and
   tray paths without duplicate completion or a stuck monitor.
8. Verify `audio.mp4`, `mic.mp4`, and `system.mp4` play and remain aligned.
9. Select a custom recordings root, record there, and discard a short take.
10. Use a meeting title containing an apostrophe and confirm final FFmpeg merge.
11. Quit and relaunch; verify existing meetings, settings, models, and database.
12. After use, verify the installed bundle again:

```bash
codesign --verify --deep --strict "/Applications/Meetily - Actually Free.app"
```

## Failure Triage

- **macOS-only Rust compile failure:** Inspect `audio/capture/core_audio.rs`,
  `backend_config.rs`, and target-specific `cfg` branches.
- **App launches once but its signature later fails:** Inspect `paths.rs` and
  runtime writes derived from `current_exe()` or resource paths.
- **Output exists but the system meter is silent:** Check Audio Capture
  permission, audible playback during the probe, and the default output route.
- **Retest starts or stops the wrong meter:** Inspect the `AudioTestStep`
  transition chain and generation checks.
- **Custom folder is ignored:** Trace `recording_commands.rs` through
  `RecordingManager` into each saver.
- **A short take cannot be discarded:** Inspect canonical allowed-root checks in
  `recording_preferences.rs`.
- **FFmpeg merge fails for a title or path:** Inspect concat escaping in
  `incremental_saver.rs` and meeting-title sanitization.
- **About or tray tries to update on macOS:** Inspect `UpdateCheckProvider`,
  `About`, `tray.rs`, and the onboarding update preference.
- **Public smoke differs from the candidate:** Inspect the release target,
  uploaded assets, checksum, and exact public tag.
