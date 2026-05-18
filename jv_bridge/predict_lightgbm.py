# -*- coding: utf-8 -*-
"""
predict_lightgbm.py — 学習済み LightGBM モデルで当日レースの 1 着確率を出す。

入力:
  data/jv_cache/model_lgbm.txt          # 学習済み LightGBM (text 形式)
  data/jv_cache/model_lgbm.json         # (フォールバック) JSON dump
  data/jv_cache/model_lgbm.pkl          # (フォールバック) sklearn GBDT
  data/jv_cache/races/<race_id>.json    # 当日の出走表
  data/jv_cache/features.json           # 集計済 features (騎手・調教師等)

出力:
  data/jv_cache/predictions/<race_id>.json
    {
      "race_id": "...",
      "model_version": "lgbm_v1",
      "trained_at": "...",
      "horses": [{number, name, raw_win_prob, win_prob, rank, ...}],
      "confidence": 0..1,
    }

使い方:
  py -3 jv_bridge\predict_lightgbm.py --race-id 2026YYYYMMDDJJRRRR00
  py -3 jv_bridge\predict_lightgbm.py --all-today
  py -3 jv_bridge\predict_lightgbm.py --all-races        # races/*.json を全部
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

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
FEATURES_PATH = CACHE / "features.json"
MODEL_TXT = CACHE / "model_lgbm.txt"
MODEL_JSON = CACHE / "model_lgbm.json"
MODEL_PKL = CACHE / "model_lgbm.pkl"
META_PATH = CACHE / "model_lgbm_meta.json"
PREDICTIONS_DIR = CACHE / "predictions"
# Wave18: 人気を見ない second model (実力派の見解を持つ)
MODEL_NOPOP_TXT = CACHE / "model_lgbm_nopop.txt"
MODEL_NOPOP_JSON = CACHE / "model_lgbm_nopop.json"
META_NOPOP_PATH = CACHE / "model_lgbm_nopop_meta.json"

# 同じ特徴量抽出を使う (train_lightgbm から import)
sys.path.insert(0, str(HERE.parent))
from jv_bridge.train_lightgbm import (  # noqa: E402
    FEATURE_NAMES, POPULARITY_FEATURE_NAMES, extract_horse_features, _race_context,
)

# 人気系特徴量の index — nopop 推論時に -1 でマスクするため
_POP_IDX = [i for i, n in enumerate(FEATURE_NAMES) if n in POPULARITY_FEATURE_NAMES]


def _load_model_at(txt_path, json_path):
    """指定パスのモデルをロードして (model, kind) を返す。
    LightGBM Windows ビルドは非 ASCII パス (例: 「競馬」) を扱えない既知の制約があるので、
    一旦 temp に copy して LightGBM Booster に渡す。
    """
    if txt_path.exists():
        try:
            import lightgbm as lgb  # type: ignore
            import tempfile, shutil
            with tempfile.NamedTemporaryFile(mode="wb", suffix=".txt", delete=False) as tf:
                tmp_path = tf.name
            try:
                shutil.copy(str(txt_path), tmp_path)
                booster = lgb.Booster(model_file=tmp_path)
                return booster, "lightgbm"
            finally:
                try: os.unlink(tmp_path)
                except Exception: pass
        except Exception as e:
            print(f"[warn] LightGBM model 読込失敗 {txt_path.name}: {e}", flush=True)
    if json_path.exists():
        try:
            data = json.loads(json_path.read_text(encoding="utf-8"))
            return data, "lightgbm_json"
        except Exception as e:
            print(f"[warn] LightGBM JSON 読込失敗 {json_path.name}: {e}", flush=True)
    return None, None


def _load_model():
    """primary (人気込) を返す。"""
    model, kind = _load_model_at(MODEL_TXT, MODEL_JSON)
    if model is not None:
        return model, kind
    if MODEL_PKL.exists():
        try:
            import pickle
            with open(MODEL_PKL, "rb") as f:
                return pickle.load(f), "sklearn"
        except Exception as e:
            print(f"[warn] sklearn model 読込失敗: {e}", flush=True)
    return None, None


def _load_model_nopop():
    """secondary (人気抜き・実力派) を返す。"""
    return _load_model_at(MODEL_NOPOP_TXT, MODEL_NOPOP_JSON)


def _mask_pop_features(X, np):
    """X (2D array) の人気系 column を -1 で上書きしたコピーを返す。"""
    if np is None or not _POP_IDX:
        return X
    if hasattr(X, "copy"):
        out = X.copy()
    else:
        out = [list(row) for row in X]
        for row in out:
            for i in _POP_IDX:
                if i < len(row):
                    row[i] = -1.0
        return out
    for i in _POP_IDX:
        out[:, i] = -1.0
    return out


def _predict_one(model, kind, X):
    """X (2D array) → 1D win-probability array"""
    if kind == "lightgbm":
        return model.predict(X)
    if kind == "sklearn":
        return model.predict_proba(X)[:, 1]
    if kind == "lightgbm_json":
        # pure-python LightGBM forward (decision trees から手で評価)
        return _predict_from_json(model, X)
    raise RuntimeError(f"unknown model kind: {kind}")


def _predict_from_json(model_json: Dict[str, Any], X) -> List[float]:
    """LightGBM の JSON dump を pure-python で推論する (lightgbm 無しの環境用)"""
    # X: 2D iterable of floats
    rows = X.tolist() if hasattr(X, "tolist") else list(X)
    trees = model_json.get("tree_info") or []
    objective = model_json.get("objective") or "binary"
    feature_names = model_json.get("feature_names") or FEATURE_NAMES

    def _walk(node, row):
        # leaf?
        if "leaf_value" in node:
            return float(node["leaf_value"])
        feat_idx = node.get("split_feature")
        threshold = node.get("threshold")
        decision = node.get("decision_type", "<=")
        default_left = node.get("default_left", True)
        v = row[feat_idx] if feat_idx is not None and feat_idx < len(row) else None
        if v is None or v != v:  # NaN
            go_left = default_left
        elif decision in ("<=", "no_greater"):
            go_left = (v <= threshold)
        else:
            go_left = (v < threshold)
        nxt = node.get("left_child") if go_left else node.get("right_child")
        return _walk(nxt, row)

    out = []
    for row in rows:
        s = 0.0
        for tree in trees:
            s += _walk(tree["tree_structure"], row)
        if "binary" in objective:
            # sigmoid
            try:
                import math
                p = 1.0 / (1.0 + math.exp(-s))
            except OverflowError:
                p = 1.0 if s > 0 else 0.0
            out.append(p)
        else:
            out.append(s)
    return out


def _normalize_softmax(probs: List[float]) -> List[float]:
    """1 着確率の合計を 1.0 に近づける (1 レース内で 1 頭しか勝てないため)"""
    # raw probs は「この馬が勝つ確率」だが、レース全体で合計が 1 を超えがち。
    # softmax で正規化するのではなく、単純比例で和=1 に揃える。
    s = sum(p for p in probs if p > 0)
    if s <= 1e-9:
        return [1.0 / max(1, len(probs)) for _ in probs]
    return [max(0.0, p) / s for p in probs]


def _load_features_index() -> Dict[str, Any]:
    if FEATURES_PATH.exists():
        try:
            return json.loads(FEATURES_PATH.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def _confidence_from_completeness(race: Dict[str, Any], features_index: Dict[str, Any]) -> float:
    """1 レース全体のデータ完備度を 0..1 で。"""
    horses = race.get("horses") or []
    if not horses:
        return 0.0
    rid = race.get("race_id")
    completed_fields = [
        "jockeyWinRate", "trainerWinRate", "courseWinRate", "distanceWinRate",
        "surfaceWinRate", "horseWinRate", "horseStarts", "careerPrizeNorm",
    ]
    score = 0
    total = 0
    for h in horses:
        n = h.get("number")
        feat = (features_index.get(rid, {}) or {}).get(str(n), {}) if rid else {}
        for f in completed_fields:
            total += 1
            if feat.get(f) is not None:
                score += 1
    return (score / total) if total > 0 else 0.0


def predict_race(race: Dict[str, Any],
                 model, kind,
                 features_index: Dict[str, Any],
                 model_nopop=None, kind_nopop=None) -> Dict[str, Any]:
    """primary (人気込) と secondary (人気抜き) の 2 モデルで推論し、
    両者の確率差を value_signal として返す。
    value_signal > 0: 実力派モデルがこの馬を市場より高く評価 (= 市場の見落とし候補)
    """
    horses = race.get("horses") or []
    if not horses:
        return {"ok": False, "reason": "no_horses", "race_id": race.get("race_id")}

    ctx = _race_context(race)
    X = [extract_horse_features(h, race, features_index, ctx) for h in horses]
    try:
        import numpy as np  # type: ignore
        X_arr = np.array(X, dtype="float64")
    except Exception:
        np = None
        X_arr = X  # JSON fallback では plain list でも OK
    try:
        raw = list(_predict_one(model, kind, X_arr))
    except Exception as e:
        return {"ok": False, "reason": "predict_failed", "error": str(e),
                "race_id": race.get("race_id")}
    raw = [float(p) for p in raw]
    normalized = _normalize_softmax(raw)

    # secondary model (人気抜き) の推論
    raw_nopop = None
    nopop_normalized = None
    if model_nopop is not None and np is not None:
        try:
            X_nopop = _mask_pop_features(X_arr, np)
            raw_nopop = [float(p) for p in _predict_one(model_nopop, kind_nopop, X_nopop)]
            nopop_normalized = _normalize_softmax(raw_nopop)
        except Exception as e:
            print(f"[warn] nopop 推論失敗: {e}", flush=True)

    # rank: 確率高い順 (primary)
    indexed = sorted(enumerate(normalized), key=lambda x: -x[1])
    ranks = [0] * len(normalized)
    for rank, (i, _) in enumerate(indexed, 1):
        ranks[i] = rank

    # nopop rank (実力派の本命順)
    ranks_nopop = [0] * len(horses)
    if nopop_normalized is not None:
        idx_nopop = sorted(enumerate(nopop_normalized), key=lambda x: -x[1])
        for rank, (i, _) in enumerate(idx_nopop, 1):
            ranks_nopop[i] = rank

    # Wave19.6: race の meta を各 horse に注入 (季節・コース・場別戦略で使う)
    rmcourse = race.get("course") or ""
    rmsurface = race.get("surface") or ""
    rmrid = race.get("race_id") or ""
    rmmonth = None
    if rmrid and len(rmrid) >= 6 and rmrid[4:6].isdigit():
        m = int(rmrid[4:6])
        if 1 <= m <= 12: rmmonth = m
    _VENUE_NAMES = {
        "01": "札幌", "02": "函館", "03": "福島", "04": "新潟", "05": "東京",
        "06": "中山", "07": "中京", "08": "京都", "09": "阪神", "10": "小倉",
    }
    rmvenue = _VENUE_NAMES.get(rmrid[8:10] if len(rmrid) >= 10 else "", "")

    pred_horses = []
    for i, h in enumerate(horses):
        odds = h.get("win_odds")
        win_prob = normalized[i]
        ev = (win_prob * float(odds)) if (odds and float(odds) > 0) else None
        value_signal = None
        nopop_prob = None
        ev_nopop = None
        if nopop_normalized is not None:
            nopop_prob = nopop_normalized[i]
            value_signal = nopop_prob - win_prob
            if odds and float(odds) > 0:
                ev_nopop = nopop_prob * float(odds)
        pred_horses.append({
            "number": h.get("number"),
            "name": h.get("name"),
            "raw_win_prob": round(raw[i], 6),
            "win_prob": round(win_prob, 6),
            "nopop_prob": round(nopop_prob, 6) if nopop_prob is not None else None,
            "value_signal": round(value_signal, 6) if value_signal is not None else None,
            "rank": ranks[i],
            "rank_nopop": ranks_nopop[i] if nopop_normalized is not None else None,
            "odds": odds,
            "ev": round(ev, 4) if ev is not None else None,
            "ev_nopop": round(ev_nopop, 4) if ev_nopop is not None else None,
            "popularity": h.get("popularity"),
            # Wave19.6: race meta
            "race_course": rmcourse,
            "race_surface": rmsurface,
            "race_month": rmmonth,
            "race_venue": rmvenue,
        })
    pred_horses.sort(key=lambda x: x["rank"])

    confidence = _confidence_from_completeness(race, features_index)
    meta = {}
    if META_PATH.exists():
        try:
            meta = json.loads(META_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    meta_nopop = {}
    if META_NOPOP_PATH.exists():
        try:
            meta_nopop = json.loads(META_NOPOP_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {
        "ok": True,
        "race_id": race.get("race_id"),
        "predicted_at": datetime.now(timezone.utc).isoformat(),
        "model_version": "lgbm_v2_ensemble" if nopop_normalized is not None else "lgbm_v1",
        "model_trained_at": meta.get("trained_at"),
        "model_auc": (meta.get("metrics") or {}).get("auc"),
        "model_nopop_auc": (meta_nopop.get("metrics") or {}).get("auc"),
        "horses": pred_horses,
        "confidence": round(confidence, 3),
    }


def main():
    ap = argparse.ArgumentParser(description="LightGBM 推論")
    ap.add_argument("--race-id", help="特定レースのみ推論")
    ap.add_argument("--all-today", action="store_true", help="data/jv_cache/races/*.json で今日の日付 (YYYYMMDD) のレース全部")
    ap.add_argument("--all-races", action="store_true", help="races/*.json の全レース")
    args = ap.parse_args()

    model, kind = _load_model()
    if model is None:
        print("[NG] モデルが見つかりません。train_lightgbm.py を実行してください。", flush=True)
        return 2
    print(f"[info] primary model kind: {kind}", flush=True)
    # secondary: 人気を見ない実力派モデル (任意)
    model_nopop, kind_nopop = _load_model_nopop()
    if model_nopop is not None:
        print(f"[info] secondary (nopop) model: {kind_nopop} — value_signal 計算有効", flush=True)
    else:
        print(f"[info] secondary (nopop) model なし — train_lightgbm.py --no-pop で生成可", flush=True)

    features_index = _load_features_index()
    PREDICTIONS_DIR.mkdir(parents=True, exist_ok=True)

    if args.race_id:
        path = RACES_DIR / f"{args.race_id}.json"
        if not path.exists():
            print(f"[NG] race file not found: {path}", flush=True)
            return 3
        race = json.loads(path.read_text(encoding="utf-8"))
        out = predict_race(race, model, kind, features_index, model_nopop, kind_nopop)
        out_path = PREDICTIONS_DIR / f"{args.race_id}.json"
        out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[OK] {args.race_id} → {out_path.name}", flush=True)
        # 簡易サマリ
        for h in (out.get("horses") or [])[:5]:
            print(f"  {h['rank']}. #{h['number']} {h.get('name','')} prob={h['win_prob']:.3f} "
                  f"ev={h.get('ev')} value={h.get('value_signal')}", flush=True)
        return 0

    if args.all_today:
        today = datetime.now().strftime("%Y%m%d")
        targets = [p for p in RACES_DIR.glob(f"{today}*.json")]
    elif args.all_races:
        targets = list(RACES_DIR.glob("*.json"))
    else:
        # default: today
        today = datetime.now().strftime("%Y%m%d")
        targets = [p for p in RACES_DIR.glob(f"{today}*.json")]

    if not targets:
        print("[info] 対象レースが見つかりません (races/*.json 空)", flush=True)
        return 0

    ok_n = 0
    for race_path in sorted(targets):
        try:
            race = json.loads(race_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        rid = race.get("race_id") or race_path.stem
        out = predict_race(race, model, kind, features_index, model_nopop, kind_nopop)
        if not out.get("ok"):
            print(f"[skip] {rid} reason={out.get('reason')}", flush=True)
            continue
        (PREDICTIONS_DIR / f"{rid}.json").write_text(
            json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        ok_n += 1
    print(f"[OK] 推論完了 {ok_n} レース → {PREDICTIONS_DIR.relative_to(ROOT)}/", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
