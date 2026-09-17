import { useEffect, useMemo, useState } from 'react'
import { Area, Bar, BarChart, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import { interpolateQuota } from '@/lib/quota-history'
import { computeQuotaSafeAverage } from '@/lib/quota-budget'
import type { CodexQuota, DailyEntry, DeviceUsage, GranularHistory } from '@/lib/api'
import { CHART_COLORS, chartColorForModel, cn, compactUsd, fmtTokens, label, usd } from '@/lib/utils'

export type Unit = 'cost' | 'tokens'

const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function fmtDay(d: string): string {
  const [, m, day] = String(d).split('-')
  return m && day ? `${Number(day)} ${MONTHS[Number(m)]}` : d
}

const TOP_N = 6
const MOVING_AVERAGE_POINTS = 10

type Series = { key: string; label: string; color: string }

function makeTooltip(labels: Record<string, string>, fmt: (n: number) => string, formatPeriod = fmtDay, totalKey?: string, totalValueKey?: string, quotaKeys: string[] = [], safeAverageKey?: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function ChartTooltip({ active, payload, label: lbl }: any) {
    if (!active || !payload?.length) return null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = payload.filter((p: any) => p.value > 0 && p.dataKey !== totalKey && !quotaKeys.includes(p.dataKey) && p.dataKey !== safeAverageKey).sort((a: any, b: any) => b.value - a.value)
    const quotaItems = payload.filter((p: any) => quotaKeys.includes(p.dataKey) && typeof p.value === 'number')
    const safeAverageItems = safeAverageKey ? payload.filter((p: any) => p.dataKey === safeAverageKey && typeof p.value === 'number') : []
    if (!items.length && !quotaItems.length && !safeAverageItems.length) return null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const totalItem = totalKey ? payload.find((p: any) => p.dataKey === totalKey) : undefined
    const total = totalValueKey && totalItem?.payload?.[totalValueKey] != null
      ? totalItem.payload[totalValueKey]
      : totalItem?.value ?? items.reduce((s: number, p: any) => s + p.value, 0)
    return (
      <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-xl ring-1 ring-border">
        <div className="mb-1.5 font-medium text-foreground">{formatPeriod(String(lbl))}</div>
        <div className="flex flex-col gap-1">
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          {items.slice(0, 6).map((p: any) => (
            <div key={p.dataKey} className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: p.color }} />
              <span
                className="flex-1 truncate text-tertiary-foreground"
                title={labels[String(p.dataKey)] ?? String(p.dataKey)}
              >
                {labels[String(p.dataKey)] ?? String(p.dataKey)}
              </span>
              <span className="tabular-nums text-muted-foreground">{fmt(p.value)}</span>
            </div>
          ))}
          {quotaItems.map((quotaItem: any) => (
            <div key={quotaItem.dataKey} className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: quotaItem.color }} />
              <span className="flex-1 truncate text-tertiary-foreground">{labels[quotaItem.dataKey]}</span>
              <span className="tabular-nums text-muted-foreground">{Number(quotaItem.value).toFixed(1)}%</span>
            </div>
          ))}
          {safeAverageItems.map((safeItem: any) => (
            <div key={safeItem.dataKey} className="flex items-center gap-2">
              <span className="h-0 w-2.5 shrink-0 border-t-2 border-dashed" style={{ borderColor: safeItem.color }} />
              <span className="flex-1 truncate text-tertiary-foreground">{labels[safeItem.dataKey]}</span>
              <span className="tabular-nums text-muted-foreground">{fmt(safeItem.value)} / bucket</span>
            </div>
          ))}
          <div className="mt-1 flex items-center justify-between border-t border-border pt-1 text-foreground">
            <span>Total</span>
            <span className="font-semibold tabular-nums">{fmt(total)}</span>
          </div>
        </div>
      </div>
    )
  }
}

export type Breakdown = 'sessions' | 'models'
const BREAKDOWN_STORAGE_KEY = 'codeburn-graph-breakdown'

