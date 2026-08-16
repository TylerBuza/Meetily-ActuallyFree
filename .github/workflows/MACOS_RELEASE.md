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
| Protected environment | `macos-release`, restricted to `main` |
| Release mutability | Immutable for releases created after August 15, 2026 |

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
.\build-cuda-env.bat test accumulation_fails_before_accepting_chunks
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
run URL and derive the run ID used for promotion. Define this resolver once in
the PowerShell session used for the release; it polls only runs created at the
dispatch time and rejects an ambiguous or mismatched run:

```powershell
function Resolve-DispatchedRun {
  param(
    [Parameter(Mandatory)] [string] $Repository,
    [Parameter(Mandatory)] [string] $Workflow,
    [Parameter(Mandatory)] [string] $HeadSha,
    [Parameter(Mandatory)] [DateTimeOffset] $DispatchStarted,
    [AllowEmptyString()] [string] $RunUrl
  )

  $runId = $null
  $urlText = $RunUrl.Trim()
  $escapedRepository = [Regex]::Escape($Repository)
  $notBefore = $DispatchStarted.AddSeconds(-1)
  $runPattern = "^https://github\.com/$escapedRepository/actions/runs/"
  $runPattern += "([0-9]+)$"
  if ($urlText -match $runPattern) {
    $runId = [long]$Matches[1]
  } else {
    for ($attempt = 0; $attempt -lt 12 -and $null -eq $runId; $attempt++) {
      $runsJson = gh run list `
        --repo $Repository `
        --workflow $Workflow `
        --branch main `
        --event workflow_dispatch `
        --limit 20 `
        --json createdAt,databaseId,headSha
      if ($LASTEXITCODE -ne 0) {
        throw "Failed to list $Workflow runs"
      }
      $runs = $runsJson | ConvertFrom-Json
      $matchingRuns = @($runs | Where-Object {
        $_.headSha -eq $HeadSha -and
        ([DateTimeOffset]$_.createdAt) -ge $notBefore
      })
      if ($matchingRuns.Count -gt 1) {
        throw "Multiple matching $Workflow runs exist; inspect Actions"
      }
      if ($matchingRuns.Count -eq 1) {
        $runId = [long]$matchingRuns[0].databaseId
      } else {
        Start-Sleep -Seconds 5
      }
    }
  }

  if ($null -eq $runId) {
    throw "Could not identify exactly one $Workflow run; inspect Actions manually"
  }
  $runJson = gh api "repos/$Repository/actions/runs/$runId"
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to inspect $Workflow run $runId"
  }
  $run = $runJson | ConvertFrom-Json
  if (
    $run.path -ne ".github/workflows/$Workflow" -or
    $run.head_branch -ne "main" -or
    $run.head_sha -ne $HeadSha -or
    $run.event -ne "workflow_dispatch" -or
    ([DateTimeOffset]$run.created_at) -lt $notBefore
  ) {
    throw "Resolved run $runId does not match the dispatch"
  }
  return $run
}
```

Dispatch the candidate and watch the exact resolved run:

```powershell
$repo = "TylerBuza/Meetily-ActuallyFree"
$head = gh api "repos/$repo/git/ref/heads/main" --jq .object.sha
if ($LASTEXITCODE -ne 0) { throw "Failed to resolve current main" }
$dispatchStarted = [DateTimeOffset]::UtcNow
$runUrl = gh workflow run "build-macos.yml" `
  --repo $repo `
  --ref "main" `
  -f "sign-and-notarize=false"
if ($LASTEXITCODE -ne 0) { throw "Candidate dispatch failed" }
$run = Resolve-DispatchedRun `
  -Repository $repo `
  -Workflow "build-macos.yml" `
  -HeadSha $head `
  -DispatchStarted $dispatchStarted `
  -RunUrl (($runUrl | Out-String).Trim())
$runId = $run.id
gh run watch $runId `
  --repo $repo `
  --exit-status
if ($LASTEXITCODE -ne 0) { throw "Candidate run $runId failed" }
```

