# Generate non-private, repeatable input for the opt-in Nemotron integration test.
param([Parameter(Mandatory = $true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$root = (New-Item -ItemType Directory -Force $OutputDirectory).FullName
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($name in @('David', 'Zira')) {
  $voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
  try {
    $voice.SelectVoice("Microsoft $name Desktop")
    $voice.SetOutputToWaveFile((Join-Path $root "$name.wav"), $format)
    $voice.Speak('We should review the release plan before the end of this meeting. The application keeps all of our audio on this computer. Please check the transcript and tell me whether the speaker labels look correct. I will return to this discussion after the next presentation.')
  } finally { $voice.Dispose() }
}
python (Join-Path $PSScriptRoot 'mix-nemotron-fixture.py') $root
if ($LASTEXITCODE -ne 0) { throw 'Fixture mixing failed' }
