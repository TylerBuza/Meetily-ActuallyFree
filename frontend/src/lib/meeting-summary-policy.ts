export function shouldSetUpAutoSummary(source: string | null, isAutoSummaryEnabled: boolean): boolean {
  return source === 'recording' && isAutoSummaryEnabled;
}