export function loadGraphBreakdown(): Breakdown {
  try {
    const saved = localStorage.getItem(BREAKDOWN_STORAGE_KEY)
    return saved === 'models' ? 'models' : 'sessions'
  } catch {
    return 'sessions'
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function fmtTimelineTick(value: string, bucketMinutes: number): string {
  const d = new Date(value)
  if (!Number.isFinite(d.getTime())) return value
  if (bucketMinutes >= 1440) return `${d.getDate()} ${MONTHS[d.getMonth() + 1]}`
  if (bucketMinutes >= 60) return `${d.getDate()} ${MONTHS[d.getMonth() + 1]} ${pad2(d.getHours())}:00`
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function fmtTimelineTooltip(value: string, bucketMinutes: number): string {
  const d = new Date(value)
  if (!Number.isFinite(d.getTime())) return value
  const day = `${d.getDate()} ${MONTHS[d.getMonth() + 1]} ${d.getFullYear()}`
  if (bucketMinutes >= 1440) return day
  return `${day}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function formatResetAt(value: string): string {
  const d = new Date(value)
  if (!Number.isFinite(d.getTime())) return value
  return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function bucketLabel(bucketMinutes: number): string {
  if (bucketMinutes >= 1440) return 'Daily buckets'
  if (bucketMinutes >= 60) return 'Hourly buckets'
  return `${bucketMinutes}-minute buckets`
}

function fmtTimelineUsd(value: number | string): string {
  const number = Number(value)
  if (!Number.isFinite(number)) return '$0'
  const sign = number < 0 ? '-' : ''
  const amount = Math.abs(number)
  if (amount >= 100) return compactUsd(number)
  if (amount >= 10) return `${sign}$${amount.toFixed(0)}`
  if (amount >= 1) return `${sign}$${amount.toFixed(1)}`
  if (amount >= 0.01) return `${sign}$${amount.toFixed(2)}`
  if (amount > 0) return `${sign}$${amount.toFixed(3)}`
  return '$0'
}

function GranularLines({
  timeline,
  breakdown,
  unit,
  quota,
  safeTimeline,
}: {
  timeline: GranularHistory
  breakdown: Breakdown
  unit: Unit
  quota?: CodexQuota
  safeTimeline?: GranularHistory
}) {
  const { rows, series, labels, hasQuota, quotaSeries, safeAverage, safeAverageKey } = useMemo(() => {
    const metadata = breakdown === 'sessions' ? timeline.sessionSeries : timeline.modelSeries
    const totals = new Map<string, number>()
    for (const point of timeline.points) {
      const values = breakdown === 'sessions' ? point.sessions : point.models
      for (const value of values) {
        const amount = unit === 'tokens' ? value.tokens : value.cost
        totals.set(value.seriesId, (totals.get(value.seriesId) ?? 0) + amount)
      }
    }

    // The backend already folds its beyond-cap remainder into a "*_other"
    // series; never give it a top slot or it renders as a second "Other"
    // line next to our own display_other fold.
    const isBackendOther = (id: string) => id === 'session_other' || id === 'model_other'
    const top = [...totals.entries()]
      .filter(([id, total]) => total > 0 && !isBackendOther(id))
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_N)
      .map(([id]) => id)
    const topSet = new Set(top)
    const hasOther = [...totals.entries()].some(([id, total]) => total > 0 && !topSet.has(id))
    const keys = hasOther ? [...top, 'display_other'] : top
    const metadataById = new Map(metadata.map(item => [item.id, item.label]))
    const quotaHistory = [...(quota?.history ?? [])].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
    const accountNames = new Map<string, string>()
    for (const point of quotaHistory) {
      if (point.accountId && point.accountName) accountNames.set(point.accountId, point.accountName)
    }
    if (quota?.accountId && quota.accountName) accountNames.set(quota.accountId, quota.accountName)
    const quotaSeries = [...new Set(quotaHistory.map(point => point.accountId ?? null))].map((accountId, index) => ({
      accountId, key: `codex_remaining_${index}`,
      label: `Codex remaining · ${accountId ? accountNames.get(accountId) ?? accountId : 'Unknown account'}`,
      color: accountId === null ? '#94a3b8' : `hsl(${[...accountId].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0) % 360}, 75%, 65%)`,
    }))
    const rowData = timeline.points.map((point) => {
      const row: Record<string, number | string | null> = { period: point.timestamp }
      for (const key of keys) row[key] = 0
      const values = breakdown === 'sessions' ? point.sessions : point.models
      for (const value of values) {
        const key = topSet.has(value.seriesId) ? value.seriesId : 'display_other'
        if (!(key in row)) continue
        row[key] = (row[key] as number) + (unit === 'tokens' ? value.tokens : value.cost)
      }
      row.display_total = unit === 'tokens' ? point.tokens : point.cost
      if (quotaHistory.length) {
        for (const item of quotaSeries) row[item.key] = interpolateQuota(point.timestamp, quotaHistory, item.accountId)
      }
      return row
    })
    const safeAverage = computeQuotaSafeAverage(safeTimeline, quota, unit)
    const safeAverageKey = 'quota_safe_average'
    if (safeAverage) for (const row of rowData) row[safeAverageKey] = safeAverage.value
    rowData.forEach((row, index) => {
      const start = Math.max(0, index - MOVING_AVERAGE_POINTS + 1)
      const values = rowData.slice(start, index + 1).map(item => Number(item.display_total ?? 0))
      row.display_total_ma = values.reduce((sum, value) => sum + value, 0) / values.length
    })
    const chartSeries: Series[] = [...keys, 'display_total_ma'].map((key, index) => ({
      key,
      label: key === 'display_total_ma'
        ? unit === 'tokens' ? 'Total Tokens (10-bucket avg)' : 'Total Cost (10-bucket avg)'
        : key === 'display_other'
        ? 'Other'
        : breakdown === 'models'
          ? label(metadataById.get(key) ?? key)
          : metadataById.get(key) ?? key,
      color: key === 'display_total_ma'
        ? 'rgba(255, 255, 255, 0.45)'
        : breakdown === 'models'
        ? chartColorForModel(metadataById.get(key) ?? key, index)
        : CHART_COLORS[index % CHART_COLORS.length]!,
    }))
    // Trim LEADING zero-only buckets: the server zero-fills the whole range, so
    // a flat zero line before the first real value asserts spend that was never
    // recorded. Trimming by value needs no date comparison, so producer/viewer
    // timezone skew cannot drop a real first-day bucket, and an all-zero series
    // trims to nothing, landing in the established empty state. Idle buckets
    // after the first real value stay: those zeros are true.
    const firstValueIdx = rowData.findIndex(row =>
      chartSeries.some(item => Number(row[item.key] ?? 0) > 0),
    )
    const rows = firstValueIdx > 0 ? rowData.slice(firstValueIdx) : firstValueIdx === 0 ? rowData : []
    const tooltipLabels = Object.fromEntries(chartSeries.map(item => {
      if (breakdown !== 'sessions') return [item.key, item.label]
      // Duplicate session titles keep an id prefix in the legend for
      // disambiguation; the hover card can show the human-readable title.
      return [item.key, item.label.replace(/^[^ ]+ \([^)]*\) · /, '')]
    }))
    for (const item of quotaSeries) tooltipLabels[item.key] = item.label
    if (safeAverage) tooltipLabels[safeAverageKey] = `Safe usage until reset · Codex · ${formatResetAt(safeAverage.resetAt)}`
    return {
      rows,
      series: chartSeries,
      labels: tooltipLabels,
      quotaSeries,
      hasQuota: rows.some(row => quotaSeries.some(item => typeof row[item.key] === 'number')),
      safeAverage,
      safeAverageKey,
    }
  }, [timeline, breakdown, unit, quota, safeTimeline])

  if (series.length === 0) {
    return <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-tertiary-foreground">No timestamped usage in this period.</div>
  }

  const fmt = unit === 'tokens' ? fmtTokens : usd
  const axisFmt = (value: number | string) => (unit === 'tokens' ? fmtTokens(Number(value)) : fmtTimelineUsd(value))
  const Tip = makeTooltip(labels, fmt, value => fmtTimelineTooltip(value, timeline.bucketMinutes), 'display_total_ma', 'display_total', quotaSeries.map(item => item.key), safeAverageKey)
  const xTickInterval = Math.max(0, Math.ceil(rows.length / 12) - 1)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-2 pb-1 text-[10px] text-tertiary-foreground">
        {series.map(item => (
          <span key={item.key} className="flex min-w-0 items-center gap-1.5">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: item.color }} />
            <span className="max-w-80 truncate" title={item.label}>{item.label}</span>
          </span>
        ))}
        {hasQuota && quotaSeries.map(item => (
          <span key={item.key} className="flex min-w-0 items-center gap-1.5">
            <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: item.color }} />
            <span className="max-w-80 truncate" title={item.label}>{item.label}</span>
          </span>
        ))}
        {safeAverage && (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="h-0 w-2.5 shrink-0 border-t-2 border-dashed border-foreground/60" />
            <span className="max-w-80 truncate" title={labels[safeAverageKey]}>
              Safe usage until reset · Codex · {fmt(safeAverage.value)} / bucket · {formatResetAt(safeAverage.resetAt)}
            </span>
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: hasQuota ? 28 : 8, bottom: 0, left: -6 }}>
            <CartesianGrid vertical={false} strokeDasharray="2 2" stroke="var(--color-chart-grid-stroke)" />
            {hasQuota && quotaSeries.map(item => <Area key={item.key} type="stepAfter" dataKey={item.key} yAxisId="quota" baseValue={0} stroke="none" fill={item.color} fillOpacity={0.15} connectNulls={false} isAnimationActive={false} />)}
            <XAxis
              dataKey="period"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              interval={xTickInterval}
              minTickGap={36}
              tick={{ fontSize: 11, fill: 'var(--color-tertiary-foreground)' }}
              tickFormatter={(value) => fmtTimelineTick(String(value), timeline.bucketMinutes)}
            />
            <YAxis
              yAxisId="usage"
              tickLine={false}
              axisLine={false}
              width={50}
              tick={{ fontSize: 11, fill: 'var(--color-tertiary-foreground)' }}
              tickFormatter={axisFmt}
            />
            <Tooltip cursor={{ stroke: 'var(--color-chart-grid-stroke)' }} content={<Tip />} />
            {series.map(item => (
              <Line
                key={item.key}
                type="linear"
                dataKey={item.key}
                yAxisId="usage"
                stroke={item.color}
                strokeWidth={item.key === 'display_total_ma' ? 3 : 2}
                dot={false}
                activeDot={{ r: 3 }}
                isAnimationActive={false}
              />
            ))}
            {safeAverage && (
              <Line
                dataKey={safeAverageKey}
                yAxisId="usage"
                stroke="rgba(255, 255, 255, 0.75)"
                strokeWidth={2}
                strokeDasharray="6 4"
                dot={false}
                activeDot={false}
                isAnimationActive={false}
              />
            )}
            {hasQuota && (
              <YAxis
                yAxisId="quota"
                orientation="right"
                domain={[0, 100]}
                tickLine={false}
                axisLine={false}
                width={38}
                tick={{ fontSize: 11, fill: 'var(--color-tertiary-foreground)' }}
                tickFormatter={(value) => `${Number(value).toFixed(0)}%`}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function StackedBars({
  rows,
  series,
  labels,
  unit,
}: {
  rows: Array<Record<string, number | string>>
  series: Series[]
  labels: Record<string, string>
  unit: Unit
}) {
  const fmt = unit === 'tokens' ? fmtTokens : usd
  const axisFmt = (v: number | string) => (unit === 'tokens' ? fmtTokens(Number(v)) : compactUsd(Number(v)))
  const Tip = makeTooltip(labels, fmt)
  return (
    <div className="relative h-full w-full [&_.recharts-bar-rectangle]:transition-opacity [&_.recharts-bar-rectangle]:duration-75 [&:has(.recharts-bar-rectangle:hover)_.recharts-bar-rectangle:not(:hover)]:opacity-40">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -6 }} barCategoryGap="16%">
          <CartesianGrid vertical={false} strokeDasharray="2 2" stroke="var(--color-chart-grid-stroke)" />
          <XAxis
            dataKey="period"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            interval="equidistantPreserveStart"
            tick={{ fontSize: 11, fill: 'var(--color-tertiary-foreground)' }}
            tickFormatter={fmtDay}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={50}
            tick={{ fontSize: 11, fill: 'var(--color-tertiary-foreground)' }}
            tickFormatter={axisFmt}
          />
          <Tooltip cursor={{ fill: 'var(--chart-hover-cursor)' }} content={<Tip />} />
          {series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              stackId="a"
              fill={s.color}
              isAnimationActive={false}
              radius={i === series.length - 1 ? [3, 3, 0, 0] : undefined}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// Spend (or tokens) per day, stacked by model (single device).
export function UsageChart({ daily, unit = 'cost' }: { daily: DailyEntry[]; unit?: Unit }) {
  return <LegacyUsageChart daily={daily} unit={unit} />
}

function LegacyUsageChart({ daily, unit = 'cost' }: { daily: DailyEntry[]; unit?: Unit }) {
  const { rows, series, labels } = useMemo(() => {
    const measure = (m: { cost: number; inputTokens: number; outputTokens: number }) =>
      unit === 'tokens' ? m.inputTokens + m.outputTokens : m.cost
    const totals = new Map<string, number>()
    for (const d of daily) for (const m of d.topModels) totals.set(m.name, (totals.get(m.name) ?? 0) + measure(m))
    const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_N).map(([k]) => k)
    const topSet = new Set(top)
    const hasOther = [...totals.keys()].some((k) => !topSet.has(k))
    const keys = hasOther ? [...top, 'Other'] : top
    const rowData = daily.map((d) => {
      const row: Record<string, number | string> = { period: d.date }
      for (const k of keys) row[k] = 0
      for (const m of d.topModels) {
        const key = topSet.has(m.name) ? m.name : 'Other'
        row[key] = (row[key] as number) + measure(m)
      }
      return row
    })
    const series: Series[] = keys.map((k, i) => ({ key: k, label: label(k), color: CHART_COLORS[i % CHART_COLORS.length]! }))
    const labels = Object.fromEntries(series.map((s) => [s.key, s.label]))
    return { rows: rowData, series, labels }
  }, [daily, unit])

  return <StackedBars rows={rows} series={series} labels={labels} unit={unit} />
}

export function GranularUsageChart({
  daily,
  timeline,
  unit = 'cost',
  quota,
  safeTimeline,
  selectedBreakdown: controlledBreakdown,
  onBreakdownChange,
}: {
  daily: DailyEntry[]
  timeline?: GranularHistory
  unit?: Unit
  quota?: CodexQuota
  safeTimeline?: GranularHistory
  selectedBreakdown?: Breakdown
  onBreakdownChange?: (breakdown: Breakdown) => void
}) {
  const [selectedBreakdown, setSelectedBreakdown] = useState<Breakdown>(loadGraphBreakdown)
  useEffect(() => {
    if (controlledBreakdown !== undefined) return
    try {
      localStorage.setItem(BREAKDOWN_STORAGE_KEY, selectedBreakdown)
    } catch {
      // Storage can be disabled in embedded or private browser contexts.
    }
  }, [selectedBreakdown, controlledBreakdown])
  if (!timeline) return <LegacyUsageChart daily={daily} unit={unit} />

  const hasSessions = timeline.sessionSeries.length > 0
  const hasModels = timeline.modelSeries.length > 0
  const requestedBreakdown = controlledBreakdown ?? selectedBreakdown
  const breakdown = requestedBreakdown === 'sessions' && !hasSessions && hasModels ? 'models' : requestedBreakdown
  const selectBreakdown = (next: Breakdown) => {
    onBreakdownChange?.(next)
    if (!controlledBreakdown) setSelectedBreakdown(next)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 px-2 pb-1">
        <span className="text-[10px] font-medium uppercase tracking-[0.1em] text-tertiary-foreground">
          {bucketLabel(timeline.bucketMinutes)}
        </span>
        <div className="flex rounded-md border border-border bg-interactive-secondary p-0.5">
          {(['sessions', 'models'] as Breakdown[]).map(option => {
            const available = option === 'sessions' ? hasSessions : hasModels
            return (
              <button
                key={option}
                type="button"
                disabled={!available}
                onClick={() => selectBreakdown(option)}
                className={cn(
                  'rounded-[4px] px-2 py-0.5 text-[10px] font-medium capitalize transition-colors',
                  breakdown === option ? 'bg-card text-foreground shadow-sm' : 'text-tertiary-foreground hover:text-foreground',
                  !available && 'cursor-not-allowed opacity-40',
                )}
              >
                {option}
              </button>
            )
          })}
        </div>
      </div>
      <GranularLines timeline={timeline} breakdown={breakdown} unit={unit} quota={quota} safeTimeline={safeTimeline} />
    </div>
  )
}

// Spend (or tokens) per day, stacked by device (one color per device) for the All view.
export function DeviceUsageChart({ devices, unit = 'cost' }: { devices: DeviceUsage[]; unit?: Unit }) {
  const { rows, series, labels } = useMemo(() => {
    const named = devices.filter((d) => d.payload)
    const dailyOf = (d: DeviceUsage) => d.payload?.history?.daily ?? []
    // Stable key + color per device (by unique id) so a device keeps its color
    // and its bars don't remount when another device drops/returns between
    // polls, and two devices sharing a hostname never collide.
    const keyOf = (d: DeviceUsage) => 'dev_' + d.id.replace(/[^a-zA-Z0-9]/g, '_')
    const colorOf = (id: string) => {
      let h = 0
      for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
      return CHART_COLORS[Math.abs(h) % CHART_COLORS.length]!
    }
    const dates = [...new Set(named.flatMap((d) => dailyOf(d).map((e) => e.date)))].sort((a, b) => a.localeCompare(b))
    const series: Series[] = named.map((d) => ({
      key: keyOf(d),
      label: d.name + (d.local ? ' (this Mac)' : ''),
      color: colorOf(d.id),
    }))
    const rowData = dates.map((date) => {
      const row: Record<string, number | string> = { period: date }
      named.forEach((d) => {
        const e = dailyOf(d).find((x) => x.date === date)
        row[keyOf(d)] = e ? (unit === 'tokens' ? e.inputTokens + e.outputTokens : e.cost) : 0
      })
      return row
    })
    const labels = Object.fromEntries(series.map((s) => [s.key, s.label]))
    return { rows: rowData, series, labels }
  }, [devices, unit])

  return <StackedBars rows={rows} series={series} labels={labels} unit={unit} />
}
