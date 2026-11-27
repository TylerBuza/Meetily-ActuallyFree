/** Messages for toasts and inline error messages raised by hooks, contexts and services. */
const feedback = {
  // Meeting actions (rename, move, delete)
  meetingNeedsTitle: 'A meeting needs a title',
  couldNotRenameMeeting: 'Could not rename the meeting',
  singleMeetingMovedToGroup: 'Meeting moved to {group}',
  meetingsMovedToGroup: '{count} meetings moved to {group}',
  singleMeetingMovedToGroupDefault: 'Meeting moved to the group',
  meetingsMovedToGroupDefault: '{count} meetings moved to the group',
  singleMeetingRemovedFromGroup: 'Meeting removed from its group',
  meetingsRemovedFromGroup: '{count} meetings removed from its group',
  couldNotMoveMeetings: 'Could not move the meetings',
  meetingDeleted: 'Meeting deleted',
  meetingsDeleted: '{count} meetings deleted',
  couldNotDeleteMeeting: 'Could not delete {count} meeting',
  couldNotDeleteMeetings: 'Could not delete {count} meetings',

  // Configuration
  failedToLoadOllamaModels: 'Failed to load Ollama models',

  // Summary language
  couldNotApplyDefaultSummaryLanguage: 'Could not apply default summary language',
  defaultSummaryLanguageNotAppliedAfterImport:
    'The imported meeting was saved, but the default summary language was not applied.',
  defaultSummaryLanguageNotAppliedAfterRecording:
    'The meeting was saved, but the default summary language was not applied.',
  defaultSummaryLanguageNotAppliedAfterRecovery:
    'The recovered meeting was saved, but the default summary language was not applied.',
  couldNotDetectSummaryLanguage: 'Could not detect summary language',
  couldNotDetectSummaryLanguageHint: 'The meeting was saved, but Auto could not detect the summary language.',
  couldNotLoadSavedSummaryLanguage: 'Could not load saved summary language',
  couldNotLoadSavedSummaryLanguageHint: 'Using Auto for this generation.',
  bilingualTranscriptDetected: 'Bilingual transcript detected',
  bilingualTranscriptDetectedHint: 'Pick a summary language manually if Auto chooses the wrong fallback.',

  // Optional model downloads
  verifyingDownload: 'Verifying download…',
  downloadFailed: 'Download failed',
  modelEnabled: '{model} is enabled',
  whisperNowDefault: 'Whisper is now the default for post-call enhancement and retranscription.',
  nemotronLiveLabeling: 'Nemotron will label speakers live on your next recording and refine them afterward.',
  modelDownloadedCouldNotEnable: 'Model downloaded, but could not enable it',
  modelDownloadFailed: '{model} download failed',
  keepUsingMeetilyRetryInSettings: 'You can keep using Meetily and retry from Settings.',
  modelUninstalled: '{model} uninstalled',
  couldNotUninstallModel: 'Could not uninstall model',

  // Recording post-processing
  meetingAudioSaveFailed: 'Some or all meeting audio could not be saved. The transcript will still be kept.',
  recordingStoppedAudioCaptureFailed: 'Recording stopped because audio capture failed.',

  // Computer audio selection
  couldNotSaveAudioChoice: 'Could not save which audio to record',
  couldNotAddApp: 'Could not add that app',

  // Live transcript
  liveTranscriptUnavailable: 'Live transcript is unavailable',
  restartMeetilyCheckLogs: 'Restart Meetily. If it keeps happening, check the logs.',
  transcriptCopiedToClipboard: 'Transcript copied to clipboard',
  couldNotSaveSpeakerName: 'Could not save speaker name. Please retry.',
  couldNotSaveSpeakerAssignment: 'Could not save speaker assignment. Please retry.',
  couldNotSaveSpeakerMerge: 'Could not save speaker merge. Please retry.',
  mergedSpeakers: 'Merged "{source}" into "{target}"',
  someSpeechNotTranscribed: 'Some speech could not be transcribed',
  modelReadyClosingWindow: 'Model ready! Closing window...',

  // Copy and export
  noTranscriptToCopy: 'There is no transcript to copy yet',
  noSummaryToCopy: 'There is no summary to copy yet',
  couldNotCopyTranscript: 'Could not copy the transcript',
  couldNotCopySummary: 'Could not copy the summary',
  transcriptCopied: 'Transcript copied',
  summaryCopied: 'Summary copied',
  transcriptAndSummaryCopied: 'Transcript and summary copied',
  noSummaryToExport: 'There is no summary to export yet',
  noTranscriptToExport: 'There is no transcript to export yet',
  exportedAs: 'Exported as {format}',
  exportFailed: 'Export failed',

  // Summary templates
  templateSelected: 'Template selected',
  usingTemplateForSummary: 'Using "{template}" template for summary generation',

  // Summary generation
  summaryGenerated: 'Summary generated successfully!',
  summaryReadyDescription: 'Your meeting summary is ready',
  summaryGenerationFailed: 'Summary generation failed',
  summaryRegenerationFailed: 'Summary regeneration failed',
  summaryGenerationFailedRetry: 'Summary generation failed. Please retry.',
  summaryCompletedWithoutContent: 'Summary completed without content. Please retry.',
  couldNotRestoreSummaryStatus: 'Could not restore summary status. Reopen this meeting to retry.',
  processingTranscript: 'Processing transcript...',
  generatingSummary: 'Generating summary...',
  regeneratingSummary: 'Regenerating summary...',
  summaryCompleted: 'Summary completed',
  errorGeneratingSummary: 'Error generating summary',
  noTranscriptText: 'No transcript text available. Please add some text first.',
  summaryBackendRejectedRequest: 'Summary backend did not accept the generation request.',
  usingModel: 'Using {provider}/{model}',
  failedToRegenerateSummary: 'Failed to regenerate summary',
  failedToGenerateSummary: 'Failed to generate summary',
  previousSummaryRestored: '{error}. Your previous summary has been restored.',
  couldNotConnectToLlm:
    'Could not connect to LLM service. Please ensure Ollama or your configured LLM provider is running.',
  summaryEmptyContent: 'Summary generation completed but returned empty content.',
  unknownError: 'Unknown error',
  failedToFetchSummaryTranscripts: 'Failed to fetch transcripts for summary generation',
  loadingModelConfiguration: 'Loading model configuration, please wait...',
  noTranscriptsAvailable: 'No transcripts available for summary',
  noTranscriptsAvailableForRegeneration: 'No transcripts available for summary regeneration',
  noOllamaModelsInstalled: 'No Ollama models are installed at the configured endpoint.',
  noOllamaModelsFound: 'No Ollama models found. Please download gemma3:1b from Model Settings.',
  modelNotInstalledAtEndpoint: '{model} is not installed at the configured endpoint.',
  selectModelForSummary: 'Select an installed model before generating a summary.',
  selectModelForRegeneration: 'Select an installed model before regenerating a summary.',
  selectedOllamaModelUnavailable: 'Selected Ollama model is unavailable',
  ollamaNotInstalled: 'Ollama is not installed',
  ollamaNotInstalledHint: 'Please download and install Ollama to use local models.',
  download: 'Download',
  failedToCheckOllamaModels:
    'Failed to check Ollama models. Please ensure Ollama is running and download a model from Settings.',
  failedToCheckOllamaModelsShort: 'Failed to check Ollama models',
  claudeCliNotReady: 'Claude Code CLI is not ready',
  install: 'Install',
  noBuiltInAiModelSelected: 'No built-in AI model selected',
  selectModelInSettings: 'Please select a model in settings',
  modelDownloadInProgress: 'Model download in progress',
  modelDownloading: '{model} is downloading ({progress}%). Please wait until download completes.',
  builtInAiModelNotDownloaded: 'Built-in AI model not downloaded',
  builtInAiModelNotDownloadedHint: '{model} needs to be downloaded. Please download it in model settings.',
  builtInAiDownloadIncomplete: 'Built-in AI model download incomplete',
  builtInAiDownloadIncompleteHint: '{model} has a saved partial download. Resume it in model settings.',
  modelFileHasError: 'The model file has an error',
  modelFileCorrupted: 'The model file is corrupted',
  builtInAiModelNotAvailable: 'Built-in AI model not available',
  builtInAiModelNotAvailableHint: '{error}. Please check model settings.',
  builtInAiModelNotReady: 'Built-in AI model not ready',
  builtInAiModelNotReadyHint: 'Please ensure the model is downloaded in settings',
  failedToValidateBuiltInAiModel: 'Failed to validate built-in AI model',
  couldNotCancelSummary: 'Could not cancel the summary. Reopen this meeting to restore its current status.',
  summaryCancellationFailed: 'Summary cancellation failed',
  summaryGenerationStopped: 'Summary generation stopped',
  summaryGenerationStoppedHint: 'You can generate a new summary anytime',

  // Recording start
  couldNotCheckSpeechRuntime: 'Could not check the speech runtime. Restart Meetily and try again.',
  speechRecognitionUnavailable: 'Speech recognition unavailable',
  recordingWaitsForModel: 'Recording can start once the transcription model finishes downloading.',
  transcriptionModelNotReady: 'Transcription model not ready',
  transcriptionModelNotReadyHint:
    'Download a transcription model (Parakeet is best for live) before recording.',
  transcriptionModelSetupRequired: 'Transcription model setup required',
  preparingTranscriptionModel: 'Preparing transcription model…',
  startingAudioCapture: 'Starting audio capture…',
  recordingAppCall: 'Recording your {app} call',
  automationStartedDescription: 'Meeting automation started it, and stops and saves it when the call ends.',
  dontStopIt: "Don't stop it",
  failedToStartRecording: 'Failed to start recording',

  // Recording stop
  recordingCancelled: 'Recording cancelled',
  recordingTooShort: 'That take was under {seconds} seconds, so nothing was saved.',
  waitingForTranscription: 'Waiting for transcription...',
  processingRemainingChunks: 'Processing {count} remaining chunks...',
  flushingTranscriptBuffer: 'Flushing transcript buffer...',
  savingMeetingToDatabase: 'Saving meeting to database...',
  callNotesNotSaved: 'Your call notes were not saved to the meeting',
  callNotesNotSavedHint:
    'Copy them from the Notes tab on the recorder before starting another recording.',
  noMeetingIdReceived: 'No meeting ID received from save operation',
  failedToSaveMeeting: 'Failed to save meeting',

  // Transcript recovery
  meetingMetadataNotFound: 'Meeting metadata not found',
  noTranscriptsFoundForMeeting: 'No transcripts found for this meeting',

  // Audio import
  failedToValidateFile: 'Failed to validate file',
  failedToStartImport: 'Failed to start import',

  // Recording start failures (lib/recording-start-errors.ts)
  noChosenAppsOpen: 'None of your chosen apps is open',
  noChosenAppsOpenMessage:
    'Computer audio is set to record only chosen apps. Open one of them, or switch the record card back to all computer audio.',
  microphoneNotAvailable: 'Microphone not available',
  microphoneNotAvailableMessage:
    'Check that the microphone is connected, that Meetily may use it, and that no other app has taken it.',
  systemAudioNotAvailable: 'System audio not available',
  systemAudioNotAvailableMessage:
    'On macOS, allow Meetily Audio Capture in Privacy & Security, play some audio, and try again. Elsewhere, check the selected playback device.',
  permissionNeeded: 'Permission needed',
  permissionNeededMessage:
    'Allow microphone access (and Audio Capture on macOS) in your system settings, then restart Meetily.',
  couldNotStartRecording: 'Could not start recording',
  couldNotStartRecordingHint: 'Check your audio devices in the recording card and try again.',

  // Quiet system audio advice shown beside the level meter
  lowSystemAudioAdvice:
    'System audio is very quiet. If someone is speaking, raise the call/playback volume or System volume in the recorder’s Output settings. Stop increasing it if the meter warns that audio is too loud.',
} as const

export default feedback
