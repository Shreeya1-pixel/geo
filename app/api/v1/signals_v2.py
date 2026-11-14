"""Enhanced Signals V2 — trader-focused intelligence endpoint.

Returns the full expanded asset universe with:
  - BUY/SELL/HOLD action
  - Confidence + uncertainty
  - Bullish / bearish strength
  - Volatility label
  - Trade setup (entry, stop, target, R:R)
  - Signal reliability metrics (accuracy, Sharpe, win rate, max drawdown)
  - Event → market reaction timeline
  - Structured reasoning chain (Event → Impact → Mechanism → Movement)
  - Asset universe metadata (category, geo_sensitivity, description)
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.cache import _make_cache_key, cache_get, cache_set
from app.core.database import get_db
from app.core.logging import get_logger
from app.config.asset_universe import AssetUniverse, get_asset_universe, AssetDefinition
from app.repositories.event_repo import EventRepository
from app.services.market import get_all_markets
from app.services.trade_setup import compute_trade_setup

router = APIRouter(prefix="/signals/v2", tags=["signals-v2"])
logger = get_logger(__name__)

# ── Per-event asset sensitivity rules ────────────────────────────────────────
_EVENT_ASSET_RULES: dict[str, dict[str, tuple[str, float]]] = {
    "military_escalation": {
        # ── Commodities ──────────────────────────────────────────────────────
        "XAUUSD": ("BUY",  0.88), "XAGUSD": ("BUY",  0.72),
        "WTI":    ("BUY",  0.80), "NATGAS": ("BUY",  0.65),
        "BTC":    ("HOLD", 0.55), "BRENT":  ("BUY",  0.82),
        # ── Defense stocks ───────────────────────────────────────────────────
        "LMT":    ("BUY",  0.85), "RTX":    ("BUY",  0.84),
        "NOC":    ("BUY",  0.80), "GD":     ("BUY",  0.78),
        "BA":     ("BUY",  0.70), "ITA":    ("BUY",  0.83),
        # ── ETF proxies ──────────────────────────────────────────────────────
        "GLD":    ("BUY",  0.86), "SLV":    ("BUY",  0.70),
        "USO":    ("BUY",  0.78), "UNG":    ("BUY",  0.62),
        # ── Other ────────────────────────────────────────────────────────────
        "TLT":    ("BUY",  0.72),
        "SPX":    ("SELL", 0.68), "NDX":    ("SELL", 0.65), "DAX":    ("SELL", 0.70),
        "USDJPY": ("SELL", 0.65), "USDCHF": ("SELL", 0.62),
    },
    "energy_supply_disruption": {
        "WTI":    ("BUY",  0.92), "BRENT":  ("BUY",  0.90), "NATGAS": ("BUY",  0.88),
        "XAUUSD": ("BUY",  0.68), "XAGUSD": ("BUY",  0.58),
        "LMT":    ("BUY",  0.60), "RTX":    ("BUY",  0.58),
        "XOM":    ("BUY",  0.82), "CVX":    ("BUY",  0.80),
        "XLE":    ("BUY",  0.85),
        "DAX":    ("SELL", 0.72), "EURUSD": ("SELL", 0.68),
        "USO":    ("BUY",  0.90), "UNG":    ("BUY",  0.86),
    },
    "trade_restrictions": {
        "COPPER":   ("SELL", 0.80), "SOYBEANS": ("SELL", 0.78), "NDX":  ("SELL", 0.72),
        "HSI":      ("SELL", 0.85), "USDCNH":   ("BUY",  0.75),
        "XAUUSD":   ("BUY",  0.65), "XAGUSD":   ("SELL", 0.58),
        "WTI":      ("SELL", 0.55), "NATGAS":   ("BUY",  0.62),
        "BTC":      ("SELL", 0.60), "ETH":      ("SELL", 0.58),
        "BA":       ("SELL", 0.65),
    },
    "sanctions": {
        "XAUUSD": ("BUY",  0.82), "XAGUSD": ("BUY",  0.70),
        "WTI":    ("BUY",  0.70), "BTC":    ("BUY",  0.65),
        "LMT":    ("BUY",  0.72), "RTX":    ("BUY",  0.70),
        "NOC":    ("BUY",  0.68), "GD":     ("BUY",  0.65),
        "EURUSD": ("SELL", 0.68), "DAX":    ("SELL", 0.72),
    },
    "political_instability": {
        "XAUUSD": ("BUY",  0.75), "XAGUSD": ("BUY",  0.62),
        "TLT":    ("BUY",  0.70),
        "BTC":    ("HOLD", 0.52),
        "LMT":    ("BUY",  0.60), "RTX":    ("BUY",  0.58),
        "SPX":    ("SELL", 0.65), "EURUSD": ("SELL", 0.60),
    },
    "nuclear_threat": {
        "XAUUSD": ("BUY",  0.92), "XAGUSD": ("BUY",  0.80),
        "TLT":    ("BUY",  0.85),
        "LMT":    ("BUY",  0.88), "RTX":    ("BUY",  0.85),
        "NOC":    ("BUY",  0.88), "GD":     ("BUY",  0.80),
        "ITA":    ("BUY",  0.86), "BTC":    ("HOLD", 0.50),
        "USDJPY": ("SELL", 0.80), "SPX":    ("SELL", 0.78), "NDX":    ("SELL", 0.75),
    },
    "territorial_dispute": {
        "XAUUSD": ("BUY",  0.78), "XAGUSD": ("BUY",  0.65),
        "NKY":    ("SELL", 0.72), "USDJPY": ("SELL", 0.68),
        "LMT":    ("BUY",  0.75), "RTX":    ("BUY",  0.73),
        "NOC":    ("BUY",  0.70), "GD":     ("BUY",  0.68),
        "ITA":    ("BUY",  0.72), "BTC":    ("HOLD", 0.48),
    },
    "economic_policy_change": {
        "XAUUSD": ("BUY",  0.70), "XAGUSD": ("BUY",  0.60),
        "BTC":    ("BUY",  0.62), "TLT":    ("BUY",  0.65),
        "SPX":    ("SELL", 0.55),
        "NATGAS": ("HOLD", 0.50), "WTI":    ("HOLD", 0.48),
    },
    "cyber_attack": {
        "XAUUSD": ("BUY",  0.72), "TLT":    ("BUY",  0.68),
        "NOC":    ("BUY",  0.80), "LMT":    ("BUY",  0.75),
        "RTX":    ("BUY",  0.72), "ITA":    ("BUY",  0.78),
        "NDX":    ("SELL", 0.65), "SPX":    ("SELL", 0.60),
        "BTC":    ("SELL", 0.58),
    },
}

# ── Explainable analysis helpers ──────────────────────────────────────────────
# Every number surfaced to the UI is produced here, once, and reused by the
# action, the reasoning chain, the summary and the explainability payload so the
# narrative can never drift from the decision it describes.
_ACTION_CUTOFF = 0.35
_MOVEMENT_WEIGHT = 0.70
_EVENT_WEIGHT = 0.30
_CONFIDENCE_BASE = 0.45
_CONFIDENCE_SLOPE = 0.45
_CONFIDENCE_CAP = 0.95
_HOLD_CONFIDENCE_CAP = 0.55

_MOVEMENT_THRESHOLD_PCT: dict[str, float] = {
    "stock": 0.50, "crypto": 1.00, "forex": 0.15, "commodity": 0.60,
    "bond": 0.35, "etf": 0.45, "equity_index": 0.40,
}
_FRESHNESS: dict[str, float] = {
    "live": 1.0, "delayed": 0.85, "stale": 0.55, "unavailable": 0.0,
}
# Feeds that publish a daily level with no previous close. Their change is
# reported as 0.0, which means "not measured" rather than "flat".
_REFERENCE_ONLY_SOURCES = frozenset({"exchangerate-api"})


@dataclass(frozen=True)
class ActionBreakdown:
    """The exact inputs, terms and thresholds behind one signal decision."""

    priced: bool
    price: float
    change_pct: float
    movement_available: bool
    data_source: str
    threshold_pct: float
    movement_score: float
    movement_clamped: bool
    movement_weight: float
    movement_term: float
    event_matched: bool
    event_applied: bool
    event_title: str | None
    event_category: str | None
    event_severity: float
    event_rule_action: str | None
    event_rule_confidence: float
    event_score: float
    event_weight: float
    event_term: float
    raw_score: float
    action: str
    confidence_base: float
    freshness: float
    confidence: float
    buy_trigger_pct: float | None
    sell_trigger_pct: float | None
    quote_timestamp: str


def _build_action_breakdown(
    asset: AssetDefinition,
    market: dict,
    event: dict | None,
) -> ActionBreakdown:
    price = float(market.get("price") or 0.0)
    threshold_pct = _MOVEMENT_THRESHOLD_PCT.get(asset.category, 0.50)
    status = str(market.get("data_status") or "unavailable")
    source = str(market.get("source") or "unknown")
    freshness = _FRESHNESS.get(status, 0.7)
    event_matched = event is not None
    event_title = str(event["title"]) if event else None
    event_category = str(event["category"]) if event else None
    event_severity = float(event["severity"]) if event else 0.0
    quote_timestamp = _iso_timestamp(market.get("timestamp"))

    if price <= 0 or market.get("status") == "unavailable":
        return ActionBreakdown(
            priced=False, price=price, change_pct=0.0, movement_available=False,
            data_source=source, threshold_pct=threshold_pct,
            movement_score=0.0, movement_clamped=False, movement_weight=1.0, movement_term=0.0,
            event_matched=event_matched, event_applied=False, event_title=event_title,
            event_category=event_category, event_severity=event_severity,
            event_rule_action=None, event_rule_confidence=0.0, event_score=0.0,
            event_weight=0.0, event_term=0.0, raw_score=0.0, action="HOLD",
            confidence_base=_CONFIDENCE_BASE, freshness=freshness, confidence=0.0,
            buy_trigger_pct=None, sell_trigger_pct=None, quote_timestamp=quote_timestamp,
        )

    # A reference-rate feed publishes a daily level without a previous close, so
    # its "0% change" means "not measured", not "flat". Scoring it against a
    # hardcoded base price would turn an 18-month-old constant into a session
    # move and hand every pair a maxed-out directional call.
    change_value = market.get("change")
    movement_available = (
        change_value is not None and source not in _REFERENCE_ONLY_SOURCES
    )
    change_pct = float(change_value or 0.0) if movement_available else 0.0
    raw_movement = change_pct / threshold_pct if threshold_pct else 0.0
    movement_score = max(-1.0, min(1.0, raw_movement))
    movement_clamped = abs(raw_movement) > 1.0

    rule: tuple[str, float] | None = None
    if event:
        rule = _EVENT_ASSET_RULES.get(event["category"], {}).get(asset.symbol)

    if rule:
        rule_action, rule_confidence = rule
        direction = 1.0 if rule_action == "BUY" else -1.0 if rule_action == "SELL" else 0.0
        event_score = direction * rule_confidence * event_severity
        movement_weight, event_weight = _MOVEMENT_WEIGHT, _EVENT_WEIGHT
        event_applied = True
    else:
        rule_action, rule_confidence = None, 0.0
        event_score = 0.0
        movement_weight, event_weight = 1.0, 0.0
        event_applied = False

    movement_term = movement_score * movement_weight
    event_term = event_score * event_weight
    raw_score = movement_term + event_term
    action = (
        "BUY" if raw_score >= _ACTION_CUTOFF
        else "SELL" if raw_score <= -_ACTION_CUTOFF
        else "HOLD"
    )
    confidence_base = _CONFIDENCE_BASE + abs(raw_score) * _CONFIDENCE_SLOPE
    confidence = min(_CONFIDENCE_CAP, confidence_base * freshness)
    if action == "HOLD":
        confidence = min(confidence, _HOLD_CONFIDENCE_CAP * freshness)

    return ActionBreakdown(
        priced=True, price=price, change_pct=change_pct,
        movement_available=movement_available, data_source=source,
        threshold_pct=threshold_pct,
        movement_score=movement_score, movement_clamped=movement_clamped,
        movement_weight=movement_weight, movement_term=movement_term,
        event_matched=event_matched, event_applied=event_applied, event_title=event_title,
        event_category=event_category, event_severity=event_severity,
        event_rule_action=rule_action, event_rule_confidence=rule_confidence,
        event_score=event_score, event_weight=event_weight, event_term=event_term,
        raw_score=raw_score, action=action, confidence_base=confidence_base,
        freshness=freshness, confidence=confidence,
        buy_trigger_pct=_trigger_change_pct(
            _ACTION_CUTOFF, event_term, movement_weight, threshold_pct,
        ) if movement_available else None,
        sell_trigger_pct=_trigger_change_pct(
            -_ACTION_CUTOFF, event_term, movement_weight, threshold_pct,
        ) if movement_available else None,
        quote_timestamp=quote_timestamp,
    )


def _trigger_change_pct(
    target_score: float,
    event_term: float,
    movement_weight: float,
    threshold_pct: float,
) -> float | None:
    """Session change that hits a score cutoff with the event overlay held fixed."""
    if movement_weight <= 0:
        return None
    required = (target_score - event_term) / movement_weight
    if abs(required) > 1.0:
        return None
    return round(required * threshold_pct, 4)


def _direction_word(score: float) -> str:
    if score > 0.05:
        return "bullish"
    if score < -0.05:
        return "bearish"
    return "flat"


def _fmt_price(value: float) -> str:
    if value >= 10000:
        return f"{value:,.0f}"
    if value >= 100:
        return f"{value:,.2f}"
    if value >= 1:
        return f"{value:,.4f}"
    return f"{value:.6f}"


def _pct(value: float) -> str:
    """Half-up percent, matching the rounding the UI applies to the same number."""
    return f"{int(value * 100 + 0.5)}%"


def _build_reasoning_chain(
    asset: AssetDefinition,
    b: ActionBreakdown,
) -> list[dict]:
    status = "unpriced" if not b.priced else f"freshness ×{b.freshness:.2f}"

    if not b.priced:
        return [
            {
                "step": 1, "label": "Market Inputs", "phase": "market_data",
                "description": f"No usable quote for {asset.label}; the signal cannot be priced.",
                "evidence": f"Last known quote {b.quote_timestamp}",
                "metric": "no quote",
            },
            {
                "step": 2, "label": "Decision", "phase": "signal",
                "description": "HOLD with zero confidence until a price is available.",
                "evidence": "Directional calls require a priced quote",
                "metric": "HOLD · 0%",
            },
        ]

    if b.movement_available:
        market_description = (
            f"{asset.label} last printed {_fmt_price(b.price)} "
            f"({b.change_pct:+.2f}% this session) from the {b.data_source} feed."
        )
        movement_description = (
            f"{b.change_pct:+.2f}% divided by the {b.threshold_pct:.2f}% "
            f"{asset.category} threshold gives a {_direction_word(b.movement_score)} "
            f"movement score of {b.movement_score:+.2f}"
            f"{' (clamped at the ±1.00 cap)' if b.movement_clamped else ''}."
        )
        basis = "provider change"
    else:
        market_description = (
            f"{asset.label} last printed {_fmt_price(b.price)}. The {b.data_source} feed "
            f"publishes a reference rate without a previous close, so no session move can "
            f"be measured."
        )
        movement_description = (
            "With no previous close there is no measurable change, so the movement score "
            "stays at 0.00 instead of being inferred from a stale reference price."
        )
        basis = "movement not published"

    steps: list[dict] = [
        {
            "step": 1, "label": "Market Inputs", "phase": "market_data",
            "description": market_description,
            "evidence": (
                f"Quote {b.quote_timestamp} · {status} · basis {basis} · "
                f"threshold {b.threshold_pct:.2f}% for {asset.category}"
            ),
            "metric": f"{b.change_pct:+.2f}%",
        },
        {
            "step": 2, "label": "Movement vs Threshold", "phase": "movement",
            "description": movement_description,
            "evidence": (
                f"Movement term = {b.movement_score:+.2f} × {_pct(b.movement_weight)} "
                f"= {b.movement_term:+.3f}"
            ),
            "metric": f"{b.movement_term:+.3f}",
        },
    ]

    if b.event_applied:
        if b.event_rule_action and b.event_rule_action != "HOLD":
            description = (
                f"{b.event_category.replace('_', ' ')} rule reads {b.event_rule_action} at "
                f"{_pct(b.event_rule_confidence)} conviction with {_pct(b.event_severity)} severity."
            )
        else:
            description = (
                f"{b.event_category.replace('_', ' ')} rule reads HOLD at "
                f"{_pct(b.event_rule_confidence)} conviction — no directional push."
            )
        evidence = (
            f"Event term = {b.event_score:+.3f} × {_pct(b.event_weight)} "
            f"= {b.event_term:+.3f} · {b.event_title}"
        )
        metric = f"{b.event_term:+.3f}"
    elif b.event_matched:
        description = (
            "A verified event matched this asset's sensitivity list, but no directional "
            "rule exists for the pair, so the overlay carries zero weight."
        )
        evidence = f"{b.event_title} · severity {_pct(b.event_severity)} · weight 0%"
        metric = "0.000"
    else:
        description = (
            "No verified event matched this asset in the last 48 hours; the score rests "
            + (
                "on observed market movement alone."
                if b.movement_available
                else "on nothing measurable, so it stays at zero."
            )
        )
        evidence = "Event weight 0% · movement weight 100%"
        metric = "0.000"

    steps.append({
        "step": 3, "label": "Event Overlay", "phase": "event",
        "description": description, "evidence": evidence, "metric": metric,
    })

    hold_note = " · HOLD confidence capped at 55% of freshness" if b.action == "HOLD" else ""
    steps.append({
        "step": 4, "label": "Decision", "phase": "signal",
        "description": (
            f"Movement {b.movement_term:+.3f} plus event {b.event_term:+.3f} gives "
            f"{b.raw_score:+.3f}, which lands {b.action} against the ±{_ACTION_CUTOFF:.2f} cutoff."
        ),
        "evidence": (
            f"Confidence = ({_CONFIDENCE_BASE:.2f} + {_CONFIDENCE_SLOPE:.2f} × "
            f"{abs(b.raw_score):.2f}) × {b.freshness:.2f} = {_pct(b.confidence)}{hold_note}"
        ),
        "metric": f"{b.action} · {_pct(b.confidence)}",
    })
    return steps


def _summarize_reasoning(asset: AssetDefinition, b: ActionBreakdown) -> str:
    if not b.priced:
        return f"No live quote for {asset.label}; HOLD at zero confidence until a price is available."
    if not b.movement_available:
        return (
            f"HOLD {asset.label}: the {b.data_source} feed publishes no previous close, so "
            f"there is no measurable session move; the score stays at {b.raw_score:+.2f} and "
            f"the model holds at {_pct(b.confidence)} confidence."
        )
    overlay = (
        f" The {b.event_category.replace('_', ' ')} overlay {b.event_rule_action} at "
        f"{_pct(b.event_rule_confidence)} adds {b.event_term:+.2f}."
        if b.event_applied and b.event_term
        else ""
    )
    if b.action == "HOLD":
        return (
            f"HOLD {asset.label}: the {b.change_pct:+.2f}% session move scores "
            f"{b.raw_score:+.2f}, inside the ±{_ACTION_CUTOFF:.2f} dead zone, at "
            f"{_pct(b.confidence)} confidence.{overlay}"
        )
    return (
        f"{b.action} {asset.label}: the {b.change_pct:+.2f}% session move against the "
        f"{b.threshold_pct:.2f}% {asset.category} threshold scores {b.movement_term:+.2f}.{overlay} "
        f"Blended score {b.raw_score:+.2f} triggers {b.action} at {_pct(b.confidence)} confidence."
    )


def _build_explainability(
    b: ActionBreakdown,
    market: dict,
    volatility_label: str,
    atr_pct: float,
) -> dict:
    return {
        "priced": b.priced,
        "price": round(b.price, 6),
        "change_pct": round(b.change_pct, 4),
        "movement_available": b.movement_available,
        "change_source": "provider" if b.movement_available else "unavailable",
        "threshold_pct": b.threshold_pct,
        "movement_score": round(b.movement_score, 4),
        "movement_clamped": b.movement_clamped,
        "movement_weight": b.movement_weight,
        "movement_term": round(b.movement_term, 4),
        "event": {
            "matched": b.event_matched,
            "applied": b.event_applied,
            "title": b.event_title,
            "category": b.event_category,
            "severity": round(b.event_severity, 4),
            "rule_action": b.event_rule_action,
            "rule_confidence": b.event_rule_confidence,
            "event_score": round(b.event_score, 4),
            "weight": b.event_weight,
            "term": round(b.event_term, 4),
        },
        "raw_score": round(b.raw_score, 4),
        "action_cutoff": _ACTION_CUTOFF,
        "confidence_base": round(b.confidence_base, 4),
        "confidence_cap": _CONFIDENCE_CAP,
        "hold_cap": _HOLD_CONFIDENCE_CAP,
        "freshness": b.freshness,
        "confidence": round(b.confidence, 4),
        "buy_trigger_pct": b.buy_trigger_pct,
        "sell_trigger_pct": b.sell_trigger_pct,
        "volatility_label": volatility_label,
        "atr_pct": round(atr_pct, 6),
        "data_status": market.get("data_status", "unavailable"),
        "data_source": market.get("source", "unknown"),
        "quote_timestamp": _iso_timestamp(market.get("timestamp")),
        "basis": "observed_market_movement_and_verified_events",
    }


# ── Event → market reaction timeline ─────────────────────────────────────────
def _build_event_timeline(
    event: dict | None,
    asset: AssetDefinition,
    b: ActionBreakdown,
) -> list[dict]:
    timeline = [
        {
            "ts": b.quote_timestamp,
            "label": "Market Quote Updated",
            "detail": (
                f"{asset.label} {b.change_pct:+.2f}% · "
                f"movement term {b.movement_term:+.3f}"
                if b.movement_available
                else f"{asset.label} reference rate · no previous close published"
            ),
            "phase": "market_data",
        },
    ]
    if event:
        timeline.append({
            "ts": event["ts"], "label": "Event Classified",
            "detail": (
                f"{event['title']} · severity {_pct(float(event['severity']))}"
                + (f" · event term {b.event_term:+.3f}" if b.event_applied else " · no rule")
            ),
            "phase": "event",
        })
    timeline.append({
        "ts": datetime.now(UTC).isoformat(),
        "label": f"{b.action} Analysis Generated",
        "detail": (
            f"{asset.label} · score {b.raw_score:+.3f} · "
            f"confidence {_pct(b.confidence)}"
        ),
        "phase": "signal",
    })
    return sorted(timeline, key=lambda row: row["ts"])


@router.get("/all")
async def get_all_signals(
    category: str | None = Query(default=None, description="Filter by asset category"),
    action: str | None   = Query(default=None, description="Filter: BUY | SELL | HOLD"),
    limit: int           = Query(default=300, le=500),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Return enriched trading signals for the full asset universe.

    Each signal includes:
    - Trade setup (entry/stop/target/R:R)
    - Bullish/bearish strength
    - Volatility label
    - Signal reliability metrics
    - Event → market reaction timeline
    - 4-step causal reasoning chain
    """
    cache_key = _make_cache_key("signals_v2_real_v4", category or "all", action or "all", limit)
    cached = await cache_get(cache_key)
    if cached:
        return cached

    universe = get_asset_universe()
    try:
        live_events = await _load_live_events(db, limit=200)
    except Exception as exc:
        logger.warning("signals_v2_event_query_failed", error=str(exc))
        live_events = []

    try:
        market_response = await get_all_markets()
    except Exception as exc:
        logger.error("signals_v2_market_fetch_failed", error=str(exc))
        market_response = {"data": {}}

    market_rows = [
        row
        for rows in market_response.get("data", {}).values()
        if isinstance(rows, list)
        for row in rows
        if isinstance(row, dict) and row.get("symbol")
    ]
    market_by_symbol = {str(row["symbol"]).upper(): row for row in market_rows}
    assets = [_asset_for_market_row(row, universe) for row in market_rows]

    # Filter by category if requested
    if category:
        requested = category.lower()
        assets = [
            asset for asset in assets
            if asset.category.lower() == requested
            or asset.asset_class.lower() == requested
            or _market_class_for_category(asset.category) == requested
        ]

    signals: list[dict] = []

    for asset in assets:
        market = market_by_symbol[asset.symbol.upper()]
        current_price = float(market.get("price") or 0.0)
        priced = current_price > 0 and market.get("status") != "unavailable"
        triggering_event = _pick_event_for_asset(asset, live_events)
        breakdown = _build_action_breakdown(asset, market, triggering_event)
        act, confidence, directional_bias = (
            breakdown.action,
            breakdown.confidence,
            breakdown.raw_score,
        )
        uncertainty = 1.0 - confidence
        realized_vol = _observed_volatility(market)

        if priced:
            setup = compute_trade_setup(
                action=act,
                price=current_price,
                realized_vol=realized_vol,
                directional_bias=directional_bias,
                confidence=confidence,
                win_rate=0.5,
            )
            trade_setup = {
                "current_price": round(current_price, 6),
                "entry_price": setup.entry_price,
                "stop_loss": setup.stop_loss,
                "target_price": setup.target_price,
                "risk_reward": setup.risk_reward_ratio,
                "atr_pct": setup.atr_estimate_pct,
                "max_position_pct": setup.max_position_pct,
            }
            volatility_label = setup.volatility_label
            bullish_strength = setup.bullish_strength
            bearish_strength = setup.bearish_strength
        else:
            trade_setup = {
                "current_price": 0.0, "entry_price": 0.0, "stop_loss": 0.0,
                "target_price": 0.0, "risk_reward": 0.0, "atr_pct": 0.0,
                "max_position_pct": 0.0,
            }
            volatility_label = "UNAVAILABLE"
            bullish_strength = 0.0
            bearish_strength = 0.0

        chain = _build_reasoning_chain(asset, breakdown)
        timeline = _build_event_timeline(triggering_event, asset, breakdown)
        event_title = triggering_event["title"] if triggering_event else "No verified event linked"
        summary = _summarize_reasoning(asset, breakdown)

        sig = {
            # ── Identity ──────────────────────────────────────────────
            "symbol":         asset.symbol,
            "label":          asset.label,
            "asset_class":    asset.category,
            "category":       asset.category,
            "sector":         asset.sector,
            "region":         asset.region,
            "description":    asset.description,
            "geo_sensitivity": asset.geo_sensitivity,
            # ── Signal ────────────────────────────────────────────────
            "action":          act,
            "confidence_pct":  round(confidence * 100, 1),
            "uncertainty_pct": round(uncertainty * 100, 1),
            "time_horizon":    "current session",
            # ── Strength meters ───────────────────────────────────────
            "bullish_strength":  bullish_strength,
            "bearish_strength":  bearish_strength,
            "volatility_label":  volatility_label,
            "vol_spike_prob":    0.0,
            # ── Trade setup ───────────────────────────────────────────
            "trade_setup": trade_setup,
            # ── Reliability ───────────────────────────────────────────
            "reliability": {
                "historical_accuracy": 0.0,
                "win_rate":            0.0,
                "sharpe_ratio":        0.0,
                "max_drawdown":        0.0,
                "basis":               "No validated backtest is configured",
            },
            # ── Trigger ───────────────────────────────────────────────
            "triggering_event": {
                "id":       triggering_event["id"] if triggering_event else "none",
                "title":    event_title,
                "category": triggering_event["category"] if triggering_event else "none",
                "severity": triggering_event["severity"] if triggering_event else 0.0,
                "ts":       triggering_event["ts"] if triggering_event else _iso_timestamp(market.get("timestamp")),
            },
            # ── Reasoning ─────────────────────────────────────────────
            "reasoning_summary":  summary,
            "reasoning_chain":    chain,
            "explainability":     _build_explainability(
                breakdown, market, volatility_label, trade_setup["atr_pct"],
            ),
            # ── Event timeline ────────────────────────────────────────
            "event_timeline":     timeline,
            # ── Related ───────────────────────────────────────────────
            "related_assets":    _find_related(asset, universe),
            # ── Metadata ──────────────────────────────────────────────
            "generated_at": datetime.now(UTC).isoformat(),
            "price": current_price if priced else None,
            "live_change_pct": breakdown.change_pct if priced else None,
            "quote_timestamp": _iso_timestamp(market.get("timestamp")),
            "data_status": market.get("data_status", "unavailable"),
            "data_source": market.get("source", "unknown"),
            "analysis_basis": "observed_market_movement_and_verified_events",
            "actionable": priced and act in ("BUY", "SELL"),
        }
        signals.append(sig)

    # Filter by action if requested
    if action:
        signals = [s for s in signals if s["action"].upper() == action.upper()]

    # Priced assets first, then strongest evidence, while preserving all rows.
    signals.sort(key=lambda s: (s["price"] is not None, s["confidence_pct"]), reverse=True)
    signals = signals[:limit]

    result = {
        "signals":     signals,
        "total":       len(signals),
        "asset_count": len(market_rows),
        "priced_count": sum(1 for signal in signals if signal["price"] is not None),
        "events_used": len(live_events),
        "events_source": "database" if live_events else "none",
        "market_counts": market_response.get("counts", {}),
        "data_as_of":  datetime.now(UTC).isoformat(),
        "not_financial_advice": True,
    }

    await cache_set(cache_key, result, ttl=45)
    return result


