# -*- coding: utf-8 -*-
"""
train_ensemble.py — XGBoost / CatBoost を追加学習し、3 モデルアンサンブル (Wave26-E)

LightGBM 単体だけでなく、XGBoost と CatBoost も同じデータで学習する。
3 モデルの予測 prob を単純平均 or 重み付き平均でアンサンブルすると、
1 モデル単独より AUC が +1-2% 向上することが知られている。

入力:
  data/jv_cache/races/<race_id>.json
  data/jv_cache/results/<race_id>.json
  data/jv_cache/features.json

出力:
  data/jv_cache/model_xgb.json
  data/jv_cache/model_xgb_meta.json
  data/jv_cache/model_catb.cbm  (CatBoost native format)
  data/jv_cache/model_catb_meta.json

使い方:
  py -3.12 jv_bridge\\train_ensemble.py
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
MODEL_XGB    = CACHE / "model_xgb.json"
META_XGB     = CACHE / "model_xgb_meta.json"
MODEL_CATB   = CACHE / "model_catb.cbm"
META_CATB    = CACHE / "model_catb_meta.json"

sys.path.insert(0, str(HERE.parent))
from jv_bridge.train_lightgbm import (  # noqa: E402
    FEATURE_NAMES, load_races_and_labels,
)


def train_xgb(X_arr, y_arr, race_ids, test_ratio=0.2):
    import xgboost as xgb  # type: ignore
    import numpy as np  # type: ignore
    from sklearn.metrics import roc_auc_score, log_loss  # type: ignore

    unique_races = sorted(set(race_ids))
    cut = max(1, int(len(unique_races) * (1.0 - test_ratio)))
    train_races = set(unique_races[:cut])
    train_mask = np.array([rid in train_races for rid in race_ids])
    test_mask  = ~train_mask
    Xtr, ytr = X_arr[train_mask], y_arr[train_mask]
    Xte, yte = X_arr[test_mask],  y_arr[test_mask]

    dtrain = xgb.DMatrix(Xtr, label=ytr, feature_names=FEATURE_NAMES)
    dvalid = xgb.DMatrix(Xte, label=yte, feature_names=FEATURE_NAMES)
    params = {
        "objective": "binary:logistic",
        "eval_metric": "auc",
        "max_depth": 6,
        "learning_rate": 0.04,
        "min_child_weight": 5,
        "reg_alpha": 0.15,
        "reg_lambda": 0.15,
        "subsample": 0.8,
        "colsample_bytree": 0.8,
        "verbosity": 0,
    }
    booster = xgb.train(
        params, dtrain,
        num_boost_round=600,
        evals=[(dvalid, "valid")],
        early_stopping_rounds=30,
        verbose_eval=False,
    )
    pred = booster.predict(dvalid)
    auc = roc_auc_score(yte, pred)
    logloss = log_loss(yte, pred)
    print(f"[xgb] AUC={auc:.4f} LogLoss={logloss:.4f}")

    # save (JSON 形式)
    booster.save_model(str(MODEL_XGB))
    print(f"[xgb] saved: {MODEL_XGB}")

    # feature importance
    fmap = booster.get_score(importance_type="gain")
    importance = {k: float(v) for k, v in fmap.items()}

    META_XGB.write_text(json.dumps({
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "feature_names": FEATURE_NAMES,
        "metrics": {"auc": auc, "logloss": logloss},
        "feature_importance": importance,
        "samples_train": int(train_mask.sum()),
        "samples_test":  int(test_mask.sum()),
        "params": params,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[xgb] meta saved: {META_XGB}")
    return auc, logloss


def train_catb(X_arr, y_arr, race_ids, test_ratio=0.2):
    import catboost as cb  # type: ignore
    import numpy as np  # type: ignore
    from sklearn.metrics import roc_auc_score, log_loss  # type: ignore

    unique_races = sorted(set(race_ids))
    cut = max(1, int(len(unique_races) * (1.0 - test_ratio)))
    train_races = set(unique_races[:cut])
    train_mask = np.array([rid in train_races for rid in race_ids])
    test_mask  = ~train_mask
    Xtr, ytr = X_arr[train_mask], y_arr[train_mask]
    Xte, yte = X_arr[test_mask],  y_arr[test_mask]

    model = cb.CatBoostClassifier(
        iterations=600,
        depth=6,
        learning_rate=0.04,
        l2_leaf_reg=3.0,
        eval_metric="AUC",
        early_stopping_rounds=30,
        verbose=0,
        random_seed=42,
    )
    model.fit(Xtr, ytr, eval_set=(Xte, yte))
    pred = model.predict_proba(Xte)[:, 1]
    auc = roc_auc_score(yte, pred)
    logloss = log_loss(yte, pred)
    print(f"[catb] AUC={auc:.4f} LogLoss={logloss:.4f}")

    model.save_model(str(MODEL_CATB), format="cbm")
    print(f"[catb] saved: {MODEL_CATB}")

    importance = {n: float(v) for n, v in zip(FEATURE_NAMES, model.get_feature_importance())}
    META_CATB.write_text(json.dumps({
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "feature_names": FEATURE_NAMES,
        "metrics": {"auc": auc, "logloss": logloss},
        "feature_importance": importance,
        "samples_train": int(train_mask.sum()),
        "samples_test":  int(test_mask.sum()),
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[catb] meta saved: {META_CATB}")
    return auc, logloss


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--test-ratio", type=float, default=0.2)
    parser.add_argument("--skip-xgb", action="store_true")
    parser.add_argument("--skip-catb", action="store_true")
    args = parser.parse_args(argv)

    try:
        import numpy as np  # type: ignore
    except ImportError:
        print("[ensemble_train] numpy missing")
        return 1

    print("[ensemble_train] Loading data...")
    X, y, race_ids = load_races_and_labels()
    if not X:
        print("[ensemble_train] No data")
        return 1
    X_arr = np.array(X, dtype="float64")
    y_arr = np.array(y, dtype="int32")
    print(f"[ensemble_train] {len(X_arr)} rows, {len(set(race_ids))} races")

    if not args.skip_xgb:
        print("[ensemble_train] === Training XGBoost ===")
        try:
            train_xgb(X_arr, y_arr, race_ids, args.test_ratio)
        except Exception as e:
            print(f"[xgb] error: {e}")

    if not args.skip_catb:
        print("[ensemble_train] === Training CatBoost ===")
        try:
            train_catb(X_arr, y_arr, race_ids, args.test_ratio)
        except Exception as e:
            print(f"[catb] error: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
