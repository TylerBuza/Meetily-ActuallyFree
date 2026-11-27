import type { Messages } from '../en'

/** 简体中文：模型目录名称、简介、性能徽章与声纹档案措辞。 */
const modelCatalog: Messages['modelCatalog'] = {
  // Whisper/Parakeet 性能徽章
  badgeFullPrecision: '全精度',
  badgeBalancedPlus: '均衡+',
  badgeBalanced: '均衡',
  badgeFast: '快速',
  badgeStandard: '标准',
  badgeInt8Quantized: 'Int8 量化',

  // Whisper 简介措辞
  speedRealTime: '实时',
  speedFastProcessing: '快速处理',
  speedModerate: '速度适中',
  speedSlower: '处理较慢',
  featureMostAccurate: '准确度最高',
  featureBestAccuracyWithSpeed: '准确度出色且速度快',
  featureProfessionalQuality: '专业级质量',
  featureBalancedQuality: '质量均衡',
  featureGoodAccuracy: '准确度良好',
  featureFastestOption: '速度最快',
  featureOptimized: '{feature}，已优化',
  featureUltraFast: '{feature}，极速',
  tagline: '{speed} • {feature}',

  // Parakeet 显示名称、简介与说明
  parakeetLightning: '闪电',
  parakeetCompact: '紧凑',
  parakeetPrecise: '精准',
  parakeetLightningTagline: '实时 • 速度优先，准确度出色',
  parakeetCompactTagline: '实时 • 体积更小',
  parakeetPreciseTagline: '20 倍实时 • 准确度更高',
  parakeetLightningDescription: '在 M4 Max 上实时运行，针对速度优化',
  parakeetCompactDescription: '25 倍实时，体积更小，准确度良好',
  parakeetPreciseDescription: '在 M4 Max 上 20 倍实时，精度更高',

  // Claude Code CLI 不可用原因
  claudeCliChecking: '正在检查 Claude Code CLI…',
  claudeCliNotFound: '未找到 Claude Code CLI。',
  claudeCliNotSignedIn: 'Claude Code CLI 已安装，但尚未登录。请在终端运行 `claude auth login`。',

  // 声纹来源
  voiceSourceOneOne: '{meetings} 场会议中的 {samples} 段清晰语音',
  voiceSourceOneOther: '{meetings} 场会议中的 {samples} 段清晰语音',
  voiceSourceOtherOne: '{meetings} 场会议中的 {samples} 段清晰语音',
  voiceSourceOtherOther: '{meetings} 场会议中的 {samples} 段清晰语音',
}

export default modelCatalog