@router.get("/universe")
async def get_asset_universe_endpoint() -> dict:
    """Return the full asset universe grouped by category."""
    universe = get_asset_universe()
    return {
        "grouped":    universe.grouped(),
        "total":      len(universe),
        "symbols":    universe.symbols(),
        "data_as_of": datetime.now(UTC).isoformat(),
    }


# ── Helpers ───────────────────────────────────────────────────────────────────

def _pick_event_for_asset(asset: AssetDefinition, events: list[dict]) -> dict | None:
    """Return the most relevant event for an asset based on geo_sensitivity."""
    for evt in events:
        if evt["category"] in asset.geo_sensitivity:
            return evt
    return None


def _asset_for_market_row(row: dict, universe: "AssetUniverse") -> AssetDefinition:
    """Resolve metadata for a real market row without inventing a price."""
    symbol = str(row["symbol"]).upper()
    configured = universe.get_asset(symbol)
    if configured:
        return configured

    market_class = str(row.get("asset_class") or "other").lower()
    category = {
        "stocks": "stock", "crypto": "crypto", "forex": "forex",
        "commodities": "commodity", "bonds": "bond", "etfs": "etf",
        "indices": "equity_index",
    }.get(market_class, market_class)
    name = str(row.get("name") or symbol)
    return AssetDefinition(
        symbol=symbol,
        name=name,
        asset_class=market_class,
        region="global",
        sector=market_class,
        label=name,
        description=f"{name} - {market_class}",
        category=category,
        geo_sensitivity=["political_instability", "economic_policy_change"],
    )


