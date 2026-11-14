"""Decision-math tests for the signals v2 explainability payload."""
from __future__ import annotations

import pytest

from app.api.v1.signals_v2 import (
    ActionBreakdown,
    _build_action_breakdown,
    _build_reasoning_chain,
    _pct,
    _summarize_reasoning,
)
from app.config.asset_universe import AssetDefinition


def _asset(symbol: str, category: str, base_price: float = 100.0) -> AssetDefinition:
    return AssetDefinition(
        symbol=symbol,
        name=symbol,
        asset_class=category,
        category=category,
        label=symbol,
        base_price=base_price,
    )


def _market(price: float, change: float, status: str = "live") -> dict:
    return {
        "symbol": "X",
        "price": price,
        "change": change,
        "data_status": status,
        "source": "test",
    }


def _event(category: str, severity: float = 0.8) -> dict:
    return {
        "id": "evt-1",
        "title": "Test event",
        "category": category,
        "severity": severity,
        "ts": "2026-11-14T00:00:00Z",
    }


def _score_at_change(asset: AssetDefinition, event: dict | None, change_pct: float) -> float:
    market = _market(asset.base_price, 0.0)
    market["price"] = asset.base_price
    # Bypass the base-price fallback by passing the change directly.
    market["change"] = change_pct
    return _build_action_breakdown(asset, market, event).raw_score


def test_movement_only_buy_uses_clamped_score_and_symmetric_triggers() -> None:
    asset = _asset("XAUUSD", "commodity", base_price=2400.0)
    b = _build_action_breakdown(asset, _market(2400.0, 1.2), None)

    assert b.priced is True
    assert b.movement_score == 1.0
    assert b.movement_clamped is True
    assert b.movement_weight == 1.0
    assert b.event_applied is False
    assert b.raw_score == 1.0
    assert b.action == "BUY"
    assert b.confidence == 0.9
    # 0.35 cutoff on a 0.60% commodity threshold.
    assert b.buy_trigger_pct == 0.21
    assert b.sell_trigger_pct == -0.21


def test_threshold_is_normalised_per_asset_class() -> None:
    stock = _asset("AAPL", "stock", base_price=175.0)
    b = _build_action_breakdown(stock, _market(175.0, 0.25), None)

    assert b.threshold_pct == 0.5
    assert b.movement_score == 0.5
    assert b.movement_clamped is False
    assert b.raw_score == 0.5
    assert b.action == "BUY"
    assert b.buy_trigger_pct == 0.175


def test_flat_market_stays_hold_with_capped_confidence() -> None:
    asset = _asset("AAPL", "stock", base_price=175.0)
    b = _build_action_breakdown(asset, _market(175.0, 0.0), None)

    assert b.raw_score == 0.0
    assert b.action == "HOLD"
    assert b.confidence == 0.45
    assert b.confidence <= 0.55 * b.freshness


def test_event_rule_blends_with_movement_and_reports_terms() -> None:
    asset = _asset("XAUUSD", "commodity", base_price=2400.0)
    b = _build_action_breakdown(asset, _market(2400.0, 0.6), _event("military_escalation", 0.8))

    assert b.event_matched is True
    assert b.event_applied is True
    assert b.event_rule_action == "BUY"
    assert b.event_rule_confidence == 0.88
    assert b.movement_weight == 0.7
    assert b.event_weight == 0.3
    assert round(b.movement_term, 6) == 0.7
    assert round(b.event_term, 6) == 0.2112
    assert round(b.raw_score, 6) == 0.9112
    assert b.action == "BUY"
    # The positive event term lowers the change needed for BUY.
    assert b.buy_trigger_pct is not None and b.buy_trigger_pct < 0.21
    assert _score_at_change(
        asset, _event("military_escalation", 0.8), b.buy_trigger_pct,
    ) == pytest.approx(0.35, abs=1e-3)


def test_event_without_rule_is_recorded_at_zero_weight() -> None:
    asset = _asset("AAA", "bond", base_price=5.0)
    b = _build_action_breakdown(asset, _market(5.0, 0.7), _event("military_escalation", 0.9))

    assert b.event_matched is True
    assert b.event_applied is False
    assert b.event_term == 0.0
    assert b.movement_weight == 1.0
    assert b.raw_score == 1.0
    assert b.buy_trigger_pct == 0.1225


