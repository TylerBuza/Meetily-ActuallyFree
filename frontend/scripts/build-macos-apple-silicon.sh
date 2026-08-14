#!/bin/bash

set -euo pipefail

TARGET="aarch64-apple-darwin"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$FRONTEND_DIR/.." && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "This build must run on macOS."
    exit 1
fi

command -v cargo >/dev/null || { echo "Rust is required."; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm is required."; exit 1; }

rustup target add "$TARGET"

echo "Building the Apple Silicon llama-helper sidecar..."
(
    cd "$REPO_DIR"
    cargo build --release --package llama-helper --target "$TARGET" --features metal
)

mkdir -p "$FRONTEND_DIR/src-tauri/binaries"
cp \
    "$REPO_DIR/target/$TARGET/release/llama-helper" \
    "$FRONTEND_DIR/src-tauri/binaries/llama-helper-$TARGET"
chmod +x "$FRONTEND_DIR/src-tauri/binaries/llama-helper-$TARGET"

echo "Building the Apple Silicon DMG..."
(
    cd "$FRONTEND_DIR"
    pnpm exec tauri build --target "$TARGET" --bundles dmg
)

echo "Build complete."
find "$REPO_DIR/target/$TARGET/release/bundle/dmg" -maxdepth 1 -name "*.dmg" -print