Do not publish unless `Verify Apple Silicon bundle` and artifact upload both
pass. The uploaded artifact contains the DMG, checksum, first/second-launch
logs, and `macos-build-metadata.json`, which binds it to the run ID, run attempt,
commit, and DMG digest. Never rerun a candidate after physical testing; a rerun
is a different candidate even when its commit is unchanged.
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

Download this exact candidate artifact and complete the physical checklist on
macOS 14.2 before publishing. CI launch success does not replace that gate.

## Publishing

`publish-macos.yml` downloads the candidate by run ID and publishes those exact
bytes. It verifies that the source workflow succeeded, the metadata run ID and
commit equal the publisher's current `main` commit, the run came from the
canonical workflow ID/path, exactly one unexpired artifact exists, and the
checksum matches the DMG. It refuses an existing release or bare tag, atomically
reserves the tag at the candidate commit, verifies every public asset digest and
Latest status, and does not rebuild from `main`.

The publisher uses explicit create-draft, upload, and publish API calls and does
not auto-delete on failure. Cleanup after an ambiguous network/API failure could
delete a release created by another actor. A failed run after tag reservation
can leave a bare tag or draft release. Inspect its target and assets before any
manual cleanup.

The publisher requires an explicit attestation that the checklist below passed
on macOS 14.2 or 14.2.x. Do not set this input based on CI or a newer macOS
version. The protected environment must contain `MACOS_RELEASE_ADMIN_TOKEN`, a
fine-grained token limited to this repository with Administration read access.
The workflow uses it only to verify immutable releases are enabled before it
reserves a tag. The operator should also perform the same privileged check
immediately before dispatch:

```powershell
$settingsJson = gh api "repos/$repo/immutable-releases"
if ($LASTEXITCODE -ne 0) {
  throw "Could not verify immutable releases with Administration read access"
}
$immutableSettings = $settingsJson | ConvertFrom-Json
if ($immutableSettings.enabled -ne $true) {
  throw "Repository immutable releases are disabled; refusing to publish"
}

$candidateHead = gh api "repos/$repo/actions/runs/$runId" --jq .head_sha
if ($LASTEXITCODE -ne 0) { throw "Failed to resolve candidate commit" }
$head = gh api "repos/$repo/git/ref/heads/main" --jq .object.sha
if ($LASTEXITCODE -ne 0) { throw "Failed to resolve current main" }
if ($candidateHead -ne $head) {
  throw "Candidate is not the current main commit; build and test a new candidate"
}

# Copy the lowercase SHA-256 produced on the physical test Mac with:
# shasum -a 256 /path/to/Meetily-Actually-Free_X.Y.Z_aarch64.dmg
$testedDmgSha256 = "replace-with-the-physically-tested-dmg-sha256"
if ($testedDmgSha256 -notmatch '^[0-9a-f]{64}$') {
  throw "A lowercase physical-test DMG SHA-256 is required"
}

$dispatchStarted = [DateTimeOffset]::UtcNow
$publishUrl = gh workflow run "publish-macos.yml" `
  --repo $repo `
  --ref "main" `
  -f "candidate-run-id=$runId" `
  -f "physical-test-attested=true" `
  -f "physical-test-os=14.2" `
  -f "physical-test-dmg-sha256=$testedDmgSha256"
if ($LASTEXITCODE -ne 0) { throw "Publisher dispatch failed" }
$publishRun = Resolve-DispatchedRun `
  -Repository $repo `
  -Workflow "publish-macos.yml" `
  -HeadSha $head `
  -DispatchStarted $dispatchStarted `
  -RunUrl (($publishUrl | Out-String).Trim())
$publishId = $publishRun.id
gh run watch $publishId `
  --repo $repo `
  --exit-status
