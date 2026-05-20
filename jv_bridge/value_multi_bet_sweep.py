# -*- coding: utf-8 -*-
"""
value_multi_bet_sweep.py — nopop top1/2/3 を使った券種別 VALUE 戦略を発掘 (Wave29-B)

VALUE (nopop top1 prob >= 0.16) の複勝が avg ROI 152.62% だったが、
他の券種 (馬連・ワイド・3連複) でも nopop top の組合せで強い戦略があるか?

評価する券種:
  1. 複勝: nopop top1 (基準・現状)
  2. 馬連: nopop top1 - top2
  3. ワイド: nopop top1 - top2 / top1 - top3 / top2 - top3 (3 点)
  4. 3連複: nopop top1 - top2 - top3 (1 点ボックス)
  5. 3連単: nopop top1 → top2 → top3 (順序固定)

閾値: nopop top1 prob >= [0.16, 0.20, 0.25, 0.30] でフィルタ

出力: data/jv_cache/value_multi_bet.json
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
OUT_PATH = CACHE / "value_multi_bet.json"

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


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--periods", type=int, default=8)
    args = parser.parse_args(argv)

    try:
        import numpy as np
    except ImportError:
        return 1

    pairs = _load_pairs()
    pairs.sort(key=lambda p: p[0])

    nopop_tup = _load_model_nopop()
    if nopop_tup is None or nopop_tup[0] is None:
        print("no nopop model")
        return 1
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
        # 馬と prob のペアを prob 降順でソート
        order = sorted(range(len(probs)), key=lambda i: -probs[i])
        cache.append({
            "rid": rid,
            "horses": horses,
            "payouts": result.get("payouts") or {},
            "top1_idx": order[0],
            "top2_idx": order[1],
            "top3_idx": order[2],
            "top1_prob": probs[order[0]],
            "top2_prob": probs[order[1]],
            "top3_prob": probs[order[2]],
        })
    print(f"  Cached {len(cache)} races")

    def get_num(horses, idx):
        if idx >= len(horses): return None
        n = horses[idx].get("number")
        try: return int(n)
        except (TypeError, ValueError): return None

    # 戦略定義: (name, bet_fn(c) → (invest, returned, hit), 説明)
    def bet_fuku(c):
        inv, ret = 0, 0
        n = get_num(c["horses"], c["top1_idx"])
        if n is None: return (0, 0, False)
        inv = 100
        r = _payout_fuku(c["payouts"], n)
        return (inv, r, r > 0)

    def bet_uren(c):
        n1 = get_num(c["horses"], c["top1_idx"])
        n2 = get_num(c["horses"], c["top2_idx"])
        if n1 is None or n2 is None: return (0, 0, False)
        r = _payout_uren(c["payouts"], n1, n2)
        return (100, r, r > 0)

    def bet_wide_3pt(c):
        n1 = get_num(c["horses"], c["top1_idx"])
        n2 = get_num(c["horses"], c["top2_idx"])
        n3 = get_num(c["horses"], c["top3_idx"])
        if None in (n1, n2, n3): return (0, 0, False)
        r = _payout_wide(c["payouts"], n1, n2) + _payout_wide(c["payouts"], n1, n3) + _payout_wide(c["payouts"], n2, n3)
        return (300, r, r > 0)

    def bet_fuku3(c):
        n1 = get_num(c["horses"], c["top1_idx"])
        n2 = get_num(c["horses"], c["top2_idx"])
        n3 = get_num(c["horses"], c["top3_idx"])
        if None in (n1, n2, n3): return (0, 0, False)
        r = _payout_fuku3(c["payouts"], n1, n2, n3)
        return (100, r, r > 0)

    def bet_tan3(c):
        n1 = get_num(c["horses"], c["top1_idx"])
        n2 = get_num(c["horses"], c["top2_idx"])
        n3 = get_num(c["horses"], c["top3_idx"])
        if None in (n1, n2, n3): return (0, 0, False)
        r = _payout_tan3(c["payouts"], n1, n2, n3)
        return (100, r, r > 0)

    bet_fns = [
        ("複勝 nopop top1", bet_fuku, 100),
        ("馬連 nopop top1-top2", bet_uren, 100),
        ("ワイド 3点 nopop top123", bet_wide_3pt, 300),
        ("3連複 ボックス nopop top123", bet_fuku3, 100),
        ("3連単 nopop top1->2->3", bet_tan3, 100),
    ]

    thresholds = [0.16, 0.20, 0.25, 0.30]
    period_size = len(cache) // args.periods
    results = {}
    for name, bet_fn, _unit in bet_fns:
        results[name] = {}
        for th in thresholds:
            period_rois = []
            period_bets = []
            for p in range(1, args.periods):
                lo = p * period_size
                hi = (p + 1) * period_size if p < args.periods - 1 else len(cache)
                inv, ret, bets = 0, 0, 0
                for c in cache[lo:hi]:
                    if c["top1_prob"] < th: continue
                    i, r, h = bet_fn(c)
                    if i > 0:
                        inv += i
                        ret += r
                        bets += 1
                if inv > 0:
                    period_rois.append(ret / inv * 100)
                    period_bets.append(bets)
            if period_rois:
                avg = sum(period_rois) / len(period_rois)
                sigma = (sum((r - avg) ** 2 for r in period_rois) / len(period_rois)) ** 0.5
                results[name][f"th_{th}"] = {
                    "threshold": th,
                    "mean_roi_pct": round(avg, 2),
                    "worst_roi_pct": round(min(period_rois), 2),
                    "best_roi_pct": round(max(period_rois), 2),
                    "roi_std": round(sigma, 2),
                    "win_periods": sum(1 for r in period_rois if r >= 100),
                    "active_periods": len(period_rois),
                    "total_bets": sum(period_bets),
                    "period_rois": [round(r, 2) for r in period_rois],
                }
            else:
                results[name][f"th_{th}"] = None

    # 表示
    print()
    print("=" * 110)
    print(f"{'券種':<32}{'閾値':<8}{'avg':<10}{'worst':<10}{'σ':<8}{'勝':<8}{'件数':<10}")
    print("=" * 110)
    for name, by_th in results.items():
        for th_key, r in by_th.items():
            th = float(th_key.replace("th_", ""))
            if r is None:
                print(f"{name:<32}{th:<8.2f}---")
                continue
            win = f"{r['win_periods']}/{r['active_periods']}"
            print(f"{name:<32}{th:<8.2f}{r['mean_roi_pct']:<10.2f}{r['worst_roi_pct']:<10.2f}{r['roi_std']:<8.2f}{win:<8}{r['total_bets']:<10}")
    print("=" * 110)

    # ベスト戦略を探す: 件数 >= 200 で avg ROI 最大
    best_overall = None
    for name, by_th in results.items():
        for th_key, r in by_th.items():
            if r is None or r.get("total_bets", 0) < 200: continue
            if best_overall is None or r["mean_roi_pct"] > best_overall["mean_roi_pct"]:
                best_overall = {**r, "bet_type": name}

    if best_overall:
        print(f"\n=== BEST ===")
        print(f"  {best_overall['bet_type']} (閾値 {best_overall['threshold']})")
        print(f"  avg {best_overall['mean_roi_pct']}% / 件数 {best_overall['total_bets']} / 勝 {best_overall['win_periods']}/{best_overall['active_periods']}")

    out = {
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
        "results": results,
        "best": best_overall,
    }
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nSaved: {OUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
