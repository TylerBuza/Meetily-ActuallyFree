# DevTest Build Workflow

This document explains how to use the `build-devtest.yml` workflow for building and testing.

## Overview

The DevTest workflow is specifically designed for development and testing purposes. It:
- Builds for all platforms (macOS, Windows, Linux)
- Has **code signing disabled by default** to speed up builds
- Allows **optional signing** via workflow dispatch input
- Uploads artifacts for testing

## Triggering the Workflow

The workflow runs via **manual dispatch only**:

1. Go to **Actions** tab in your GitHub repository
2. Select **Build and Test - DevTest** from the left sidebar
3. Click **Run workflow** button
4. Configure options:
   - **Branch**: Select the branch to build
   - **Sign the build**: Check to enable code signing (default: unchecked)
   - **Upload build artifacts**: Check to upload artifacts (default: checked)
5. Click **Run workflow** to start

## Workflow Options

### Sign the build
- **Unchecked (default)**: Fast builds without code signing (~25-30 minutes)
- **Checked**: Full code signing for all platforms (~35-45 minutes)

### Upload build artifacts
- **Checked (default)**: Artifacts are uploaded and available for download
- **Unchecked**: Build runs but no artifacts are saved

## Build Matrix

The workflow builds for all platforms in parallel:

| Platform | Target | Output |
|----------|--------|--------|
| macOS (Apple Silicon) | aarch64-apple-darwin | DMG + App |
| Windows (x64) | x86_64-pc-windows-msvc | MSI + NSIS |
| Linux (Ubuntu 22.04) | x86_64-unknown-linux-gnu | DEB |
| Linux (Ubuntu 24.04) | x86_64-unknown-linux-gnu | AppImage + RPM |

## Code Signing Details

When signing is enabled:

### macOS
- Uses **Apple Developer Certificate** from secrets
- Performs **notarization** with Apple ID
- Signs both DMG and .app bundle
- Verifies signatures with `codesign` and `spctl`

### Windows
- Uses **DigiCert KeyLocker** (cloud HSM)
- Signs both MSI and NSIS installers
- Verifies signatures with PowerShell

### Linux
- Uses **Tauri updater signing** (Ed25519)
- Signs update manifests for auto-updater

## Build Artifacts

Artifacts are automatically uploaded and retained for **14 days**:

- **macOS**: `*.dmg`, `*.app`, `*.app.tar.gz`, `*.app.tar.gz.sig`
- **Windows**: `*.msi`, `*.msi.sig`, `*.exe`, `*.exe.sig`
- **Linux**: `*.deb`, `*.AppImage`, `*.rpm`

### Downloading Artifacts

1. Go to **Actions** tab
2. Select the completed workflow run
3. Scroll down to **Artifacts** section
4. Click on the artifact name to download

## Examples

### Example 1: Unsigned Build (Default, Fast)

1. Go to Actions > Build and Test - DevTest
2. Click "Run workflow"
3. Leave all options at defaults
4. Click "Run workflow"

**Result:** Builds without signing in ~25-30 minutes

---

### Example 2: Signed Build

1. Go to Actions > Build and Test - DevTest
2. Click "Run workflow"
3. Check "Sign the build"
4. Click "Run workflow"

**Result:** Builds with full code signing in ~35-45 minutes

## Hardware Acceleration

Each platform uses optimal hardware acceleration:

| Platform | Acceleration | Performance |
|----------|-------------|-------------|
| macOS | Metal GPU | 10-15x faster than CPU |
| Windows | Vulkan GPU | 5-10x faster than CPU |
| Linux | OpenBLAS CPU | 2-3x faster than vanilla CPU |

## Troubleshooting

### Signing Not Working

**Problem:** Signing enabled but builds are still unsigned

**Solutions:**
1. Verify all required secrets are configured in repository settings
2. Check the workflow logs for specific error messages
3. Ensure secrets haven't expired

### Build Failures

**Problem:** Build fails during signing phase

**Solutions:**
1. Check that all required secrets are configured:
   - `APPLE_CERTIFICATE`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`
   - `SM_HOST`, `SM_API_KEY`, `SM_CODE_SIGNING_CERT_SHA1_HASH`
   - `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
2. Review workflow logs for specific error messages
3. Try running without signing first to isolate the issue

### Artifacts Not Available

**Problem:** Can't download build artifacts

**Solutions:**
1. Check workflow status - artifacts only available after successful build
2. Artifacts expire after 14 days
3. Ensure "Upload build artifacts" was checked when running

## Performance Comparison

| Build Type | Duration | When to Use |
|------------|----------|-------------|
| **Unsigned** (default) | ~25-30 min | Regular development, quick testing |
| **Signed** | ~35-45 min | Pre-release testing, production-like testing |

## Best Practices

1. **Use unsigned builds** for routine development and testing
2. **Enable signing** only when:
   - Testing production-like scenarios
   - Preparing for release
   - Testing installer behavior
   - Verifying code signing infrastructure
3. **Always test** locally before triggering workflow to save CI time
4. **Review** the workflow summary to confirm build status

## Workflow Configuration

Located at: `.github/workflows/build-devtest.yml`

Key configuration:
- **Default signing:** OFF
- **Artifact retention:** 14 days
- **Parallel builds:** All platforms simultaneously
- **Trigger:** Manual dispatch only

## Related Workflows

- `build-macos.yml` - macOS-specific builds with signing
- `build-windows.yml` - Windows-specific builds with signing
- `build-linux.yml` - Linux-specific builds with signing
- `build-test.yml` - All platforms with signing (pre-release)
- `build-macos.yml` can publish the separate Apple Silicon release; see `ARCHITECTURE.md` for the Windows universal release process
