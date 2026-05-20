# -*- coding: utf-8 -*-
"""
walk_forward_v2.py — 真の Walk-forward (期間別再学習) で look-ahead leakage を構造的に排除 (Wave30)

旧 walk_forward_validate.py の致命的問題:
  全データの前 80% で学習した 1 つのモデルを全期間 1〜N-1 に適用していた。
  → period 1〜N-2 は train データに含まれる = 未来結果を見ながら予想する偽の高 ROI。

このスクリプト:
  各期間 i (i=1..N-1) について:
    1. pairs[0:start_i] のみで nopop モデルを学習
    2. period i のレースを予測 → 戦略を発火 → ROI を計測
  これで全 N-1 期間が「真の未来予測」になる。

注意:
  - LightGBM の num_boost を 300 に軽量化 (1 期間 ~20 秒・7 期間で ~2.5 分)
  - 主モデル (人気込) は不要・nopop のみ学習 (V 系戦略の評価用)
  - 出力: data/jv_cache/walk_forward_v2_result.json
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
import tempfile
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Callable

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
FEATURES_PATH = CACHE / "features.json"
OUT_PATH = CACHE / "walk_forward_v2_result.json"

sys.path.insert(0, str(HERE.parent))
from jv_bridge.train_lightgbm import (  # noqa: E402
    FEATURE_NAMES, extract_horse_features, _race_context, _mask_pop_columns,
)
from jv_bridge.predict_lightgbm import (  # noqa: E402
    _predict_one, _mask_pop_features,
)
from jv_bridge.validate_lightgbm import (  # noqa: E402
    _payout_fuku, _payout_uren, _payout_tan3, _load_features_index,
)


def _load_pairs():
    """時系列順に (rid, race, result) のペアを返す。"""
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


def _build_xy_from_pairs(pairs, features_index):
    """pairs から train 用の (X, y, race_ids) を作る。"""
    X: List[List[float]] = []
    y: List[int] = []
    race_ids: List[str] = []
    for rid, race, result in pairs:
        horses = race.get("horses") or []
        if not horses:
            continue
        # 1 着の馬番を抽出
        winners = set()
        for r in (result.get("results") or []):
            if r.get("rank") == 1 and r.get("number") is not None:
                try:
                    winners.add(int(r["number"]))
                except (TypeError, ValueError):
                    pass
        if not winners:
            continue
        ctx = _race_context(race)
        for h in horses:
            n = h.get("number")
            if not isinstance(n, int):
                continue
            X.append(extract_horse_features(h, race, features_index, ctx))
            y.append(1 if n in winners else 0)
            race_ids.append(rid)
    return X, y, race_ids


def _train_nopop_lightgbm(X, y, np, lgb, num_boost=300):
    """nopop モードで LightGBM を 1 つ学習。早めに収束させて軽量化。"""
    X_arr = np.array(X, dtype="float64")
    y_arr = np.array(y, dtype="int32")
    X_arr, _ = _mask_pop_columns(X_arr, np)

    # 7:3 で valid を切る (時系列順保証されているので race_ids 不要)
    n = len(X_arr)
    cut = max(1, int(n * 0.85))
    Xtr, ytr = X_arr[:cut], y_arr[:cut]
    Xte, yte = X_arr[cut:], y_arr[cut:]

    train_data = lgb.Dataset(Xtr, label=ytr, feature_name=FEATURE_NAMES)
    valid_data = lgb.Dataset(Xte, label=yte, reference=train_data, feature_name=FEATURE_NAMES)
    params = {
        "objective": "binary",
        "metric": ["binary_logloss"],
        "num_leaves": 31,
        "learning_rate": 0.05,
        "min_data_in_leaf": 25,
        "lambda_l1": 0.15,
        "lambda_l2": 0.15,
        "feature_fraction": 0.8,
        "bagging_fraction": 0.8,
        "bagging_freq": 5,
        "verbosity": -1,
    }
    booster = lgb.train(
        params, train_data,
        num_boost_round=num_boost,
        valid_sets=[valid_data],
        valid_names=["valid"],
        callbacks=[
            lgb.early_stopping(stopping_rounds=20, verbose=False),
            lgb.log_evaluation(period=0),
        ],
    )
    return booster


def _predict_with_booster(booster, X_arr, np):
    """booster で予測 (nopop マスク適用済を期待)"""
    return booster.predict(X_arr, num_iteration=booster.best_iteration or booster.current_iteration())


def _softmax(probs):
    s = sum(p for p in probs if p > 0)
    if s <= 0:
        return [1.0 / max(1, len(probs)) for _ in probs]
    return [max(0.0, p) / s for p in probs]


def _race_filter_turf(race):
    s = (race.get("course") or "") + " " + (race.get("surface") or "")
    return "芝" in s


def _race_filter_dirt(race):
    s = (race.get("course") or "") + " " + (race.get("surface") or "")
    return "ダ" in s


def _race_filter_short(race):
    try:
        return 1000 <= int(race.get("distance") or 0) <= 1400
    except (TypeError, ValueError):
        return False


def _race_filter_g1(race):
    return bool(race.get("is_g1"))


def _strategies_for_evaluation():
    """評価する戦略一覧 (key, filter_func, threshold, bet_type)。
    bet_type ∈ {"fuku", "uren", "double", "tan3"} で _payout_* を切替。
    - "double": 複勝 100 + 馬連 100 を併買 (¥200/R)
    - "tan3": 3連単 nopop top1->top2->top3 (¥100/R)
    """
    return [
        # V 系 (nopop モデル評価)
        ("value_invest_nopop_016", lambda r: True, 0.16, "fuku"),
        ("value_uren_nopop_030",   lambda r: True, 0.30, "uren"),
        ("value_uren_nopop_016",   lambda r: True, 0.16, "uren"),
        ("value_uren_turf_030",    _race_filter_turf, 0.30, "uren"),
        ("value_uren_short_030",   _race_filter_short, 0.30, "uren"),
        ("value_uren_short_ultra_035", _race_filter_short, 0.35, "uren"),
        ("value_uren_turf_025",    _race_filter_turf, 0.25, "uren"),
        ("value_uren_g1_020",      _race_filter_g1, 0.20, "uren"),
        ("value_uren_g1_030",      _race_filter_g1, 0.30, "uren"),
        # Wave30-X 拡張: 併買・3連単
        ("value_double_nopop_016", lambda r: True, 0.16, "double"),
        ("value_double_nopop_030", lambda r: True, 0.30, "double"),
        ("value_tan3_nopop_020",   lambda r: True, 0.20, "tan3"),
        ("value_tan3_nopop_030",   lambda r: True, 0.30, "tan3"),
        ("value_double_turf_030",  _race_filter_turf, 0.30, "double"),
        ("value_double_short_030", _race_filter_short, 0.30, "double"),
    ]


def _evaluate_period(cache_slice, strategies, np):
    """1 期間ぶんの cache_slice で全戦略を評価し、{name: {bets, invested, returned, hits, roi_pct}} を返す。"""
    out: Dict[str, Dict[str, Any]] = {s[0]: {"bets": 0, "invested": 0, "returned": 0, "hits": 0} for s in strategies}
    for c in cache_slice:
        race = c["race"]
        horses = c["horses"]
        payouts = c["payouts"]
        probs = c["probs"]
        if len(probs) < 2:
            continue
        sorted_idx = sorted(range(len(probs)), key=lambda i: -probs[i])
        top1_i, top2_i = sorted_idx[0], sorted_idx[1]
        # top3 も用意 (3連単・併買用)
        top3_i = sorted_idx[2] if len(sorted_idx) >= 3 else None
        for name, filter_fn, th, bet_type in strategies:
            if probs[top1_i] < th:
                continue
            if not filter_fn(race):
                continue
            try:
                a = int(horses[top1_i].get("number"))
            except (TypeError, ValueError):
                continue
            if bet_type == "fuku":
                out[name]["invested"] += 100
                pay = _payout_fuku(payouts, a)
            elif bet_type == "uren":
                try:
                    b = int(horses[top2_i].get("number"))
                except (TypeError, ValueError):
                    continue
                out[name]["invested"] += 100
                pay = _payout_uren(payouts, a, b)
            elif bet_type == "double":
                # 複勝 100 + 馬連 100 を併買 (¥200/R)
                try:
                    b = int(horses[top2_i].get("number"))
                except (TypeError, ValueError):
                    continue
                out[name]["invested"] += 200
                pay = _payout_fuku(payouts, a) + _payout_uren(payouts, a, b)
            elif bet_type == "tan3":
                # 3 連単 top1 -> top2 -> top3 (¥100/R)
                if top3_i is None:
                    continue
                try:
                    b = int(horses[top2_i].get("number"))
                    c = int(horses[top3_i].get("number"))
                except (TypeError, ValueError):
                    continue
                out[name]["invested"] += 100
                pay = _payout_tan3(payouts, a, b, c)
            else:
                continue
            out[name]["returned"] += pay
            out[name]["bets"] += 1
            if pay > 0:
                out[name]["hits"] += 1
    for name in out:
        inv = out[name]["invested"]
        out[name]["roi_pct"] = round(out[name]["returned"] / inv * 100, 2) if inv > 0 else None
        out[name]["hit_rate"] = round(out[name]["hits"] / out[name]["bets"], 3) if out[name]["bets"] > 0 else None
    return out


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--periods", type=int, default=7)
    parser.add_argument("--num-boost", type=int, default=300)
    args = parser.parse_args(argv)

    try:
        import numpy as np  # type: ignore
        import lightgbm as lgb  # type: ignore
    except ImportError as e:
        print(f"[NG] {e}", flush=True)
        return 1

    pairs = _load_pairs()
    pairs.sort(key=lambda p: p[0])
    if len(pairs) < args.periods * 100:
        print(f"[NG] pairs 数 {len(pairs)} が分割 {args.periods} に対して少ない", flush=True)
        return 1

    features_index = _load_features_index()
    strategies = _strategies_for_evaluation()

    n = len(pairs)
    period_size = max(1, n // args.periods)
    print(f"[info] pairs={n} / 期間数={args.periods} / 1 期間={period_size}", flush=True)

    # 各期間 i (i=1..N-1) について、pairs[0:i*period_size] で学習 → period i 評価
    period_results: List[Dict[str, Any]] = []
    for p in range(1, args.periods):
        lo = p * period_size
        hi = (p + 1) * period_size if p < args.periods - 1 else n
        train_pairs = pairs[:lo]
        test_pairs = pairs[lo:hi]
        print(f"\n[period {p}/{args.periods-1}] train={len(train_pairs)} pairs / test={len(test_pairs)} R", flush=True)

        # 1. train (nopop モデル)
        X, y, _ = _build_xy_from_pairs(train_pairs, features_index)
        if not X:
            print(f"  [skip] features 0 件", flush=True)
            continue
        print(f"  [train] X={len(X)} 行, num_boost={args.num_boost}…", flush=True)

        # LightGBM が 非 ASCII path を扱えない問題 (Wave17 の workaround) — tempfile copy 経由
        booster = _train_nopop_lightgbm(X, y, np, lgb, num_boost=args.num_boost)

        # 2. test pairs を予測
        print(f"  [predict] {len(test_pairs)} レース…", flush=True)
        cache_slice = []
        for rid, race, result in test_pairs:
            horses = race.get("horses") or []
            if not horses:
                continue
            ctx = _race_context(race)
            X_t = [extract_horse_features(h, race, features_index, ctx) for h in horses]
            X_arr = np.array(X_t, dtype="float64")
            X_nopop = _mask_pop_features(X_arr, np)
            raw = list(_predict_with_booster(booster, X_nopop, np))
            probs = _softmax([float(x) for x in raw])
            cache_slice.append({
                "rid": rid, "race": race, "horses": horses,
                "payouts": result.get("payouts") or {},
                "probs": probs,
            })

        # 3. 戦略評価
        period_eval = _evaluate_period(cache_slice, strategies, np)
        period_results.append({"period": p, "test_races": len(test_pairs), "strategies": period_eval})
        # 簡易表示
        print(f"  [period {p}] 結果:", flush=True)
        for name, st in period_eval.items():
            if st.get("bets", 0) > 0:
                print(f"    {name:<35} bets={st['bets']:>4} ROI={st['roi_pct']:>7.2f}% hit_rate={st['hit_rate']}", flush=True)

    # 戦略ごとに集計
    print("\n[集約] 各戦略の真の Walk-forward 結果 (look-ahead 完全排除):", flush=True)
    summary = []
    for name, _, _, _ in strategies:
        period_rois = []
        period_bets = []
        total_inv = 0
        total_ret = 0
        total_bets = 0
        total_hits = 0
        for pr in period_results:
            st = pr["strategies"].get(name)
            if st and st.get("bets", 0) > 0:
                period_rois.append(st["roi_pct"])
                period_bets.append(st["bets"])
                total_inv += st["invested"]
                total_ret += st["returned"]
                total_bets += st["bets"]
                total_hits += st["hits"]
            else:
                period_rois.append(None)
                period_bets.append(0)
        valid = [r for r in period_rois if r is not None]
        if not valid:
            continue
        mean = sum(valid) / len(valid)
        sigma = (sum((r - mean) ** 2 for r in valid) / len(valid)) ** 0.5
        # ⭐ どの period も「真の未来予測」なので、final だけでなく全期間が pure test
        # ただし「最終期間」は最も新しいデータに対する評価なので、UI 互換のため別途記録
        final_roi = period_rois[-1] if period_rois else None
        summary.append({
            "name": name,
            "mean_roi_pct": round(mean, 2),
            "worst_roi_pct": round(min(valid), 2),
            "best_roi_pct": round(max(valid), 2),
            "final_period_roi": round(final_roi, 2) if final_roi is not None else None,
            "roi_std": round(sigma, 2),
            "win_periods": sum(1 for r in valid if r >= 100),
            "active_periods": len(valid),
            "total_bets": total_bets,
            "total_hits": total_hits,
            "hit_rate": round(total_hits / total_bets, 3) if total_bets else None,
            "total_invested": total_inv,
            "total_returned": total_ret,
            "overall_roi_pct": round(total_ret / total_inv * 100, 2) if total_inv else None,
            "period_rois": period_rois,
            "period_bets": period_bets,
            "leakage_free": True,  # 真の Walk-forward である証
        })
    summary.sort(key=lambda x: -(x["overall_roi_pct"] or 0))
    print(f"\n{'戦略':<35}{'overall':<10}{'mean':<10}{'worst':<10}{'勝期間':<10}{'件数':<8}", flush=True)
    print("=" * 85, flush=True)
    for s in summary:
        wp = f"{s['win_periods']}/{s['active_periods']}"
        print(f"{s['name']:<35}{s['overall_roi_pct']:<10.1f}{s['mean_roi_pct']:<10.1f}{s['worst_roi_pct']:<10.1f}{wp:<10}{s['total_bets']:<8}", flush=True)

    out = {
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
        "periods": args.periods,
        "num_boost": args.num_boost,
        "total_pairs": n,
        "period_size": period_size,
        "leakage_free": True,
        "method": "期間別再学習 (各 period i で pairs[0:start_i] のみで nopop モデルを学習)",
        "strategies": summary,
        "period_details": period_results,
    }
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n[OK] {OUT_PATH.relative_to(ROOT)} 保存", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
