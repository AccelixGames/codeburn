import type { CodexQuota, GranularHistory } from './api'

const CODEX_WEEKLY_BUDGET_USD = 1200
const WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60
const MS_PER_SECOND = 1000
const MS_PER_MINUTE = 60 * MS_PER_SECOND

export type QuotaSafeAverage = {
  value: number
  resetAt: string
}

/**
 * Estimate the fixed weekly Codex API-equivalent budget that can be used per
 * graph bucket until the current weekly window resets. The budget is a
 * deliberate product estimate, not a provider-reported dollar balance.
 */
export function computeQuotaSafeAverage(
  timeline: GranularHistory | undefined,
  quota: CodexQuota | undefined,
  unit: 'cost' | 'tokens',
): QuotaSafeAverage | null {
  const primary = quota?.primary
  if (unit !== 'cost' || !timeline || !primary || quota.connection !== 'connected') return null
  if (!primary.resetsAt || primary.windowSeconds !== WEEKLY_WINDOW_SECONDS) return null

  const capturedAt = Date.parse(quota.capturedAt)
  const resetAt = Date.parse(primary.resetsAt)
  if (!Number.isFinite(capturedAt) || !Number.isFinite(resetAt)) return null

  const remainingMs = resetAt - capturedAt
  const bucketMs = timeline.bucketMinutes * MS_PER_MINUTE
  if (!Number.isFinite(bucketMs) || bucketMs <= 0 || remainingMs <= 0) return null

  const remainingPercent = primary.remainingPercent
  if (!Number.isFinite(remainingPercent) || remainingPercent <= 0 || remainingPercent > 100) return null

  const remainingBudget = CODEX_WEEKLY_BUDGET_USD * (remainingPercent / 100)
  const value = remainingBudget * (bucketMs / remainingMs)
  if (!Number.isFinite(value) || value < 0) return null

  // A quota history can span an account switch. When reset metadata is
  // available, only compare samples from the current weekly window; otherwise
  // keep the conservative mixed-account guard for legacy samples.
  const currentWindowHistory = quota.history.filter(point => point.resetsAt === primary.resetsAt)
  const historyForAccountGuard = currentWindowHistory.length > 0 ? currentWindowHistory : quota.history
  const accountIds = new Set(historyForAccountGuard.map(point => point.accountId ?? null))
  if (accountIds.size > 1) return null
  if (quota.accountId && accountIds.size > 0 && !accountIds.has(quota.accountId)) return null

  return { value, resetAt: primary.resetsAt }
}
