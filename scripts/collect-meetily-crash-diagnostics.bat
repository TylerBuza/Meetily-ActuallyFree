@echo off
setlocal
title Meetily Crash Diagnostics
set "MEETILY_DIAG_SCRIPT=%~f0"
set "MEETILY_DIAG_ARGS=%*"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$content=[IO.File]::ReadAllText($env:MEETILY_DIAG_SCRIPT);$marker='# POWER'+'SHELL_PAYLOAD_START';$index=$content.IndexOf($marker);if($index -lt 0){throw 'PowerShell payload not found'};Invoke-Expression $content.Substring($index+$marker.Length)"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo Diagnostic collection failed. Keep this window open and report the error above.
  pause
)
exit /b %EXIT_CODE%

# POWERSHELL_PAYLOAD_START
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$arguments = @($env:MEETILY_DIAG_ARGS -split '\s+' | Where-Object { $_ })
$quiet = $arguments -contains '--quiet'
$skipRecording = $arguments -contains '--no-recording'
$outputBase = if ($env:MEETILY_DIAG_OUTPUT) {
  $env:MEETILY_DIAG_OUTPUT
} else {
  [Environment]::GetFolderPath('Desktop')
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packageName = "Meetily-Diagnostics-$timestamp"
$packageDir = Join-Path $outputBase $packageName
$zipPath = Join-Path $outputBase "$packageName.zip"
New-Item -ItemType Directory -Path $packageDir -Force | Out-Null
$transcriptPath = Join-Path $packageDir 'collector.log'
$summaryPath = Join-Path $packageDir 'diagnostics-summary.txt'
Start-Transcript -Path $transcriptPath -Force | Out-Null

function Add-SummaryLine {
  param([string]$Text = '')
  Add-Content -LiteralPath $summaryPath -Value $Text -Encoding UTF8
}

function Copy-Safe {
  param(
    [string]$Source,
    [string]$Destination
  )
  if (-not $Source -or -not (Test-Path -LiteralPath $Source)) {
    return $false
  }
  try {
    $parent = Split-Path -Parent $Destination
    if ($parent) {
      New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    Copy-Item -LiteralPath $Source -Destination $Destination -Force -Recurse
    return $true
  } catch {
    Add-SummaryLine "Could not copy ${Source}: $($_.Exception.Message)"
    return $false
  }
}

function Add-ExistingPath {
  param(
    [System.Collections.Generic.List[string]]$List,
    [string]$Path
  )
  if (-not $Path) {
    return
  }
  try {
    $fullPath = [IO.Path]::GetFullPath($Path.Trim('"'))
    if ((Test-Path -LiteralPath $fullPath) -and -not $List.Contains($fullPath)) {
      $List.Add($fullPath)
    }
  } catch {
  }
}

Add-SummaryLine 'Meetily Crash Diagnostics'
Add-SummaryLine "Collected: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')"
Add-SummaryLine "Computer: $env:COMPUTERNAME"
Add-SummaryLine "User: $env:USERNAME"
Add-SummaryLine ''

Write-Host 'Locating Meetily installation and data...' -ForegroundColor Cyan
$exeCandidates = [System.Collections.Generic.List[string]]::new()
Add-ExistingPath $exeCandidates (Join-Path $env:LOCALAPPDATA 'Meetily-ActuallyFree\meetily.exe')
Add-ExistingPath $exeCandidates (Join-Path $env:ProgramFiles 'Meetily-ActuallyFree\meetily.exe')
if (${env:ProgramFiles(x86)}) {
  Add-ExistingPath $exeCandidates (Join-Path ${env:ProgramFiles(x86)} 'Meetily-ActuallyFree\meetily.exe')
}

Get-CimInstance Win32_Process -Filter "Name='meetily.exe'" -ErrorAction SilentlyContinue |
  ForEach-Object { Add-ExistingPath $exeCandidates $_.ExecutablePath }

foreach ($keyPath in @(
  'HKCU:\Software\meetily\Meetily - Actually Free',
  'HKLM:\Software\meetily\Meetily - Actually Free',
  'HKLM:\Software\WOW6432Node\meetily\Meetily - Actually Free'
)) {
  try {
    if (Test-Path $keyPath) {
      $installDir = (Get-Item -LiteralPath $keyPath).GetValue('')
      Add-ExistingPath $exeCandidates (Join-Path $installDir 'meetily.exe')
    }
  } catch {
  }
}

foreach ($uninstallRoot in @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)) {
  Get-ChildItem -LiteralPath $uninstallRoot -ErrorAction SilentlyContinue |
    ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue } |
    Where-Object { $_.DisplayName -like 'Meetily*' } |
    ForEach-Object {
      if ($_.InstallLocation) {
        Add-ExistingPath $exeCandidates (Join-Path $_.InstallLocation.Trim('"') 'meetily.exe')
      }
    }
}

