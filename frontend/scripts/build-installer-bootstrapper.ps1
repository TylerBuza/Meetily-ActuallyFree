param(
  [Parameter(Mandatory = $true)]
  [string]$Payload,
  [Parameter(Mandatory = $true)]
  [string]$Output,
  [Parameter(Mandatory = $true)]
  [string]$Version,
  [string]$ProgressMainBinary,
  [UInt64]$CpuVariantBytes = 0,
  [UInt64]$CudaVariantBytes = 0,
  [UInt64]$VulkanVariantBytes = 0
)

$ErrorActionPreference = "Stop"
$frontend = Split-Path $PSScriptRoot -Parent
$sourceDir = Join-Path $frontend "src-tauri\installer-bootstrapper"
$repo = Split-Path $frontend -Parent
$buildDir = Join-Path $repo "target\installer-bootstrapper\$Version"
$outputDir = Split-Path $Output -Parent

if (-not (Test-Path -LiteralPath $Payload)) { throw "NSIS payload not found: $Payload" }
if (-not (Test-Path -LiteralPath $sourceDir)) { throw "Bootstrapper source not found: $sourceDir" }
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

$payloadPath = [System.IO.Path]::GetFullPath($Payload).Replace("\", "\\")
$iconPath = [System.IO.Path]::GetFullPath((Join-Path $frontend "src-tauri\icons\icon.ico")).Replace("\", "\\")
$manifestPath = [System.IO.Path]::GetFullPath((Join-Path $sourceDir "app.manifest")).Replace("\", "\\")
$payloadHash = (Get-FileHash -LiteralPath $Payload -Algorithm SHA256).Hash.ToLowerInvariant()
$tauri = Join-Path $frontend "src-tauri"
$progressFiles = [System.Collections.Generic.List[object]]::new()
function Add-ProgressFile([string]$RelativePath, [string]$SourcePath) {
  if ($SourcePath -and (Test-Path -LiteralPath $SourcePath)) {
    $progressFiles.Add([PSCustomObject]@{
      RelativePath = $RelativePath
      Length = (Get-Item -LiteralPath $SourcePath).Length
    })
  }
}
Add-ProgressFile "meetily.exe" $ProgressMainBinary
foreach ($name in @(".gitkeep", "meetily-cpu.exe", "meetily-cuda.exe", "meetily-vulkan-probe.exe", "meetily-vulkan.exe", "universal.marker")) {
  Add-ProgressFile "installer-variants\$name" (Join-Path $tauri "installer-variants\$name")
}
foreach ($name in @("segmentation-3.0-fp16.onnx", "wespeaker-resnet34-LM.onnx", "xvec_transform.npz")) {
  Add-ProgressFile "resources\diarization\$name" (Join-Path $tauri "resources\diarization\$name")
}
foreach ($name in @("DirectML.dll", "cublas64_13.dll", "cublasLt64_13.dll", "cudart64_13.dll", "vc_redist.x64.exe")) {
  Add-ProgressFile "runtime-deps\$name" (Join-Path $tauri "runtime-deps\$name")
}
Get-ChildItem (Join-Path $tauri "templates") -Filter "*.json" | Sort-Object Name | ForEach-Object {
  Add-ProgressFile "templates\$($_.Name)" $_.FullName
}
Add-ProgressFile "ffmpeg.exe" (Join-Path $tauri "binaries\ffmpeg-x86_64-pc-windows-msvc.exe")
Add-ProgressFile "llama-helper.exe" (Join-Path $tauri "binaries\llama-helper-x86_64-pc-windows-msvc.exe")
$progressEntries = ($progressFiles | ForEach-Object {
  $escaped = $_.RelativePath.Replace("\", "\\").Replace('"', '\"')
  "  { L`"$escaped`", $($_.Length)ULL },"
}) -join "`r`n"
$progressTotal = ($progressFiles | Measure-Object Length -Sum).Sum
$hashHeader = Join-Path $buildDir "payload_hash.h"
$resourceScript = Join-Path $buildDir "bootstrapper.rc"
$resourceOutput = Join-Path $buildDir "bootstrapper.res"
$objectOutput = Join-Path $buildDir "bootstrapper.obj"
$intermediateOutput = Join-Path $buildDir "Meetily-ActuallyFree-$Version-setup.exe"

[System.IO.File]::WriteAllText(
  $hashHeader,
  "#pragma once`r`nstatic constexpr wchar_t kExpectedPayloadSha256[] = L`"$payloadHash`";`r`nstatic constexpr unsigned long long kCpuVariantBytes = ${CpuVariantBytes}ULL;`r`nstatic constexpr unsigned long long kCudaVariantBytes = ${CudaVariantBytes}ULL;`r`nstatic constexpr unsigned long long kVulkanVariantBytes = ${VulkanVariantBytes}ULL;`r`nstruct BundledFileInfo { const wchar_t* path; unsigned long long size; };`r`nstatic constexpr BundledFileInfo kBundledFiles[] = {`r`n$progressEntries`r`n};`r`nstatic constexpr unsigned long long kBundledFilesTotalBytes = ${progressTotal}ULL;`r`n",
  [System.Text.UTF8Encoding]::new($false)
)
[System.IO.File]::WriteAllText(
  $resourceScript,
  @"
#include "resource.h"
#include <windows.h>
IDI_MEETILY ICON "$iconPath"
IDR_NSIS_PAYLOAD RCDATA "$payloadPath"
IDR_APP_MANIFEST RT_MANIFEST "$manifestPath"
"@,
  [System.Text.UTF8Encoding]::new($false)
)

& rc.exe /nologo /I "$sourceDir" /fo "$resourceOutput" "$resourceScript"
if ($LASTEXITCODE -ne 0) { throw "Bootstrapper resource compilation failed" }

& cl.exe /nologo /O2 /MT /W4 /EHsc /std:c++17 /DUNICODE /D_UNICODE /DNOMINMAX `
  /I "$sourceDir" /I "$buildDir" `
  /c (Join-Path $sourceDir "bootstrapper.cpp") /Fo"$objectOutput"
if ($LASTEXITCODE -ne 0) { throw "Bootstrapper C++ compilation failed" }

& link.exe /nologo /SUBSYSTEM:WINDOWS /MACHINE:X64 /OPT:REF /OPT:ICF `
  /OUT:"$intermediateOutput" "$objectOutput" "$resourceOutput" user32.lib gdi32.lib `
  gdiplus.lib shell32.lib ole32.lib advapi32.lib dwmapi.lib bcrypt.lib
if ($LASTEXITCODE -ne 0) { throw "Bootstrapper link failed" }
if (-not (Test-Path -LiteralPath $intermediateOutput)) { throw "Bootstrapper output is missing" }

Copy-Item -LiteralPath $intermediateOutput -Destination $Output -Force
Write-Host "Frameless installer ready: $Output"
