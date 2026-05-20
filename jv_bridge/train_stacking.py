# -*- coding: utf-8 -*-
"""
train_stacking.py — 4 モデル予測を入力に Stacking メタモデルを学習 (Wave30-C)

設計:
  1. LightGBM primary / LightGBM nopop / XGBoost / CatBoost の 4 モデルで全レース予測
  2. 各馬につき 4 つの prob を特徴量とする
  3. メタモデル (Logistic Regression) を 1着馬 yes/no で学習
  4. Walk-forward 評価で Stacking が 4 モデル単独を超えるか確認

出力:
  data/jv_cache/model_stacking.json (LR の重み)
  data/jv_cache/model_stacking_meta.json
  data/jv_cache/stacking_evaluation.json (Walk-forward 結果)
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
MODEL_XGB = CACHE / "model_xgb.json"
MODEL_CATB = CACHE / "model_catb.cbm"
STACKING_PATH = CACHE / "model_stacking.json"
META_PATH = CACHE / "model_stacking_meta.json"
EVAL_PATH = CACHE / "stacking_evaluation.json"

sys.path.insert(0, str(HERE.parent))
from jv_bridge.train_lightgbm import (  # noqa: E402
    FEATURE_NAMES, extract_horse_features, _race_context,
)
from jv_bridge.predict_lightgbm import (  # noqa: E402
    _load_model, _load_model_nopop, _predict_one, _mask_pop_features,
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
    parser.add_argument("--test-ratio", type=float, default=0.2)
    parser.add_argument("--periods", type=int, default=8)
    args = parser.parse_args(argv)

    try:
        import numpy as np
        import xgboost as xgb
        import catboost as cb
        from sklearn.linear_model import LogisticRegression
        from sklearn.metrics import roc_auc_score, log_loss
    except ImportError as e:
        print(f"missing: {e}")
        return 1

    pairs = _load_pairs()
    pairs.sort(key=lambda p: p[0])

    lgb_tup = _load_model()
    lgb_nopop_tup = _load_model_nopop()
    xgb_bst = xgb.Booster()
    xgb_bst.load_model(str(MODEL_XGB))
    catb_model = cb.CatBoostClassifier()
    catb_model.load_model(str(MODEL_CATB))
    features_index = _load_features_index()

    # 全レース予測 + ラベル
    print(f"Predicting {len(pairs)} races with 4 models...")
    cache = []  # [(rid, X_stack, y, payouts, horses)]
    for i, (rid, race, result) in enumerate(pairs):
        if i % 300 == 0: print(f"  {i}/{len(pairs)}")
        winner = _winner_num(race, result)
        horses = race.get("horses") or []
        if not horses or winner is None: continue
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

        # 各馬の (4 つの prob) + ラベル
        X_stack_race = []
        y_stack_race = []
        for h, plgb, pln, pxg, pcb in zip(horses, prob_lgb, prob_ln, prob_xgb, prob_catb):
            try: n_int = int(h.get("number"))
            except (TypeError, ValueError): continue
            X_stack_race.append([plgb, pln, pxg, pcb])
            y_stack_race.append(1 if n_int == winner else 0)
        if not X_stack_race: continue
        cache.append({
            "rid": rid,
            "X_stack": X_stack_race,
            "y_stack": y_stack_race,
            "payouts": result.get("payouts") or {},
            "horses": horses,
        })
    print(f"  Cached {len(cache)} races")

    # train/test 分割 (時系列)
    cut = int(len(cache) * (1 - args.test_ratio))
    train_cache = cache[:cut]
    test_cache = cache[cut:]
    print(f"  train: {len(train_cache)} races / test: {len(test_cache)} races")

    # X, y 配列に展開
    X_tr = np.array([row for c in train_cache for row in c["X_stack"]], dtype="float64")
    y_tr = np.array([y for c in train_cache for y in c["y_stack"]], dtype="int32")
    X_te = np.array([row for c in test_cache for row in c["X_stack"]], dtype="float64")
    y_te = np.array([y for c in test_cache for y in c["y_stack"]], dtype="int32")
    print(f"  train rows: {len(X_tr)} / test rows: {len(X_te)}")

    # Logistic Regression (Stacking メタモデル) 学習
    lr = LogisticRegression(C=1.0, max_iter=1000)
    lr.fit(X_tr, y_tr)
    pred_te = lr.predict_proba(X_te)[:, 1]
    auc = roc_auc_score(y_te, pred_te)
    loss = log_loss(y_te, pred_te)
    print(f"\n[Stacking LR] AUC: {auc:.4f}  LogLoss: {loss:.4f}")
    print(f"  weights: LGBM={lr.coef_[0][0]:.4f}, nopop={lr.coef_[0][1]:.4f}, XGB={lr.coef_[0][2]:.4f}, CatB={lr.coef_[0][3]:.4f}")
    print(f"  intercept: {lr.intercept_[0]:.4f}")

    # Stacking モデルで複勝・馬連戦略の Walk-forward を測る
    # 各レースの 4 モデル prob を fit 済 LR で混合 → softmax
    def stacked_probs(c):
        X = np.array(c["X_stack"], dtype="float64")
        raw = lr.predict_proba(X)[:, 1]
        s = float(sum(raw))
        if s <= 0: return [1.0 / len(raw)] * len(raw)
        return [r / s for r in raw]

    # Walk-forward 評価: 複勝 nopop top1 prob >= 0.16 を stack に置き換える
    print("\nEvaluating stacking on Walk-forward...")
    n_periods = args.periods
    period_size = len(cache) // n_periods
    rois_fuku = []
    rois_uren = []
    bets_fuku = 0
    bets_uren = 0
    for p in range(1, n_periods):
        lo = p * period_size
        hi = (p + 1) * period_size if p < n_periods - 1 else len(cache)
        inv_f, ret_f, bets_f = 0, 0, 0
        inv_u, ret_u, bets_u = 0, 0, 0
        for c in cache[lo:hi]:
            probs = stacked_probs(c)
            best_i = max(range(len(probs)), key=lambda i: probs[i])
            if probs[best_i] < 0.16: continue
            top_num = c["horses"][best_i].get("number")
            try: top_num_int = int(top_num)
            except (TypeError, ValueError): continue
            inv_f += 100
            ret_f += _payout_fuku(c["payouts"], top_num_int)
            bets_f += 1
            # 馬連 top2 も
            order = sorted(range(len(probs)), key=lambda i: -probs[i])
            if len(order) >= 2:
                n2 = c["horses"][order[1]].get("number")
                try: n2_int = int(n2)
                except (TypeError, ValueError): continue
                inv_u += 100
                ret_u += _payout_uren(c["payouts"], top_num_int, n2_int)
                bets_u += 1
        if inv_f > 0: rois_fuku.append(ret_f / inv_f * 100); bets_fuku += bets_f
        if inv_u > 0: rois_uren.append(ret_u / inv_u * 100); bets_uren += bets_u

    def _stat(rois):
        if not rois: return None
        avg = sum(rois) / len(rois)
        sigma = (sum((r - avg) ** 2 for r in rois) / len(rois)) ** 0.5
        return {"mean": round(avg, 2), "worst": round(min(rois), 2),
                "sigma": round(sigma, 2), "wins": sum(1 for r in rois if r >= 100),
                "periods": len(rois), "rois": [round(r, 2) for r in rois]}

    stat_f = _stat(rois_fuku)
    stat_u = _stat(rois_uren)
    print(f"\n=== Stacking 戦略 Walk-forward ===")
    if stat_f:
        print(f"複勝 stacking top1 (閾値 0.16): avg {stat_f['mean']}% / worst {stat_f['worst']} / σ {stat_f['sigma']} / 勝 {stat_f['wins']}/{stat_f['periods']} / 件数 {bets_fuku}")
    if stat_u:
        print(f"馬連 stacking top1-top2 (閾値 0.16): avg {stat_u['mean']}% / worst {stat_u['worst']} / σ {stat_u['sigma']} / 勝 {stat_u['wins']}/{stat_u['periods']} / 件数 {bets_uren}")

    # 保存
    STACKING_PATH.write_text(json.dumps({
        "method": "stacking_lr",
        "input_features": ["lgbm_prob", "nopop_prob", "xgb_prob", "catb_prob"],
        "weights": list(lr.coef_[0]),
        "intercept": float(lr.intercept_[0]),
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    META_PATH.write_text(json.dumps({
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "auc_test": auc, "logloss_test": loss,
        "weights": {"lgbm": float(lr.coef_[0][0]), "nopop": float(lr.coef_[0][1]),
                    "xgb": float(lr.coef_[0][2]), "catb": float(lr.coef_[0][3])},
        "intercept": float(lr.intercept_[0]),
        "samples_train": len(X_tr), "samples_test": len(X_te),
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    EVAL_PATH.write_text(json.dumps({
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
        "fuku_top1_prob_016": stat_f,
        "uren_top12_prob_016": stat_u,
        "total_bets_fuku": bets_fuku,
        "total_bets_uren": bets_uren,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nSaved: {STACKING_PATH.name}, {META_PATH.name}, {EVAL_PATH.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
