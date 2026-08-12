# -*- coding: utf-8 -*-
r"""
experiment_10y.py — 「学習データを10年ぶんに増やすと本当に強くなるのか」をリークなしで測る。

★本番の予想・モデル・おすすめには一切さわらない。読むだけ + 実験結果 json を書くだけ。

━━ 何と何を比べるか ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  A (いままで) … 手元にある約15か月ぶん (data/jv_cache/races|results) だけで学習
  B (10年)     … A + 取り込んだ過去 (data/jv_cache/history/races|results) で学習

  **テストに使うレースは A と B でまったく同じ**。ここを揃えないと比べられない。
  テスト区間より前のレースだけで学習する (未来を1レースも覗かない)。

━━ なぜ AUC だけ見てはいけないか ━━━━━━━━━━━━━━━━━━━━━━
  このプロジェクトは「AUC が上がったのに回収率は下がる」を何度も見ている
  (市場オッズが賢いので、当てる力が少し上がっても控除率20〜25%は超えない)。
  だから **AUC と 回収率(ROI) の両方** を出す。

実行 (64bit python):
  py -3.12-64 jv_bridge/experiment_10y.py --blocks 5
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

os.environ.setdefault("PYTHONIOENCODING", "utf-8")
for _a in ("stdout", "stderr"):
    _s = getattr(sys, _a, None)
    if _s is not None and hasattr(_s, "buffer"):
        setattr(sys, _a, io.TextIOWrapper(_s.buffer, encoding="utf-8", errors="replace"))

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
CACHE = ROOT / "data" / "jv_cache"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

LIVE_RACES = CACHE / "races"
LIVE_RESULTS = CACHE / "results"
HIST_RACES = CACHE / "history" / "races"
HIST_RESULTS = CACHE / "history" / "results"
FEAT_A = CACHE / "features.json"
FEAT_B = CACHE / "features_10y.json"
OUT = CACHE / "experiment_10y.json"

from jv_bridge.train_lightgbm import (  # noqa: E402
    FEATURE_NAMES, extract_horse_features, _race_context, _mask_pop_columns,
)
from jv_bridge.predict_lightgbm import _mask_pop_features  # noqa: E402
from jv_bridge import walk_forward_v2 as wf  # noqa: E402


def _log(m: str) -> None:
    print(m, flush=True)


def load_pairs(dirs: List[Tuple[Path, Path]]) -> List[Tuple[str, dict, dict]]:
    """(races_dir, results_dir) の並び順で読み、先に出てきた方を優先する。"""
    seen: Dict[str, Tuple[str, dict, dict]] = {}
    for rdir, sdir in dirs:
        if not rdir.exists():
            continue
        for rf in sorted(rdir.glob("*.json")):
            rid = rf.stem
            if rid in seen:
                continue
            sf = sdir / f"{rid}.json"
            if not sf.exists():
                continue
            try:
                race = json.loads(rf.read_text(encoding="utf-8"))
                res = json.loads(sf.read_text(encoding="utf-8"))
            except Exception:
                continue
            if not race.get("horses") or not (res.get("payouts") or {}):
                continue
            seen[rid] = (rid, race, res)
    return [seen[k] for k in sorted(seen)]


def build_xy(pairs, feats):
    X, y = wf._build_xy_from_pairs(pairs, feats)[:2]
    return X, y


def train_and_eval(train_pairs, test_pairs, feats, np, lgb, num_boost: int, label: str):
    """nopop モデルを学習 → テスト区間で AUC と各戦略の回収率を出す。"""
    X, y = build_xy(train_pairs, feats)
    if not X:
        return None
    _log(f"    [{label}] 学習 {len(X):,} 行 …")
    t0 = time.time()
    booster = wf._train_nopop_lightgbm(X, y, np, lgb, num_boost=num_boost)
    _log(f"    [{label}] 学習おわり {time.time()-t0:.0f} 秒")

    from sklearn.metrics import roc_auc_score  # type: ignore

    ys: List[int] = []
    ps: List[float] = []
    cache_slice = []
    for rid, race, result in test_pairs:
        horses = race.get("horses") or []
        if not horses:
            continue
        winners = set()
        for r in (result.get("results") or []):
            if r.get("rank") == 1 and r.get("number") is not None:
                try:
                    winners.add(int(r["number"]))
                except (TypeError, ValueError):
                    pass
        ctx = _race_context(race)
        X_t = [extract_horse_features(h, race, feats, ctx) for h in horses]
        X_arr = np.array(X_t, dtype="float64")
        X_nopop = _mask_pop_features(X_arr, np)
        raw = list(wf._predict_with_booster(booster, X_nopop, np))
        probs = wf._softmax([float(v) for v in raw])
        cache_slice.append({
            "rid": rid, "race": race, "horses": horses,
            "payouts": result.get("payouts") or {}, "probs": probs,
        })
        if winners:
            for h, pr in zip(horses, probs):
                n = h.get("number")
                if isinstance(n, int):
                    ys.append(1 if n in winners else 0)
                    ps.append(float(pr))

    auc = float(roc_auc_score(ys, ps)) if (ys and 0 < sum(ys) < len(ys)) else None
    strat = wf._evaluate_period(cache_slice, wf._strategies_for_evaluation(), np)
    return {"auc": auc, "rows": len(ys), "strategies": strat, "train_rows": len(X)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--blocks", type=int, default=5, help="テスト区間をいくつに割るか")
    ap.add_argument("--num-boost", type=int, default=300)
    ap.add_argument("--test-fraction", type=float, default=0.5,
                    help="今の手元データのうち、後ろ何割をテストに使うか")
    args = ap.parse_args()

    try:
        import numpy as np  # type: ignore
        import lightgbm as lgb  # type: ignore
        import sklearn  # noqa: F401
    except ImportError as e:
        _log(f"[NG] {e} (64bit python で実行してください)")
        return 1

    if not FEAT_B.exists():
        _log(f"[NG] {FEAT_B.name} がありません。先に 10年ぶんの features を作ってください。")
        return 1

    _log("[load] レースを読み込み中 …")
    pairs_a = load_pairs([(LIVE_RACES, LIVE_RESULTS)])
    pairs_b = load_pairs([(LIVE_RACES, LIVE_RESULTS), (HIST_RACES, HIST_RESULTS)])
    _log(f"  A(いままで) {len(pairs_a):,} レース / B(10年) {len(pairs_b):,} レース")
    if len(pairs_b) <= len(pairs_a):
        _log("[NG] 過去データが増えていません (history/ が空?)")
        return 1

    # テスト区間 = 「いままでの手元データ」の後ろ半分。A と B で完全に同じレース。
    cut = int(len(pairs_a) * (1.0 - args.test_fraction))
    test_all = pairs_a[cut:]
    block = max(1, len(test_all) // args.blocks)
    _log(f"[plan] テストに使うレース {len(test_all):,} (A と B で同一) を {args.blocks} 区間に分けます")

    blocks: List[Tuple[int, List]] = []
    for b in range(args.blocks):
        lo = b * block
        hi = (b + 1) * block if b < args.blocks - 1 else len(test_all)
        tp = test_all[lo:hi]
        if tp:
            blocks.append((b + 1, tp))

    # ⚠ features は片方で 380MB 級になるので、A を全部やってから B に移る
    #   (両方いっぺんに開くとメモリが厳しい)
    import gc
    got: Dict[str, Dict[int, Any]] = {"a": {}, "b": {}}
    for tag, feat_path, pairs_src, label in (
        ("a", FEAT_A, pairs_a, "A いままで"),
        ("b", FEAT_B, pairs_b, "B 10年"),
    ):
        _log(f"\n########## {label} ##########")
        feats = json.loads(feat_path.read_text(encoding="utf-8"))
        for bno, test_pairs in blocks:
            first_rid = test_pairs[0][0]
            train = [p for p in pairs_src if p[0] < first_rid]
            _log(f"\n[区間 {bno}/{len(blocks)}] テスト {len(test_pairs)} R / 学習 {len(train):,} R")
            r = train_and_eval(train, test_pairs, feats, np, lgb, args.num_boost, label)
            if r:
                r["train_races"] = len(train)
                got[tag][bno] = r
                _log(f"    AUC {r['auc']:.4f}")
        del feats
        gc.collect()

    rows: List[Dict[str, Any]] = []
    for bno, test_pairs in blocks:
        ra = got["a"].get(bno)
        rb = got["b"].get(bno)
        if not ra or not rb:
            continue
        _log(f"[区間 {bno}] AUC  A {ra['auc']:.4f}  →  B {rb['auc']:.4f}  (差 {rb['auc']-ra['auc']:+.4f})")
        rows.append({"block": bno, "test_races": len(test_pairs),
                     "train_races_a": ra["train_races"], "train_races_b": rb["train_races"],
                     "a": ra, "b": rb})

    if not rows:
        _log("[NG] 測れませんでした")
        return 1

    # ── まとめ ────────────────────────────────────────────
    aucs_a = [r["a"]["auc"] for r in rows if r["a"]["auc"] is not None]
    aucs_b = [r["b"]["auc"] for r in rows if r["b"]["auc"] is not None]
    mean_a = sum(aucs_a) / len(aucs_a)
    mean_b = sum(aucs_b) / len(aucs_b)
    up = sum(1 for r in rows if r["b"]["auc"] > r["a"]["auc"])

    _log("\n=== 当てる力 (AUC・高いほど良い) ===")
    _log(f"  A いままで {mean_a:.4f}   →   B 10年 {mean_b:.4f}   (差 {mean_b-mean_a:+.4f})")
    _log(f"  上がった区間 {up}/{len(rows)}")

    _log("\n=== 回収率 (100%を超えないと勝てない) ===")
    _log(f"{'戦略':<32}{'A いままで':>12}{'B 10年':>12}{'差':>10}{'件数A':>8}{'件数B':>8}")
    _log("=" * 82)
    names = [s[0] for s in wf._strategies_for_evaluation()]
    roi_rows = []
    for name in names:
        ia = sum(r["a"]["strategies"].get(name, {}).get("invested", 0) for r in rows)
        ra_ = sum(r["a"]["strategies"].get(name, {}).get("returned", 0) for r in rows)
        ba = sum(r["a"]["strategies"].get(name, {}).get("bets", 0) for r in rows)
        ib = sum(r["b"]["strategies"].get(name, {}).get("invested", 0) for r in rows)
        rb_ = sum(r["b"]["strategies"].get(name, {}).get("returned", 0) for r in rows)
        bb = sum(r["b"]["strategies"].get(name, {}).get("bets", 0) for r in rows)
        if not ia or not ib:
            continue
        pa = ra_ / ia * 100
        pb = rb_ / ib * 100
        roi_rows.append({"name": name, "roi_a": round(pa, 2), "roi_b": round(pb, 2),
                         "bets_a": ba, "bets_b": bb})
        _log(f"{name:<32}{pa:>11.1f}%{pb:>11.1f}%{pb-pa:>+9.1f}{ba:>8}{bb:>8}")

    better = sum(1 for r in roi_rows if r["roi_b"] > r["roi_a"])
    over100_a = sum(1 for r in roi_rows if r["roi_a"] >= 100)
    over100_b = sum(1 for r in roi_rows if r["roi_b"] >= 100)
    _log(f"\n  回収率が上がった戦略 {better}/{len(roi_rows)} ・"
         f"100%を超えた戦略 A={over100_a} → B={over100_b}")

    OUT.write_text(json.dumps({
        "evaluated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "races_a": len(pairs_a), "races_b": len(pairs_b),
        "test_races": len(test_all), "blocks": args.blocks,
        "auc_mean_a": round(mean_a, 4), "auc_mean_b": round(mean_b, 4),
        "auc_up_blocks": up, "roi": roi_rows, "per_block": rows,
        "leakage_free": True,
        "note": "テストレースは A/B で同一・学習はテスト区間より前のレースだけ",
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    _log(f"\n[OK] {OUT} に保存")
    return 0


if __name__ == "__main__":
    sys.exit(main())
