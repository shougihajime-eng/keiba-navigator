# -*- coding: utf-8 -*-
"""
analyze_calibrated_ev.py — 「2次元補正(予想勝率×オッズ帯)」+「回収率の信頼区間」(2026-06-13)

調査(成功した馬券システムの研究)で判明した本物のエッジ:
  「人はみんな大穴を買いすぎる(favorite-longshot bias) → 大穴は割高・本命は割安。
   割安になっている馬を機械的に拾い続けると、控除(テラ銭)の壁をギリギリ越えられる。」

この発想を、ズルなし(リークなし)で検証する:
  1. 既存の leak-free な per-bet キャッシュ value_ev_bets.json を読む
     (各ベットに period / p_nopop_raw(モデル素の勝率) / odds(本物の事前オッズ) /
      won / tan_pay / fuku_pay / popularity がタグ付き。再学習不要)
  2. 【2次元補正】(予想勝率の帯 × オッズの帯) ごとに「過去に実際何%勝ったか」を集計し、
     モデルの素の勝率をその実測へ補正する。
     ★ 重要(リーク防止): 補正表は「その期間より前(period < p)」のデータだけで作り、
        当該期間に適用する(expanding window=未来を一切覗かない)。
        period 1 は前が無いので無補正(素の勝率)のまま=正直。
  3. 補正後の勝率 × 本物オッズ = 期待値(EV)。EV>=閾値 の馬だけ単勝/複勝で買う。
  4. 生EV(補正なし) / 人気1番ベタ買い とも比較。
  5. 【信頼区間】レース単位のブートストラップ(1000回)で回収率の分布を出し、
     「その100%超えは運か実力か(5%〜95%区間が100%をまたぐか)」を正直に示す。

出力: data/jv_cache/calibrated_ev_result.json + コンソール表
実行: <64bit python> jv_bridge/analyze_calibrated_ev.py
      (キャッシュが古ければ先に walk_forward_value_ev.py を回して再生成すること)
"""
from __future__ import annotations

import io
import json
import os
import random
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
BETS_PATH = CACHE / "value_ev_bets.json"
OUT_PATH = CACHE / "calibrated_ev_result.json"

# 補正の格子(帯)。粗すぎると効かず・細かすぎるとスカスカになるので中庸に。
PROB_EDGES = [0.0, 0.03, 0.06, 0.10, 0.15, 0.22, 0.35, 1.01]
ODDS_EDGES = [1.0, 2.5, 4.0, 6.0, 9.0, 15.0, 30.0, 70.0, 1e9]
SHRINK_K = 25.0   # サンプルが薄い帯は素の勝率へ寄せる(過適合防止)
MIN_CELL = 8      # この件数未満の帯は素の勝率にフォールバック
BOOT_N = 1000     # ブートストラップ回数
SEED = 20260613


def _bin(value, edges):
    if value is None:
        return None
    for i in range(len(edges) - 1):
        if edges[i] <= value < edges[i + 1]:
            return i
    return len(edges) - 2


def _build_2d_table(recs):
    """recs から (prob帯, odds帯) -> (wins, count) を集計。"""
    table = defaultdict(lambda: [0, 0])
    for r in recs:
        oi = _bin(r.get("odds"), ODDS_EDGES)
        pi = _bin(r.get("p_nopop_raw"), PROB_EDGES)
        if oi is None or pi is None:
            continue
        table[(pi, oi)][0] += r["won"]
        table[(pi, oi)][1] += 1
    return table


def _calibrated_prob(rec, table):
    """素の勝率を、その馬が属する2次元帯の実勝率へ補正(薄い帯は素へ寄せる)。"""
    raw = rec.get("p_nopop_raw")
    oi = _bin(rec.get("odds"), ODDS_EDGES)
    pi = _bin(rec.get("p_nopop_raw"), PROB_EDGES)
    if raw is None or oi is None or pi is None:
        return raw
    wins, cnt = table.get((pi, oi), [0, 0])
    if cnt < MIN_CELL:
        return raw
    # 縮約(Beta事前 SHRINK_K で素の勝率へ寄せる)
    return (wins + SHRINK_K * raw) / (cnt + SHRINK_K)


