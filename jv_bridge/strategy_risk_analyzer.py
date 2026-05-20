# -*- coding: utf-8 -*-
"""
strategy_risk_analyzer.py — 戦略のリスク総合分析 (Wave30-E/F/G)

E. Walk-forward 16 期間検証 — 統計信頼性を倍にする
F. Kelly criterion 資金管理 — 各戦略の最適投資比率を計算
G. 連敗ドローダウン分析 — 最大連敗・最大ドローダウンを定量化

評価対象戦略:
  - V-複勝 (nopop top1, 閾値 0.16)
  - V-馬連 (nopop top1-top2, 閾値 0.16)
  - V-馬連 厳選 (nopop top1-top2, 閾値 0.30)
  - V-3連単 (nopop top1->2->3, 閾値 0.20)
  - V-DOUBLE 併買 (複勝+馬連, 閾値 0.16)

出力: data/jv_cache/strategy_risk_analysis.json
"""
from __future__ import annotations

import argparse
import io
import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

os.environ["PYTHONIOENCODING"] = "utf-8"
for _attr in ("stdout", "stderr"):
    _s = getattr(sys, _attr, None)
    if _s is None: continue
    try: _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception: pass

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
CACHE = ROOT / "data" / "jv_cache"
RACES_DIR = CACHE / "races"
RESULTS_DIR = CACHE / "results"
OUT_PATH = CACHE / "strategy_risk_analysis.json"

sys.path.insert(0, str(HERE.parent))
from jv_bridge.train_lightgbm import (  # noqa: E402
    FEATURE_NAMES, extract_horse_features, _race_context,
)
from jv_bridge.predict_lightgbm import (  # noqa: E402
    _load_model_nopop, _predict_one, _mask_pop_features,
)
from jv_bridge.validate_lightgbm import (  # noqa: E402
    _payout_fuku, _payout_uren, _payout_tan3, _load_features_index,
)


def _load_pairs():
    pairs = []
    for race_file in sorted(RACES_DIR.glob("*.json")):
        rid = race_file.stem
        result_file = RESULTS_DIR / f"{rid}.json"
        if not result_file.exists(): continue
        try:
            race = json.loads(race_file.read_text(encoding="utf-8"))
            result = json.loads(result_file.read_text(encoding="utf-8"))
            if not race.get("horses") or not (result.get("payouts") or {}):
                continue
            pairs.append((rid, race, result))
        except Exception:
            continue
    return pairs


def _softmax(probs):
    s = sum(p for p in probs if p > 0)
    if s <= 0: return [1.0 / max(1, len(probs)) for _ in probs]
    return [max(0.0, p) / s for p in probs]


def _get_num(horses, idx):
    if idx >= len(horses): return None
    n = horses[idx].get("number")
    try: return int(n)
    except (TypeError, ValueError): return None


# === bet 関数群: 1 レースで (invest, payout) を返す ===
def bet_fuku(c, threshold):
    if c["top1_prob"] < threshold: return None
    n = _get_num(c["horses"], c["top1_idx"])
    if n is None: return None
    return (100, _payout_fuku(c["payouts"], n))


def bet_uren(c, threshold):
    if c["top1_prob"] < threshold: return None
    n1 = _get_num(c["horses"], c["top1_idx"])
    n2 = _get_num(c["horses"], c["top2_idx"])
    if None in (n1, n2): return None
    return (100, _payout_uren(c["payouts"], n1, n2))


def bet_tan3(c, threshold):
    if c["top1_prob"] < threshold: return None
    n1 = _get_num(c["horses"], c["top1_idx"])
    n2 = _get_num(c["horses"], c["top2_idx"])
    n3 = _get_num(c["horses"], c["top3_idx"])
    if None in (n1, n2, n3): return None
    return (100, _payout_tan3(c["payouts"], n1, n2, n3))


def bet_double(c, threshold):
    """複勝 + 馬連 併買"""
    if c["top1_prob"] < threshold: return None
    n1 = _get_num(c["horses"], c["top1_idx"])
    n2 = _get_num(c["horses"], c["top2_idx"])
    if None in (n1, n2): return None
    inv = 200
    ret = _payout_fuku(c["payouts"], n1) + _payout_uren(c["payouts"], n1, n2)
    return (inv, ret)


