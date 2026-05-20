# -*- coding: utf-8 -*-
"""
evaluate_ensemble.py — 3 モデル (LGBM + XGB + CatBoost) のアンサンブル評価 (Wave27-2)

各モデルで予測 → 単純平均 + LGBM のみ vs LGBM_nopop のみ vs 3 モデル平均 を比較。
Walk-forward 8 期間で「複勝 top1 prob >= 0.22」戦略の ROI を測る。

出力:
  data/jv_cache/ensemble_evaluation.json
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
OUT_PATH = CACHE / "ensemble_evaluation.json"

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


def _eval_strategy_rois(cache, prob_field, threshold, periods=8):
    """各レースの prob_field を見て複勝 top1 prob >= threshold で買う戦略の Walk-forward ROI"""
    period_size = len(cache) // periods
    period_rois = []
    period_bets = []
    for p in range(1, periods):  # period 0 は warmup
        lo = p * period_size
        hi = (p + 1) * period_size if p < periods - 1 else len(cache)
        inv, ret, bets = 0, 0, 0
        for c in cache[lo:hi]:
            probs = c[prob_field]
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
            period_rois.append(round(ret / inv * 100, 2))
            period_bets.append(bets)
        else:
            period_rois.append(None)
            period_bets.append(0)
    valid = [r for r in period_rois if r is not None]
    if not valid:
        return None
    avg = sum(valid) / len(valid)
    sigma = (sum((r - avg) ** 2 for r in valid) / len(valid)) ** 0.5
    return {
        "mean_roi_pct": round(avg, 2),
        "worst_roi_pct": round(min(valid), 2),
        "best_roi_pct": round(max(valid), 2),
        "roi_std": round(sigma, 2),
        "win_periods": sum(1 for r in valid if r >= 100),
        "active_periods": len(valid),
        "total_bets": sum(period_bets),
        "period_rois": period_rois,
        "period_bets": period_bets,
    }


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--threshold", type=float, default=0.22)
    parser.add_argument("--periods", type=int, default=8)
    args = parser.parse_args(argv)

    try:
        import numpy as np  # type: ignore
        import xgboost as xgb  # type: ignore
        import catboost as cb  # type: ignore
    except ImportError as e:
        print(f"[evaluate_ensemble] missing dep: {e}")
        return 1

    pairs = _load_pairs()
    pairs.sort(key=lambda p: p[0])
    if not pairs:
        print("[evaluate_ensemble] No data")
        return 1
    print(f"[evaluate_ensemble] {len(pairs)} pairs")

    # 3 モデル + LGBM nopop ロード
    print("[evaluate_ensemble] Loading models...")
    lgb_tup = _load_model()
    lgb_nopop_tup = _load_model_nopop()
    xgb_bst = xgb.Booster()
    xgb_bst.load_model(str(MODEL_XGB))
    catb_model = cb.CatBoostClassifier()
    catb_model.load_model(str(MODEL_CATB))

    features_index = _load_features_index()

    # 全レースで 4 モデルの予測を一度だけ計算
    print(f"[evaluate_ensemble] Predicting {len(pairs)} races with 4 models...")
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

        # LGBM primary
        lgb_m, lgb_k = lgb_tup
        raw_lgb = list(_predict_one(lgb_m, lgb_k, X_arr))
        prob_lgb = _softmax([float(p) for p in raw_lgb])

        # LGBM nopop
        if lgb_nopop_tup and lgb_nopop_tup[0]:
            X_nopop = _mask_pop_features(X_arr, np)
            ln_m, ln_k = lgb_nopop_tup
            raw_ln = list(_predict_one(ln_m, ln_k, X_nopop))
            prob_ln = _softmax([float(p) for p in raw_ln])
        else:
            prob_ln = list(prob_lgb)

        # XGBoost
        dmat = xgb.DMatrix(X_arr, feature_names=FEATURE_NAMES)
        raw_xgb = list(xgb_bst.predict(dmat))
        prob_xgb = _softmax([float(p) for p in raw_xgb])

        # CatBoost
        raw_catb = list(catb_model.predict_proba(X_arr)[:, 1])
        prob_catb = _softmax([float(p) for p in raw_catb])

        # 3 モデル単純平均 (LGBM + XGB + CatBoost) - all popularity-aware
        prob_ens3 = [(a + b + c) / 3 for a, b, c in zip(prob_lgb, prob_xgb, prob_catb)]
        # 4 モデル平均 (3 モデル + nopop)
        prob_ens4 = [(a + b + c + d) / 4 for a, b, c, d in zip(prob_lgb, prob_xgb, prob_catb, prob_ln)]
        # 価値投資: 50% nopop + 50% (3-model avg)
        prob_value = [0.5 * d + 0.5 / 3 * (a + b + c) for a, b, c, d in zip(prob_lgb, prob_xgb, prob_catb, prob_ln)]

        cache.append({
            "rid": rid,
            "horses": horses,
            "payouts": result.get("payouts") or {},
            "prob_lgb": prob_lgb,
            "prob_ln": prob_ln,
            "prob_xgb": prob_xgb,
            "prob_catb": prob_catb,
            "prob_ens3": prob_ens3,
            "prob_ens4": prob_ens4,
            "prob_value": prob_value,
        })
    print(f"  Cached {len(cache)} races")

    # 各 prob_field で評価
    results = {}
    for field, name in [
        ("prob_lgb", "LGBM (primary)"),
        ("prob_ln", "LGBM nopop"),
        ("prob_xgb", "XGBoost"),
        ("prob_catb", "CatBoost"),
        ("prob_ens3", "3 モデル平均 (LGBM+XGB+CatB)"),
        ("prob_ens4", "4 モデル平均 (+ nopop)"),
        ("prob_value", "Value 50%nopop+50%(3model)"),
    ]:
        print(f"[evaluate_ensemble] Evaluating {name}...")
        res = _eval_strategy_rois(cache, field, args.threshold, args.periods)
        results[name] = res

    # 結果表示
    print()
    print("=" * 95)
    print(f"{'モデル':<35}{'avg ROI':<12}{'worst':<10}{'σ':<8}{'勝期間':<10}{'件数':<10}")
    print("=" * 95)
    for name, r in results.items():
        if r is None:
            print(f"{name:<35}発火なし")
            continue
        win = f"{r['win_periods']}/{r['active_periods']}"
        print(f"{name:<35}{r['mean_roi_pct']:<12.2f}{r['worst_roi_pct']:<10.2f}{r['roi_std']:<8.2f}{win:<10}{r['total_bets']:<10}")
    print("=" * 95)

    out = {
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
        "threshold": args.threshold,
        "periods": args.periods,
        "results": results,
    }
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[evaluate_ensemble] Saved: {OUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
