param([string]$MakeNsis = "$env:LOCALAPPDATA\tauri\NSIS\makensis.exe")
$ErrorActionPreference = 'Stop'
$root = (New-Item -ItemType Directory -Path (Join-Path ([IO.Path]::GetTempPath()) ("meetily backend test " + [guid]::NewGuid()))).FullName
$hooks = (Resolve-Path "$PSScriptRoot\..\src-tauri\windows\installer-hooks.nsh").Path
try {
  $fixture = @'
Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "fixture.exe"
!include FileFunc.nsh
!include WordFunc.nsh
!define MAINBINARYNAME "meetily"
Var MeetilyProgressToken
!include "${HOOKS}"
Section
  StrCpy $MeetilyProgressToken ""
  !insertmacro Meetily_SelectBackend
SectionEnd
'@
  $script = Join-Path $root 'fixture.nsi'
  [IO.File]::WriteAllText($script, $fixture)
  & $MakeNsis '/V2' "/DHOOKS=$hooks" $script
  if ($LASTEXITCODE) { throw 'Could not compile NSIS test fixture' }
  foreach ($locked in @($false, $true)) {
    $dir = Join-Path $root "install $locked"
    $variants = (New-Item -ItemType Directory -Path "$dir\installer-variants" -Force).FullName
    $exe = Join-Path $dir 'meetily.exe'
    [IO.File]::WriteAllText($exe, 'bundled')
    [IO.File]::WriteAllText("$variants\universal.marker", 'universal')
    [IO.File]::WriteAllText("$variants\meetily-cpu.exe", 'selected')
    $lock = $null
    try {
      if ($locked) { $lock = [IO.File]::Open($exe, 'Open', 'Read', 'Read') }
      # /D takes the rest of the NSIS command line, including embedded spaces.
      $proc = Start-Process "$root\fixture.exe" -ArgumentList "/S /BACKEND=cpu /D=$dir" -PassThru
      if (!$proc.WaitForExit(15000)) { $proc.Kill(); throw 'NSIS fixture timed out' }
    } finally {
      if ($lock) { $lock.Dispose() }
    }
    if ($locked) {
      if ($proc.ExitCode -eq 0 -or [IO.File]::ReadAllText($exe) -ne 'bundled' -or (Test-Path "$dir\data\selected-backend.txt")) {
        throw 'Locked replacement lost the original or reported success'
      }
    } elseif ($proc.ExitCode -ne 0 -or [IO.File]::ReadAllText($exe) -ne 'selected' -or
              [IO.File]::ReadAllText("$dir\data\selected-backend.txt").Trim() -ne 'cpu') {
      throw 'Successful selection did not install and record the same backend'
    }
  }
  Write-Output 'Passed: same-volume backend replacement and locked executable preservation.'
} finally {
  Remove-Item -LiteralPath $root -Force -Recurse
}
