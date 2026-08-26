param(
  [string]$VulkanSdk,
  [string]$LlvmDir,
  [switch]$SkipFrontend,
  [switch]$AllowUnsigned,
  [string]$UpdaterPrivateKeyPath,
  [switch]$PackageOnly,
  [switch]$BootstrapperOnly
)

$ErrorActionPreference = "Stop"
$frontend = Split-Path $PSScriptRoot -Parent
$repo = Split-Path $frontend -Parent
$tauri = Join-Path $frontend "src-tauri"
$variants = Join-Path $tauri "installer-variants"
$sign = Join-Path $tauri "scripts\sign-windows.ps1"
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

function Build-VulkanProbe([string]$Sdk) {
  Write-Host ""
  Write-Host "=== Building Vulkan capability probe ==="
  $source = Join-Path $tauri "vulkan-probe\vulkan_probe.cpp"
  $header = Join-Path $Sdk "Include\vulkan\vulkan.h"
  $build = Join-Path $repo "target\vulkan-probe\release"
  $object = Join-Path $build "vulkan_probe.obj"
  $binary = Join-Path $build "meetily-vulkan-probe.exe"
  foreach ($required in @($source, $header)) {
    if (-not (Test-Path -LiteralPath $required)) {
      throw "Vulkan probe input missing: $required"
    }
  }
  New-Item -ItemType Directory -Force -Path $build | Out-Null
  & cl.exe /nologo /O2 /MT /W4 /EHsc /std:c++17 /DUNICODE /D_UNICODE /DNOMINMAX `
    "/D_WIN32_WINNT=0x0A00" /I (Join-Path $Sdk "Include") /c $source /Fo"$object" | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "Vulkan capability probe compilation failed" }
  & link.exe /nologo /SUBSYSTEM:CONSOLE /MACHINE:X64 /OPT:REF /OPT:ICF `
    /OUT:"$binary" "$object" kernel32.lib | Out-Host
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $binary)) {
    throw "Vulkan capability probe link failed"
  }
  return $binary
}

