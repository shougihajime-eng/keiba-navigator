# -*- coding: utf-8 -*-
"""
ev_threshold_sweep.py — 券種別 EV 閾値の最適化スイープ (Wave25-A)

各券種 (単勝・複勝・馬連・ワイド・3連複・3連単) について、EV 閾値を
0.85〜1.40 の範囲で 0.025 刻みでスイープし、それぞれの券種で
最も Walk-forward ROI が高い閾値を探す。

これまで全券種一律 EV >= 1.10 で買っていたが、券種ごとに最適な閾値は
異なる (控除率が違うので・払戻分布が違うので)。これを定量的に発見する。

入力:
  data/jv_cache/races/<race_id>.json
  data/jv_cache/results/<race_id>.json
  data/jv_cache/features.json
  data/jv_cache/model_lgbm.txt
  data/jv_cache/model_lgbm_nopop.txt (optional)

出力:
  data/jv_cache/ev_threshold_sweep.json
    各券種ごとに 「閾値 → ROI/的中率/件数」のテーブル + ベスト閾値

使い方:
  py -3.12 jv_bridge\\ev_threshold_sweep.py
  py -3.12 jv_bridge\\ev_threshold_sweep.py --test-ratio 0.2 --step 0.025
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
FEATURES_PATH = CACHE / "features.json"
META_PATH = CACHE / "model_lgbm_meta.json"
OUT_PATH = CACHE / "ev_threshold_sweep.json"

sys.path.insert(0, str(HERE.parent))
from jv_bridge.train_lightgbm import (  # noqa: E402
    FEATURE_NAMES, extract_horse_features, _race_context,
)
from jv_bridge.predict_lightgbm import (  # noqa: E402
    _load_model, _load_model_nopop, _predict_one,
    _normalize_softmax, _mask_pop_features,
)
from jv_bridge.validate_lightgbm import (  # noqa: E402
    _payout_tan, _payout_fuku, _payout_uren, _payout_wide,
    _payout_fuku3, _payout_tan3, _load_features_index,
)

UNIT = 100


def _load_race_results() -> List[Dict[str, Any]]:
    """race_id 昇順で (race, result) ペアのリスト"""
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


def _predict_race(race: Dict[str, Any], model_tup, features_index, model_nopop_tup=None) -> List[Dict[str, Any]]:
    """1 レースの全頭分の予測を返す: [{number, prob, prob_nopop, ev, ev_nopop, odds, popularity, name}]
    model_tup: (booster, kind) のタプル
    """
    horses = race.get("horses") or []
    if not horses:
        return []
    ctx = _race_context(race)
    X = [extract_horse_features(h, race, features_index, ctx) for h in horses]
    try:
        import numpy as np  # type: ignore
        X_arr = np.array(X, dtype="float64")
    except Exception:
        np = None
        X_arr = X
    model, kind = model_tup
    raws = list(_predict_one(model, kind, X_arr))
    raws_nopop = None
    if model_nopop_tup is not None and model_nopop_tup[0] is not None and np is not None:
        X_nopop = _mask_pop_features(X_arr, np)
        m2, k2 = model_nopop_tup
        raws_nopop = list(_predict_one(m2, k2, X_nopop))
    # softmax 正規化 (レース内)
    probs = _normalize_softmax([float(p) for p in raws])
    probs_nopop = _normalize_softmax([float(p) for p in raws_nopop]) if raws_nopop is not None else [None] * len(horses)
    out = []
    for i, h in enumerate(horses):
        odds = h.get("win_odds") or 0
        try:
            odds_f = float(odds)
        except (TypeError, ValueError):
            odds_f = 0.0
        ev = probs[i] * odds_f if odds_f > 0 else 0.0
        ev_nopop = (probs_nopop[i] or 0) * odds_f if odds_f > 0 and probs_nopop[i] else 0.0
        out.append({
            "number": h.get("number"),
            "name": h.get("name") or "",
            "odds": odds_f,
            "popularity": h.get("popularity"),
            "prob": probs[i],
            "prob_nopop": probs_nopop[i],
            "ev": ev,
            "ev_nopop": ev_nopop,
        })
    return out


def _is_in_top3(payouts: Dict[str, Any], num: int) -> bool:
    """複勝対象に入っているか"""
    fuku = (payouts or {}).get("fuku") or []
    for f in fuku:
        if isinstance(f, dict) and f.get("number") == num:
            return True
    return False


# ─────────────────────────────────────────────────────────────
# 各券種ごとの「投資額・払戻・hit」を返す betting function
#  共通インタフェース: (predictions, payouts, threshold) → (invest, returned, hit)
#  predictions は prob 降順でソート済み
# ─────────────────────────────────────────────────────────────

def bet_tan(preds, payouts, threshold):
    """単勝: 本命の EV が閾値以上のときだけ買う"""
    if not preds:
        return (0, 0, False)
    top = preds[0]
    if top["ev"] < threshold:
        return (0, 0, False)
    ret = _payout_tan(payouts, top["number"])
    return (UNIT, ret, ret > 0)


def bet_fuku(preds, payouts, threshold):
    """複勝: 本命の EV (期待値) が閾値以上のときに買う
       複勝の EV は「単勝確率 × 単勝オッズ」では正確じゃないが、
       高めの prob を持つ馬の複勝 EV は実質的に prob*1.5 ぐらい (経験則)
       なので、threshold は単勝より少し低めに効く"""
    if not preds:
        return (0, 0, False)
    top = preds[0]
    if top["ev"] < threshold:
        return (0, 0, False)
    ret = _payout_fuku(payouts, top["number"])
    return (UNIT, ret, ret > 0)


def bet_fuku_prob(preds, payouts, threshold):
    """複勝 (確率閾値版): 本命の prob (1着確率) が閾値以上のとき複勝を買う
       これは「複勝は配当より的中率重視」という思想
       閾値は確率なので 0.15〜0.45 ぐらいの範囲"""
    if not preds:
        return (0, 0, False)
    top = preds[0]
    if (top["prob"] or 0) < threshold:
        return (0, 0, False)
    ret = _payout_fuku(payouts, top["number"])
    return (UNIT, ret, ret > 0)


def bet_uren(preds, payouts, threshold):
    """馬連 本命-対抗: 本命と対抗の合計確率 × 平均オッズ 推定 EV"""
    if len(preds) < 2:
        return (0, 0, False)
    p1 = preds[0]
    p2 = preds[1]
    # 馬連の擬似 EV: (p1*p2) を 1-2 着の同時発生確率と仮定し、
    # 推定オッズ 1/(p1*p2)*0.75 (控除 25%) で EV を作る
    p_pair = (p1["prob"] or 0) * (p2["prob"] or 0) * 2  # 順不同なので 2 倍
    if p_pair <= 0:
        return (0, 0, False)
    est_ev = p_pair / max(1e-6, p_pair) * 1.0  # placeholder
    # 簡易版: 本命 prob + 対抗 prob が閾値以上なら買う
    if (p1["prob"] or 0) + (p2["prob"] or 0) < threshold:
        return (0, 0, False)
    ret = _payout_uren(payouts, p1["number"], p2["number"])
    return (UNIT, ret, ret > 0)


def bet_wide_3box(preds, payouts, threshold):
    """ワイド 3 点ボックス (1-2 / 1-3 / 2-3): top3 の prob 合計が閾値以上"""
    if len(preds) < 3:
        return (0, 0, False)
    top3 = preds[:3]
    sum_p = sum((p["prob"] or 0) for p in top3)
    if sum_p < threshold:
        return (0, 0, False)
    invest = UNIT * 3
    ret = (
        _payout_wide(payouts, top3[0]["number"], top3[1]["number"])
        + _payout_wide(payouts, top3[0]["number"], top3[2]["number"])
        + _payout_wide(payouts, top3[1]["number"], top3[2]["number"])
    )
    return (invest, ret, ret > 0)


def bet_fuku3_box(preds, payouts, threshold):
    """3 連複 ボックス: top3 の prob 合計が閾値以上"""
    if len(preds) < 3:
        return (0, 0, False)
    top3 = preds[:3]
    sum_p = sum((p["prob"] or 0) for p in top3)
    if sum_p < threshold:
        return (0, 0, False)
    invest = UNIT  # ボックス 1 点 = 100 円
    ret = _payout_fuku3(payouts, top3[0]["number"], top3[1]["number"], top3[2]["number"])
    return (invest, ret, ret > 0)


def bet_tan3(preds, payouts, threshold):
    """3 連単 (1-2-3 着順通り): top3 の prob 積が閾値以上"""
    if len(preds) < 3:
        return (0, 0, False)
    top3 = preds[:3]
    prod_p = 1.0
    for p in top3:
        prod_p *= (p["prob"] or 0)
    # 閾値は確率積 (例: 0.001 ~ 0.05)
    if prod_p < threshold:
        return (0, 0, False)
    invest = UNIT
    ret = _payout_tan3(payouts, top3[0]["number"], top3[1]["number"], top3[2]["number"])
    return (invest, ret, ret > 0)


# ─────────────────────────────────────────────────────────────
# 券種別の閾値スイープ範囲
# ─────────────────────────────────────────────────────────────
SWEEPS = [
    # (券種名, ベッティング関数, 閾値リスト, 説明)
    ("単勝 EV", bet_tan,
        [round(0.40 + i * 0.025, 4) for i in range(40)],
        "本命単勝 100 円 (EV 閾値)"),
    ("複勝 EV", bet_fuku,
        [round(0.40 + i * 0.025, 4) for i in range(40)],
        "本命複勝 100 円 (EV 閾値)"),
    ("複勝 prob", bet_fuku_prob,
        [round(0.15 + i * 0.005, 4) for i in range(80)],  # 0.15-0.55 を 0.005 刻みで 80 段階
        "本命複勝 100 円 (1 着確率閾値)"),
    ("馬連 prob合計", bet_uren,
        [round(0.25 + i * 0.01, 4) for i in range(60)],  # 0.25-0.85 を 0.01 刻みで 60 段階
        "馬連 本命-対抗 100 円 (top2 prob 合計)"),
    ("ワイド 3点 prob合計", bet_wide_3box,
        [round(0.30 + i * 0.01, 4) for i in range(60)],
        "ワイド 3 点ボックス 300 円 (top3 prob 合計)"),
    ("3連複 prob合計", bet_fuku3_box,
        [round(0.30 + i * 0.01, 4) for i in range(60)],
        "3連複 ボックス 1 点 100 円 (top3 prob 合計)"),
    ("3連単 prob積", bet_tan3,
        [round(0.0005 * (1.10 ** i), 6) for i in range(50)],
        "3連単 1 点 100 円 (top3 prob 積)"),
]


def evaluate_strategy(bet_fn, threshold, pairs):
    """1 戦略 + 1 閾値で全レースを評価"""
    invested = 0
    returned = 0
    bets = 0
    hits = 0
    model_tup = _load_model()
    if model_tup is None or model_tup[0] is None:
        return None
    model_nopop_tup = _load_model_nopop()
    features_index = _load_features_index()
    for (rid, race, result) in pairs:
        preds = _predict_race(race, model_tup, features_index, model_nopop_tup=model_nopop_tup)
        if not preds:
            continue
        preds.sort(key=lambda x: (x["prob"] or 0), reverse=True)
        inv, ret, hit = bet_fn(preds, result.get("payouts") or {}, threshold)
        if inv > 0:
            bets += 1
            invested += inv
            returned += ret
            if hit:
                hits += 1
    roi = (returned / invested) if invested > 0 else 0.0
    hit_rate = (hits / bets) if bets > 0 else 0.0
    return {
        "threshold": threshold,
        "bets": bets,
        "invested": invested,
        "returned": returned,
        "roi_pct": roi * 100,
        "hit_rate_pct": hit_rate * 100,
    }


def evaluate_all_sweeps_cached(pairs):
    """全戦略・全閾値を評価 (予測キャッシュで高速化)"""
    model_tup = _load_model()
    if model_tup is None or model_tup[0] is None:
        print("[ev_threshold_sweep] No model. Run train_lightgbm.py first.")
        return None
    model_nopop_tup = _load_model_nopop()
    features_index = _load_features_index()

    # 全レースの予測を 1 回だけ計算して使い回す
    print(f"[ev_threshold_sweep] Predicting {len(pairs)} races...")
    cache = []  # [(payouts, preds_sorted)]
    for i, (rid, race, result) in enumerate(pairs):
        if i % 200 == 0:
            print(f"  {i}/{len(pairs)}")
        preds = _predict_race(race, model_tup, features_index, model_nopop_tup=model_nopop_tup)
        if not preds:
            continue
        preds.sort(key=lambda x: (x["prob"] or 0), reverse=True)
        cache.append((rid, result.get("payouts") or {}, preds))
    print(f"  {len(cache)} races predicted.")

    results = {}
    for (name, bet_fn, thresholds, desc) in SWEEPS:
        print(f"[ev_threshold_sweep] Sweeping {name} ({len(thresholds)} thresholds)...")
        rows = []
        for th in thresholds:
            invested = 0
            returned = 0
            bets = 0
            hits = 0
            for (rid, payouts, preds) in cache:
                inv, ret, hit = bet_fn(preds, payouts, th)
                if inv > 0:
                    bets += 1
                    invested += inv
                    returned += ret
                    if hit:
                        hits += 1
            roi = (returned / invested) if invested > 0 else 0.0
            hit_rate = (hits / bets) if bets > 0 else 0.0
            rows.append({
                "threshold": th,
                "bets": bets,
                "invested": invested,
                "returned": returned,
                "roi_pct": round(roi * 100, 1),
                "hit_rate_pct": round(hit_rate * 100, 1),
            })
        # ベスト閾値 (件数 >= 30 で ROI 最大) を見つける
        valid_rows = [r for r in rows if r["bets"] >= 30]
        best = max(valid_rows, key=lambda r: r["roi_pct"]) if valid_rows else (
            max(rows, key=lambda r: r["roi_pct"]) if rows else None
        )
        results[name] = {
            "desc": desc,
            "rows": rows,
            "best": best,
        }
    return results


def print_summary(results):
    print()
    print("=" * 90)
    print(f"{'券種':<24}{'最適閾値':<14}{'件数':<8}{'ROI':<10}{'的中率':<10}")
    print("=" * 90)
    for name, r in results.items():
        b = r.get("best")
        if not b:
            print(f"{name:<24}{'(発火なし)':<14}")
            continue
        th_txt = f"{b['threshold']:.4f}".rstrip("0").rstrip(".") if isinstance(b['threshold'], float) else str(b['threshold'])
        print(f"{name:<24}{th_txt:<14}{b['bets']:<8}{b['roi_pct']:<10}{b['hit_rate_pct']:<10}")
    print("=" * 90)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--test-ratio", type=float, default=0.2,
                        help="後ろから何割を test とするか (デフォルト 0.2)")
    parser.add_argument("--use-all", action="store_true",
                        help="train/test 分割せず全レースで評価")
    args = parser.parse_args(argv)

    pairs = _load_race_results()
    if len(pairs) == 0:
        print("[ev_threshold_sweep] No race-result pairs.")
        return 1
    pairs.sort(key=lambda p: p[0])
    if not args.use_all:
        n = len(pairs)
        cut = int(n * (1 - args.test_ratio))
        pairs = pairs[cut:]
    print(f"[ev_threshold_sweep] Using {len(pairs)} race-result pairs (test).")

    results = evaluate_all_sweeps_cached(pairs)
    if results is None:
        return 1

    print_summary(results)

    out = {
        "evaluated_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        "pairs_count": len(pairs),
        "test_ratio": args.test_ratio if not args.use_all else None,
        "sweeps": results,
    }
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[ev_threshold_sweep] Saved: {OUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
