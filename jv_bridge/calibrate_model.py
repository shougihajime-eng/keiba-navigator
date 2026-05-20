# -*- coding: utf-8 -*-
"""
calibrate_model.py — LightGBM の予測確率を Platt scaling で校正する (Wave25-B)

問題:
  LightGBM の出力 raw_score を softmax 正規化した「prob」は順位は良いが、
  実際の的中率と prob のキャリブレーションがズレている可能性がある。
  例えば「prob 30% と予測した馬が実際は 25% しか勝てない」など。
  これを Platt scaling (logistic regression) で校正する。

  校正後の prob は「20% と予測したら 20% で勝つ」という意味になり、
  EV 計算 (prob × odds) の信頼性が大きく向上する。

入力:
  data/jv_cache/races/<race_id>.json
  data/jv_cache/results/<race_id>.json
  data/jv_cache/features.json
  data/jv_cache/model_lgbm.txt

出力:
  data/jv_cache/calibration.json  {"a": float, "b": float, "method": "platt",
                                   "before_brier": ..., "after_brier": ...}

  校正後の prob は: p_cal = sigmoid(a * logit(p_raw) + b)

使い方:
  py -3.12 jv_bridge\\calibrate_model.py
  py -3.12 jv_bridge\\calibrate_model.py --test-ratio 0.2
"""
from __future__ import annotations

import argparse
import io
import json
import math
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

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
OUT_PATH = CACHE / "calibration.json"

sys.path.insert(0, str(HERE.parent))
from jv_bridge.train_lightgbm import (  # noqa: E402
    FEATURE_NAMES, extract_horse_features, _race_context,
)
from jv_bridge.predict_lightgbm import (  # noqa: E402
    _load_model, _predict_one, _normalize_softmax,
)
from jv_bridge.validate_lightgbm import (  # noqa: E402
    _load_features_index,
)


def _safe_logit(p: float, eps: float = 1e-7) -> float:
    p = max(eps, min(1.0 - eps, p))
    return math.log(p / (1 - p))


def _sigmoid(z: float) -> float:
    if z >= 0:
        ez = math.exp(-z)
        return 1.0 / (1.0 + ez)
    ez = math.exp(z)
    return ez / (1.0 + ez)


def _brier_score(probs: List[float], labels: List[int]) -> float:
    """Brier Score (低いほど良い)"""
    if not probs:
        return 0.0
    s = 0.0
    for p, y in zip(probs, labels):
        s += (p - y) ** 2
    return s / len(probs)


def _log_loss(probs: List[float], labels: List[int]) -> float:
    s = 0.0
    eps = 1e-7
    for p, y in zip(probs, labels):
        p = max(eps, min(1.0 - eps, p))
        s += -(y * math.log(p) + (1 - y) * math.log(1 - p))
    return s / len(probs)


def _calibration_table(probs: List[float], labels: List[int], bins: int = 10):
    """予測確率 vs 実際の的中率を bin ごとに集計 (キャリブレーションプロット用)"""
    rows = []
    for i in range(bins):
        lo = i / bins
        hi = (i + 1) / bins
        bucket_p = []
        bucket_y = []
        for p, y in zip(probs, labels):
            if lo <= p < hi or (i == bins - 1 and p == 1.0):
                bucket_p.append(p)
                bucket_y.append(y)
        if not bucket_p:
            continue
        rows.append({
            "bin": f"{lo:.2f}-{hi:.2f}",
            "n": len(bucket_p),
            "predicted_mean": sum(bucket_p) / len(bucket_p),
            "actual_rate": sum(bucket_y) / len(bucket_y),
        })
    return rows


def _fit_platt(raw_probs: List[float], labels: List[int]) -> Tuple[float, float]:
    """Platt scaling を simple gradient descent で fit.
    p_cal = sigmoid(a * logit(p_raw) + b)
    a, b を最尤推定 (log loss を最小化)
    """
    if not raw_probs:
        return (1.0, 0.0)
    # 特徴量 x = logit(p_raw)
    X = [_safe_logit(p) for p in raw_probs]
    y = labels
    n = len(X)

    a, b = 1.0, 0.0
    lr = 0.05
    n_iter = 1500
    best_loss = float("inf")
    best_a, best_b = a, b

    for it in range(n_iter):
        # gradient
        ga = 0.0
        gb = 0.0
        loss = 0.0
        for xi, yi in zip(X, y):
            z = a * xi + b
            p = _sigmoid(z)
            err = p - yi
            ga += err * xi
            gb += err
            # log loss
            ep = max(1e-7, min(1 - 1e-7, p))
            loss += -(yi * math.log(ep) + (1 - yi) * math.log(1 - ep))
        ga /= n
        gb /= n
        loss /= n
        if loss < best_loss:
            best_loss = loss
            best_a, best_b = a, b
        a -= lr * ga
        b -= lr * gb
        # learning rate decay
        if it == 800:
            lr *= 0.4
        if it == 1200:
            lr *= 0.4
    return (best_a, best_b)


def _load_race_results() -> List[Tuple[str, Dict, Dict]]:
    pairs = []
    for race_file in sorted(RACES_DIR.glob("*.json")):
        rid = race_file.stem
        result_file = RESULTS_DIR / f"{rid}.json"
        if not result_file.exists():
            continue
        try:
            race = json.loads(race_file.read_text(encoding="utf-8"))
            result = json.loads(result_file.read_text(encoding="utf-8"))
            if not race.get("horses"):
                continue
            pairs.append((rid, race, result))
        except Exception:
            continue
    return pairs


