# -*- coding: utf-8 -*-
"""
value_combo_sweep.py — VALUE 戦略の併買 (DOUBLE) で σ を下げる (Wave30-B)

単独戦略の弱点:
  - V-馬連HOT 222% は σ 92 (1 期間で 66% まで落ちる)
  - V-3連単 308% は σ 191 (1 期間で 40% まで落ちる)

併買 (複数券種を同時に買う) で:
  - 期待値合計は変わらない (足し合わせ)
  - σ は分散効果で下がる (相関 < 1 なら)

評価する併買戦略:
  - 複勝 + 馬連 (200 円投資)
  - 複勝 + 馬連 + 3連単 (300 円投資)
  - 複勝 + 馬連 + ワイド (500 円投資)
  - 複勝 + 馬連 + 3連単 + ワイド (600 円投資)

各併買戦略について Walk-forward 7 期間で評価し、ベスト組合せを発見

出力: data/jv_cache/value_combo.json
"""
from __future__ import annotations

import argparse
import io
import json
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
OUT_PATH = CACHE / "value_combo.json"

sys.path.insert(0, str(HERE.parent))
from jv_bridge.train_lightgbm import (  # noqa: E402
    FEATURE_NAMES, extract_horse_features, _race_context,
)
from jv_bridge.predict_lightgbm import (  # noqa: E402
    _load_model_nopop, _predict_one, _mask_pop_features,
)
from jv_bridge.validate_lightgbm import (  # noqa: E402
    _payout_fuku, _payout_uren, _payout_wide,
    _payout_fuku3, _payout_tan3, _load_features_index,
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


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--periods", type=int, default=8)
    parser.add_argument("--threshold", type=float, default=0.16)
    args = parser.parse_args(argv)

    try:
        import numpy as np
    except ImportError:
        return 1

    pairs = _load_pairs()
    pairs.sort(key=lambda p: p[0])
    nopop_tup = _load_model_nopop()
    if nopop_tup is None or nopop_tup[0] is None:
        return 1
    features_index = _load_features_index()

    print(f"Predicting {len(pairs)} races...")
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

    # 各券種の bet 関数 (invest, returned)
    def bet_fuku(c):
        n = _get_num(c["horses"], c["top1_idx"])
        if n is None: return (0, 0)
        return (100, _payout_fuku(c["payouts"], n))

    def bet_uren(c):
        n1 = _get_num(c["horses"], c["top1_idx"])
        n2 = _get_num(c["horses"], c["top2_idx"])
        if None in (n1, n2): return (0, 0)
        return (100, _payout_uren(c["payouts"], n1, n2))

    def bet_wide_3pt(c):
        n1 = _get_num(c["horses"], c["top1_idx"])
        n2 = _get_num(c["horses"], c["top2_idx"])
        n3 = _get_num(c["horses"], c["top3_idx"])
        if None in (n1, n2, n3): return (0, 0)
        r = _payout_wide(c["payouts"], n1, n2) + _payout_wide(c["payouts"], n1, n3) + _payout_wide(c["payouts"], n2, n3)
        return (300, r)

    def bet_fuku3_box(c):
        n1 = _get_num(c["horses"], c["top1_idx"])
        n2 = _get_num(c["horses"], c["top2_idx"])
        n3 = _get_num(c["horses"], c["top3_idx"])
        if None in (n1, n2, n3): return (0, 0)
        return (100, _payout_fuku3(c["payouts"], n1, n2, n3))

    def bet_tan3(c):
        n1 = _get_num(c["horses"], c["top1_idx"])
        n2 = _get_num(c["horses"], c["top2_idx"])
        n3 = _get_num(c["horses"], c["top3_idx"])
        if None in (n1, n2, n3): return (0, 0)
        return (100, _payout_tan3(c["payouts"], n1, n2, n3))

    # 併買戦略を定義
    combos = [
        ("V-複勝 単体", [bet_fuku]),
        ("V-馬連 単体", [bet_uren]),
        ("V-3連単 単体", [bet_tan3]),
        ("V-DOUBLE 複勝+馬連", [bet_fuku, bet_uren]),
        ("V-TRIPLE 複勝+馬連+ワイド", [bet_fuku, bet_uren, bet_wide_3pt]),
        ("V-QUAD 複勝+馬連+ワイド+3連複", [bet_fuku, bet_uren, bet_wide_3pt, bet_fuku3_box]),
        ("V-MEGA 複勝+馬連+3連単", [bet_fuku, bet_uren, bet_tan3]),
        ("V-ULTRA 複勝+馬連+ワイド+3連単", [bet_fuku, bet_uren, bet_wide_3pt, bet_tan3]),
        ("V-MAX 5 券種全部", [bet_fuku, bet_uren, bet_wide_3pt, bet_fuku3_box, bet_tan3]),
    ]

    period_size = len(cache) // args.periods
    results = []
    for name, bet_fns in combos:
        period_rois = []
        period_bets = []
        period_invests = []
        for p in range(1, args.periods):
            lo = p * period_size
            hi = (p + 1) * period_size if p < args.periods - 1 else len(cache)
            inv, ret, bets = 0, 0, 0
            for c in cache[lo:hi]:
                if c["top1_prob"] < args.threshold: continue
                race_inv, race_ret = 0, 0
                for fn in bet_fns:
                    i, r = fn(c)
                    race_inv += i
                    race_ret += r
                if race_inv > 0:
                    inv += race_inv
                    ret += race_ret
                    bets += 1
            if inv > 0:
                period_rois.append(ret / inv * 100)
                period_bets.append(bets)
                period_invests.append(inv)
        if period_rois:
            avg = sum(period_rois) / len(period_rois)
            sigma = (sum((r - avg) ** 2 for r in period_rois) / len(period_rois)) ** 0.5
            results.append({
                "name": name,
                "mean_roi_pct": round(avg, 2),
                "worst_roi_pct": round(min(period_rois), 2),
                "best_roi_pct": round(max(period_rois), 2),
                "roi_std": round(sigma, 2),
                "win_periods": sum(1 for r in period_rois if r >= 100),
                "active_periods": len(period_rois),
                "total_bets": sum(period_bets),
                "total_invested": sum(period_invests),
                "period_rois": [round(r, 2) for r in period_rois],
                "unit_per_race": sum(period_invests) // max(1, sum(period_bets)),
            })

    # 表示
    print()
    print("=" * 110)
    print(f"{'戦略':<35}{'avg':<10}{'worst':<10}{'σ':<8}{'勝':<8}{'単R投資':<10}{'件数':<10}")
    print("=" * 110)
    for r in results:
        win = f"{r['win_periods']}/{r['active_periods']}"
        print(f"{r['name']:<35}{r['mean_roi_pct']:<10.2f}{r['worst_roi_pct']:<10.2f}{r['roi_std']:<8.2f}{win:<8}{r['unit_per_race']:<10}{r['total_bets']:<10}")
    print("=" * 110)

    # ベスト 3 (avg ROI 高い順 + 件数 >= 500)
    valid = [r for r in results if r["total_bets"] >= 500]
    if valid:
        sorted_results = sorted(valid, key=lambda r: -r["mean_roi_pct"])
        print(f"\n=== TOP 3 (件数 >= 500) ===")
        for i, r in enumerate(sorted_results[:3]):
            print(f"  {i+1}. {r['name']}: avg {r['mean_roi_pct']}% / σ {r['roi_std']} / 勝 {r['win_periods']}/{r['active_periods']}")

    # σ 最小 (件数 >= 500・avg >= 100)
    stable = [r for r in results if r["total_bets"] >= 500 and r["mean_roi_pct"] >= 100]
    if stable:
        best_stable = min(stable, key=lambda r: r["roi_std"])
        print(f"\n=== 最も安定 (σ 最小・avg 100%+) ===")
        print(f"  {best_stable['name']}: avg {best_stable['mean_roi_pct']}% / σ {best_stable['roi_std']} / 勝 {best_stable['win_periods']}/{best_stable['active_periods']}")

    out = {
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
        "threshold": args.threshold,
        "results": results,
    }
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nSaved: {OUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
