/** Messages for the first-run setup wizard. */
const onboarding = {
  // Shared across onboarding steps
  continue: 'Continue',
  skipForNow: 'Skip for now',
  statusFailed: 'Failed',
  recommended: 'Recommended',
  installedEnableIt: '· Installed; enable it',

  // Shared permission row
  permissionChecking: 'Checking...',
  permissionOpenSettings: 'Open Settings',
  permissionEnable: 'Enable',
  permissionAccessGranted: 'Access Granted',
  permissionAccessDenied: 'Access Denied - Please grant in System Settings',

  // Welcome step
  welcomeTitle: 'Welcome to Meetily',
  welcomeDescription: 'Record. Transcribe. Summarize. All on your device.',
  welcomeFeaturePrivacy: 'Your data never leaves your device',
  welcomeFeatureInsights: 'Intelligent summaries & insights',
  welcomeFeatureOffline: 'Works offline, no cloud required',
  updatesTitle: 'Check for updates when Meetily starts?',
  updatesDescription:
    "This checks this fork's GitHub releases. No analytics or usage data is sent.",
  updatesYes: 'Yes, check on launch',
  updatesNo: "No, I'll check manually",
  welcomeGetStarted: 'Get Started',
  welcomeTimeEstimate: 'Takes less than 3 minutes',

  // Your name step
  yourNameTitle: 'What should we call you?',
  yourNameDescription:
    'Your name labels your voice in transcripts as “You”. You can change this later in Settings.',
  yourNamePlaceholder: 'Your name',
  yourNameExamplePrefix: 'Example: lines you speak show as',
  yourNameFallback: 'You',
  yourNameSuffix: ' (You)',

  // Permissions step
  permissionsTitle: 'Grant Permissions',
  permissionsDescription:
    'Meetily needs access to your microphone and system audio to record meetings',
  microphone: 'Microphone',
  systemAudio: 'System Audio',
  microphonePermissionDescription: 'Required to capture your voice during meetings',
  systemAudioPermissionDescription: 'Click Enable to grant Audio Capture permission',
  allowMicrophoneToast: 'Allow microphone access',
  allowMicrophoneToastDescription:
    'Open System Settings → Privacy & Security → Microphone and turn on Meetily.',
  allowAudioCaptureToast: 'Allow Audio Capture',
  allowAudioCaptureToastDescription:
    'Open System Settings → Privacy & Security → Audio Capture and turn on Meetily.',
  finishSetup: 'Finish Setup',
  doThisLater: "I'll do this later",
  permissionsRequiredWarning:
    "Recording won't work without permissions. You can grant them later in settings.",

  // Audio test step
  audioTestTitle: 'Test your audio',
  audioTestDescriptionMacos:
    'Pick your mic, play audio through the current default output, then use Retest audio to verify native Audio Capture.',
  audioTestDescription:
    'Pick your mic and speakers, then speak / play something. Meters should move.',
  audioSystemAudioLabel: 'System audio',
  audioHeardYou: 'Heard you',
  audioSpeakNow: 'Speak now…',
  audioDetected: 'Detected',
  audioPlayVideo: 'Play a video…',
  audioNoMicrophones: 'No microphones found',
  audioNoPlaybackDevices: 'No playback devices found',
  audioDefaultOutputHint: 'Current default output (change it in System Settings)',
  audioSystemAudioDevice: 'System audio device',
  audioRetest: 'Retest audio',
  audioRefreshDevices: 'Refresh devices',
  audioFinishHint:
    'You can finish even if a meter stays quiet — fix devices later in Settings → Recording.',
  statusStartingMeters: 'Starting meters…',
  statusOpeningDevices: 'Opening devices…',
  statusFindingDevices: 'Finding devices…',
  statusNoDevices: 'No devices',
  statusTestingNativeSystemAudio: 'Testing native system audio… Play a video now.',
  statusListening: 'Listening{device}',
  statusListeningProbeComplete: 'Listening{device} · native system-audio probe complete',
  errorNoDevicesFound: 'No microphone or speakers found. Check your system sound settings.',
  errorSystemAudioNotDetected:
    'System audio was not detected. Play audio, grant Audio Capture permission if prompted, then click Retest audio.',
  errorNativeAudioTestFailed: 'Could not test native system audio: {message}',
  errorCouldNotStartLevelMeters: 'Could not start level meters',
  errorNoAudioDevicesDetected:
    'No audio devices detected. Plug in a microphone and check system privacy settings.',
  errorListAudioDevicesFailed: 'Failed to list audio devices',

  // Setup overview step
  setupOverviewTitle: 'Setup Overview',
  setupOverviewDescription:
    'Meetily requires that you download the Transcription & Summarization AI models for the software to work.',
  setupStepLabel: 'Step {number} :  {title}',
  setupStepDownloadTranscription: 'Download Transcription Engine',
  setupStepDownloadSummarization: 'Download Summarization Engine',
  setupExternalProviders:
    'You can also select external AI providers like OpenAI, Claude, or Ollama for summary generation in settings.',
  accelerationTitle: 'Transcription acceleration',
  accelerationCudaSetupRequired: 'NVIDIA CUDA available — setup required',
  accelerationDetecting: 'Detecting...',
  accelerationUnknown: 'Could not determine',
  accelerationSelected: '{backend} selected',
  accelerationChecking: 'Checking the acceleration selected for this installation.',
  accelerationReviewLater:
    'You can review the acceleration backend later in Local Stack settings.',
  accelerationCpu: 'Whisper post-call enhancement will use CPU processing.',
  accelerationAuto: 'Whisper post-call enhancement will use this automatically selected backend.',
  accelerationParakeetNote:
    'Live Parakeet uses the CPU by default; DirectML acceleration is optional in Labs.',
  cudaReady: 'CUDA is ready now',
  cudaUnverified: 'CUDA support could not be verified',
  cudaDriverNeeded: 'Your NVIDIA GPU needs a current driver',
  cudaStillUsing:
    'This installation is still using {backend}. Rerun the latest Meetily setup and it will select NVIDIA CUDA automatically.',
  cudaProbeFailed:
    'Meetily could not read your NVIDIA driver details. Update or reinstall the driver, then recheck here.{extra}',
  cudaBackendRemains: ' The current backend remains selected until setup is rerun.',
  cudaDriverRequired:
    'This CUDA installation cannot use acceleration until NVIDIA driver 580.00 or newer is installed.',
  cudaInstallDriverHint:
    'Install NVIDIA driver 580.00 or newer to enable CUDA acceleration. Meetily will keep using its current fallback safely until you rerun setup.',
  cudaDownloadSetup: 'Download CUDA setup',
  cudaGetDriver: 'Get NVIDIA driver',
  cudaRecheck: 'Recheck',
  optionalUpgrades: 'Optional upgrades',
  whisperOption: 'Whisper for retranscription',
  whisperOptionDescription:
    'Large v3 Turbo Q5 for post-call enhancement and retranscribing recordings. Parakeet remains the live transcription engine.',
  nemotronOption: 'Nemotron for speaker identification',
  nemotronOptionDescription:
    'Auto-detect speakers after recording. Windows supports DirectML GPU acceleration with CPU fallback.',
  optionalModelsNote:
    'Selected models download in the background and enable automatically when ready. You can finish setup immediately and track progress or retry in Settings.',
  setupLetsGo: "Let's Go",
  viewProjectOnGithub: 'View project on GitHub',

  // Download progress step
  gettingThingsReady: 'Getting things ready',
  gettingThingsReadyDescription:
    'Finish setup while models download in the background. Recording becomes available when the transcription engine is ready.',
  transcriptionEngine: 'Transcription Engine',
  summaryEngine: 'Summary Engine',
  downloadStepHeading: 'Step {step}: {title}',
  waitingForStep1: 'Waiting for Step 1',
  waiting: 'Waiting...',
  downloadError: 'Download Error',
  downloadTryAgain: 'Try Again',
  downloadRetryFailed: 'Download retry failed',
  summaryDownloadRetryFailed: 'Summary model download retry failed',
  checkConnectionTryAgain: 'Please check your connection and try again.',
  retryFailed: 'Retry failed',
  summaryRecommendationNotReady: 'Summary model recommendation is not ready yet',
  downloadsContinueInBackground: 'Downloads will continue in the background',
  downloadsContinueDescription:
    'You can start using the app. Recording will be available once speech recognition is ready.',
  selectingRecommendedModel: 'Selecting recommended model...',
  continueWhileFinishing: 'You can continue while this finishes',
  downloadContinuesInBackground: 'Download will continue in the background.',
  continueDownloadsBackground: 'Continue — downloads run in background',
} as const

export default onboarding
