import { describe, expect, it } from 'vitest'
import { appendCodexQuotaPoint } from '../src/quota/codex-history'
import { interpolateQuota } from '../dash/src/lib/quota-history'
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
