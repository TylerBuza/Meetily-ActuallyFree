@echo off
REM Fork build helper: MSVC + LLVM + reassembled CUDA toolkit + Ninja.
REM Usage: build-cuda-env.bat [helper|libhelper|lib|bundle|check]
REM   check = cargo check only (type-check, NO exe link) - safe to run while the
REM           app is still running (won't hit LNK1104 on the locked meetily.exe).
setlocal enabledelayedexpansion

set "ROOT=%~dp0"
set "REPO=%ROOT%.."

REM --- MSVC environment ---
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1

REM --- Toolchain env ---
set "LIBCLANG_PATH=C:\Program Files\LLVM\bin"
REM LLVM 22 libclang breaks whisper-rs-sys bindgen (opaque structs); use its pre-generated bindings
set "WHISPER_DONT_GENERATE_BINDINGS=1"
REM Reassembled, working CUDA 13.3 toolkit (user-space; nvcc test compile passes)
set "CUDA_PATH=C:\Users\tyler\Documents\BuzaMeet\.cuda_toolkit"
set "CUDA_TOOLKIT_ROOT_DIR=%CUDA_PATH%"
set "CMAKE_GENERATOR=Ninja"
set "CMAKE_CUDA_ARCHITECTURES=89"
REM CUDA 13 CCCL (thrust/cub) needs C++17 + MSVC conforming preprocessor for .cu host compile
set "NVCC_APPEND_FLAGS=-std=c++17 -Xcompiler=/Zc:preprocessor -DCCCL_IGNORE_MSVC_TRADITIONAL_PREPROCESSOR_WARNING"
set "NINJA_DIR=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja"
set "PATH=C:\Program Files\CMake\bin;%NINJA_DIR%;%CUDA_PATH%\bin;%CUDA_PATH%\bin\x64;%USERPROFILE%\.cargo\bin;%PATH%"
set "TAURI_GPU_FEATURE=cuda"

echo === Build env ===
where cl.exe
where nvcc.exe
where cmake.exe
where ninja.exe
where cargo.exe
echo CUDA_PATH=%CUDA_PATH%
echo CMAKE_GENERATOR=%CMAKE_GENERATOR%  ARCH=%CMAKE_CUDA_ARCHITECTURES%
echo =================

set "MODE=%~1"
if "%MODE%"=="" set "MODE=lib"

if /I "%MODE%"=="helper"    goto :helper
if /I "%MODE%"=="libhelper" goto :helper
if /I "%MODE%"=="lib"       goto :lib
if /I "%MODE%"=="bundle"    goto :bundle
if /I "%MODE%"=="check"     goto :check
if /I "%MODE%"=="test"      goto :test
echo Unknown mode: %MODE%
exit /b 1

:helper
echo [helper] building llama-helper (CPU) release
cd /d "%REPO%\llama-helper"
cargo build --release
if errorlevel 1 ( echo [helper] build FAILED & exit /b 1 )
if not exist "%ROOT%src-tauri\binaries" mkdir "%ROOT%src-tauri\binaries"
copy /Y "%REPO%\target\release\llama-helper.exe" "%ROOT%src-tauri\binaries\llama-helper-x86_64-pc-windows-msvc.exe" >nul
if errorlevel 1 ( echo [helper] copy FAILED & exit /b 1 )
echo [helper] sidecar copied OK
if /I "%MODE%"=="libhelper" goto :lib
exit /b 0

:lib
echo [lib] building meetily --release --features cuda,custom-protocol
cd /d "%ROOT%src-tauri"
cargo build --release --features cuda,custom-protocol
if errorlevel 1 exit /b %errorlevel%
REM Stage bundled resources next to the exe. For a packaged build Tauri does
REM this itself, but a plain `cargo build` doesn't - and resource_dir() resolves
REM to the exe folder, so diarization models + templates must be copied here.
set "STAGE=%REPO%\target\release"
if not exist "%STAGE%\resources\diarization" mkdir "%STAGE%\resources\diarization"
copy /Y "%ROOT%src-tauri\resources\diarization\*" "%STAGE%\resources\diarization\" >nul
if not exist "%STAGE%\templates" mkdir "%STAGE%\templates"
copy /Y "%ROOT%src-tauri\templates\*.json" "%STAGE%\templates\" >nul
echo [lib] staged bundled resources (diarization models, templates)
exit /b 0

:check
echo [check] cargo check meetily --release --features cuda,custom-protocol (no exe link)
cd /d "%ROOT%src-tauri"
cargo check --release --features cuda,custom-protocol
exit /b %errorlevel%

:test
REM Run a specific test with output shown, e.g.:
REM   build-cuda-env.bat test diarize_sample
echo [test] cargo test --release --features cuda %~2
cd /d "%ROOT%src-tauri"
cargo test --release --features cuda %~2 -- --nocapture --test-threads=1
exit /b %errorlevel%

:bundle
echo [bundle] pnpm run tauri:build:cuda
cd /d "%ROOT%"
call pnpm run tauri:build:cuda
exit /b %errorlevel%
