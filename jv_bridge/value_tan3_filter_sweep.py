# -*- coding: utf-8 -*-
"""
value_tan3_filter_sweep.py — V-3連単 戦略を G1/芝/ダ/距離/コース別 で深掘り (Wave30-X3)

背景:
  walk_forward_v2 で V-3連単 (nopop 閾値 0.30) が真の overall 229.5% / 件数 365 と判明。
  これを更にフィルタで絞り込めば「件数 100+ で 300%+」の領域が見つかるかも。

注意:
  filter_sweep は単一モデル (全データ学習済 nopop) で予測 cache を作るため、
  最終期間以外には残存 leakage がある。これは「相対比較」用。
  真の検証は walk_forward_v2 にフィルタを足して期間別再学習で行うべき。

出力: data/jv_cache/value_tan3_filter_sweep.json
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Callable, Tuple

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
OUT_PATH = CACHE / "value_tan3_filter_sweep.json"

sys.path.insert(0, str(HERE.parent))
from jv_bridge.train_lightgbm import (  # noqa: E402
    FEATURE_NAMES, extract_horse_features, _race_context,
)
from jv_bridge.predict_lightgbm import (  # noqa: E402
    _load_model_nopop, _predict_one, _mask_pop_features,
)
from jv_bridge.validate_lightgbm import (  # noqa: E402
    _payout_tan3, _load_features_index,
)


# フィルタ定義 (value_uren_filter_sweep の構造を流用)
def _surface_is_turf(race): return "芝" in ((race.get("course") or "") + " " + (race.get("surface") or ""))
def _surface_is_dirt(race): return "ダ" in ((race.get("course") or "") + " " + (race.get("surface") or ""))
def _is_g1(race): return bool(race.get("is_g1"))
def _dist_short(race):
    try: return 1000 <= int(race.get("distance") or 0) <= 1400
    except (TypeError, ValueError): return False
def _dist_mid(race):
    try: return 1500 <= int(race.get("distance") or 0) <= 2000
    except (TypeError, ValueError): return False
def _dist_long(race):
    try: return int(race.get("distance") or 0) >= 2100
    except (TypeError, ValueError): return False

def _course_tokyo(r): return "東京" in (r.get("course") or "")
def _course_hanshin(r): return "阪神" in (r.get("course") or "")
def _course_kyoto(r): return "京都" in (r.get("course") or "")
def _course_nakayama(r): return "中山" in (r.get("course") or "")


FILTERS: List[Tuple[str, Callable[[Dict[str, Any]], bool]]] = [
    ("all",         lambda r: True),
    ("turf",        _surface_is_turf),
    ("dirt",        _surface_is_dirt),
    ("g1",          _is_g1),
    ("turf_g1",     lambda r: _surface_is_turf(r) and _is_g1(r)),
    ("dist_short",  _dist_short),
    ("dist_mid",    _dist_mid),
    ("dist_long",   _dist_long),
    ("turf_short",  lambda r: _surface_is_turf(r) and _dist_short(r)),
    ("turf_mid",    lambda r: _surface_is_turf(r) and _dist_mid(r)),
    ("turf_long",   lambda r: _surface_is_turf(r) and _dist_long(r)),
    ("dirt_short",  lambda r: _surface_is_dirt(r) and _dist_short(r)),
    ("dirt_mid",    lambda r: _surface_is_dirt(r) and _dist_mid(r)),
    ("tokyo",       _course_tokyo),
    ("hanshin",     _course_hanshin),
    ("kyoto",       _course_kyoto),
    ("nakayama",    _course_nakayama),
    ("turf_tokyo",  lambda r: _surface_is_turf(r) and _course_tokyo(r)),
    ("turf_hanshin", lambda r: _surface_is_turf(r) and _course_hanshin(r)),
]

THRESHOLDS = [0.20, 0.25, 0.30, 0.35]


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
    if s <= 0: return [1.0 / max(1, len(probs)) for _ in probs]
    return [max(0.0, p) / s for p in probs]


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--periods", type=int, default=7)
    args = parser.parse_args(argv)
    try:
        import numpy as np  # type: ignore
    except ImportError:
        print("[NG] numpy が必要", flush=True); return 1
    pairs = _load_pairs(); pairs.sort(key=lambda p: p[0])
    if not pairs: print("[NG] レースデータなし", flush=True); return 1

    nopop_tup = _load_model_nopop()
    if nopop_tup is None or nopop_tup[0] is None:
        print("[NG] nopop モデル未生成", flush=True); return 1
    features_index = _load_features_index()

    # 推論 cache
    print(f"[info] {len(pairs)} レースで nopop 予測キャッシュ中…", flush=True)
    cache = []
    for i, (rid, race, result) in enumerate(pairs):
        if i % 500 == 0 and i > 0: print(f"  {i}/{len(pairs)}", flush=True)
        horses = race.get("horses") or []
        if not horses: continue
        ctx = _race_context(race)
        X = [extract_horse_features(h, race, features_index, ctx) for h in horses]
        X_arr = np.array(X, dtype="float64")
        X_nopop = _mask_pop_features(X_arr, np)
        m, k = nopop_tup
        raw = list(_predict_one(m, k, X_nopop))
        probs = _softmax([float(p) for p in raw])
        cache.append({"rid": rid, "race": race, "horses": horses,
                      "payouts": result.get("payouts") or {}, "probs": probs})
    print(f"  キャッシュ完了 ({len(cache)} レース)", flush=True)

    period_size = max(1, len(cache) // args.periods)

    results: List[Dict[str, Any]] = []
    for filter_name, predicate in FILTERS:
        for th in THRESHOLDS:
            period_rois: List[Optional[float]] = []
            period_bets: List[int] = []
            total_inv, total_ret, total_bets = 0, 0, 0
            for p in range(1, args.periods):
                lo = p * period_size
                hi = (p + 1) * period_size if p < args.periods - 1 else len(cache)
                inv, ret, bets = 0, 0, 0
                for c in cache[lo:hi]:
                    if not predicate(c["race"]): continue
                    probs = c["probs"]
                    if len(probs) < 3: continue
                    sorted_idx = sorted(range(len(probs)), key=lambda i: -probs[i])
                    if probs[sorted_idx[0]] < th: continue
                    try:
                        a = int(c["horses"][sorted_idx[0]].get("number"))
                        b = int(c["horses"][sorted_idx[1]].get("number"))
                        cn = int(c["horses"][sorted_idx[2]].get("number"))
                    except (TypeError, ValueError):
                        continue
                    inv += 100
                    pay = _payout_tan3(c["payouts"], a, b, cn)
                    ret += pay; bets += 1
                total_inv += inv; total_ret += ret; total_bets += bets
                if inv > 0:
                    period_rois.append(round(ret / inv * 100, 2))
                    period_bets.append(bets)
                else:
                    period_rois.append(None); period_bets.append(0)
            valid = [r for r in period_rois if r is not None]
            if not valid or total_bets < 10: continue
            avg = sum(valid) / len(valid)
            sigma = (sum((r - avg) ** 2 for r in valid) / len(valid)) ** 0.5
            final_roi = period_rois[-1]
            final_bets = period_bets[-1] if period_bets else 0
            results.append({
                "filter": filter_name,
                "threshold": th,
                "active_periods": len(valid),
                "total_bets": total_bets,
                "mean_overall_roi_pct": round(total_ret / total_inv * 100, 2) if total_inv else None,
                "mean_period_roi_pct": round(avg, 2),
                "worst_period_roi_pct": round(min(valid), 2),
                "best_period_roi_pct": round(max(valid), 2),
                "final_period_roi_pct": round(final_roi, 2) if final_roi is not None else None,
                "final_period_bets": final_bets,
                "roi_std": round(sigma, 2),
                "win_periods": sum(1 for r in valid if r >= 100),
                "period_rois": period_rois,
                "period_bets": period_bets,
            })

    results_sorted = sorted(
        [r for r in results if r["mean_overall_roi_pct"] is not None and r["total_bets"] >= 20],
        key=lambda x: -x["mean_overall_roi_pct"]
    )
    print("\n=== V-3連単 フィルタスイープ 結果 (overall_roi 降順) ===", flush=True)
    print(f"{'フィルタ':<18}{'閾値':<6}{'overall':<10}{'final':<10}{'wp':<6}{'件数':<8}", flush=True)
    print("=" * 70, flush=True)
    for r in results_sorted[:30]:
        wp = f"{r['win_periods']}/{r['active_periods']}"
        f_val = r['final_period_roi_pct']
        f_str = f"{f_val:.1f}" if f_val is not None else "-"
        print(f"{r['filter']:<18}{r['threshold']:<6.2f}{r['mean_overall_roi_pct']:<10.1f}{f_str:<10}{wp:<6}{r['total_bets']:<8}", flush=True)

    out = {
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
        "strategy": "value_tan3_filter",
        "filters_tested": [f[0] for f in FILTERS],
        "thresholds_tested": THRESHOLDS,
        "results": results,
        "results_sorted_by_overall": results_sorted,
    }
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n[OK] {OUT_PATH.relative_to(ROOT)} 保存", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