def test_hold_event_rule_pushes_nothing_but_reweights_movement() -> None:
    asset = _asset("BTC", "crypto", base_price=65000.0)
    b = _build_action_breakdown(asset, _market(65000.0, 0.4), _event("military_escalation"))

    assert b.event_applied is True
    assert b.event_rule_action == "HOLD"
    assert b.event_term == 0.0
    assert b.movement_weight == 0.7
    assert round(b.movement_term, 6) == 0.28
    # A 0.40% crypto move scores 0.40, but the event rule trims it to 0.28.
    assert b.action == "HOLD"


def test_unpriced_asset_has_no_direction_or_triggers() -> None:
    asset = _asset("XAUUSD", "commodity", base_price=2400.0)
    b = _build_action_breakdown(asset, _market(0.0, 0.0, status="unavailable"), None)

    assert b.priced is False
    assert b.action == "HOLD"
    assert b.confidence == 0.0
    assert b.buy_trigger_pct is None
    assert b.sell_trigger_pct is None


def test_reasoning_chain_quotes_the_same_numbers_as_the_breakdown() -> None:
    asset = _asset("XAUUSD", "commodity", base_price=2400.0)
    b = _build_action_breakdown(asset, _market(2400.0, 1.2), _event("military_escalation", 0.8))
    chain = _build_reasoning_chain(asset, b)

    assert [step["step"] for step in chain] == [1, 2, 3, 4]
    assert chain[1]["metric"] == f"{b.movement_term:+.3f}"
    assert chain[2]["metric"] == f"{b.event_term:+.3f}"
    assert b.action in chain[3]["metric"]
    assert f"{b.raw_score:+.3f}" in chain[3]["description"]
    assert f"{b.change_pct:+.2f}%" in chain[0]["description"]
    assert "clamped" in chain[1]["description"]


def test_summary_states_the_trigger_and_confidence() -> None:
    asset = _asset("XAUUSD", "commodity", base_price=2400.0)
    b = _build_action_breakdown(asset, _market(2400.0, 1.2), None)
    summary = _summarize_reasoning(asset, b)

    assert summary.startswith("BUY XAUUSD")
    assert f"{b.raw_score:+.2f}" in summary
    assert f"{b.confidence:.0%}" in summary


def test_reference_feed_without_previous_close_is_not_scored_as_a_move() -> None:
    asset = _asset("EURUSD", "forex", base_price=1.08)
    market = _market(1.10, 0.0)
    market["source"] = "exchangerate-api"
    b = _build_action_breakdown(asset, market, None)

    assert b.priced is True
    assert b.movement_available is False
    assert b.change_pct == 0.0
    assert b.raw_score == 0.0
    assert b.action == "HOLD"
    assert b.buy_trigger_pct is None
    assert "without a previous close" in _build_reasoning_chain(asset, b)[0]["description"]
    assert "no measurable session move" in _summarize_reasoning(asset, b)


def test_missing_change_field_means_unmeasured_movement() -> None:
    asset = _asset("XAUUSD", "commodity", base_price=2400.0)
    b = _build_action_breakdown(asset, {"price": 2400.0, "source": "test"}, None)

    assert b.priced is True
    assert b.movement_available is False
    assert b.action == "HOLD"


def test_provider_change_is_always_marked_available() -> None:
    asset = _asset("XAUUSD", "commodity", base_price=2400.0)
    b = _build_action_breakdown(asset, _market(2400.0, 1.2), None)

    assert b.movement_available is True
    assert b.data_source == "test"


def test_percent_formatting_uses_half_up_like_the_ui() -> None:
    # 0.90 confidence on a 0.85-freshness quote is 76.5%, which the UI renders
    # as 77%; the prose must not say 76%.
    assert _pct(0.765) == "77%"
    assert _pct(0.7649) == "76%"
    assert _pct(1.0) == "100%"


def test_breakdown_is_a_frozen_dataclass() -> None:
    asset = _asset("AAPL", "stock", base_price=175.0)
    b: ActionBreakdown = _build_action_breakdown(asset, _market(175.0, 0.3), None)
    try:
        b.action = "SELL"  # type: ignore[misc]
    except Exception:
        pass
    else:
        raise AssertionError("ActionBreakdown should be frozen")
