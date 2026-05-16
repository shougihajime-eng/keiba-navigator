# -*- coding: utf-8 -*-
"""
train_lightgbm.py — LightGBM で「1着馬を予想する」モデルを訓練する。

入力:
  data/jv_cache/races/<race_id>.json     # 出走表 + オッズ
  data/jv_cache/results/<race_id>.json   # 着順 + 払戻
  data/jv_cache/features.json            # 集計済み騎手・調教師等の特徴量

出力:
  data/jv_cache/model_lgbm.txt           # LightGBM のテキスト形式モデル
  data/jv_cache/model_lgbm_meta.json     # 訓練メトリクス + 特徴量重要度 + 学習サンプル数

使い方:
  py -3.12-32 jv_bridge\\train_lightgbm.py
  py -3.12-32 jv_bridge\\train_lightgbm.py --min-races 20 --test-ratio 0.2

データが薄い時 (races < min-races) はモデルを作らず、状態を meta に書き出すだけ。
データが増えたら何度でも再実行可能 (idempotent)。

依存:
  pip install lightgbm scikit-learn numpy
  (32bit Python でも lightgbm のホイールあり: pip install lightgbm)
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Windows + pipe では sys.stdout.reconfigure() が silent fail することがあるため、
# TextIOWrapper を二段構えで張り直して "—" "・" U+FFFD 等を確実に通す。
# (これがないと em-dash が cp932 で落ちて訓練成功でも失敗判定される既知バグが出る)
os.environ["PYTHONIOENCODING"] = "utf-8"
for _attr in ("stdout", "stderr"):
    _s = getattr(sys, _attr, None)
    if _s is None:
        continue
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    # reconfigure が無効だった場合のフォールバック: buffer から再ラップ
    try:
        buf = getattr(_s, "buffer", None)
        if buf is not None and getattr(_s, "encoding", "").lower() not in ("utf-8", "utf8"):
            setattr(sys, _attr, io.TextIOWrapper(
                buf, encoding="utf-8", errors="replace", line_buffering=True
            ))
    except Exception:
        pass

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
CACHE = ROOT / "data" / "jv_cache"
RACES_DIR = CACHE / "races"
RESULTS_DIR = CACHE / "results"
FEATURES_PATH = CACHE / "features.json"
MODEL_PATH = CACHE / "model_lgbm.txt"
META_PATH = CACHE / "model_lgbm_meta.json"


def _try_import_lightgbm():
    try:
        import lightgbm as lgb  # type: ignore
        return lgb
    except ImportError:
        return None


def _try_import_sklearn():
    try:
        from sklearn import ensemble  # type: ignore
        return ensemble
    except ImportError:
        return None


def _try_import_numpy():
    try:
        import numpy as np  # type: ignore
        return np
    except ImportError:
        return None


# ─── 特徴量抽出 ───────────────────────────────────────────
FEATURE_NAMES = [
    "win_odds",
    "popularity",
    "weight",
    "body_weight",
    "weight_diff",
    "age",
    "prev_finish",
    "days_from_last_race",
    "jockey_win_rate",
    "trainer_win_rate",
    "course_win_rate",
    "distance",
    "is_g1",
]


def _safe_num(x, default=None):
    try:
        v = float(x)
        if v != v:  # NaN
            return default
        return v
    except (TypeError, ValueError):
        return default


def _parse_age(sex_age: Optional[str]) -> Optional[float]:
    """'牡4' → 4 のように年齢を抜く"""
    if not sex_age:
        return None
    digits = "".join(c for c in str(sex_age) if c.isdigit())
    return float(digits) if digits else None


def extract_horse_features(horse: Dict[str, Any],
                           race: Dict[str, Any],
                           features_index: Dict[str, Any]) -> List[float]:
    """1 頭分の特徴ベクトル (FEATURE_NAMES と同じ順序) を返す。
    欠損は -1 で埋める (LightGBM は NaN 扱いも可能だが互換性のため)。
    """
    race_id = race.get("race_id")
    horse_num = str(horse.get("number") or "")
    feat = (features_index or {}).get(race_id, {}).get(horse_num, {}) if features_index else {}

    vec = [
        _safe_num(horse.get("win_odds"), -1),
        _safe_num(horse.get("popularity"), -1),
        _safe_num(horse.get("weight"), -1),                # 斤量
        _safe_num(horse.get("body_weight"), -1),
        _safe_num(horse.get("weight_diff"), 0),
        _parse_age(horse.get("sex_age")) or -1,
        _safe_num(horse.get("prev_finish"), -1),
        _safe_num(feat.get("daysFromLastRace"), -1),
        _safe_num(feat.get("jockeyWinRate"), 0.075),       # JRA 平均勝率を prior に
        _safe_num(feat.get("trainerWinRate"), 0.075),
        _safe_num(feat.get("courseWinRate"), 0.075),
        _safe_num(race.get("distance"), -1),
        1.0 if race.get("is_g1") else 0.0,
    ]
    return vec


def load_races_and_labels() -> Tuple[List[List[float]], List[int], List[str]]:
    """races/<id>.json + results/<id>.json を全部読んで (X, y, race_ids) を返す。
    y[i] = 1 if 当該馬が 1 着, else 0
    """
    if not RACES_DIR.exists() or not RESULTS_DIR.exists():
        return [], [], []

    features_index = {}
    if FEATURES_PATH.exists():
        try:
            features_index = json.loads(FEATURES_PATH.read_text(encoding="utf-8"))
        except Exception:
            features_index = {}

    X: List[List[float]] = []
    y: List[int] = []
    race_ids: List[str] = []
    skipped_no_result = 0
    skipped_no_horses = 0

    for race_path in sorted(RACES_DIR.glob("*.json")):
        try:
            race = json.loads(race_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        race_id = race.get("race_id") or race_path.stem
        result_path = RESULTS_DIR / f"{race_id}.json"
        if not result_path.exists():
            skipped_no_result += 1
            continue
        try:
            result = json.loads(result_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        horses = race.get("horses") or []
        if not horses:
            skipped_no_horses += 1
            continue
        winners = set()
        for r in (result.get("results") or []):
            if r.get("rank") == 1 and r.get("number") is not None:
                winners.add(int(r["number"]))
        if not winners:
            continue
        for h in horses:
            n = h.get("number")
            if not isinstance(n, int):
                continue
            X.append(extract_horse_features(h, race, features_index))
            y.append(1 if n in winners else 0)
            race_ids.append(race_id)

    print(f"[info] races/ 走査: {len(list(RACES_DIR.glob('*.json')))} / "
          f"results 紐付け済: {len(set(race_ids))} / 学習行: {len(X)} "
          f"(skip-no-result={skipped_no_result} skip-no-horses={skipped_no_horses})", flush=True)
    return X, y, race_ids


def train(min_races: int, test_ratio: float) -> int:
    np = _try_import_numpy()
    lgb = _try_import_lightgbm()
    sk_ens = _try_import_sklearn()

    if np is None:
        _write_meta_only(state="missing_numpy",
                         hint="pip install numpy")
        print("[NG] numpy が必要です: pip install numpy", flush=True)
        return 2

    X, y, race_ids = load_races_and_labels()
    n_races = len(set(race_ids))
    n_rows = len(X)

    if n_races < min_races:
        _write_meta_only(state="not_enough_data",
                         races=n_races, rows=n_rows, min_races=min_races,
                         hint=f"あと {min_races - n_races} レースぶんの確定結果が必要")
        print(f"[skip] 学習サンプル不足 (races={n_races} < {min_races})", flush=True)
        return 0

    X_arr = np.array(X, dtype="float64")
    y_arr = np.array(y, dtype="int32")

    # シャッフル + train/test split (race 単位で分けて look-ahead を防ぐ)
    unique_races = sorted(set(race_ids))
    rng = np.random.default_rng(42)
    rng.shuffle(unique_races)
    cut = max(1, int(len(unique_races) * (1.0 - test_ratio)))
    train_races = set(unique_races[:cut])
    train_mask = np.array([rid in train_races for rid in race_ids])
    test_mask = ~train_mask

    Xtr, ytr = X_arr[train_mask], y_arr[train_mask]
    Xte, yte = X_arr[test_mask],  y_arr[test_mask]

    meta = {
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "feature_names": FEATURE_NAMES,
        "samples_total": n_rows,
        "races_total": n_races,
        "samples_train": int(train_mask.sum()),
        "samples_test":  int(test_mask.sum()),
    }

    # LightGBM があれば優先
    if lgb is not None:
        try:
            train_data = lgb.Dataset(Xtr, label=ytr, feature_name=FEATURE_NAMES)
            params = {
                "objective": "binary",
                "metric": ["binary_logloss", "auc"],
                "num_leaves": 31,
                "learning_rate": 0.05,
                "feature_fraction": 0.9,
                "bagging_fraction": 0.8,
                "bagging_freq": 5,
                "verbosity": -1,
            }
            booster = lgb.train(params, train_data, num_boost_round=100)
            # LightGBM Windows binary は非 ASCII path (例: 競馬) を扱えない (既知の制約)
            # 一時パス (Temp) で save → shutil.copy で最終パスに移動する
            import tempfile, shutil
            with tempfile.NamedTemporaryFile(mode="wb", suffix=".txt", delete=False) as tf:
                tmp_path = tf.name
            try:
                booster.save_model(tmp_path)
                shutil.copy(tmp_path, str(MODEL_PATH))
            finally:
                try: os.unlink(tmp_path)
                except Exception: pass
            # Node 側で評価できるよう JSON ダンプも保存
            try:
                model_json = booster.dump_model()
                json_path = MODEL_PATH.with_suffix(".json")
                json_path.write_text(
                    json.dumps(model_json, ensure_ascii=False),
                    encoding="utf-8"
                )
                print(f"[info] JSON ダンプも保存: {json_path.name}", flush=True)
            except Exception as e:
                print(f"[warn] JSON ダンプ失敗: {e}", flush=True)

            preds = booster.predict(Xte)
            auc = _auc(yte, preds, np)
            logloss = _logloss(yte, preds, np)
            importance = dict(zip(FEATURE_NAMES, [int(v) for v in booster.feature_importance(importance_type="gain")]))
            meta.update({
                "model": "lightgbm",
                "params": params,
                "metrics": {"auc": auc, "logloss": logloss},
                "feature_importance": importance,
                "model_path": str(MODEL_PATH.relative_to(ROOT)),
            })
            META_PATH.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"[OK] LightGBM 訓練完了 — AUC={auc:.3f} logloss={logloss:.4f}", flush=True)
            print(f"     model: {MODEL_PATH.name}", flush=True)
            print(f"     重要度 top-5:", flush=True)
            for k, v in sorted(importance.items(), key=lambda x: -x[1])[:5]:
                print(f"       {k}: {v}", flush=True)
            return 0
        except Exception as e:
            print(f"[warn] LightGBM 訓練失敗 ({e})・sklearn にフォールバック", flush=True)

    # フォールバック: sklearn GradientBoosting
    if sk_ens is not None:
        try:
            clf = sk_ens.GradientBoostingClassifier(n_estimators=100, learning_rate=0.05,
                                                    max_depth=4, random_state=42)
            clf.fit(Xtr, ytr)
            preds = clf.predict_proba(Xte)[:, 1]
            auc = _auc(yte, preds, np)
            logloss = _logloss(yte, preds, np)
            # モデル保存 (pickle)
            import pickle
            with open(MODEL_PATH.with_suffix(".pkl"), "wb") as f:
                pickle.dump(clf, f)
            importance = dict(zip(FEATURE_NAMES, [float(v) for v in clf.feature_importances_]))
            meta.update({
                "model": "sklearn_gbdt",
                "metrics": {"auc": auc, "logloss": logloss},
                "feature_importance": importance,
                "model_path": str(MODEL_PATH.with_suffix(".pkl").relative_to(ROOT)),
            })
            META_PATH.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"[OK] sklearn GBDT 訓練完了 — AUC={auc:.3f} logloss={logloss:.4f}", flush=True)
            return 0
        except Exception as e:
            print(f"[NG] sklearn 訓練失敗: {e}", flush=True)

    _write_meta_only(state="no_ml_library",
                     hint="pip install lightgbm scikit-learn のいずれかが必要")
    print("[NG] 機械学習ライブラリ未インストール: pip install lightgbm  または pip install scikit-learn", flush=True)
    return 3


def _write_meta_only(**kwargs):
    meta = {
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "state": kwargs.pop("state", "unknown"),
        **kwargs,
    }
    META_PATH.parent.mkdir(parents=True, exist_ok=True)
    META_PATH.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")


def _auc(y_true, y_score, np):
    """シンプルな AUC 計算 (sklearn 不要)。"""
    y_true = np.asarray(y_true)
    y_score = np.asarray(y_score)
    pos = y_score[y_true == 1]
    neg = y_score[y_true == 0]
    if len(pos) == 0 or len(neg) == 0:
        return 0.5
    # rank-sum (Mann–Whitney U) 法
    all_scores = np.concatenate([pos, neg])
    ranks = all_scores.argsort().argsort() + 1.0
    rank_pos = ranks[: len(pos)].sum()
    auc = (rank_pos - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg))
    return float(auc)


def _logloss(y_true, y_score, np, eps=1e-15):
    y_true = np.asarray(y_true)
    y_score = np.clip(np.asarray(y_score), eps, 1.0 - eps)
    return float(-np.mean(y_true * np.log(y_score) + (1 - y_true) * np.log(1 - y_score)))


def main():
    ap = argparse.ArgumentParser(description="LightGBM 1着馬予想モデルを訓練")
    ap.add_argument("--min-races", type=int, default=20,
                    help="最低必要なレース数 (デフォルト 20)")
    ap.add_argument("--test-ratio", type=float, default=0.2,
                    help="テスト分割比率 (デフォルト 0.2 = 20%)")
    args = ap.parse_args()
    return train(args.min_races, args.test_ratio)


if __name__ == "__main__":
    sys.exit(main())
