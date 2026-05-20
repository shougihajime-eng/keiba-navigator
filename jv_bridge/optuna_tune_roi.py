# -*- coding: utf-8 -*-
"""
optuna_tune_roi.py — Optuna の objective を「Walk-forward 平均 ROI」に変更 (Wave26-A)

Wave25 の失敗を踏まえて: AUC を最大化しても ROI は上がらない (むしろ下がる)。
真に「世界一当たる」予想を目指すなら、Walk-forward 8 期間の平均 ROI を
直接最適化すべき。

各 trial で:
  1. 与えられたパラメータで複数期間それぞれで学習・評価
  2. 「複勝 prob >= 0.22 で買う」のような検証用戦略で ROI 計算
  3. 全期間の平均 ROI を返す

時間がかかるので n_trials は控えめ (default 15)。

使い方:
  py -3.12 jv_bridge\\optuna_tune_roi.py
  py -3.12 jv_bridge\\optuna_tune_roi.py --n-trials 20 --periods 5

出力:
  data/jv_cache/optuna_roi_best.json
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
OUT_PATH = CACHE / "optuna_roi_best.json"

sys.path.insert(0, str(HERE.parent))
from jv_bridge.train_lightgbm import (  # noqa: E402
    FEATURE_NAMES, extract_horse_features, _race_context, load_races_and_labels,
)
from jv_bridge.validate_lightgbm import (  # noqa: E402
    _payout_fuku, _payout_uren, _payout_wide, _load_features_index,
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


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--n-trials", type=int, default=15)
    parser.add_argument("--periods", type=int, default=5,
                        help="Walk-forward 期間数 (warmup 含む)")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args(argv)

    try:
        import lightgbm as lgb  # type: ignore
        import numpy as np  # type: ignore
        import optuna  # type: ignore
    except ImportError as e:
        print(f"[optuna_tune_roi] missing dep: {e}")
        return 1

    print(f"[optuna_tune_roi] Loading data...")
    pairs = _load_pairs()
    pairs.sort(key=lambda p: p[0])
    if not pairs:
        print("[optuna_tune_roi] No data.")
        return 1
    print(f"[optuna_tune_roi] {len(pairs)} race-result pairs")

    X_all, y_all, race_ids_all = load_races_and_labels()
    if not X_all:
        print("[optuna_tune_roi] No training rows.")
        return 1
    X_arr = np.array(X_all, dtype="float64")
    y_arr = np.array(y_all, dtype="int32")
    race_ids_arr = race_ids_all

    # 期間に分割 (race_id 昇順で N 等分)
    unique_races_sorted = sorted(set(race_ids_arr))
    n_races = len(unique_races_sorted)
    period_size = n_races // args.periods
    period_ranges = []
    for i in range(args.periods):
        lo = i * period_size
        hi = (i + 1) * period_size if i < args.periods - 1 else n_races
        period_ranges.append((lo, hi))
    print(f"[optuna_tune_roi] {args.periods} periods × {period_size} races each")

    # race_id → period index map
    rid_to_period = {}
    for p_idx, (lo, hi) in enumerate(period_ranges):
        for rid in unique_races_sorted[lo:hi]:
            rid_to_period[rid] = p_idx

    features_index = _load_features_index()

    # 各期間ごとに「(test pairs)」を準備
    test_pairs_per_period = {p_idx: [] for p_idx in range(args.periods)}
    for (rid, race, result) in pairs:
        p_idx = rid_to_period.get(rid)
        if p_idx is not None:
            test_pairs_per_period[p_idx].append((rid, race, result))

    def _eval_period_roi(booster, period_idx):
        """1 期間の ROI (複勝 prob >= 0.22 で買う戦略) を返す"""
        invested = 0
        returned = 0
        bets = 0
        for (rid, race, result) in test_pairs_per_period[period_idx]:
            horses = race.get("horses") or []
            if not horses:
                continue
            ctx = _race_context(race)
            X = [extract_horse_features(h, race, features_index, ctx) for h in horses]
            X_pred = np.array(X, dtype="float64")
            try:
                raw = list(booster.predict(X_pred))
            except Exception:
                continue
            # softmax 正規化
            s = sum(p for p in raw if p > 0)
            if s <= 0:
                continue
            probs = [max(0.0, p) / s for p in raw]
            # 最大 prob の馬
            best_i = max(range(len(probs)), key=lambda i: probs[i])
            best_p = probs[best_i]
            if best_p < 0.22:
                continue
            top_num = horses[best_i].get("number")
            if top_num is None:
                continue
            try:
                top_num_int = int(top_num)
            except (TypeError, ValueError):
                continue
            invested += 100
            ret = _payout_fuku(result.get("payouts") or {}, top_num_int)
            returned += ret
            bets += 1
        if invested == 0:
            return None, 0
        return (returned / invested) * 100, bets

    def objective(trial):
        params = {
            "objective": "binary",
            "metric": "auc",
            "verbosity": -1,
            "boosting_type": "gbdt",
            "feature_pre_filter": False,
            "num_leaves": trial.suggest_int("num_leaves", 31, 127),
            "max_depth": trial.suggest_int("max_depth", -1, 10),
            "learning_rate": trial.suggest_float("learning_rate", 0.01, 0.05, log=True),
            "min_data_in_leaf": trial.suggest_int("min_data_in_leaf", 15, 80),
            "lambda_l1": trial.suggest_float("lambda_l1", 1e-3, 5.0, log=True),
            "lambda_l2": trial.suggest_float("lambda_l2", 1e-3, 5.0, log=True),
            "feature_fraction": trial.suggest_float("feature_fraction", 0.6, 1.0),
            "bagging_fraction": trial.suggest_float("bagging_fraction", 0.6, 1.0),
            "bagging_freq": trial.suggest_int("bagging_freq", 0, 7),
        }
        num_boost = trial.suggest_int("num_boost_round", 300, 1500)

        # 期間 1, 2, ..., N-1 を test に。各期間より前を train に。
        # (期間 0 は warmup として skip = 学習データが少ないため)
        all_rois = []
        total_bets = 0
        for test_p in range(1, args.periods):
            train_mask = np.array([rid_to_period.get(rid, -1) < test_p for rid in race_ids_arr])
            test_mask = np.array([rid_to_period.get(rid, -1) == test_p for rid in race_ids_arr])
            if train_mask.sum() < 1000 or test_mask.sum() < 100:
                continue

            train_data = lgb.Dataset(X_arr[train_mask], label=y_arr[train_mask],
                                      feature_name=FEATURE_NAMES,
                                      params={"feature_pre_filter": False})
            valid_data = lgb.Dataset(X_arr[test_mask], label=y_arr[test_mask],
                                      reference=train_data, feature_name=FEATURE_NAMES,
                                      params={"feature_pre_filter": False})
            booster = lgb.train(
                params, train_data,
                num_boost_round=num_boost,
                valid_sets=[valid_data],
                valid_names=["valid"],
                callbacks=[
                    lgb.early_stopping(stopping_rounds=30, verbose=False),
                    lgb.log_evaluation(period=0),
                ],
            )
            roi, bets = _eval_period_roi(booster, test_p)
            if roi is not None:
                all_rois.append(roi)
                total_bets += bets

        if not all_rois:
            return -float("inf")

        avg_roi = sum(all_rois) / len(all_rois)
        # 件数が少なすぎる試行はペナルティ (発火しなさすぎ)
        if total_bets < 50:
            avg_roi -= 5.0
        # σ (分散) もチェック (安定性)
        if len(all_rois) >= 2:
            mean = avg_roi
            var = sum((r - mean) ** 2 for r in all_rois) / len(all_rois)
            sigma = var ** 0.5
            # σ ペナルティ: σ が 15 を超えるとマイナス
            if sigma > 15:
                avg_roi -= (sigma - 15) * 0.3

        # trial に periods 別 ROI を user_attr 保存
        trial.set_user_attr("rois", all_rois)
        trial.set_user_attr("bets", total_bets)
        return avg_roi

    sampler = optuna.samplers.TPESampler(seed=args.seed)
    study = optuna.create_study(direction="maximize", sampler=sampler)

    print(f"[optuna_tune_roi] Running {args.n_trials} trials (each = {args.periods - 1} learn+evals)...")
    study.optimize(objective, n_trials=args.n_trials, show_progress_bar=False)

    best = study.best_trial
    print(f"\n=== Best Trial (Walk-forward ROI) ===")
    print(f"Average ROI: {best.value:.2f}%")
    print(f"ROIs per period: {best.user_attrs.get('rois')}")
    print(f"Total bets: {best.user_attrs.get('bets')}")
    print(f"Params:")
    for k, v in best.params.items():
        print(f"  {k}: {v}")

    out = {
        "found_at": datetime.now(timezone.utc).isoformat(),
        "best_avg_roi_pct": best.value,
        "best_rois": best.user_attrs.get("rois"),
        "best_total_bets": best.user_attrs.get("bets"),
        "best_params": best.params,
        "n_trials": len(study.trials),
        "strategy": "fuku_top1_prob_022",
    }
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[optuna_tune_roi] Saved: {OUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
