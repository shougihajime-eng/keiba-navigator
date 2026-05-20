# -*- coding: utf-8 -*-
"""
walk_forward_win5_v1.py — WIN5 戦略の真の look-ahead 排除版 評価 (Wave31)

設計:
  1. 過去 WIN5 開催日を時系列ソート
  2. 各 period i について:
     a. その日付より前のレースで nopop モデルを再学習
     b. period i 内の WIN5 開催日について:
        - 対象 5 レースを取得
        - nopop モデルで各レースの top1 (本命) / top1+top2 (中波) / top1+top2+top3 (万舟) を予測
        - WF レコードの的中組番と照合 → 払戻金計算
  3. 3 戦略 (safe / mid / wide) の真の overall ROI を出力

戦略仕様:
  - safe: 各 R top1 のみ (1 点 ¥200)
  - mid:  各 R top1-2 (2^5 = 32 点 ¥6,400)
  - wide: 各 R top1-3 (3^5 = 243 点 ¥48,600)

注意:
  - nopop モデル学習: LightGBM 64bit Python 必須
  - WIN5 開催日 50 件しかないので periods=3 デフォルト

出力: data/jv_cache/walk_forward_win5_v1_result.json
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
from datetime import datetime, timezone, date as date_cls
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

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
WIN5_DIR = CACHE / "win5"
OUT_PATH = CACHE / "walk_forward_win5_v1_result.json"

sys.path.insert(0, str(HERE.parent))
from jv_bridge.train_lightgbm import (  # noqa: E402
    FEATURE_NAMES, extract_horse_features, _race_context, _mask_pop_columns,
)
from jv_bridge.predict_lightgbm import (  # noqa: E402
    _mask_pop_features,
)
from jv_bridge.validate_lightgbm import (  # noqa: E402
    _load_features_index,
)


POINT_PRICE = 200  # WIN5 1 点 200 円


def _load_win5_days() -> List[Dict[str, Any]]:
    """win5/*.json を読み込み・有効な払戻データのある日を時系列順に返す。"""
    days = []
    if not WIN5_DIR.exists(): return days
    for p in sorted(WIN5_DIR.glob("*.json")):
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        if d.get("husei_flag") == "1" or d.get("tekityu_nashi_flag") == "1":
            continue  # 不成立・的中無は除外
        if not d.get("payouts"):
            continue
        days.append(d)
    return days


def _load_all_pairs():
    """races + results が揃ったペアを時系列順に返す。"""
    pairs = []
    for race_file in sorted(RACES_DIR.glob("*.json")):
        rid = race_file.stem
        result_file = RESULTS_DIR / f"{rid}.json"
        if not result_file.exists(): continue
        try:
            race = json.loads(race_file.read_text(encoding="utf-8"))
            result = json.loads(result_file.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not race.get("horses"): continue
        pairs.append((rid, race, result))
    return pairs


def _build_xy_from_pairs(pairs, features_index):
    X, y, race_ids = [], [], []
    for rid, race, result in pairs:
        horses = race.get("horses") or []
        if not horses: continue
        winners = set()
        for r in (result.get("results") or []):
            if r.get("rank") == 1 and r.get("number") is not None:
                try: winners.add(int(r["number"]))
                except (TypeError, ValueError): pass
        if not winners: continue
        ctx = _race_context(race)
        for h in horses:
            n = h.get("number")
            if not isinstance(n, int): continue
            X.append(extract_horse_features(h, race, features_index, ctx))
            y.append(1 if n in winners else 0)
            race_ids.append(rid)
    return X, y, race_ids


def _train_nopop_lightgbm(X, y, np, lgb, num_boost=300):
    X_arr = np.array(X, dtype="float64")
    y_arr = np.array(y, dtype="int32")
    X_arr, _ = _mask_pop_columns(X_arr, np)
    n = len(X_arr)
    cut = max(1, int(n * 0.85))
    Xtr, ytr = X_arr[:cut], y_arr[:cut]
    Xte, yte = X_arr[cut:], y_arr[cut:]
    train_data = lgb.Dataset(Xtr, label=ytr, feature_name=FEATURE_NAMES)
    valid_data = lgb.Dataset(Xte, label=yte, reference=train_data, feature_name=FEATURE_NAMES)
    params = {
        "objective": "binary", "metric": ["binary_logloss"],
        "num_leaves": 31, "learning_rate": 0.05, "min_data_in_leaf": 25,
        "lambda_l1": 0.15, "lambda_l2": 0.15,
        "feature_fraction": 0.8, "bagging_fraction": 0.8, "bagging_freq": 5,
        "verbosity": -1,
    }
    booster = lgb.train(params, train_data, num_boost_round=num_boost,
                        valid_sets=[valid_data], valid_names=["valid"],
                        callbacks=[lgb.early_stopping(stopping_rounds=20, verbose=False),
                                   lgb.log_evaluation(period=0)])
    return booster


def _softmax(probs):
    s = sum(p for p in probs if p > 0)
    if s <= 0: return [1.0 / max(1, len(probs)) for _ in probs]
    return [max(0.0, p) / s for p in probs]


def _predict_race(booster, race, features_index, np):
    """1 レースの nopop 予測 → top1, top2, top3 の馬番リスト"""
    horses = race.get("horses") or []
    if not horses: return []
    ctx = _race_context(race)
    X = [extract_horse_features(h, race, features_index, ctx) for h in horses]
    X_arr = np.array(X, dtype="float64")
    X_nopop = _mask_pop_features(X_arr, np)
    raw = booster.predict(X_nopop, num_iteration=booster.best_iteration or booster.current_iteration())
    probs = _softmax([float(p) for p in raw])
    # top3 を馬番で返す
    sorted_idx = sorted(range(len(probs)), key=lambda i: -probs[i])
    top_nums = []
    for i in sorted_idx[:3]:
        try: top_nums.append(int(horses[i].get("number")))
        except (TypeError, ValueError): top_nums.append(None)
    return top_nums  # [top1, top2, top3]


def _winner_of(result: Dict[str, Any]) -> Optional[int]:
    """results.json から 1 着馬番を取り出す"""
    for r in (result.get("results") or []):
        if r.get("rank") == 1 and r.get("number") is not None:
            try: return int(r["number"])
            except (TypeError, ValueError): pass
    return None


def _evaluate_win5_day(day: Dict[str, Any], booster, features_index, np) -> Optional[Dict[str, Any]]:
    """1 開催日の WIN5 を 3 戦略で評価。payouts は max 1 通り想定 (実際そう)。
    Returns: {"safe": {bet, ret, hit}, "mid": {...}, "wide": {...}, "winning_kumi": "...", "payout": ...}
    """
    target_races = day.get("target_races") or []
    payouts = day.get("payouts") or []
    if len(target_races) != 5 or not payouts:
        return None
    # 5 R それぞれの top3 を nopop 予測
    top_lists: List[List[Optional[int]]] = []
    winners: List[Optional[int]] = []
    for tr in target_races:
        rid = tr.get("race_id")
        race_path = RACES_DIR / f"{rid}.json"
        result_path = RESULTS_DIR / f"{rid}.json"
        if not race_path.exists() or not result_path.exists():
            return None
        try:
            race = json.loads(race_path.read_text(encoding="utf-8"))
            result = json.loads(result_path.read_text(encoding="utf-8"))
        except Exception:
            return None
        top_lists.append(_predict_race(booster, race, features_index, np))
        winners.append(_winner_of(result))
    if any(w is None for w in winners):
        return None
    # 的中組番 (1 通りの WIN5 払戻のみ想定)
    actual_kumi = winners  # [1着馬番 × 5]
    actual_kumi_raw = "".join(f"{n:02d}" for n in actual_kumi)
    # 払戻金を該当組番から取得 (kumi_raw マッチ)
    payout_amount = 0
    for p in payouts:
        if p.get("kumi_raw") == actual_kumi_raw:
            payout_amount = p.get("amount") or 0
            break
    # 3 戦略
    out = {"actual": actual_kumi, "actual_kumi_raw": actual_kumi_raw, "payout": payout_amount}
    # safe: 各 R top1 のみ (1 点 ¥200)
    safe_hit = all(top_lists[i][0] == winners[i] for i in range(5))
    out["safe"] = {"bet": POINT_PRICE, "ret": payout_amount if safe_hit else 0, "hit": int(safe_hit)}
    # mid: 各 R top1-2 (2^5 = 32 点 ¥6,400)
    mid_hit = all(winners[i] in top_lists[i][:2] for i in range(5))
    out["mid"] = {"bet": 32 * POINT_PRICE, "ret": payout_amount if mid_hit else 0, "hit": int(mid_hit)}
    # wide: 各 R top1-3 (3^5 = 243 点 ¥48,600)
    wide_hit = all(winners[i] in top_lists[i][:3] for i in range(5))
    out["wide"] = {"bet": 243 * POINT_PRICE, "ret": payout_amount if wide_hit else 0, "hit": int(wide_hit)}
    out["predicted_top1"] = [t[0] if t else None for t in top_lists]
    out["winners"] = winners
    return out


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--periods", type=int, default=3)
    parser.add_argument("--num-boost", type=int, default=300)
    args = parser.parse_args(argv)

    try:
        import numpy as np
        import lightgbm as lgb
    except ImportError as e:
        print(f"[NG] {e}", flush=True); return 1

    days = _load_win5_days()
    if not days:
        print("[NG] WIN5 配当データなし", flush=True); return 1
    print(f"[info] WIN5 開催日: {len(days)} 件", flush=True)

    pairs = _load_all_pairs()
    pairs.sort(key=lambda p: p[0])
    if not pairs:
        print("[NG] races/results データなし", flush=True); return 1
    print(f"[info] races/results pairs: {len(pairs)} 件", flush=True)

    features_index = _load_features_index()

    # WIN5 開催日を period 数に分割
    period_size = max(1, len(days) // args.periods)
    period_results: List[Dict[str, Any]] = []
    for p in range(args.periods):
        lo = p * period_size
        hi = (p + 1) * period_size if p < args.periods - 1 else len(days)
        period_days = days[lo:hi]
        if not period_days: continue
        # この period の最初の WIN5 日付を取得 → これより前の pairs で学習
        first_date = period_days[0].get("date")  # YYYY-MM-DD
        if not first_date: continue
        first_yyyymmdd = first_date.replace("-", "")
        # pairs の race_id 先頭 8 桁が first_yyyymmdd 未満のもののみで学習
        train_pairs = [pp for pp in pairs if pp[0][:8] < first_yyyymmdd]
        if not train_pairs:
            print(f"  [period {p}] {first_date} 以前のレースなし・スキップ", flush=True)
            continue
        print(f"\n[period {p+1}/{args.periods}] WIN5 開催 {len(period_days)} 日 / train pairs={len(train_pairs)}", flush=True)
        X, y, _ = _build_xy_from_pairs(train_pairs, features_index)
        if len(X) < 1000:
            print(f"  [skip] features 不足 ({len(X)})", flush=True)
            continue
        print(f"  [train] X={len(X)} 行, num_boost={args.num_boost}…", flush=True)
        booster = _train_nopop_lightgbm(X, y, np, lgb, num_boost=args.num_boost)

        day_evals = []
        for day in period_days:
            ev = _evaluate_win5_day(day, booster, features_index, np)
            if ev:
                ev["date"] = day.get("date")
                day_evals.append(ev)
        # 期間集計
        agg = {"safe": {"bet": 0, "ret": 0, "hit": 0}, "mid": {"bet": 0, "ret": 0, "hit": 0}, "wide": {"bet": 0, "ret": 0, "hit": 0}}
        for ev in day_evals:
            for s in ("safe", "mid", "wide"):
                agg[s]["bet"] += ev[s]["bet"]
                agg[s]["ret"] += ev[s]["ret"]
                agg[s]["hit"] += ev[s]["hit"]
        for s in ("safe", "mid", "wide"):
            inv = agg[s]["bet"]
            agg[s]["roi_pct"] = round(agg[s]["ret"] / inv * 100, 2) if inv > 0 else None
            agg[s]["hit_rate"] = round(agg[s]["hit"] / len(day_evals), 3) if day_evals else None
        period_results.append({"period": p+1, "days": len(day_evals), "first_date": first_date, "summary": agg, "day_evals": day_evals})
        print(f"  [period {p+1}] 評価 {len(day_evals)} 日", flush=True)
        for s in ("safe", "mid", "wide"):
            a = agg[s]
            print(f"    {s:<5} bet=¥{a['bet']:,} ret=¥{a['ret']:,} ROI={a['roi_pct']}% hit_rate={a['hit_rate']}", flush=True)

    # 全期間集計
    total_agg = {"safe": {"bet": 0, "ret": 0, "hit": 0, "days": 0}, "mid": {"bet": 0, "ret": 0, "hit": 0, "days": 0}, "wide": {"bet": 0, "ret": 0, "hit": 0, "days": 0}}
    strategy_period_rois = {"safe": [], "mid": [], "wide": []}
    for pr in period_results:
        days_n = pr["days"]
        for s in ("safe", "mid", "wide"):
            total_agg[s]["bet"] += pr["summary"][s]["bet"]
            total_agg[s]["ret"] += pr["summary"][s]["ret"]
            total_agg[s]["hit"] += pr["summary"][s]["hit"]
            total_agg[s]["days"] += days_n
            if pr["summary"][s]["roi_pct"] is not None:
                strategy_period_rois[s].append(pr["summary"][s]["roi_pct"])
    summary = {}
    for s in ("safe", "mid", "wide"):
        a = total_agg[s]
        rois = strategy_period_rois[s]
        valid = [r for r in rois if r is not None]
        mean = round(sum(valid) / len(valid), 2) if valid else None
        summary[s] = {
            "overall_roi_pct": round(a["ret"] / a["bet"] * 100, 2) if a["bet"] > 0 else None,
            "mean_period_roi_pct": mean,
            "worst_period_roi_pct": min(valid) if valid else None,
            "best_period_roi_pct": max(valid) if valid else None,
            "win_periods": sum(1 for r in valid if r >= 100),
            "active_periods": len(valid),
            "period_rois": rois,
            "total_bets": a["bet"],
            "total_returns": a["ret"],
            "total_hits": a["hit"],
            "total_days": a["days"],
            "hit_rate": round(a["hit"] / a["days"], 4) if a["days"] else None,
        }

    print("\n=== WIN5 真の Walk-forward 結果 (期間別 nopop 再学習・look-ahead 完全排除) ===", flush=True)
    print(f"{'戦略':<6}{'overall':<10}{'mean':<10}{'worst':<10}{'勝':<6}{'件数':<6}{'hit_rate':<10}", flush=True)
    for s in ("safe", "mid", "wide"):
        a = summary[s]
        wp = f"{a['win_periods']}/{a['active_periods']}"
        print(f"{s:<6}{a['overall_roi_pct'] or '-':<10}{a['mean_period_roi_pct'] or '-':<10}{a['worst_period_roi_pct'] or '-':<10}{wp:<6}{a['total_days']:<6}{a['hit_rate'] or '-':<10}", flush=True)

    out = {
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
        "periods": args.periods,
        "num_boost": args.num_boost,
        "total_days_evaluated": sum(pr["days"] for pr in period_results),
        "leakage_free": True,
        "method": "WIN5 開催日を期間分割し、各 period より前のレースで nopop 再学習 → period 内 WIN5 で 5 R 連勝予測",
        "summary": summary,
        "period_details": period_results,
    }
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n[OK] {OUT_PATH.relative_to(ROOT)} 保存", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
