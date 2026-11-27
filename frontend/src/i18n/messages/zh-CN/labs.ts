import type { Messages } from '../en'

/** 简体中文：Labs, meeting detection, local stack, Claude CLI and About */
const labs: Messages['labs'] = {
  // 实验室功能分组
  groupMeetings: '会议',
  groupPlaybackTranscript: '播放与转写',
  groupSpeechRecognition: '语音识别',
  groupVoices: '声音',

  // 实验室功能
  meetingAutomationTitle: '会议自动化',
  meetingAutomationDescription:
    '当会议检测发现正在使用你的麦克风或摄像头的通话时开始录制，并在通话结束时停止并保存。你自己手动开始的录制永远不会被停止。',
  meetingAutomationWhere: '会开启会议检测。通话开始或结束录制时会显示提示。',
  waveformScrubbingTitle: '波形拖动',
  waveformScrubbingDescription:
    '在会议播放器中显示录音的波形，让你看到人们说话的位置并直接跳转过去。新增 0.5× 和 0.75× 倍速。',
  waveformScrubbingWhere: '会议转写内容下方的播放器中。',
  cleanTranscriptTitle: '清理转写内容',
  cleanTranscriptDescription:
    '在转写内容中隐藏犹豫和口吃（“嗯”“我我”），并用清理后的文本生成新摘要。已保存的转写内容保持逐字不变。',
  cleanTranscriptWhere: '在会议播放器中的“清理”和“逐字”之间切换。',
  whisperSilenceGuardTitle: 'Whisper 静音保护',
  whisperSilenceGuardDescription:
    '在 Whisper 转写时更严格地过滤静音和背景噪音，避免安静片段变成编造的内容。非常轻的说话声可能会被跳过。',
  whisperSilenceGuardWhere: '在 Whisper 转写时生效。',
  parakeetGpuTitle: 'GPU 上的 Parakeet',
  parakeetGpuDescription:
    '通过 DirectML 在显卡上运行 Parakeet 的编码器。切换会重新加载模型；如果 GPU 无法加载，Parakeet 会继续使用 CPU。',
  parakeetGpuWhere: '适用于 Parakeet 转写。',
  voiceProfilesTitle: '声纹档案',
  voiceProfilesDescription:
    '根据联系人在会议中说话的声音学习其声纹。当之后的会议识别发言人时，匹配的声纹会获得该联系人的姓名。',
  voiceProfilesWhere:
    '在联系人页面学习、更新或删除声纹，或从会议发言人卡片添加该会议的音频。',
  meetingAutomationOn: '会议自动化已开启',
  meetingAutomationOnDescription: '会议检测也会同时开启，因此通话可以自动开始录制。',
  couldNotTurnOn: '无法开启{feature}',
  couldNotTurnOff: '无法关闭{feature}',
  voiceProfilesNeedModels: '声纹档案需要说话人模型。',
  downloadThemInTranscription: '在“转写”中下载',
  sentencePeriod: '。',
  noVoicesYet: '还没有任何声纹。打开',
  contactsLink: '联系人',
  noVoicesYetTail: '列表并选择“学习声纹”。',
  forgetVoiceAria: '删除{name}的声纹',
  forgotVoice: '已删除{name}的声纹',
  couldNotForgetVoice: '无法删除声纹',

  // 会议检测
  meetingDetectionTitle: '会议检测',
  meetingDetectionDescription:
    '监视会议应用（Zoom、Teams、Slack、Webex、Discord 等），在其中一个开始时提示你开始录制。完全在本机运行 —— 无网络、无遥测。',
  checkEvery: '检查间隔',
  seconds: '秒',
  alsoSendNotification: '同时发送系统通知',
  ignoreApps: '忽略这些应用（逗号分隔）',
  ignoreAppsPlaceholder: '例如：obs64、teamviewer',
  watchedApps: '监视的应用：{apps}',
  startStopAutomatically: '自动开始和停止录制',
  startStopAutomaticallyDescription:
    '不再提示，而是在检测到的通话使用你的麦克风或摄像头后开始录制，并在通话结束时停止并保存。你自己手动开始的录制永远不会被停止。',
  badgeLabs: '实验室',
  couldNotChangeAutomation: '无法更改会议自动化',

  // Claude Code CLI 摘要服务商
  claudeCliDescriptionPrefix: '摘要通过本机的 ',
  claudeCliDescriptionSuffix:
    ' 命令运行，因此会使用你的 Claude 订阅，而不是按量计费的 API 密钥。此处不存储密钥 —— CLI 会负责登录。',
  claudeLookingForCli: '正在查找 Claude Code CLI…',
  claudeFound: '已找到 {version}',
  claudeSignedIn: '已登录',
  claudeSignedInAs: '（{email}）',
  claudePlan: ' · {plan} 套餐',
  claudeOrg: ' · {org}',
  claudeNotSignedInRun: '未登录。请在终端运行 ',
  claudeNotSignedInTail: '，然后重新检查。',
  claudeCliNotFound: '未找到 Claude Code CLI。',
  claudeInstall: '安装 Claude Code',
  claudeApiKeySet:
    ' 已在本应用的环境中设置。CLI 会优先使用该密钥而非你的订阅，因此摘要将按 token 计费。要使用订阅，请取消设置该环境变量。',
  claudeCliPathLabel: 'CLI 路径（可选）',
  claudeCliPathPlaceholder: '留空以自动查找 claude',
  claudeOnlyNeededWhen: '仅在 ',
  claudeInstalledSomewhereUnusual: ' 安装在非常规位置时才需要设置。',
  claudeChecking: '检查中…',
  claudeRecheck: '重新检查',
  claudeTesting: '测试中…',
  claudeTestCall: '测试摘要调用',
  claudeTestCallTitle: '通过 CLI 发送一个单词的提示',

  // 关于
  aboutVersionLine: '版本 {version} · 隐私优先的本地会议助手',
  aboutParagraph:
    'Meetily 的免费开源分支，为所有人解锁全部功能。它完全在你自己的电脑上捕获、转写并生成会议摘要 —— 支持 GPU 加速、自带密钥的云端模型，以及本地优先的数据所有权。',
  aboutOnDevice: '本地运行',
  aboutOnDeviceDescription: '本地转写与摘要',
  aboutPrivate: '隐私',
  aboutPrivateDescription: '无遥测，数据不会离开你的电脑',
  aboutActuallyFree: '真正免费',
  aboutActuallyFreeDescription: '全部功能，无付费墙',
  aboutLinks: '链接',
  aboutSourceCode: 'GitHub 源代码',
  aboutPrivacyPolicy: '隐私政策',
  aboutBuiltOnThe: '基于',
  aboutOpenSourceProject: '开源 Meetily 项目',
  aboutMitLicensed: ' · MIT 许可证',
  aboutForkBy: '由 Tyler Buza 制作的 Meetily - Actually Free 分支',
}

export default labs
