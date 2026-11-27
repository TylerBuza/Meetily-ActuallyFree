/** Messages for Labs, meeting detection, local stack, Claude CLI and About. */
const labs = {
  // Labs feature groups
  groupMeetings: 'Meetings',
  groupPlaybackTranscript: 'Playback and transcript',
  groupSpeechRecognition: 'Speech recognition',
  groupVoices: 'Voices',

  // Labs features
  meetingAutomationTitle: 'Meeting automation',
  meetingAutomationDescription:
    'Start recording when meeting detection sees a call using your microphone or camera, and stop and save it when the call ends. Recordings you start yourself are never stopped.',
  meetingAutomationWhere:
    'Turns on meeting detection. A notice says when a call starts or ends a recording.',
  waveformScrubbingTitle: 'Waveform scrubbing',
  waveformScrubbingDescription:
    "Show the recording's waveform in the meeting player, so you can see where people talk and jump straight there. Adds 0.5× and 0.75× speeds.",
  waveformScrubbingWhere: "In the player under a meeting's transcript.",
  cleanTranscriptTitle: 'Clean transcript',
  cleanTranscriptDescription:
    'Hide hesitations and stutters ("um", "we we") in the transcript, and write new summaries from the clean text. The saved transcript stays word for word.',
  cleanTranscriptWhere: 'Switch between Clean and Verbatim in the meeting player.',
  whisperSilenceGuardTitle: 'Whisper silence guard',
  whisperSilenceGuardDescription:
    'Filter silence and background noise more strictly when Whisper transcribes, so quiet stretches do not turn into made-up lines. Very quiet speech may be skipped.',
  whisperSilenceGuardWhere: 'Applies whenever Whisper transcribes.',
  parakeetGpuTitle: 'Parakeet on the GPU',
  parakeetGpuDescription:
    "Run Parakeet's encoder on your graphics card through DirectML. Switching reloads the model; if the GPU cannot load it, Parakeet stays on the CPU.",
  parakeetGpuWhere: 'Applies to Parakeet transcription.',
  voiceProfilesTitle: 'Voice profiles',
  voiceProfilesDescription:
    "Learn a contact's voice from the meetings they spoke in. When speakers are identified in later meetings, a matching voice gets their name.",
  voiceProfilesWhere:
    "Learn, update or forget a voice on a contact's page, or add one meeting's audio from its speaker card.",
  meetingAutomationOn: 'Meeting automation is on',
  meetingAutomationOnDescription: 'Meeting detection is on too, so calls can start recordings.',
  couldNotTurnOn: 'Could not turn on {feature}',
  couldNotTurnOff: 'Could not turn off {feature}',
  voiceProfilesNeedModels: 'Voice profiles need the speaker models. ',
  downloadThemInTranscription: 'Download them in Transcription',
  sentencePeriod: '.',
  noVoicesYet: 'No voices yet. Open a contact from ',
  contactsLink: 'Contacts',
  noVoicesYetTail: ' and choose Learn voice.',
  forgetVoiceAria: "Forget {name}'s voice",
  forgotVoice: "Forgot {name}'s voice",
  couldNotForgetVoice: 'Could not forget the voice',

  // Meeting detection
  meetingDetectionTitle: 'Meeting Detection',
  meetingDetectionDescription:
    'Watch for meeting apps (Zoom, Teams, Slack, Webex, Discord…) and prompt you to start recording when one starts. Runs entirely on-device — no network, no telemetry.',
  checkEvery: 'Check every',
  seconds: 'seconds',
  alsoSendNotification: 'Also send a system notification',
  ignoreApps: 'Ignore these apps (comma-separated)',
  ignoreAppsPlaceholder: 'e.g. obs64, teamviewer',
  watchedApps: 'Watched apps: {apps}',
  startStopAutomatically: 'Start and stop recordings automatically',
  startStopAutomaticallyDescription:
    'Instead of prompting, record a detected call once it uses your microphone or camera, and stop and save when it ends. Recordings you start yourself are never stopped.',
  badgeLabs: 'Labs',
  couldNotChangeAutomation: 'Could not change meeting automation',

  // Claude Code CLI summary provider
  claudeCliDescriptionPrefix: 'Summaries run through the ',
  claudeCliDescriptionSuffix:
    ' command on this computer, so they use your Claude subscription instead of a pay-as-you-go API key. No key is stored here — the CLI handles sign-in.',
  claudeLookingForCli: 'Looking for the Claude Code CLI…',
  claudeFound: 'Found {version}',
  claudeSignedIn: 'Signed in',
  claudeSignedInAs: ' as {email}',
  claudePlan: ' · {plan} plan',
  claudeOrg: ' · {org}',
  claudeNotSignedInRun: 'Not signed in. Run ',
  claudeNotSignedInTail: ' in a terminal, then re-check.',
  claudeCliNotFound: 'Claude Code CLI not found.',
  claudeInstall: 'Install Claude Code',
  claudeApiKeySet:
    " is set in this app's environment. The CLI prefers that key over your subscription, so summaries would be billed per token. Unset it to use the subscription.",
  claudeCliPathLabel: 'CLI path (optional)',
  claudeCliPathPlaceholder: 'Leave empty to find claude automatically',
  claudeOnlyNeededWhen: 'Only needed when ',
  claudeInstalledSomewhereUnusual: ' is installed somewhere unusual.',
  claudeChecking: 'Checking…',
  claudeRecheck: 'Re-check',
  claudeTesting: 'Testing…',
  claudeTestCall: 'Test summary call',
  claudeTestCallTitle: 'Send a one-word prompt through the CLI',

  // About
  aboutVersionLine: 'Version {version} · Privacy-first, on-device meeting assistant',
  aboutParagraph:
    'A free, open fork of Meetily that unlocks every feature for everyone. It captures, transcribes and summarizes your meetings entirely on your own machine — with GPU acceleration, bring-your-own-key cloud models, and local-first data ownership.',
  aboutOnDevice: 'On-device',
  aboutOnDeviceDescription: 'Local transcription & summaries',
  aboutPrivate: 'Private',
  aboutPrivateDescription: 'No telemetry, nothing leaves your PC',
  aboutActuallyFree: 'Actually free',
  aboutActuallyFreeDescription: 'Every feature, no paywall',
  aboutLinks: 'Links',
  aboutSourceCode: 'Source code on GitHub',
  aboutPrivacyPolicy: 'Privacy policy',
  aboutBuiltOnThe: 'Built on the ',
  aboutOpenSourceProject: 'open-source Meetily project',
  aboutMitLicensed: ' · MIT licensed',
  aboutForkBy: 'Meetily - Actually Free fork by Tyler Buza',
} as const

export default labs
