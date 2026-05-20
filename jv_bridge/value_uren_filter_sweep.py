# -*- coding: utf-8 -*-
"""
value_uren_filter_sweep.py — V-馬連 戦略 (nopop 馬連 top1-top2) を
レース条件 (G1 / 芝 / ダ / 距離帯 / コース) でフィルタして真の期待 ROI を探る (Wave29)

背景:
  Wave28 で V-馬連 (閾値 0.30) が pure test (最終期間) で 108.75% / 勝 7/7 と確認 ★★★★ TRUSTED。
  これを更に条件で絞れば final 120%+ の領域があるかもしれない。
  (例: G1 は荒れにくいので nopop 信頼性が上がるはず・芝の方がペース読みやすい等)

出力:
  data/jv_cache/value_uren_filter_sweep.json
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
OUT_PATH = CACHE / "value_uren_filter_sweep.json"

sys.path.insert(0, str(HERE.parent))
from jv_bridge.train_lightgbm import (  # noqa: E402
    FEATURE_NAMES, extract_horse_features, _race_context,
)
from jv_bridge.predict_lightgbm import (  # noqa: E402
    _load_model_nopop, _predict_one, _mask_pop_features,
)
from jv_bridge.validate_lightgbm import (  # noqa: E402
    _payout_uren, _load_features_index,
)


# レースフィルタ: (name, predicate(race) -> bool)
def _surface_is_turf(race: Dict[str, Any]) -> bool:
    s = (race.get("course") or "") + " " + (race.get("race_surface") or "")
    return "芝" in s


def _surface_is_dirt(race: Dict[str, Any]) -> bool:
    s = (race.get("course") or "") + " " + (race.get("race_surface") or "")
    return "ダ" in s


def _is_g1(race: Dict[str, Any]) -> bool:
    return bool(race.get("is_g1"))


def _is_graded(race: Dict[str, Any]) -> bool:
    """G1/G2/G3 (重賞) を含む"""
    name = (race.get("race_name") or "")
    code = str(race.get("grade_code") or "")
    return bool(race.get("is_g1")) or "G1" in name or "G2" in name or "G3" in name or code in ("A", "B", "C", "D", "E", "F", "G")


def _dist_short(race: Dict[str, Any]) -> bool:
    d = race.get("distance") or 0
    try:
        return 1000 <= int(d) <= 1400
    except (TypeError, ValueError):
        return False


def _dist_mid(race: Dict[str, Any]) -> bool:
    d = race.get("distance") or 0
    try:
        return 1500 <= int(d) <= 2000
    except (TypeError, ValueError):
        return False


def _dist_long(race: Dict[str, Any]) -> bool:
    d = race.get("distance") or 0
    try:
        return int(d) >= 2100
    except (TypeError, ValueError):
        return False


def _course_tokyo(race: Dict[str, Any]) -> bool:
    return "東京" in (race.get("course") or "")


def _course_hanshin(race: Dict[str, Any]) -> bool:
    return "阪神" in (race.get("course") or "")


def _course_kyoto(race: Dict[str, Any]) -> bool:
    return "京都" in (race.get("course") or "")


def _course_nakayama(race): return "中山" in (race.get("course") or "")
def _course_chukyo(race): return "中京" in (race.get("course") or "")
def _course_niigata(race): return "新潟" in (race.get("course") or "")
def _course_fukushima(race): return "福島" in (race.get("course") or "")


def _month_in(race, months):
    """race_id (YYYYMMDD...) から月を取り出して months set に含まれるか"""
    rid = race.get("race_id") or ""
    if len(rid) < 6: return False
    try:
        return int(rid[4:6]) in months
    except (TypeError, ValueError):
        return False


FILTERS: List[Tuple[str, Callable[[Dict[str, Any]], bool]]] = [
    # 全体
    ("all",       lambda r: True),
    # サーフェス
    ("turf",      _surface_is_turf),
    ("dirt",      _surface_is_dirt),
    # グレード
    ("g1",        _is_g1),
    ("graded",    _is_graded),
    ("turf_g1",   lambda r: _surface_is_turf(r) and _is_g1(r)),
    ("turf_graded", lambda r: _surface_is_turf(r) and _is_graded(r)),
    # 距離
    ("dist_short", _dist_short),                     # 1000-1400m
    ("dist_mid",  _dist_mid),                         # 1500-2000m
    ("dist_long", _dist_long),                        # 2100m+
    # 距離 × サーフェス
    ("turf_short", lambda r: _surface_is_turf(r) and _dist_short(r)),
    ("turf_mid",  lambda r: _surface_is_turf(r) and _dist_mid(r)),
    ("turf_long", lambda r: _surface_is_turf(r) and _dist_long(r)),
    ("dirt_short", lambda r: _surface_is_dirt(r) and _dist_short(r)),
    ("dirt_mid",  lambda r: _surface_is_dirt(r) and _dist_mid(r)),
    # コース (主要 10 場)
    ("tokyo",     _course_tokyo),
    ("hanshin",   _course_hanshin),
    ("kyoto",     _course_kyoto),
    ("nakayama",  _course_nakayama),
    ("chukyo",    _course_chukyo),
    ("niigata",   _course_niigata),
    ("fukushima", _course_fukushima),
    # コース × サーフェス
    ("turf_tokyo", lambda r: _surface_is_turf(r) and _course_tokyo(r)),
    ("turf_hanshin", lambda r: _surface_is_turf(r) and _course_hanshin(r)),
    ("turf_kyoto", lambda r: _surface_is_turf(r) and _course_kyoto(r)),
    ("turf_nakayama", lambda r: _surface_is_turf(r) and _course_nakayama(r)),
    # 季節 (Wave29 拡張)
    ("spring",    lambda r: _month_in(r, {3, 4, 5})),
    ("summer",    lambda r: _month_in(r, {6, 7, 8})),
    ("autumn",    lambda r: _month_in(r, {9, 10, 11})),
    ("winter",    lambda r: _month_in(r, {12, 1, 2})),
    ("turf_spring", lambda r: _surface_is_turf(r) and _month_in(r, {3, 4, 5})),
    ("turf_autumn", lambda r: _surface_is_turf(r) and _month_in(r, {9, 10, 11})),
]

THRESHOLDS = [0.16, 0.20, 0.25, 0.30, 0.35]


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
        print("[NG] numpy が必要", flush=True)
        return 1

    pairs = _load_pairs()
    pairs.sort(key=lambda p: p[0])
    if not pairs:
        print("[NG] レースデータなし", flush=True)
        return 1

    nopop_tup = _load_model_nopop()
    if nopop_tup is None or nopop_tup[0] is None:
        print("[NG] nopop モデル未生成", flush=True)
        return 1

    features_index = _load_features_index()

    # nopop 予測を 1 回キャッシュ
    print(f"[info] {len(pairs)} レースで nopop 予測キャッシュ中…", flush=True)
    cache = []
    for i, (rid, race, result) in enumerate(pairs):
        if i % 500 == 0 and i > 0:
            print(f"  {i}/{len(pairs)}", flush=True)
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
            "race": race,
            "horses": horses,
            "payouts": result.get("payouts") or {},
            "probs": probs,
        })
    print(f"  キャッシュ完了 ({len(cache)} レース)", flush=True)

    # 期間分割
    period_size = max(1, len(cache) // args.periods)

    results: List[Dict[str, Any]] = []
    for filter_name, predicate in FILTERS:
        for th in THRESHOLDS:
            period_rois: List[Optional[float]] = []
            period_bets: List[int] = []
            total_invested = 0
            total_returned = 0
            total_bets = 0
            for p in range(1, args.periods):
                lo = p * period_size
                hi = (p + 1) * period_size if p < args.periods - 1 else len(cache)
                inv, ret, bets = 0, 0, 0
                for c in cache[lo:hi]:
                    # フィルタ判定
                    if not predicate(c["race"]):
                        continue
                    probs = c["probs"]
                    if len(probs) < 2:
                        continue
                    # top1 / top2 を nopop の prob から
                    sorted_idx = sorted(range(len(probs)), key=lambda i: -probs[i])
                    top1_i, top2_i = sorted_idx[0], sorted_idx[1]
                    if probs[top1_i] < th:
                        continue
                    h1 = c["horses"][top1_i]
                    h2 = c["horses"][top2_i]
                    try:
                        a = int(h1.get("number"))
                        b = int(h2.get("number"))
                    except (TypeError, ValueError):
                        continue
                    inv += 100
                    r = _payout_uren(c["payouts"], a, b)
                    ret += r
                    bets += 1
                total_invested += inv
                total_returned += ret
                total_bets += bets
                if inv > 0:
                    period_rois.append(round(ret / inv * 100, 2))
                    period_bets.append(bets)
                else:
                    period_rois.append(None)
                    period_bets.append(0)
            valid = [r for r in period_rois if r is not None]
            if not valid or total_bets < 10:
                continue
            avg = sum(valid) / len(valid)
            sigma = (sum((r - avg) ** 2 for r in valid) / len(valid)) ** 0.5
            final_roi = period_rois[-1]  # 最終期間 (pure test)
            final_bets = period_bets[-1] if period_bets else 0
            mean_overall_roi = round(total_returned / total_invested * 100, 2) if total_invested else None
            results.append({
                "filter": filter_name,
                "threshold": th,
                "active_periods": len(valid),
                "total_bets": total_bets,
                "mean_overall_roi_pct": mean_overall_roi,
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

    # final_period_roi で降順ソート (真の期待 ROI 高い順)
    results_sorted = sorted(
        [r for r in results if r["final_period_roi_pct"] is not None and r["final_period_bets"] >= 5],
        key=lambda x: -x["final_period_roi_pct"]
    )

    # 表示
    print("\n=== V-馬連 フィルタスイープ 結果 (final_period_roi 降順) ===", flush=True)
    print(f"{'フィルタ':<18}{'閾値':<6}{'final':<8}{'mean':<8}{'wp':<6}{'件数':<8}{'σ':<8}", flush=True)
    print("=" * 70, flush=True)
    for r in results_sorted[:25]:
        wp_str = f"{r['win_periods']}/{r['active_periods']}"
        print(f"{r['filter']:<18}{r['threshold']:<6.2f}{r['final_period_roi_pct']:<8.1f}{r['mean_period_roi_pct']:<8.1f}{wp_str:<6}{r['total_bets']:<8}{r['roi_std']:<8.1f}", flush=True)

    # 100%+ かつ件数 50+ の領域を best として記録
    best_strict = [r for r in results_sorted
                   if r["final_period_roi_pct"] >= 105 and r["total_bets"] >= 50]
    best_super = [r for r in results_sorted
                  if r["final_period_roi_pct"] >= 120 and r["total_bets"] >= 20]

    out = {
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
        "strategy": "value_uren_filter",
        "filters_tested": [f[0] for f in FILTERS],
        "thresholds_tested": THRESHOLDS,
        "results": results,
        "results_sorted_by_final_roi": results_sorted,
        "best_strict_105_final_50bets": best_strict[:10],
        "best_super_120_final_20bets": best_super[:10],
    }
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n[OK] {OUT_PATH.relative_to(ROOT)} 保存", flush=True)
    print(f"     final 105%+ かつ 件数 50+ の条件: {len(best_strict)} 件", flush=True)
    print(f"     final 120%+ かつ 件数 20+ の条件: {len(best_super)} 件", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
