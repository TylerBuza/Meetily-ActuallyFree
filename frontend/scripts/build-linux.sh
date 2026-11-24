#!/usr/bin/env bash
# Reproducible Linux candidate entry point; no auto-detected backend or publication.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
backend="${1:-cpu}"
profile="${2:-release}"
[[ "$(uname -s)" == Linux ]] || { echo 'Run this on Linux.' >&2; exit 1; }
case "$backend" in cpu|vulkan) ;; *) echo 'Backend must be cpu or vulkan.' >&2; exit 1;; esac
case "$profile" in debug|release) ;; *) echo 'Profile must be debug or release.' >&2; exit 1;; esac
cd "$ROOT"
export CMAKE_POLICY_VERSION_MINIMUM="${CMAKE_POLICY_VERSION_MINIMUM:-3.5}"
export CMAKE_PROJECT_INCLUDE_BEFORE="$ROOT/frontend/scripts/linux-portable-cpu.cmake"
triple="$(rustc -vV | sed -n 's/^host: //p')"
[[ "$triple" == x86_64-unknown-linux-gnu ]] || { echo 'Only Linux x86_64 candidates are qualified by this script.' >&2; exit 1; }
target="$(cargo metadata --no-deps --format-version 1 | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')"
# The pinned sys build scripts do not track arbitrary forwarded CMAKE_* changes.
# Reconfigure these two libraries so a previous source build cannot leave host-
# tuned machine code in an otherwise portable candidate.
cargo clean -p whisper-rs-sys -p llama-cpp-sys-2
helper_args=(--locked -p llama-helper --no-default-features)
app_args=(build --bundles deb,appimage --features custom-protocol)
if [[ "$profile" == release ]]; then helper_args+=(--release); else app_args+=(--debug); fi
if [[ "$backend" == vulkan ]]; then
    helper_args+=(--features vulkan)
    app_args=(build --bundles deb,appimage --features custom-protocol,vulkan)
    [[ "$profile" != debug ]] || app_args+=(--debug)
    # Tauri doesn't infer the Vulkan loader dependency from the ELF. Merge the
    # complete list because JSON merge patches replace arrays.
    vulkan_config="$(python3 -c '
import json
with open("frontend/src-tauri/tauri.linux.conf.json") as config:
    depends = json.load(config)["bundle"]["linux"]["deb"]["depends"]
print(json.dumps({"bundle": {"linux": {"deb": {"depends": [*depends, "libvulkan1"]}}}}))
')"
    app_args+=(--config "$vulkan_config")
fi
CMAKE_DISABLE_FIND_PACKAGE_OpenSSL=TRUE cargo build "${helper_args[@]}"
mkdir -p frontend/src-tauri/binaries
install -m 755 "$target/$profile/llama-helper" "frontend/src-tauri/binaries/llama-helper-$triple"
cd frontend
# Tauri serializes its frontend build before Cargo embeds frontend/out.
pnpm exec tauri "${app_args[@]}" -- --locked --no-default-features
python3 scripts/verify-linux-package.py "$target/$profile/bundle"
