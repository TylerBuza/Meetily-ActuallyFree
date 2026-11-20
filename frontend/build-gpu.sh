#!/bin/bash
# Linux HIP uses the helper's ROCm backend; keep this script LF-terminated.
# GPU-accelerated build script for Meetily
# Automatically detects and builds with optimal GPU features

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 Meetily GPU-Accelerated Build Script${NC}"
echo ""

# Export CUDA flags for Linux/NVIDIA
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    export CMAKE_CUDA_ARCHITECTURES="${CMAKE_CUDA_ARCHITECTURES:-75}"
    export CMAKE_CUDA_STANDARD=17
    export CMAKE_POSITION_INDEPENDENT_CODE=ON
fi

# Detect OS
if [[ "$OSTYPE" == "darwin"* ]]; then
  OS="macos"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
  OS="linux"
else
  echo -e "${RED}❌ Unsupported OS: $OSTYPE${NC}"
  exit 1
fi

# Function to check if command exists
command_exists() {
  command -v "$1" >/dev/null 2>&1
}

# mhlas7's root-invocation fix: never resolve paths from a changed cwd.
FRONTEND_DIR="$SCRIPT_DIR"
cd "$FRONTEND_DIR"

echo ""
echo -e "${BLUE}📦 Building Meetily...${NC}"
echo ""

# Check for pnpm or npm
if command_exists pnpm; then
  PKG_MGR="pnpm"
elif command_exists npm; then
  PKG_MGR="npm"
else
  echo -e "${RED}❌ Neither npm nor pnpm found${NC}"
  exit 1
fi

# Detect GPU feature if not already set
if [ -z "$TAURI_GPU_FEATURE" ]; then
    echo -e "${BLUE}🔍 Detecting GPU features...${NC}"
    TAURI_GPU_FEATURE=$(node scripts/auto-detect-gpu.js)
fi

if [ -n "$TAURI_GPU_FEATURE" ]; then
    echo -e "${GREEN}✅ Detected GPU feature: $TAURI_GPU_FEATURE${NC}"
    export TAURI_GPU_FEATURE
else
    echo -e "${YELLOW}⚠️ No specific GPU feature detected or forced${NC}"
fi

source "$SCRIPT_DIR/scripts/linux-cuda-env.sh"

# Build llama-helper
echo ""
echo -e "${BLUE}🦙 Building llama-helper sidecar (release)...${NC}"

HELPER_DIR="$SCRIPT_DIR/../llama-helper"

if [ ! -d "$HELPER_DIR" ]; then
    echo -e "${RED}❌ Could not find llama-helper directory${NC}"
    exit 1
fi

# Determine llama-helper features
# Note: llama-cpp-2 supports neither coreml (use metal instead) nor the
# `hipblas` name the Tauri transcription crate uses for AMD HIP (use `rocm`).
HELPER_FEATURES=""
if [ -n "$TAURI_GPU_FEATURE" ] && [ "$TAURI_GPU_FEATURE" != "none" ]; then
    LLAMA_FEATURE="$TAURI_GPU_FEATURE"
    if [ "$LLAMA_FEATURE" = "coreml" ]; then
        LLAMA_FEATURE="metal"
        echo -e "${YELLOW}   Note: llama-cpp-2 doesn't support CoreML, using Metal instead${NC}"
    elif [ "$LLAMA_FEATURE" = "hipblas" ]; then
        LLAMA_FEATURE="rocm"
        echo -e "${YELLOW}   Note: llama-cpp-2 uses the ROCm feature for HIP acceleration${NC}"
    fi
    HELPER_FEATURES="--features $LLAMA_FEATURE"
fi

if [ "$TAURI_GPU_FEATURE" = "hipblas" ] && [ -z "$ROCM_PATH" ] && [ -z "$HIP_PATH" ]; then
    for candidate in /opt/rocm /usr/local/rocm /usr/lib64/rocm /usr/lib/rocm; do
        if [ -d "$candidate/lib" ]; then
            export ROCM_PATH="$candidate"
            break
        fi
    done
fi

