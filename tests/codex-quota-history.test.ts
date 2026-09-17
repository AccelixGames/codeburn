import { describe, expect, it } from 'vitest'
import { appendCodexQuotaPoint } from '../src/quota/codex-history'
import { interpolateQuota } from '../dash/src/lib/quota-history'
import { computeQuotaSafeAverage } from '../dash/src/lib/quota-budget'
import type { CodexQuota } from '../dash/src/lib/api'
import type { QuotaProvider } from '../src/quota/types'
const point = (minute: number, accountId: string | null, remainingPercent: number) => ({ timestamp: new Date(minute * 60000).toISOString(), accountId, remainingPercent, label: '5-hour', resetsAt: null })
const at = (minute: number) => new Date(minute * 60000).toISOString()
describe('account quota history', () => {
  it('records an account switch even with unchanged quota within one minute', () => {
    const quota: QuotaProvider = { provider: 'codex', connection: 'connected', accountId: 'B', primary: { label: '5-hour', percent: 0.5, resetsAt: null }, details: [], planLabel: null, footerLines: [] }
    const rows = appendCodexQuotaPoint([point(0, 'A', 50)], quota, 1000)
    expect(rows).toHaveLength(2)
    expect(rows[1].accountId).toBe('B')
    expect(appendCodexQuotaPoint(rows, quota, 2000)).toBe(rows)
  })
  it('interpolates only consecutive observations of the same account', () => {
    const rows = [point(0, 'A', 80), point(10, 'A', 60), point(20, 'B', 90), point(30, 'A', 40)]
    expect(interpolateQuota(at(5), rows, 'A')).toBe(70)
    expect(interpolateQuota(at(5), rows, 'B')).toBe(0)
    expect(interpolateQuota(at(15), rows, 'A')).toBe(0)
    expect(interpolateQuota(at(15), rows, 'B')).toBe(0)
    expect(interpolateQuota(at(20), rows, 'B')).toBe(90)
    expect(interpolateQuota(at(20), rows, 'A')).toBe(0)
    expect(interpolateQuota(at(25), rows, 'A')).toBe(0)
    expect(interpolateQuota(at(30), rows, 'A')).toBe(40)
  })
  it('keeps legacy unknown-account samples separate', () => {
    const rows = [point(0, null, 80), point(10, null, 60), point(20, 'A', 90)]
    expect(interpolateQuota(at(5), rows, null)).toBe(70)
    expect(interpolateQuota(at(15), rows, null)).toBe(0)
    expect(interpolateQuota(at(25), rows, 'A')).toBe(90)
    expect(interpolateQuota(at(25), rows, null)).toBe(0)
  })
})

describe('quota-safe average', () => {
  const quota = (overrides: Partial<NonNullable<CodexQuota['primary']>> = {}, history = [point(0, 'A', 80)]): CodexQuota => ({
    capturedAt: '2026-01-04T03:00:00.000Z',
    connection: 'connected',
    planLabel: 'Pro',
    accountId: 'A',
    accountName: 'Account A',
    history,
    primary: {
      label: 'Weekly',
      usedPercent: 40,
      remainingPercent: 60,
      resetsAt: '2026-01-08T03:00:00.000Z',
      windowSeconds: 604_800,
      ...overrides,
    },
  })
  const timeline = (bucketMinutes: number, values: Array<{ cost: number; tokens: number }>) => ({
    bucketMinutes,
    modelSeries: [],
    sessionSeries: [],
    points: values.map((value, index) => ({ timestamp: at(index), ...value, models: [], sessions: [] })),
  })

  it.each([1, 5, 60, 1440])('calculates the fixed weekly budget for a %i-minute bucket', (bucketMinutes) => {
    const result = computeQuotaSafeAverage(timeline(bucketMinutes, [{ cost: 10, tokens: 100 }, { cost: 20, tokens: 200 }]), quota(), 'cost')
    // $1,200 × 60% remaining = $720, spread across the four remaining days.
    expect(result?.value).toBeCloseTo(720 * bucketMinutes / (4 * 24 * 60), 8)
    expect(result?.resetAt).toBe('2026-01-08T03:00:00.000Z')
  })

  it('does not depend on recent usage and hides the estimate in token mode', () => {
    const quiet = computeQuotaSafeAverage(timeline(5, [{ cost: 0, tokens: 0 }]), quota(), 'cost')
    const busy = computeQuotaSafeAverage(timeline(5, [{ cost: 1000, tokens: 100_000 }]), quota(), 'cost')
    expect(quiet?.value).toBeCloseTo(busy?.value ?? 0, 8)
    expect(computeQuotaSafeAverage(timeline(5, [{ cost: 10, tokens: 100 }]), quota(), 'tokens')).toBeNull()
  })


  it.each([
    { name: 'no timeline', timeline: undefined, overrides: {} },
    { name: 'missing reset', timeline: timeline(5, [{ cost: 10, tokens: 10 }]), overrides: { resetsAt: null } },
    { name: 'missing window', timeline: timeline(5, [{ cost: 10, tokens: 10 }]), overrides: { windowSeconds: null } },
    { name: 'non-weekly window', timeline: timeline(5, [{ cost: 10, tokens: 10 }]), overrides: { windowSeconds: 18_000 } },
    { name: 'past reset', timeline: timeline(5, [{ cost: 10, tokens: 10 }]), overrides: { resetsAt: '2025-12-31T23:00:00.000Z' } },
    { name: 'zero remaining', timeline: timeline(5, [{ cost: 10, tokens: 10 }]), overrides: { remainingPercent: 0 } },
    { name: 'invalid remaining', timeline: timeline(5, [{ cost: 10, tokens: 10 }]), overrides: { remainingPercent: 101 } },
    { name: 'ambiguous accounts', timeline: timeline(5, [{ cost: 10, tokens: 10 }]), overrides: {}, history: [point(0, 'A', 80), point(1, 'B', 70)] },
  ] as const)('hides the line for $name', ({ timeline: history, overrides, history: quotaHistory }) => {
    expect(computeQuotaSafeAverage(history, quota(overrides, quotaHistory), 'cost')).toBeNull()
  })

  it('uses the remaining percentage as a fixed budget', () => {
    const result = computeQuotaSafeAverage(
      timeline(1, [{ cost: 0, tokens: 0 }]),
      quota({ remainingPercent: 18, usedPercent: 82 }),
      'cost',
    )
    expect(result?.value).toBeCloseTo(216 / (4 * 24 * 60), 8)
  })

  it('ignores history from a previous account window when reset metadata identifies the current window', () => {
    const currentReset = '2026-01-08T03:00:00.000Z'
    const result = computeQuotaSafeAverage(
      timeline(5, [{ cost: 0, tokens: 0 }]),
      quota({}, [
        { ...point(0, 'old-account', 80), resetsAt: '2026-01-07T03:00:00.000Z' },
        { ...point(1, 'A', 60), resetsAt: currentReset },
      ]),
      'cost',
    )
    expect(result?.resetAt).toBe('2026-01-08T03:00:00.000Z')
  })
})
