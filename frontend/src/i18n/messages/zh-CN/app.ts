import type { Messages } from '../en'

/** 简体中文：应用外壳（启动、崩溃恢复、窗口级事件）。 */
const app: Messages['app'] = {
  checkingSetup: '正在检查初始设置…',
  startupSlow: '检查初始设置的时间比预期更长。',
  startupError: '无法检查初始设置状态，请重试。',
  liveSpeakerLabelingUnavailable: '实时说话人标注不可用',
  completeSetupFirst: '请先完成初始设置',
  completeSetupFirstTray: '你需要先完成初始设置，然后才能开始录制。',
  completeSetupFirstDetection: '请先完成初始设置，然后才能开始录制。',
  meetingDetectedTitle: '检测到 {app} 会议',
  meetingDetectedNotificationBody: '现在开始录制这个会议吗？',
  meetingDetectedDescription: '在 Meetily 中同时录制麦克风和系统声音。',
  startRecording: '开始录制',
  meetingEndedTitle: '{app} 通话已结束',
  meetingEndedDescription: '会议自动化正在停止并保存本次录制。',
  dropAudioFile: '请拖入一个音频文件',
  dropAudioFileDescription: '支持的格式：{formats}',
}

export default app
