# -*- coding: utf-8 -*-
"""
ensemble_weight_tune.py — primary + nopop の混合重み α を最適化 (Wave26-C)

primary (人気込) と nopop (人気抜き) の予測確率を α : (1-α) で混合する。
α を 0.0-1.0 で 0.05 刻みで Walk-forward 8 期間評価し、平均 ROI が
最大になる α を見つける。

戦略は「複勝 top1 prob >= 0.22 で買う」(fuku_top1_prob_022 相当)

使い方:
  py -3.12 jv_bridge\\ensemble_weight_tune.py

出力:
  data/jv_cache/ensemble_weight_best.json
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
    if _s is None:
        continue
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
CACHE = ROOT / "data" / "jv_cache"
RACES_DIR = CACHE / "races"
RESULTS_DIR = CACHE / "results"
OUT_PATH = CACHE / "ensemble_weight_best.json"

sys.path.insert(0, str(HERE.parent))
from jv_bridge.train_lightgbm import (  # noqa: E402
    FEATURE_NAMES, extract_horse_features, _race_context,
)
from jv_bridge.predict_lightgbm import (  # noqa: E402
    _load_model, _load_model_nopop, _predict_one, _mask_pop_features,
)
from jv_bridge.validate_lightgbm import (  # noqa: E402
    _payout_fuku, _load_features_index,
)


def _load_pairs():
    pairs = []
    for race_file in sorted(RACES_DIR.glob("*.json")):
        rid = race_file.stem
        result_file = RESULTS_DIR / f"{rid}.json"
        if not result_file.exists():
            continue
        try:
            race = json.loads(race_file.read_text(encoding="utf-8"))
            result = json.loads(result_file.read_text(encoding="utf-8"))
            if not race.get("horses") or not (result.get("payouts") or {}):
                continue
            pairs.append((rid, race, result))
        except Exception:
            continue
    return pairs


def _predict_both(race, model_tup, model_nopop_tup, features_index, np):
    """1 レース全頭の primary と nopop の生 prob (softmax前) を返す"""
    horses = race.get("horses") or []
    if not horses:
        return None, None
    ctx = _race_context(race)
    X = [extract_horse_features(h, race, features_index, ctx) for h in horses]
    X_arr = np.array(X, dtype="float64")
    m, k = model_tup
    raw_p = list(_predict_one(m, k, X_arr))
    if model_nopop_tup and model_nopop_tup[0]:
        X_nopop = _mask_pop_features(X_arr, np)
        m2, k2 = model_nopop_tup
        raw_n = list(_predict_one(m2, k2, X_nopop))
    else:
        raw_n = list(raw_p)  # nopop なしなら primary と同じ
    return [float(p) for p in raw_p], [float(p) for p in raw_n]


def _softmax(probs):
    s = sum(p for p in probs if p > 0)
    if s <= 0:
        return [1.0 / max(1, len(probs)) for _ in probs]
    return [max(0.0, p) / s for p in probs]


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--threshold", type=float, default=0.22,
                        help="複勝 top1 prob 閾値 (default 0.22)")
    parser.add_argument("--periods", type=int, default=8)
    args = parser.parse_args(argv)

    try:
        import numpy as np  # type: ignore
    except ImportError:
        print("[ensemble] numpy 必要")
        return 1

    pairs = _load_pairs()
    pairs.sort(key=lambda p: p[0])
    if not pairs:
        print("[ensemble] No data")
        return 1
    print(f"[ensemble] {len(pairs)} pairs")

    model_tup = _load_model()
    if model_tup is None or model_tup[0] is None:
        print("[ensemble] No primary model")
        return 1
    model_nopop_tup = _load_model_nopop()
    features_index = _load_features_index()

    # 1 回だけ全 race 予測してキャッシュ
    print("[ensemble] Predicting all races (1 time)...")
    cache = []  # [(rid, p_idx, raw_primary, raw_nopop, horses, payouts)]
    n_periods = args.periods
    period_size = len(pairs) // n_periods
    for i, (rid, race, result) in enumerate(pairs):
        if i % 300 == 0:
            print(f"  {i}/{len(pairs)}")
        raw_p, raw_n = _predict_both(race, model_tup, model_nopop_tup, features_index, np)
        if raw_p is None:
            continue
        p_idx = i // period_size
        if p_idx >= n_periods:
            p_idx = n_periods - 1
        cache.append({
            "rid": rid,
            "period": p_idx,
            "raw_p": raw_p,
            "raw_n": raw_n,
            "horses": race.get("horses") or [],
            "payouts": result.get("payouts") or {},
        })
    print(f"  Cached {len(cache)} races")

    # α を 0.0 〜 1.0 で 0.05 刻みで評価 (warmup 期間 0 は除外)
    alphas = [round(i * 0.05, 4) for i in range(21)]
    results = []
    for alpha in alphas:
        rois = []
        bets_total = 0
        for p in range(1, n_periods):
            inv, ret, bets = 0, 0, 0
            for c in cache:
                if c["period"] != p:
                    continue
                raw_p = c["raw_p"]
                raw_n = c["raw_n"]
                mixed = [alpha * a + (1 - alpha) * b for a, b in zip(raw_p, raw_n)]
                probs = _softmax(mixed)
                best_i = max(range(len(probs)), key=lambda i: probs[i])
                if probs[best_i] < args.threshold:
                    continue
                top_num = c["horses"][best_i].get("number")
                try:
                    top_num_int = int(top_num)
                except (TypeError, ValueError):
                    continue
                inv += 100
                r = _payout_fuku(c["payouts"], top_num_int)
                ret += r
                bets += 1
            if inv > 0:
                rois.append(ret / inv * 100)
                bets_total += bets
        if rois:
            avg_roi = sum(rois) / len(rois)
            worst = min(rois)
            best = max(rois)
            sigma = (sum((r - avg_roi) ** 2 for r in rois) / len(rois)) ** 0.5
            win_periods = sum(1 for r in rois if r >= 100)
            results.append({
                "alpha": alpha,
                "avg_roi_pct": round(avg_roi, 2),
                "worst_roi_pct": round(worst, 2),
                "best_roi_pct": round(best, 2),
                "sigma": round(sigma, 2),
                "win_periods": win_periods,
                "total_periods": len(rois),
                "total_bets": bets_total,
                "rois": [round(r, 2) for r in rois],
            })
        else:
            results.append({"alpha": alpha, "avg_roi_pct": 0, "total_bets": 0})

    # ベスト α: 件数 >= 100 で avg ROI 最大
    valid = [r for r in results if r.get("total_bets", 0) >= 100]
    best_alpha = max(valid, key=lambda r: r["avg_roi_pct"]) if valid else None

    print()
    print(f"=== Ensemble Weight Sweep (threshold={args.threshold}) ===")
    print(f"{'α':<8}{'avg ROI':<12}{'worst':<12}{'σ':<8}{'勝':<6}{'件数':<8}")
    for r in results:
        if r.get("total_bets", 0) == 0:
            continue
        win = f"{r.get('win_periods', 0)}/{r.get('total_periods', 0)}"
        print(f"{r['alpha']:<8}{r['avg_roi_pct']:<12.2f}{r['worst_roi_pct']:<12.2f}{r['sigma']:<8.2f}{win:<6}{r['total_bets']:<8}")

    if best_alpha:
        print()
        print(f"=== BEST: α = {best_alpha['alpha']} ===")
        print(f"  avg ROI: {best_alpha['avg_roi_pct']}%")
        print(f"  worst:   {best_alpha['worst_roi_pct']}%")
        print(f"  σ:       {best_alpha['sigma']}")
        print(f"  勝期間:  {best_alpha['win_periods']}/{best_alpha['total_periods']}")
        print(f"  件数:    {best_alpha['total_bets']}")
        print(f"  ROIs:    {best_alpha['rois']}")

    out = {
        "found_at": datetime.now(timezone.utc).isoformat(),
        "threshold": args.threshold,
        "strategy": "fuku_top1_prob_022",
        "results": results,
        "best": best_alpha,
    }
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n[ensemble] Saved: {OUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
