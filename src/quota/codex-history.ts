import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'

import { getCodeburnCacheDir } from '../cache-dir.js'
import type { QuotaProvider } from './types.js'

export type CodexQuotaPoint = {
  timestamp: string
  remainingPercent: number
  label: string
  resetsAt: string | null
}

const HISTORY_FILE = 'codex-quota-history.json'
const MAX_POINTS = 525_600 // One-minute samples for roughly one year.
const SAMPLE_INTERVAL_MS = 60_000

function historyPath(): string {
  return join(getCodeburnCacheDir(), HISTORY_FILE)
}

function finitePercent(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null
}

function decodePoint(value: unknown): CodexQuotaPoint | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const timestamp = typeof raw.timestamp === 'string' ? raw.timestamp : null
  const remainingPercent = finitePercent(raw.remainingPercent)
  const label = typeof raw.label === 'string' ? raw.label : null
  const resetsAt = raw.resetsAt === null || typeof raw.resetsAt === 'string' ? raw.resetsAt : null
  if (!timestamp || !Number.isFinite(Date.parse(timestamp)) || remainingPercent === null || label === null) return null
  return { timestamp, remainingPercent, label, resetsAt }
}

export async function loadCodexQuotaHistory(): Promise<CodexQuotaPoint[]> {
  try {
    const raw = JSON.parse(await readFile(historyPath(), 'utf8')) as unknown
    const rows = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { points?: unknown }).points)
      ? (raw as { points: unknown[] }).points
      : []
    return rows.map(decodePoint).filter((point): point is CodexQuotaPoint => point !== null).slice(-MAX_POINTS)
  } catch {
    return []
  }
}

export async function saveCodexQuotaHistory(points: CodexQuotaPoint[]): Promise<void> {
  const path = historyPath()
  await mkdir(getCodeburnCacheDir(), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, JSON.stringify({ version: 1, points: points.slice(-MAX_POINTS) }) + '\n', 'utf8')
  await rename(temp, path)
}

export function selectCodexQuotaHistory(points: CodexQuotaPoint[], start: number, end: number): CodexQuotaPoint[] {
  const sorted = [...points].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
  const before = [...sorted].reverse().find(point => Date.parse(point.timestamp) < start)
  const after = sorted.find(point => Date.parse(point.timestamp) > end)
  return sorted.filter(point => {
    const at = Date.parse(point.timestamp)
    return at >= start && at <= end
  }).concat(before ? [before] : [], after ? [after] : []).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
}

export function appendCodexQuotaPoint(points: CodexQuotaPoint[], quota: QuotaProvider, capturedAt = Date.now()): CodexQuotaPoint[] {
  const primary = quota.primary
  if (quota.connection !== 'connected' || !primary) return points
  const remainingPercent = Math.round(Math.max(0, Math.min(1, 1 - primary.percent)) * 1000) / 10
  const timestamp = new Date(capturedAt).toISOString()
  const last = points[points.length - 1]
  const lastAt = last ? Date.parse(last.timestamp) : NaN
  if (last && Number.isFinite(lastAt) && capturedAt - lastAt < SAMPLE_INTERVAL_MS && last.remainingPercent === remainingPercent) return points
  const next = points.filter(point => point.timestamp !== timestamp)
  next.push({ timestamp, remainingPercent, label: primary.label, resetsAt: primary.resetsAt })
  next.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
  return next.slice(-MAX_POINTS)
}

export function codexQuotaPayload(quota: QuotaProvider, history: CodexQuotaPoint[], capturedAt = Date.now()) {
  const primary = quota.primary
  return {
    capturedAt: new Date(capturedAt).toISOString(),
    connection: quota.connection,
    planLabel: quota.planLabel,
    primary: primary
      ? {
          label: primary.label,
          usedPercent: Math.round(Math.max(0, Math.min(1, primary.percent)) * 1000) / 10,
          remainingPercent: Math.round(Math.max(0, Math.min(1, 1 - primary.percent)) * 1000) / 10,
          resetsAt: primary.resetsAt,
        }
      : null,
    history,
  }
}
