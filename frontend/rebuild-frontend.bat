@echo off
REM Fast frontend-only rebuild for the portable CUDA app.
REM 1) next build  2) kill meetily  3) cargo relink (embeds ../out)  4) launch
REM Use this when you only changed TS/CSS. For Rust-only type checks while the
REM app is running, prefer:  build-cuda-env.bat check

setlocal
cd /d "%~dp0"

echo [1/4] Next.js export build...
node node_modules\next\dist\bin\next build
if errorlevel 1 (
  echo Next build failed.
  exit /b 1
)

echo [2/4] Stopping meetily.exe if running...
taskkill /IM meetily.exe /F >nul 2>&1
timeout /t 1 /nobreak >nul

echo [3/4] Relinking Tauri release binary (embeds frontend)...
call build-cuda-env.bat lib
if errorlevel 1 (
  echo Cargo build failed.
  exit /b 1
)

echo [4/4] Launching...
start "" "%~dp0..\target\release\meetily.exe"
echo Done.
endlocal