$exePath = $exeCandidates | Select-Object -First 1
$installationReport = [System.Collections.Generic.List[string]]::new()
if ($exePath) {
  $exe = Get-Item -LiteralPath $exePath
  $version = $exe.VersionInfo.ProductVersion
  if (-not $version) { $version = $exe.VersionInfo.FileVersion }
  $hash = (Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash
  $signature = Get-AuthenticodeSignature -LiteralPath $exePath
  $installationReport.Add("Executable: $exePath")
  $installationReport.Add("Version: $version")
  $installationReport.Add("SHA-256: $hash")
  $installationReport.Add("Signature status: $($signature.Status)")
  Add-SummaryLine "Meetily executable: $exePath"
  Add-SummaryLine "Meetily version: $version"
} else {
  $installationReport.Add('Meetily executable was not found automatically.')
  Add-SummaryLine 'Meetily executable: not found automatically'
}
$installationReport | Set-Content -LiteralPath (Join-Path $packageDir 'installation.txt') -Encoding UTF8

$dataRoots = [System.Collections.Generic.List[string]]::new()
if ($exePath) {
  Add-ExistingPath $dataRoots (Join-Path (Split-Path -Parent $exePath) 'data')
}
Add-ExistingPath $dataRoots (Join-Path $env:APPDATA 'Meetily')
Add-ExistingPath $dataRoots (Join-Path $env:LOCALAPPDATA 'Meetily')

$selectedBackend = 'unknown'
$dataIndex = 0
foreach ($dataRoot in $dataRoots) {
  $dataIndex++
  $destinationRoot = Join-Path $packageDir "app-data-$dataIndex"
  New-Item -ItemType Directory -Path $destinationRoot -Force | Out-Null
  Get-ChildItem -LiteralPath $dataRoot -File -Force -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -match '^(crash\.log|selected-backend\.txt|meeting_minutes\.(sqlite|db)(-wal|-shm)?|.*\.(json|txt|log))$'
    } |
    ForEach-Object {
      Copy-Safe $_.FullName (Join-Path $destinationRoot $_.Name) | Out-Null
    }

  $backendFile = Join-Path $dataRoot 'selected-backend.txt'
  if ($selectedBackend -eq 'unknown' -and (Test-Path -LiteralPath $backendFile)) {
    $selectedBackend = (Get-Content -LiteralPath $backendFile -Raw).Trim()
  }
}
Add-SummaryLine "Selected backend: $selectedBackend"

$storeFiles = [System.Collections.Generic.List[string]]::new()
foreach ($storeRoot in @(
  (Join-Path $env:APPDATA 'com.meetily.ai'),
  (Join-Path $env:LOCALAPPDATA 'com.meetily.ai')
)) {
  if (Test-Path -LiteralPath $storeRoot) {
    Get-ChildItem -LiteralPath $storeRoot -File -Force -ErrorAction SilentlyContinue |
      Where-Object { $_.Extension -in @('.json', '.log', '.txt') } |
      ForEach-Object {
        $storeFiles.Add($_.FullName)
        Copy-Safe $_.FullName (Join-Path $packageDir "stores\$($_.Name)") | Out-Null
      }
  }
}

foreach ($indexedDbPath in @(
  (Join-Path $env:LOCALAPPDATA 'com.meetily.ai\EBWebView\Default\IndexedDB'),
  (Join-Path $env:LOCALAPPDATA 'Meetily\EBWebView\Default\IndexedDB')
)) {
  if (Test-Path -LiteralPath $indexedDbPath) {
    $indexedDbDestination = Join-Path $packageDir ('webview-indexeddb-' + (Split-Path (Split-Path $indexedDbPath -Parent) -Leaf))
    Copy-Safe $indexedDbPath $indexedDbDestination | Out-Null
  }
}

