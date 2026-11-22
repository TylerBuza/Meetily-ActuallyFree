#!/usr/bin/env bash
# Private Pulse server: default-route changes never touch the desktop's routes.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
temp="$(mktemp -d)"
server=""
cleanup() {
    if [[ -n "$server" ]]; then kill "$server" 2>/dev/null || true; wait "$server" 2>/dev/null || true; fi
    rm -rf "$temp"
}
trap cleanup EXIT
export PULSE_SERVER="unix:$temp/native"
export MEETILY_TEST_PULSE_ISOLATED=1
pulseaudio -n --daemonize=no --use-pid-file=no --exit-idle-time=-1 --disable-shm=true \
    -L "module-native-protocol-unix socket=$temp/native auth-anonymous=1" > "$temp/server.log" 2>&1 &
server=$!
for _ in {1..100}; do
    if pactl info >/dev/null 2>&1; then break; fi
    if ! kill -0 "$server" 2>/dev/null; then cat "$temp/server.log"; exit 1; fi
    sleep 0.05
done
pactl info
cd "$ROOT/frontend/src-tauri"
cargo test --locked -p meetily --lib --no-default-features isolated_linux_default_output -- --ignored --nocapture
cargo test --locked -p meetily --lib --no-default-features graceful_closeout_on_an_isolated_virtual_sink -- --ignored --nocapture
cargo test --locked -p meetily --lib --no-default-features isolated_linux_lifecycle -- --ignored --nocapture --test-threads=1