def attach_calibrated_prob(recs, n_periods):
    """expanding window: period p の補正は period<p のデータだけで作る(未来を覗かない)。"""
    by_period = defaultdict(list)
    for r in recs:
        by_period[r["period"]].append(r)
    periods = sorted(by_period)
    for p in periods:
        past = [r for q in periods if q < p for r in by_period[q]]
        if len(past) >= 300:
            table = _build_2d_table(past)
            for r in by_period[p]:
                r["p_cal2d"] = _calibrated_prob(r, table)
        else:
            for r in by_period[p]:
                r["p_cal2d"] = r.get("p_nopop_raw")   # 前が薄い=無補正(正直)
    return recs


def roi_table(recs, predicate, pay_field):
    inv = ret = bets = hits = 0
    by_period = defaultdict(lambda: [0, 0])
    for r in recs:
        if not predicate(r):
            continue
        pay = r.get(pay_field) or 0
        inv += 100
        ret += pay
        bets += 1
        hits += 1 if pay > 0 else 0
        by_period[r["period"]][0] += 100
        by_period[r["period"]][1] += pay
    period_rois = [round(v[1] / v[0] * 100, 1) for k, v in sorted(by_period.items()) if v[0]]
    return {
        "bets": bets, "hits": hits,
        "hit_rate_pct": round(hits / bets * 100, 1) if bets else None,
        "invested": inv, "returned": ret,
        "overall_roi_pct": round(ret / inv * 100, 2) if inv else None,
        "period_rois": period_rois,
        "win_periods": sum(1 for x in period_rois if x >= 100),
        "active_periods": len(period_rois),
    }


def bootstrap_ci(recs, predicate, pay_field, n=BOOT_N):
    """レース単位(rid)でブートストラップ → 回収率の 5%/50%/95% を返す。"""
    by_race = defaultdict(lambda: [0, 0])  # rid -> [invested, returned]
    for r in recs:
        if not predicate(r):
            continue
        by_race[r["rid"]][0] += 100
        by_race[r["rid"]][1] += (r.get(pay_field) or 0)
    races = [(inv, ret) for inv, ret in by_race.values() if inv > 0]
    if len(races) < 20:
        return None
    rng = random.Random(SEED)
    m = len(races)
    rois = []
    for _ in range(n):
        inv = ret = 0
        for _ in range(m):
            i, rr = races[rng.randrange(m)]
            inv += i
            ret += rr
        if inv:
            rois.append(ret / inv * 100)
    rois.sort()
    pct = lambda q: round(rois[min(len(rois) - 1, int(q * len(rois)))], 1)
    return {"races": m, "lo5": pct(0.05), "mid": pct(0.50), "hi95": pct(0.95),
            "prob_over_100_pct": round(sum(1 for x in rois if x >= 100) / len(rois) * 100, 1)}