Write-Host 'Collecting Windows, GPU, and audio information...' -ForegroundColor Cyan
$os = Get-CimInstance Win32_OperatingSystem
$computer = Get-CimInstance Win32_ComputerSystem
$processor = Get-CimInstance Win32_Processor
@(
  [PSCustomObject]@{
    Windows = $os.Caption
    Version = $os.Version
    Build = $os.BuildNumber
    Architecture = $os.OSArchitecture
    InstalledRAMGB = [Math]::Round($computer.TotalPhysicalMemory / 1GB, 2)
    CPU = ($processor.Name -join '; ')
    LastBoot = $os.LastBootUpTime
  }
) | Format-List | Out-File (Join-Path $packageDir 'system.txt') -Width 300 -Encoding UTF8

Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue |
  Select-Object Name, DriverVersion, Status, PNPDeviceID, AdapterRAM |
  Format-List | Out-File (Join-Path $packageDir 'gpu.txt') -Width 300 -Encoding UTF8

Get-CimInstance Win32_SoundDevice -ErrorAction SilentlyContinue |
  Select-Object Name, Manufacturer, Status, PNPDeviceID |
  Format-List | Out-File (Join-Path $packageDir 'audio-devices.txt') -Width 300 -Encoding UTF8

if (Get-Command Get-PnpDevice -ErrorAction SilentlyContinue) {
  Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
    Where-Object { $_.Class -in @('AudioEndpoint', 'MEDIA', 'Display') } |
    Select-Object Class, FriendlyName, Status, InstanceId |
    Format-Table -AutoSize | Out-File (Join-Path $packageDir 'pnp-devices.txt') -Width 400 -Encoding UTF8
}

Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -in @('meetily.exe', 'ffmpeg.exe', 'llama-helper.exe') } |
  Select-Object Name, ProcessId, ParentProcessId, ExecutablePath, CreationDate, CommandLine |
  Format-List | Out-File (Join-Path $packageDir 'meetily-processes.txt') -Width 400 -Encoding UTF8

$dxdiagPath = Join-Path $packageDir 'dxdiag.txt'
try {
  $dxdiag = Join-Path $env:WINDIR 'System32\dxdiag.exe'
  Start-Process -FilePath $dxdiag -ArgumentList @('/dontskip', '/whql:off', '/t', $dxdiagPath) -Wait -WindowStyle Hidden
  for ($attempt = 0; $attempt -lt 30 -and -not (Test-Path -LiteralPath $dxdiagPath); $attempt++) {
    Start-Sleep -Seconds 1
  }
} catch {
  Add-SummaryLine "dxdiag failed: $($_.Exception.Message)"
}

Write-Host 'Collecting Windows crash events and reports...' -ForegroundColor Cyan
$eventStart = (Get-Date).AddDays(-7)
$applicationEvents = Get-WinEvent -FilterHashtable @{
  LogName = 'Application'
  StartTime = $eventStart
} -MaxEvents 5000 -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Message -match '(?i)meetily(\.exe)?' -or
    ($_.ProviderName -in @('Application Error', 'Windows Error Reporting') -and $_.Message -match '(?i)meetily')
  } |
  Select-Object TimeCreated, Id, LevelDisplayName, ProviderName, Message
if ($applicationEvents) {
  $applicationEvents | Format-List |
    Out-File (Join-Path $packageDir 'windows-application-events.txt') -Width 500 -Encoding UTF8
} else {
  'No Meetily-related Application events were found in the last 7 days.' |
    Set-Content (Join-Path $packageDir 'windows-application-events.txt') -Encoding UTF8
}

$systemEvents = Get-WinEvent -FilterHashtable @{
  LogName = 'System'
  StartTime = (Get-Date).AddHours(-24)
  Level = 1, 2, 3
} -MaxEvents 3000 -ErrorAction SilentlyContinue |
  Where-Object { $_.Message -match '(?i)(display|gpu|nvidia|amd|intel|audio|wasapi|sound|device)' } |
  Select-Object -First 250 TimeCreated, Id, LevelDisplayName, ProviderName, Message
$systemEvents | Format-List |
  Out-File (Join-Path $packageDir 'recent-device-system-events.txt') -Width 500 -Encoding UTF8

$dumpDestination = Join-Path $packageDir 'crash-dumps'
Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'CrashDumps') -Filter 'meetily*.dmp' -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTimeUtc -Descending |
  Select-Object -First 5 |
  ForEach-Object { Copy-Safe $_.FullName (Join-Path $dumpDestination $_.Name) | Out-Null }