if ($BootstrapperOnly) {
  $dist = Join-Path $repo "dist"
  $engineOutput = Join-Path $dist "Meetily-ActuallyFree-${appVersion}-x64-universal-updater.exe"
  $updaterSignatureOutput = "$engineOutput.sig"
  $output = Join-Path $dist "Meetily-ActuallyFree-${appVersion}-x64-universal-setup.exe"
  $cpuBinary = Join-Path $repo "target\variants\cpu\release\meetily.exe"

  foreach ($required in @($engineOutput, $updaterSignatureOutput, $cpuBinary)) {
    if (-not (Test-Path -LiteralPath $required)) {
      throw "Bootstrapper-only input is missing: $required"
    }
  }
  foreach ($variant in @("meetily-cpu.exe", "meetily-vulkan.exe", "meetily-cuda.exe", "meetily-vulkan-probe.exe")) {
    $variantPath = Join-Path $variants $variant
    if (-not (Test-Path -LiteralPath $variantPath)) {
      throw "Staged variant missing: $variantPath"
    }
  }

  & (Join-Path $PSScriptRoot "build-installer-bootstrapper.ps1") `
    -Payload $engineOutput `
    -Output $output `
    -Version $appVersion `
    -ProgressMainBinary $cpuBinary `
    -CpuVariantBytes (Get-Item (Join-Path $variants "meetily-cpu.exe")).Length `
    -CudaVariantBytes (Get-Item (Join-Path $variants "meetily-cuda.exe")).Length `
    -VulkanVariantBytes (Get-Item (Join-Path $variants "meetily-vulkan.exe")).Length
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $output)) {
    throw "Frameless installer bootstrapper build failed"
  }
  & $sign -FilePath $output
  if ($LASTEXITCODE -ne 0) { throw "Frameless installer signing failed" }

  $latestPath = Join-Path $dist "latest.json"
  if (-not (Test-Path -LiteralPath $latestPath)) {
    throw "Updater metadata is missing: $latestPath"
  }
  $latestMetadata = Get-Content $latestPath -Raw | ConvertFrom-Json
  $latestPlatform = $latestMetadata.platforms.'windows-x86_64'
  $expectedUpdaterUrl = "https://github.com/TylerBuza/Meetily-ActuallyFree/releases/download/v${appVersion}/$(Split-Path $engineOutput -Leaf)"
  $expectedUpdaterSignature = (Get-Content $updaterSignatureOutput -Raw).Trim()
  if ($latestMetadata.version -ne $appVersion -or
      $latestPlatform.url -ne $expectedUpdaterUrl -or
      $latestPlatform.signature -ne $expectedUpdaterSignature) {
    throw "Existing latest.json does not match the current updater engine"
  }
  $checksums = @(
    "{0}  {1}" -f (Get-FileHash $output -Algorithm SHA256).Hash.ToLowerInvariant(), (Split-Path $output -Leaf)
    "{0}  {1}" -f (Get-FileHash $engineOutput -Algorithm SHA256).Hash.ToLowerInvariant(), (Split-Path $engineOutput -Leaf)
    "{0}  {1}" -f (Get-FileHash $updaterSignatureOutput -Algorithm SHA256).Hash.ToLowerInvariant(), (Split-Path $updaterSignatureOutput -Leaf)
    "{0}  latest.json" -f (Get-FileHash $latestPath -Algorithm SHA256).Hash.ToLowerInvariant()
  ) -join "`n"
  [System.IO.File]::WriteAllText(
    (Join-Path $dist "SHA256SUMS.txt"),
    $checksums + "`n",
    [System.Text.UTF8Encoding]::new($false)
  )

  Write-Host "Bootstrapper-only installer ready: $output"
  Get-Item $output | Select-Object FullName, Length, LastWriteTime
  exit 0
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
$universalMarker = Join-Path $variants "universal.marker"
try {
[System.IO.File]::WriteAllText($universalMarker, "universal`r`n")

if (-not $VulkanSdk) { $VulkanSdk = $env:VULKAN_SDK }
if (-not $VulkanSdk -or -not (Test-Path (Join-Path $VulkanSdk "Bin\glslc.exe"))) {
  $VulkanSdk = & (Join-Path $PSScriptRoot "bootstrap-vulkan-build-tools.ps1") | Select-Object -Last 1
}
$VulkanSdk = [System.IO.Path]::GetFullPath($VulkanSdk)
$vulkanProbeBinary = Build-VulkanProbe $VulkanSdk

if (-not $PackageOnly) {

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
Copy-Item $vulkanProbeBinary (Join-Path $variants "meetily-vulkan-probe.exe") -Force

& (Join-Path $PSScriptRoot "stage-runtime-deps.ps1") -BuildOutput @(
  (Join-Path $cpuTarget "release"),
  (Join-Path $cudaTarget "release")
)

foreach ($binary in Get-ChildItem $variants -Filter "*.exe") {
  & $sign -FilePath $binary.FullName
}
} else {
  foreach ($variant in @("meetily-cpu.exe", "meetily-vulkan.exe", "meetily-cuda.exe")) {
    $variantPath = Join-Path $variants $variant
    if (-not (Test-Path $variantPath)) { throw "Staged variant missing: $variantPath" }
  }
  Copy-Item $vulkanProbeBinary (Join-Path $variants "meetily-vulkan-probe.exe") -Force
  & $sign -FilePath (Join-Path $variants "meetily-vulkan-probe.exe")
}

# Bundle once with CPU as the safe main executable. The post-install hook
# replaces it with the selected signed variant and keeps meetily.exe canonical.
$env:CARGO_TARGET_DIR = $cpuTarget
& (Join-Path $PSScriptRoot "build-nsis-progress-plugin.ps1") `
  -ProgressMainBinary (Join-Path $cpuTarget "release\meetily.exe")
if ($LASTEXITCODE -ne 0) { throw "NSIS overall-progress plugin build failed" }
Push-Location $frontend
try {
  & node "node_modules\@tauri-apps\cli\tauri.js" build --config "src-tauri\tauri.updater.conf.json" -- --no-default-features --features custom-protocol
  if ($LASTEXITCODE -ne 0) { throw "Universal Tauri bundle failed" }
} finally {
  Pop-Location
}
} finally {
  Remove-Item $universalMarker -Force -ErrorAction SilentlyContinue
}

$installer = Join-Path $cpuTarget "release\bundle\nsis\Meetily - Actually Free_${appVersion}_x64-setup.exe"
if (-not (Test-Path $installer)) { throw "Universal installer missing: $installer" }
$dist = Join-Path $repo "dist"
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$engineOutput = Join-Path $dist "Meetily-ActuallyFree-${appVersion}-x64-universal-updater.exe"
$output = Join-Path $dist "Meetily-ActuallyFree-${appVersion}-x64-universal-setup.exe"
Remove-Item "$output.sig" -Force -ErrorAction SilentlyContinue
Copy-Item $installer $engineOutput -Force

$updaterSignatureSource = "$installer.sig"
if (-not (Test-Path $updaterSignatureSource)) { throw "Tauri updater signature was not generated" }

$installerName = Split-Path $engineOutput -Leaf
$updaterSignatureOutput = "$engineOutput.sig"
Copy-Item $updaterSignatureSource $updaterSignatureOutput -Force

& (Join-Path $PSScriptRoot "build-installer-bootstrapper.ps1") `
  -Payload $installer `
  -Output $output `
  -Version $appVersion `
  -ProgressMainBinary (Join-Path $cpuTarget "release\meetily.exe") `
  -CpuVariantBytes (Get-Item (Join-Path $variants "meetily-cpu.exe")).Length `
  -CudaVariantBytes (Get-Item (Join-Path $variants "meetily-cuda.exe")).Length `
  -VulkanVariantBytes (Get-Item (Join-Path $variants "meetily-vulkan.exe")).Length
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $output)) {
  throw "Frameless installer bootstrapper build failed"
}
& $sign -FilePath $output
if ($LASTEXITCODE -ne 0) { throw "Frameless installer signing failed" }

$signature = (Get-Content $updaterSignatureOutput -Raw).Trim()
$latest = [ordered]@{
  version = $appVersion
  notes = "Prevents long post-call transcription jobs from losing their model, keeps meeting transcripts usable while enhancement runs, and shows the selected Whisper acceleration backend during setup and in settings."
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
  "{0}  {1}" -f (Get-FileHash $engineOutput -Algorithm SHA256).Hash.ToLowerInvariant(), (Split-Path $engineOutput -Leaf)
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
Get-Item $engineOutput, $updaterSignatureOutput, (Join-Path $dist "latest.json"), (Join-Path $dist "SHA256SUMS.txt") |
  Select-Object FullName, Length, LastWriteTime
