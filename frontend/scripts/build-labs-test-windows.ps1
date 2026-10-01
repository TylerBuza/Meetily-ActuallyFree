param([switch]$Cuda)

$ErrorActionPreference = 'Stop'
$frontend = Split-Path $PSScriptRoot -Parent
$repo = Split-Path $frontend -Parent
$tauri = Join-Path $frontend 'src-tauri'
$appVersion = (Get-Content (Join-Path $tauri 'tauri.conf.json') -Raw | ConvertFrom-Json).version
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Visual Studio Build Tools locator is missing' }
$vsInstall = (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath).Trim()
$vcvars = Join-Path $vsInstall 'VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path -LiteralPath $vcvars)) { throw "Visual Studio x64 tools are missing: $vcvars" }

# Import the C++ environment into this PowerShell process for whisper.cpp.
cmd /c "call `"$vcvars`" >nul 2>&1 && set" | ForEach-Object {
  if ($_ -match '^([^=]+)=(.*)$') {
    [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
  }
}
$env:ORT_LIB_LOCATION = Join-Path $tauri 'binaries\onnxruntime'
$env:LIBCLANG_PATH = 'C:\Program Files\LLVM\bin'
$env:CMAKE_GENERATOR = 'Ninja'
Remove-Item Env:CMAKE_GENERATOR_INSTANCE -ErrorAction SilentlyContinue
$ninja = Join-Path $vsInstall 'Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja'
$env:PATH = "$ninja;$env:PATH"
if ($Cuda) {
  $env:CUDA_PATH = 'C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.3'
  $env:CUDA_TOOLKIT_ROOT_DIR = $env:CUDA_PATH
  if (-not (Test-Path -LiteralPath (Join-Path $env:CUDA_PATH 'bin\nvcc.exe'))) { throw 'CUDA compiler is missing' }
  $env:PATH = "$(Join-Path $env:CUDA_PATH 'bin');$(Join-Path $env:CUDA_PATH 'bin\x64');$env:PATH"
  $env:CMAKE_CUDA_ARCHITECTURES = '120'
  $env:NVCC_APPEND_FLAGS = '-std=c++17 -Xcompiler=/Zc:preprocessor -DCCCL_IGNORE_MSVC_TRADITIONAL_PREPROCESSOR_WARNING'
}
foreach ($required in @((Join-Path $env:ORT_LIB_LOCATION 'onnxruntime.dll'), (Join-Path $env:LIBCLANG_PATH 'libclang.dll'))) {
  if (-not (Test-Path -LiteralPath $required)) { throw "Build dependency is missing: $required" }
}

$runtimeDeps = Join-Path $tauri 'runtime-deps'
New-Item -ItemType Directory -Force -Path $runtimeDeps | Out-Null
foreach ($dll in @('onnxruntime.dll', 'onnxruntime_providers_shared.dll', 'DirectML.dll')) {
  $src = Join-Path $env:ORT_LIB_LOCATION $dll
  if (Test-Path -LiteralPath $src) {
    Copy-Item -LiteralPath $src -Destination (Join-Path $runtimeDeps $dll) -Force
  }
}
if ($Cuda) {
  $cudaBinX64 = Join-Path $env:CUDA_PATH 'bin\x64'
  foreach ($dll in @('cudart64_13.dll', 'cublas64_13.dll', 'cublasLt64_13.dll')) {
    $src = Join-Path $cudaBinX64 $dll
    if (-not (Test-Path -LiteralPath $src)) {
      $src = Join-Path (Join-Path $env:CUDA_PATH 'bin') $dll
    }
    if (Test-Path -LiteralPath $src) {
      Copy-Item -LiteralPath $src -Destination (Join-Path $runtimeDeps $dll) -Force
    } else {
      Write-Warning "Could not find CUDA DLL: $dll"
    }
  }
}

Push-Location $frontend
try {
  # Keep the Labs install identity so the CUDA upgrade sees existing profiles,
  # meeting database, and downloaded models beside the previous CPU executable.
  $config = 'src-tauri\tauri.labs-test.conf.json'
  $features = if ($Cuda) { 'custom-protocol,cuda' } else { 'custom-protocol' }
  & node 'node_modules\@tauri-apps\cli\tauri.js' build --bundles nsis --config $config -- --no-default-features --features $features
  if ($LASTEXITCODE -ne 0) { throw 'Tauri local-test bundle failed' }
} finally { Pop-Location }

$targetRelease = Join-Path $repo 'target\release'
if (Test-Path -LiteralPath $targetRelease) {
  Get-ChildItem -Path $runtimeDeps -Filter '*.dll' | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $targetRelease $_.Name) -Force
  }
}

$installer = Join-Path $repo "target\release\bundle\nsis\Meetily Labs Local Test_${appVersion}_x64-setup.exe"
if (-not (Test-Path -LiteralPath $installer)) { throw "Installer was not produced: $installer" }
$dist = Join-Path $repo $(if ($Cuda) { 'dist-labs-cuda-test' } else { 'dist-labs-test' })
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$outputName = if ($Cuda) { "Meetily Labs CUDA Test_${appVersion}_x64-setup.exe" } else { "Meetily Labs Local Test_${appVersion}_x64-setup.exe" }
$output = Join-Path $dist $outputName
Copy-Item -LiteralPath $installer -Destination $output -Force
$hash = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText((Join-Path $dist 'SHA256SUMS.txt'), "$hash  $(Split-Path $output -Leaf)`n")
Write-Host "Unsigned local Windows test installer: $output"
Get-Item -LiteralPath $output | Select-Object FullName,Length,LastWriteTime
