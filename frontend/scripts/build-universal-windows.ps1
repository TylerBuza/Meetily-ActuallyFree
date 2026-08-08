param(
  [string]$VulkanSdk,
  [string]$LlvmDir,
  [switch]$SkipFrontend,
  [switch]$AllowUnsigned,
  [string]$UpdaterPrivateKeyPath,
  [switch]$PackageOnly
)

$ErrorActionPreference = "Stop"
$frontend = Split-Path $PSScriptRoot -Parent
$repo = Split-Path $frontend -Parent
$tauri = Join-Path $frontend "src-tauri"
$variants = Join-Path $tauri "installer-variants"
$appVersion = (Get-Content (Join-Path $tauri "tauri.conf.json") -Raw | ConvertFrom-Json).version
$vcvars = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"

if (-not (Test-Path $vcvars)) { throw "Visual Studio Build Tools not found" }
if (-not $env:DIGICERT_KEYPAIR_ALIAS -and -not $AllowUnsigned) {
  throw "DIGICERT_KEYPAIR_ALIAS is not set. Pass -AllowUnsigned only for local test artifacts."
}
if ($AllowUnsigned -and -not $env:DIGICERT_KEYPAIR_ALIAS) {
  Write-Warning "Building an explicitly unsigned local-test installer"
}

if (-not $env:TAURI_SIGNING_PRIVATE_KEY -and -not $env:TAURI_SIGNING_PRIVATE_KEY_PATH) {
  if (-not $UpdaterPrivateKeyPath) {
    $UpdaterPrivateKeyPath = Join-Path $repo ".build-tools\updater\meetily.key"
  }
  $updaterPasswordPath = Join-Path (Split-Path $UpdaterPrivateKeyPath -Parent) "meetily.password"
  if (-not (Test-Path $UpdaterPrivateKeyPath) -or -not (Test-Path $updaterPasswordPath)) {
    throw "Tauri updater signing key or password is missing. Generate it before building a release."
  }
  $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $UpdaterPrivateKeyPath -Raw
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content $updaterPasswordPath -Raw).Trim()
}

