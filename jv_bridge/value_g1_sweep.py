# -*- coding: utf-8 -*-
"""
value_g1_sweep.py — VALUE 戦略を「G1 限定」「重賞限定」「平場限定」で再評価 (Wave28-A)

通常レースと重賞レースで AI の予測精度が違う可能性。
nopop モデルが重賞でより強いなら、G1 専用戦略として組み込む。

出力:
  data/jv_cache/value_g1_sweep.json
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
OUT_PATH = CACHE / "value_g1_sweep.json"

sys.path.insert(0, str(HERE.parent))
from jv_bridge.train_lightgbm import (  # noqa: E402
    FEATURE_NAMES, extract_horse_features, _race_context,
)
from jv_bridge.predict_lightgbm import (  # noqa: E402
    _load_model_nopop, _predict_one, _mask_pop_features,
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


def _race_class(race):
    """G1 / G2 / G3 / 重賞 / 平場 を判定。
    race.is_g1 (bool) があれば優先。grade_code (RA レコード) からも判定。"""
    if race.get("is_g1"): return "G1"
    grade = race.get("grade_code") or race.get("grade")
    if grade:
        g = str(grade).strip()
        if g in ("1", "A", "G1"): return "G1"
        if g in ("2", "B", "G2"): return "G2"
        if g in ("3", "C", "G3"): return "G3"
        if g in ("4", "5", "D", "E"): return "重賞他"
    return "平場"


def _eval_filtered(cache, filter_fn, threshold, periods=8):
    period_size = len(cache) // periods
    period_rois = []
    period_bets = []
    for p in range(1, periods):
        lo = p * period_size
        hi = (p + 1) * period_size if p < periods - 1 else len(cache)
        inv, ret, bets = 0, 0, 0
        for c in cache[lo:hi]:
            if not filter_fn(c["race"]):
                continue
            probs = c["probs"]
            best_i = max(range(len(probs)), key=lambda i: probs[i])
            if probs[best_i] < threshold:
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
    valid = [r for r in period_rois]
    if not valid:
        return None
    avg = sum(valid) / len(valid)
    sigma = (sum((r - avg) ** 2 for r in valid) / len(valid)) ** 0.5
    return {
        "mean_roi_pct": round(avg, 2),
        "worst_roi_pct": round(min(valid), 2),
        "best_roi_pct": round(max(valid), 2),
        "roi_std": round(sigma, 2),
        "win_periods": sum(1 for r in valid if r >= 100),
        "active_periods": len(valid),
        "total_bets": sum(period_bets),
        "period_rois": valid,
    }


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
        if not horses: continue
        ctx = _race_context(race)
        X = [extract_horse_features(h, race, features_index, ctx) for h in horses]
        X_arr = np.array(X, dtype="float64")
        X_nopop = _mask_pop_features(X_arr, np)
        m, k = nopop_tup
        raw = list(_predict_one(m, k, X_nopop))
        probs = _softmax([float(p) for p in raw])
        cache.append({
            "rid": rid, "race": race, "horses": horses,
            "payouts": result.get("payouts") or {}, "probs": probs,
        })
    print(f"  Cached {len(cache)} races")

    # 各クラスをカウント
    counts = {}
    for c in cache:
        cls = _race_class(c["race"])
        counts[cls] = counts.get(cls, 0) + 1
    print(f"Race classes: {counts}")

    # フィルタを定義
    filters = {
        "全レース": lambda r: True,
        "G1 のみ": lambda r: _race_class(r) == "G1",
        "G1/G2/G3 重賞": lambda r: _race_class(r) in ("G1", "G2", "G3"),
        "平場 のみ": lambda r: _race_class(r) == "平場",
    }

    # 各フィルタ × 閾値で評価
    thresholds = [0.16, 0.20, 0.22, 0.25, 0.30, 0.35]
    results = {}
    for fname, ffn in filters.items():
        results[fname] = {}
        for th in thresholds:
            r = _eval_filtered(cache, ffn, th, args.periods)
            results[fname][f"th_{th}"] = r

    # 表示
    print()
    print("=" * 100)
    print(f"{'フィルタ':<20}{'閾値':<8}{'avg':<10}{'worst':<10}{'σ':<8}{'勝':<8}{'件数':<10}")
    print("=" * 100)
    for fname, by_th in results.items():
        for th_key, r in by_th.items():
            th = float(th_key.replace("th_", ""))
            if r is None:
                print(f"{fname:<20}{th:<8.2f}---")
                continue
            win = f"{r['win_periods']}/{r['active_periods']}"
            print(f"{fname:<20}{th:<8.2f}{r['mean_roi_pct']:<10.2f}{r['worst_roi_pct']:<10.2f}{r['roi_std']:<8.2f}{win:<8}{r['total_bets']:<10}")
    print("=" * 100)

    out = {
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
        "race_class_counts": counts,
        "thresholds": thresholds,
        "results": results,
    }
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nSaved: {OUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
