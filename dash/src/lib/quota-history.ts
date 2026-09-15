import type { CodexQuotaPoint } from './api'

export function interpolateQuota(timestamp: string, samples: CodexQuotaPoint[], accountId: string | null): number | null {
  const at = Date.parse(timestamp)
  if (!Number.isFinite(at) || samples.length === 0) return null
  let leftIndex = -1
  let rightIndex = -1
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index]!
    const sampleAt = Date.parse(sample.timestamp)
    if (!Number.isFinite(sampleAt)) continue
    if (sampleAt === at) return (sample.accountId ?? null) === accountId ? sample.remainingPercent : 0
    if (sampleAt < at) leftIndex = index
    if (sampleAt > at) {
      rightIndex = index
      break
    }
  }
  // Estimate the missing edges from the nearest two observations. This keeps
  // the graph moving through the full selected range without flattening it to
  // the current value when the usage and quota requests have different ages.
  if (leftIndex < 0 && samples.length >= 2) {
    leftIndex = 0
    rightIndex = 1
  } else if (rightIndex < 0 && samples.length >= 2) {
    rightIndex = samples.length - 1
    leftIndex = rightIndex - 1
  }
  if (leftIndex < 0 || rightIndex < 0) return null
  const left = samples[leftIndex]!
  const right = samples[rightIndex]!
  // A switch has no same-account observations to interpolate between.
  if ((left.accountId ?? null) !== (right.accountId ?? null)) {
    if (at > Date.parse(right.timestamp)) return (right.accountId ?? null) === accountId ? right.remainingPercent : 0
    if (at < Date.parse(left.timestamp)) return (left.accountId ?? null) === accountId ? left.remainingPercent : 0
    return 0
  }
  if ((left.accountId ?? null) !== accountId) return 0
  const leftAt = Date.parse(left.timestamp)
  const rightAt = Date.parse(right.timestamp)
  if (rightAt <= leftAt) return left.remainingPercent
  const ratio = (at - leftAt) / (rightAt - leftAt)
  return Math.max(0, Math.min(100, left.remainingPercent + (right.remainingPercent - left.remainingPercent) * ratio))
}