# === Walk-forward N 期間評価 ===
def walk_forward_n(cache, bet_fn, threshold, n_periods):
    period_size = len(cache) // n_periods
    period_rois = []
    period_bets = []
    period_invests = []
    bet_history = []  # 全 (invest, ret) の時系列 (ドローダウン用)
    for p in range(1, n_periods):
        lo = p * period_size
        hi = (p + 1) * period_size if p < n_periods - 1 else len(cache)
        inv, ret, bets = 0, 0, 0
        for c in cache[lo:hi]:
            res = bet_fn(c, threshold)
            if res is None: continue
            i, r = res
            inv += i
            ret += r
            bets += 1
            bet_history.append((i, r))
        if inv > 0:
            period_rois.append(ret / inv * 100)
            period_bets.append(bets)
            period_invests.append(inv)
    return period_rois, period_bets, period_invests, bet_history


def calc_kelly(rois, hit_rate=None):
    """Half-Kelly: f = (mean_return - 1) / sigma^2 を半分
    rois: 各期間 ROI (% 単位)
    """
    if not rois: return None
    rs = [r / 100.0 for r in rois]
    avg = sum(rs) / len(rs)
    var = sum((r - avg) ** 2 for r in rs) / len(rs)
    if var < 1e-9: return None
    # Kelly fraction f = (mean - 1) / variance (mean は returns: 1.0 + ROI%)
    # ここでは ROI は "払戻 / 投資" なので mean が return
    f = (avg - 1) / var
    half_f = f * 0.5
    quarter_f = f * 0.25
    return {
        "kelly_full": round(f, 4),
        "kelly_half": round(half_f, 4),
        "kelly_quarter": round(quarter_f, 4),
        "advice": (
            "破産危険・見送り" if f <= 0 else
            f"Half-Kelly 推奨投資率 {half_f*100:.1f}%/レース (¥1000 中 ¥{int(half_f*1000)})"
        ),
    }


