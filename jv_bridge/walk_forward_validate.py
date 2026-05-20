# -*- coding: utf-8 -*-
"""
walk_forward_validate.py — 上位戦略の Walk-forward 安定性検証

通常の validate_lightgbm は 1 つの train/test 分割で評価する (test = 最新 20%)。
Walk-forward 検証は、データを N 期間に分割して、それぞれを「test」にしたときの
回収率を計測する。全期間で安定して 100% 越えなら「本物の戦略」と判定。

設計:
  - races/results を時系列ソート
  - N 等分 (デフォルト 5 期間)
  - 各期間 i について:
      train = 期間 [0, i)
      test  = 期間 [i, i+1)
    (i=0 は train 空でテスト不可なのでスキップ・i=1..N-1 のみ評価)
  - 各 test 期間で全戦略の発火・回収率を測定
  - 各戦略について「期間別 ROI」「ROI 標準偏差」「最悪期間 ROI」「最終期間 ROI」を集計
  - 結果: data/jv_cache/walk_forward_result.json

⚠️ Wave28 重要な制約 (look-ahead leakage):
  現在の実装は「全データの前 80% で学習した 1 つのモデル」を全期間に適用しているため、
  最終期間以外の period_rois は train データに含まれる = look-ahead bias あり。
  **真に学習データを見ていないのは最終期間 (period N-1) のみ。**
  集約結果の `final_period_roi` がその「pure test ROI」。これが真の期待値判定の根拠。
  trust_label の判定 (aggregate_recommendations.py) では `final_period_roi >= 100` を必須条件とする。

使い方:
  py -3 jv_bridge\\walk_forward_validate.py --periods 5
  py -3 jv_bridge\\walk_forward_validate.py --periods 10 --strategies fuku_top1_prob_020,combo_best_wide_double_bet,best_turf
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

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
FEATURES_PATH = CACHE / "features.json"
OUT_PATH = CACHE / "walk_forward_result.json"

sys.path.insert(0, str(HERE.parent))
from jv_bridge.validate_lightgbm import (  # noqa: E402
    _build_strategies, _load_features_index, _predict_horses_for_race,
)
from jv_bridge.predict_lightgbm import _load_model, _load_model_nopop  # noqa: E402

# 重点戦略 (デフォルトでこれだけ詳しく検証)
DEFAULT_STRATEGIES = [
    "fuku_top1_prob_020",
    "fuku_top1_prob_022",
    "combo_best_wide_double_bet",
    "combo_best_and_gap",
    "fuku3_top3_conf50",
    "best_turf",
    "combo_big_turf",
    "combo_big_turf_double_bet",
    "combo_turf_ultra",
    "wide_top3_conf_050",
    "uren_top1_top2",   # ベースライン (機械的)
    "fuku_top1_always", # ベースライン
]


def run_walk_forward(periods: int, strategies_filter: Optional[List[str]]) -> int:
    model, kind = _load_model()
    if model is None:
        print("[NG] モデル未生成。先に train_lightgbm.py を回してください。", flush=True)
        return 2
    model_nopop, kind_nopop = _load_model_nopop()

    features_index = _load_features_index()

    # 利用可能なレース (races + results 両方ある) を時系列順に
    available = []
    for rp in sorted(RACES_DIR.glob("*.json")):
        rid = rp.stem
        if (RESULTS_DIR / f"{rid}.json").exists():
            available.append(rid)
    available.sort()  # race_id 昇順 = 時系列

    if len(available) < periods * 10:
        print(f"[NG] レース数 {len(available)} が分割 {periods} に対して少なすぎる", flush=True)
        return 3

    # N 期間に等分割
    n = len(available)
    chunk = n // periods
    period_ranges = []
    for i in range(periods):
        start = i * chunk
        end = (i + 1) * chunk if i < periods - 1 else n
        period_ranges.append((start, end))
    print(f"[info] 分割: {periods} 期間・各 ~{chunk} レース", flush=True)

    # 各期間で全戦略を発火・集計
    # period_results[i] = { strategy_name: { bets, invested, returned, hits, ...} }
    period_results: List[Dict[str, Dict[str, Any]]] = []
    for pi, (st, ed) in enumerate(period_ranges):
        if pi == 0:
            # 期間 0 は train なし (look-ahead bias 回避のため評価不可)
            period_results.append({})
            print(f"  [period {pi}] {available[st]} 〜 {available[ed-1]} = warmup (skip)", flush=True)
            continue
        target_rids = available[st:ed]
        # 各期間で新しい戦略インスタンスを作って評価
        strategies = _build_strategies()
        if strategies_filter:
            strategies = [s for s in strategies if s.name in strategies_filter]
        for rid in target_rids:
            try:
                race = json.loads((RACES_DIR / f"{rid}.json").read_text(encoding="utf-8"))
                result = json.loads((RESULTS_DIR / f"{rid}.json").read_text(encoding="utf-8"))
            except Exception:
                continue
            payouts = result.get("payouts") or {}
            ranked = _predict_horses_for_race(race, model, kind, features_index,
                                              model_nopop, kind_nopop)
            if not ranked:
                continue
            for s in strategies:
                s.apply(rid, ranked, payouts)
        period_results.append({s.name: s.summary() for s in strategies})
        print(f"  [period {pi}] {available[st]} 〜 {available[ed-1]} 評価完了 "
              f"({len(target_rids)} レース)", flush=True)

    # 戦略ごとに「期間別 ROI」「件数合計」「最悪期間 ROI」「平均 ROI」を集約
    all_strategy_names: List[str] = []
    if period_results:
        # period 1 から取る (period 0 は空)
        for pr in period_results[1:]:
            for name in pr.keys():
                if name not in all_strategy_names:
                    all_strategy_names.append(name)

    aggregated = []
    for name in all_strategy_names:
        period_rois = []
        period_bets = []
        period_hits = []
        for pr in period_results[1:]:
            if name in pr and pr[name]["bets"] > 0:
                period_rois.append(pr[name]["roi_pct"])
                period_bets.append(pr[name]["bets"])
                period_hits.append(pr[name]["hits"])
        if not period_rois:
            continue
        mean_roi = sum(period_rois) / len(period_rois)
        worst_roi = min(period_rois)
        best_roi = max(period_rois)
        # 標準偏差
        var = sum((r - mean_roi) ** 2 for r in period_rois) / len(period_rois)
        std = var ** 0.5
        # 期間ごとの 100% 越え回数
        wins = sum(1 for r in period_rois if r >= 100)
        # Wave28: 最終期間 ROI (= pure test = 学習データに含まれない真の評価)
        final_period_roi = round(period_rois[-1], 1) if period_rois else None
        final_period_bets = period_bets[-1] if period_bets else 0
        aggregated.append({
            "name": name,
            "active_periods": len(period_rois),
            "total_bets": sum(period_bets),
            "total_hits": sum(period_hits),
            "mean_roi_pct": round(mean_roi, 1),
            "worst_roi_pct": round(worst_roi, 1),
            "best_roi_pct": round(best_roi, 1),
            "final_period_roi": final_period_roi,  # ⚠ pure test (これが真の期待 ROI)
            "final_period_bets": final_period_bets,
            "roi_std": round(std, 1),
            "win_periods": wins,  # 100% 越えた期間数
            "period_rois": [round(r, 1) for r in period_rois],
            "period_bets": period_bets,
        })

    # 平均 ROI 降順でソート
    aggregated.sort(key=lambda x: -x["mean_roi_pct"])

    # console 表示
    print(f"\n=== Walk-forward 検証結果 ({periods} 期間) ===", flush=True)
    print(f"{'戦略名':<32} {'期間数':>6} {'累計件数':>8} {'平均ROI':>10} {'最悪ROI':>10} {'最良ROI':>10} {'勝期間':>6} {'σ':>6}", flush=True)
    for s in aggregated[:25]:
        print(f"{s['name']:<32} {s['active_periods']:>6}/{periods-1} {s['total_bets']:>7,} "
              f"{s['mean_roi_pct']:>9.1f}% {s['worst_roi_pct']:>9.1f}% {s['best_roi_pct']:>9.1f}% "
              f"{s['win_periods']:>5}/{s['active_periods']} {s['roi_std']:>5.1f}",
              flush=True)

    out = {
        "validated_at": datetime.now(timezone.utc).isoformat(),
        "periods": periods,
        "total_races": n,
        "period_size": chunk,
        "period_ranges": [
            {"index": i, "race_start": available[st], "race_end": available[ed-1], "count": ed-st}
            for i, (st, ed) in enumerate(period_ranges)
        ],
        "strategies": aggregated,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n[OK] {OUT_PATH.relative_to(ROOT)} 保存", flush=True)
    return 0


def main():
    ap = argparse.ArgumentParser(description="Walk-forward 検証 (上位戦略の安定性チェック)")
    ap.add_argument("--periods", type=int, default=5)
    ap.add_argument("--strategies", default=",".join(DEFAULT_STRATEGIES),
                    help="カンマ区切り or 'all' で全戦略")
    args = ap.parse_args()
    filt = None if args.strategies == "all" else args.strategies.split(",")
    return run_walk_forward(args.periods, filt)


if __name__ == "__main__":
    sys.exit(main())
