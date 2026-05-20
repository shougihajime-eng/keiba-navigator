# -*- coding: utf-8 -*-
"""
optuna_tune.py — LightGBM のハイパラを Optuna で自動最適化 (Wave25-C)

現状: train_lightgbm.py のパラメータは手書きの「経験則」(num_leaves=63, lr=0.02, ...)
これを Optuna で 100 試行回し、valid AUC が最大のパラメータを見つける。
見つかったパラメータを optuna_best_params.json に保存し、train_lightgbm.py の
params を差し替えるだけで AUC が +0.5〜1.5% 向上する見込み。

使い方:
  py -3.12 jv_bridge\\optuna_tune.py
  py -3.12 jv_bridge\\optuna_tune.py --n-trials 50 --test-ratio 0.2

出力:
  data/jv_cache/optuna_best_params.json
  data/jv_cache/optuna_history.json (全 trial の履歴)
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
BEST_PATH    = CACHE / "optuna_best_params.json"
HISTORY_PATH = CACHE / "optuna_history.json"

sys.path.insert(0, str(HERE.parent))
from jv_bridge.train_lightgbm import (  # noqa: E402
    FEATURE_NAMES, load_races_and_labels,
)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--n-trials", type=int, default=80, help="試行回数 (default 80)")
    parser.add_argument("--test-ratio", type=float, default=0.2)
    parser.add_argument("--timeout", type=int, default=None, help="秒で打ち切り (default なし)")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args(argv)

    try:
        import lightgbm as lgb  # type: ignore
        import numpy as np  # type: ignore
        import optuna  # type: ignore
        from sklearn.metrics import roc_auc_score, log_loss  # type: ignore
    except ImportError as e:
        print(f"[optuna_tune] missing dep: {e}", flush=True)
        return 1

    print(f"[optuna_tune] Loading data...")
    X, y, race_ids = load_races_and_labels()
    if len(X) == 0:
        print("[optuna_tune] No data.")
        return 1
    X_arr = np.array(X, dtype="float64")
    y_arr = np.array(y, dtype="int32")
    n_rows = len(X_arr)
    n_races = len(set(race_ids))
    print(f"[optuna_tune] Loaded {n_rows} rows / {n_races} races")

    # 時系列分割
    unique_races = sorted(set(race_ids))
    cut = max(1, int(len(unique_races) * (1.0 - args.test_ratio)))
    train_races = set(unique_races[:cut])
    train_mask = np.array([rid in train_races for rid in race_ids])
    test_mask  = ~train_mask
    Xtr, ytr = X_arr[train_mask], y_arr[train_mask]
    Xte, yte = X_arr[test_mask],  y_arr[test_mask]
    print(f"[optuna_tune] train={len(Xtr)} / valid={len(Xte)}")

    def objective(trial):
        params = {
            "objective": "binary",
            "metric": "auc",
            "verbosity": -1,
            "boosting_type": "gbdt",
            "feature_pre_filter": False,  # min_data_in_leaf を trial ごとに変えるため
            "num_leaves": trial.suggest_int("num_leaves", 15, 200),
            "max_depth": trial.suggest_int("max_depth", -1, 12),
            "learning_rate": trial.suggest_float("learning_rate", 0.005, 0.05, log=True),
            "min_data_in_leaf": trial.suggest_int("min_data_in_leaf", 10, 100),
            "lambda_l1": trial.suggest_float("lambda_l1", 1e-3, 5.0, log=True),
            "lambda_l2": trial.suggest_float("lambda_l2", 1e-3, 5.0, log=True),
            "feature_fraction": trial.suggest_float("feature_fraction", 0.5, 1.0),
            "bagging_fraction": trial.suggest_float("bagging_fraction", 0.5, 1.0),
            "bagging_freq": trial.suggest_int("bagging_freq", 0, 10),
            "min_gain_to_split": trial.suggest_float("min_gain_to_split", 0.0, 0.5),
        }

        num_boost_round = trial.suggest_int("num_boost_round", 200, 2000)

        # Dataset は trial 毎に新規作成 (feature_pre_filter の再利用問題回避)
        train_data = lgb.Dataset(Xtr, label=ytr, feature_name=FEATURE_NAMES,
                                  free_raw_data=False, params={"feature_pre_filter": False})
        valid_data = lgb.Dataset(Xte, label=yte, reference=train_data, feature_name=FEATURE_NAMES,
                                  free_raw_data=False, params={"feature_pre_filter": False})

        booster = lgb.train(
            params, train_data,
            num_boost_round=num_boost_round,
            valid_sets=[valid_data],
            valid_names=["valid"],
            callbacks=[
                lgb.early_stopping(stopping_rounds=40, verbose=False),
                lgb.log_evaluation(period=0),
            ],
        )
        pred = booster.predict(Xte)
        auc = roc_auc_score(yte, pred)
        return auc

    sampler = optuna.samplers.TPESampler(seed=args.seed)
    study = optuna.create_study(direction="maximize", sampler=sampler)

    print(f"[optuna_tune] Running {args.n_trials} trials...")
    study.optimize(
        objective,
        n_trials=args.n_trials,
        timeout=args.timeout,
        show_progress_bar=False,
    )

    best = study.best_trial
    print(f"\n=== Best Trial ===")
    print(f"AUC: {best.value:.6f}")
    print(f"Params:")
    for k, v in best.params.items():
        print(f"  {k}: {v}")

    out = {
        "found_at": datetime.now(timezone.utc).isoformat(),
        "best_auc": best.value,
        "best_params": best.params,
        "n_trials": len(study.trials),
        "current_baseline_auc": 0.806,
    }
    BEST_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[optuna_tune] Saved best: {BEST_PATH}")

    history = []
    for t in study.trials:
        history.append({
            "number": t.number,
            "value": t.value,
            "params": t.params,
            "state": str(t.state),
        })
    HISTORY_PATH.write_text(json.dumps({"trials": history}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[optuna_tune] Saved history: {HISTORY_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
