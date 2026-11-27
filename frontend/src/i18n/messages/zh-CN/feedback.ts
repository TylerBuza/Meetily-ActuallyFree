import type { Messages } from '../en'

/** 简体中文：toasts and inline error messages raised by hooks, contexts and services */
const feedback: Messages['feedback'] = {
  // 会议操作（重命名、移动、删除）
  meetingNeedsTitle: '会议标题不能为空',
  couldNotRenameMeeting: '无法重命名会议',
  singleMeetingMovedToGroup: '会议已移至 {group}',
  meetingsMovedToGroup: '{count} 个会议已移至 {group}',
  singleMeetingMovedToGroupDefault: '会议已移至分组',
  meetingsMovedToGroupDefault: '{count} 个会议已移至分组',
  singleMeetingRemovedFromGroup: '会议已从分组中移除',
  meetingsRemovedFromGroup: '{count} 个会议已从分组中移除',
  couldNotMoveMeetings: '无法移动会议',
  meetingDeleted: '会议已删除',
  meetingsDeleted: '已删除 {count} 个会议',
  couldNotDeleteMeeting: '无法删除 {count} 个会议',
  couldNotDeleteMeetings: '无法删除 {count} 个会议',

  // 配置
  failedToLoadOllamaModels: '无法加载 Ollama 模型',

  // 摘要语言
  couldNotApplyDefaultSummaryLanguage: '无法应用默认摘要语言',
  defaultSummaryLanguageNotAppliedAfterImport: '导入的会议已保存，但未能应用默认摘要语言。',
  defaultSummaryLanguageNotAppliedAfterRecording: '会议已保存，但未能应用默认摘要语言。',
  defaultSummaryLanguageNotAppliedAfterRecovery: '恢复的会议已保存，但未能应用默认摘要语言。',
  couldNotDetectSummaryLanguage: '无法检测摘要语言',
  couldNotDetectSummaryLanguageHint: '会议已保存，但“自动”未能检测出摘要语言。',
  couldNotLoadSavedSummaryLanguage: '无法加载已保存的摘要语言',
  couldNotLoadSavedSummaryLanguageHint: '本次生成将使用“自动”。',
  bilingualTranscriptDetected: '检测到双语转写内容',
  bilingualTranscriptDetectedHint: '如果“自动”选错了回退语言，请手动选择摘要语言。',

  // 可选模型下载
  verifyingDownload: '正在校验下载…',
  downloadFailed: '下载失败',
  modelEnabled: '{model} 已启用',
  whisperNowDefault: 'Whisper 现在是会后增强和重新转写的默认模型。',
  nemotronLiveLabeling: 'Nemotron 将在下次录制时实时标注发言人，并在会后进一步优化。',
  modelDownloadedCouldNotEnable: '模型已下载，但无法启用',
  modelDownloadFailed: '{model} 下载失败',
  keepUsingMeetilyRetryInSettings: '你可以继续使用 Meetily，并在设置中重试。',
  modelUninstalled: '{model} 已卸载',
  couldNotUninstallModel: '无法卸载模型',

  // 录制后处理
  meetingAudioSaveFailed: '部分或全部会议音频无法保存。转写内容仍会保留。',
  recordingStoppedAudioCaptureFailed: '录制因音频采集失败而停止。',

  // 电脑音频选择
  couldNotSaveAudioChoice: '无法保存要录制的音频',
  couldNotAddApp: '无法添加该应用',

  // 实时转写
  liveTranscriptUnavailable: '实时转写不可用',
  restartMeetilyCheckLogs: '请重启 Meetily。如果问题仍然存在，请查看日志。',
  transcriptCopiedToClipboard: '转写内容已复制到剪贴板',
  couldNotSaveSpeakerName: '无法保存发言人名称，请重试。',
  couldNotSaveSpeakerAssignment: '无法保存发言人分配，请重试。',
  couldNotSaveSpeakerMerge: '无法保存发言人合并，请重试。',
  mergedSpeakers: '已将“{source}”合并到“{target}”',
  someSpeechNotTranscribed: '部分语音无法转写',
  modelReadyClosingWindow: '模型已就绪！正在关闭窗口…',

  // 复制与导出
  noTranscriptToCopy: '暂无可复制的转写内容',
  noSummaryToCopy: '暂无可复制的摘要',
  couldNotCopyTranscript: '无法复制转写内容',
  couldNotCopySummary: '无法复制摘要',
  transcriptCopied: '转写内容已复制',
  summaryCopied: '摘要已复制',
  transcriptAndSummaryCopied: '转写内容和摘要已复制',
  noSummaryToExport: '暂无可导出的摘要',
  noTranscriptToExport: '暂无可导出的转写内容',
  exportedAs: '已导出为 {format}',
  exportFailed: '导出失败',

  // 摘要模板
  templateSelected: '已选择模板',
  usingTemplateForSummary: '使用“{template}”模板生成摘要',

  // 摘要生成
  summaryGenerated: '摘要生成成功！',
  summaryReadyDescription: '你的会议摘要已就绪',
  summaryGenerationFailed: '摘要生成失败',
  summaryRegenerationFailed: '摘要重新生成失败',
  summaryGenerationFailedRetry: '摘要生成失败，请重试。',
  summaryCompletedWithoutContent: '摘要已完成，但没有内容。请重试。',
  couldNotRestoreSummaryStatus: '无法恢复摘要状态。请重新打开此会议重试。',
  processingTranscript: '正在处理转写内容…',
  generatingSummary: '正在生成摘要…',
  regeneratingSummary: '正在重新生成摘要…',
  summaryCompleted: '摘要已完成',
  errorGeneratingSummary: '生成摘要时出错',
  noTranscriptText: '没有可用的转写文本。请先添加一些文本。',
  summaryBackendRejectedRequest: '摘要后端未接受本次生成请求。',
  usingModel: '使用 {provider}/{model}',
  failedToRegenerateSummary: '重新生成摘要失败',
  failedToGenerateSummary: '生成摘要失败',
  previousSummaryRestored: '{error}。之前的摘要已恢复。',
  couldNotConnectToLlm: '无法连接 LLM 服务。请确认 Ollama 或你配置的 LLM 提供方正在运行。',
  summaryEmptyContent: '摘要生成完成，但返回的内容为空。',
  unknownError: '未知错误',
  failedToFetchSummaryTranscripts: '无法获取用于生成摘要的转写内容',
  loadingModelConfiguration: '正在加载模型配置，请稍候…',
  noTranscriptsAvailable: '没有可用于生成摘要的转写内容',
  noTranscriptsAvailableForRegeneration: '没有可用于重新生成摘要的转写内容',
  noOllamaModelsInstalled: '配置的端点上没有安装任何 Ollama 模型。',
  noOllamaModelsFound: '未找到 Ollama 模型。请在模型设置中下载 gemma3:1b。',
  modelNotInstalledAtEndpoint: '配置的端点未安装 {model}。',
  selectModelForSummary: '请先选择已安装的模型再生成摘要。',
  selectModelForRegeneration: '请先选择已安装的模型再重新生成摘要。',
  selectedOllamaModelUnavailable: '所选的 Ollama 模型不可用',
  ollamaNotInstalled: '未安装 Ollama',
  ollamaNotInstalledHint: '请下载并安装 Ollama 以使用本地模型。',
  download: '下载',
  failedToCheckOllamaModels: '检查 Ollama 模型失败。请确认 Ollama 正在运行，并在设置中下载模型。',
  failedToCheckOllamaModelsShort: '检查 Ollama 模型失败',
  claudeCliNotReady: 'Claude Code CLI 尚未就绪',
  install: '安装',
  noBuiltInAiModelSelected: '未选择内置 AI 模型',
  selectModelInSettings: '请在设置中选择模型',
  modelDownloadInProgress: '模型正在下载',
  modelDownloading: '{model} 正在下载（{progress}%）。请等待下载完成。',
  builtInAiModelNotDownloaded: '内置 AI 模型尚未下载',
  builtInAiModelNotDownloadedHint: '{model} 需要下载。请在模型设置中下载。',
  builtInAiDownloadIncomplete: '内置 AI 模型下载未完成',
  builtInAiDownloadIncompleteHint: '{model} 有未完成的下载。请在模型设置中继续。',
  modelFileHasError: '模型文件存在错误',
  modelFileCorrupted: '模型文件已损坏',
  builtInAiModelNotAvailable: '内置 AI 模型不可用',
  builtInAiModelNotAvailableHint: '{error}。请检查模型设置。',
  builtInAiModelNotReady: '内置 AI 模型未就绪',
  builtInAiModelNotReadyHint: '请确认已在设置中下载该模型',
  failedToValidateBuiltInAiModel: '验证内置 AI 模型失败',
  couldNotCancelSummary: '无法取消摘要。请重新打开此会议以恢复其当前状态。',
  summaryCancellationFailed: '取消摘要失败',
  summaryGenerationStopped: '摘要生成已停止',
  summaryGenerationStoppedHint: '你可以随时重新生成摘要',

  // 开始录制
  couldNotCheckSpeechRuntime: '无法检查语音运行时。请重启 Meetily 后重试。',
  speechRecognitionUnavailable: '语音识别不可用',
  recordingWaitsForModel: '转写模型下载完成后即可开始录制。',
  transcriptionModelNotReady: '转写模型未就绪',
  transcriptionModelNotReadyHint: '开始录制前请先下载转写模型（实时录制推荐 Parakeet）。',
  transcriptionModelSetupRequired: '需要设置转写模型',
  preparingTranscriptionModel: '正在准备转写模型…',
  startingAudioCapture: '正在开始音频采集…',
  recordingAppCall: '正在录制你的 {app} 通话',
  automationStartedDescription: '由会议自动化启动；通话结束后会自动停止并保存。',
  dontStopIt: '不要停止',
  failedToStartRecording: '无法开始录制',

  // 停止录制
  recordingCancelled: '录制已取消',
  recordingTooShort: '本次录制不足 {seconds} 秒，因此未保存。',
  waitingForTranscription: '正在等待转写…',
  processingRemainingChunks: '正在处理剩余 {count} 个音频片段…',
  flushingTranscriptBuffer: '正在刷新转写缓冲区…',
  savingMeetingToDatabase: '正在将会议保存到数据库…',
  callNotesNotSaved: '通话笔记未能保存到会议',
  callNotesNotSavedHint: '请先到录制页的“笔记”标签页复制内容，再开始下一次录制。',
  noMeetingIdReceived: '保存操作未返回会议 ID',
  failedToSaveMeeting: '保存会议失败',

  // 转写恢复
  meetingMetadataNotFound: '未找到会议元数据',
  noTranscriptsFoundForMeeting: '未找到此会议的转写内容',

  // 音频导入
  failedToValidateFile: '文件校验失败',
  failedToStartImport: '无法开始导入',

  // 开始录制失败（lib/recording-start-errors.ts）
  noChosenAppsOpen: '所选应用都没有打开',
  noChosenAppsOpenMessage:
    '电脑声音当前只录制所选应用。请打开其中一个应用，或在录制卡片中切换回“全部电脑声音”。',
  microphoneNotAvailable: '麦克风不可用',
  microphoneNotAvailableMessage: '请检查麦克风是否已连接、Meetily 是否有权使用它，以及其他应用是否占用了它。',
  systemAudioNotAvailable: '系统声音不可用',
  systemAudioNotAvailableMessage:
    '在 macOS 上，请在“隐私与安全”中允许“Meetily 音频采集”，播放一些声音后重试。其他系统请检查所选的播放设备。',
  permissionNeeded: '需要权限',
  permissionNeededMessage: '请在系统设置中允许麦克风访问（macOS 还需允许音频采集），然后重新启动 Meetily。',
  couldNotStartRecording: '无法开始录制',
  couldNotStartRecordingHint: '请在录制卡片中检查音频设备后重试。',

  // 系统声音过小提示（显示在电平表旁）
  lowSystemAudioAdvice:
    '系统声音非常小。如果有人正在说话，请调高通话/播放音量或系统音量（可在录制器的“输出”设置中调整）。如果电平表提示音量过大，请停止调高。',
}

export default feedback