def _market_class_for_category(category: str) -> str:
    return {
        "stock": "stocks", "crypto": "crypto", "forex": "forex",
        "commodity": "commodities", "bond": "bonds", "etf": "etfs",
        "equity_index": "indices",
    }.get(category, category)


def _observed_volatility(market: dict) -> float:
    """Estimate annualized volatility only from the current observed quote range."""
    price = float(market.get("price") or 0.0)
    high = float(market.get("high_24h") or 0.0)
    low = float(market.get("low_24h") or 0.0)
    change = abs(float(market.get("change") or 0.0)) / 100
    range_return = (high - low) / price if price > 0 and high >= low > 0 else 0.0
    daily_observation = max(range_return, change)
    return max(0.01, min(2.0, daily_observation * math.sqrt(252)))


def _iso_timestamp(value: Any) -> str:
    if isinstance(value, (int, float)) and value > 0:
        return datetime.fromtimestamp(value / 1000, tz=UTC).isoformat()
    if isinstance(value, str) and value:
        return value
    return datetime.now(UTC).isoformat()


def _map_classification_to_category(classification: str | None, title: str) -> str:
    raw = (classification or "").strip().lower()
    if raw in _EVENT_ASSET_RULES:
        return raw
    simple_map = {
        "escalation": "military_escalation",
        "tension": "political_instability",
        "normal": "economic_policy_change",
    }
    if raw in simple_map:
        return simple_map[raw]
    return _infer_category_from_title(title)


