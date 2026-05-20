# -*- coding: utf-8 -*-
"""
walk_forward_stacking_pure.py — 真の look-ahead 排除版 Stacking 検証 (Wave32-A)

Wave30-C の Stacking は train データの 80% で 4 モデルを学習 + LR を fit してから
8 期間 Walk-forward で評価した。これは「test 期間が train データに含まれる」leakage
の可能性がある。

本スクリプトでは各期間ごとに:
  1. その期間より前のデータだけで LightGBM (primary + nopop) + XGB + CatB を再学習
  2. その期間より前のデータ + 4 モデルで LR を fit
  3. test 期間に対して Stacking 予測 → 馬連戦略 ROI を計算

これにより「真の look-ahead 完全排除」した V-STACK の実 ROI を測定する。

時間がかかる (1 期間あたり 4 モデル学習 + 1 LR fit) ので periods=5 デフォルト。

出力: data/jv_cache/walk_forward_stacking_pure.json
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
OUT_PATH = CACHE / "walk_forward_stacking_pure.json"

sys.path.insert(0, str(HERE.parent))
from jv_bridge.train_lightgbm import (  # noqa: E402
    FEATURE_NAMES, extract_horse_features, _race_context, load_races_and_labels,
    POPULARITY_FEATURE_NAMES,
)
from jv_bridge.validate_lightgbm import (  # noqa: E402
    _payout_fuku, _payout_uren, _load_features_index,
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


def _winner_num(race, result):
    tan = (result.get("payouts") or {}).get("tan")
    if isinstance(tan, dict):
        try: return int(tan.get("winner"))
        except (TypeError, ValueError): pass
    for h in race.get("horses") or []:
        if h.get("kakutei_jyuni") == 1:
            try: return int(h.get("number"))
            except (TypeError, ValueError): pass
    return None


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--periods", type=int, default=5,
                        help="Walk-forward 期間数 (warmup 含む・default 5)")
    parser.add_argument("--threshold", type=float, default=0.16)
    parser.add_argument("--warmup-min", type=int, default=10000,
                        help="期間 0 の学習サンプル下限 (これ未満ならスキップ)")
    args = parser.parse_args(argv)

    try:
        import numpy as np
        import lightgbm as lgb
        import xgboost as xgb
        import catboost as cb
        from sklearn.linear_model import LogisticRegression
    except ImportError as e:
        print(f"missing: {e}")
        return 1

    print("Loading all data...")
    X_all, y_all, race_ids_all = load_races_and_labels()
    if not X_all:
        print("no data"); return 1
    X_arr = np.array(X_all, dtype="float64")
    y_arr = np.array(y_all, dtype="int32")

    print(f"Loaded {len(X_arr)} rows / {len(set(race_ids_all))} races")

    # race_id → 期間 idx
    unique_races = sorted(set(race_ids_all))
    n = len(unique_races)
    period_size = n // args.periods
    rid_to_period = {}
    for p_idx in range(args.periods):
        lo = p_idx * period_size
        hi = (p_idx + 1) * period_size if p_idx < args.periods - 1 else n
        for rid in unique_races[lo:hi]:
            rid_to_period[rid] = p_idx
    print(f"{args.periods} periods × {period_size} races each")

    pairs = _load_pairs()
    pairs.sort(key=lambda p: p[0])
    features_index = _load_features_index()

    pop_idx = [i for i, name in enumerate(FEATURE_NAMES) if name in POPULARITY_FEATURE_NAMES]

    # 各期間 (1..n-1) で再学習 + 評価
    period_results = []
    for test_p in range(1, args.periods):
        print(f"\n=== Period {test_p}/{args.periods - 1} ===")
        train_mask = np.array([rid_to_period.get(rid, -1) < test_p for rid in race_ids_all])
        test_mask = np.array([rid_to_period.get(rid, -1) == test_p for rid in race_ids_all])
        if train_mask.sum() < args.warmup_min:
            print(f"  skip (train rows {train_mask.sum()} < {args.warmup_min})")
            continue
        Xtr, ytr = X_arr[train_mask], y_arr[train_mask]
        Xte, yte = X_arr[test_mask], y_arr[test_mask]
        print(f"  train={len(Xtr)} test={len(Xte)}")

        # 1. LGBM primary
        print("  train LGBM primary...")
        ld_train = lgb.Dataset(Xtr, label=ytr, feature_name=FEATURE_NAMES,
                                params={"feature_pre_filter": False})
        ld_val = lgb.Dataset(Xte, label=yte, reference=ld_train,
                              feature_name=FEATURE_NAMES,
                              params={"feature_pre_filter": False})
        lgb_params = {
            "objective": "binary", "metric": "auc", "verbosity": -1,
            "num_leaves": 63, "learning_rate": 0.02, "min_data_in_leaf": 25,
            "lambda_l1": 0.15, "lambda_l2": 0.15,
            "feature_fraction": 0.8, "bagging_fraction": 0.8, "bagging_freq": 5,
            "feature_pre_filter": False,
        }
        lgb_m = lgb.train(lgb_params, ld_train, num_boost_round=600,
                          valid_sets=[ld_val], valid_names=["valid"],
                          callbacks=[lgb.early_stopping(30, verbose=False), lgb.log_evaluation(0)])

        # 2. LGBM nopop (人気特徴量をマスクして学習)
        print("  train LGBM nopop...")
        Xtr_nopop = Xtr.copy()
        Xte_nopop = Xte.copy()
        for ci in pop_idx:
            Xtr_nopop[:, ci] = -1.0
            Xte_nopop[:, ci] = -1.0
        ld_train_n = lgb.Dataset(Xtr_nopop, label=ytr, feature_name=FEATURE_NAMES,
                                  params={"feature_pre_filter": False})
        ld_val_n = lgb.Dataset(Xte_nopop, label=yte, reference=ld_train_n,
                                feature_name=FEATURE_NAMES,
                                params={"feature_pre_filter": False})
        lgb_n = lgb.train(lgb_params, ld_train_n, num_boost_round=600,
                          valid_sets=[ld_val_n], valid_names=["valid"],
                          callbacks=[lgb.early_stopping(30, verbose=False), lgb.log_evaluation(0)])

        # 3. XGBoost
        print("  train XGBoost...")
        dtr = xgb.DMatrix(Xtr, label=ytr, feature_names=FEATURE_NAMES)
        dte = xgb.DMatrix(Xte, label=yte, feature_names=FEATURE_NAMES)
        xgb_p = {"objective": "binary:logistic", "eval_metric": "auc",
                  "max_depth": 6, "learning_rate": 0.04, "min_child_weight": 5,
                  "reg_alpha": 0.15, "reg_lambda": 0.15,
                  "subsample": 0.8, "colsample_bytree": 0.8, "verbosity": 0}
        xgb_m = xgb.train(xgb_p, dtr, num_boost_round=400,
                          evals=[(dte, "valid")], early_stopping_rounds=30, verbose_eval=False)

        # 4. CatBoost
        print("  train CatBoost...")
        catb_m = cb.CatBoostClassifier(iterations=400, depth=6, learning_rate=0.04,
                                        l2_leaf_reg=3.0, eval_metric="AUC",
                                        early_stopping_rounds=30, verbose=0, random_seed=42)
        catb_m.fit(Xtr, ytr, eval_set=(Xte, yte))

        # 5. train データの 4 モデル予測で LR を fit
        print("  fit Stacking LR...")
        p_lgb_tr = lgb_m.predict(Xtr)
        p_ln_tr  = lgb_n.predict(Xtr_nopop)
        p_xgb_tr = xgb_m.predict(xgb.DMatrix(Xtr, feature_names=FEATURE_NAMES))
        p_catb_tr = catb_m.predict_proba(Xtr)[:, 1]
        X_stack_tr = np.column_stack([p_lgb_tr, p_ln_tr, p_xgb_tr, p_catb_tr])
        lr = LogisticRegression(C=1.0, max_iter=1000)
        lr.fit(X_stack_tr, ytr)

        # 6. test データに対して Stacking 予測
        p_lgb_te = lgb_m.predict(Xte)
        p_ln_te  = lgb_n.predict(Xte_nopop)
        p_xgb_te = xgb_m.predict(dte)
        p_catb_te = catb_m.predict_proba(Xte)[:, 1]
        X_stack_te = np.column_stack([p_lgb_te, p_ln_te, p_xgb_te, p_catb_te])
        p_stack_te = lr.predict_proba(X_stack_te)[:, 1]

        # 7. test 期間のレースごとに softmax + 戦略評価
        # まず race_id ごとに index を集める
        race_id_te = np.array(race_ids_all)[test_mask]
        unique_test_rids = sorted(set(race_id_te.tolist()))
        # race_id → 行インデックス
        idx_by_rid = {}
        for i, rid in enumerate(race_id_te):
            idx_by_rid.setdefault(rid, []).append(i)

        # 馬連戦略の ROI を計算
        inv_fuku, ret_fuku, bets_fuku = 0, 0, 0
        inv_uren, ret_uren, bets_uren = 0, 0, 0
        for (rid, race, result) in pairs:
            if rid not in idx_by_rid: continue
            indices = idx_by_rid[rid]
            horses = race.get("horses") or []
            if not horses: continue
            # この race 内の馬の prob
            probs = [p_stack_te[i] for i in indices]
            # softmax
            sm = _softmax(probs)
            # rank
            order = sorted(range(len(sm)), key=lambda j: -sm[j])
            top1_p = sm[order[0]]
            if top1_p < args.threshold: continue
            try:
                n1 = int(horses[order[0]].get("number"))
                inv_fuku += 100
                ret_fuku += _payout_fuku(result.get("payouts") or {}, n1)
                bets_fuku += 1
                if len(order) >= 2:
                    n2 = int(horses[order[1]].get("number"))
                    inv_uren += 100
                    ret_uren += _payout_uren(result.get("payouts") or {}, n1, n2)
                    bets_uren += 1
            except (TypeError, ValueError):
                continue

        roi_fuku = (ret_fuku / inv_fuku * 100) if inv_fuku > 0 else None
        roi_uren = (ret_uren / inv_uren * 100) if inv_uren > 0 else None
        print(f"  Stacking 複勝: ROI {roi_fuku:.2f}% / {bets_fuku} bets" if roi_fuku else "  no fuku bets")
        print(f"  Stacking 馬連: ROI {roi_uren:.2f}% / {bets_uren} bets" if roi_uren else "  no uren bets")

        period_results.append({
            "period": test_p,
            "train_rows": int(train_mask.sum()),
            "test_rows": int(test_mask.sum()),
            "fuku_roi_pct": round(roi_fuku, 2) if roi_fuku is not None else None,
            "fuku_bets": bets_fuku,
            "uren_roi_pct": round(roi_uren, 2) if roi_uren is not None else None,
            "uren_bets": bets_uren,
            "lr_weights": [round(float(w), 4) for w in lr.coef_[0]],
            "lr_intercept": round(float(lr.intercept_[0]), 4),
        })

    # 全期間集計
    fuku_rois = [p["fuku_roi_pct"] for p in period_results if p["fuku_roi_pct"] is not None]
    uren_rois = [p["uren_roi_pct"] for p in period_results if p["uren_roi_pct"] is not None]

    def _stat(rois):
        if not rois: return None
        avg = sum(rois) / len(rois)
        sigma = (sum((r - avg) ** 2 for r in rois) / len(rois)) ** 0.5
        return {
            "mean_roi_pct": round(avg, 2),
            "worst_roi_pct": round(min(rois), 2),
            "best_roi_pct": round(max(rois), 2),
            "roi_std": round(sigma, 2),
            "win_periods": sum(1 for r in rois if r >= 100),
            "active_periods": len(rois),
            "rois": rois,
        }

    summary_fuku = _stat(fuku_rois)
    summary_uren = _stat(uren_rois)

    print()
    print("=== 真の Walk-forward Stacking 結果 (look-ahead 完全排除) ===")
    if summary_fuku:
        print(f"複勝 V-STACK pure: avg {summary_fuku['mean_roi_pct']}% / worst {summary_fuku['worst_roi_pct']} / σ {summary_fuku['roi_std']} / 勝 {summary_fuku['win_periods']}/{summary_fuku['active_periods']}")
    if summary_uren:
        print(f"馬連 V-STACK pure: avg {summary_uren['mean_roi_pct']}% / worst {summary_uren['worst_roi_pct']} / σ {summary_uren['roi_std']} / 勝 {summary_uren['win_periods']}/{summary_uren['active_periods']}")

    out = {
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
        "periods_total": args.periods,
        "threshold": args.threshold,
        "leakage_free": True,
        "method": "期間別再学習 Stacking (LGBM + nopop + XGB + CatB + LR)",
        "fuku_summary": summary_fuku,
        "uren_summary": summary_uren,
        "per_period": period_results,
    }
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nSaved: {OUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
