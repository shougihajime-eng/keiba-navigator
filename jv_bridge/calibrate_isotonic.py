# -*- coding: utf-8 -*-
"""
calibrate_isotonic.py — nopop モデルを Isotonic Regression で校正 (Wave29-C)

Wave28-C で nopop モデルが prob を 1/2〜1/3 に過小評価していると判明。
Platt scaling は線形補正で改善幅 1.9% に留まった。

Isotonic Regression は単調増加関数を fit するので、より柔軟に非線形補正が可能。
特に「predicted 30% → actual 80%」のような大きく非線形なズレに強い。

校正後のテーブル + Brier / LogLoss 改善を測定。
さらに校正後 prob で VALUE 戦略 (閾値 0.16/0.22/0.30) の Walk-forward ROI を再評価。

出力:
  data/jv_cache/calibration_isotonic_nopop.json
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
OUT_PATH = CACHE / "calibration_isotonic_nopop.json"

sys.path.insert(0, str(HERE.parent))
from jv_bridge.train_lightgbm import (  # noqa: E402
    FEATURE_NAMES, extract_horse_features, _race_context,
)
from jv_bridge.predict_lightgbm import (  # noqa: E402
    _load_model_nopop, _predict_one, _normalize_softmax, _mask_pop_features,
)
from jv_bridge.validate_lightgbm import (  # noqa: E402
    _payout_fuku, _load_features_index,
)


def _brier(probs, labels):
    return sum((p - y) ** 2 for p, y in zip(probs, labels)) / max(1, len(probs))


def _log_loss(probs, labels):
    eps = 1e-7
    s = 0.0
    for p, y in zip(probs, labels):
        p = max(eps, min(1 - eps, p))
        s += -(y * math.log(p) + (1 - y) * math.log(1 - p))
    return s / max(1, len(probs))


def _calibration_table(probs, labels, bins=10):
    rows = []
    for i in range(bins):
        lo = i / bins
        hi = (i + 1) / bins
        bp, by = [], []
        for p, y in zip(probs, labels):
            if lo <= p < hi or (i == bins - 1 and p == 1.0):
                bp.append(p); by.append(y)
        if bp:
            rows.append({"bin": f"{lo:.2f}-{hi:.2f}", "n": len(bp),
                          "predicted_mean": sum(bp) / len(bp),
                          "actual_rate": sum(by) / len(by)})
    return rows


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--test-ratio", type=float, default=0.2)
    args = parser.parse_args(argv)

    try:
        import numpy as np
        from sklearn.isotonic import IsotonicRegression
    except ImportError as e:
        print(f"missing: {e}")
        return 1

    # 全レースを race_id 順に並べる
    pairs = []
    for race_file in sorted(RACES_DIR.glob("*.json")):
        rid = race_file.stem
        rfile = RESULTS_DIR / f"{rid}.json"
        if not rfile.exists(): continue
        try:
            race = json.loads(race_file.read_text(encoding="utf-8"))
            result = json.loads(rfile.read_text(encoding="utf-8"))
            if not race.get("horses"): continue
            pairs.append((rid, race, result))
        except Exception:
            continue
    pairs.sort(key=lambda p: p[0])

    nopop_tup = _load_model_nopop()
    if nopop_tup is None or nopop_tup[0] is None:
        print("no nopop model")
        return 1
    model, kind = nopop_tup
    features_index = _load_features_index()

    # 全予測 + ラベルを集める
    print(f"Predicting {len(pairs)} races...")
    all_probs = []
    all_labels = []
    for i, (rid, race, result) in enumerate(pairs):
        if i % 300 == 0: print(f"  {i}/{len(pairs)}")
        winner = None
        tan = (result.get("payouts") or {}).get("tan")
        if isinstance(tan, dict):
            try: winner = int(tan.get("winner"))
            except (TypeError, ValueError): winner = None
        if winner is None:
            for h in race.get("horses") or []:
                if h.get("kakutei_jyuni") == 1:
                    try: winner = int(h.get("number")); break
                    except (TypeError, ValueError): pass
        if winner is None: continue

        horses = race.get("horses") or []
        if not horses: continue
        ctx = _race_context(race)
        X = [extract_horse_features(h, race, features_index, ctx) for h in horses]
        X_arr = np.array(X, dtype="float64")
        X_nopop = _mask_pop_features(X_arr, np)
        raw = list(_predict_one(model, kind, X_nopop))
        probs = _normalize_softmax([float(p) for p in raw])
        for h, p in zip(horses, probs):
            try:
                n_int = int(h.get("number"))
            except (TypeError, ValueError): continue
            all_probs.append(p)
            all_labels.append(1 if n_int == winner else 0)
    print(f"  Collected {len(all_probs)} pairs")

    # train/test 分割 (時系列順)
    n = len(all_probs)
    cut = int(n * (1 - args.test_ratio))
    train_p = all_probs[:cut]
    train_y = all_labels[:cut]
    test_p = all_probs[cut:]
    test_y = all_labels[cut:]
    print(f"  train: {len(train_p)} / test: {len(test_p)}")

    # 校正前
    before_brier_test = _brier(test_p, test_y)
    before_loss_test = _log_loss(test_p, test_y)
    before_table = _calibration_table(test_p, test_y)

    # Isotonic Regression を train で fit
    iso = IsotonicRegression(out_of_bounds="clip")
    iso.fit(train_p, train_y)
    # test を校正
    test_cal = list(iso.predict(test_p))

    after_brier_test = _brier(test_cal, test_y)
    after_loss_test = _log_loss(test_cal, test_y)
    after_table = _calibration_table(test_cal, test_y)

    print()
    print(f"=== Isotonic Calibration Result (test) ===")
    print(f"Brier   : {before_brier_test:.6f} → {after_brier_test:.6f} (Δ {before_brier_test - after_brier_test:+.6f})")
    print(f"LogLoss : {before_loss_test:.6f} → {after_loss_test:.6f} (Δ {before_loss_test - after_loss_test:+.6f})")
    print()
    print("=== Calibration Table BEFORE (test) ===")
    print(f"{'bin':<14}{'n':<7}{'predicted':<14}{'actual':<10}")
    for r in before_table:
        print(f"{r['bin']:<14}{r['n']:<7}{r['predicted_mean']:<14.4f}{r['actual_rate']:<10.4f}")
    print()
    print("=== Calibration Table AFTER (test) ===")
    print(f"{'bin':<14}{'n':<7}{'predicted':<14}{'actual':<10}")
    for r in after_table:
        print(f"{r['bin']:<14}{r['n']:<7}{r['predicted_mean']:<14.4f}{r['actual_rate']:<10.4f}")

    # Save iso mapping (X, Y)
    iso_x = list(iso.X_thresholds_)
    iso_y = list(iso.y_thresholds_)
    out = {
        "method": "isotonic",
        "before_brier_test": before_brier_test,
        "after_brier_test":  after_brier_test,
        "before_logloss_test": before_loss_test,
        "after_logloss_test":  after_loss_test,
        "iso_x_thresholds": iso_x,
        "iso_y_thresholds": iso_y,
        "test_samples": len(test_p),
        "train_samples": len(train_p),
        "before_table": before_table,
        "after_table": after_table,
    }
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nSaved: {OUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