def _winner_number_from_result(result: Dict[str, Any]) -> Optional[int]:
    """payouts.tan.winner から 1着馬番を取得"""
    tan = (result.get("payouts") or {}).get("tan")
    if isinstance(tan, dict):
        w = tan.get("winner")
        try:
            return int(w)
        except (TypeError, ValueError):
            return None
    # フォールバック: 各馬の確定着順から
    horses = result.get("horses") or []
    for h in horses:
        if h.get("kakutei_jyuni") == 1 or h.get("finish") == 1:
            try:
                return int(h.get("number"))
            except (TypeError, ValueError):
                return None
    return None


def _winner_from_race_result_pair(race: Dict[str, Any], result: Dict[str, Any]) -> Optional[int]:
    """race と result を見て 1 着馬番を返す"""
    n = _winner_number_from_result(result)
    if n is not None:
        return n
    # race 側にも kakutei_jyuni が乗っている (build_all で merge)
    horses = race.get("horses") or []
    for h in horses:
        if h.get("kakutei_jyuni") == 1:
            try:
                return int(h.get("number"))
            except (TypeError, ValueError):
                return None
    return None


def collect_predictions_and_labels(pairs):
    """全レースの (prob, label) ペアを集める"""
    model_tup = _load_model()
    if model_tup is None or model_tup[0] is None:
        print("[calibrate] No model. Run train_lightgbm.py first.")
        return None, None
    model, kind = model_tup
    features_index = _load_features_index()

    try:
        import numpy as np  # type: ignore
    except ImportError:
        np = None

    all_probs = []
    all_labels = []

    print(f"[calibrate] Predicting {len(pairs)} races...")
    for i, (rid, race, result) in enumerate(pairs):
        if i % 200 == 0:
            print(f"  {i}/{len(pairs)}")
        winner = _winner_from_race_result_pair(race, result)
        horses = race.get("horses") or []
        if not horses or winner is None:
            continue
        ctx = _race_context(race)
        X = [extract_horse_features(h, race, features_index, ctx) for h in horses]
        try:
            if np is not None:
                X_arr = np.array(X, dtype="float64")
            else:
                X_arr = X
            raw = list(_predict_one(model, kind, X_arr))
            probs = _normalize_softmax([float(p) for p in raw])
        except Exception:
            continue
        for h, p in zip(horses, probs):
            n = h.get("number")
            try:
                n_int = int(n)
            except (TypeError, ValueError):
                continue
            all_probs.append(p)
            all_labels.append(1 if n_int == winner else 0)
    print(f"  Collected {len(all_probs)} (prob, label) pairs")
    return all_probs, all_labels


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--test-ratio", type=float, default=0.2,
                        help="後ろから何割を validation/test として校正に使う")
    parser.add_argument("--use-all", action="store_true",
                        help="train/test 分割せず全レースで校正")
    args = parser.parse_args(argv)

    pairs = _load_race_results()
    if not pairs:
        print("[calibrate] No race-result pairs.")
        return 1
    pairs.sort(key=lambda p: p[0])
    if not args.use_all:
        cut = int(len(pairs) * (1 - args.test_ratio))
        pairs = pairs[cut:]
    print(f"[calibrate] Using {len(pairs)} race-result pairs.")

    probs, labels = collect_predictions_and_labels(pairs)
    if not probs:
        print("[calibrate] Nothing to fit.")
        return 1

    # 校正前
    before_brier = _brier_score(probs, labels)
    before_loss  = _log_loss(probs, labels)
    before_table = _calibration_table(probs, labels)

    # Platt scaling fit
    print("[calibrate] Fitting Platt scaling (1500 iter)...")
    a, b = _fit_platt(probs, labels)

    # 校正後
    cal_probs = [_sigmoid(a * _safe_logit(p) + b) for p in probs]
    after_brier = _brier_score(cal_probs, labels)
    after_loss  = _log_loss(cal_probs, labels)
    after_table = _calibration_table(cal_probs, labels)

    print()
    print(f"=== Calibration Result ===")
    print(f"a = {a:.6f}, b = {b:.6f}")
    print(f"Brier (before → after): {before_brier:.6f} → {after_brier:.6f} (Δ {before_brier - after_brier:+.6f})")
    print(f"LogLoss (before → after): {before_loss:.6f} → {after_loss:.6f} (Δ {before_loss - after_loss:+.6f})")
    print()
    print("=== Calibration Table (before) ===")
    print(f"{'bin':<14}{'n':<7}{'predicted':<14}{'actual':<10}")
    for r in before_table:
        print(f"{r['bin']:<14}{r['n']:<7}{r['predicted_mean']:<14.4f}{r['actual_rate']:<10.4f}")
    print()
    print("=== Calibration Table (after) ===")
    print(f"{'bin':<14}{'n':<7}{'predicted':<14}{'actual':<10}")
    for r in after_table:
        print(f"{r['bin']:<14}{r['n']:<7}{r['predicted_mean']:<14.4f}{r['actual_rate']:<10.4f}")

    out = {
        "method": "platt",
        "a": a,
        "b": b,
        "before_brier": before_brier,
        "after_brier": after_brier,
        "before_logloss": before_loss,
        "after_logloss": after_loss,
        "samples": len(probs),
        "before_table": before_table,
        "after_table": after_table,
    }
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[calibrate] Saved: {OUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