def _infer_category_from_title(title: str) -> str:
    lower = title.lower()
    keyword_map = [
        ("energy_supply_disruption", ("oil", "gas", "lng", "pipeline", "opec", "refinery", "supply")),
        ("trade_restrictions", ("tariff", "sanction", "export control", "trade", "restriction", "embargo")),
        ("cyber_attack", ("cyber", "ransomware", "ddos", "malware")),
        ("nuclear_threat", ("nuclear", "ballistic", "warhead")),
        ("military_escalation", ("missile", "airstrike", "invasion", "military", "drone", "navy", "army")),
        ("territorial_dispute", ("border", "territorial", "south china sea", "strait")),
        ("diplomatic_breakdown", ("diplomatic", "talks collapsed", "expelled ambassador")),
        ("political_instability", ("protest", "coup", "election crisis", "unrest", "cabinet collapse")),
        ("economic_policy_change", ("central bank", "rate hike", "rate cut", "fiscal", "policy")),
    ]
    for category, keywords in keyword_map:
        if any(kw in lower for kw in keywords):
            return category
    return "political_instability"


async def _load_live_events(db: AsyncSession, limit: int = 200) -> list[dict]:
    """Load recent classified events and map to signal-event payload shape."""
    repo = EventRepository(db)
    now = datetime.now(UTC)
    start = now - timedelta(hours=48)
    rows = await repo.get_timeline(start=start, end=now, limit=limit)

    mapped: list[dict] = []
    for event in rows:
        if event.severity_score is None:
            continue
        category = _map_classification_to_category(event.classification, event.title)
        mapped.append(
            {
                "id": str(event.id),
                "title": event.title,
                "category": category,
                "region": event.region or "global",
                "severity": float(event.severity_score),
                "ts": event.occurred_at.isoformat(),
            }
        )

    mapped.sort(
        key=lambda evt: (
            float(evt.get("severity", 0.0)),
            evt.get("ts", ""),
        ),
        reverse=True,
    )
    return mapped


def _find_related(asset: AssetDefinition, universe: "AssetUniverse") -> list[str]:
    """Return symbols of assets in the same sector or class."""
    related = [
        a.symbol for a in universe.all()
        if a.symbol != asset.symbol and (a.sector == asset.sector or a.region == asset.region)
    ]
    return related[:4]
