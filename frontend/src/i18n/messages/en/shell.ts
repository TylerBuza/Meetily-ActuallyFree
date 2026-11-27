/** Messages for the sidebar, command bar, About, updates and other always-present chrome. */
const shell = {
  // Sidebar rail
  resizeSidebar: 'Resize sidebar',
  aboutMeetily: 'About Meetily',
  expandSidebar: 'Expand sidebar',
  collapseSidebar: 'Collapse sidebar',
  backToRecording: 'Back to recording',
  backToRecordingWithTime: 'Back to recording · {time}',
  paused: 'Paused',
  newRecording: 'New recording',
  moreWaysToStart: 'More ways to start',
  importAudioFile: 'Import an audio file…',
  recordForGroup: 'Record for a group',
  searchCommand: 'Search or run a command',
  searchOrJump: 'Search or jump to…',
  sectionsLabel: 'Sections',
  contacts: 'Contacts',
  groups: 'Groups',
  allMeetings: 'All meetings',

  // Meeting list
  meetingsHeading: 'Meetings',
  meetingListOptions: 'Meeting list options',
  arrangeBy: 'Arrange by',
  sortByDate: 'Date',
  sortByGroup: 'Group',
  selectMeetings: 'Select meetings',
  openLibrary: 'Open the library',
  noMeetingsYet: 'No meetings yet',
  noMeetingsHint: 'Your recordings will show up here.',
  noGroup: 'No group',
  older: 'Older',
  selectedCount: '{count} selected',
  selectAll: 'All',
  clearSelection: 'Clear selection',
  moveToGroup: 'Move to group',
  moveToGroupPlaceholder: 'Move to group…',
  removeFromGroup: 'Remove from group',
  createGroupOption: 'Create group “{query}”',
  export: 'Export',
  exportSelected: 'Export selected meetings',
  deleteSelected: 'Delete selected meetings',
  deleteMeetingTitle: 'Delete this meeting?',
  deleteMeetingsTitle: 'Delete {count} meetings?',
  deleteMeetingDescription:
    'The transcript, summary, notes, and action items are removed. Audio files stay in your recordings folder.',
  selectMeeting: 'Select {title}',
  deselectMeeting: 'Deselect {title}',
  meetingTitleLabel: 'Meeting title',
  meetingActions: 'Actions for {title}',
  open: 'Open',
  newGroupEllipsis: 'New group…',
  deleteEllipsis: 'Delete…',

  // Command bar
  searchAndCommands: 'Search and commands',
  searchPlaceholder: 'Search meetings, people, groups, transcripts… or type a command',
  nothingMatches: 'Nothing matches “{query}”',
  searchHint: 'Try a name, a topic, or fewer words.',
  searchUnavailable: 'Search is unavailable',
  actionsHeading: 'Actions',
  recordHeading: 'Record',
  peopleHeading: 'People',
  actionItemsHeading: 'Action items',
  saidInMeetingHeading: 'Said in a meeting',
  inSummaryHeading: 'In a summary',
  recentMeetingsHeading: 'Recent meetings',
  goToHeading: 'Go to',
  themeHeading: 'Theme',
  searchInfo:
    'Search finds names, meeting titles, anything said in a transcript, summaries and action items.',
  moveHint: 'to move',
  openHint: 'to open',
  anywhereHint: 'anywhere',
  backToRecordingCommand: 'Back to the recording',
  resumeRecording: 'Resume recording',
  pauseRecording: 'Pause recording',
  stopAndSaveRecording: 'Stop and save the recording',
  startRecording: 'Start recording',
  importRecording: 'Import a recording',
  newGroup: 'New group',
  newContact: 'New contact',
  home: 'Home',
  themeCommand: 'Theme: {theme}',
  current: 'Current',
  recordGroupMeeting: 'Record a {group} meeting',
  meetingCountOne: '{count} meeting',
  meetingCountMany: '{count} meetings',

  // Window controls
  windowGroup: 'Window',
  minimize: 'Minimize',
  maximize: 'Maximize',
  restore: 'Restore',

  // About
  meetilyLogo: 'Meetily Logo',
  aboutTagline: 'Real-time notes and summaries that never leave your machine.',
  viewMacosReleases: 'View macOS Releases',
  checkForUpdates: 'Check for Updates',
  checkingForUpdates: 'Checking...',
  youAreUpToDate: 'You are running the latest version',
  updateCheckFailed: 'Failed to check for updates: {message}',
  unknownError: 'Unknown error',
  couldNotOpenLink: 'Could not open the link',
  updateAvailableInline: 'Update available: v{version}',
  whatMakesDifferent: 'What makes Meetily different',
  privacyFirst: 'Privacy-first',
  privacyFirstBody:
    'Your data & AI processing workflow can now stay within your premise. No cloud, no leaks.',
  useAnyModel: 'Use Any Model',
  useAnyModelBody:
    'Prefer local open-source model? Great. Want to plug in an external API? Also fine. No lock-in.',
  costSmart: 'Cost-Smart',
  costSmartBody:
    'Avoid pay-per-minute bills by running models locally (or pay only for the calls you choose).',
  worksEverywhere: 'Works everywhere',
  worksEverywhereBody: 'Google Meet, Zoom, Teams-online or offline.',
  aboutFooter: 'Meetily - Actually Free · Open source (MIT)',

  // Update prompt
  updateAvailable: 'Update Available',
  updateAvailableVersion: 'Version {version} is now available',
  viewDetails: 'View Details',

  // CUDA / driver notices
  cudaReady: 'NVIDIA CUDA is ready',
  cudaReadyDescription:
    'Rerun Meetily setup to replace the {backend} build with the CUDA build.',
  downloadSetup: 'Download setup',
  driverUpdateRecommended: 'NVIDIA driver update recommended',
  driverUpdateDescription:
    'Install a current NVIDIA driver, then reopen Meetily to recheck CUDA support.',
  getDriver: 'Get driver',

  // Crash report
  crashTitle: 'Meetily encountered a problem',
  crashDescriptionPanic:
    'Meetily encountered an internal error during the previous session. Creating or ignoring this report does not include or modify meeting content.',
  crashDescriptionUnclean:
    'Meetily did not shut down cleanly during the previous session. Creating or ignoring this report does not include or modify meeting content.',
  crashDetectedFallback: 'the previous session',
  detected: 'Detected',
  version: 'Version',
  whatsIncluded: "What's included?",
  crashIncludedCrash:
    'Crash time and type, Meetily version, coarse operating-system details, bucketed CPU core count, rounded memory size, acceleration backend, and source-relative panic file/line details with a location fingerprint when available.',
  crashIncludedTimeline:
    'When available, a short diagnostic timeline shows model loading, recording startup and Stop stages, elapsed times, and operations that failed or were still running.',
  crashIncludedExcluded:
    'No audio, recordings, transcripts, summaries, meeting names, database, settings, credentials, usernames, hostnames, or device names.',
  crashSendExplainer:
    'Send Report asks where to save the private ZIP, then opens a public GitHub issue. Opening GitHub contacts GitHub; the ZIP stays local until you choose it as an attachment, which uploads it before issue submission.',
  ignore: 'Ignore',
  saveZip: 'Save ZIP',
  sendReport: 'Send Report',
  crashDismissFailed: 'The report could not be dismissed permanently',
  crashDismissFailedDescription:
    'You can continue now, but Meetily may ask about it again next launch.',
  crashSaved: 'Crash report saved',
  crashSaveFailed: 'Could not save the crash report',
  crashReadyToAttach: 'Crash report ready to attach',
  crashReadyToAttachDescription: 'GitHub opened with the report details. Attach the ZIP you just saved.',
  crashPrepareFailed: 'Could not prepare the crash report',

  // Download progress toast
  enablingModel: 'Enabling model…',
  downloadFailed: 'Download failed',
  downloadComplete: 'Download complete',
  downloadCancelled: 'Download cancelled',
  downloadAriaLabel: '{name}: {detail} {progress}%',
  progressAriaText: '{detail} {progress}%',
  transcriptionModel: 'Transcription Model ({model})',
  summaryModel: 'Summary Model ({model})',
  whisperDescription: 'Whisper · Post-call transcription',
  nemotronDescription: 'Nemotron · Speaker identification',
  networkError: 'Network error - Check your internet connection',
  serverError: 'Server error - Download temporarily unavailable',
  storageError: 'Storage error - Check available disk space',
  validationError: 'File validation failed - Please retry download',
} as const

export default shell
