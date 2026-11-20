#!/usr/bin/env bash
# Sourced by the build/dev entry points. Based on Noah Passalacqua's PR #61.
# Distro CUDA packages can put static archives outside find_cuda_helper's search.
if [[ "${TAURI_GPU_FEATURE:-}" == cuda && "$OSTYPE" == linux-gnu* ]]; then
    CUDA_LIB_DIR=""
    NVCC_LIB_DIR=""
    if command -v nvcc >/dev/null 2>&1; then
        NVCC_LIB_DIR="$(dirname "$(readlink -f "$(command -v nvcc)")")/../lib64"
    fi
    for candidate in \
        "${CUDA_LIBRARY_PATH:-}" \
        "${CUDA_PATH:+$CUDA_PATH/lib64}" \
        "${CUDA_HOME:+$CUDA_HOME/lib64}" \
        "$NVCC_LIB_DIR" /usr/local/cuda/lib64 /opt/cuda/lib64 \
        "/usr/lib/$(uname -m)-linux-gnu" /usr/lib64; do
        if [[ -n "$candidate" && -f "$candidate/libcudart_static.a" ]]; then
            CUDA_LIB_DIR="$(cd "$candidate" && pwd)"
            break
        fi
    done
    if [[ -n "$CUDA_LIB_DIR" ]]; then
        export RUSTFLAGS="${RUSTFLAGS:+$RUSTFLAGS }-L native=$CUDA_LIB_DIR"
        echo "CUDA static libraries: $CUDA_LIB_DIR"
    else
        echo "CUDA static libraries not found; install the CUDA SDK or set CUDA_PATH." >&2
        exit 1
    fi
fi
