# -*- coding: utf-8 -*-
"""
optuna_4model_weights.py — 4 モデルの重みを Walk-forward ROI で最適化 (Wave28-B)

4 つのモデル:
  - LGBM (primary)    : 重み α
  - LGBM nopop         : 重み β
  - XGBoost            : 重み γ
  - CatBoost           : 重み δ
制約: α + β + γ + δ = 1

戦略: 「混合 prob が top1 で >= 0.22 で複勝」
objective: Walk-forward 7 期間の平均 ROI (件数 >= 300 ペナルティ)

時間がかかる (1 trial = 8 期間学習なし・全レース予測キャッシュ済なら trial 自体は速い)
予測キャッシュは 1 回だけ作る (n_trials 関係なく)

使い方:
  py -3.12 jv_bridge\\optuna_4model_weights.py --n-trials 100

出力:
  data/jv_cache/optuna_4model_best.json
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
MODEL_XGB = CACHE / "model_xgb.json"
MODEL_CATB = CACHE / "model_catb.cbm"
OUT_PATH = CACHE / "optuna_4model_best.json"

sys.path.insert(0, str(HERE.parent))
from jv_bridge.train_lightgbm import (  # noqa: E402
    FEATURE_NAMES, extract_horse_features, _race_context,
)
from jv_bridge.predict_lightgbm import (  # noqa: E402
    _load_model, _load_model_nopop, _predict_one, _mask_pop_features,
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


def _build_cache():
    """4 モデルの予測を 1 回だけ計算してキャッシュ"""
    try:
        import numpy as np
        import xgboost as xgb
        import catboost as cb
    except ImportError as e:
        print(f"missing dep: {e}")
        return None, None

    pairs = _load_pairs()
    pairs.sort(key=lambda p: p[0])

    lgb_tup = _load_model()
    lgb_nopop_tup = _load_model_nopop()
    xgb_bst = xgb.Booster()
    xgb_bst.load_model(str(MODEL_XGB))
    catb_model = cb.CatBoostClassifier()
    catb_model.load_model(str(MODEL_CATB))

    features_index = _load_features_index()

    print(f"Predicting {len(pairs)} races with 4 models...")
    cache = []
    for i, (rid, race, result) in enumerate(pairs):
        if i % 300 == 0:
            print(f"  {i}/{len(pairs)}")
        horses = race.get("horses") or []
        if not horses:
            continue
        ctx = _race_context(race)
        X = [extract_horse_features(h, race, features_index, ctx) for h in horses]
        X_arr = np.array(X, dtype="float64")

        lgb_m, lgb_k = lgb_tup
        prob_lgb = _softmax([float(p) for p in _predict_one(lgb_m, lgb_k, X_arr)])

        if lgb_nopop_tup and lgb_nopop_tup[0]:
            X_nopop = _mask_pop_features(X_arr, np)
            ln_m, ln_k = lgb_nopop_tup
            prob_ln = _softmax([float(p) for p in _predict_one(ln_m, ln_k, X_nopop)])
        else:
            prob_ln = list(prob_lgb)

        dmat = xgb.DMatrix(X_arr, feature_names=FEATURE_NAMES)
        prob_xgb = _softmax([float(p) for p in xgb_bst.predict(dmat)])

        prob_catb = _softmax([float(p) for p in catb_model.predict_proba(X_arr)[:, 1]])

        cache.append({
            "rid": rid, "horses": horses,
            "payouts": result.get("payouts") or {},
            "prob_lgb": prob_lgb,
            "prob_ln": prob_ln,
            "prob_xgb": prob_xgb,
            "prob_catb": prob_catb,
        })
    print(f"  Cached {len(cache)} races")
    return cache, pairs


def _evaluate(cache, alpha, beta, gamma, delta, threshold=0.22, periods=8):
    """混合確率で複勝戦略 ROI を Walk-forward 評価"""
    period_size = len(cache) // periods
    period_rois = []
    period_bets = []
    for p in range(1, periods):
        lo = p * period_size
        hi = (p + 1) * period_size if p < periods - 1 else len(cache)
        inv, ret, bets = 0, 0, 0
        for c in cache[lo:hi]:
            mixed_raw = [
                alpha * a + beta * b + gamma * g + delta * d
                for a, b, g, d in zip(c["prob_lgb"], c["prob_ln"], c["prob_xgb"], c["prob_catb"])
            ]
            probs = _softmax(mixed_raw)
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
            period_rois.append(ret / inv * 100)
            period_bets.append(bets)
    if not period_rois:
        return None
    avg = sum(period_rois) / len(period_rois)
    sigma = (sum((r - avg) ** 2 for r in period_rois) / len(period_rois)) ** 0.5
    return {
        "alpha": alpha, "beta": beta, "gamma": gamma, "delta": delta,
        "threshold": threshold,
        "mean_roi_pct": round(avg, 2),
        "worst_roi_pct": round(min(period_rois), 2),
        "roi_std": round(sigma, 2),
        "win_periods": sum(1 for r in period_rois if r >= 100),
        "active_periods": len(period_rois),
        "total_bets": sum(period_bets),
        "period_rois": [round(r, 2) for r in period_rois],
    }


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--n-trials", type=int, default=80)
    parser.add_argument("--threshold", type=float, default=0.22)
    parser.add_argument("--periods", type=int, default=8)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args(argv)

    try:
        import optuna
    except ImportError:
        print("optuna missing")
        return 1

    cache, pairs = _build_cache()
    if cache is None:
        return 1

    def objective(trial):
        # 3 つの "weights_logit" を Dirichlet 分布から取り出すように
        # シンプルに、4 つの非負の値 → softmax で正規化
        a_raw = trial.suggest_float("a_raw", 0.01, 1.0)
        b_raw = trial.suggest_float("b_raw", 0.01, 1.0)
        c_raw = trial.suggest_float("c_raw", 0.01, 1.0)
        d_raw = trial.suggest_float("d_raw", 0.01, 1.0)
        total = a_raw + b_raw + c_raw + d_raw
        alpha = a_raw / total
        beta  = b_raw / total
        gamma = c_raw / total
        delta = d_raw / total

        threshold = trial.suggest_float("threshold", 0.15, 0.30)

        res = _evaluate(cache, alpha, beta, gamma, delta, threshold, args.periods)
        if res is None:
            return -float("inf")
        avg = res["mean_roi_pct"]
        # 件数ペナルティ (発火少なすぎる試行は無視)
        if res["total_bets"] < 300:
            avg -= 10.0
        # σ ペナルティ
        if res["roi_std"] > 25:
            avg -= (res["roi_std"] - 25) * 0.3

        trial.set_user_attr("alpha", alpha)
        trial.set_user_attr("beta", beta)
        trial.set_user_attr("gamma", gamma)
        trial.set_user_attr("delta", delta)
        trial.set_user_attr("result", res)
        return avg

    sampler = optuna.samplers.TPESampler(seed=args.seed)
    study = optuna.create_study(direction="maximize", sampler=sampler)
    print(f"Running {args.n_trials} trials...")
    study.optimize(objective, n_trials=args.n_trials, show_progress_bar=False)

    best = study.best_trial
    res = best.user_attrs.get("result", {})
    print()
    print(f"=== Best Trial ===")
    print(f"avg ROI: {res.get('mean_roi_pct')}%")
    print(f"  α (LGBM):    {best.user_attrs.get('alpha'):.4f}")
    print(f"  β (LGBM nopop): {best.user_attrs.get('beta'):.4f}")
    print(f"  γ (XGB):     {best.user_attrs.get('gamma'):.4f}")
    print(f"  δ (CatB):    {best.user_attrs.get('delta'):.4f}")
    print(f"  threshold:   {best.params.get('threshold')}")
    print(f"  worst:       {res.get('worst_roi_pct')}%")
    print(f"  σ:           {res.get('roi_std')}")
    print(f"  勝期間:      {res.get('win_periods')}/{res.get('active_periods')}")
    print(f"  件数:        {res.get('total_bets')}")
    print(f"  ROIs:        {res.get('period_rois')}")

    out = {
        "found_at": datetime.now(timezone.utc).isoformat(),
        "best_weights": {
            "alpha_lgbm": best.user_attrs.get("alpha"),
            "beta_lgbm_nopop": best.user_attrs.get("beta"),
            "gamma_xgb": best.user_attrs.get("gamma"),
            "delta_catb": best.user_attrs.get("delta"),
        },
        "best_threshold": best.params.get("threshold"),
        "best_result": res,
        "n_trials": len(study.trials),
    }
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nSaved: {OUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