$werDestination = Join-Path $packageDir 'wer-reports'
$werIndex = 0
foreach ($werRoot in @(
  (Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\WER\ReportArchive'),
  (Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\WER\ReportQueue'),
  (Join-Path $env:ProgramData 'Microsoft\Windows\WER\ReportArchive'),
  (Join-Path $env:ProgramData 'Microsoft\Windows\WER\ReportQueue')
)) {
  Get-ChildItem -LiteralPath $werRoot -Filter '*.wer' -File -Recurse -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTimeUtc -Descending |
    Where-Object {
      try { Select-String -LiteralPath $_.FullName -Pattern 'meetily.exe' -Quiet } catch { $false }
    } |
    Select-Object -First 5 |
    ForEach-Object {
      $werIndex++
      Copy-Safe $_.DirectoryName (Join-Path $werDestination "report-$werIndex") | Out-Null
    }
}

Write-Host 'Locating and backing up the newest meeting...' -ForegroundColor Cyan
$recordingRoots = [System.Collections.Generic.List[string]]::new()
foreach ($knownRoot in @(
  (Join-Path ([Environment]::GetFolderPath('MyMusic')) 'meetily-recordings'),
  (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'meetily-recordings'),
  (Join-Path ([Environment]::GetFolderPath('MyVideos')) 'meetily-recordings')
)) {
  Add-ExistingPath $recordingRoots $knownRoot
}

foreach ($storeFile in $storeFiles) {
  try {
    $store = Get-Content -LiteralPath $storeFile -Raw | ConvertFrom-Json
    if ($store.preferences.save_folder) {
      Add-ExistingPath $recordingRoots ([string]$store.preferences.save_folder)
    }
  } catch {
  }
}

$newestMeeting = $recordingRoots |
  ForEach-Object { Get-ChildItem -LiteralPath $_ -Directory -Force -ErrorAction SilentlyContinue } |
  Sort-Object LastWriteTimeUtc -Descending |
  Select-Object -First 1

if ($newestMeeting) {
  Add-SummaryLine "Newest meeting source: $($newestMeeting.FullName)"
  Get-ChildItem -LiteralPath $newestMeeting.FullName -Recurse -Force -ErrorAction SilentlyContinue |
    Select-Object FullName, Length, CreationTime, LastWriteTime, Attributes |
    Export-Csv -LiteralPath (Join-Path $packageDir 'latest-recording-inventory.csv') -NoTypeInformation -Encoding UTF8

  if (-not $skipRecording) {
    $recordingDestination = Join-Path $packageDir "latest-recording\$($newestMeeting.Name)"
    New-Item -ItemType Directory -Path $recordingDestination -Force | Out-Null
    $robocopyLog = Join-Path $packageDir 'recording-backup.log'
    & robocopy.exe $newestMeeting.FullName $recordingDestination /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /XJ /NP /LOG:$robocopyLog | Out-Null
    $robocopyCode = $LASTEXITCODE
    if ($robocopyCode -le 7) {
      Add-SummaryLine "Newest meeting backup: included ($recordingDestination)"
    } else {
      Add-SummaryLine "Newest meeting backup failed with robocopy code $robocopyCode"
    }
  } else {
    Add-SummaryLine 'Newest meeting backup: skipped by --no-recording'
  }
} else {
  Add-SummaryLine 'Newest meeting source: no recording folder found'
}

if (-not $quiet) {
  Write-Host ''
  $crashNotes = Read-Host 'What was happening immediately before Meetily closed? (optional)'
  if ($crashNotes) {
    Add-SummaryLine ''
    Add-SummaryLine 'User crash notes:'
    Add-SummaryLine $crashNotes
  }
}

Add-SummaryLine ''
Add-SummaryLine 'Recovery reminder: keep the recovery entry and use Recover, not Delete.'
Add-SummaryLine 'This package may contain meeting audio, transcripts, database rows, and crash memory dumps.'

Stop-Transcript | Out-Null

Write-Host 'Creating ZIP archive...' -ForegroundColor Cyan
try {
  Compress-Archive -Path (Join-Path $packageDir '*') -DestinationPath $zipPath -CompressionLevel Optimal -Force
  Write-Host ''
  Write-Host 'Meetily diagnostics collected successfully.' -ForegroundColor Green
  Write-Host "Folder: $packageDir"
  Write-Host "ZIP:    $zipPath"
  if (-not $quiet) {
    Start-Process explorer.exe -ArgumentList "/select,`"$zipPath`""
  }
} catch {
  Write-Host ''
  Write-Warning "ZIP creation failed: $($_.Exception.Message)"
  Write-Host "The uncompressed diagnostics are available at: $packageDir"
}

if (-not $quiet) {
  Write-Host ''
  Read-Host 'Press Enter to close'
}
exit 0