# Import vcvars64 into this PowerShell process.
cmd /c "call `"$vcvars`" >nul 2>&1 && set" | ForEach-Object {
  if ($_ -match '^([^=]+)=(.*)$') {
    [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
  }
}

if (-not $LlvmDir) { $LlvmDir = $env:MEETILY_LLVM_DIR }
if (-not $LlvmDir) { $LlvmDir = "C:\Program Files\LLVM" }
$clang = Join-Path $LlvmDir "bin\clang.exe"
$clangVersion = if (Test-Path $clang) { (& $clang --version | Select-Object -First 1) } else { "" }
if ($clangVersion -notmatch 'version 18\.') {
  $LlvmDir = & (Join-Path $PSScriptRoot "bootstrap-llvm18.ps1") | Select-Object -Last 1
}
$env:LIBCLANG_PATH = Join-Path $LlvmDir "bin"
if (-not (Test-Path (Join-Path $env:LIBCLANG_PATH "libclang.dll"))) {
  throw "Compatible LLVM/libclang not found at $LlvmDir (LLVM 18 recommended)"
}
# Bundled whisper-rs bindings are Linux-shaped in 0.13.x. Clean Windows
# variant targets must generate their own bindings via libclang.
Remove-Item Env:WHISPER_DONT_GENERATE_BINDINGS -ErrorAction SilentlyContinue
$env:CMAKE_GENERATOR = "Ninja"
$ninja = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja"
$env:PATH = "C:\Program Files\CMake\bin;$ninja;$env:PATH"

if (-not $SkipFrontend) {
  Push-Location $frontend
  try {
    & node "node_modules\next\dist\bin\next" build
    if ($LASTEXITCODE -ne 0) { throw "Next.js build failed" }
  } finally { Pop-Location }
}

$cpuTarget = Join-Path $repo "target\variants\cpu"
$vulkanTarget = Join-Path $repo "target\variants\vulkan"
$cudaTarget = Join-Path $repo "target\variants\cuda"

if (-not $PackageOnly) {
if (-not $VulkanSdk) { $VulkanSdk = $env:VULKAN_SDK }
if (-not $VulkanSdk -or -not (Test-Path (Join-Path $VulkanSdk "Bin\glslc.exe"))) {
  $VulkanSdk = & (Join-Path $PSScriptRoot "bootstrap-vulkan-build-tools.ps1") | Select-Object -Last 1
}
$VulkanSdk = [System.IO.Path]::GetFullPath($VulkanSdk)

function Build-Variant([string]$Name, [string]$TargetDir, [string[]]$Features) {
  Write-Host ""
  Write-Host "=== Building $Name variant ==="
  $env:CARGO_TARGET_DIR = $TargetDir
  Push-Location $repo
  try {
    $featureList = (@("custom-protocol") + $Features) -join ","
    & cargo build --release -p meetily --bin meetily --no-default-features --features $featureList
    if ($LASTEXITCODE -ne 0) { throw "$Name build failed" }
  } finally { Pop-Location }
  $binary = Join-Path $TargetDir "release\meetily.exe"
  if (-not (Test-Path $binary)) { throw "$Name binary missing: $binary" }
  return $binary
}

$cpuBinary = Build-Variant "CPU" $cpuTarget @()

$env:VULKAN_SDK = $VulkanSdk
$env:VK_SDK_PATH = $VulkanSdk
$env:Vulkan_LIBRARY = Join-Path $VulkanSdk "Lib\vulkan-1.lib"
$env:Vulkan_INCLUDE_DIR = Join-Path $VulkanSdk "Include"
$env:PATH = "$(Join-Path $VulkanSdk 'Bin');$env:PATH"
$vulkanBinary = Build-Variant "Vulkan" $vulkanTarget @("vulkan")

$env:CUDA_PATH = Join-Path $repo ".cuda_toolkit"
$env:CUDA_TOOLKIT_ROOT_DIR = $env:CUDA_PATH
$nvcc = Join-Path $env:CUDA_PATH "bin\nvcc.exe"
if (-not (Test-Path $nvcc)) {
  throw "CUDA toolkit missing: $nvcc"
}
$env:PATH = "$env:CUDA_PATH\bin;$env:CUDA_PATH\bin\x64;$env:PATH"
# CUDA 13 supports Turing and newer. Include native cubins for the widely used
# generations rather than shipping the previous Ada-only (89) executable.
$env:CMAKE_CUDA_ARCHITECTURES = "75;80;86;89;90;100;120"
$env:NVCC_APPEND_FLAGS = "-std=c++17 -Xcompiler=/Zc:preprocessor -DCCCL_IGNORE_MSVC_TRADITIONAL_PREPROCESSOR_WARNING"
$cudaBinary = Build-Variant "CUDA" $cudaTarget @("cuda")

foreach ($sidecar in @("llama-helper-x86_64-pc-windows-msvc.exe", "ffmpeg-x86_64-pc-windows-msvc.exe")) {
  $sidecarPath = Join-Path $tauri "binaries\$sidecar"
  if (-not (Test-Path $sidecarPath)) { throw "Required sidecar missing: $sidecarPath" }
}

New-Item -ItemType Directory -Force -Path $variants | Out-Null
Copy-Item $cpuBinary (Join-Path $variants "meetily-cpu.exe") -Force
Copy-Item $vulkanBinary (Join-Path $variants "meetily-vulkan.exe") -Force
Copy-Item $cudaBinary (Join-Path $variants "meetily-cuda.exe") -Force

& (Join-Path $PSScriptRoot "stage-runtime-deps.ps1") -BuildOutput @(
  (Join-Path $cpuTarget "release"),
  (Join-Path $cudaTarget "release")
)

$sign = Join-Path $tauri "scripts\sign-windows.ps1"
foreach ($binary in Get-ChildItem $variants -Filter "*.exe") {
  & $sign -FilePath $binary.FullName
}
} else {
  foreach ($variant in @("meetily-cpu.exe", "meetily-vulkan.exe", "meetily-cuda.exe")) {
    $variantPath = Join-Path $variants $variant
    if (-not (Test-Path $variantPath)) { throw "Staged variant missing: $variantPath" }
  }
}

# Bundle once with CPU as the safe main executable. The post-install hook
# replaces it with the selected signed variant and keeps meetily.exe canonical.
$env:CARGO_TARGET_DIR = $cpuTarget
$universalMarker = Join-Path $variants "universal.marker"
[System.IO.File]::WriteAllText($universalMarker, "universal`r`n")
Push-Location $frontend
try {
  & node "node_modules\@tauri-apps\cli\tauri.js" build --config "src-tauri\tauri.updater.conf.json" -- --no-default-features --features custom-protocol
  if ($LASTEXITCODE -ne 0) { throw "Universal Tauri bundle failed" }
} finally {
  Pop-Location
  Remove-Item $universalMarker -Force -ErrorAction SilentlyContinue
}

$installer = Join-Path $cpuTarget "release\bundle\nsis\Meetily - Actually Free_${appVersion}_x64-setup.exe"
if (-not (Test-Path $installer)) { throw "Universal installer missing: $installer" }
$dist = Join-Path $repo "dist"
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$output = Join-Path $dist "Meetily-ActuallyFree-${appVersion}-x64-universal-setup.exe"
Copy-Item $installer $output -Force

$updaterSignatureSource = "$installer.sig"
if (-not (Test-Path $updaterSignatureSource)) { throw "Tauri updater signature was not generated" }

$installerName = Split-Path $output -Leaf
$updaterSignatureOutput = "$output.sig"
Copy-Item $updaterSignatureSource $updaterSignatureOutput -Force

$signature = (Get-Content $updaterSignatureOutput -Raw).Trim()
$latest = [ordered]@{
  version = $appVersion
  notes = "Universal CPU, Vulkan, and NVIDIA CUDA installer; improved recording recovery and speaker diarization."
  pub_date = [DateTime]::UtcNow.ToString("o")
  platforms = [ordered]@{
    "windows-x86_64" = [ordered]@{
      signature = $signature
      url = "https://github.com/TylerBuza/Meetily-ActuallyFree/releases/download/v${appVersion}/${installerName}"
    }
  }
}
[System.IO.File]::WriteAllText(
  (Join-Path $dist "latest.json"),
  ($latest | ConvertTo-Json -Depth 5) + "`n",
  [System.Text.UTF8Encoding]::new($false)
)

$checksums = @(
  "{0}  {1}" -f (Get-FileHash $output -Algorithm SHA256).Hash.ToLowerInvariant(), (Split-Path $output -Leaf)
  "{0}  {1}" -f (Get-FileHash $updaterSignatureOutput -Algorithm SHA256).Hash.ToLowerInvariant(), (Split-Path $updaterSignatureOutput -Leaf)
  "{0}  latest.json" -f (Get-FileHash (Join-Path $dist "latest.json") -Algorithm SHA256).Hash.ToLowerInvariant()
) -join "`n"
[System.IO.File]::WriteAllText(
  (Join-Path $dist "SHA256SUMS.txt"),
  $checksums + "`n",
  [System.Text.UTF8Encoding]::new($false)
)

Write-Host ""
Write-Host "Universal installer ready: $output"
Get-Item $output | Select-Object FullName, Length, LastWriteTime
Get-Item $updaterSignatureOutput, (Join-Path $dist "latest.json"), (Join-Path $dist "SHA256SUMS.txt") |
  Select-Object FullName, Length, LastWriteTime
