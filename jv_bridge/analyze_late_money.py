# -*- coding: utf-8 -*-
"""
analyze_late_money.py — 「賢いお金の動き(late money)」に本物のもうけの隙があるかを計測する(計測専用)

考え方:
  発走直前にオッズが急に下がる(=賢い人がこっそり買っている=money_in)馬は
  来やすい・割安かもしれない。逆に急騰(money_out)は危ないかもしれない。
  これを「実際にその馬を単勝で機械的に買い続けたら回収率は100%を超えたか」で
  ズルなし(リークなし)で計測する。

リークなしの理由:
  - 事実(オッズ急落/急騰)はすべて“発走前”のスナップショット同士の比較で確定する。
  - それを“後で出た着順・払戻”と突き合わせるだけ。未来情報で事実を選んでいない。
  - 結果で事実を選り好みしない(全部を機械的に集計する)。

★ 本番のEV/おすすめ/モデル/予想には一切触れない。読むだけ・計測するだけ。

判定材料の出力(回収率 + レース単位ブートストラップの下限5%):
  delta閾値(オッズの下がり幅)ごとに、単勝の回収率・有効開催日数・信頼区間を出す。

出力: data/jv_cache/late_money_result.json + コンソール表
実行: py -3.12 jv_bridge/analyze_late_money.py
"""
from __future__ import annotations

import glob
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
RACES = CACHE / "races"
RESULTS = CACHE / "results"
SIGNALS = CACHE / "signals"
OUT = CACHE / "late_money_result.json"

sys.path.insert(0, str(Path(__file__).resolve().parent))
from race_facts import signal_odds_moves  # noqa: E402

BOOT_N = 1000
SEED = 20260623
MIN_RACES_FOR_CI = 20


def _load(p: Path):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def _finishes(rid: str) -> dict:
    """results/<rid>.json → 馬番:{rank, tan_payout}。取消等で着順無しは入らない。"""
    result = _load(RESULTS / f"{rid}.json")
    out = {}
    for r in ((result or {}).get("results") or []):
        try:
            n = int(r.get("number"))
        except (TypeError, ValueError):
            continue
        try:
            rank = int(r.get("rank"))
        except (TypeError, ValueError):
            rank = None
        pay = r.get("tan_payout") or 0
        out[n] = {"rank": rank, "tan_pay": pay if rank == 1 else 0}
    return out


def collect_bets() -> list:
    """各レースの signal_odds_moves(発走前のオッズ動き=パーセント変化)を読み、
    money_in(オッズ -15%以下=下落) / money_out(+30%以上=上昇) の馬を
    「単勝1点」のベットとして集める(計測用)。各ベットに delta(下がり幅%・正値)を付ける。
    判定の閾値は本番表示(race_facts)と同じにする(money_in: mv<=-15 / money_out: mv>=30)。"""
    bets = []
    for sp in glob.glob(str(SIGNALS / "*.json")):
        rid = Path(sp).stem
        finishes = _finishes(rid)
        if not finishes:
            continue  # 確定結果が無いレースは計測できない
        moves = signal_odds_moves(rid)  # 馬番(str) -> パーセント変化(float)
        if not isinstance(moves, dict):
            continue
        for num, mv in moves.items():
            try:
                n = int(num)
            except (TypeError, ValueError):
                continue
            try:
                mv = float(mv)
            except (TypeError, ValueError):
                continue
            if mv <= -15:
                kind = "money_in"
            elif mv >= 30:
                kind = "money_out"
            else:
                continue
            if n not in finishes:
                continue  # 取消等で着順が無い=買えない
            bets.append({
                "rid": rid, "number": n, "kind": kind,
                "delta": abs(mv), "tan_pay": finishes[n]["tan_pay"],
            })
    return bets


def roi_of(bets) -> dict:
    inv = sum(100 for _ in bets)
    ret = sum(b["tan_pay"] for b in bets)
    hits = sum(1 for b in bets if b["tan_pay"] > 0)
    days = len({b["rid"][:8] for b in bets})  # 開催日 = race_id 先頭8桁(YYYYMMDD)
    return {
        "bets": len(bets), "hits": hits,
        "hit_rate_pct": round(hits / len(bets) * 100, 1) if bets else None,
        "invested": inv, "returned": ret,
        "overall_roi_pct": round(ret / inv * 100, 2) if inv else None,
        "active_days": days,
    }


def bootstrap_ci(bets, n=BOOT_N) -> dict | None:
    """レース単位でブートストラップ → 回収率の 5%/50%/95% を返す。"""
    by_race = defaultdict(lambda: [0, 0])
    for b in bets:
        by_race[b["rid"]][0] += 100
        by_race[b["rid"]][1] += b["tan_pay"]
    races = [(inv, ret) for inv, ret in by_race.values() if inv > 0]
    if len(races) < MIN_RACES_FOR_CI:
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


def main() -> int:
    bets = collect_bets()
    in_bets = [b for b in bets if b["kind"] == "money_in"]

    strategies = []
    # money_in 全部
    strategies.append(("late money(オッズ急落)全部・単勝", in_bets))
    # delta(下がり幅%)閾値別 — 強く下がったものほど賢いお金が入った疑い
    for th in (15, 25, 40):
        sub = [b for b in in_bets if (b.get("delta") or 0) >= th]
        strategies.append((f"late money・下がり幅{th}%以上・単勝", sub))
    # 参考: money_out を「買わない/嫌う」材料に使えるか(急騰馬の単勝回収率=低いほど嫌う価値)
    out_bets = [b for b in bets if b["kind"] == "money_out"]
    strategies.append(("(参考)money out(オッズ急騰)馬の単勝", out_bets))

    rows = []
    for name, sub in strategies:
        st = roi_of(sub)
        st["name"] = name
        st["ci"] = bootstrap_ci(sub)
        rows.append(st)

    rows_sorted = sorted(rows, key=lambda x: -(x["overall_roi_pct"] or 0))
    print(f"[info] late money ベット {len(bets)} 件 (money_in {len(in_bets)} 件)", flush=True)
    print(f"\n{'戦略':<36}{'回収率':>9}{'開催日':>7}{'件数':>7}{'的中率':>7}", flush=True)
    print("=" * 70, flush=True)
    for r in rows_sorted:
        roi = f"{r['overall_roi_pct']:.1f}%" if r["overall_roi_pct"] is not None else "—"
        hr = f"{r['hit_rate_pct']:.1f}%" if r["hit_rate_pct"] is not None else "—"
        print(f"{r['name']:<36}{roi:>8} {r['active_days']:>6}{r['bets']:>7}{hr:>7}", flush=True)
        if r["ci"]:
            print(f"     90%レンジ {r['ci']['lo5']}%〜{r['ci']['hi95']}% / "
                  f"100%超え確率 {r['ci']['prob_over_100_pct']}%", flush=True)

    out = {
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
        "leakage_free": True,
        "method": "発走前オッズ急落/急騰(late money)馬を単勝1点で機械買い + レース単位ブートストラップ",
        "bets_total": len(bets),
        "money_in_total": len(in_bets),
        "strategies": rows_sorted,
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n[OK] {OUT.name} 保存", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
