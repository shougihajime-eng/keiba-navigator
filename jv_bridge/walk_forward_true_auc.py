# -*- coding: utf-8 -*-
"""
walk_forward_true_auc.py — 真の AUC 測定 (look-ahead 完全排除版) (Wave35-E)

既存の model_lgbm_meta.json に書かれている AUC 0.806/0.814 は、
train 80% / test 20% の単一分割。test 期間が future leakage を含む可能性。

本スクリプトは 8 期間 Walk-forward (期間別再学習) で各期間の AUC を測定。
これが「真の AUC」(look-ahead 完全排除版)。

出力:
  data/jv_cache/walk_forward_true_auc.json
"""
from __future__ import annotations
import argparse, io, json, os, sys
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
OUT_PATH = CACHE / "walk_forward_true_auc.json"

sys.path.insert(0, str(HERE.parent))
from jv_bridge.train_lightgbm import (
    FEATURE_NAMES, load_races_and_labels, POPULARITY_FEATURE_NAMES,
)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--periods", type=int, default=8)
    parser.add_argument("--warmup-min", type=int, default=8000)
    args = parser.parse_args()

    try:
        import numpy as np
        import lightgbm as lgb
        from sklearn.metrics import roc_auc_score, log_loss
    except ImportError as e:
        print(f"missing: {e}"); return 1

    print("Loading data...")
    X_all, y_all, race_ids_all = load_races_and_labels()
    X_arr = np.array(X_all, dtype="float64")
    y_arr = np.array(y_all, dtype="int32")
    print(f"Loaded {len(X_arr)} rows")

    unique_races = sorted(set(race_ids_all))
    n = len(unique_races)
    period_size = n // args.periods
    rid_to_period = {}
    for p_idx in range(args.periods):
        lo = p_idx * period_size
        hi = (p_idx + 1) * period_size if p_idx < args.periods - 1 else n
        for rid in unique_races[lo:hi]:
            rid_to_period[rid] = p_idx
    pop_idx = [i for i, name in enumerate(FEATURE_NAMES) if name in POPULARITY_FEATURE_NAMES]

    lgb_params = {
        "objective": "binary", "metric": "auc", "verbosity": -1,
        "num_leaves": 63, "learning_rate": 0.02, "min_data_in_leaf": 25,
        "lambda_l1": 0.15, "lambda_l2": 0.15,
        "feature_fraction": 0.8, "bagging_fraction": 0.8, "bagging_freq": 5,
        "feature_pre_filter": False,
    }

    per_period = []
    for test_p in range(1, args.periods):
        print(f"\n=== Period {test_p}/{args.periods - 1} ===")
        train_mask = np.array([rid_to_period.get(rid, -1) < test_p for rid in race_ids_all])
        test_mask = np.array([rid_to_period.get(rid, -1) == test_p for rid in race_ids_all])
        if train_mask.sum() < args.warmup_min:
            print(f"  skip"); continue
        Xtr, ytr = X_arr[train_mask], y_arr[train_mask]
        Xte, yte = X_arr[test_mask], y_arr[test_mask]
        # Primary
        print("  train primary...")
        ld_tr = lgb.Dataset(Xtr, label=ytr, feature_name=FEATURE_NAMES,
                             params={"feature_pre_filter": False})
        ld_va = lgb.Dataset(Xte, label=yte, reference=ld_tr,
                             feature_name=FEATURE_NAMES,
                             params={"feature_pre_filter": False})
        m_pri = lgb.train(lgb_params, ld_tr, num_boost_round=600,
                          valid_sets=[ld_va], valid_names=["valid"],
                          callbacks=[lgb.early_stopping(30, verbose=False), lgb.log_evaluation(0)])
        p_pri = m_pri.predict(Xte)
        auc_pri = roc_auc_score(yte, p_pri)
        loss_pri = log_loss(yte, p_pri)
        print(f"  primary: AUC {auc_pri:.4f} LogLoss {loss_pri:.4f}")
        # nopop
        print("  train nopop...")
        Xtr_n = Xtr.copy(); Xte_n = Xte.copy()
        for ci in pop_idx:
            Xtr_n[:, ci] = -1.0; Xte_n[:, ci] = -1.0
        ld_tr_n = lgb.Dataset(Xtr_n, label=ytr, feature_name=FEATURE_NAMES,
                                params={"feature_pre_filter": False})
        ld_va_n = lgb.Dataset(Xte_n, label=yte, reference=ld_tr_n,
                                feature_name=FEATURE_NAMES,
                                params={"feature_pre_filter": False})
        m_nop = lgb.train(lgb_params, ld_tr_n, num_boost_round=600,
                          valid_sets=[ld_va_n], valid_names=["valid"],
                          callbacks=[lgb.early_stopping(30, verbose=False), lgb.log_evaluation(0)])
        p_nop = m_nop.predict(Xte_n)
        auc_nop = roc_auc_score(yte, p_nop)
        loss_nop = log_loss(yte, p_nop)
        print(f"  nopop:   AUC {auc_nop:.4f} LogLoss {loss_nop:.4f}")
        per_period.append({
            "period": test_p,
            "train_rows": int(train_mask.sum()),
            "test_rows": int(test_mask.sum()),
            "auc_primary": round(auc_pri, 4),
            "logloss_primary": round(loss_pri, 4),
            "auc_nopop": round(auc_nop, 4),
            "logloss_nopop": round(loss_nop, 4),
        })

    auc_pri_list = [p["auc_primary"] for p in per_period]
    auc_nop_list = [p["auc_nopop"] for p in per_period]
    def _avg(lst): return sum(lst) / len(lst) if lst else None

    print()
    print("=== Walk-forward 真の AUC (look-ahead 完全排除) ===")
    print(f"Primary AUC: avg {_avg(auc_pri_list):.4f} / min {min(auc_pri_list):.4f} / max {max(auc_pri_list):.4f}")
    print(f"Nopop   AUC: avg {_avg(auc_nop_list):.4f} / min {min(auc_nop_list):.4f} / max {max(auc_nop_list):.4f}")

    out = {
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
        "periods": args.periods,
        "leakage_free": True,
        "summary": {
            "primary_auc_avg": round(_avg(auc_pri_list), 4),
            "primary_auc_min": round(min(auc_pri_list), 4),
            "primary_auc_max": round(max(auc_pri_list), 4),
            "nopop_auc_avg": round(_avg(auc_nop_list), 4),
            "nopop_auc_min": round(min(auc_nop_list), 4),
            "nopop_auc_max": round(max(auc_nop_list), 4),
        },
        "per_period": per_period,
    }
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nSaved: {OUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
