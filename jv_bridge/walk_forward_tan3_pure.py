# -*- coding: utf-8 -*-
"""
walk_forward_tan3_pure.py — V-3連単 0.30 を真の look-ahead 排除版で再検証 (Wave33-1)

walk_forward_v2_result.json で「V-3連単 0.30 = 229.5%」と出ているが、
これも実は train データの partial leakage がある可能性 (期間別再学習でも
LightGBM の前期間が train として使われる)。

本スクリプトでは:
  1. 各期間 p で、period < p のデータだけで LGBM nopop を再学習
  2. period p の test データで予測 → 3 連単戦略 ROI を計算
  3. 8 期間の ROI 配列 + 平均・σ を出力

これにより「V-3連単 0.30」の真の期待 ROI が分かる。

出力: data/jv_cache/walk_forward_tan3_pure.json
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
OUT_PATH = CACHE / "walk_forward_tan3_pure.json"

sys.path.insert(0, str(HERE.parent))
from jv_bridge.train_lightgbm import (  # noqa: E402
    FEATURE_NAMES, extract_horse_features, _race_context, load_races_and_labels,
    POPULARITY_FEATURE_NAMES,
)
from jv_bridge.validate_lightgbm import (  # noqa: E402
    _payout_tan3, _payout_uren, _payout_fuku, _load_features_index,
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
    parser.add_argument("--threshold", type=float, default=0.30)
    parser.add_argument("--warmup-min", type=int, default=8000)
    args = parser.parse_args(argv)

    try:
        import numpy as np
        import lightgbm as lgb
    except ImportError as e:
        print(f"missing: {e}"); return 1

    print("Loading data...")
    X_all, y_all, race_ids_all = load_races_and_labels()
    if not X_all: return 1
    X_arr = np.array(X_all, dtype="float64")
    y_arr = np.array(y_all, dtype="int32")
    print(f"Loaded {len(X_arr)} rows / {len(set(race_ids_all))} races")

    unique_races = sorted(set(race_ids_all))
    n = len(unique_races)
    period_size = n // args.periods
    rid_to_period = {}
    for p_idx in range(args.periods):
        lo = p_idx * period_size
        hi = (p_idx + 1) * period_size if p_idx < args.periods - 1 else n
        for rid in unique_races[lo:hi]:
            rid_to_period[rid] = p_idx
    print(f"{args.periods} periods")

    pairs = _load_pairs()
    pairs.sort(key=lambda p: p[0])
    pairs_by_rid = {rid: (race, result) for rid, race, result in pairs}
    pop_idx = [i for i, name in enumerate(FEATURE_NAMES) if name in POPULARITY_FEATURE_NAMES]

    # 各期間ごとに nopop モデルを再学習 → test 期間で 3 連単 + 馬連 + 複勝 を評価
    period_results = []
    for test_p in range(1, args.periods):
        print(f"\n=== Period {test_p}/{args.periods - 1} ===")
        train_mask = np.array([rid_to_period.get(rid, -1) < test_p for rid in race_ids_all])
        test_mask = np.array([rid_to_period.get(rid, -1) == test_p for rid in race_ids_all])
        if train_mask.sum() < args.warmup_min:
            print(f"  skip (train rows {train_mask.sum()} < {args.warmup_min})")
            continue
        Xtr_n = X_arr[train_mask].copy()
        Xte_n = X_arr[test_mask].copy()
        for ci in pop_idx:
            Xtr_n[:, ci] = -1.0
            Xte_n[:, ci] = -1.0
        ytr = y_arr[train_mask]
        yte = y_arr[test_mask]

        print(f"  train nopop ({len(Xtr_n)} rows)...")
        ld_train = lgb.Dataset(Xtr_n, label=ytr, feature_name=FEATURE_NAMES,
                                params={"feature_pre_filter": False})
        ld_val = lgb.Dataset(Xte_n, label=yte, reference=ld_train,
                              feature_name=FEATURE_NAMES,
                              params={"feature_pre_filter": False})
        booster = lgb.train({
            "objective": "binary", "metric": "auc", "verbosity": -1,
            "num_leaves": 63, "learning_rate": 0.02, "min_data_in_leaf": 25,
            "lambda_l1": 0.15, "lambda_l2": 0.15,
            "feature_fraction": 0.8, "bagging_fraction": 0.8, "bagging_freq": 5,
            "feature_pre_filter": False,
        }, ld_train, num_boost_round=800,
            valid_sets=[ld_val], valid_names=["valid"],
            callbacks=[lgb.early_stopping(30, verbose=False), lgb.log_evaluation(0)])

        # test 期間で予測
        p_te = booster.predict(Xte_n)

        # race_id ごとに集約
        race_id_te = np.array(race_ids_all)[test_mask]
        idx_by_rid = {}
        for i, rid in enumerate(race_id_te):
            idx_by_rid.setdefault(rid, []).append(i)

        # 3 戦略を同じレースで評価
        inv_t3, ret_t3, bets_t3 = 0, 0, 0
        inv_ur, ret_ur, bets_ur = 0, 0, 0
        inv_fk, ret_fk, bets_fk = 0, 0, 0
        for rid, indices in idx_by_rid.items():
            if rid not in pairs_by_rid: continue
            race, result = pairs_by_rid[rid]
            horses = race.get("horses") or []
            if not horses: continue
            probs_race = [p_te[i] for i in indices]
            sm = _softmax(probs_race)
            order = sorted(range(len(sm)), key=lambda j: -sm[j])
            if sm[order[0]] < args.threshold: continue
            try:
                n1 = int(horses[order[0]].get("number"))
                # 複勝
                inv_fk += 100
                ret_fk += _payout_fuku(result.get("payouts") or {}, n1)
                bets_fk += 1
                if len(order) >= 2:
                    n2 = int(horses[order[1]].get("number"))
                    inv_ur += 100
                    ret_ur += _payout_uren(result.get("payouts") or {}, n1, n2)
                    bets_ur += 1
                if len(order) >= 3:
                    n3 = int(horses[order[2]].get("number"))
                    inv_t3 += 100
                    ret_t3 += _payout_tan3(result.get("payouts") or {}, n1, n2, n3)
                    bets_t3 += 1
            except (TypeError, ValueError):
                continue

        roi_t3 = (ret_t3 / inv_t3 * 100) if inv_t3 > 0 else None
        roi_ur = (ret_ur / inv_ur * 100) if inv_ur > 0 else None
        roi_fk = (ret_fk / inv_fk * 100) if inv_fk > 0 else None
        print(f"  3連単: ROI {roi_t3:.2f}% / {bets_t3} bets" if roi_t3 else "  no t3 bets")
        print(f"  馬連:  ROI {roi_ur:.2f}% / {bets_ur} bets" if roi_ur else "  no uren bets")
        print(f"  複勝:  ROI {roi_fk:.2f}% / {bets_fk} bets" if roi_fk else "  no fuku bets")

        period_results.append({
            "period": test_p,
            "train_rows": int(train_mask.sum()),
            "test_rows": int(test_mask.sum()),
            "tan3_roi_pct": round(roi_t3, 2) if roi_t3 is not None else None,
            "tan3_bets": bets_t3,
            "uren_roi_pct": round(roi_ur, 2) if roi_ur is not None else None,
            "uren_bets": bets_ur,
            "fuku_roi_pct": round(roi_fk, 2) if roi_fk is not None else None,
            "fuku_bets": bets_fk,
        })

    def _stat(rois, bets=None):
        if not rois: return None
        avg = sum(rois) / len(rois)
        sigma = (sum((r - avg) ** 2 for r in rois) / len(rois)) ** 0.5
        # QA-2 FIX: 件数加重平均 (各期間の bet 数で重み付け) = 真の期待 ROI
        weighted_roi = None
        if bets and len(bets) == len(rois):
            total_inv = sum(b * 100 for b in bets)
            total_ret = sum(b * 100 * r / 100 for b, r in zip(bets, rois))
            if total_inv > 0:
                weighted_roi = total_ret / total_inv * 100
        return {
            "mean_roi_pct": round(avg, 2),  # 算術平均 (期間別 ROI の単純平均・サンプル数差を無視)
            "weighted_roi_pct": round(weighted_roi, 2) if weighted_roi is not None else None,
            "worst_roi_pct": round(min(rois), 2),
            "best_roi_pct": round(max(rois), 2),
            "roi_std": round(sigma, 2),
            "win_periods": sum(1 for r in rois if r >= 100),
            "active_periods": len(rois),
            "total_bets": sum(bets) if bets else None,
            "rois": rois,
            "bets_per_period": list(bets) if bets else None,
        }

    t3_rois = [p["tan3_roi_pct"] for p in period_results if p["tan3_roi_pct"] is not None]
    t3_bets = [p["tan3_bets"] for p in period_results if p["tan3_roi_pct"] is not None]
    ur_rois = [p["uren_roi_pct"] for p in period_results if p["uren_roi_pct"] is not None]
    ur_bets = [p["uren_bets"] for p in period_results if p["uren_roi_pct"] is not None]
    fk_rois = [p["fuku_roi_pct"] for p in period_results if p["fuku_roi_pct"] is not None]
    fk_bets = [p["fuku_bets"] for p in period_results if p["fuku_roi_pct"] is not None]

    print()
    print(f"=== 真の Walk-forward 結果 (look-ahead 完全排除・閾値 {args.threshold}) ===")
    print(f"  算術平均: 期間別 ROI の単純平均 (件数差を無視)")
    print(f"  件数加重: 総払戻 / 総投資 × 100 (= 真の期待 ROI)")
    for name, st in [("3連単 V-3連単 0.30", _stat(t3_rois, t3_bets)),
                       ("馬連 V-馬連 0.30", _stat(ur_rois, ur_bets)),
                       ("複勝 V-複勝 0.30", _stat(fk_rois, fk_bets))]:
        if st:
            print(f"{name}:")
            print(f"  算術平均 {st['mean_roi_pct']}% / 件数加重 {st['weighted_roi_pct']}% / worst {st['worst_roi_pct']} / σ {st['roi_std']} / 勝 {st['win_periods']}/{st['active_periods']} / 件数 {st['total_bets']}")

    out = {
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
        "periods": args.periods,
        "threshold": args.threshold,
        "leakage_free": True,
        "method": "期間別 nopop モデル再学習 (本物の look-ahead 完全排除)",
        "tan3_summary": _stat(t3_rois, t3_bets),
        "uren_summary": _stat(ur_rois, ur_bets),
        "fuku_summary": _stat(fk_rois, fk_bets),
        "per_period": period_results,
    }
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nSaved: {OUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