def calc_drawdown(bet_history):
    """全 bet の時系列から最大ドローダウン・最大連敗を計算"""
    if not bet_history:
        return None
    # 累積収支
    cum = 0
    cum_history = []
    for inv, ret in bet_history:
        cum += (ret - inv)
        cum_history.append(cum)
    # 最大ドローダウン: peak からの最大下落
    max_dd = 0
    peak = 0
    for c in cum_history:
        if c > peak: peak = c
        dd = peak - c
        if dd > max_dd: max_dd = dd
    # 最大連敗
    losses = []
    cur_loss = 0
    for inv, ret in bet_history:
        if ret < inv:
            cur_loss += 1
        else:
            if cur_loss > 0: losses.append(cur_loss)
            cur_loss = 0
    if cur_loss > 0: losses.append(cur_loss)
    max_streak = max(losses) if losses else 0
    # 最大連勝
    wins = []
    cur_win = 0
    for inv, ret in bet_history:
        if ret > inv:
            cur_win += 1
        else:
            if cur_win > 0: wins.append(cur_win)
            cur_win = 0
    if cur_win > 0: wins.append(cur_win)
    max_win_streak = max(wins) if wins else 0
    # 最終収支
    final_balance = cum_history[-1] if cum_history else 0
    total_invest = sum(inv for inv, _ in bet_history)
    return {
        "max_drawdown_jpy": int(max_dd),
        "max_losing_streak": max_streak,
        "max_winning_streak": max_win_streak,
        "final_balance_jpy": int(final_balance),
        "total_invested_jpy": int(total_invest),
        "total_bets": len(bet_history),
    }


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--periods", type=int, default=16)
    args = parser.parse_args(argv)

    try:
        import numpy as np
    except ImportError:
        return 1

    pairs = _load_pairs()
    pairs.sort(key=lambda p: p[0])
    nopop_tup = _load_model_nopop()
    if nopop_tup is None or nopop_tup[0] is None: return 1
    features_index = _load_features_index()

    print(f"Predicting {len(pairs)} races (nopop)...")
    cache = []
    for i, (rid, race, result) in enumerate(pairs):
        if i % 300 == 0: print(f"  {i}/{len(pairs)}")
        horses = race.get("horses") or []
        if len(horses) < 3: continue
        ctx = _race_context(race)
        X = [extract_horse_features(h, race, features_index, ctx) for h in horses]
        X_arr = np.array(X, dtype="float64")
        X_nopop = _mask_pop_features(X_arr, np)
        m, k = nopop_tup
        raw = list(_predict_one(m, k, X_nopop))
        probs = _softmax([float(p) for p in raw])
        order = sorted(range(len(probs)), key=lambda i: -probs[i])
        cache.append({
            "rid": rid, "horses": horses, "payouts": result.get("payouts") or {},
            "top1_idx": order[0], "top2_idx": order[1], "top3_idx": order[2],
            "top1_prob": probs[order[0]],
        })
    print(f"  Cached {len(cache)} races")

    # 評価対象戦略
    strategies = [
        ("V-複勝 (閾値 0.16)", bet_fuku, 0.16),
        ("V-馬連 (閾値 0.16)", bet_uren, 0.16),
        ("V-馬連 厳選 (閾値 0.30)", bet_uren, 0.30),
        ("V-3連単 (閾値 0.20)", bet_tan3, 0.20),
        ("V-DOUBLE 複勝+馬連 (閾値 0.16)", bet_double, 0.16),
    ]

    results = {}
    for name, bet_fn, threshold in strategies:
        print(f"\nEvaluating: {name}")
        # 8 + 16 期間 両方
        results[name] = {}
        for n_periods in [8, 16]:
            period_rois, period_bets, period_invests, bet_history = walk_forward_n(
                cache, bet_fn, threshold, n_periods
            )
            if not period_rois:
                results[name][f"{n_periods}_periods"] = None
                continue
            avg = sum(period_rois) / len(period_rois)
            sigma = (sum((r - avg) ** 2 for r in period_rois) / len(period_rois)) ** 0.5
            kelly = calc_kelly(period_rois)
            dd = calc_drawdown(bet_history)
            results[name][f"{n_periods}_periods"] = {
                "mean_roi_pct": round(avg, 2),
                "worst_roi_pct": round(min(period_rois), 2),
                "best_roi_pct": round(max(period_rois), 2),
                "roi_std": round(sigma, 2),
                "win_periods": sum(1 for r in period_rois if r >= 100),
                "active_periods": len(period_rois),
                "total_bets": sum(period_bets),
                "period_rois": [round(r, 2) for r in period_rois],
                "kelly": kelly,
                "drawdown": dd,
            }

    # 結果表示
    print()
    print("=" * 120)
    print(f"{'戦略':<35}{'期間':<6}{'avg':<10}{'worst':<10}{'σ':<8}{'勝':<8}{'件数':<8}{'最大連敗':<10}{'最大DD':<12}{'Kelly':<10}")
    print("=" * 120)
    for name, by_per in results.items():
        for periods_key in ["8_periods", "16_periods"]:
            r = by_per.get(periods_key)
            if r is None: continue
            n = periods_key.replace("_periods", "")
            win = f"{r['win_periods']}/{r['active_periods']}"
            dd_jpy = r['drawdown']['max_drawdown_jpy'] if r['drawdown'] else 0
            ls = r['drawdown']['max_losing_streak'] if r['drawdown'] else 0
            kf = r['kelly']['kelly_half'] if r['kelly'] else None
            kf_str = f"{kf*100:.1f}%" if kf and kf > 0 else "見送り"
            print(f"{name:<35}{n:<6}{r['mean_roi_pct']:<10.2f}{r['worst_roi_pct']:<10.2f}{r['roi_std']:<8.2f}{win:<8}{r['total_bets']:<8}{ls:<10}{dd_jpy:<12}{kf_str:<10}")
    print("=" * 120)

    out = {
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
        "strategies": results,
    }
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nSaved: {OUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