def main():
    if not BETS_PATH.exists():
        print(f"[error] {BETS_PATH} が無い。先に walk_forward_value_ev.py を実行してください。", flush=True)
        return 1
    recs = json.loads(BETS_PATH.read_text(encoding="utf-8"))
    n_periods = max((r["period"] for r in recs), default=0) + 1
    print(f"[info] per-bet レコード {len(recs)} 件 / 期間 {n_periods}", flush=True)

    attach_calibrated_prob(recs, n_periods)

    # 比較する戦略
    def raw_ev(th):
        return lambda r: r.get("odds") is not None and (r.get("p_nopop") or 0) * r["odds"] >= th

    def cal_ev(th):
        return lambda r: r.get("odds") is not None and r.get("p_cal2d") is not None and r["p_cal2d"] * r["odds"] >= th

    def cal_ev_band(th, lo, hi):
        return lambda r: (r.get("odds") is not None and lo <= r["odds"] <= hi
                          and r.get("p_cal2d") is not None and r["p_cal2d"] * r["odds"] >= th)

    strategies = []
    strategies.append(("[基準] 人気1番ベタ買い", lambda r: r.get("popularity") == 1, "tan_pay"))
    for th in (1.0, 1.1, 1.2, 1.3):
        strategies.append((f"単勝 生EV>={th:.2f} (補正なし)", raw_ev(th), "tan_pay"))
    for th in (1.0, 1.1, 1.2, 1.3):
        strategies.append((f"単勝 2次元補正EV>={th:.2f} ★", cal_ev(th), "tan_pay"))
    for th in (1.1, 1.2, 1.3):
        strategies.append((f"単勝 2次元補正EV>={th:.2f} かつ オッズ3-15倍 ★", cal_ev_band(th, 3.0, 15.0), "tan_pay"))
    for th in (1.0, 1.1, 1.2):
        strategies.append((f"複勝 2次元補正EV(単勝換算)>={th:.2f} ★", cal_ev(th), "fuku_pay"))

    rows = []
    for name, pred, field in strategies:
        st = roi_table(recs, pred, field)
        st["name"] = name
        st["pay_field"] = field
        st["_pred"] = pred
        rows.append(st)

    # 表示
    rows_sorted = sorted(rows, key=lambda x: -(x["overall_roi_pct"] or 0))
    print(f"\n{'戦略':<40}{'本当の回収率':>12}{'勝期間':>8}{'件数':>8}{'的中率':>8}", flush=True)
    print("=" * 80, flush=True)
    for r in rows_sorted:
        roi = f"{r['overall_roi_pct']:.1f}%" if r["overall_roi_pct"] is not None else "—"
        wp = f"{r['win_periods']}/{r['active_periods']}"
        hr = f"{r['hit_rate_pct']:.1f}%" if r["hit_rate_pct"] is not None else "—"
        print(f"{r['name']:<40}{roi:>11} {wp:>8}{r['bets']:>8}{hr:>8}", flush=True)

    # 上位3戦略 + 基準に信頼区間を付ける
    print("\n--- 回収率の信頼区間(レース単位ブートストラップ1000回・お金ベース) ---", flush=True)
    ci_targets = rows_sorted[:3]
    base = next((r for r in rows if "基準" in r["name"]), None)
    if base and base not in ci_targets:
        ci_targets = ci_targets + [base]
    for r in ci_targets:
        ci = bootstrap_ci(recs, r["_pred"], r["pay_field"])
        r["ci"] = ci
        if ci:
            verdict = "本物っぽい(運だけでは説明しにくい)" if ci["lo5"] >= 100 else (
                      "判断保留(区間が100%をまたぐ=運の範囲)" if ci["hi95"] >= 100 else
                      "ほぼ負け確定(上振れても100%未満)")
            print(f"  {r['name']}", flush=True)
            print(f"     90%予想レンジ {ci['lo5']}% 〜 {ci['hi95']}% (中央 {ci['mid']}%) / "
                  f"100%超え確率 {ci['prob_over_100_pct']}% → {verdict}", flush=True)

    # JSON 保存(内部の predicate は外す)
    for r in rows:
        r.pop("_pred", None)
    out = {
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
        "source": BETS_PATH.name,
        "leakage_free": True,
        "method": "2次元補正(予想勝率×オッズ帯・expanding window)+ EV単複価値投資 + レース単位ブートストラップ信頼区間",
        "prob_edges": PROB_EDGES, "odds_edges": ODDS_EDGES,
        "shrink_k": SHRINK_K, "min_cell": MIN_CELL, "bootstrap_n": BOOT_N,
        "strategies": rows_sorted,
    }
    OUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n[OK] {OUT_PATH.name} 保存", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
