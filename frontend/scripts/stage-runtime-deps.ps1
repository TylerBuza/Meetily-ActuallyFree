# Stage Windows runtime dependencies for the NSIS installer.
param(
  [string[]]$BuildOutput = @()
)
$ErrorActionPreference = "Stop"
$frontend = Split-Path $PSScriptRoot -Parent
$repo = Split-Path $frontend -Parent
$deps = Join-Path $frontend "src-tauri\runtime-deps"
New-Item -ItemType Directory -Force -Path $deps | Out-Null
$dlls = @("cudart64_13.dll", "cublas64_13.dll", "cublasLt64_13.dll", "DirectML.dll")
foreach ($dll in $dlls) {
  Remove-Item (Join-Path $deps $dll) -Force -ErrorAction SilentlyContinue
}

$candidates = @($BuildOutput | Where-Object { $_ } | ForEach-Object {
  [System.IO.Path]::GetFullPath($_)
}) + @(
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

foreach ($dll in $dlls) {
  $from = Find-Dll $dll
  if ($from) {
    Copy-Item $from (Join-Path $deps $dll) -Force
    Write-Host "staged $dll"
  } else {
    throw "Required installer runtime missing: $dll"
  }
}

$vc = Join-Path $deps "vc_redist.x64.exe"
$vcSha256 = "CC0FF0EB1DC3F5188AE6300FAEF32BF5BEEBA4BDD6E8E445A9184072096B713B"
if (-not (Test-Path $vc)) {
  Write-Host "Downloading VC++ Redistributable x64..."
  Invoke-WebRequest -Uri "https://aka.ms/vs/17/release/vc_redist.x64.exe" -OutFile $vc -UseBasicParsing
}
if ((Get-FileHash $vc -Algorithm SHA256).Hash -ne $vcSha256) {
  throw "VC++ Redistributable checksum mismatch"
}
Write-Host "Runtime deps ready:"
Get-ChildItem $deps | ForEach-Object { Write-Host ("  " + $_.Name) }