if ($LASTEXITCODE -ne 0) { throw "Publisher run $publishId failed" }
```

### Immutable Releases And Rollback

Repository release immutability is enabled. The publisher verifies the created
release reports `immutable=true`; this setting requires repository Administration
permission and is managed outside `GITHUB_TOKEN`. Immutable release assets and
the associated tag cannot be changed. Release metadata remains editable, and an
immutable release can be deleted, but its tag name cannot then be reused. Never
plan a same-tag rebuild. If a published macOS release is defective:

1. Fix the defect and increment the app patch version.
2. Build and physically test a new candidate.
3. Publish a new `vX.Y.Z-macos` immutable release.
4. Update README's macOS link and filename to the new tag.
5. Run the public smoke test against the new tag.

If publication fails after reserving a tag but before creating an immutable
release, inspect drafts, releases, assets, and the tag. Delete only resources
whose target and provenance exactly equal the candidate; never delete based on
a name alone.
If the workflow fails after a release already exists, do not rerun publication
or use the public smoke workflow, which intentionally requires a successful
publisher run. Treat the release as unsafe: verify its tag target and
`macos-release-metadata.json` publish run ID match the failed run, delete that
release without deleting its reserved tag, and increment the version. Do not
leave a partially verified release public or reuse its tag.
The legacy `v0.2.5-macos` release predates immutability and is not a template for
future replacement behavior.

After successful promotion, confirm that:

- `vX.Y.Z-macos` targets the intended commit.
- The canonical DMG, checksum, and `macos-release-metadata.json` are present.
- GitHub reports the release as immutable and all API asset digests match.
- The release is not marked Latest.
- Windows `vX.Y.Z` and `latest.json` are unchanged.

## Public Artifact Verification

Run the independent smoke test after every publication:

```powershell
$head = gh api "repos/$repo/git/ref/heads/main" --jq .object.sha
if ($LASTEXITCODE -ne 0) { throw "Failed to resolve current main" }
$dispatchStarted = [DateTimeOffset]::UtcNow
$smokeUrl = gh workflow run "smoke-test-macos-release.yml" `
  --repo $repo `
  --ref "main" `
  -f "release-tag=vX.Y.Z-macos"
if ($LASTEXITCODE -ne 0) { throw "Smoke-test dispatch failed" }
$smokeRun = Resolve-DispatchedRun `
  -Repository $repo `
  -Workflow "smoke-test-macos-release.yml" `
  -HeadSha $head `
  -DispatchStarted $dispatchStarted `
  -RunUrl (($smokeUrl | Out-String).Trim())
$smokeId = $smokeRun.id
gh run watch $smokeId `
  --repo $repo `
  --exit-status
if ($LASTEXITCODE -ne 0) { throw "Smoke-test run $smokeId failed" }
```

This workflow downloads from the public GitHub release. It does not trust the
candidate job's local files. It requires exactly the three canonical assets,
binds release metadata to the candidate run attempt, artifact archive, tested
DMG hash, and tag commit, checks every GitHub asset digest, and rejects a macOS
Latest release.

## Optional Notarization

Publication always requires `MACOS_RELEASE_ADMIN_TOKEN` on the
`macos-release` environment. It must be a fine-grained token limited to this
repository with read-only Administration permission and is used only for the
immutable-release preflight.

Set `sign-and-notarize=true` only when these additional environment secrets are
configured:

- `APPLE_CERTIFICATE`: base64-encoded PKCS#12 (`.p12`) containing the Developer
  ID Application certificate and its private key.
- `APPLE_CERTIFICATE_PASSWORD`: password used to export that `.p12`.
- `APPLE_ID`: Apple developer account email used by the notary service.
- `APPLE_PASSWORD`: app-specific password for that Apple ID, not its normal
  interactive login password.
- `APPLE_TEAM_ID`: the Apple Developer team identifier for the certificate.

The environment is restricted to `main`. The candidate workflow imports the
certificate into a temporary keychain, requires a `Developer ID Application`
identity, and exposes notary credentials only to the Tauri build step.

Ad-hoc signing makes bundle-integrity tests meaningful but does not satisfy
Gatekeeper notarization. Release notes and README must continue warning users
about Control-click and Open until the notarized path succeeds.

## Physical Apple Silicon Checklist

Run these checks on a real M1-or-newer Mac running macOS 14.2 before dispatching
the publisher:

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
9. Run `shasum -a 256` on the tested DMG and preserve the digest for the
   publisher input. Do not rerun the candidate workflow after this test.
10. Select a custom recordings root, record there, and discard a short take.
11. Use a meeting title containing an apostrophe and confirm final FFmpeg merge.
12. Quit and relaunch; verify existing meetings, settings, models, and database.
13. After use, verify the installed bundle again:

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
