# -*- coding: utf-8 -*-
"""
walk_forward_value_ev.py — 本物の価値投資 (EV) をズルなし Walk-forward で検証 (2026-05-26)

これまでの戦略の致命的弱点:
  「AI が自信を持った馬を、その馬のオッズ (配当の良し悪し) を一切見ずに買う」だけだった。
  → odds:null / ev:null のまま発火。投資としては「安いか高いか」を見ていない。

このスクリプトの新規性:
  1. 各期間 i で pairs[0:start_i] だけで nopop (人気を見ない実力派) モデルを学習 (look-ahead 排除)
  2. 過去データだけで確率の癖を Isotonic 補正 (nopop は確率を低く見積もる癖あり → 補正で本当の勝率へ)
  3. テスト期間で「補正済み勝率 p × 本物の単勝オッズ o = 期待値 EV」を計算
  4. EV >= 閾値 の馬だけ単勝で買う = 市場が安く見ている馬だけ狙う「価値投資」
  5. 比較として「人気を見る primary モデルの EV」「人気 1 番ベタ買い」「nopop top1 ベタ買い」も測る

出力: data/jv_cache/value_ev_result.json
      (per-bet キャッシュ value_ev_bets.json も保存し、閾値の再スイープを高速化)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

os.environ["PYTHONIOENCODING"] = "utf-8"
for _attr in ("stdout", "stderr"):
    _s = getattr(sys, _attr, None)
    if _s is not None:
        try:
            _s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
CACHE = ROOT / "data" / "jv_cache"
RACES_DIR = CACHE / "races"
RESULTS_DIR = CACHE / "results"
OUT_PATH = CACHE / "value_ev_result.json"
BETS_PATH = CACHE / "value_ev_bets.json"

sys.path.insert(0, str(ROOT))
from jv_bridge.train_lightgbm import (  # noqa: E402
    FEATURE_NAMES, extract_horse_features, _race_context, _mask_pop_columns,
)
from jv_bridge.predict_lightgbm import _mask_pop_features  # noqa: E402
from jv_bridge.validate_lightgbm import (  # noqa: E402
    _payout_tan, _payout_fuku, _payout_uren, _load_features_index,
)


# ----------------------------------------------------------------------------
# データ読み込み
# ----------------------------------------------------------------------------
def _load_pairs() -> List[Tuple[str, dict, dict]]:
    pairs = []
    for race_file in sorted(RACES_DIR.glob("*.json")):
        rid = race_file.stem
        result_file = RESULTS_DIR / f"{rid}.json"
        if not result_file.exists():
            continue
        try:
            race = json.loads(race_file.read_text(encoding="utf-8"))
            result = json.loads(result_file.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not race.get("horses") or not (result.get("payouts") or {}):
            continue
        pairs.append((rid, race, result))
    pairs.sort(key=lambda p: p[0])
    return pairs


def _winner_number(result: dict) -> Optional[int]:
    tan = (result.get("payouts") or {}).get("tan")
    if isinstance(tan, dict) and tan.get("winner") is not None:
        try:
            return int(tan["winner"])
        except (TypeError, ValueError):
            pass
    for r in (result.get("results") or []):
        if r.get("rank") == 1 and r.get("number") is not None:
            try:
                return int(r["number"])
            except (TypeError, ValueError):
                pass
    return None


def _build_xy(pairs, features_index):
    X, y = [], []
    for rid, race, result in pairs:
        horses = race.get("horses") or []
        win = _winner_number(result)
        if win is None or not horses:
            continue
        ctx = _race_context(race)
        for h in horses:
            n = h.get("number")
            if not isinstance(n, int):
                continue
            X.append(extract_horse_features(h, race, features_index, ctx))
            y.append(1 if n == win else 0)
    return X, y


def _train_booster(X, y, np, lgb, nopop: bool, num_boost: int):
    X_arr = np.array(X, dtype="float64")
    y_arr = np.array(y, dtype="int32")
    if nopop:
        X_arr, _ = _mask_pop_columns(X_arr, np)
    n = len(X_arr)
    cut = max(1, int(n * 0.85))
    train_data = lgb.Dataset(X_arr[:cut], label=y_arr[:cut], feature_name=FEATURE_NAMES)
    valid_data = lgb.Dataset(X_arr[cut:], label=y_arr[cut:], reference=train_data, feature_name=FEATURE_NAMES)
    params = {
        "objective": "binary", "metric": ["binary_logloss"],
        "num_leaves": 31, "learning_rate": 0.05, "min_data_in_leaf": 25,
        "lambda_l1": 0.15, "lambda_l2": 0.15,
        "feature_fraction": 0.8, "bagging_fraction": 0.8, "bagging_freq": 5,
        "verbosity": -1,
    }
    booster = lgb.train(
        params, train_data, num_boost_round=num_boost,
        valid_sets=[valid_data], valid_names=["valid"],
        callbacks=[lgb.early_stopping(stopping_rounds=20, verbose=False), lgb.log_evaluation(period=0)],
    )
    return booster


def _softmax(vals):
    s = sum(v for v in vals if v > 0)
    if s <= 0:
        return [1.0 / max(1, len(vals))] * len(vals)
    return [max(0.0, v) / s for v in vals]


def _predict_race_probs(booster, race, features_index, np, nopop: bool):
    """1 レースの各馬の softmax 勝率を返す (馬の並び順)。"""
    horses = race.get("horses") or []
    ctx = _race_context(race)
    X = [extract_horse_features(h, race, features_index, ctx) for h in horses]
    X_arr = np.array(X, dtype="float64")
    if nopop:
        X_arr = _mask_pop_features(X_arr, np)
    raw = booster.predict(X_arr, num_iteration=booster.best_iteration or booster.current_iteration())
    return _softmax([float(x) for x in raw])


# ----------------------------------------------------------------------------
# メイン
# ----------------------------------------------------------------------------
def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--periods", type=int, default=7)
    parser.add_argument("--num-boost", type=int, default=400)
    parser.add_argument("--with-primary", action="store_true", help="人気込み primary モデルも評価")
    args = parser.parse_args(argv)

    try:
        import numpy as np  # type: ignore
        import lightgbm as lgb  # type: ignore
        from sklearn.isotonic import IsotonicRegression  # type: ignore
    except ImportError as e:
        print(f"[NG] {e}", flush=True)
        return 1

    pairs = _load_pairs()
    if len(pairs) < args.periods * 100:
        print(f"[NG] pairs 数 {len(pairs)} が少ない", flush=True)
        return 1
    features_index = _load_features_index()
    n = len(pairs)
    period_size = max(1, n // args.periods)
    print(f"[info] pairs={n} / 期間数={args.periods} / 1 期間={period_size}", flush=True)

    # 全期間の per-bet レコードを貯める
    # rec: {period, rid, number, p_nopop, p_primary, odds, won, tan_pay, popularity, fuku_pay, is_winner_fav}
    all_recs: List[Dict[str, Any]] = []

    for p in range(1, args.periods):
        lo = p * period_size
        hi = (p + 1) * period_size if p < args.periods - 1 else n
        train_pairs = pairs[:lo]
        test_pairs = pairs[lo:hi]
        print(f"\n[period {p}/{args.periods-1}] train={len(train_pairs)} / test={len(test_pairs)}", flush=True)

        X, y = _build_xy(train_pairs, features_index)
        if not X:
            continue

        # --- nopop モデル学習 + 補正 ---
        bst_nopop = _train_booster(X, y, np, lgb, nopop=True, num_boost=args.num_boost)
        bst_primary = None
        if args.with_primary:
            bst_primary = _train_booster(X, y, np, lgb, nopop=False, num_boost=args.num_boost)

        # 補正: 過去 train_pairs の後半 20% を使って (softmax_p, won) を集め Isotonic fit (out-of-sample 寄り)
        cal_lo = int(len(train_pairs) * 0.80)
        cal_pairs = train_pairs[cal_lo:] or train_pairs[-200:]
        cal_p, cal_y = [], []
        for rid, race, result in cal_pairs:
            win = _winner_number(result)
            if win is None:
                continue
            probs = _predict_race_probs(bst_nopop, race, features_index, np, nopop=True)
            for h, pr in zip(race.get("horses") or [], probs):
                if not isinstance(h.get("number"), int):
                    continue
                cal_p.append(pr)
                cal_y.append(1 if h["number"] == win else 0)
        iso = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
        if len(set(cal_p)) > 2 and sum(cal_y) > 0:
            iso.fit(cal_p, cal_y)
            calibrate = lambda arr: list(iso.predict(arr))
        else:
            calibrate = lambda arr: list(arr)

        # --- テスト期間を予測してレコード化 ---
        for rid, race, result in test_pairs:
            horses = race.get("horses") or []
            if not horses:
                continue
            win = _winner_number(result)
            payouts = result.get("payouts") or {}
            probs_n = _predict_race_probs(bst_nopop, race, features_index, np, nopop=True)
            cal_n = calibrate(probs_n)
            # レース内で和=1 に正規化 (確率分布として整える)
            s = sum(cal_n) or 1.0
            cal_n = [c / s for c in cal_n]
            probs_p = None
            if bst_primary is not None:
                probs_p = _predict_race_probs(bst_primary, race, features_index, np, nopop=False)
            for i, h in enumerate(horses):
                num = h.get("number")
                if not isinstance(num, int):
                    continue
                odds = h.get("win_odds")
                try:
                    odds = float(odds) if odds is not None else None
                except (TypeError, ValueError):
                    odds = None
                rec = {
                    "period": p,
                    "rid": rid,
                    "number": num,
                    "p_nopop": round(cal_n[i], 6),
                    "p_nopop_raw": round(probs_n[i], 6),
                    "p_primary": round(probs_p[i], 6) if probs_p else None,
                    "odds": odds,
                    "won": 1 if (win is not None and num == win) else 0,
                    "tan_pay": _payout_tan(payouts, num),
                    "fuku_pay": _payout_fuku(payouts, num),
                    "popularity": h.get("popularity"),
                }
                all_recs.append(rec)
        print(f"  [period {p}] レコード累計={len(all_recs)}", flush=True)

    BETS_PATH.write_text(json.dumps(all_recs, ensure_ascii=False), encoding="utf-8")
    print(f"\n[OK] per-bet キャッシュ {BETS_PATH.name} 保存 ({len(all_recs)} レコード)", flush=True)

    # ------------------------------------------------------------------
    # 戦略スイープ (キャッシュから・再学習不要)
    # ------------------------------------------------------------------
    summary = sweep_strategies(all_recs, args.periods)

    out = {
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
        "periods": args.periods,
        "num_boost": args.num_boost,
        "total_pairs": n,
        "leakage_free": True,
        "method": "期間別再学習 + 過去データのみで Isotonic 補正 + 補正済み勝率×本物オッズ=EV で単勝価値投資",
        "strategies": summary,
    }
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[OK] {OUT_PATH.name} 保存", flush=True)
    return 0


def _roi_table(recs, predicate, stake_field="tan_pay", periods=7):
    """predicate(rec)->bool を満たす rec を単勝で買ったときの ROI を期間別+全体で集計。"""
    by_period: Dict[int, List[int]] = {}
    inv_total = ret_total = bets = hits = 0
    for r in recs:
        if not predicate(r):
            continue
        pay = r[stake_field]
        per = r["period"]
        by_period.setdefault(per, [0, 0])
        by_period[per][0] += 100
        by_period[per][1] += pay
        inv_total += 100
        ret_total += pay
        bets += 1
        if pay > 0:
            hits += 1
    period_rois = []
    for per in sorted(by_period):
        inv, ret = by_period[per]
        period_rois.append(round(ret / inv * 100, 1) if inv else None)
    valid = [x for x in period_rois if x is not None]
    return {
        "bets": bets,
        "hits": hits,
        "hit_rate": round(hits / bets, 4) if bets else None,
        "invested": inv_total,
        "returned": ret_total,
        "overall_roi_pct": round(ret_total / inv_total * 100, 2) if inv_total else None,
        "period_rois": period_rois,
        "win_periods": sum(1 for x in valid if x >= 100),
        "active_periods": len(valid),
    }


def sweep_strategies(recs, periods):
    """各戦略の ROI を測って表示・返す。"""
    strategies: List[Tuple[str, Any, str]] = []

    # --- ベースライン ---
    strategies.append(("単勝: 人気1番ベタ買い", lambda r: r["popularity"] == 1, "tan_pay"))
    strategies.append(("単勝: nopop top1ベタ買い(EV無視)", _make_top1_nopop(recs), "tan_pay"))

    # --- 価値投資: 補正済みnopop勝率 × 単勝オッズ = EV ---
    for th in [1.0, 1.05, 1.1, 1.15, 1.2, 1.3, 1.4, 1.5, 1.7, 2.0]:
        strategies.append((
            f"単勝 価値投資 EV>={th:.2f} (補正nopop×オッズ)",
            (lambda th: lambda r: r["odds"] is not None and r["p_nopop"] * r["odds"] >= th)(th),
            "tan_pay",
        ))

    # --- 価値投資: オッズ帯で絞る (穴狙い / 中穴) ---
    for th in [1.1, 1.2, 1.3]:
        strategies.append((
            f"単勝 価値投資 EV>={th:.2f} かつ オッズ5-50倍 (中穴)",
            (lambda th: lambda r: r["odds"] is not None and 5.0 <= r["odds"] <= 50.0 and r["p_nopop"] * r["odds"] >= th)(th),
            "tan_pay",
        ))

    # --- 複勝の価値投資 (近似: 補正勝率を使い fuku_pay で回収) ---
    for th in [1.1, 1.2, 1.3]:
        strategies.append((
            f"複勝 価値投資 EV(単勝換算)>={th:.2f}",
            (lambda th: lambda r: r["odds"] is not None and r["p_nopop"] * r["odds"] >= th)(th),
            "fuku_pay",
        ))

    rows = []
    for name, pred, field in strategies:
        st = _roi_table(recs, pred, field, periods)
        st["name"] = name
        rows.append(st)

    rows.sort(key=lambda x: -(x["overall_roi_pct"] or 0))
    print(f"\n{'戦略':<48}{'回収率':>9}{'勝期間':>9}{'件数':>8}{'的中率':>8}", flush=True)
    print("=" * 90, flush=True)
    for r in rows:
        roi = f"{r['overall_roi_pct']:.1f}%" if r["overall_roi_pct"] is not None else "—"
        wp = f"{r['win_periods']}/{r['active_periods']}"
        hr = f"{r['hit_rate']*100:.1f}%" if r["hit_rate"] is not None else "—"
        print(f"{r['name']:<48}{roi:>9}{wp:>9}{r['bets']:>8}{hr:>8}", flush=True)
    return rows


def _make_top1_nopop(recs):
    """各レースで補正nopop勝率が最大の馬番を覚えておき、その馬だけ True。"""
    best: Dict[str, Tuple[int, float]] = {}
    for r in recs:
        cur = best.get(r["rid"])
        if cur is None or r["p_nopop"] > cur[1]:
            best[r["rid"]] = (r["number"], r["p_nopop"])
    top = {rid: num for rid, (num, _) in best.items()}
    return lambda r: top.get(r["rid"]) == r["number"]


if __name__ == "__main__":
    sys.exit(main())
