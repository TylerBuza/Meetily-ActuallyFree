param(
  [string]$ToolRoot
)

$ErrorActionPreference = "Stop"
$frontend = Split-Path $PSScriptRoot -Parent
$repo = Split-Path $frontend -Parent
if (-not $ToolRoot) {
  $ToolRoot = Join-Path $repo ".build-tools"
}

$llvm = Join-Path $ToolRoot "clang+llvm-18.1.8-x86_64-pc-windows-msvc"
$libclang = Join-Path $llvm "bin\libclang.dll"
if (Test-Path $libclang) {
  Write-Host "LLVM 18 already ready: $llvm"
  $llvm
  exit 0
}

New-Item -ItemType Directory -Force -Path $ToolRoot | Out-Null
$archive = Join-Path $ToolRoot "clang+llvm-18.1.8-x86_64-pc-windows-msvc.tar.xz"
$expectedSha256 = "22C5907DB053026CC2A8FF96D21C0F642A90D24D66C23C6D28EE7B1D572B82E8"
if (-not (Test-Path $archive)) {
  Write-Host "Downloading portable LLVM 18 (required for whisper-rs Windows bindings)…"
  gh release download llvmorg-18.1.8 `
    --repo llvm/llvm-project `
    --pattern "clang+llvm-18.1.8-x86_64-pc-windows-msvc.tar.xz" `
    --dir $ToolRoot
  if ($LASTEXITCODE -ne 0) { throw "Failed to download LLVM 18" }
}
$actualSha256 = (Get-FileHash $archive -Algorithm SHA256).Hash
if ($actualSha256 -ne $expectedSha256) {
  throw "LLVM 18 archive checksum mismatch: $actualSha256"
}

tar -xf $archive -C $ToolRoot
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $libclang)) {
  throw "Failed to extract portable LLVM 18"
}

Write-Host "LLVM 18 ready: $llvm"
$llvm
