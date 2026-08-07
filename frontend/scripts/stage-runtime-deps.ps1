# Stage Windows runtime dependencies for the NSIS installer.
$ErrorActionPreference = "Stop"
$frontend = Split-Path $PSScriptRoot -Parent
$repo = Split-Path $frontend -Parent
$deps = Join-Path $frontend "src-tauri\runtime-deps"
New-Item -ItemType Directory -Force -Path $deps | Out-Null

$candidates = @(
  (Join-Path $repo "target\release"),
  (Join-Path $repo ".cuda_toolkit\bin\x64"),
  (Join-Path $repo ".cuda_toolkit\bin")
)

function Find-Dll([string]$name) {
  foreach ($dir in $candidates) {
    $p = Join-Path $dir $name
    if (Test-Path $p) { return $p }
  }
  return $null
}

$dlls = @("cudart64_13.dll", "cublas64_13.dll", "cublasLt64_13.dll", "DirectML.dll")
foreach ($dll in $dlls) {
  $from = Find-Dll $dll
  if ($from) {
    Copy-Item $from (Join-Path $deps $dll) -Force
    Write-Host "staged $dll"
  } else {
    Write-Warning "MISSING $dll"
  }
}

$vc = Join-Path $deps "vc_redist.x64.exe"
if (-not (Test-Path $vc)) {
  Write-Host "Downloading VC++ Redistributable x64..."
  Invoke-WebRequest -Uri "https://aka.ms/vs/17/release/vc_redist.x64.exe" -OutFile $vc -UseBasicParsing
}
Write-Host "Runtime deps ready:"
Get-ChildItem $deps | ForEach-Object { Write-Host ("  " + $_.Name) }
