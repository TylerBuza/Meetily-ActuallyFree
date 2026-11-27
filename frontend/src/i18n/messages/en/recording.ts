/** Messages for recording controls, live session, import and recovery. */
const recording = {
  // Record card / recording controls
  startRecording: 'Start recording',
  stopRecording: 'Stop recording',
  pauseRecording: 'Pause recording',
  resumeRecording: 'Resume recording',
  shrinkToFloatingBar: 'Shrink to floating bar',
  statusRecording: 'Recording',
  statusPaused: 'Paused',
  statusStopping: 'Stopping',
  statusFinishing: 'Finishing',
  statusStoppingEllipsis: 'Stopping…',
  statusStartingEllipsis: 'Starting…',
  statusProcessingEllipsis: 'Processing…',
  oneMoment: 'One moment',
  noGroup: 'No group',
  recordingUnavailable: 'Recording is unavailable',
  recordingUnavailableHint: 'Restart Meetily. If this keeps happening, check the logs.',
  couldNotSaveDevice: 'Could not save the audio device',
  couldNotSaveSensitivity: 'Could not save sensitivity',
  couldNotSwitchMicrophone: 'Could not switch microphone',
  couldNotSwitchSystemAudio: 'Could not switch system audio',
  stillUsingPreviousDevice: 'The recording is still using the previous device.',
  couldNotPause: 'Could not pause the recording',
  couldNotResume: 'Could not resume the recording',

  // Recording pill
  backToLiveRecording: 'Back to the live recording',
  pause: 'Pause',
  resume: 'Resume',
  stopAndSave: 'Stop and save',

  // Recording notice
  beforeYouRecord: 'Before you record',
  recordingDisclosure: 'Recording disclosure and consent',
  noticeTellEveryone:
    'Tell everyone involved that they are being recorded before you start, and obtain any consent required by applicable law.',
  noticeLaws:
    'Recording laws vary by location and situation. You are responsible for following the laws and workplace policies that apply to you and the participants.',
  noticeNoConsent: 'Meetily does not notify participants or obtain their consent for you.',
  rememberNotice: 'Permanently acknowledge — don’t show this notice again',
  acknowledgeNotice: 'Acknowledge recording notice',
  iUnderstand: 'I understand',
  couldNotSavePreference:
    'Could not save your preference. Try again, or uncheck the option to continue for this session.',

  // Live session header
  meetingTitleLabel: 'Meeting title',
  addToGroup: 'Add to group',
  namedCount: '{count} named',
  toNameCount: '{count} to name',
  justYouSoFar: 'Just you so far',
  languageLabel: 'Language',
  copyTranscript: 'Copy transcript',
  hideSidePanel: 'Hide the side panel',
  toggleSidePanel: 'Toggle the side panel',
  closeSidePanel: 'Close the side panel',
  sidePanelDescription: 'Speakers, notes and Ask AI',

  // Live panel
  speakersTab: 'Speakers',
  notesTab: 'Notes',
  askAiTab: 'Ask AI',
  noVoicesYet: 'No voices yet',
  noVoicesHint: 'Each person shows up here as they start talking.',
  thisIsMe: 'This is me',
  isMeAria: '{name} is me',
  speakersFooter:
    'Click a speaker to name them from your contacts or add someone new. Names are saved as contacts when the recording ends.',
  notesPlaceholder: 'Type notes as the call goes. They are saved to this meeting when you stop.',
  askEmptyTitle: 'Ask about this call',
  askEmptyHint: 'Answers come from what has been said so far and your notes.',
  askSuggestionMissed: 'What did I miss in the last 5 minutes?',
  askSuggestionDecided: 'What has been decided?',
  askSuggestionActionItems: 'Which action items came up?',
  askSuggestionOpenQuestions: 'What questions are still open?',
  askPlaceholder: 'Ask about the call…',
  askFootnote:
    'Uses your summary model. Cloud providers receive the parts of the transcript needed to answer.',
  askNoTranscript: 'Nothing has been said yet. Ask again once the transcript has some lines.',

  // Computer audio source
  statusPlaying: 'playing sound',
  statusOpen: 'open',
  statusClosed: 'not open',
  computerAudioToRecord: 'Computer audio to record',
  onlyChosenApps: 'Only chosen apps',
  allComputerAudio: 'All computer audio',
  addApp: 'Add app',
  searchOpenApps: 'Search open apps',
  lookingForApps: 'Looking for open apps…',
  noMatchingApps: 'No matching open apps.',
  playingSoundNow: 'Playing sound now',
  openApps: 'Open apps',
  chooseAppNotOpen: 'Choose an app that is not open…',
  stopRecordingApp: 'Stop recording {app}',
  appsHintNextRecording: 'Applies from your next recording.',
  appsHintAddFirst: 'Add an app before starting, or choose all computer audio.',
  appsHintMac: 'On macOS choose one app, start audio in it, then start recording.',
  appsHintOnly: "Only these apps are recorded. If none is open when you start, the recording can't start.",
  legendPlaying: 'Playing sound',
  legendOpen: 'Open',
  legendNotOpen: 'Not open',
  computerAudioTitle: 'Computer audio',
  computerAudioDescription:
    'Record everything your computer plays, or only the apps you choose, such as just the call without music or notification sounds. You can also change this from the record card.',

  // Recording settings
  couldNotOpenFolder: 'Could not open recordings folder',
  folderUpdated: 'Recordings folder updated',
  couldNotUpdateFolder: 'Could not update recordings folder',
  preferenceSaved: 'Preference saved',
  failedToSavePreference: 'Failed to save preference',
  settingsSaved: 'Recording settings saved',
  couldNotSaveSettings: 'Could not save recording settings',
  saveAudio: 'Save audio',
  saveAudioDescription:
    "Keep each meeting's audio so you can play it back, fix who said what, and transcribe it again later.",
  savedLocation: 'Where recordings are saved',
  defaultFolder: 'Default folder',
  changeFolder: 'Change folder',
  savedAsFiles: 'Saved as {format} files named recording_YYYYMMDD_HHMMSS.{extension}.',
  audioNotSavedTitle: "Audio isn't being saved",
  audioNotSavedDescription:
    "Transcripts are kept, but you won't be able to play meetings back or transcribe them again. Turn on Save audio to keep it.",

  // Audio device selection
  devicesAria: '{label} devices',
  noDevicesFound: 'No devices found',
  recordSection: 'Record',
  deviceNotConnected: '{device} is not connected.',

  // Voice lane
  systemDefault: 'System default',
  defaultMicrophone: 'Default microphone',
  defaultOutput: 'Default output',
  inputSettings: 'Input settings',
  outputSettings: 'Output settings',
  muteMicrophone: 'Mute microphone',
  unmuteMicrophone: 'Unmute microphone',
  muteOutput: 'Mute output',
  unmuteOutput: 'Unmute output',
  microphoneLabel: 'Microphone',
  systemAudioLabel: 'System audio',
  micVolume: 'Mic volume',
  systemVolume: 'System volume',
  inputLevel: 'Input level',
  systemLevel: 'System level',
  macOutputNote: 'macOS records the current system output.',

  // Recorder dialogs
  transcriptionLanguageTitle: 'Transcription language',
  transcriptionLanguageDescription:
    'The language people speak in your meetings. Auto-detect works for most calls.',
  setupTranscriptionTitle: 'Set up transcription to record',
  transcriptionModelsTitle: 'Transcription models',
  setupTranscriptionDescription:
    'Meetily needs a speech model on this computer before it can transcribe. Parakeet is fast and works well for live meetings.',
  transcriptionModelsDescription: 'Choose the speech model used while recording and after the call.',
  showConfidence: 'Show confidence',
  showConfidenceDescription: 'Mark transcript lines the model was unsure about',
  recordingStoppedTitle: 'The recording stopped',
  fallingBehindTitle: 'Transcription is falling behind',
} as const

export default recording
