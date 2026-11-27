/** The application shell: startup, crash recovery and window-level events. */
const app = {
  checkingSetup: 'Checking setup…',
  startupSlow: 'Setup status is taking longer than expected.',
  startupError: 'Unable to check setup status. Please retry.',
  liveSpeakerLabelingUnavailable: 'Live speaker labeling unavailable',
  completeSetupFirst: 'Please complete setup first',
  completeSetupFirstTray: 'You need to finish onboarding before you can start recording.',
  completeSetupFirstDetection: 'Finish onboarding before you can start recording.',
  meetingDetectedTitle: '{app} meeting detected',
  meetingDetectedNotificationBody: 'Start recording this meeting now?',
  meetingDetectedDescription: 'Capture mic + system audio in Meetily.',
  startRecording: 'Start recording',
  meetingEndedTitle: '{app} call ended',
  meetingEndedDescription: 'Meeting automation is stopping and saving the recording.',
  dropAudioFile: 'Please drop an audio file',
  dropAudioFileDescription: 'Supported formats: {formats}',
} as const

export default app
