/** Model catalogue names, taglines, performance badges and voice-profile wording. */
const modelCatalog = {
  // Whisper/Parakeet performance badges
  badgeFullPrecision: 'Full Precision',
  badgeBalancedPlus: 'Balanced+',
  badgeBalanced: 'Balanced',
  badgeFast: 'Fast',
  badgeStandard: 'Standard',
  badgeInt8Quantized: 'Int8 Quantized',

  // Whisper tagline wording
  speedRealTime: 'Real time',
  speedFastProcessing: 'Fast processing',
  speedModerate: 'Moderate speed',
  speedSlower: 'Slower processing',
  featureMostAccurate: 'Most accurate',
  featureBestAccuracyWithSpeed: 'Best accuracy with speed',
  featureProfessionalQuality: 'Professional quality',
  featureBalancedQuality: 'Balanced quality',
  featureGoodAccuracy: 'Good accuracy',
  featureFastestOption: 'Fastest option',
  featureOptimized: '{feature}, optimized',
  featureUltraFast: '{feature}, ultra fast',
  tagline: '{speed} • {feature}',

  // Parakeet display names, taglines and descriptions
  parakeetLightning: 'Lightning',
  parakeetCompact: 'Compact',
  parakeetPrecise: 'Precise',
  parakeetLightningTagline: 'Real time • Best for speed, great accuracy',
  parakeetCompactTagline: 'Real time • Smaller size',
  parakeetPreciseTagline: '20x real-time • Higher accuracy',
  parakeetLightningDescription: 'Real time on M4 Max, optimized for speed',
  parakeetCompactDescription: '25x real-time, smaller size with good accuracy',
  parakeetPreciseDescription: '20x real-time on M4 Max, higher precision',

  // Claude Code CLI blocking reasons
  claudeCliChecking: 'Checking the Claude Code CLI…',
  claudeCliNotFound: 'Claude Code CLI not found.',
  claudeCliNotSignedIn:
    'The Claude Code CLI is installed but not signed in. Run `claude auth login` in a terminal.',

  // Voice profile source
  voiceSourceOneOne: '{samples} clear turn in {meetings} meeting',
  voiceSourceOneOther: '{samples} clear turn in {meetings} meetings',
  voiceSourceOtherOne: '{samples} clear turns in {meetings} meeting',
  voiceSourceOtherOther: '{samples} clear turns in {meetings} meetings',
} as const

export default modelCatalog
