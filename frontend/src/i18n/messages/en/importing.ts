/** Messages for audio import, transcript recovery and permission warnings. */
const importing = {
  // Permission warning banner.
  micAndAudioUnavailable: 'Meetily can’t hear your microphone or computer audio',
  micUnavailable: 'Meetily can’t hear your microphone',
  systemAudioUnavailable: 'Meetily can’t record computer audio',
  macAudioCaptureDenied: ' Audio Capture is turned off for Meetily. Turn it on in System Settings, then check again.',
  macAccessNotConfirmed:
    ' macOS hasn’t confirmed access yet. Click Check again and allow Meetily to record system audio. If you already allowed it, restart Meetily or play some audio and check again.',
  macAudioCaptureUnknown:
    ' On macOS, allow Audio Capture for Meetily, play some audio, then check again. Restart Meetily if it stays silent.',
  noMicrophoneFound:
    'No microphone was found. Check that one is connected, that Meetily is allowed to use it in your system settings, and that no other app has taken it over.',
  canStillRecordMic: 'You can still record your microphone, but the other side of the call won’t be captured.',
  computerAudioUnavailable: 'Computer audio capture is unavailable too.',
  microphoneSettings: 'Microphone settings',
  audioCaptureSettings: 'Audio Capture settings',
  checkAgain: 'Check again',

  // Drag-and-drop overlay.
  dropToImport: 'Drop to import this recording',

  // Import audio dialog.
  importCompleteToast: 'Import complete! {count} segments created.',
  importFailed: 'Import failed',
  importCancelled: 'Import cancelled',
  importingAudio: 'Importing Audio...',
  importFailedTitle: 'Import Failed',
  importCompleteTitle: 'Import Complete',
  importAudioFileTitle: 'Import Audio File',
  processingAudio: 'Processing audio...',
  importErrorDescription: 'An error occurred during import',
  importDialogDescription: 'Import an audio file to create a new meeting with transcripts',
  meetingTitle: 'Meeting Title',
  enterMeetingTitle: 'Enter meeting title',
  chooseDifferentFile: 'Choose Different File',
  validating: 'Validating...',
  selectAudioFile: 'Select Audio File',
  advancedOptions: 'Advanced Options',
  language: 'Language',
  selectLanguage: 'Select language',
  parakeetLanguageNote: "Language selection isn't supported for Parakeet. It always uses automatic detection.",
  model: 'Model',
  loadingModels: 'Loading models...',
  selectModel: 'Select model',
  importAction: 'Import',
  tryAgain: 'Try Again',

  // Transcript recovery dialog.
  recoverToastFailed: 'Could not recover the meeting',
  recoveryToastFailedDescription: 'Please try again.',
  deleteToastFailed: 'Could not delete the recording',
  recoverTitle: 'Recover Interrupted Meetings',
  recoverDescriptionOne:
    'We found {count} meeting that was interrupted. Select a meeting to preview and recover it.',
  recoverDescriptionMany:
    'We found {count} meetings that were interrupted. Select a meeting to preview and recover it.',
  interruptedMeetings: 'Interrupted Meetings',
  preview: 'Preview',
  audioAvailable: 'Audio available',
  noAudio: 'No audio',
  transcriptCountOne: '{count} transcript',
  transcriptsCount: '{count} transcripts',
  startedAt: 'Started {date}',
  loadingPreview: 'Loading preview...',
  showingFirstSegments: 'Showing first {shown} transcript segments (of {total} total)',
  andMoreTranscriptOne: '... and {count} more transcript',
  andMoreTranscripts: '... and {count} more transcripts',
  noTranscriptsToPreview: 'No transcripts to preview',
  selectMeetingToPreview: 'Select a meeting to preview',
  recover: 'Recover',
  deleteUnsavedTitle: 'Delete this unsaved recording?',
  deleteUnsavedDescription: 'Its recovered transcript is removed for good. This cannot be undone.',

  // Update dialog and toasts.
  updateInstalledToast: 'Update installed successfully. The app will restart...',
  failedToInstallUpdate: 'Failed to download or install update',
  unknownError: 'Unknown error',
  updateFailedWithMessage: 'Update failed: {message}',
  installingUpdate: 'Installing Update',
  downloadingUpdate: 'Downloading Update',
  updateError: 'Update Error',
  updateAvailable: 'Update Available',
  downloadCompleteInstalling: 'Download complete. Verifying and installing the update.',
  preparingSecureDownload: 'Preparing the secure download...',
  downloadingSignedPackage: 'Downloading the signed update package from GitHub.',
  updateErrorDescription: 'An error occurred while updating',
  newVersionAvailable: 'A new version ({version}) is available',
  installed: 'Installed',
  available: 'Available',
  released: 'Released',
  installing: 'Installing',
  restartWhenInstalled: 'Meetily will restart automatically when the update is installed.',
  later: 'Later',
  downloadAndInstall: 'Download & Install',
} as const

export default importing
