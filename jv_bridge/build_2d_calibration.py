# -*- coding: utf-8 -*-
"""
build_2d_calibration.py — 本番用「2次元補正表(予想勝率×オッズ帯→実勝率)」を作る (2026-06-13)

調査で判明した favorite-longshot bias(大穴は割高・本命は割安)を、手調整の冷まし係数
(honest_ev._COOL_BANDS)ではなく「過去に実際何%勝ったか」の実測で補正するための表。

  ・過去の全レース(predictions の win_prob + races の win_odds + results の着順)を走査
  ・各馬を (レース内正規化した予想勝率の帯 × 単勝オッズの帯) に振り分け
  ・帯ごとに「実際の1着率(wins/count)」を集計 → calibration_2d.json に保存
  ・honest_ev はこの表を読み、(素の予想勝率, オッズ) を実勝率へ補正して EV を出す

リークについて: この表は「未来のレースに適用する安定したマッピング」なので、
全期間の集計で作ってよい(個々の未来結果を覗くわけではない)。検証(analyze_calibrated_ev)は
別途 expanding window で leak-free に効果を確認済み。

出力: data/jv_cache/calibration_2d.json
実行: <64bit python> jv_bridge/build_2d_calibration.py
"""
from __future__ import annotations

import io
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

os.environ["PYTHONIOENCODING"] = "utf-8"
for _attr in ("stdout", "stderr"):
    _s = getattr(sys, _attr, None)
    if _s and hasattr(_s, "buffer"):
        setattr(sys, _attr, io.TextIOWrapper(_s.buffer, encoding="utf-8"))

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "jv_cache"
PREDS = CACHE / "predictions"
RACES = CACHE / "races"
RESULTS = CACHE / "results"
OUT = CACHE / "calibration_2d.json"

# honest_ev / analyze_calibrated_ev と同じ格子(帯)に揃える
PROB_EDGES = [0.0, 0.03, 0.06, 0.10, 0.15, 0.22, 0.35, 1.01]
ODDS_EDGES = [1.0, 2.5, 4.0, 6.0, 9.0, 15.0, 30.0, 70.0, 1e9]
MIN_CELL = 8       # この件数未満の帯は補正しない(素の勝率にフォールバック)
SHRINK_K = 25.0    # 縮約(薄い帯は素の勝率へ寄せ過適合を防ぐ)


def _load(p):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def _winner_number(result):
    if not result:
        return None
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


def _bin(value, edges):
    if value is None:
        return None
    for i in range(len(edges) - 1):
        if edges[i] <= value < edges[i + 1]:
            return i
    return len(edges) - 2


def main():
    table = defaultdict(lambda: [0, 0])  # (pi, oi) -> [wins, count]
    races_used = 0
    for pred_file in PREDS.glob("*.json"):
        rid = pred_file.stem
        pred = _load(pred_file)
        race = _load(RACES / f"{rid}.json")
        result = _load(RESULTS / f"{rid}.json")
        if not pred or not race or not result:
            continue
        winner = _winner_number(result)
        if winner is None:
            continue
        # 予想勝率を馬番で引けるように
        pmap = {h.get("number"): h.get("win_prob") for h in (pred.get("horses") or [])
                if isinstance(h.get("number"), int)}
        rhorses = [h for h in (race.get("horses") or []) if isinstance(h.get("number"), int)]
        # レース内で正規化(build_race_card と同じ)
        sw = sum(pmap.get(h["number"]) or 0 for h in rhorses) or 0.0
        if sw <= 0:
            continue
        used = False
        for h in rhorses:
            num = h["number"]
            raw = pmap.get(num)
            odds = h.get("win_odds")
            try:
                odds = float(odds) if odds is not None else None
            except (TypeError, ValueError):
                odds = None
            if raw is None or odds is None or odds <= 1.0:
                continue
            prob = raw / sw
            pi = _bin(prob, PROB_EDGES)
            oi = _bin(odds, ODDS_EDGES)
            if pi is None or oi is None:
                continue
            table[(pi, oi)][0] += 1 if num == winner else 0
            table[(pi, oi)][1] += 1
            used = True
        if used:
            races_used += 1

    # JSON 化 (キーは "pi_oi" 文字列)
    cells = {}
    for (pi, oi), (wins, cnt) in table.items():
        cells[f"{pi}_{oi}"] = {"wins": wins, "count": cnt,
                               "rate": round(wins / cnt, 5) if cnt else None}
    out = {
        "built_at": datetime.now(timezone.utc).isoformat(),
        "races_used": races_used,
        "prob_edges": PROB_EDGES,
        "odds_edges": ODDS_EDGES,
        "min_cell": MIN_CELL,
        "shrink_k": SHRINK_K,
        "cells": cells,
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    n_usable = sum(1 for c in cells.values() if c["count"] >= MIN_CELL)
    print(f"[OK] {OUT.name} 保存: {races_used} レース / 有効な帯 {n_usable}/{len(cells)}", flush=True)
    # ざっくり可視化(オッズ帯ごとの実勝率の平均的傾向)
    print("オッズ帯ごとの実1着率(参考):", flush=True)
    by_odds = defaultdict(lambda: [0, 0])
    for (pi, oi), (wins, cnt) in table.items():
        by_odds[oi][0] += wins
        by_odds[oi][1] += cnt
    for oi in sorted(by_odds):
        wins, cnt = by_odds[oi]
        lo, hi = ODDS_EDGES[oi], ODDS_EDGES[oi + 1]
        hi_s = "∞" if hi >= 1e9 else f"{hi:g}"
        if cnt:
            print(f"  オッズ {lo:g}〜{hi_s}倍: 実1着率 {wins/cnt*100:.1f}% ({cnt}頭)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
