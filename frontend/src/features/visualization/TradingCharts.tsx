/**
 * AI Signals terminal
 *
 * The command bar carries the universe filters and search, a dense signal
 * queue runs down the left, and the analysis workspace pairs the TradingView
 * chart with a live signal snapshot before the tabbed detail.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
    Activity,
    AlertTriangle,
    BarChart2,
    ChevronLeft,
    Clock,
    Globe2,
    Info,
    Minus,
    RefreshCw,
    Search,
    Shield,
    ShieldCheck,
    Target,
    TrendingDown,
    TrendingUp,
    X,
    Zap,
} from 'lucide-react'
import { api } from '../../shared/api/client'
import { TradingViewAssetChart } from '@/features/ai-signals/TradingViewAssetChart'

// ── Types ─────────────────────────────────────────────────────────────────────

interface TradeSetup {
    current_price: number
    entry_price: number
    stop_loss: number
    target_price: number
    risk_reward: number
    atr_pct: number
    max_position_pct: number
}

interface Reliability {
    historical_accuracy: number
    win_rate: number
    sharpe_ratio: number
    max_drawdown: number
    basis?: string
}

interface ReasoningStep {
    step: number
    label: string
    description: string
    evidence: string
    phase: string
    metric?: string
}

interface SignalExplainability {
    priced: boolean
    price: number
    change_pct: number
    movement_available: boolean
    change_source: 'provider' | 'unavailable'
    threshold_pct: number
    movement_score: number
    movement_clamped: boolean
    movement_weight: number
    movement_term: number
    event: {
        matched: boolean
        applied: boolean
        title: string | null
        category: string | null
        severity: number
        rule_action: string | null
        rule_confidence: number
        event_score: number
        weight: number
        term: number
    }
    raw_score: number
    action_cutoff: number
    confidence_base: number
    confidence_cap: number
    hold_cap: number
    freshness: number
    confidence: number
    buy_trigger_pct: number | null
    sell_trigger_pct: number | null
    volatility_label: string
    atr_pct: number
    data_status: string
    data_source: string
    quote_timestamp: string
    basis: string
}

interface TimelineEntry {
    ts: string
    label: string
    detail: string
    phase: string
}

interface Signal {
    symbol: string
    label: string
    asset_class: string
    category: string
    sector: string
    region: string
    description: string
    geo_sensitivity: string[]
    action: 'BUY' | 'SELL' | 'HOLD'
    confidence_pct: number
    uncertainty_pct: number
    time_horizon: string
    bullish_strength: number
    bearish_strength: number
    volatility_label: string
    vol_spike_prob: number
    trade_setup: TradeSetup
    reliability: Reliability
    triggering_event: { id: string; title: string; category: string; severity: number; ts: string }
    reasoning_summary: string
    reasoning_chain: ReasoningStep[]
    explainability?: SignalExplainability | null
    event_timeline: TimelineEntry[]
    related_assets: string[]
    generated_at: string
    price?: number | null
    live_change_pct?: number | null
    quote_timestamp?: string
    data_status?: string
    data_source?: string
    actionable?: boolean
}

const CATEGORY_TO_ASSET_CLASS: Record<string, string> = {
    'Commodities': 'commodity',
    'Equity Indices': 'equity_index',
    'Forex': 'forex',
    'Crypto': 'crypto',
    'Stocks': 'stock',
    'ETFs': 'etf',
    'Bonds': 'bond',
}

const CATEGORIES = ['All', 'Commodities', 'Equity Indices', 'Forex', 'Crypto', 'Stocks', 'ETFs', 'Bonds']
const ACTIONS = ['All', 'BUY', 'SELL', 'HOLD']
const GEO_TAGS = [
    'military_escalation',
    'energy_supply_disruption',
    'trade_restrictions',
    'sanctions',
    'political_instability',
]

const DETAIL_TABS = [
    { id: 'setup', label: 'Trade Setup', shortLabel: 'Setup', icon: Target },
    { id: 'reasoning', label: 'AI Reasoning', shortLabel: 'Reason', icon: Zap },
    { id: 'timeline', label: 'Timeline', shortLabel: 'Timeline', icon: Clock },
    { id: 'reliability', label: 'Reliability', shortLabel: 'Reliability', icon: Shield },
] as const

type DetailTab = (typeof DETAIL_TABS)[number]['id']
type Tone = 'neutral' | 'accent' | 'positive' | 'negative' | 'warning' | 'info'

// ── Utility helpers ───────────────────────────────────────────────────────────

function formatPrice(p: number): string {
    if (!Number.isFinite(p) || p <= 0) return 'Unavailable'
    if (p >= 10000) return p.toLocaleString('en-US', { maximumFractionDigits: 0 })
    if (p >= 100) return p.toFixed(2)
    if (p >= 1) return p.toFixed(4)
    return p.toFixed(6)
}

function formatPct(v: number): string { return `${(v * 100).toFixed(1)}%` }

function formatTs(iso: string): string {
    const d = new Date(iso)
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function actionClass(action: string) {
    if (action === 'BUY') return 'border-emerald-500/35 bg-emerald-500/12 text-emerald-300'
    if (action === 'SELL') return 'border-red-500/35 bg-red-500/12 text-red-300'
    return 'border-amber-500/35 bg-amber-500/12 text-amber-300'
}

function actionAccent(action: string) {
    if (action === 'BUY') return 'bg-emerald-400'
    if (action === 'SELL') return 'bg-red-400'
    return 'bg-amber-400'
}

function directionActiveClass(action: string) {
    if (action === 'BUY') return 'border-emerald-500/40 bg-emerald-500/12 text-emerald-200'
    if (action === 'SELL') return 'border-red-500/40 bg-red-500/12 text-red-200'
    if (action === 'HOLD') return 'border-amber-500/40 bg-amber-500/12 text-amber-200'
    return 'border-[#a855f7]/40 bg-[#a855f7]/14 text-white'
}

function volTone(label: string): Tone {
    if (label === 'LOW') return 'positive'
    if (label === 'MEDIUM') return 'warning'
    if (label === 'HIGH') return 'warning'
    return 'negative'
}

function statusTone(status?: string): Tone {
    const value = (status || 'unavailable').toLowerCase()
    if (value === 'live' || value === 'realtime' || value === 'real-time') return 'positive'
    if (value === 'delayed' || value === 'stale') return 'warning'
    return 'neutral'
}

function statusDot(status?: string) {
    const tone = statusTone(status)
    if (tone === 'positive') return 'bg-emerald-400'
    if (tone === 'warning') return 'bg-amber-400'
    return 'bg-white/30'
}

function phaseColor(phase: string) {
    const m: Record<string, string> = {
        event: 'border-red-500 bg-red-500/20 text-red-300',
        nlp: 'border-purple-500 bg-purple-500/20 text-purple-300',
        signal: 'border-white/30 bg-white/10 text-white',
        reaction: 'border-emerald-500 bg-emerald-500/20 text-emerald-300',
        economic_impact: 'border-orange-500 bg-orange-500/20 text-orange-300',
        mechanism: 'border-white/30 bg-white/10 text-white/70',
        movement: 'border-teal-500 bg-teal-500/20 text-teal-300',
    }
    return m[phase] ?? 'border-gray-600 bg-gray-500/20 text-gray-300'
}

function phaseDot(phase: string) {
    const m: Record<string, string> = {
        event: 'bg-red-400',
        nlp: 'bg-purple-400',
        signal: 'bg-slate-300',
        reaction: 'bg-emerald-400',
        economic_impact: 'bg-amber-400',
        mechanism: 'bg-slate-400',
        movement: 'bg-teal-400',
    }
    return m[phase] ?? 'bg-slate-500'
}

// ── Shared presentational pieces ──────────────────────────────────────────────

const TONE_CLASS: Record<Tone, string> = {
    neutral: 'border-white/10 bg-white/[0.04] text-white/55',
    accent: 'border-[#a855f7]/30 bg-[#a855f7]/10 text-[#d8b4fe]',
    positive: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    negative: 'border-red-500/30 bg-red-500/10 text-red-300',
    warning: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
    info: 'border-cyan-500/25 bg-cyan-500/10 text-cyan-300',
}

const TONE_TEXT: Record<Tone, string> = {
    neutral: 'text-white/70',
    accent: 'text-[#d8b4fe]',
    positive: 'text-emerald-300',
    negative: 'text-red-300',
    warning: 'text-amber-300',
    info: 'text-cyan-300',
}

function Chip({
    children,
    tone = 'neutral',
    className = '',
}: {
    children: ReactNode
    tone?: Tone
    className?: string
}) {
    return (
        <span
            className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[9px] leading-4 tracking-wide ${TONE_CLASS[tone]} ${className}`}
        >
            {children}
        </span>
    )
}

function SectionLabel({ text, className = '' }: { text: string; className?: string }) {
    return (
        <div
            className={`flex items-center gap-2 font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-white/40 ${className}`}
        >
            <span className="h-2.5 w-[2px] shrink-0 rounded-full bg-[#a855f7]/55" aria-hidden="true" />
            <span className="truncate">{text}</span>
        </div>
    )
}

function MetricTile({
    label,
    value,
    sub,
    tone = 'text-white',
}: {
    label: string
    value: string
    sub?: string
    tone?: string
}) {
    return (
        <div className="flex min-h-[74px] flex-col justify-center rounded-lg border border-white/8 bg-white/[0.025] px-3 py-2.5">
            <div className="font-mono text-[8.5px] uppercase leading-snug tracking-[0.12em] text-white/35">
                {label}
            </div>
            <div
                className={`mt-1.5 truncate font-mono text-[17px] font-bold leading-none tabular-nums ${tone}`}
            >
                {value}
            </div>
            {sub && (
                <div className="mt-1.5 truncate font-mono text-[8px] tracking-wide text-white/25">{sub}</div>
            )}
        </div>
    )
}

function DirectionIcon({ action }: { action: string }) {
    if (action === 'BUY') return <TrendingUp className="h-3.5 w-3.5 shrink-0" />
    if (action === 'SELL') return <TrendingDown className="h-3.5 w-3.5 shrink-0" />
    if (action === 'HOLD') return <Minus className="h-3.5 w-3.5 shrink-0" />
    return <BarChart2 className="h-3.5 w-3.5 shrink-0" />
}

// ── Signal queue row ──────────────────────────────────────────────────────────

function SignalRow({
    signal,
    selected,
    onClick,
}: {
    signal: Signal
    selected: boolean
    onClick: () => void
}) {
    const change = signal.live_change_pct ?? null
    const up = (change ?? 0) >= 0
    const bull = signal.bullish_strength * 100
    const bear = signal.bearish_strength * 100
    const eventTitle = signal.triggering_event?.title ?? ''
    const hasVerifiedEvent = eventTitle.length > 0 && !/no verified event/i.test(eventTitle)

    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={selected}
            aria-label={`${signal.symbol} ${signal.action} signal, ${signal.confidence_pct.toFixed(0)} percent confidence`}
            className={`group relative w-full border-b border-white/[0.05] px-4 py-3 text-left transition-colors ${
                selected ? 'bg-[#a855f7]/[0.09]' : 'hover:bg-white/[0.03]'
            }`}
            style={{ minHeight: 'unset' }}
        >
            <span
                className={`absolute left-0 top-0 h-full w-[2px] ${actionAccent(signal.action)} ${
                    selected ? 'opacity-100' : 'opacity-40 group-hover:opacity-70'
                }`}
            />

            <div className="flex items-baseline gap-2">
                <span className="font-mono text-[13.5px] font-bold tracking-tight text-white">
                    {signal.symbol}
                </span>
                <span
                    className={`shrink-0 rounded border px-1.5 py-px font-mono text-[8px] font-bold tracking-[0.08em] ${actionClass(signal.action)}`}
                >
                    {signal.action}
                </span>
                <span className="ml-auto font-mono text-[15px] font-bold leading-none tabular-nums text-white">
                    {signal.confidence_pct.toFixed(0)}
                    <span className="text-[9px] font-medium text-white/40">%</span>
                </span>
            </div>

            <div className="mt-1 flex min-w-0 items-center gap-1.5">
                <span className="truncate text-[10.5px] text-white/45">{signal.label}</span>
                {hasVerifiedEvent && (
                    <Zap
                        className="h-3 w-3 shrink-0 text-amber-400/70"
                        aria-label="Linked to a verified event"
                    />
                )}
            </div>

            <div className="mt-1.5 flex items-center gap-2">
                <div
                    className="relative h-1 flex-1 overflow-hidden rounded-full bg-white/[0.06]"
                    role="img"
                    aria-label={`Bullish ${bull.toFixed(0)} percent, bearish ${bear.toFixed(0)} percent`}
                >
                    <div
                        className="absolute inset-y-0 left-0 bg-emerald-400/80"
                        style={{ width: `${bull}%` }}
                    />
                    <div className="absolute inset-y-0 right-0 bg-red-400/80" style={{ width: `${bear}%` }} />
                </div>
                <span className="shrink-0 font-mono text-[9px] tabular-nums text-white/30">
                    R:R {signal.trade_setup.risk_reward.toFixed(1)}
                </span>
            </div>

            <div className="mt-1.5 flex items-center gap-2 font-mono text-[10px] tabular-nums">
                <span className="text-white/60">{formatPrice(signal.trade_setup.current_price)}</span>
                <span className="text-white/15">·</span>
                <span className={TONE_TEXT[volTone(signal.volatility_label)]}>
                    VOL {signal.volatility_label}
                </span>
                <span
                    className={`ml-auto flex items-center gap-1 ${
                        change === null ? 'text-white/30' : up ? 'text-emerald-400' : 'text-red-400'
                    }`}
                >
                    {change === null
                        ? 'No movement data'
                        : `${up ? '+' : ''}${change.toFixed(2)}%`}
                </span>
                <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDot(signal.data_status)}`}
                    title={`Data: ${(signal.data_status || 'unavailable').toUpperCase()}`}
                />
            </div>
        </button>
    )
}

// ── Signal snapshot panel ─────────────────────────────────────────────────────

function SignalSnapshot({ signal }: { signal: Signal }) {
    const eventTitle = signal.triggering_event?.title ?? ''
    // The API marks unlinked signals with a placeholder title rather than null.
    const hasVerifiedEvent = eventTitle.length > 0 && !/no verified event/i.test(eventTitle)
    const event = hasVerifiedEvent ? signal.triggering_event : null
    const geoTags = signal.geo_sensitivity ?? []
    const bull = signal.bullish_strength * 100
    const bear = signal.bearish_strength * 100

    const rows: Array<{ label: string; value: string; tone: Tone }> = [
        {
            label: 'Volatility',
            value: signal.volatility_label,
            tone: volTone(signal.volatility_label),
        },
        { label: 'Time horizon', value: signal.time_horizon, tone: 'neutral' },
        { label: 'Vol spike', value: formatPct(signal.vol_spike_prob), tone: 'neutral' },
        { label: 'Sector', value: signal.sector.replace(/_/g, ' '), tone: 'neutral' },
        { label: 'Region', value: signal.region.replace(/_/g, ' '), tone: 'neutral' },
        {
            label: 'Data',
            value: `${(signal.data_status || 'unavailable').toUpperCase()} · ${signal.data_source || 'unknown'}`,
            tone: statusTone(signal.data_status),
        },
    ]

    return (
        <section
            className="flex flex-col rounded-xl border border-white/10 bg-[#07091a]/55 p-4"
            aria-label="Signal snapshot"
        >
            <div className="flex items-center justify-between gap-2">
                <SectionLabel text="Signal Snapshot" />
                <span className="truncate font-mono text-[9px] uppercase tracking-[0.1em] text-white/25">
                    {signal.category}
                </span>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-4">
                <div>
                    <div className="font-mono text-[8.5px] uppercase tracking-[0.14em] text-emerald-300/60">
                        Bullish strength
                    </div>
                    <div className="mt-1 font-mono text-xl font-bold leading-none tabular-nums text-emerald-300">
                        {bull.toFixed(0)}
                        <span className="text-[10px] font-medium text-emerald-300/50">%</span>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                        <div
                            className="h-full rounded-full bg-gradient-to-r from-emerald-600 to-emerald-400"
                            style={{ width: `${bull}%` }}
                        />
                    </div>
                </div>
                <div className="text-right">
                    <div className="font-mono text-[8.5px] uppercase tracking-[0.14em] text-red-300/60">
                        Bearish strength
                    </div>
                    <div className="mt-1 font-mono text-xl font-bold leading-none tabular-nums text-red-300">
                        {bear.toFixed(0)}
                        <span className="text-[10px] font-medium text-red-300/50">%</span>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                        <div
                            className="ml-auto h-full rounded-full bg-gradient-to-l from-red-600 to-red-400"
                            style={{ width: `${bear}%` }}
                        />
                    </div>
                </div>
            </div>

            <dl className="mt-3.5 divide-y divide-white/[0.05] border-t border-white/8 pt-1">
                {rows.map(row => (
                    <div key={row.label} className="flex items-center justify-between gap-3 py-2">
                        <dt className="shrink-0 font-mono text-[9px] uppercase tracking-[0.1em] text-white/30">
                            {row.label}
                        </dt>
                        <dd
                            className={`truncate text-right font-mono text-[11px] tabular-nums capitalize ${TONE_TEXT[row.tone]}`}
                            title={row.value}
                        >
                            {row.value}
                        </dd>
                    </div>
                ))}
            </dl>

            {geoTags.length > 0 && (
                <div className="mt-2.5">
                    <SectionLabel text="Geo sensitivity" />
                    <div className="mt-1.5 flex flex-wrap gap-1">
                        {geoTags.map(tag => (
                            <Chip key={tag} tone="accent">
                                {tag.replace(/_/g, ' ')}
                            </Chip>
                        ))}
                    </div>
                </div>
            )}

            <div className="mt-auto pt-3">
                {event ? (
                    <div className="flex items-start gap-2.5 rounded-lg border border-red-500/20 bg-red-500/[0.06] px-3 py-2.5">
                        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-red-500/25 bg-red-500/10">
                            <AlertTriangle className="h-3 w-3 text-red-400" />
                        </span>
                        <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                                <span className="font-mono text-[8px] uppercase tracking-[0.16em] text-red-400/80">
                                    Triggering Event
                                </span>
                                <span className="font-mono text-[9px] text-white/35">
                                    {formatPct(event.severity)}
                                </span>
                            </div>
                            <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-white/80">
                                {event.title}
                            </div>
                            <div className="mt-0.5 font-mono text-[9px] capitalize text-white/30">
                                {event.category.replace(/_/g, ' ')} · {formatTs(event.ts)}
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="flex items-center gap-2.5 rounded-lg border border-dashed border-white/12 bg-white/[0.02] px-3 py-2.5">
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/[0.03]">
                            <ShieldCheck className="h-3 w-3 text-white/40" />
                        </span>
                        <div className="min-w-0">
                            <div className="text-[11px] text-white/55">No verified triggering event</div>
                            <div className="font-mono text-[9px] leading-snug text-white/30">
                                Not linked to a verified geopolitical event right now.
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </section>
    )
}

// ── AI reasoning tab ──────────────────────────────────────────────────────────

function signed(value: number, digits = 2): string {
    if (!Number.isFinite(value)) return '—'
    const rendered = value.toFixed(digits)
    return value > 0 && Number(rendered) !== 0 ? `+${rendered}` : rendered
}

function scoreTextTone(score: number, cutoff: number): string {
    if (score >= cutoff) return 'text-emerald-300'
    if (score <= -cutoff) return 'text-red-300'
    return 'text-amber-300'
}

function scoreBarTone(score: number, cutoff: number): string {
    if (score >= cutoff) return 'bg-emerald-400/75'
    if (score <= -cutoff) return 'bg-red-400/75'
    return 'bg-amber-400/75'
}

function formatWhen(iso?: string): string {
    if (!iso) return 'unavailable'
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return iso
    return date.toLocaleString('en-US', {
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    })
}

function stepMetricClass(step: ReasoningStep): string {
    const metric = step.metric ?? ''
    if (metric.startsWith('BUY')) return 'border-emerald-500/35 bg-emerald-500/12 text-emerald-300'
    if (metric.startsWith('SELL')) return 'border-red-500/35 bg-red-500/12 text-red-300'
    if (metric.startsWith('HOLD')) return 'border-amber-500/35 bg-amber-500/12 text-amber-300'
    const value = Number.parseFloat(metric)
    if (!Number.isFinite(value) || value === 0) return 'border-white/12 bg-white/[0.04] text-white/50'
    return value > 0
        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
        : 'border-red-500/30 bg-red-500/10 text-red-300'
}

function ScoreScale({ score, cutoff }: { score: number; cutoff: number }) {
    const clamped = Math.max(-1, Math.min(1, score))
    const position = ((clamped + 1) / 2) * 100
    const edge = ((1 - cutoff) / 2) * 100
    const band = cutoff * 100

    return (
        <div className="mt-3">
            <div className="relative">
                <div className="flex h-2.5 overflow-hidden rounded-full ring-1 ring-inset ring-white/10">
                    <div className="bg-red-500/40" style={{ width: `${edge}%` }} />
                    <div className="bg-amber-500/30" style={{ width: `${band}%` }} />
                    <div className="bg-emerald-500/40" style={{ width: `${edge}%` }} />
                </div>
                <div
                    className="pointer-events-none absolute inset-y-0 w-px bg-white/25"
                    style={{ left: `${edge}%` }}
                />
                <div
                    className="pointer-events-none absolute inset-y-0 w-px bg-white/25"
                    style={{ left: `${edge + band}%` }}
                />
                <div
                    className="absolute -bottom-1 -top-1 -translate-x-1/2"
                    style={{ left: `${position}%` }}
                >
                    <div
                        className={`h-full w-[3px] rounded-full ${scoreBarTone(score, cutoff)}`}
                    />
                </div>
            </div>
            <div className="relative mt-1.5 h-3 font-mono text-[8.5px] text-white/30">
                <span className="absolute left-0">−1.00</span>
                <span className="absolute -translate-x-1/2" style={{ left: `${edge}%` }}>
                    −{cutoff.toFixed(2)}
                </span>
                <span className="absolute -translate-x-1/2 text-white/45" style={{ left: '50%' }}>
                    0
                </span>
                <span className="absolute -translate-x-1/2" style={{ left: `${edge + band}%` }}>
                    +{cutoff.toFixed(2)}
                </span>
                <span className="absolute right-0">+1.00</span>
            </div>
        </div>
    )
}

function MathRow({
    label,
    weight,
    value,
    formula,
    tone,
    bar,
    magnitude,
    emphasis = false,
}: {
    label: string
    weight?: number
    value: string
    formula: string
    tone: string
    bar: string
    magnitude: number
    emphasis?: boolean
}) {
    return (
        <div className="py-2.5">
            <div className="flex items-baseline justify-between gap-3">
                <div className="flex min-w-0 items-baseline gap-2">
                    <span
                        className={`text-[11px] font-semibold ${emphasis ? 'text-white' : 'text-white/75'}`}
                    >
                        {label}
                    </span>
                    {weight !== undefined && (
                        <span className="font-mono text-[8px] uppercase tracking-[0.1em] text-white/25">
                            wt {Math.round(weight * 100)}%
                        </span>
                    )}
                </div>
                <span className={`shrink-0 font-mono text-[14px] font-bold ${tone}`}>{value}</span>
            </div>
            <div
                className={`mt-1.5 overflow-hidden rounded-full bg-white/[0.05] ${emphasis ? 'h-1.5' : 'h-1'}`}
            >
                <div
                    className={`h-full rounded-full ${bar}`}
                    style={{ width: `${Math.min(100, Math.abs(magnitude) * 100)}%` }}
                />
            </div>
            <p className="mt-1.5 font-mono text-[9px] leading-relaxed text-white/35">{formula}</p>
        </div>
    )
}

function FlipLevel({
    action,
    level,
    change,
}: {
    action: 'BUY' | 'SELL'
    level: number | null
    change: number
}) {
    const buy = action === 'BUY'
    const distance = level === null ? null : Math.abs(level - change)

    return (
        <div
            className={`rounded-lg border px-3 py-2.5 ${
                buy ? 'border-emerald-500/20 bg-emerald-500/[0.05]' : 'border-red-500/20 bg-red-500/[0.05]'
            }`}
        >
            <div className="flex items-center gap-1 font-mono text-[8px] uppercase tracking-[0.12em] text-white/35">
                {buy ? (
                    <TrendingUp className="h-3 w-3 text-emerald-400/70" />
                ) : (
                    <TrendingDown className="h-3 w-3 text-red-400/70" />
                )}
                To {action}
            </div>
            <div
                className={`mt-1 font-mono text-[17px] font-bold leading-none ${
                    buy ? 'text-emerald-300' : 'text-red-300'
                }`}
            >
                {level === null ? '—' : `${signed(level)}%`}
            </div>
            <div className="mt-1.5 font-mono text-[8.5px] leading-relaxed text-white/30">
                {distance === null
                    ? 'Needs more than the full ±1.00 movement cap'
                    : `${distance.toFixed(2)}pp from the current ${signed(change)}%`}
            </div>
        </div>
    )
}

function ReasoningTab({ signal, ex }: { signal: Signal; ex: SignalExplainability | null }) {
    const chain = signal.reasoning_chain
    const cutoff = ex?.action_cutoff ?? 0.35
    const confidencePct = ex ? ex.confidence * 100 : signal.confidence_pct
    const dataSource = ex?.data_source ?? signal.data_source ?? 'unknown'
    const dataStatus = ex?.data_status ?? signal.data_status ?? 'unavailable'
    const quoteTimestamp = ex?.quote_timestamp ?? signal.quote_timestamp ?? signal.generated_at

    let eventFormula = 'No verified event matched in the last 48 hours · weight 0%'
    if (ex?.event.applied) {
        const category = (ex.event.category ?? '').replace(/_/g, ' ')
        eventFormula =
            ex.event.rule_action === 'HOLD'
                ? `${category} rule reads HOLD · reweights movement, no directional push`
                : `${category} rule ${ex.event.rule_action} · ${Math.round(ex.event.rule_confidence * 100)}% conviction × ${Math.round(ex.event.severity * 100)}% severity = ${signed(ex.event.event_score, 3)} × ${Math.round(ex.event.weight * 100)}% weight`
    } else if (ex?.event.matched) {
        eventFormula = `Event matched (${formatPct(ex.event.severity)} severity) but no rule exists for ${signal.symbol} · weight 0%`
    }

    let confidenceFormula = `${Math.round(confidencePct)}%`
    if (ex) {
        const product = ex.confidence_base * ex.freshness
        confidenceFormula = `(${ex.confidence_base.toFixed(3)} base) × ${ex.freshness.toFixed(2)} freshness = ${product.toFixed(3)}`
        if (ex.confidence < product - 0.0005) {
            confidenceFormula +=
                signal.action === 'HOLD'
                    ? ` → HOLD cap ${(ex.hold_cap * ex.freshness).toFixed(3)}`
                    : ` → capped at ${ex.confidence_cap.toFixed(2)}`
        }
    }

    return (
        <div className="space-y-3.5">
            {/* Decision verdict */}
            <section className="rounded-xl border border-white/10 bg-white/[0.025] p-3.5 sm:p-4">
                <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
                    <div className="min-w-0">
                        <SectionLabel text="Decision" />
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            <span
                                className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[12px] font-bold tracking-wide ${actionClass(signal.action)}`}
                            >
                                <DirectionIcon action={signal.action} />
                                {signal.action}
                            </span>
                            <Chip tone="accent">
                                <ShieldCheck className="h-3 w-3" />
                                {Math.round(confidencePct)}% confidence
                            </Chip>
                            <Chip tone={statusTone(dataStatus)}>
                                <span className={`h-1.5 w-1.5 rounded-full ${statusDot(dataStatus)}`} />
                                {dataStatus}
                            </Chip>
                            {ex && !ex.movement_available && (
                                <Chip tone="warning">
                                    <AlertTriangle className="h-3 w-3" />
                                    movement not published
                                </Chip>
                            )}
                            {ex && <Chip tone="neutral">freshness ×{ex.freshness.toFixed(2)}</Chip>}
                        </div>
                    </div>
                    {ex && (
                        <div className="shrink-0 text-right">
                            <SectionLabel text="Blended score" className="justify-end" />
                            <div
                                className={`mt-1 font-mono text-[28px] font-bold leading-none ${scoreTextTone(ex.raw_score, cutoff)}`}
                            >
                                {signed(ex.raw_score)}
                                <span className="ml-1.5 text-[10px] font-medium text-white/25">
                                    of ±1.00
                                </span>
                            </div>
                        </div>
                    )}
                </div>

                {ex?.priced && <ScoreScale score={ex.raw_score} cutoff={cutoff} />}

                {ex && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[8px] uppercase tracking-[0.12em] text-white/25">
                        <span>SELL ≤ −{cutoff.toFixed(2)}</span>
                        <span>HOLD ±{cutoff.toFixed(2)}</span>
                        <span>BUY ≥ +{cutoff.toFixed(2)}</span>
                        <span className="text-white/15">·</span>
                        <span>
                            weights movement {Math.round(ex.movement_weight * 100)}% / event{' '}
                            {Math.round(ex.event.weight * 100)}%
                        </span>
                    </div>
                )}

                <p className="mt-3 max-w-[100ch] text-[12px] leading-relaxed text-white/70">
                    {signal.reasoning_summary}
                </p>

                {ex && !ex.priced && (
                    <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2.5">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                        <p className="text-[10.5px] leading-relaxed text-amber-200/70">
                            No usable quote for {signal.label} (last attempt {formatWhen(quoteTimestamp)}).
                            The model holds at zero confidence and publishes no flip levels until a
                            price arrives.
                        </p>
                    </div>
                )}
            </section>

            <div className="grid gap-3.5 xl:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)] xl:items-start">
                {/* Reasoning chain */}
                <section className="rounded-xl border border-white/8 bg-white/[0.02] p-3.5 sm:p-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                        <SectionLabel text="Reasoning Chain" />
                        <span className="font-mono text-[8px] uppercase tracking-[0.1em] text-white/25">
                            same computation as the call
                        </span>
                    </div>
                    <div className="mt-3">
                        {chain.map((step, i) => (
                            <div key={`${step.step}-${step.label}`} className="flex gap-3">
                                <div className="flex flex-col items-center">
                                    <div
                                        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border font-mono text-[10px] font-bold ${phaseColor(step.phase)}`}
                                    >
                                        {step.step}
                                    </div>
                                    {i < chain.length - 1 && (
                                        <div className="my-1 w-px flex-1 bg-white/10" />
                                    )}
                                </div>
                                <div className="mb-2.5 min-w-0 flex-1 rounded-lg border border-white/8 bg-white/[0.02] p-3">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <div className="flex min-w-0 items-center gap-2">
                                            <span className="text-[11px] font-semibold text-white/85">
                                                {step.label}
                                            </span>
                                            <span className="font-mono text-[8px] uppercase tracking-[0.1em] text-white/25">
                                                {step.phase.replace(/_/g, ' ')}
                                            </span>
                                        </div>
                                        {step.metric && (
                                            <span
                                                className={`shrink-0 rounded-md border px-1.5 py-0.5 font-mono text-[9px] font-bold ${stepMetricClass(step)}`}
                                            >
                                                {step.metric}
                                            </span>
                                        )}
                                    </div>
                                    <p className="mt-1.5 text-[10.5px] leading-relaxed text-white/60">
                                        {step.description}
                                    </p>
                                    <p className="mt-1 text-[9.5px] leading-relaxed text-white/35">
                                        {step.evidence}
                                    </p>
                                </div>
                            </div>
                        ))}
                    </div>
                </section>

                <div className="space-y-3.5">
                    {ex?.priced && (
                        <section className="rounded-xl border border-white/8 bg-white/[0.02] p-3.5 sm:p-4">
                            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                                <SectionLabel text="Score Construction" />
                                <span className="font-mono text-[8px] uppercase tracking-[0.1em] text-white/25">
                                    {signal.category} threshold {ex.threshold_pct.toFixed(2)}%
                                </span>
                            </div>
                            <div className="mt-1 divide-y divide-white/[0.06]">
                                <MathRow
                                    label="Movement"
                                    weight={ex.movement_weight}
                                    value={ex.movement_available ? signed(ex.movement_term, 3) : 'n/a'}
                                    formula={
                                        ex.movement_available
                                            ? `${signed(ex.change_pct)}% ÷ ${ex.threshold_pct.toFixed(2)}% = ${signed(ex.movement_score)}${ex.movement_clamped ? ' (capped at ±1.00)' : ''} × ${Math.round(ex.movement_weight * 100)}% weight`
                                            : `The ${dataSource} feed publishes no previous close · movement unmeasured`
                                    }
                                    tone={
                                        ex.movement_available
                                            ? scoreTextTone(ex.movement_term, cutoff)
                                            : 'text-white/40'
                                    }
                                    bar={scoreBarTone(ex.movement_term, cutoff)}
                                    magnitude={ex.movement_term}
                                />
                                <MathRow
                                    label="Event overlay"
                                    weight={ex.event.weight}
                                    value={signed(ex.event.term, 3)}
                                    formula={eventFormula}
                                    tone={scoreTextTone(ex.event.term, cutoff)}
                                    bar={scoreBarTone(ex.event.term, cutoff)}
                                    magnitude={ex.event.term}
                                />
                                <MathRow
                                    label="Blended score"
                                    value={signed(ex.raw_score, 3)}
                                    formula={`${signed(ex.movement_term, 3)} movement + event ${signed(ex.event.term, 3)} = ${signed(ex.raw_score, 3)} → ${signal.action} against the ±${cutoff.toFixed(2)} cutoff`}
                                    tone={scoreTextTone(ex.raw_score, cutoff)}
                                    bar={scoreBarTone(ex.raw_score, cutoff)}
                                    magnitude={ex.raw_score}
                                    emphasis
                                />
                            </div>
                            <div className="border-t border-white/[0.06] pt-3">
                                <div className="flex items-baseline justify-between gap-3">
                                    <span className="text-[11px] font-semibold text-white/75">
                                        Confidence
                                    </span>
                                    <span className="font-mono text-[14px] font-bold text-[#d8b4fe]">
                                        {Math.round(confidencePct)}%
                                    </span>
                                </div>
                                <p className="mt-1 font-mono text-[9px] leading-relaxed text-white/35">
                                    {confidenceFormula}
                                </p>
                            </div>
                        </section>
                    )}

                    {ex?.priced && (
                        <section className="rounded-xl border border-white/8 bg-white/[0.02] p-3.5 sm:p-4">
                            <SectionLabel text="What Flips The Call" />
                            {ex.movement_available ? (
                                <>
                                    <div className="mt-2.5 grid grid-cols-2 gap-2.5">
                                        <FlipLevel
                                            action="BUY"
                                            level={ex.buy_trigger_pct}
                                            change={ex.change_pct}
                                        />
                                        <FlipLevel
                                            action="SELL"
                                            level={ex.sell_trigger_pct}
                                            change={ex.change_pct}
                                        />
                                    </div>
                                    <p className="mt-2.5 font-mono text-[9px] leading-relaxed text-white/30">
                                        Session change required to reach ±{cutoff.toFixed(2)} with the
                                        event overlay held at {signed(ex.event.term, 3)}. Current
                                        session {signed(ex.change_pct)}%.
                                    </p>
                                </>
                            ) : (
                                <p className="mt-2 font-mono text-[9.5px] leading-relaxed text-white/35">
                                    No flip levels until the feed publishes a previous close: without
                                    a measurable session change there is no level to cross.
                                </p>
                            )}
                        </section>
                    )}

                    <section className="rounded-xl border border-white/8 bg-white/[0.02] p-3.5 sm:p-4">
                        <SectionLabel text="Inputs & Provenance" />
                        <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-2.5">
                            <div>
                                <dt className="font-mono text-[8px] uppercase tracking-[0.12em] text-white/30">
                                    Feed
                                </dt>
                                <dd className="mt-0.5 truncate font-mono text-[10px] text-white/70">
                                    {dataSource}
                                </dd>
                            </div>
                            <div>
                                <dt className="font-mono text-[8px] uppercase tracking-[0.12em] text-white/30">
                                    Quote time
                                </dt>
                                <dd className="mt-0.5 truncate font-mono text-[10px] text-white/70">
                                    {formatWhen(quoteTimestamp)}
                                </dd>
                            </div>
                            <div>
                                <dt className="font-mono text-[8px] uppercase tracking-[0.12em] text-white/30">
                                    Change basis
                                </dt>
                                <dd className="mt-0.5 font-mono text-[10px] text-white/70">
                                    {ex
                                        ? ex.movement_available
                                            ? 'Provider session change'
                                            : 'Not published by the feed'
                                        : 'Provider session change'}
                                </dd>
                            </div>
                            <div>
                                <dt className="font-mono text-[8px] uppercase tracking-[0.12em] text-white/30">
                                    Freshness
                                </dt>
                                <dd className="mt-0.5 font-mono text-[10px] text-white/70">
                                    {ex ? `×${ex.freshness.toFixed(2)}` : 'unavailable'}
                                </dd>
                            </div>
                            {ex && (
                                <>
                                    <div>
                                        <dt className="font-mono text-[8px] uppercase tracking-[0.12em] text-white/30">
                                            Volatility
                                        </dt>
                                        <dd className="mt-0.5 font-mono text-[10px] text-white/70">
                                            {ex.volatility_label} · ATR{' '}
                                            {(ex.atr_pct * 100).toFixed(2)}%
                                        </dd>
                                    </div>
                                    <div>
                                        <dt className="font-mono text-[8px] uppercase tracking-[0.12em] text-white/30">
                                            Model basis
                                        </dt>
                                        <dd className="mt-0.5 font-mono text-[10px] text-white/70">
                                            Movement + verified events
                                        </dd>
                                    </div>
                                </>
                            )}
                        </dl>

                        {signal.related_assets.length > 0 && (
                            <div className="mt-3 border-t border-white/[0.06] pt-3">
                                <SectionLabel text="Related Assets" />
                                <div className="mt-1.5 flex flex-wrap gap-1.5">
                                    {signal.related_assets.map(sym => (
                                        <span
                                            key={sym}
                                            className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 font-mono text-[9px] text-white/55"
                                        >
                                            {sym}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        )}
                    </section>
                </div>
            </div>
        </div>
    )
}

// ── Signal detail ─────────────────────────────────────────────────────────────

function useIsDesktopLayout() {
    const [isDesktop, setIsDesktop] = useState(
        () => window.matchMedia('(min-width: 1024px)').matches,
    )

    useEffect(() => {
        const query = window.matchMedia('(min-width: 1024px)')
        const onChange = (event: MediaQueryListEvent) => setIsDesktop(event.matches)
        query.addEventListener('change', onChange)
        return () => query.removeEventListener('change', onChange)
    }, [])

    return isDesktop
}

function SignalDetail({ signal, showChart = true }: { signal: Signal; showChart?: boolean }) {
    const [tab, setTab] = useState<DetailTab>('setup')

    const ts = signal.trade_setup
    const rel = signal.reliability
    const risk = Math.abs(ts.entry_price - ts.stop_loss)
    const rewrd = Math.abs(ts.target_price - ts.entry_price)
    const change = signal.live_change_pct ?? null
    const up = (change ?? 0) >= 0
    const assetClassLabel = signal.asset_class.replace(/_/g, ' ')
    const showAssetClass = assetClassLabel.toLowerCase() !== signal.category.toLowerCase()

    return (
        <div className="flex h-full flex-col overflow-hidden bg-[#040714]/60">
            {/* ── Instrument header ── */}
            <div className="shrink-0 border-b border-white/8 px-4 py-3.5 sm:px-5">
                <div className="mx-auto flex w-full max-w-[1500px] flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0 flex-1 basis-[280px]">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <h2 className="font-mono text-[27px] font-bold leading-none tracking-tight text-white">
                                {signal.symbol}
                            </h2>
                            <span
                                className={`rounded-md border px-2 py-0.5 font-mono text-[10px] font-bold tracking-wide ${actionClass(signal.action)}`}
                            >
                                {signal.action}
                            </span>
                            <span className="rounded border border-[#a855f7]/25 bg-[#a855f7]/[0.08] px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-[0.14em] text-[#d8b4fe]/90">
                                AI Signal
                            </span>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10.5px] text-white/40">
                            <span className="text-white/70">{signal.label}</span>
                            <span className="text-white/15">·</span>
                            <span className="capitalize">{signal.category}</span>
                            {showAssetClass && (
                                <>
                                    <span className="text-white/15">·</span>
                                    <span className="capitalize">{assetClassLabel}</span>
                                </>
                            )}
                            <span className="text-white/15">·</span>
                            <span className="capitalize">{signal.region.replace(/_/g, ' ')}</span>
                        </div>
                        <p className="mt-1.5 line-clamp-2 max-w-[75ch] text-[11.5px] leading-relaxed text-white/45">
                            {signal.description}
                        </p>
                    </div>

                    <div className="flex shrink-0 items-stretch divide-x divide-white/8 overflow-hidden rounded-lg border border-white/8 bg-white/[0.03]">
                        <div className="min-w-[118px] px-3 py-2.5 text-right">
                            <div className="font-mono text-[8px] uppercase tracking-[0.14em] text-white/35">
                                Last Price
                            </div>
                            <div className="mt-1 font-mono text-lg font-bold leading-none tabular-nums text-white">
                                {formatPrice(ts.current_price)}
                            </div>
                            <div
                                className={`mt-1.5 flex items-center justify-end gap-1 font-mono text-[9.5px] tabular-nums ${
                                    change === null
                                        ? 'text-white/30'
                                        : up
                                            ? 'text-emerald-400'
                                            : 'text-red-400'
                                }`}
                            >
                                {change !== null &&
                                    (up ? (
                                        <TrendingUp className="h-3 w-3" />
                                    ) : (
                                        <TrendingDown className="h-3 w-3" />
                                    ))}
                                {change === null
                                    ? 'No movement data'
                                    : `${up ? '+' : ''}${change.toFixed(2)}%`}
                            </div>
                        </div>

                        <div className="min-w-[92px] bg-[#a855f7]/[0.08] px-3 py-2.5 text-right">
                            <div className="font-mono text-[8px] uppercase tracking-[0.14em] text-[#c084fc]/75">
                                Confidence
                            </div>
                            <div className="mt-1 font-mono text-lg font-bold leading-none tabular-nums text-white">
                                {signal.confidence_pct.toFixed(0)}%
                            </div>
                        </div>

                        <div className="min-w-[92px] px-3 py-2.5 text-right">
                            <div className="font-mono text-[8px] uppercase tracking-[0.14em] text-white/35">
                                Uncertainty
                            </div>
                            <div className="mt-1 font-mono text-lg font-bold leading-none tabular-nums text-orange-300">
                                {signal.uncertainty_pct.toFixed(0)}%
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* ── Scrollable workspace ── */}
            <div
                className="flex-1 overflow-y-auto"
                style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(148, 163, 184, 0.16) transparent' }}
            >
                <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-3.5 px-4 py-3.5 pb-16 sm:px-5">
                    {/* ── Tabbed analysis ── */}
                    <section className="overflow-hidden rounded-xl border border-white/10 bg-[#07091a]/55">
                        <div className="flex flex-col gap-2 border-b border-white/8 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                            <SectionLabel text="Analysis" className="hidden shrink-0 sm:flex" />
                            <div
                                className="flex min-w-0 gap-1 overflow-x-auto rounded-lg border border-white/[0.06] bg-white/[0.025] p-[3px]"
                                role="tablist"
                                aria-label="Signal detail sections"
                                style={{ scrollbarWidth: 'none' }}
                            >
                                {DETAIL_TABS.map(({ id, label, shortLabel, icon: Icon }) => {
                                    const active = tab === id
                                    return (
                                        <button
                                            key={id}
                                            type="button"
                                            role="tab"
                                            aria-selected={active}
                                            aria-label={label}
                                            title={label}
                                            onClick={() => setTab(id)}
                                            className={`flex flex-1 shrink-0 items-center justify-center gap-1.5 rounded-md border px-2.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.04em] transition-colors sm:px-3 ${
                                                active
                                                    ? 'border-[#a855f7]/30 bg-[#a855f7]/15 text-white'
                                                    : 'border-transparent text-white/40 hover:bg-white/[0.05] hover:text-white/70'
                                            }`}
                                            style={{ minHeight: '34px' }}
                                        >
                                            <Icon
                                                className={`hidden h-3.5 w-3.5 shrink-0 sm:block ${active ? 'text-[#c084fc]' : ''}`}
                                            />
                                            <span className="hidden whitespace-nowrap sm:inline">{label}</span>
                                            <span className="whitespace-nowrap sm:hidden">{shortLabel}</span>
                                        </button>
                                    )
                                })}
                            </div>
                        </div>

                        <div className="p-3.5 sm:p-4">
                            <AnimatePresence mode="wait">
                                {tab === 'setup' && (
                                    <motion.div
                                        key="setup"
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        exit={{ opacity: 0 }}
                                        className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]"
                                    >
                                        <section>
                                            <SectionLabel text="Primary Levels" />
                                            <div className="mt-2 grid grid-cols-2 gap-2">
                                                <MetricTile
                                                    label="Current Price"
                                                    value={formatPrice(ts.current_price)}
                                                    sub="last quote"
                                                    tone="text-white/85"
                                                />
                                                <MetricTile
                                                    label="Entry"
                                                    value={formatPrice(ts.entry_price)}
                                                    sub="planned entry"
                                                />
                                                <MetricTile
                                                    label="Stop Loss"
                                                    value={formatPrice(ts.stop_loss)}
                                                    sub="invalidation"
                                                    tone="text-red-400"
                                                />
                                                <MetricTile
                                                    label="Target"
                                                    value={formatPrice(ts.target_price)}
                                                    sub="take profit"
                                                    tone="text-emerald-400"
                                                />
                                            </div>

                                            <div className="mt-4">
                                                <SectionLabel text="Risk Metrics" />
                                                <div className="mt-2 grid grid-cols-3 gap-2">
                                                    <MetricTile
                                                        label="Risk / Reward"
                                                        value={`${ts.risk_reward.toFixed(2)}×`}
                                                        sub="ratio"
                                                    />
                                                    <MetricTile
                                                        label="ATR (daily)"
                                                        value={`${(ts.atr_pct * 100).toFixed(2)}%`}
                                                        sub="volatility"
                                                        tone="text-orange-300"
                                                    />
                                                    <MetricTile
                                                        label="Max Position"
                                                        value={`${(ts.max_position_pct * 100).toFixed(1)}%`}
                                                        sub="portfolio cap"
                                                        tone="text-purple-300"
                                                    />
                                                </div>
                                            </div>
                                        </section>

                                        <section className="space-y-3">
                                            <div className="rounded-lg border border-white/8 bg-white/[0.025] p-3.5">
                                                <div className="flex items-center justify-between gap-2">
                                                    <SectionLabel text="Risk vs Reward" />
                                                    <span className="rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums text-white/60">
                                                        {ts.risk_reward.toFixed(2)}×
                                                    </span>
                                                </div>
                                                <div className="mt-2.5 flex items-baseline justify-between gap-2 font-mono text-[11.5px] font-semibold tabular-nums">
                                                    <span className="text-red-400">
                                                        Risk {formatPrice(risk)}
                                                    </span>
                                                    <span className="text-emerald-400">
                                                        Reward +{formatPrice(rewrd)}
                                                    </span>
                                                </div>
                                                <div className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-white/[0.06]">
                                                    <div
                                                        className="bg-gradient-to-r from-red-500/80 to-red-400/60"
                                                        style={{ width: `${100 / (ts.risk_reward + 1)}%` }}
                                                    />
                                                    <div className="flex-1 bg-gradient-to-r from-emerald-500/60 to-emerald-400/80" />
                                                </div>
                                                <div className="mt-1.5 flex justify-between font-mono text-[9px] tabular-nums text-white/25">
                                                    <span>1R risk unit</span>
                                                    <span>{ts.risk_reward.toFixed(2)}R reward</span>
                                                </div>
                                            </div>

                                            <div className="flex gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] p-3">
                                                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                                                <p className="text-[10px] leading-relaxed text-amber-200/70">
                                                    Educational purposes only. Not financial advice. Always perform
                                                    your own due diligence. Explainable movement model · Quote as
                                                    of{' '}
                                                    {new Date(
                                                        signal.quote_timestamp || signal.generated_at,
                                                    ).toLocaleString()}
                                                </p>
                                            </div>
                                        </section>
                                    </motion.div>
                                )}

                                {tab === 'reasoning' && (
                                    <motion.div
                                        key="reasoning"
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        exit={{ opacity: 0 }}
                                    >
                                        <ReasoningTab
                                            signal={signal}
                                            ex={signal.explainability ?? null}
                                        />
                                    </motion.div>
                                )}

                                {tab === 'timeline' && (
                                    <motion.div
                                        key="timeline"
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        exit={{ opacity: 0 }}
                                        className="max-w-4xl"
                                    >
                                        <SectionLabel text="Event → Market Reaction" />
                                        {signal.event_timeline.length === 0 ? (
                                            <div className="mt-2 flex flex-col items-center gap-2 rounded-xl border border-dashed border-white/12 bg-white/[0.02] px-4 py-9 text-center">
                                                <Clock className="h-5 w-5 text-white/25" />
                                                <span className="font-mono text-[11px] text-white/45">
                                                    No verified event timeline available
                                                </span>
                                                <span className="max-w-sm font-mono text-[9px] leading-relaxed text-white/25">
                                                    Timeline entries appear once a linked geopolitical event is
                                                    verified for this instrument.
                                                </span>
                                            </div>
                                        ) : (
                                            <div className="mt-3">
                                                {signal.event_timeline.map((entry, i) => (
                                                    <div key={i} className="flex gap-3">
                                                        <div className="flex flex-col items-center pt-2">
                                                            <span
                                                                className={`h-2.5 w-2.5 shrink-0 rounded-full ring-4 ring-white/[0.04] ${phaseDot(entry.phase)}`}
                                                            />
                                                            {i < signal.event_timeline.length - 1 && (
                                                                <div className="my-1.5 min-h-[26px] w-px flex-1 bg-white/10" />
                                                            )}
                                                        </div>
                                                        <div className="flex-1 pb-5">
                                                            <div className="flex flex-wrap items-center gap-2">
                                                                <span className="font-mono text-[9.5px] tabular-nums text-white/40">
                                                                    {formatTs(entry.ts)}
                                                                </span>
                                                                <span
                                                                    className={`rounded-full border px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-wide ${phaseColor(entry.phase)}`}
                                                                >
                                                                    {entry.phase.replace(/_/g, ' ')}
                                                                </span>
                                                            </div>
                                                            <div className="mt-1 text-[11.5px] font-semibold text-white/85">
                                                                {entry.label}
                                                            </div>
                                                            <div className="mt-1 text-[10.5px] leading-relaxed text-white/45">
                                                                {entry.detail}
                                                            </div>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </motion.div>
                                )}

                                {tab === 'reliability' && (
                                    <motion.div
                                        key="reliability"
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        exit={{ opacity: 0 }}
                                        className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,340px)]"
                                    >
                                        <section>
                                            <SectionLabel text="Historical Performance" />
                                            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-2 2xl:grid-cols-4">
                                                <MetricTile
                                                    label="Signal Accuracy"
                                                    value={formatPct(rel.historical_accuracy)}
                                                    sub="directional calls"
                                                    tone="text-emerald-400"
                                                />
                                                <MetricTile
                                                    label="Win Rate"
                                                    value={formatPct(rel.win_rate)}
                                                    sub="profitable trades"
                                                />
                                                <MetricTile
                                                    label="Sharpe Ratio"
                                                    value={rel.sharpe_ratio.toFixed(2)}
                                                    sub="risk-adjusted return"
                                                    tone="text-white/70"
                                                />
                                                <MetricTile
                                                    label="Max Drawdown"
                                                    value={formatPct(rel.max_drawdown)}
                                                    sub="peak-to-trough"
                                                    tone="text-red-400"
                                                />
                                            </div>
                                        </section>

                                        <div className="space-y-3">
                                            <div className="rounded-lg border border-white/8 bg-white/[0.025] p-3.5">
                                                <div className="flex items-center justify-between gap-2">
                                                    <SectionLabel text="Signal Reliability Score" />
                                                    <span className="font-mono text-[11px] font-semibold tabular-nums text-emerald-400">
                                                        {formatPct(rel.historical_accuracy)}
                                                    </span>
                                                </div>
                                                <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/[0.06]">
                                                    <motion.div
                                                        initial={{ width: 0 }}
                                                        animate={{ width: `${rel.historical_accuracy * 100}%` }}
                                                        transition={{ duration: 0.8 }}
                                                        className="h-full rounded-full bg-gradient-to-r from-white/70 to-emerald-500"
                                                    />
                                                </div>
                                            </div>

                                            {rel.basis && (
                                                <div className="rounded-lg border border-white/8 bg-white/[0.025] px-3.5 py-3">
                                                    <SectionLabel text="Basis" />
                                                    <p className="mt-1.5 text-[10.5px] leading-relaxed text-white/45">
                                                        {rel.basis}
                                                    </p>
                                                </div>
                                            )}

                                            <div className="rounded-lg border border-white/8 bg-white/[0.02] p-3.5">
                                                <div className="text-[10.5px] leading-relaxed text-white/40">
                                                    Performance metrics derived from backtesting engine using
                                                    historical geopolitical events. Past performance does not
                                                    guarantee future results.
                                                </div>
                                            </div>
                                        </div>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>
                    </section>

                    {/* ── Chart + signal snapshot ── */}
                    <div className="grid items-stretch gap-3.5 xl:grid-cols-[minmax(0,1fr)_340px] 2xl:grid-cols-[minmax(0,1fr)_380px]">
                        {showChart && (
                            <TradingViewAssetChart
                                symbol={signal.symbol}
                                label={signal.label}
                                assetClass={signal.asset_class}
                                region={signal.region}
                            />
                        )}
                        <SignalSnapshot signal={signal} />
                    </div>
                </div>
            </div>
        </div>
    )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function TradingCharts() {
    const [signals, setSignals] = useState<Signal[]>([])
    const [loading, setLoading] = useState(true)
    const [selectedCategory, setSelectedCategory] = useState('All')
    const [selectedAction, setSelectedAction] = useState('All')
    const [selectedSignal, setSelectedSignal] = useState<Signal | null>(null)
    const [searchQuery, setSearchQuery] = useState('')
    const [lastRefresh, setLastRefresh] = useState(new Date())
    const isDesktopLayout = useIsDesktopLayout()

    // 'list' = signal queue, 'detail' = signal detail
    const [mobileView, setMobileView] = useState<'list' | 'detail'>('list')

    const fetchSignals = useCallback(async () => {
        setLoading(true)
        try {
            const data = await api.getSignalsV2({ limit: 500 })
            const merged = Array.isArray(data?.signals)
                ? (data.signals as Signal[]).sort((a, b) => {
                    const aPriced = typeof a.price === 'number' && a.price > 0 ? 1 : 0
                    const bPriced = typeof b.price === 'number' && b.price > 0 ? 1 : 0
                    if (aPriced !== bPriced) return bPriced - aPriced
                    return a.symbol.localeCompare(b.symbol)
                })
                : []

            setSignals(merged)
            setSelectedSignal(prev => {
                if (prev) {
                    return merged.find(signal => signal.symbol === prev.symbol) ?? merged[0] ?? null
                }
                return merged[0] ?? null
            })
        } catch {
            setSignals([])
            setSelectedSignal(null)
        } finally {
            setLoading(false)
            setLastRefresh(new Date())
        }
    }, [])

    useEffect(() => {
        fetchSignals()
        const interval = setInterval(fetchSignals, 60_000)
        return () => clearInterval(interval)
    }, [fetchSignals])

    // Filtering (category + search scope the direction counts as well)
    const query = searchQuery.trim().toLowerCase()
    const matchesSearch = (s: Signal) =>
        !query
        || s.symbol.toLowerCase().includes(query)
        || s.label.toLowerCase().includes(query)
        || s.sector.toLowerCase().includes(query)
    const matchesCategory = (s: Signal) =>
        selectedCategory === 'All'
        || s.category === selectedCategory
        || s.asset_class === CATEGORY_TO_ASSET_CLASS[selectedCategory]

    const searchMatched = signals.filter(matchesSearch)
    const scoped = searchMatched.filter(matchesCategory)
    const filtered = scoped.filter(s => selectedAction === 'All' || s.action === selectedAction)

    // Keep the workspace in sync with the queue: when a filter or search hides
    // the previous pick, fall back to the first visible signal.
    const activeSignal =
        selectedSignal && filtered.some(s => s.symbol === selectedSignal.symbol)
            ? selectedSignal
            : filtered[0] ?? null

    const categoryCounts: Record<string, number> = {}
    for (const cat of CATEGORIES) {
        categoryCounts[cat] = cat === 'All'
            ? searchMatched.length
            : searchMatched.filter(s => s.category === cat || s.asset_class === CATEGORY_TO_ASSET_CLASS[cat]).length
    }
    const directionCounts: Record<string, number> = {
        All: scoped.length,
        BUY: scoped.filter(s => s.action === 'BUY').length,
        SELL: scoped.filter(s => s.action === 'SELL').length,
        HOLD: scoped.filter(s => s.action === 'HOLD').length,
    }

    const listScrollStyle = {
        scrollbarWidth: 'thin' as const,
        scrollbarColor: 'rgba(148, 163, 184, 0.16) transparent',
    }

    const renderQueue = (onSelect: (signal: Signal) => void) =>
        loading && signals.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3">
                <RefreshCw className="h-5 w-5 animate-spin text-white/50" />
                <span className="font-mono text-[10px] text-gray-600">Loading signals...</span>
            </div>
        ) : filtered.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                <Info className="h-5 w-5 text-gray-600" />
                <span className="font-mono text-[10px] text-gray-600">
                    No signals match the current filters
                </span>
            </div>
        ) : (
            filtered.map(sig => (
                <SignalRow
                    key={sig.symbol}
                    signal={sig}
                    selected={activeSignal?.symbol === sig.symbol}
                    onClick={() => onSelect(sig)}
                />
            ))
        )

    return (
        // The app's TopBar is an overlay above this view, so the terminal
        // starts below it (61px on phones, ~79px once the bar wraps).
        <div className="absolute inset-0 flex flex-col overflow-hidden bg-[#030610] pt-[62px] sm:pt-[80px]">
            {/* ── Command bar ── */}
            <header className="shrink-0 border-b border-white/8 bg-[#06091b]/90">
                <div className="flex flex-wrap items-center gap-2 px-3 py-2 sm:px-4 xl:px-5">
                    <div className="hidden shrink-0 items-center gap-2.5 lg:flex">
                        <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#a855f7]/30 bg-[#a855f7]/10">
                            <Activity className="h-4 w-4 text-[#c084fc]" />
                        </span>
                        <div className="leading-tight">
                            <div className="font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-white">
                                Signal Universe
                            </div>
                            <div className="mt-0.5 font-mono text-[9px] tabular-nums text-white/35">
                                {filtered.length} of {signals.length} instruments
                            </div>
                        </div>
                        <span className="mx-2 h-8 w-px bg-white/10" />
                    </div>

                    <div className="order-1 flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-white/8 bg-white/[0.04] px-2.5 transition-colors focus-within:border-[#a855f7]/40 focus-within:bg-white/[0.05] sm:order-none sm:w-56 sm:flex-none md:w-64">
                        <Search className="h-3.5 w-3.5 shrink-0 text-white/35" />
                        <input
                            type="text"
                            placeholder="Search symbol, name or sector"
                            value={searchQuery}
                            onChange={e => setSearchQuery(e.target.value)}
                            className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-white/80 placeholder-white/30 outline-none"
                            style={{ minHeight: 'unset' }}
                        />
                        {searchQuery && (
                            <button
                                onClick={() => setSearchQuery('')}
                                className="shrink-0 text-white/35 transition-colors hover:text-white/70"
                                style={{ minHeight: 'unset' }}
                                aria-label="Clear search"
                            >
                                <X className="h-3 w-3" />
                            </button>
                        )}
                    </div>

                    <div
                        className="order-2 -mx-1 flex w-full min-w-0 items-center gap-0.5 overflow-x-auto px-1 sm:order-none sm:mx-0 sm:w-auto sm:flex-1 sm:gap-1 sm:px-0"
                        role="group"
                        aria-label="Filter by direction"
                        style={{ scrollbarWidth: 'none' }}
                    >
                        {ACTIONS.map(act => {
                            const active = selectedAction === act
                            return (
                                <button
                                    key={act}
                                    type="button"
                                    onClick={() => setSelectedAction(act)}
                                    aria-pressed={active}
                                    className={`flex h-9 shrink-0 items-center gap-1 rounded-lg border px-2 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] transition-colors sm:gap-1.5 sm:px-2.5 ${
                                        active
                                            ? directionActiveClass(act)
                                            : 'border-transparent text-white/40 hover:bg-white/[0.04] hover:text-white/70'
                                    }`}
                                    style={{ minHeight: 'unset' }}
                                >
                                    <DirectionIcon action={act} />
                                    <span>{act}</span>
                                    <span
                                        className={`rounded px-1 py-px text-[8.5px] font-medium tabular-nums ${
                                            active ? 'bg-black/20' : 'bg-white/[0.05] text-white/35'
                                        }`}
                                    >
                                        {directionCounts[act] ?? 0}
                                    </span>
                                </button>
                            )
                        })}
                    </div>

                    <div className="order-1 flex shrink-0 items-center gap-2 sm:order-none">
                        <span className="hidden font-mono text-[9px] tabular-nums text-white/30 lg:inline">
                            {lastRefresh.toLocaleTimeString('en-US', {
                                hour: '2-digit',
                                minute: '2-digit',
                                second: '2-digit',
                                hour12: false,
                            })}{' '}
                            UTC
                        </span>
                        <button
                            onClick={fetchSignals}
                            disabled={loading}
                            className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/8 bg-white/[0.04] transition-colors hover:border-white/20 disabled:opacity-60"
                            title="Refresh signals"
                            aria-label="Refresh signals"
                            style={{ minHeight: 'unset' }}
                        >
                            <RefreshCw
                                className={`h-3.5 w-3.5 text-gray-400 ${loading ? 'animate-spin' : ''}`}
                            />
                        </button>
                    </div>
                </div>

                {/* Asset-class chips + geo legend */}
                <div className="flex items-center gap-2 border-t border-white/[0.06] px-3 py-1.5 sm:px-4 xl:px-5">
                    <span className="hidden shrink-0 font-mono text-[9px] uppercase tracking-[0.14em] text-white/30 md:inline">
                        Universe
                    </span>
                    <div
                        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
                        role="group"
                        aria-label="Filter by asset class"
                        style={{
                            scrollbarWidth: 'none',
                            maskImage: 'linear-gradient(to right, #000 calc(100% - 16px), transparent)',
                            WebkitMaskImage: 'linear-gradient(to right, #000 calc(100% - 16px), transparent)',
                        }}
                    >
                        {CATEGORIES.map(cat => {
                            const active = selectedCategory === cat
                            return (
                                <button
                                    key={cat}
                                    type="button"
                                    onClick={() => setSelectedCategory(cat)}
                                    aria-pressed={active}
                                    className={`flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2.5 font-mono text-[10px] transition-colors ${
                                        active
                                            ? 'border-[#a855f7]/40 bg-[#a855f7]/12 text-white'
                                            : 'border-white/6 bg-white/[0.02] text-white/45 hover:border-white/12 hover:text-white/75'
                                    }`}
                                    style={{ minHeight: 'unset' }}
                                >
                                    {cat}
                                    <span
                                        className={`text-[8.5px] tabular-nums ${
                                            active ? 'text-[#d8b4fe]' : 'text-white/25'
                                        }`}
                                    >
                                        {categoryCounts[cat] ?? 0}
                                    </span>
                                </button>
                            )
                        })}
                    </div>

                    <div className="hidden shrink-0 items-center gap-2.5 2xl:flex">
                        <span className="h-3 w-px bg-white/10" />
                        <span className="flex items-center gap-1 font-mono text-[8px] uppercase tracking-[0.12em] text-white/25">
                            <Globe2 className="h-3 w-3" />
                            Geo
                        </span>
                        {GEO_TAGS.map(tag => (
                            <span
                                key={tag}
                                className="flex items-center gap-1 font-mono text-[8.5px] capitalize text-white/35"
                            >
                                <span className="h-1 w-1 rounded-full bg-[#a855f7]/70" />
                                {tag.replace(/_/g, ' ')}
                            </span>
                        ))}
                    </div>

                    <span className="hidden shrink-0 items-center gap-1 font-mono text-[8px] uppercase tracking-[0.14em] text-white/25 sm:flex">
                        <Activity className="h-3 w-3" />
                        Auto 60s
                    </span>
                </div>
            </header>

            <div className="flex-1 overflow-hidden">
                {/* ── DESKTOP / TABLET: queue + workspace ── */}
                <div className="hidden h-full lg:flex">
                    <aside
                        className="flex w-[21rem] shrink-0 flex-col overflow-hidden border-r border-white/8 bg-[#05081a]/40 xl:w-[23rem] 2xl:w-[25rem]"
                        aria-label="Signal queue"
                    >
                        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/8 px-4 py-2.5">
                            <div className="flex items-center gap-2">
                                <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-white/65">
                                    Signal Queue
                                </span>
                                <span className="rounded bg-white/[0.05] px-1.5 py-px font-mono text-[9px] tabular-nums text-white/40">
                                    {filtered.length}
                                </span>
                            </div>
                            <span className="truncate font-mono text-[9px] text-white/25">
                                {selectedCategory === 'All' ? 'All classes' : selectedCategory}
                            </span>
                        </div>

                        <div className="flex-1 overflow-y-auto" style={listScrollStyle}>
                            {renderQueue(setSelectedSignal)}
                        </div>
                    </aside>

                    <main className="min-w-0 flex-1 overflow-hidden">
                        <AnimatePresence mode="wait">
                            {activeSignal ? (
                                <motion.div
                                    key={activeSignal.symbol}
                                    initial={{ opacity: 0, x: 16 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    exit={{ opacity: 0, x: -8 }}
                                    transition={{ duration: 0.2 }}
                                    className="h-full"
                                >
                                    <SignalDetail signal={activeSignal} showChart={isDesktopLayout} />
                                </motion.div>
                            ) : (
                                <motion.div
                                    key="empty"
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    className="flex h-full flex-col items-center justify-center gap-3"
                                >
                                    <BarChart2 className="h-8 w-8 text-gray-700" />
                                    <span className="font-mono text-[11px] text-gray-600">
                                        Select a signal to view details
                                    </span>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </main>
                </div>

                {/* ── MOBILE / TABLET: single-panel navigation ── */}
                <div className="flex h-full flex-col overflow-hidden lg:hidden">
                    {mobileView === 'detail' && (
                        <div className="flex shrink-0 items-center gap-2 border-b border-white/8 bg-[#07091a]/60 px-3 py-2">
                            <button
                                onClick={() => setMobileView('list')}
                                className="flex items-center gap-2 rounded-lg border border-white/12 bg-white/5 px-3 py-2 font-mono text-[11px] text-gray-300 transition-colors hover:text-white"
                                style={{ minHeight: '44px' }}
                            >
                                <ChevronLeft className="h-4 w-4" />
                                <span>Signal Queue</span>
                            </button>
                            <span className="ml-auto truncate font-mono text-[10px] uppercase tracking-[0.14em] text-white/35">
                                {activeSignal?.symbol}
                            </span>
                        </div>
                    )}

                    <div className="flex-1 overflow-hidden">
                        <AnimatePresence mode="wait">
                            {mobileView === 'list' ? (
                                <motion.div
                                    key="mobile-list"
                                    initial={{ opacity: 0, x: -16 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    exit={{ opacity: 0, x: -16 }}
                                    transition={{ duration: 0.2 }}
                                    className="h-full overflow-y-auto pb-16"
                                    style={listScrollStyle}
                                >
                                    {renderQueue(sig => {
                                        setSelectedSignal(sig)
                                        setMobileView('detail')
                                    })}
                                </motion.div>
                            ) : (
                                <motion.div
                                    key={`mobile-detail-${activeSignal?.symbol}`}
                                    initial={{ opacity: 0, x: 24 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    exit={{ opacity: 0, x: 16 }}
                                    transition={{ duration: 0.22 }}
                                    className="h-full overflow-hidden"
                                >
                                    {activeSignal ? (
                                        <SignalDetail
                                            signal={activeSignal}
                                            showChart={!isDesktopLayout}
                                        />
                                    ) : (
                                        <div className="flex h-full flex-col items-center justify-center gap-3">
                                            <BarChart2 className="h-8 w-8 text-gray-700" />
                                            <span className="font-mono text-[11px] text-gray-600">
                                                Select a signal to view details
                                            </span>
                                        </div>
                                    )}
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                </div>
            </div>

            {/* ── Disclaimer ── */}
            <footer className="shrink-0 border-t border-white/8 bg-[#07091a]/85 px-4 py-2">
                <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center font-mono text-[9px] text-white/35">
                    <span className="flex items-center gap-1">
                        <ShieldCheck className="h-3 w-3 text-white/30" />
                        Educational purposes only
                    </span>
                    <span className="text-white/15">·</span>
                    <span>Not financial advice</span>
                    <span className="text-white/15">·</span>
                    <span>Model v1.0</span>
                    <span className="text-white/15">·</span>
                    <span>Auto-refresh 60s</span>
                </div>
            </footer>
        </div>
    )
}
