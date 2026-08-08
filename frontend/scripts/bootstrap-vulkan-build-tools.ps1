param(
  [string]$ToolRoot
)

$ErrorActionPreference = "Stop"
$frontend = Split-Path $PSScriptRoot -Parent
$repo = Split-Path $frontend -Parent
if (-not $ToolRoot) {
  $ToolRoot = Join-Path $repo ".build-tools\vulkan"
}

$portable = Join-Path $ToolRoot "sdk"
$glslc = Join-Path $portable "Bin\glslc.exe"
$vulkanLib = Join-Path $portable "Lib\vulkan-1.lib"
$vulkanHeader = Join-Path $portable "Include\vulkan\vulkan.h"
$videoHeader = Join-Path $portable "Include\vk_video\vulkan_video_codecs_common.h"
if ((Test-Path $glslc) -and (Test-Path $vulkanLib) -and (Test-Path $vulkanHeader) -and (Test-Path $videoHeader)) {
  Write-Host "Portable Vulkan build tools already ready: $portable"
  $portable
  exit 0
}

$vcvars = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if (-not (Test-Path $vcvars)) {
  throw "Visual Studio 2022 Build Tools not found: $vcvars"
}

New-Item -ItemType Directory -Force -Path $ToolRoot | Out-Null
$shaderc = Join-Path $ToolRoot "shaderc"
$headers = Join-Path $ToolRoot "Vulkan-Headers"
$shadercCommit = "7060a6615a1c6e2515e696651eea685524ecadb5"
$headersCommit = "f9973cd97e6f3584707e7ef1c425e336f1b92a5b"

if (-not (Test-Path (Join-Path $shaderc ".git"))) {
  git init $shaderc
  git -C $shaderc remote add origin https://github.com/google/shaderc.git
  git -C $shaderc fetch --depth 1 origin $shadercCommit
  git -C $shaderc checkout --detach FETCH_HEAD
  if ($LASTEXITCODE -ne 0) { throw "Failed to fetch pinned shaderc" }
}
Push-Location $shaderc
try {
  python utils/git-sync-deps
  if ($LASTEXITCODE -ne 0) { throw "Failed to fetch shaderc dependencies" }
  cmd /c "call `"$vcvars`" >nul 2>&1 && cmake -S . -B build -GNinja -DCMAKE_BUILD_TYPE=Release -DSHADERC_SKIP_TESTS=ON -DSHADERC_SKIP_EXAMPLES=ON -DSHADERC_SKIP_COPYRIGHT_CHECK=ON && cmake --build build --target glslc_exe"
  if ($LASTEXITCODE -ne 0) { throw "Failed to build glslc" }
} finally {
  Pop-Location
}

if (-not (Test-Path (Join-Path $headers ".git"))) {
  git init $headers
  git -C $headers remote add origin https://github.com/KhronosGroup/Vulkan-Headers.git
  git -C $headers fetch --depth 1 origin $headersCommit
  git -C $headers checkout --detach FETCH_HEAD
  if ($LASTEXITCODE -ne 0) { throw "Failed to fetch pinned Vulkan-Headers" }
}

New-Item -ItemType Directory -Force -Path (Join-Path $portable "Bin") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $portable "Lib") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $portable "Include") | Out-Null
Copy-Item (Join-Path $shaderc "build\glslc\glslc.exe") $glslc -Force
Copy-Item (Join-Path $headers "include\vulkan") (Join-Path $portable "Include\vulkan") -Recurse -Force
Copy-Item (Join-Path $headers "include\vk_video") (Join-Path $portable "Include\vk_video") -Recurse -Force

# Generate a standard MSVC import library from the Windows Vulkan loader. This
# avoids a machine-wide SDK install; end-user GPU drivers supply vulkan-1.dll.
$loader = Join-Path $env:WINDIR "System32\vulkan-1.dll"
if (-not (Test-Path $loader)) {
  throw "Windows Vulkan loader not found: $loader"
}
$exports = cmd /c "call `"$vcvars`" >nul 2>&1 && dumpbin /nologo /exports `"$loader`"" |
  ForEach-Object {
    if ($_ -match '^\s+\d+\s+[0-9A-F]+\s+[0-9A-F]+\s+(\S+)') { $matches[1] }
  }
if (-not $exports) { throw "Could not read Vulkan loader exports" }
$def = Join-Path $portable "Lib\vulkan-1.def"
@("LIBRARY vulkan-1.dll", "EXPORTS") + @($exports) | Set-Content $def -Encoding ASCII
cmd /c "call `"$vcvars`" >nul 2>&1 && lib /nologo /def:`"$def`" /machine:x64 /out:`"$vulkanLib`""
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $vulkanLib)) {
  throw "Failed to generate vulkan-1.lib"
}

Write-Host "Portable Vulkan build tools ready: $portable"
$portable
