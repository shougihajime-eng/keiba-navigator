# -*- coding: utf-8 -*-
"""
value_threshold_sweep.py — value_invest 戦略 (nopop 単独) の最適閾値スイープ (Wave27-3)

ensemble_weight_tune.py で α=0.0 (nopop 単独) が最強 (avg 148.75%) と判明。
ただし閾値 0.22 で固定だった。これを 0.15-0.40 でスイープして、
件数・ROI・σ・勝期間 のバランスで最適点を探す。

戦略名は「value_invest_nopop_<threshold>」
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
OUT_PATH = CACHE / "value_threshold_sweep.json"

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


def _softmax(probs):
    s = sum(p for p in probs if p > 0)
    if s <= 0:
        return [1.0 / max(1, len(probs)) for _ in probs]
    return [max(0.0, p) / s for p in probs]


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--periods", type=int, default=8)
    args = parser.parse_args(argv)

    try:
        import numpy as np  # type: ignore
    except ImportError:
        return 1

    pairs = _load_pairs()
    pairs.sort(key=lambda p: p[0])
    if not pairs:
        return 1

    nopop_tup = _load_model_nopop()
    if nopop_tup is None or nopop_tup[0] is None:
        print("[value_sweep] no nopop model")
        return 1
    features_index = _load_features_index()

    # 全 race で nopop の予測を 1 回だけ計算
    print(f"[value_sweep] Predicting {len(pairs)} races (nopop only)...")
    cache = []
    for i, (rid, race, result) in enumerate(pairs):
        if i % 300 == 0:
            print(f"  {i}/{len(pairs)}")
        horses = race.get("horses") or []
        if not horses:
            continue
        ctx = _race_context(race)
        X = [extract_horse_features(h, race, features_index, ctx) for h in horses]
        X_arr = np.array(X, dtype="float64")
        X_nopop = _mask_pop_features(X_arr, np)
        m, k = nopop_tup
        raw = list(_predict_one(m, k, X_nopop))
        probs = _softmax([float(p) for p in raw])
        cache.append({
            "rid": rid,
            "horses": horses,
            "payouts": result.get("payouts") or {},
            "probs": probs,
        })
    print(f"  Cached {len(cache)} races")

    # 閾値 0.15-0.40 を 0.01 刻みでスイープ
    thresholds = [round(0.15 + i * 0.01, 4) for i in range(26)]
    period_size = len(cache) // args.periods

    results = []
    for th in thresholds:
        period_rois = []
        period_bets = []
        for p in range(1, args.periods):
            lo = p * period_size
            hi = (p + 1) * period_size if p < args.periods - 1 else len(cache)
            inv, ret, bets = 0, 0, 0
            for c in cache[lo:hi]:
                probs = c["probs"]
                best_i = max(range(len(probs)), key=lambda i: probs[i])
                if probs[best_i] < th:
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
                period_rois.append(round(ret / inv * 100, 2))
                period_bets.append(bets)
            else:
                period_rois.append(None)
                period_bets.append(0)
        valid = [r for r in period_rois if r is not None]
        if valid:
            avg = sum(valid) / len(valid)
            sigma = (sum((r - avg) ** 2 for r in valid) / len(valid)) ** 0.5
            results.append({
                "threshold": th,
                "mean_roi_pct": round(avg, 2),
                "worst_roi_pct": round(min(valid), 2),
                "best_roi_pct": round(max(valid), 2),
                "roi_std": round(sigma, 2),
                "win_periods": sum(1 for r in valid if r >= 100),
                "active_periods": len(valid),
                "total_bets": sum(period_bets),
                "period_rois": period_rois,
            })
        else:
            results.append({"threshold": th, "total_bets": 0})

    # ベスト: 件数 >= 200 で avg ROI 最大
    valid = [r for r in results if r.get("total_bets", 0) >= 200]
    best_avg = max(valid, key=lambda r: r["mean_roi_pct"]) if valid else None
    # 件数 >= 500 で安定性 (σ 小・勝期間 多) を優先
    stable_filter = [r for r in results if r.get("total_bets", 0) >= 500
                     and r.get("mean_roi_pct", 0) >= 110]
    best_stable = min(stable_filter, key=lambda r: r["roi_std"]) if stable_filter else None
    # 最大件数で 100%+ を狙う (発火数優先)
    most_fires = [r for r in results if r.get("mean_roi_pct", 0) >= 105]
    best_volume = max(most_fires, key=lambda r: r["total_bets"]) if most_fires else None

    print()
    print("=" * 100)
    print(f"{'閾値':<8}{'avg ROI':<12}{'worst':<10}{'σ':<8}{'勝期間':<10}{'件数':<10}")
    print("=" * 100)
    for r in results:
        if r.get("total_bets", 0) == 0:
            continue
        win = f"{r.get('win_periods', 0)}/{r.get('active_periods', 0)}"
        print(f"{r['threshold']:<8.4f}{r['mean_roi_pct']:<12.2f}{r['worst_roi_pct']:<10.2f}{r['roi_std']:<8.2f}{win:<10}{r['total_bets']:<10}")
    print("=" * 100)

    if best_avg:
        print(f"\n[BEST avg]    th={best_avg['threshold']:.3f} → ROI {best_avg['mean_roi_pct']}%・σ {best_avg['roi_std']}・勝 {best_avg['win_periods']}/{best_avg['active_periods']}・件数 {best_avg['total_bets']}")
    if best_stable:
        print(f"[BEST 安定]   th={best_stable['threshold']:.3f} → ROI {best_stable['mean_roi_pct']}%・σ {best_stable['roi_std']}・勝 {best_stable['win_periods']}/{best_stable['active_periods']}・件数 {best_stable['total_bets']}")
    if best_volume:
        print(f"[BEST 件数]   th={best_volume['threshold']:.3f} → ROI {best_volume['mean_roi_pct']}%・σ {best_volume['roi_std']}・勝 {best_volume['win_periods']}/{best_volume['active_periods']}・件数 {best_volume['total_bets']}")

    out = {
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
        "strategy": "value_invest_nopop_only",
        "results": results,
        "best_avg": best_avg,
        "best_stable": best_stable,
        "best_volume": best_volume,
    }
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n[value_sweep] Saved: {OUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