if [ "$TAURI_GPU_FEATURE" = "hipblas" ]; then
    if [ -n "$ROCM_PATH" ]; then
        echo -e "   Using ROCm SDK at $ROCM_PATH"
    elif [ -n "$HIP_PATH" ]; then
        echo -e "   Using HIP SDK at $HIP_PATH"
    else
        echo -e "${RED}❌ ROCm SDK not found; set ROCM_PATH or HIP_PATH${NC}"
        exit 1
    fi

    # Fedora keeps ROCm's CMake package in /usr/lib64/cmake while the
    # compiler and libraries live below /usr/lib64/rocm.
    SDK_PATH="${ROCM_PATH:-$HIP_PATH}"
    if [ -z "$CMAKE_HIP_COMPILER_ROCM_ROOT" ] && [ -f "$SDK_PATH/lib/cmake/hip-lang/hip-lang-config.cmake" ]; then
        export CMAKE_HIP_COMPILER_ROCM_ROOT="$SDK_PATH"
    elif [ -z "$CMAKE_HIP_COMPILER_ROCM_ROOT" ]; then
        SDK_PARENT="$(dirname "$(dirname "$SDK_PATH")")"
        if [ -f "$SDK_PARENT/lib64/cmake/hip-lang/hip-lang-config.cmake" ]; then
            export CMAKE_HIP_COMPILER_ROCM_ROOT="$SDK_PARENT"
        fi
    fi

    if [ -n "$CMAKE_HIP_COMPILER_ROCM_ROOT" ]; then
        echo -e "   Using HIP CMake root at $CMAKE_HIP_COMPILER_ROCM_ROOT"
    fi
fi

echo -e "   Building in $HELPER_DIR with features: ${HELPER_FEATURES:-none}"
(cd "$HELPER_DIR" && cargo build --locked --release --no-default-features $HELPER_FEATURES)

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Failed to build llama-helper${NC}"
    exit 1
fi

echo -e "${GREEN}✅ llama-helper built successfully${NC}"

# Detect target triple
echo ""
echo -e "${BLUE}🎯 Detecting target triple...${NC}"
TARGET_TRIPLE=$(rustc -vV | grep "host:" | awk '{print $2}')
echo -e "   Target: $TARGET_TRIPLE"

# Copy binary
BINARIES_DIR="$FRONTEND_DIR/src-tauri/binaries"
mkdir -p "$BINARIES_DIR"

# Keep other targets' sidecars; only replace the host's binary below.

BASE_BINARY="llama-helper"
SIDECAR_BINARY="llama-helper-$TARGET_TRIPLE"

if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "win32" ]]; then
    BASE_BINARY="llama-helper.exe"
    SIDECAR_BINARY="llama-helper-$TARGET_TRIPLE.exe"
fi

# Cargo metadata honors both CARGO_TARGET_DIR and workspace configuration.
TARGET_DIR="$(cd "$HELPER_DIR" && cargo metadata --no-deps --format-version 1 | node -e 'let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).target_directory))')"
SRC_PATH="$TARGET_DIR/release/$BASE_BINARY"
DEST_PATH="$BINARIES_DIR/$SIDECAR_BINARY"

if [ -f "$SRC_PATH" ]; then
    cp "$SRC_PATH" "$DEST_PATH"
    echo -e "${GREEN}✅ Copied binary to $DEST_PATH${NC}"
else
    echo -e "${RED}❌ Binary not found at $SRC_PATH${NC}"
    exit 1
fi

# Build using npm scripts
echo -e "${BLUE}Building complete Tauri application...${NC}"
echo ""

# NO_STRIP true due to issues with bundling appImage
NO_STRIP=true $PKG_MGR run tauri:build

if [ $? -eq 0 ]; then
  echo ""
  echo -e "${GREEN}✅ Build completed successfully!${NC}"
  echo ""
  echo -e "${GREEN}🎉 Complete Tauri application built with GPU acceleration!${NC}"
else
  echo ""
  echo -e "${RED}❌ Build failed${NC}"
  exit 1
fi
